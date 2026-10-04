/* @ffmpeg/core 0.12.10, single threaded; all temporary media is in MEMFS. */
'use strict';
importScripts('./vendor/ffmpeg-core.js');
let core, activeRequest = null, logs = [], caps = null;
const sources = new Map();
const MAX_PCM = 256000000;
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
function status(phase,message,time=null) { self.postMessage({status:{phase,message,progress:null,time}}); }
function fail(message,code='PROCESSING',details='') { const e = new Error(message); e.code=code;e.details=details;throw e; }
function num(value,fallback=0,min=-Infinity,max=Infinity) { const v=Number(value); return Number.isFinite(v)?Math.max(min,Math.min(max,v)):fallback; }
function n(value) { return Number(value.toFixed(8)).toString(); }
const nearest=(value,list)=>list.reduce((best,v)=>Math.abs(v-value)<Math.abs(best-value)?v:best,list[0]);
function unlink(path) { try { core.FS.unlink(path); } catch (_) {} }
function run(args,allowFailure=false) {
  logs=[];core.reset(); const code=core.exec('-hide_banner','-loglevel','info','-nostdin',...args); const text=logs.join('\n');core.reset();
  if(code!==0&&!allowFailure) classify(text);
  return {code,text};
}
function classify(text) {
  if (/out of memory|Cannot enlarge memory|memory access out of bounds|allocation failed/i.test(text)) fail('브라우저 메모리가 부족합니다. 새 작업을 열고 짧은 구간이나 작은 파일로 다시 시도해 주세요.','MEMORY');
  if (/Decoder.*not found|Unknown decoder|Unsupported codec|not supported in WAVE/i.test(text)) fail('이 파일의 코덱은 현재 처리 도구에서 지원되지 않습니다. WAV, MP3 또는 AAC 파일로 준비해 주세요.','UNSUPPORTED');
  if (/Invalid data found|moov atom not found|Error while decoding|Invalid PCM packet|corrupt/i.test(text)) fail('파일이 손상되었거나 올바른 영상·음원 형식이 아닙니다. 원본 파일이 정상 재생되는지 확인해 주세요.','CORRUPT');
  fail('음원을 처리하지 못했습니다. 구간과 출력 설정을 확인하거나 다른 형식으로 다시 시도해 주세요.','PROCESSING',text.slice(-3000).replace(/source_[a-z0-9_]+/gi,'[원본]'));
}
function probe(path) {
  unlink('probe.json');logs=[];core.reset();
  const code=core.ffprobe('-v','error','-show_streams','-show_format','-of','json','-o','probe.json',path);core.reset();
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
    averageBitrate:!picture&&num(json.format?.bit_rate)>0?num(json.format.bit_rate)/1000:null,
    channelLayout:s.channel_layout||'',track,streamIndex:s.index,
    video:picture?{codec:picture.codec_name||'',width:num(picture.width),height:num(picture.height),fps:frameRate(picture.avg_frame_rate)||frameRate(picture.r_frame_rate)}:null,
    tracks:audio.map((t,index)=>({index,streamIndex:t.index,codec:t.codec_name,language:t.tags?.language||'',title:t.tags?.title||'',channels:t.channels,sampleRate:num(t.sample_rate)})),
    tags:{...(json.format?.tags||{}),...(s.tags||{})}};
}
function memoryCheck(meta) {
  if(meta.duration<=0) fail('파일의 재생 시간을 확인할 수 없습니다. 정상적인 음원 파일로 다시 저장해 주세요.','DURATION');
  if(meta.channels<1||meta.channels>8) fail('현재는 최대 8개 채널의 원본을 열 수 있습니다. 모노 또는 스테레오로 변환한 원본을 사용해 주세요.','CHANNELS');
  if(meta.duration*meta.sampleRate*meta.channels*4>MAX_PCM) fail('이 음원의 디코딩 크기가 256 MB를 넘습니다. 재생 시간을 줄이거나 샘플레이트·채널 수를 낮춘 파일을 준비해 주세요.','MEMORY');
}
function readDelete(path) { const bytes=new Uint8Array(core.FS.readFile(path));unlink(path);return bytes; }
function decode(path,track=0,meta=null) {
  const m=meta||metadata(probe(path),track);memoryCheck(m);
  unlink('decode.wav');
  try { run(['-i',path,'-map',`0:a:${track}`,'-vn','-sn','-dn','-c:a','pcm_s16le','-ar',String(m.sampleRate),'-ac',String(m.channels),'-map_metadata','-1','decode.wav']);return readDelete('decode.wav'); }
  finally { unlink('decode.wav'); }
}
async function initialize() {
  if(core)return;
  status('loading','처리 도구 준비 중');
  try{core=await createFFmpegCore({mainScriptUrlOrBlob:new URL('vendor/ffmpeg-core.js',self.location.href).href+'#'+btoa(JSON.stringify({wasmURL:new URL('vendor/ffmpeg-core.wasm',self.location.href).href}))});}
  catch(_){core=null;fail('처리 도구(vendor/ffmpeg-core.wasm)를 불러오지 못했습니다. 폴더 안에 이 파일이 그대로 있는지 확인하고 새로고침해 주세요.','ENGINE_LOAD');}
  core.setLogger(({message})=>{logs.push(message); if(logs.length>8000)logs.shift();});
  core.setProgress(({time})=>{if(activeRequest)status(activeRequest.phase,activeRequest.message,num(time)/1000000);});
  const encoders=run(['-encoders'],true).text, filters=run(['-filters'],true).text, muxers=run(['-muxers'],true).text;
  const has=(text,name)=>new RegExp('\\s'+name+'\\s').test(text);
  const filterNames=['atrim','asetpts','aresample','aformat','volume','concat','acrossfade','asplit','aloop','apad','adelay','afade','amix','sidechaincompress','afftdn','highpass','equalizer','acompressor','loudnorm','alimiter','asetrate','atempo','volumedetect','pan','areverse','showwaves','overlay','format'];
  caps={version:'@ffmpeg/core 0.12.10 / FFmpeg 5.1.4',singleThread:true,maxFileBytes:120000000,maxTotalSourceBytes:200000000,maxDecodedBytes:MAX_PCM,
    formats:Object.fromEntries(Object.entries(FORMATS).map(([k,v])=>[k,{...v,supported:has(encoders,v.encoder)&&has(muxers,v.muxer)&&(!v.videoEncoder||has(encoders,v.videoEncoder))}])),
    filters:Object.fromEntries(filterNames.map(name=>[name,has(filters,name)])),pitchMethod:'asetrate + atempo',normalizeTargetLUFS:-16,normalizeTruePeakDB:-1.5,normalizeMaxGainDB:18,
    videoSizes:Object.keys(VIDEO_SIZES),videoStyles:['cover','waves']};
  for(const key of ['opus','webm']) if(caps.formats[key].supported){caps.formats[key].note=OPUS_MONO_NOTE;caps.formats[key].monoOnly=true;}
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
    if(rate<32000&&bitrate>160&&!output.vbr){
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
  const args=['-c:a',encoder,'-ar',String(rate),'-ac',String(channels)];
  if(key==='mp3') args.push(...(output.vbr?['-q:a',String(num(output.quality,3,0,9))]:['-b:a',`${bitrate}k`]));
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
function tempoFilters(rate) {const r=[];let value=rate;while(value<0.5){r.push('atempo=0.5');value/=0.5;}while(value>2){r.push('atempo=2');value/=2;}if(Math.abs(value-1)>1e-7)r.push(`atempo=${n(value)}`);return r;}
function buildGraph(model,format) {
  if(!Array.isArray(model.clips)||!model.clips.length||model.clips.length>200)fail('음원이 0초가 되는 편집은 저장할 수 없습니다. 원본이나 구간을 추가해 주세요.','RANGE');
  const rate=format.rate,channels=format.channels,layout=channels===1?'mono':channels===2?'stereo':{3:'2.1',4:'quad',5:'5.0',6:'5.1',7:'6.1',8:'7.1'}[channels];
  const args=[],graph=[],inputs=new Map();
  function input(id){if(!inputs.has(id)){inputs.set(id,inputs.size);args.push('-i',source(id).path);}return inputs.get(id);}
  const clips=model.clips.map(c=>{const s=c.sourceId?source(c.sourceId):null;const start=num(c.start),end=num(c.end,s?.metadata.duration||0);if(start<0||end<=start||(s&&end>s.metadata.duration+0.05))fail('선택 구간이 원본 범위를 벗어났습니다. 시작·끝 시간을 확인해 주세요.','RANGE');return {...c,start,end,duration:end-start,s};});
  // Channel choice happens before any downmix so "왼쪽만" really is the left microphone channel.
  const channelMode=model.effects?.channelMode,pan={left:'pan=stereo|c0=c0|c1=c0',right:'pan=stereo|c0=c1|c1=c1',swap:'pan=stereo|c0=c1|c1=c0'}[channelMode];
  let duration=0,current='';
  clips.forEach((c,i)=>{
    const idx=c.sourceId?input(c.sourceId):null,label=`clip${i}`;
    const filters=[`atrim=start=${n(c.start)}:end=${n(c.end)}`,'asetpts=PTS-STARTPTS'];
    if(pan&&c.s&&c.s.metadata.channels>=2)filters.push(pan);
    filters.push(`aresample=${rate}`,`aformat=sample_fmts=fltp:channel_layouts=${layout}`,`volume=${c.muted?0:n(num(c.gain,1,0,8))}`);
    if(model.edgeFade) {const edge=Math.min(.005,c.duration/2);filters.push(`afade=t=in:d=${n(edge)}`,`afade=t=out:st=${n(c.duration-edge)}:d=${n(edge)}`);}
    if(c.s)graph.push(`[${idx}:a:${c.s.track}]${filters.join(',')}[${label}]`);
    else graph.push(`anullsrc=r=${rate}:cl=${layout},atrim=duration=${n(c.duration)},asetpts=PTS-STARTPTS[${label}]`);
    if(i===0){current=label;duration=c.duration;return;}
    const overlap=Math.min(num(model.crossfade,0,0,10),clips[i-1].duration/2,c.duration/2), out=`join${i}`;
    if(overlap>0)graph.push(`[${current}][${label}]acrossfade=d=${n(overlap)}:c1=tri:c2=tri[${out}]`);
    else graph.push(`[${current}][${label}]concat=n=2:v=0:a=1[${out}]`);
    duration+=c.duration-overlap;current=out;
  });
  const repeat=Math.round(num(model.repeat,1,1,20)),gap=num(model.gap,0,0,600);
  if(repeat>1){const block=duration+gap;const filt=[];if(gap)filt.push(`apad=pad_dur=${n(gap)}`);filt.push(`aloop=loop=${repeat-1}:size=${Math.round(block*rate)}`,`atrim=duration=${n(duration*repeat+gap*(repeat-1))}`);graph.push(`[${current}]${filt.join(',')}[repeated]`);current='repeated';duration=duration*repeat+gap*(repeat-1);}
  const speed=num(model.speed,1,.5,2),pitch=num(model.pitch,0,-12,12),factor=2**(pitch/12),transform=[];
  if(pitch){transform.push(`asetrate=${Math.round(rate*factor)}`,`aresample=${rate}`);}
  transform.push(...tempoFilters(speed/factor));duration/=speed;
  // Reversal sits before the pads and fades, so a fade-in still fades the start of the saved file.
  if(model.reverse===true)transform.push('areverse');
  const padStart=num(model.padStart,0,0,600),padEnd=num(model.padEnd,0,0,600);
  if(padStart)transform.push(`adelay=${Math.round(padStart*rate)}S:all=1`);
  if(padEnd)transform.push(`apad=pad_dur=${n(padEnd)}`);
  duration+=padStart+padEnd;
  const fadeIn=Math.min(num(model.fadeIn,0,0,600),duration),fadeOut=Math.min(num(model.fadeOut,0,0,600),duration);
  if(fadeIn)transform.push(`afade=t=in:d=${n(fadeIn)}`);if(fadeOut)transform.push(`afade=t=out:st=${n(duration-fadeOut)}:d=${n(fadeOut)}`);
  if(transform.length){graph.push(`[${current}]${transform.join(',')}[main]`);current='main';}
  const mix=model.mix;
  if(mix?.sourceId){
    const s=source(mix.sourceId),idx=input(mix.sourceId),start=num(mix.start),end=num(mix.end,s.metadata.duration);
    if(start<0||end<=start||end>s.metadata.duration+.05)fail('배경음 구간을 확인해 주세요.','RANGE');
    const bgLength=end-start,bgOffset=num(mix.offset,0,0,600),voiceOffset=num(mix.voiceOffset,0,0,600),voiceLength=duration+voiceOffset;
    const loopLength=Math.max(bgLength,voiceLength-bgOffset);
    duration=mix.lengthMode==='longest'?Math.max(voiceLength,bgOffset+(mix.loop?loopLength:bgLength)):voiceLength;
    const voiceMuted=mix.voiceMuted||mix.solo===true||mix.solo==='background',bgMuted=mix.muted||mix.solo==='voice';
    const voiceFilters=[`volume=${voiceMuted?0:n(10**(num(mix.voiceGainDb,0,-60,24)/20))}`];if(voiceOffset)voiceFilters.push(`adelay=${Math.round(voiceOffset*rate)}S:all=1`);voiceFilters.push(`apad=whole_dur=${n(duration)}`,`atrim=duration=${n(duration)}`);
    graph.push(`[${current}]${voiceFilters.join(',')}[voice]`);
    const b=[`atrim=start=${n(start)}:end=${n(end)}`,'asetpts=PTS-STARTPTS',`aresample=${rate}`,`aformat=sample_fmts=fltp:channel_layouts=${layout}`];
    const actualBg=mix.loop?Math.max(.001,duration-bgOffset):bgLength;
    if(mix.loop)b.push(`aloop=loop=-1:size=${Math.max(1,Math.round(bgLength*rate))}`,`atrim=duration=${n(actualBg)}`);
    b.push(`volume=${bgMuted?0:n(10**(num(mix.gainDb,-16,-60,24)/20))}`);
    const bi=Math.min(num(mix.fadeIn,0,0,600),actualBg),bo=Math.min(num(mix.fadeOut,0,0,600),actualBg);
    if(bi)b.push(`afade=t=in:d=${n(bi)}`);if(bo)b.push(`afade=t=out:st=${n(Math.max(0,actualBg-bo))}:d=${n(bo)}`);
    if(bgOffset)b.push(`adelay=${Math.round(bgOffset*rate)}S:all=1`);b.push(`apad=whole_dur=${n(duration)}`,`atrim=duration=${n(duration)}`);
    graph.push(`[${idx}:a:${s.track}]${b.join(',')}[background]`);
    if(mix.duck&&!voiceMuted&&!bgMuted){
      const threshold=10**(num(mix.duckThreshold,-30,-60,-6)/20),wet=1-10**(-num(mix.duckAmount,12,0,30)/20),release=num(mix.duckRelease,.4,.05,5)*1000;
      graph.push('[voice]asplit=2[voiceMix][sidechain]');graph.push(`[background][sidechain]sidechaincompress=threshold=${n(threshold)}:ratio=20:attack=15:release=${n(release)}:makeup=1:mix=${n(wet)}[ducked]`);
      graph.push('[voiceMix][ducked]amix=inputs=2:normalize=0:duration=first[mixed]');
    }else graph.push('[voice][background]amix=inputs=2:normalize=0:duration=first[mixed]');
    current='mixed';
  }
  const e=model.effects||{},effects=[];
  if(e.noise&&e.noise!=='off'){const nr={light:6,medium:12,strong:20}[e.noise];if(!nr)fail('잡음 감소 설정을 확인해 주세요.','SETTINGS');effects.push(`afftdn=nr=${nr}:nf=-35:tn=1`);}
  if(e.highpass)effects.push(`highpass=f=${typeof e.highpass==='number'?num(e.highpass,80,30,300):80}`);
  for(const [value,freq,width] of [[e.clarity,2500,1],[e.eqLow,120,1],[e.eqMid,1000,1],[e.eqHigh,6000,1]])if(num(value))effects.push(`equalizer=f=${freq}:t=o:w=${width}:g=${n(num(value,0,-12,12))}`);
  if(num(e.gainDb))effects.push(`volume=${n(num(e.gainDb,0,-60,24))}dB`);
  if(e.compressor)effects.push('acompressor=threshold=0.125:ratio=3:attack=20:release=250:makeup=1');
  effects.push(`atrim=duration=${n(duration)}`,'asetpts=PTS-STARTPTS');
  graph.push(`[${current}]${effects.join(',')}[processed]`);
  if(duration*rate*channels*4>MAX_PCM)fail('최종 음원의 예상 디코딩 크기가 256 MB를 넘습니다. 반복 횟수·재생 시간·샘플레이트·채널 수를 줄여 주세요.','MEMORY');
  return {args,graph:graph.join(';'),duration,clips};
}
function normalizeFilters(path,enabled,limiter) {
  const filters=[],notes=[];
  if(enabled){
    status('normalizing','음량 기준 분석 중');
    const report=run(['-i',path,'-af','loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json','-f','null','-']).text;
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
  const args=['-map_metadata',String(metaIndex)];
  if(output.metadataMode==='edit')for(const key of ['title','artist','album'])args.push('-metadata',`${key}=${String(output[key]||'').slice(0,300)}`);
  return args;
}
async function render(model,output,options) {
  const firstId=model.clips?.find(c=>c.sourceId)?.sourceId;
  const first=firstId?source(firstId):{path:null,metadata:{sampleRate:48000,channels:2}};const actualOutput=options.preview?{...output,format:'wav',bitDepth:16,channels:Math.min(num(output.channels,0)||first.metadata.channels,MAX_CHANNELS[output.format||'mp3']||8)}:output;
  const f=formatOptions(actualOutput,first.metadata), built=buildGraph(model,f);
  activeRequest={phase:'processing',message:options.preview?'편집 결과 만드는 중':'편집·보정 중'};status(activeRequest.phase,activeRequest.message);
  const temp='render_float.wav',final=`result.${f.extension}`;unlink(temp);unlink(final);unlink('cover.png');
  try{
    run([...built.args,'-filter_complex',built.graph,'-map','[processed]','-vn','-sn','-dn','-c:a','pcm_f32le','-ar',String(f.rate),'-ac',String(f.channels),'-map_metadata','-1','-threads','1',temp]);
    const {filters,notes}=normalizeFilters(temp,model.effects?.normalize,model.effects?.limiter);
    let video=null;
    if(f.kind==='video'){
      if(!(options.cover instanceof Uint8Array)||options.cover.length<100)fail('영상 배경 그림이 준비되지 않았습니다. 영상 설정을 확인하고 다시 변환해 주세요.','SETTINGS');
      video=videoOptions(output);
      activeRequest={phase:'encoding',message:video.style==='waves'?'파형 영상 만드는 중 · 시간이 걸려요':'영상으로 만드는 중'};status(activeRequest.phase,activeRequest.message);
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
      args.push('-filter_complex',graph,'-map','[v]','-map','[a]','-t',n(built.duration),'-r',String(video.fps));
      if(f.videoEncoder==='libx264')args.push('-c:v','libx264','-preset','ultrafast',...(video.style==='waves'?['-crf','28']:['-tune','stillimage','-crf','23']),'-g',String(video.fps*30),'-profile:v','main','-level','4.0');
      else args.push('-c:v','libvpx','-b:v',video.style==='waves'?'1500k':'400k','-deadline','realtime','-cpu-used','8','-g',String(video.fps*30));
      args.push(...f.args,...tagArgs(output,metaIndex));
      if(f.key==='mp4')args.push('-movflags','+faststart');
      args.push('-f',f.muxer,'-threads','1',final);run(args);
      notes.push(`${video.width}×${video.height} · ${video.style==='waves'?'파형 애니메이션 6 fps':'정지 화면 1 fps'} · ${f.videoCodec==='h264'?'H.264 + AAC':'VP8 + Vorbis'}`);
    } else {
      activeRequest={phase:'encoding',message:options.preview?'편집본 준비 중':'선택한 형식으로 변환 중'};status(activeRequest.phase,activeRequest.message);
      const args=['-i',temp];let metaIndex=-1;
      if(output.metadataMode==='keep'&&first.path){metaIndex=1;args.push('-i',first.path);}
      args.push('-map','0:a:0','-vn','-sn','-dn');if(filters.length)args.push('-af',filters.join(','));
      args.push(...f.args,...tagArgs(output,metaIndex));
      args.push('-f',f.muxer,'-threads','1',final);run(args);
    }
    status('verifying','실제 출력 정보 확인 중');const meta=metadata(probe(final));const bytes=readDelete(final);
    if(bytes.length<64||meta.duration<=0)fail('빈 결과가 생성되었습니다. 원본과 선택 구간을 확인해 주세요.','EMPTY_OUTPUT');
    if(first.metadata.channels!==f.channels)notes.push(`출력 채널을 ${first.metadata.channels}개에서 ${f.channels}개로 변환했습니다.`);
    if((Number(output.sampleRate)||first.metadata.sampleRate)!==f.rate)notes.push(`출력 코덱의 지원 범위에 맞춰 ${f.rate} Hz로 변환했습니다.`);
    if((f.key==='opus'||f.key==='webm')&&first.metadata.channels>1&&!options.preview)notes.push('Opus는 이 엔진에서 모노로만 안정적으로 저장돼 모노로 저장했습니다.');
    if(f.key==='m4r'&&meta.duration>40)notes.push('아이폰 벨소리는 40초 이내여야 합니다. 구간을 줄여 다시 변환해 보세요.');
    return {bytes,mime:f.mime,extension:f.extension,metadata:meta,summary:{duration:meta.duration,plannedDuration:built.duration,clips:model.clips.length,speed:num(model.speed,1),pitch:num(model.pitch),repeat:num(model.repeat,1),mix:!!model.mix,reverse:model.reverse===true,notes,format:f.key,kind:f.kind,video:video?{...video,codec:f.videoCodec}:null,preview:!!options.preview}};
  }finally{activeRequest=null;unlink(temp);unlink(final);unlink('cover.png');}
}
function copyExtract(data){
  const s=source(data.sourceId),codec=s.metadata.codec;const map={aac:'m4a',mp3:'mp3',flac:'flac',vorbis:'ogg',opus:'opus',alac:'alac',ac3:'ac3',mp2:'mp2',wmav2:'wma',pcm_s16le:'wav',pcm_s24le:'wav',pcm_f32le:'wav',pcm_u8:'wav',pcm_s16be:'aiff',pcm_s24be:'aiff'};
  const key=map[codec];if(!key||(data.format&&data.format!==key))fail('이 코덱과 출력 형식 조합은 재인코딩 없이 추출할 수 없습니다. 일반 변환을 사용해 주세요.','COPY_UNSUPPORTED');
  const f=FORMATS[key],start=num(data.start),end=data.end==null?s.metadata.duration:num(data.end);if(start<0||end<=start||end>s.metadata.duration+.05)fail('추출 구간을 확인해 주세요.','RANGE');
  const final='copy.'+f.extension;const args=['-ss',String(start),'-i',s.path,'-t',String(end-start),'-map',`0:a:${s.track}`,'-vn','-sn','-dn','-c:a','copy','-map_metadata',data.metadataMode==='keep'?'0':'-1','-f',f.muxer,final];
  try{run(args);const meta=metadata(probe(final)),bytes=readDelete(final);return {bytes,mime:f.mime,extension:f.extension,metadata:meta,summary:{copy:true,format:key,kind:f.kind,notes:['재인코딩 없는 구간 추출은 코덱 패킷 경계 때문에 시작·끝에 작은 차이가 있을 수 있습니다.']}};}finally{unlink(final);}
}
self.onmessage=async({data})=>{
  const requestId=data.requestId;
  try{
    await initialize();let result;
    if(data.type==='init')result={ready:true};
    else if(data.type==='capabilities')result=caps;
    else if(data.type==='restore'){const path=data.id+'.media';core.FS.writeFile(path,data.bytes);sources.set(data.id,{path,metadata:data.metadata,track:data.track});result=true;}
    else if(data.type==='analyze'){
      const path=data.id+'.media';status('analyzing','파일의 오디오 트랙 분석 중');
      core.FS.writeFile(path,data.bytes);
      try{const meta=metadata(probe(path),data.track);memoryCheck(meta);status('decoding','파형에 사용할 실제 소리 읽는 중');const wav=decode(path,data.track,meta);sources.set(data.id,{path,metadata:meta,track:data.track});result={id:data.id,metadata:meta,wav};}catch(e){unlink(path);throw e;}
    }
    else if(data.type==='render')result=await render(data.model,data.output,data.options||{});
    else if(data.type==='decode'){const path='verify.media';core.FS.writeFile(path,data.bytes);try{result={wav:decode(path)};}finally{unlink(path);}}
    else if(data.type==='copy')result=copyExtract(data);
    else if(data.type==='remove'){const s=sources.get(data.id);if(s)unlink(s.path);sources.delete(data.id);result=true;}
    else fail('알 수 없는 처리 요청입니다.','REQUEST');
    const transfer=[];if(result?.bytes)transfer.push(result.bytes.buffer);if(result?.wav)transfer.push(result.wav.buffer);
    self.postMessage({requestId,result},transfer);
  }catch(error){activeRequest=null;const fatal=/out of memory|memory access out of bounds|Cannot enlarge memory|allocation failed/i.test(error.message);self.postMessage({requestId,error:{message:fatal?'처리 도구의 메모리 오류가 발생했습니다. 짧은 구간이나 다른 형식으로 다시 시도해 주세요. 원본과 편집 설정은 유지됩니다.':error.message||'처리 중 오류가 발생했습니다.',code:fatal?'MEMORY':error.code||'ENGINE',fatal,details:error.details||''}});}
};
