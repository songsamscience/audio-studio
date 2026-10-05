/* @ffmpeg/core 0.12.10, single threaded. Originals are read from disk on demand (WORKERFS). When the browser has the
 * origin-private file system (OPFS), long work files (the float mix, the result) live there and decoded sound streams
 * out as Blob parts, so nothing grows in memory with the length. Without OPFS the work files stay in MEMFS under the
 * older, shorter limits. */
'use strict';
importScripts('./vendor/ffmpeg-core.js');
let core, logs = [], caps = null, ioError = null, progress = null, disk = null, diskSerial = 0;
const sources = new Map();
// Without OPFS a render's float work file sits in memory, so decoded sound stays under 256 MB (48 kHz stereo ≈ 11 min).
const MAX_PCM = 256000000;
// With OPFS: an original's playback sound (16-bit at the playback rate) up to 2 GiB — at 48 kHz stereo ≈ 3 h 6 min,
// mono ≈ 6 h 12 min — and a render's float work file up to 8 GiB. Beyond that one single-threaded job runs for well over
// half an hour and the scratch files pass ~10 GB, more than many school PCs have free.
const PCM_BUDGET = 2*1024**3, RENDER_BUDGET = 8*1024**3;
// areverse and aloop keep all of their input in wasm memory (2 GB at most), so they get this much float sound.
const WASM_BUFFER = 512*1024*1024;
// kind: lossy · lossless · pcm · video. A video format carries a still/animated picture next to the sound.
const FORMATS = {
  mp3:{encoder:'libmp3lame',codec:'mp3',mime:'audio/mpeg',extension:'mp3',muxer:'mp3',kind:'lossy'},
  m4a:{encoder:'aac',codec:'aac',mime:'audio/mp4',extension:'m4a',muxer:'ipod',kind:'lossy'},
  aac:{encoder:'aac',codec:'aac',mime:'audio/aac',extension:'aac',muxer:'adts',kind:'lossy'},
  m4r:{encoder:'aac',codec:'aac',mime:'audio/mp4',extension:'m4r',muxer:'ipod',kind:'lossy'},
  ogg:{encoder:'libvorbis',codec:'vorbis',mime:'audio/ogg',extension:'ogg',muxer:'ogg',kind:'lossy'},
  opus:{encoder:'libopus',codec:'opus',mime:'audio/ogg; codecs=opus',extension:'opus',muxer:'opus',kind:'lossy'},
  webm:{encoder:'libopus',codec:'opus',mime:'audio/webm',extension:'webm',muxer:'webm',kind:'lossy'},
  wma:{encoder:'wmav2',codec:'wmav2',mime:'audio/x-ms-wma',extension:'wma',muxer:'asf',kind:'lossy'},
  mp2:{encoder:'mp2',codec:'mp2',mime:'audio/mpeg',extension:'mp2',muxer:'mp2',kind:'lossy'},
  ac3:{encoder:'ac3',codec:'ac3',mime:'audio/ac3',extension:'ac3',muxer:'ac3',kind:'lossy'},
  wav:{encoder:'pcm_s16le',codec:'pcm_s16le',mime:'audio/wav',extension:'wav',muxer:'wav',kind:'pcm'},
  flac:{encoder:'flac',codec:'flac',mime:'audio/flac',extension:'flac',muxer:'flac',kind:'lossless'},
  alac:{encoder:'alac',codec:'alac',mime:'audio/mp4',extension:'m4a',muxer:'ipod',kind:'lossless'},
  aiff:{encoder:'pcm_s16be',codec:'pcm_s16be',mime:'audio/aiff',extension:'aiff',muxer:'aiff',kind:'pcm'},
  caf:{encoder:'pcm_s16le',codec:'pcm_s16le',mime:'audio/x-caf',extension:'caf',muxer:'caf',kind:'pcm'},
  au:{encoder:'pcm_s16be',codec:'pcm_s16be',mime:'audio/basic',extension:'au',muxer:'au',kind:'pcm'},
  mp4:{encoder:'aac',codec:'aac',mime:'video/mp4',extension:'mp4',muxer:'mp4',kind:'video',videoEncoder:'libx264',videoCodec:'h264'},
  webmv:{encoder:'libvorbis',codec:'vorbis',mime:'video/webm',extension:'webm',muxer:'webm',kind:'video',videoEncoder:'libvpx',videoCodec:'vp8'}
};
const PCM_ENCODERS = {wav:{8:'pcm_u8',16:'pcm_s16le',24:'pcm_s24le',32:'pcm_f32le'},aiff:{16:'pcm_s16be',24:'pcm_s24be'},au:{16:'pcm_s16be',24:'pcm_s24be'},caf:{16:'pcm_s16le',24:'pcm_s24le'}};
const MP3_RATES = [8000,11025,12000,16000,22050,24000,32000,44100,48000];
const AAC_RATES = [8000,11025,12000,16000,22050,24000,32000,44100,48000,64000,88200,96000];
const MP2_RATES = [16000,22050,24000,32000,44100,48000];
const AC3_RATES = [32000,44100,48000];
const AC3_KBPS = [64,96,128,160,192,224,256,320,384,448,512,576,640];
// Opus is mono only: this core's libopus aborts (memory access out of bounds) on stereo for some content
// (white noise, WebM muxing, 60 ms frames) even at complexity 0, while mono passed every test (tests/engine-caps.html#set4).
const MAX_CHANNELS = {mp3:2,ogg:2,opus:1,webm:1,m4a:2,aac:2,m4r:2,mp4:2,webmv:2,wma:2,mp2:2,ac3:6};
const OPUS_MONO_NOTE = '이 엔진의 스테레오 Opus 인코딩은 소리에 따라 멈추는 문제가 있어 Opus는 모노로만 저장합니다. 스테레오가 필요하면 OGG(Vorbis)나 M4A를 쓰세요.';
const VIDEO_SIZES = {'1280x720':[1280,720],'1920x1080':[1920,1080],'1080x1080':[1080,1080],'1080x1920':[1080,1920]};
function status(phase,message) { self.postMessage({status:{phase,message}}); }
function fail(message,code='PROCESSING',details='') { const e = new Error(message); e.code=code;e.details=details;throw e; }
function num(value,fallback=0,min=-Infinity,max=Infinity) { const v=Number(value); return Number.isFinite(v)?Math.max(min,Math.min(max,v)):fallback; }
function n(value) { return Number(value.toFixed(8)).toString(); }
const nearest=(value,list)=>list.reduce((best,v)=>Math.abs(v-value)<Math.abs(best-value)?v:best,list[0]);
function unlink(path) { try { core.FS.unlink(path); } catch (_) {} }
// Each original is its own read-only WORKERFS mount, so FFmpeg pulls only the bytes it needs from the File:
// a 4 GB video never has to fit in memory, and nothing is copied when the engine restarts.
function mountSource(id,file) {
  const dir='/'+id;core.FS.mkdir(dir);
  try{core.FS.mount(core.FS.filesystems.WORKERFS,{blobs:[{name:'media',data:file}]},dir);}catch(e){try{core.FS.rmdir(dir);}catch(_){}throw e;}
  return dir+'/media';
}
function unmountSource(id) { try { core.FS.unmount('/'+id); } catch (_) {} try { core.FS.rmdir('/'+id); } catch (_) {} }
const UNREADABLE='원본 파일을 읽지 못했습니다. 파일을 옮기거나 지웠다면 같은 파일을 다시 선택해 주세요.';
const NO_SPACE='기기의 저장 공간이 부족해 작업 파일을 쓰지 못했습니다. 저장 공간을 비우거나 더 짧은 구간으로 다시 시도해 주세요.';
// I/O errors inside FFmpeg arrive as plain EIO; this says which one it was.
function checkIo() {
  const e=ioError;ioError=null;
  if(e==='read')fail(UNREADABLE,'SOURCE_READ');
  if(e==='space')fail(NO_SPACE,'DISK_FULL');
  if(e==='disk')fail('작업 파일을 쓰지 못했습니다. 다시 시도해 주세요.','DISK');
}
function span(seconds) {
  seconds=Math.floor(seconds);
  if(seconds>=3600){const h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60);return `${h}시간${m?` ${m}분`:''}`;}
  return seconds>=120?`${Math.floor(seconds/60)}분`:`${seconds}초`;
}
// ----- scratch files: OPFS sync access handles behind ordinary MEMFS paths -----
// Remove leftovers of a closed, crashed or cancelled engine. Files another open tab is using are locked and stay; a
// cancelled (terminated) engine's locks are released a moment later, so locked files are tried again twice.
// Retries touch only the names seen at start, never this engine's own new files.
async function sweep(dir,names=null,tries=3) {
  if(!names){names=[];for await (const name of dir.keys())names.push(name);}
  const locked=[];
  for(const name of names) try { await dir.removeEntry(name); } catch (e) { if(e?.name!=='NotFoundError')locked.push(name); }
  if(locked.length&&tries>1)setTimeout(()=>sweep(dir,locked,tries-1).catch(()=>{}),2000);
}
async function initDisk() {
  try {
    if(!self.FileSystemFileHandle?.prototype?.createSyncAccessHandle||!navigator.storage?.getDirectory)return;
    const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('audio-studio-scratch',{create:true});
    await sweep(dir);
    const test=await dir.getFileHandle(`check-${Date.now().toString(36)}`,{create:true}),h=await test.createSyncAccessHandle();
    h.write(new Uint8Array(8),{at:0});h.close();await dir.removeEntry(test.name);
    disk=dir;
  } catch (_) { disk=null; }
}
const view=(buffer,offset,length)=>new Uint8Array(buffer.buffer,buffer.byteOffset+offset,length);
// A DOMException must not unwind through wasm frames (the core would be left unusable): turn it into EIO.
function diskIo(fn) {
  try { return fn(); }
  catch (e) { if(e?.name==='ErrnoError')throw e; ioError=e?.name==='QuotaExceededError'?'space':'disk'; throw new core.FS.ErrnoError(29); }
}
// Give a MEMFS path an OPFS file as its storage; FFmpeg sees an ordinary seekable file.
function attachHandle(path,h) {
  unlink(path);core.FS.writeFile(path,new Uint8Array(0));
  const node=core.FS.lookupPath(path).node,ops=node.node_ops,streams=node.stream_ops;
  node.node_ops={...ops,
    getattr(n){const a=ops.getattr(n);a.size=h.getSize();a.blocks=Math.ceil(a.size/4096);return a;},
    setattr(n,attr){if(attr.size!==undefined)diskIo(()=>h.truncate(attr.size));ops.setattr(n,{...attr,size:undefined});}};
  node.stream_ops={...streams,
    read(stream,buffer,offset,length,position){return diskIo(()=>h.read(view(buffer,offset,length),{at:position}));},
    write(stream,buffer,offset,length,position){return diskIo(()=>{const done=h.write(view(buffer,offset,length),{at:position});if(done<length)throw new DOMException('short write','QuotaExceededError');return done;});},
    llseek(stream,offset,whence){let p=offset;if(whence===1)p+=stream.position;else if(whence===2)p+=h.getSize();if(p<0)throw new core.FS.ErrnoError(28);return p;}};
}
// Work files of one job: on disk with OPFS, plain MEMFS files without it. release() removes them.
async function scratch(...names) {
  const files=[];
  const release=async()=>{for(const f of files){if(f.h)try{f.h.close();}catch(_){}unlink(f.path);if(f.entry)try{await disk.removeEntry(f.entry);}catch(_){}}};
  try {
    for(const name of names){
      const f={path:'/'+name};files.push(f);unlink(f.path);
      if(!disk)continue;
      f.entry=`${Date.now().toString(36)}-${++diskSerial}-${name}`;
      f.h=await (await disk.getFileHandle(f.entry,{create:true})).createSyncAccessHandle();
      attachHandle(f.path,f.h);
    }
  } catch (e) { await release(); fail(e?.name==='QuotaExceededError'?NO_SPACE:'작업 파일을 만들지 못했습니다. 다시 시도해 주세요.','DISK'); }
  return {paths:files.map(f=>f.path),release};
}
async function ensureSpace(bytes) {
  if(!disk||!navigator.storage?.estimate)return;
  let room=Infinity;try{const {quota,usage}=await navigator.storage.estimate();if(quota)room=quota-(usage||0);}catch(_){}
  if(room<bytes)fail(NO_SPACE,'DISK_FULL');
}
// A finished file as Blob parts, 16 MB at a time, so a long result never needs one big buffer.
function fileBlob(path,type) {
  const size=core.FS.stat(path).size,stream=core.FS.open(path,'r'),parts=[];
  try{for(let at=0;at<size;at+=16<<20){const buf=new Uint8Array(Math.min(16<<20,size-at));core.FS.read(stream,buf,0,buf.length,at);parts.push(new Blob([buf]));}}
  finally{core.FS.close(stream);}
  checkIo();
  return new Blob(parts,{type});
}
// ----- decoded sound out of FFmpeg: raw 16-bit PCM becomes Blob parts and running statistics as it is written -----
const PART_FRAMES=1<<17, PEAK_CAP=1<<20;
function pcmSink(channels,rate,{keep=true,peaks=false,envelope=false,expectedFrames=0}={}) {
  const path='/sound.pcm';unlink(path);core.FS.writeFile(path,new Uint8Array(0));
  const node=core.FS.lookupPath(path).node,frameBytes=channels*2,part=new Uint8Array(PART_FRAMES*frameBytes),parts=[];
  let fill=0,frames=0,sum=0,peak=0;
  // Waveform peaks: the loudest sample per `step` frames. A recording of unknown length halves the resolution as it grows.
  let step=Math.max(1,Math.ceil(expectedFrames/(PEAK_CAP/2))),values=peaks?new Float32Array(PEAK_CAP):null,count=0,bucket=0,bucketFill=0;
  // Silence finding: the loudest channel's RMS per 10 ms window.
  const win=Math.max(1,Math.round(rate*.01)),power=new Float64Array(channels);let env=envelope?new Float32Array(1<<16):null,envCount=0,winFill=0;
  const pushEnv=len=>{let best=0;for(let c=0;c<channels;c++){if(power[c]>best)best=power[c];power[c]=0;}if(envCount===env.length){const grown=new Float32Array(env.length*2);grown.set(env);env=grown;}env[envCount++]=Math.sqrt(best/len)/32768;};
  function flush() {
    const n=Math.floor(fill/frameBytes),s=new Int16Array(part.buffer,0,n*channels);
    for(let f=0,i=0;f<n;f++){
      let loud=0;
      for(let c=0;c<channels;c++,i++){const v=s[i],a=v<0?-v:v;if(a>loud)loud=a;sum+=v*v;if(env)power[c]+=v*v;}
      if(loud>peak)peak=loud;
      if(values){
        if(loud>bucket)bucket=loud;
        if(++bucketFill===step){values[count++]=bucket/32768;bucket=bucketFill=0;if(count===PEAK_CAP){for(let k=0;k<PEAK_CAP/2;k++)values[k]=Math.max(values[2*k],values[2*k+1]);count=PEAK_CAP/2;step*=2;}}
      }
      if(env&&++winFill===win){pushEnv(win);winFill=0;}
    }
    if(keep&&n)parts.push(new Blob([part.subarray(0,n*frameBytes)]));
    frames+=n;fill=0;
  }
  node.stream_ops={...node.stream_ops,write(stream,buffer,offset,length){for(let at=0;at<length;){const take=Math.min(length-at,part.length-fill);part.set(view(buffer,offset+at,take),fill);fill+=take;at+=take;if(fill===part.length)flush();}return length;}};
  return {path,finish(){
    flush();unlink(path);
    if(values&&bucketFill)values[count++]=bucket/32768;
    if(env&&winFill)pushEnv(winFill);
    const samples=frames*channels,rms=samples?Math.sqrt(sum/samples)/32768:0;
    return {frames,
      pcm:keep?{rate,channels,frames,partFrames:PART_FRAMES,parts,rms,peak:peak/32768}:null,
      peaks:values?{values:values.slice(0,count),secondsPer:step/rate,duration:frames/rate,peak:peak/32768,rms}:null,
      envelope:env?{values:env.slice(0,envCount),window:win/rate,total:frames/rate}:null};
  }};
}
// Decode one audio stream (through `filters`, if any) into a sink at `rate`; returns the sink's result.
function decodeTo(path,map,channels,rate,options={},{limit=0,filters=[],label='소리 읽는 중',duration=0}={}) {
  const sink=pcmSink(channels,rate,options);
  try{run(['-i',path,'-map',map,'-vn','-sn','-dn',...(limit?['-t',n(limit)]:[]),...(filters.length?['-af',filters.join(',')]:[]),'-c:a','pcm_s16le','-ar',String(rate),'-ac',String(channels),'-map_metadata','-1','-f','s16le',sink.path],false,{phase:'decoding',label,duration});}
  catch(e){unlink(sink.path);throw e;}
  return sink.finish();
}
// @ffmpeg/core 0.12.10 leaves the wasm stack pointer moved after exec/ffprobe, so the 64 KB stack runs out after
// some 60-140 jobs. asm.Da/asm.Ea are this build's stackSave/stackRestore (see vendor/ffmpeg-core.js).
let stackGuard=null,callsWithoutGuard=0;
function guarded(fn){if(stackGuard===null)stackGuard=typeof core.asm?.Da==='function'&&typeof core.asm?.Ea==='function';if(!stackGuard){callsWithoutGuard++;return fn();}const sp=core.asm.Da();try{return fn();}finally{core.asm.Ea(sp);}}
// `report` ({phase,label,duration}) turns FFmpeg's progress into "label · 37%" status messages for long jobs.
function run(args,allowFailure=false,report=null) {
  logs=[];ioError=null;progress=report&&report.duration>0?{...report,pct:-1,at:0}:null;core.reset();
  let code;try{code=guarded(()=>core.exec('-hide_banner','-loglevel','info','-nostdin',...args));}finally{progress=null;}
  const text=logs.join('\n');core.reset();
  checkIo();
  if(code!==0&&!allowFailure) classify(text);
  return {code,text};
}
function onProgress({time}) {
  const p=progress;if(!p||!(time>0))return;
  const pct=Math.max(0,Math.min(99,Math.floor(time/1e6/p.duration*100))),now=Date.now();
  if(pct>p.pct&&now-p.at>400){p.pct=pct;p.at=now;status(p.phase,`${p.label} · ${pct}%`);}
}
function classify(text) {
  if (/out of memory|Cannot enlarge memory|memory access out of bounds|allocation failed/i.test(text)) fail('브라우저 메모리가 부족합니다. 새 작업을 열고 짧은 구간이나 작은 파일로 다시 시도해 주세요.','MEMORY');
  if (/Decoder.*not found|Unknown decoder|Unsupported codec|not supported in WAVE/i.test(text)) fail('이 파일의 코덱은 현재 처리 도구에서 지원되지 않습니다. WAV, MP3 또는 AAC 파일로 준비해 주세요.','UNSUPPORTED');
  if (/Invalid data found|moov atom not found|Error while decoding|Invalid PCM packet|corrupt/i.test(text)) fail('파일이 손상되었거나 올바른 영상·음원 형식이 아닙니다. 원본 파일이 정상 재생되는지 확인해 주세요.','CORRUPT');
  fail('음원을 처리하지 못했습니다. 구간과 출력 설정을 확인하거나 다른 형식으로 다시 시도해 주세요.','PROCESSING',text.slice(-3000).replace(/source_[a-z0-9_]+/gi,'[원본]'));
}
function probe(path) {
  unlink('probe.json');logs=[];ioError=null;core.reset();
  guarded(()=>core.ffprobe('-v','error','-show_streams','-show_format','-of','json','-o','probe.json',path));core.reset();
  checkIo();
  // This pinned core leaves ffprobe's return field at -1 even on success.
  // Validate its JSON output and reported streams instead.
  let json;try{json=JSON.parse(core.FS.readFile('probe.json',{encoding:'utf8'}));}catch(_){fail('파일 정보를 읽지 못했습니다. 다른 파일로 다시 시도해 주세요.','PROBE');}finally{unlink('probe.json');}
  if(!Array.isArray(json.streams)) classify(logs.join('\n') || 'Invalid data found');
  return json;
}
function frameRate(text) { const m=/^(\d+)\/(\d+)$/.exec(String(text||''));if(!m||!Number(m[2]))return null;const v=Number(m[1])/Number(m[2]);return v>0?Math.round(v*100)/100:null; }
function metadata(json,track=0) {
  const audio=(json.streams||[]).filter(s=>s.codec_type==='audio');
  if(!audio.length) fail('이 영상에는 추출할 소리가 없습니다.','NO_AUDIO');
  if(!audio[track]) fail('선택한 오디오 트랙을 찾지 못했습니다. 다른 트랙을 선택해 주세요.','TRACK');
  const s=audio[track], duration=num(s.duration,num(json.format?.duration,0));
  const bitrate=num(s.bit_rate,0)>0?num(s.bit_rate)/1000:null;
  // Embedded cover art is a picture stream too; only a real moving picture counts as video.
  const still=t=>Number(t.disposition?.attached_pic)===1||(/^(png|mjpeg|bmp|gif|webp|tiff)$/.test(t.codec_name||'')&&(Number(t.nb_frames)>0?Number(t.nb_frames)<=1:!frameRate(t.avg_frame_rate)));
  const picture=(json.streams||[]).find(t=>t.codec_type==='video'&&!still(t));
  return {duration,sampleRate:num(s.sample_rate),channels:num(s.channels),codec:s.codec_name||'확인할 수 없음',bitrate,
    track,container:String(json.format?.format_name||''),
    video:picture?{codec:picture.codec_name||'',width:num(picture.width),height:num(picture.height),fps:frameRate(picture.avg_frame_rate)||frameRate(picture.r_frame_rate)}:null,
    tracks:audio.map(t=>({codec:t.codec_name,language:t.tags?.language||'',title:t.tags?.title||''}))};
}
// How long one original may be. The cap is on decoded sound, so it depends on channels (and, without OPFS, the rate).
function maxSeconds(meta,pcmRate) {
  return disk?Math.floor(PCM_BUDGET/(pcmRate*meta.channels*2)):Math.floor(MAX_PCM/((meta.sampleRate||48000)*meta.channels*4));
}
function tooLong(limit,meta,duration=0) {
  fail(`이 파일의 소리(${n((meta.sampleRate||48000)/1000)} kHz · ${meta.channels}채널)는 약 ${span(limit)}까지 열 수 있습니다${duration>0?`(이 파일 약 ${span(Math.ceil(duration))})`:'(이 파일은 그보다 깁니다)'}. 짧게 나눈 파일로 열어 주세요.`,'TOO_LONG');
}
// Decode the chosen track once, at the playback rate: the sound for 원본 A, its waveform peaks, and its real length.
// Browser recordings (MediaRecorder WebM/MP4) often carry no duration; this measures it too.
function analyze(data) {
  status('analyzing','파일의 오디오 트랙 분석 중');
  const path=mountSource(data.id,data.file),track=data.track,pcmRate=num(data.pcmRate,48000,8000,192000);
  try{
    let meta=metadata(probe(path),track);
    if(meta.channels<1||meta.channels>8) fail('현재는 최대 8개 채널의 원본을 열 수 있습니다. 모노 또는 스테레오로 변환한 원본을 사용해 주세요.','CHANNELS');
    const limit=maxSeconds(meta,pcmRate),known=meta.duration>0;
    // MP3/MP2 lengths are often estimated from the first frames, so only a clear overrun is refused before decoding.
    if(known&&meta.duration>limit*(/^mp[23]$/.test(meta.codec)?1.5:1)+.5)tooLong(limit,meta,meta.duration);
    const keep=data.pcm!==false;
    status('decoding',known?'파형에 사용할 실제 소리 읽는 중':'녹음 길이 확인 중');
    const got=decodeTo(path,`0:a:${track}`,meta.channels,pcmRate,{keep,peaks:keep,expectedFrames:known?meta.duration*pcmRate:0},{limit:limit+1,label:known?'파형에 사용할 실제 소리 읽는 중':'녹음 길이 확인 중',duration:known?meta.duration:0});
    const real=got.frames/pcmRate;
    if(!(real>0))fail('파일의 재생 시간을 확인할 수 없습니다. 정상적인 음원 파일로 다시 저장해 주세요.','DURATION');
    if(real>limit+.5)tooLong(limit,meta,known?Math.max(meta.duration,real):0);
    if(!known&&!(meta.sampleRate>0))meta={...meta,sampleRate:48000};
    if(!known||Math.abs(real-meta.duration)>0.02)meta={...meta,duration:real};
    sources.set(data.id,{path,metadata:meta,track});
    return {id:data.id,metadata:meta,pcm:got.pcm,peaks:got.peaks};
  }catch(e){unmountSource(data.id);throw e;}
}
async function initialize() {
  if(core)return;
  status('loading','처리 도구 준비 중');
  try{core=await createFFmpegCore({mainScriptUrlOrBlob:new URL('vendor/ffmpeg-core.js',self.location.href).href+'#'+btoa(JSON.stringify({wasmURL:new URL('vendor/ffmpeg-core.wasm',self.location.href).href}))});}
  catch(_){core=null;fail('처리 도구(vendor/ffmpeg-core.wasm)를 불러오지 못했습니다. 폴더 안에 이 파일이 그대로 있는지 확인하고 새로고침해 주세요.','ENGINE_LOAD');}
  core.setLogger(({message})=>{logs.push(message); if(logs.length>8000)logs.shift();});
  core.setProgress(onProgress);
  // A File that was moved or deleted after it was picked throws a DOMException from FileReaderSync. Hand FFmpeg a
  // plain I/O error instead (an exception through wasm frames would leave the core unusable) and report it ourselves.
  const workerfs=core.FS.filesystems.WORKERFS.stream_ops,read=workerfs.read;
  workerfs.read=function(...args){try{return read.apply(this,args);}catch(e){if(e?.name==='ErrnoError')throw e;ioError='read';throw new core.FS.ErrnoError(29);}};
  await initDisk();
  const encoders=run(['-encoders'],true).text, muxers=run(['-muxers'],true).text;
  const has=(text,name)=>new RegExp('\\s'+name+'\\s').test(text);
  caps={formats:Object.fromEntries(Object.entries(FORMATS).map(([k,v])=>[k,{supported:has(encoders,v.encoder)&&has(muxers,v.muxer)&&(!v.videoEncoder||has(encoders,v.videoEncoder))}])),
    limits:{disk:!!disk,pcmBudget:PCM_BUDGET,maxPcm:MAX_PCM}};
  for(const key of ['opus','webm']) if(caps.formats[key].supported)caps.formats[key].note=OPUS_MONO_NOTE;
  status('ready','처리 도구 준비 완료');
}
function source(id) { const s=sources.get(id);if(!s)fail('필요한 원본 파일을 찾지 못했습니다. 원본을 다시 선택해 주세요.','MISSING_SOURCE');return s; }
function formatOptions(output,meta) {
  const key=output.format||'mp3', f=FORMATS[key];if(!f||!caps.formats[key].supported)fail('현재 처리 도구에서 지원되지 않는 출력 형식입니다.','UNSUPPORTED');
  let rate=num(output.sampleRate,0)||meta.sampleRate;
  let channels=num(output.channels,0)||meta.channels;
  if(![1,2,3,4,5,6,7,8].includes(channels))fail('출력 채널은 1~8개 범위에서 선택해 주세요.','SETTINGS');
  if(channels>(MAX_CHANNELS[key]||8))channels=MAX_CHANNELS[key];
  const bitrate=num(output.bitrate,192);
  if(key==='mp3'){
    if(!MP3_RATES.includes(rate))rate=48000;
    if(![64,96,128,160,192,256,320].includes(bitrate))fail('지원되는 MP3 비트레이트를 선택해 주세요.','SETTINGS');
    // MP3 below 32 kHz tops out at 160 kbps. With "원본 유지" a low-rate recording
    // (16/22.05 kHz) is raised to 44.1 kHz instead of failing the default settings.
    if(rate<32000&&bitrate>160){
      if(num(output.sampleRate,0))fail('32 kHz 미만의 MP3는 160 kbps 이하로 선택해 주세요. 192~320 kbps는 44.1 또는 48 kHz를 사용하세요.','SETTINGS');
      rate=44100;
    }
  }
  else if(key==='opus'||key==='webm') rate=48000;
  else if(['m4a','aac','m4r','mp4'].includes(key)&&!AAC_RATES.includes(rate)) rate=nearest(rate,AAC_RATES);
  else if(key==='mp2'&&!MP2_RATES.includes(rate)) rate=nearest(rate,MP2_RATES);
  else if(key==='ac3'&&!AC3_RATES.includes(rate)) rate=nearest(rate,AC3_RATES);
  else if(key==='wma'&&rate>48000) rate=48000;
  if(rate<8000||rate>192000)fail('출력 샘플레이트는 8~192 kHz 범위에서 선택해 주세요.','SETTINGS');
  const wanted=num(output.bitDepth,16);
  const depth=key==='wav'?([8,16,24,32].includes(wanted)?wanted:16):['aiff','caf','au','flac','alac'].includes(key)?([16,24].includes(wanted)?wanted:16):16;
  const encoder=PCM_ENCODERS[key]?PCM_ENCODERS[key][depth]:f.encoder;
  const args=['-c:a',encoder,'-ar',String(rate),...(channels===4?['-ch_layout','4.0']:['-ac',String(channels)])];
  if(key==='mp3') args.push('-b:a',`${bitrate}k`);
  else if(['m4a','aac','m4r','mp4'].includes(key)){ args.push('-b:a',`${num(bitrate,192,32,320)}k`); if(key==='mp4') args.push('-aac_coder','fast'); if(key==='m4a'||key==='m4r') args.push('-movflags','+faststart'); }
  // Vorbis accepts a different bitrate range for every rate/channel pair, so use its quality scale.
  else if(key==='ogg'||key==='webmv') args.push('-q:a',String(Math.round(num(output.oggQuality,4,0,10))));
  else if(key==='opus'||key==='webm') args.push('-b:a',`${num(bitrate,96,6,256)}k`,'-vbr','on','-compression_level','10');
  else if(key==='wma') args.push('-b:a',`${num(bitrate,128,32,192)}k`);
  else if(key==='mp2') args.push('-b:a',`${nearest(bitrate,rate>=32000?[32,48,56,64,80,96,112,128,160,192,224,256,320,384]:[8,16,24,32,40,48,56,64,80,96,112,128,144,160])}k`);
  else if(key==='ac3') args.push('-b:a',`${nearest(bitrate,AC3_KBPS)}k`);
  else if(key==='flac') args.push('-sample_fmt',depth===24?'s32':'s16','-bits_per_raw_sample',String(depth),'-compression_level',String(Math.round(num(output.compression,5,0,12))));
  else if(key==='alac') args.push('-sample_fmt',depth===24?'s32p':'s16p','-movflags','+faststart');
  return {key,...f,encoder,rate,channels,depth,args,bitrate};
}
function videoOptions(output) {
  const [width,height]=VIDEO_SIZES[output.videoSize]||VIDEO_SIZES['1280x720'];
  const style=output.videoStyle==='waves'?'waves':'cover';
  return {width,height,style,fps:style==='waves'?6:1};
}
function channelPan(src,out,mode){
  if(src>=2&&out===1)return mode==='left'?'pan=mono|c0=c0':mode==='right'?'pan=mono|c0=c1':src===2?'pan=mono|c0=0.5*c0+0.5*c1':'';
  if(src>=2&&out>=2)return {left:'pan=stereo|c0=c0|c1=c0',right:'pan=stereo|c0=c1|c1=c1',swap:'pan=stereo|c0=c1|c1=c0'}[mode]||'';
  if(src===1&&out===2)return 'pan=stereo|c0=c0|c1=c0';
  return '';
}
function tempoFilters(rate) {const r=[];let value=rate;while(value<0.5){r.push('atempo=0.5');value/=0.5;}while(value>2){r.push('atempo=2');value/=2;}if(Math.abs(value-1)>1e-7)r.push(`atempo=${n(value)}`);return r;}
function buildGraph(model,format) {
  if(!Array.isArray(model.clips)||!model.clips.length||model.clips.length>200)fail('음원이 0초가 되는 편집은 저장할 수 없습니다. 원본이나 구간을 추가해 주세요.','RANGE');
  const rate=format.rate,channels=format.channels,layout=channels===1?'mono':channels===2?'stereo':{3:'2.1',4:'4.0',5:'5.0',6:'5.1',7:'6.1',8:'7.1'}[channels];
  const args=[],graph=[],opened=new Map();let inputs=0;
  // A piece reads from an input opened about a second before it when the container seeks exactly (WAV, FLAC, AIFF/CAF,
  // MP4/M4A/MOV, MKV/WebM, Ogg): two minutes from the middle of a three-hour recording are decoded from there, not from
  // the start. Pieces in increasing order share an input; a piece that goes back (reordered or duplicated) or that the
  // background needs at the same time gets its own input, so FFmpeg never has to hold the stretch in between in memory.
  // MP3/AAC streams are read from the start: their seek positions are estimates, so cuts could drift.
  const exact=meta=>/^(wav|w64|aiff|caf|flac|mov|matroska|ogg)/.test(meta.container||'');
  function input(id,start,own=false){
    const s=source(id),prev=own?null:opened.get(id);
    if(prev&&start>=prev.end-1e-6&&!(exact(s.metadata)&&start-prev.end>120))return prev;
    const seek=exact(s.metadata)?Math.max(0,start-1):0,next={index:inputs++,seek,end:start};
    args.push(...(seek>0?['-ss',n(seek)]:[]),'-i',s.path);if(!own)opened.set(id,next);return next;
  }
  const clips=model.clips.map(c=>{const s=c.sourceId?source(c.sourceId):null;const start=num(c.start),end=num(c.end,s?.metadata.duration||0);if(start<0||end<=start||(s&&end>s.metadata.duration+0.05))fail('선택 구간이 원본 범위를 벗어났습니다. 시작·끝 시간을 확인해 주세요.','RANGE');return {...c,start,end,duration:end-start,s};});
  // Channel choice happens before any downmix so "왼쪽만" really is the left microphone channel.
  const channelMode=model.effects?.channelMode;
  let duration=0,current='';
  clips.forEach((c,i)=>{
    const from=c.sourceId?input(c.sourceId,c.start):null,label=`clip${i}`;if(from)from.end=c.end;
    const filters=[`atrim=start=${n(c.start-(from?.seek||0))}:end=${n(c.end-(from?.seek||0))}`,'asetpts=PTS-STARTPTS'];
    const cp=c.s?channelPan(c.s.metadata.channels,channels,channelMode):'';if(cp)filters.push(cp);else if(channels===4&&c.s?.metadata.channels===4)filters.push('channelmap=channel_layout=4.0');
    filters.push(`aresample=${rate}:rematrix_maxval=1`,`aformat=sample_fmts=fltp:channel_layouts=${layout}`,`volume=${c.muted?0:n(num(c.gain,1,0,8))}`);
    if(model.edgeFade) {const edge=Math.min(.005,c.duration/2);filters.push(`afade=t=in:d=${n(edge)}`,`afade=t=out:st=${n(c.duration-edge)}:d=${n(edge)}`);}
    if(c.s)graph.push(`[${from.index}:a:${c.s.track}]${filters.join(',')}[${label}]`);
    else graph.push(`anullsrc=r=${rate}:cl=${layout},atrim=duration=${n(c.duration)},asetpts=PTS-STARTPTS[${label}]`);
    if(i===0){current=label;duration=c.duration;return;}
    const overlap=Math.min(num(model.crossfade,0,0,10),clips[i-1].duration/2,c.duration/2), out=`join${i}`;
    if(overlap>0)graph.push(`[${current}][${label}]acrossfade=d=${n(overlap)}:c1=tri:c2=tri[${out}]`);
    else graph.push(`[${current}][${label}]concat=n=2:v=0:a=1[${out}]`);
    duration+=c.duration-overlap;current=out;
  });
  const repeat=Math.round(num(model.repeat,1,1,20)),gap=num(model.gap,0,0,600);
  // aloop, areverse and the looped background keep their whole input in wasm memory.
  const wasmRoom=WASM_BUFFER/(rate*channels*4);
  if(repeat>1){const block=duration+gap;if(block>wasmRoom)fail(`반복할 부분이 너무 깁니다. 반복은 이 설정(${n(rate/1000)} kHz · ${channels}채널)에서 약 ${span(wasmRoom)}까지의 길이에 쓸 수 있어요.`,'TOO_LONG');const filt=[];if(gap)filt.push(`apad=pad_dur=${n(gap)}`);filt.push(`aloop=loop=${repeat-1}:size=${Math.round(block*rate)}`,`atrim=duration=${n(duration*repeat+gap*(repeat-1))}`);graph.push(`[${current}]${filt.join(',')}[repeated]`);current='repeated';duration=duration*repeat+gap*(repeat-1);}
  const speed=num(model.speed,1,.5,2),pitch=num(model.pitch,0,-12,12),factor=2**(pitch/12),transform=[];
  if(pitch){transform.push(`asetrate=${Math.round(rate*factor)}`,`aresample=${rate}`);}
  transform.push(...tempoFilters(speed/factor));duration/=speed;
  // Reversal sits before the pads and fades, so a fade-in still fades the start of the saved file.
  if(model.reverse===true){if(duration>wasmRoom)fail(`거꾸로 재생은 이 설정(${n(rate/1000)} kHz · ${channels}채널)에서 약 ${span(wasmRoom)}까지의 길이에 쓸 수 있어요. 구간을 줄여 주세요.`,'TOO_LONG');transform.push('areverse');}
  const body=duration,fadeIn=Math.min(num(model.fadeIn,0,0,600),body),fadeOut=Math.min(num(model.fadeOut,0,0,600),body);
  if(fadeIn)transform.push(`afade=t=in:d=${n(fadeIn)}`);if(fadeOut)transform.push(`afade=t=out:st=${n(Math.max(0,body-fadeOut))}:d=${n(fadeOut)}`);
  const padStart=num(model.padStart,0,0,600),padEnd=num(model.padEnd,0,0,600);
  if(padStart)transform.push(`adelay=${Math.round(padStart*rate)}S:all=1`);
  if(padEnd)transform.push(`apad=pad_dur=${n(padEnd)}`);
  duration+=padStart+padEnd;
  if(transform.length){graph.push(`[${current}]${transform.join(',')}[main]`);current='main';}
  const mix=model.mix;
  if(mix?.sourceId){
    const s=source(mix.sourceId),start=num(mix.start),end=num(mix.end,s.metadata.duration),bg=input(mix.sourceId,start,true);
    if(start<0||end<=start||end>s.metadata.duration+.05)fail('배경음 구간을 확인해 주세요.','RANGE');
    const bgLength=end-start,bgOffset=num(mix.offset,0,0,600),voiceOffset=num(mix.voiceOffset,0,0,600),voiceLength=duration+voiceOffset;
    const loopLength=Math.max(bgLength,voiceLength-bgOffset);
    duration=mix.lengthMode==='longest'?Math.max(voiceLength,bgOffset+(mix.loop?loopLength:bgLength)):voiceLength;
    const voiceMuted=false,bgMuted=false; // the mute/solo toggles were removed from the UI
    const voiceFilters=[`volume=${voiceMuted?0:n(10**(num(mix.voiceGainDb,0,-60,24)/20))}`];if(voiceOffset)voiceFilters.push(`adelay=${Math.round(voiceOffset*rate)}S:all=1`);voiceFilters.push(`apad=whole_dur=${n(duration)}`,`atrim=duration=${n(duration)}`);
    graph.push(`[${current}]${voiceFilters.join(',')}[voice]`);
    const bp=channelPan(s.metadata.channels,channels,'keep');
    const b=[`atrim=start=${n(start-bg.seek)}:end=${n(end-bg.seek)}`,'asetpts=PTS-STARTPTS',...(bp?[bp]:channels===4&&s.metadata.channels===4?['channelmap=channel_layout=4.0']:[]),`aresample=${rate}:rematrix_maxval=1`,`aformat=sample_fmts=fltp:channel_layouts=${layout}`];
    // [29] without looping, the music ends with the mix, so its fade-out must end there too
    const actualBg=Math.max(.001,mix.loop?duration-bgOffset:Math.min(bgLength,duration-bgOffset));
    if(mix.loop){if(bgLength>wasmRoom)fail(`반복하는 배경음 구간은 약 ${span(wasmRoom)}까지 쓸 수 있어요. 배경음 구간을 줄이거나 반복을 꺼 주세요.`,'TOO_LONG');b.push(`aloop=loop=-1:size=${Math.max(1,Math.round(bgLength*rate))}`);}
    b.push(`atrim=duration=${n(actualBg)}`);
    b.push(`volume=${bgMuted?0:n(10**(num(mix.gainDb,-16,-60,24)/20))}`);
    const bi=Math.min(num(mix.fadeIn,0,0,600),actualBg),bo=Math.min(num(mix.fadeOut,0,0,600),actualBg);
    if(bi)b.push(`afade=t=in:d=${n(bi)}`);if(bo)b.push(`afade=t=out:st=${n(Math.max(0,actualBg-bo))}:d=${n(bo)}`);
    if(bgOffset)b.push(`adelay=${Math.round(bgOffset*rate)}S:all=1`);b.push(`apad=whole_dur=${n(duration)}`,`atrim=duration=${n(duration)}`);
    graph.push(`[${bg.index}:a:${s.track}]${b.join(',')}[background]`);
    if(mix.duck&&!voiceMuted&&!bgMuted){
      const threshold=10**(num(mix.duckThreshold,-30,-60,-6)/20),wet=1-10**(-num(mix.duckAmount,12,0,30)/20),release=num(mix.duckRelease,.4,.05,5)*1000;
      graph.push('[voice]asplit=2[voiceMix][sidechain]');graph.push(`[background][sidechain]sidechaincompress=threshold=${n(threshold)}:ratio=20:attack=15:release=${n(release)}:makeup=1:mix=${n(wet)}[ducked]`);
      graph.push('[voiceMix][ducked]amix=inputs=2:normalize=0:duration=first[mixed]');
    }else graph.push('[voice][background]amix=inputs=2:normalize=0:duration=first[mixed]');
    current='mixed';
  }
  const e=model.effects||{},effects=[];
  if(e.noise&&e.noise!=='off'){const nr={light:6,medium:12,strong:20}[e.noise];if(!nr)fail('잡음 감소 설정을 확인해 주세요.','SETTINGS');effects.push(`afftdn=nr=${nr}:nf=-35:tn=1`);}
  if(e.highpass)effects.push('highpass=f=80');
  for(const [value,freq,width] of [[e.clarity,2500,1],[e.eqLow,120,1],[e.eqMid,1000,1],[e.eqHigh,6000,1]])if(num(value))effects.push(`equalizer=f=${freq}:t=o:w=${width}:g=${n(num(value,0,-12,12))}`);
  if(num(e.gainDb))effects.push(`volume=${n(num(e.gainDb,0,-60,24))}dB`);
  if(e.compressor)effects.push('acompressor=threshold=0.125:ratio=3:attack=20:release=250:makeup=1');
  effects.push(`atrim=duration=${n(duration)}`,'asetpts=PTS-STARTPTS');
  graph.push(`[${current}]${effects.join(',')}[processed]`);
  // The float work file of the render: on disk with OPFS, in memory without it.
  const cap=disk?RENDER_BUDGET:MAX_PCM;
  if(duration*rate*channels*4>cap)fail(`최종 음원이 너무 깁니다. 이 설정(${n(rate/1000)} kHz · ${channels}채널)으로는 약 ${span(cap/(rate*channels*4))}까지 만들 수 있어요. 반복 횟수·재생 시간·샘플레이트·채널 수를 줄여 주세요.`,'TOO_LONG');
  return {args,graph:graph.join(';'),duration,clips};
}
function normalizeFilters(path,enabled,limiter,duration=0) {
  const filters=[],notes=[];
  if(enabled){
    status('normalizing','음량 기준 분석 중');
    const report=run(['-i',path,'-af','loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json','-f','null','-'],false,{phase:'normalizing',label:'음량 기준 분석 중',duration}).text;
    const match=report.match(/\{\s*"input_i"[\s\S]*?\}/);let m=null;try{m=JSON.parse(match?.[0]);}catch(_){}
    const input=Number(m?.input_i),tp=Number(m?.input_tp);
    if(!Number.isFinite(input)||input < -50)notes.push('무음·매우 작은 소리는 과도한 증폭을 막기 위해 음량 균일화를 적용하지 않았습니다.');
    else {
      const target=Math.min(-16,input+18);if(target!==-16)notes.push('과도한 증폭을 막기 위해 음량 균일화 증폭을 최대 18 dB로 제한했습니다.');
      filters.push(`loudnorm=I=${n(target)}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${target===-16?m.target_offset:0}:linear=true:print_format=summary`);
      notes.push(`음량 균일화 목표 ${n(target)} LUFS, true peak 상한 -1.5 dBTP`);
    }
  }
  if(limiter)filters.push('alimiter=limit=0.891251:level=0:latency=1');
  return {filters,notes};
}
function tagArgs(output,metaIndex) {
  const args=['-map_metadata',String(metaIndex),'-map_chapters','-1'];
  if(metaIndex>=0)args.push('-metadata','TLEN=');
  if(output.metadataMode==='edit')for(const key of ['title','artist','album'])args.push('-metadata',`${key}=${String(output[key]||'').slice(0,300)}`);
  return args;
}
// Options: preview → the edit as sound for 편집본 B (PCM at options.pcmRate); analysis → only the loudness envelope
// for 무음 찾기; otherwise an output file, plus its decoded sound for 최종 파일 듣기 when options.listen is set.
async function render(model,output,options) {
  const firstId=model.clips?.find(c=>c.sourceId)?.sourceId;
  const first=firstId?source(firstId):{path:null,metadata:{sampleRate:48000,channels:2}};
  const sound=options.preview||options.analysis;
  const actualOutput=sound?{...output,format:'wav',bitDepth:16,channels:options.analysis?(num(output.channels,0)||first.metadata.channels):Math.min(num(output.channels,0)||first.metadata.channels,MAX_CHANNELS[output.format||'mp3']||8)}:output;
  const f=formatOptions(actualOutput,first.metadata), built=buildGraph(model,f), length=built.duration;
  const floatBytes=length*f.rate*f.channels*4;
  await ensureSpace(floatBytes+(sound?0:f.kind==='pcm'||f.kind==='lossless'?floatBytes:length*2500000/8));
  const job=await scratch('render_float.wav',...(sound?[]:[`result.${f.extension}`]));
  const [temp,final]=job.paths,label=options.preview?'편집 결과 만드는 중':options.analysis?'무음 찾는 중':'편집·보정 중';
  status('processing',label);unlink('cover.png');
  try{
    run([...built.args,'-filter_complex',built.graph,'-map','[processed]','-vn','-sn','-dn','-c:a','pcm_f32le','-ar',String(f.rate),'-ac',String(f.channels),'-map_metadata','-1','-threads','1',temp],false,{phase:'processing',label,duration:length});
    const {filters,notes}=normalizeFilters(temp,model.effects?.normalize,model.effects?.limiter,length);
    if(sound){
      const rate=options.analysis?f.rate:num(options.pcmRate,48000,8000,192000);
      status('encoding',options.analysis?'무음 찾는 중':'편집본 준비 중');
      const got=decodeTo(temp,'0:a:0',f.channels,rate,{keep:!options.analysis,envelope:!!options.analysis},{filters,label:options.analysis?'무음 찾는 중':'편집본 준비 중',duration:length});
      return {pcm:got.pcm,envelope:got.envelope,metadata:{duration:got.frames/rate,sampleRate:f.rate,channels:f.channels,codec:'pcm_s16le'},summary:{notes,format:'wav',kind:'pcm'}};
    }
    let video=null;
    if(f.kind==='video'){
      if(!(options.cover instanceof Uint8Array)||options.cover.length<100)fail('영상 배경 그림이 준비되지 않았습니다. 영상 설정을 확인하고 다시 변환해 주세요.','SETTINGS');
      video=videoOptions(output);
      const videoLabel=video.style==='waves'?'파형 영상 만드는 중 · 시간이 걸려요':'영상으로 만드는 중';
      status('encoding',videoLabel);
      core.FS.writeFile('cover.png',options.cover);
      const args=['-loop','1','-framerate',String(video.fps),'-i','cover.png','-i',temp];let metaIndex=-1;
      if(output.metadataMode==='keep'&&first.path){metaIndex=2;args.push('-i',first.path);}
      const audioChain=filters.length?filters.join(','):'anull';
      let graph;
      if(video.style==='waves'){
        const waveHeight=Math.round(video.height*.3/2)*2,top=Math.round((video.height-waveHeight)*.72/2)*2;
        const color=/^#[0-9a-f]{6}$/i.test(options.waveColor||'')?'0x'+options.waveColor.slice(1):'0xffffff';
        graph=`[1:a]asplit=2[wa][oa];[wa]showwaves=s=${video.width}x${waveHeight}:mode=cline:rate=${video.fps}:colors=${color}@0.9[w];[0:v][w]overlay=0:${top}:shortest=1,format=yuv420p[v];[oa]${audioChain}[a]`;
      } else graph=`[0:v]format=yuv420p[v];[1:a]${audioChain}[a]`;
      args.push('-filter_complex',graph,'-map','[v]','-map','[a]','-t',n(length),'-r',String(video.fps));
      if(f.videoEncoder==='libx264')args.push('-c:v','libx264','-preset','ultrafast',...(video.style==='waves'?['-crf','28']:['-tune','stillimage','-crf','23']),'-g',String(video.fps*30),'-profile:v','main','-level','4.0');
      else args.push('-c:v','libvpx','-b:v',video.style==='waves'?'1500k':'400k','-deadline','realtime','-cpu-used','8','-g',String(video.fps*30));
      args.push(...f.args,...tagArgs(output,metaIndex));
      if(f.key==='mp4')args.push('-movflags','+faststart');
      args.push('-f',f.muxer,'-threads','1',final);run(args,false,{phase:'encoding',label:videoLabel,duration:length});
      notes.push(`${video.width}×${video.height} · ${video.style==='waves'?'파형 애니메이션 6 fps':'정지 화면 1 fps'} · ${f.videoCodec==='h264'?'H.264 + AAC':'VP8 + Vorbis'}`);
    } else {
      status('encoding','선택한 형식으로 변환 중');
      const args=['-i',temp];let metaIndex=-1;
      if(output.metadataMode==='keep'&&first.path){metaIndex=1;args.push('-i',first.path);}
      args.push('-map','0:a:0','-vn','-sn','-dn');if(filters.length)args.push('-af',filters.join(','));
      args.push(...f.args,...tagArgs(output,metaIndex));
      // Past 4 GB a plain WAV header overflows; RF64 keeps such a file readable.
      if(f.key==='wav')args.push('-rf64','auto');
      args.push('-f',f.muxer,'-threads','1',final);run(args,false,{phase:'encoding',label:'선택한 형식으로 변환 중',duration:length});
    }
    return finishOutput(final,f,{length,notes,output,first,listen:options.listen,pcmRate:options.pcmRate,preview:false});
  }finally{await job.release();unlink('cover.png');}
}
// Check the written file, hand it over as a Blob, and decode it for 최종 파일 듣기 when asked.
function finishOutput(final,f,{length,notes,output,first,listen,pcmRate,copy=false}) {
  status('verifying','실제 출력 정보 확인 중');
  const meta=metadata(probe(final));if(f.muxer==='adts'){meta.duration=length;meta.bitrate=null;}
  const size=core.FS.stat(final).size;
  if(size<64||meta.duration<=0)fail('빈 결과가 생성되었습니다. 원본과 선택 구간을 확인해 주세요.','EMPTY_OUTPUT');
  if(!copy){
    if(first.metadata.channels!==f.channels)notes.push(`출력 채널을 ${first.metadata.channels}개에서 ${f.channels}개로 변환했습니다.`);
    if((Number(output.sampleRate)||first.metadata.sampleRate)!==f.rate)notes.push(`출력 코덱의 지원 범위에 맞춰 ${f.rate} Hz로 변환했습니다.`);
    if((f.key==='opus'||f.key==='webm')&&first.metadata.channels>1)notes.push('Opus는 이 엔진에서 모노로만 안정적으로 저장돼 모노로 저장했습니다.');
    if(f.key==='m4r'&&meta.duration>40)notes.push('아이폰 벨소리는 40초 이내여야 합니다. 구간을 줄여 다시 변환해 보세요.');
  }
  status('verifying','결과 파일 넘기는 중');
  const blob=fileBlob(final,f.mime);
  let pcm=null;
  if(listen){
    // The real encoded file, decoded: what 최종 파일 듣기 plays.
    try{pcm=decodeTo(final,'0:a:0',meta.channels||f.channels,num(pcmRate,48000,8000,192000),{},{label:'최종 파일 듣기 준비 중',duration:meta.duration}).pcm;}
    catch(e){if(e.code==='DISK_FULL'||e.code==='SOURCE_READ')throw e;pcm=null;}
  }
  return {blob,size,mime:f.mime,extension:f.extension,metadata:meta,pcm,summary:{notes,format:f.key,kind:f.kind,...(copy?{copy:true}:{})}};
}
async function copyExtract(data){
  const s=source(data.sourceId),codec=s.metadata.codec;const map={aac:'m4a',mp3:'mp3',flac:'flac',vorbis:'ogg',opus:'opus',alac:'alac',ac3:'ac3',mp2:'mp2',wmav2:'wma',pcm_s16le:'wav',pcm_s24le:'wav',pcm_f32le:'wav',pcm_u8:'wav',pcm_s16be:'aiff',pcm_s24be:'aiff'};
  const key=map[codec];if(!key||(data.format&&data.format!==key))fail('이 코덱과 출력 형식 조합은 재인코딩 없이 추출할 수 없습니다. 일반 변환을 사용해 주세요.','COPY_UNSUPPORTED');
  const f={...FORMATS[key],key},start=num(data.start),end=data.end==null?s.metadata.duration:num(data.end);if(start<0||end<=start||end>s.metadata.duration+.05)fail('추출 구간을 확인해 주세요.','RANGE');
  const bitrate=(s.metadata.bitrate||1500)*1000/8;
  await ensureSpace((end-start)*bitrate*1.2);
  const job=await scratch('copy.'+f.extension),[final]=job.paths;
  const args=['-ss',String(start),'-i',s.path,'-t',String(end-start),'-map',`0:a:${s.track}`,'-vn','-sn','-dn','-c:a','copy','-map_metadata',data.metadataMode==='keep'?'0':'-1',...(key==='wav'?['-rf64','auto']:[]),'-f',f.muxer,final];
  try{
    status('processing','원본 소리 추출 중');run(args,false,{phase:'processing',label:'원본 소리 추출 중',duration:end-start});
    return finishOutput(final,f,{length:end-start,notes:['재인코딩 없는 구간 추출은 코덱 패킷 경계 때문에 시작·끝에 작은 차이가 있을 수 있습니다.'],listen:data.listen,pcmRate:data.pcmRate,copy:true});
  }finally{await job.release();}
}
self.onmessage=async({data})=>{
  const requestId=data.requestId;
  try{
    await initialize();let result;
    if(data.type==='init')result={ready:true};
    else if(data.type==='capabilities')result=caps;
    else if(data.type==='restore'){const path=mountSource(data.id,data.file);sources.set(data.id,{path,metadata:data.metadata,track:data.track});result=true;}
    else if(data.type==='analyze')result=analyze(data);
    else if(data.type==='render')result=await render(data.model,data.output,data.options||{});
    else if(data.type==='copy')result=await copyExtract(data);
    else if(data.type==='remove'){unmountSource(data.id);sources.delete(data.id);result=true;}
    else fail('알 수 없는 처리 요청입니다.','REQUEST');
    const transfer=[result?.peaks?.values?.buffer,result?.envelope?.values?.buffer].filter(Boolean);
    self.postMessage({requestId,result,recycle:stackGuard===false&&callsWithoutGuard>40},transfer);
  }catch(error){const fatal=/out of memory|memory access out of bounds|Cannot enlarge memory|allocation failed/i.test(error.message);self.postMessage({requestId,error:{message:fatal?'처리 도구의 메모리 오류가 발생했습니다. 짧은 구간이나 다른 형식으로 다시 시도해 주세요. 원본과 편집 설정은 유지됩니다.':error.message||'처리 중 오류가 발생했습니다.',code:fatal?'MEMORY':error.code||'ENGINE',fatal,details:error.details||''}});}
};
