const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('../model.js');
const M = globalThis.StudioModel;
const source = { id: 'one', originalName: '한글 음원.wav', size: 123456, metadata: { duration: 10, sampleRate: 48000, channels: 2 } };
const second = { id: 'two', originalName: '배경.wav', size: 987654, metadata: { duration: 7, sampleRate: 44100, channels: 1 } };
let count = 0;
function test(name, fn) { fn(); count++; console.log(`✓ ${name}`); }
test('trim preserves source coordinates and original model', () => {
  const before = M.create(source), after = M.edit(before, 'trim', { start: 2, end: 6.125 });
  assert.deepEqual(after.clips[0], { sourceId: 'one', start: 2, end: 6.125, gain: 1, muted: false });
  assert.equal(M.duration(after), 4.125); assert.equal(before.clips[0].end, 10);
  assert.deepEqual(after.selection, { start: 0, end: 4.125 });
});
test('delete closes the gap; silence and gain preserve exact length', () => {
  const base = M.create(source), deleted = M.edit(base, 'delete', { start: 2, end: 5 });
  assert.equal(M.duration(deleted), 7);
  assert.deepEqual(deleted.clips.map(c => [c.start, c.end]), [[0, 2], [5, 10]]);
  const muted = M.edit(base, 'silence', { start: 1.25, end: 1.75 });
  assert.equal(M.duration(muted), 10); assert.equal(muted.clips[1].muted, true);
  const gained = M.edit(base, 'gain', { start: 2, end: 3, db: -6 });
  assert.ok(Math.abs(gained.clips[1].gain - 0.501187) < 1e-6);
  assert.throws(() => M.edit(base, 'delete', { start: 0, end: 10 }), /전체/);
  assert.throws(() => M.edit(base, 'trim', { start: 8, end: 7 }), /시작/);
});
test('repeat, gaps, speed, pads and crossfade produce agreed duration', () => {
  let m = M.edit(M.create(source), 'append', { source: second });
  m = M.edit(m, 'settings', { crossfade: 1, repeat: 3, gap: 2, speed: 2, padStart: 0.5, padEnd: 1.5 });
  assert.equal(M.baseDuration(m), 17); assert.equal(M.arrangementDuration(m), 16);
  assert.equal(M.duration(m), 28); // (16*3 + 2*2)/2 + 2
  const trimmed = M.edit(m, 'trim', { start: 1, end: 5 });
  assert.equal(trimmed.crossfade, 0);
  assert.equal(M.duration(trimmed), 10); // (4*3+4)/2+2
});
test('clip duplicate, reorder and removal retain source ranges', () => {
  let m = M.edit(M.create(source), 'split', { time: 3 });
  m = M.edit(m, 'bookmark', { time: 4, name: '문제 제시' });
  m = M.edit(m, 'reorder', { from: 1, to: 0 });
  assert.deepEqual(m.clips.map(c => [c.start, c.end]), [[3, 10], [0, 3]]);
  assert.equal(m.bookmarks[0].time, 1);
  m = M.edit(m, 'duplicateClip', { index: 1 }); assert.equal(M.duration(m), 13);
  m = M.edit(m, 'removeClip', { index: 1 }); assert.equal(M.duration(m), 10);
});
test('fixed splits, inserted silence and merged removal ranges', () => {
  let m = M.edit(M.create(source), 'splitFixed', { seconds: 3 });
  assert.deepEqual(m.clips.map(c => c.end - c.start), [3, 3, 3, 1]);
  m = M.edit(m, 'insertSilence', { time: 4, length: 2 });
  assert.equal(M.duration(m), 12); assert.equal(m.clips.filter(c => c.sourceId === null).length, 1);
  m = M.edit(m, 'removeRanges', { ranges: [{ start: 4, end: 5.5 }, { start: 5, end: 6 }] });
  assert.equal(M.duration(m), 10); assert.equal(m.clips.some(c => c.sourceId === null), false);
});
test('history restores every edit setting and truncates redo branch', () => {
  const history = new M.History(M.create(source));
  history.commit(M.edit(history.current, 'trim', { start: 1, end: 7 }), '자르기');
  history.commit(M.edit(history.current, 'settings', { speed: 2, effects: { gainDb: -3 } }), '속도');
  assert.equal(M.duration(history.current), 3);
  const undone = history.undo(); assert.equal(undone.speed, 1); assert.equal(undone.effects.gainDb, 0);
  assert.equal(M.duration(history.redo()), 3);
  history.undo(); history.commit(M.edit(history.current, 'settings', { pitch: 4 }));
  assert.equal(history.canRedo, false); assert.equal(history.current.pitch, 4);
  const detached = history.current; detached.pitch = -12; assert.equal(history.current.pitch, 4);
  const entryCount = history.entries.length;
  history.updateSelection(1.125, 4.875);
  assert.deepEqual(history.current.selection, { start: 1.125, end: 4.875 });
  assert.equal(history.entries.length, entryCount);
  assert.throws(() => history.updateSelection(4, 1), /시작/);
});
test('A/B map handles cuts, speed, repetition, pads, silence and overlaps', () => {
  let m = M.edit(M.create(source), 'delete', { start: 2, end: 5 });
  m = M.edit(m, 'settings', { speed: 2, repeat: 2, gap: 1, padStart: 1, padEnd: 1 });
  assert.equal(M.mapTime(m, 0.5), null);
  assert.equal(M.mapTime(m, 2.5).time, 6);
  assert.equal(M.mapTime(m, 4.75), null); // gap
  assert.equal(M.mapTime(m, 5.5).repeatIndex, 1);
  assert.equal(M.reverseMapTime(m, 'one', 6), 2.5);
  assert.equal(M.reverseMapTime(m, 'one', 6, 6.5), 6.5);
  m = M.edit(M.create(source), 'append', { source: second });
  m.crossfade = 2;
  assert.equal(M.mapTime(m, 9), null); assert.equal(M.mapTime(m, 11).sourceId, 'two');
});
test('measured silence uses both channels and retains requested padding', () => {
  const sampleRate = 1000, left = new Float32Array(4000), right = new Float32Array(4000);
  right.fill(0.1, 1000, 1500); left.fill(0.1, 2500, 3000);
  const buffer = { sampleRate, length: 4000, numberOfChannels: 2, getChannelData: i => i ? right : left };
  const ranges = M.detectSilence(buffer, { thresholdDb: -40, minDuration: 0.4, padding: 0.1 });
  assert.deepEqual(ranges.map(r => [r.start, r.end]), [[0, 0.9], [1.6, 2.4], [3.1, 4]]);
  assert.equal(M.detectSilence(buffer, { edgesOnly: true }).length, 2);
  assert.throws(() => M.detectSilence(buffer, { thresholdDb: NaN }), /기준/);
});
test('project round trip reconnects sources by checked identity', () => {
  let model = M.edit(M.create(source), 'trim', { start: 1.25, end: 8 });
  model = M.edit(model, 'append', { source: second });
  model = M.edit(model, 'bookmark', { time: 3, name: '도입' });
  model = M.edit(model, 'settings', { speed: 1.5, pitch: 2, effects: { eqMid: 3 } });
  const output = { format: 'mp3', bitrate: 192, sampleRate: 44100, channels: 1, title: '수업' };
  const json = M.exportProject(model, output, [source, second]);
  const restored = M.importProject(json, [{ ...source, id: 'new-one' }, { ...second, id: 'new-two' }]);
  assert.equal(restored.model.clips[0].sourceId, 'new-one');
  assert.equal(restored.model.clips[1].sourceId, 'new-two');
  assert.deepEqual(restored.output, M.validateOutput(output)); assert.equal(restored.model.bookmarks[0].name, '도입');
  assert.equal(M.duration(restored.model), M.duration(model));
  assert.throws(() => M.importProject(json, [{ ...source, size: source.size + 1 }, second]), /일치/);
  assert.throws(() => M.importProject(json, [{ ...source, metadata: { ...source.metadata, duration: 11 } }, second]), /일치/);
});
test('project import rejects invalid values and never preserves unknown code fields', () => {
  const json = M.exportProject(M.create(source), { format: 'wav', bitDepth: 24 }, [source]);
  const invalid = JSON.parse(json); invalid.model.speed = 0;
  assert.throws(() => M.importProject(JSON.stringify(invalid), [source]), /speed/);
  invalid.model.speed = 1; invalid.schemaVersion = 999;
  assert.throws(() => M.importProject(JSON.stringify(invalid), [source]), /버전/);
  assert.throws(() => M.importProject('{bad', [source]), /JSON/);
  assert.throws(() => M.importProject(' '.repeat(1024 * 1024 + 1), [source]), /1 MB/);
  const hostile = JSON.parse(json); hostile.model.effects.code = 'alert(1)'; hostile.output.onclick = 'alert(2)';
  const safe = M.importProject(JSON.stringify(hostile), [source]);
  assert.equal(safe.model.effects.code, undefined); assert.equal(safe.output.onclick, undefined);
  const prototype = JSON.parse(json.replace('"schemaVersion": 1', '"schemaVersion": 1, "__proto__": {"polluted": true}'));
  M.importProject(JSON.stringify(prototype), [source]); assert.equal({}.polluted, undefined);
});
test('mix duration uses offsets and selected length mode; A/B is unavailable', () => {
  const m = M.create(source);
  m.mix = { sourceId: 'two', start: 0, end: 7, offset: 9, gainDb: -12, loop: false, duck: true, duckThreshold: -35, duckAmount: 12, duckRelease: 0.5, fadeIn: 0, fadeOut: 0, muted: false, solo: false, voiceMuted: false, voiceGainDb: 0, voiceOffset: 2, lengthMode: 'longest' };
  assert.equal(M.duration(M.validateModel(m, [source, second])), 16);
  m.mix.lengthMode = 'voice'; assert.equal(M.duration(m), 12); assert.equal(M.mapTime(m, 3), null);
  const json = M.exportProject(m, { format: 'mp3', bitrate: 128 }, [source, second]);
  assert.equal(M.importProject(json, [source, second]).model.mix.duck, true);
});
test('file names and estimates use decimal bytes and final duration', () => {
  const used = new Set();
  assert.equal(M.safeFilename('수업:/질문.wav', 'mp3', used), '수업__질문.mp3');
  assert.equal(M.safeFilename('수업:/질문.wav', 'mp3', used), '수업__질문_2.mp3');
  assert.equal(M.safeFilename('CON', 'wav'), '_CON.wav');
  const m = M.create(source); m.speed = 2;
  assert.equal(M.estimateBytes(m, { format: 'wav', bitDepth: 24, sampleRate: 48000, channels: 2 }, [source]), 1440044);
  assert.equal(M.estimateBytes(m, { format: 'mp3', bitrate: 192 }, [source]), 121024);
  assert.equal(M.suggestBitrate(m, 0.04).possible, false);
});
test('range endpoints remain usable after removal and fades clamp after edits', () => {
  let m = M.edit(M.create(source), 'split', { time: 7 });
  m.selection = { start: 7, end: 10 }; m.fadeIn = 8; m.fadeOut = 9;
  m = M.edit(m, 'removeClip', { index: 1 });
  assert.deepEqual(m.selection, { start: 0, end: 7 });
  assert.equal(m.fadeIn, 7); assert.equal(m.fadeOut, 7);
  M.validateModel(m, [source]);
  assert.throws(() => M.edit(m, 'selection', { start: 0, end: 7.001 }), /선택 끝/);
  assert.throws(() => M.edit(m, 'settings', { repeat: 21 }), /repeat/);
  const duplicated = M.edit(m, 'duplicate', { start: 0, end: 7, at: 0 });
  assert.equal(M.duration(duplicated), 14);
});
test('exact UI output schema including tag handling survives project import', () => {
  const output = { format: 'mp3', bitrate: 192, sampleRate: 0, channels: 0, bitDepth: 16, vbr: false, quality: 3, compression: 5, oggQuality: 4, metadataMode: 'edit', title: '실험', artist: '송쌤과학', album: '', videoStyle: 'cover', videoSize: '1280x720', videoColor: '#49301f', videoTitle: '', videoSubtitle: '' };
  const json = M.exportProject(M.create(source), output, [source]);
  assert.deepEqual(M.importProject(json, [source]).output, output);
  assert.throws(() => M.validateOutput({ ...output, metadataMode: 'execute' }), /태그 처리/);
  assert.throws(() => M.validateOutput({ ...output, sampleRate: 1 }), /샘플레이트/);
  assert.throws(() => M.validateOutput({ ...output, bitDepth: 12 }), /비트 깊이/);
  assert.throws(() => M.validateOutput({ ...output, format: 'flac', bitDepth: 32 }), /WAV에서만/);
  assert.equal(M.validateOutput({ ...output, format: 'wav', bitDepth: 32 }).bitDepth, 32);
});
test('every engine format validates; video options are checked and old projects get defaults', () => {
  for (const format of M.OUTPUT_FORMATS) assert.equal(M.validateOutput({ format }).format, format);
  assert.throws(() => M.validateOutput({ format: 'mkv' }), /출력 형식/);
  assert.throws(() => M.validateOutput({ format: 'mp4', videoColor: 'red' }), /바탕색/);
  assert.throws(() => M.validateOutput({ format: 'mp4', videoSize: '640x480' }), /영상 크기/);
  assert.throws(() => M.validateOutput({ format: 'mp4', videoStyle: 'spectrum' }), /영상 모양/);
  const video = M.validateOutput({ format: 'webmv', videoStyle: 'waves', videoSize: '1080x1920', videoTitle: '광합성 실험 설명' });
  assert.equal(video.videoSize, '1080x1920'); assert.equal(video.oggQuality, 4);
  // A v1.1 project has no reverse/channelMode; it must still import with safe defaults.
  const json = M.exportProject(M.create(source), { format: 'mp3' }, [source]);
  const old = JSON.parse(json); delete old.model.reverse; delete old.model.effects.channelMode;
  const restored = M.importProject(JSON.stringify(old), [source]);
  assert.equal(restored.model.reverse, false); assert.equal(restored.model.effects.channelMode, 'keep');
  assert.throws(() => M.validateModel({ ...M.create(source), effects: { ...M.effectsDefault(), channelMode: 'center' } }), /채널 처리/);
});
test('reverse and channel mode: no A/B time map, settings round trip, graph filters', () => {
  let m = M.edit(M.create(source), 'settings', { reverse: true, effects: { channelMode: 'left' } });
  assert.equal(m.reverse, true); assert.equal(M.mapTime(m, 3), null); assert.equal(M.reverseMapTime(m, 'one', 3), null);
  assert.equal(M.duration(m), 10);
  const restored = M.importProject(M.exportProject(m, { format: 'opus' }, [source]), [source]);
  assert.equal(restored.model.reverse, true); assert.equal(restored.model.effects.channelMode, 'left');
  const context = vm.createContext({ importScripts() {}, self: { postMessage() {} }, Map, Set, console });
  vm.runInContext(fs.readFileSync(require.resolve('../engine-worker.js'), 'utf8'), context);
  context.testSources = [source]; context.testModel = m;
  vm.runInContext('for (const s of testSources) sources.set(s.id, { path:s.id+".wav", metadata:s.metadata, track:0 });', context);
  const graph = vm.runInContext('buildGraph(testModel,{rate:48000,channels:2}).graph', context);
  assert.ok(graph.includes('pan=stereo|c0=c0|c1=c0'), 'left channel copied to both sides before the downmix');
  assert.ok(/atempo|areverse/.test(graph) && graph.indexOf('areverse') < graph.indexOf('[processed]'), 'areverse is in the main transform');
  const mono = { id: 'mono', metadata: { duration: 10, sampleRate: 48000, channels: 1 } };
  context.testSources = [mono];
  vm.runInContext('for (const s of testSources) sources.set(s.id, { path:s.id+".wav", metadata:s.metadata, track:0 });', context);
  context.testModel = M.edit(M.create(mono), 'settings', { effects: { channelMode: 'right' } });
  assert.ok(!vm.runInContext('buildGraph(testModel,{rate:48000,channels:1}).graph', context).includes('pan='), 'mono sources are left alone');
});
test('estimates cover PCM containers, lossless, Opus and video outputs', () => {
  const m = M.create(source);
  assert.equal(M.estimateBytes(m, { format: 'aiff', bitDepth: 24, sampleRate: 48000, channels: 2 }, [source]), 2880044);
  assert.equal(M.estimateBytes(m, { format: 'wav', bitDepth: 8, sampleRate: 48000, channels: 1 }, [source]), 480044);
  assert.equal(M.estimateBytes(m, { format: 'alac', bitDepth: 16, sampleRate: 48000, channels: 2 }, [source]), 1152000);
  assert.equal(M.estimateBytes(m, { format: 'opus', bitrate: 96 }, [source]), 121024);
  const still = M.estimateBytes(m, { format: 'mp4', bitrate: 160, videoStyle: 'cover', videoSize: '1280x720' }, [source]);
  const waves = M.estimateBytes(m, { format: 'mp4', bitrate: 160, videoStyle: 'waves', videoSize: '1280x720' }, [source]);
  const large = M.estimateBytes(m, { format: 'mp4', bitrate: 160, videoStyle: 'cover', videoSize: '1920x1080' }, [source]);
  assert.ok(still > 200000 && waves > still * 5 && large > still, 'video estimates scale with style and size');
});
test('a project remembers the video audio track and refuses another track', () => {
  const video = { id: 'v', originalName: '실험 영상.mp4', size: 5000, track: 1, metadata: { duration: 4, sampleRate: 44100, channels: 1 } };
  const json = M.exportProject(M.create(video), { format: 'mp3' }, [video]);
  assert.equal(JSON.parse(json).sources[0].track, 1);
  assert.equal(M.importProject(json, [{ ...video, id: 'v2' }]).model.clips[0].sourceId, 'v2');
  assert.throws(() => M.importProject(json, [{ ...video, track: 0 }]), /일치/);
  const old = JSON.parse(json); delete old.sources[0].track;
  assert.equal(M.importProject(JSON.stringify(old), [{ ...video, track: 0 }]).model.clips.length, 1);
});
test('OGG uses a quality step and estimates from it', () => {
  const m = M.create(source);
  assert.equal(M.validateOutput({ format: 'ogg' }).oggQuality, 4);
  assert.throws(() => M.validateOutput({ format: 'ogg', oggQuality: 11 }), /OGG/);
  assert.ok(M.estimateBytes(m, { format: 'ogg', oggQuality: 8 }, [source]) > M.estimateBytes(m, { format: 'ogg', oggQuality: 2 }, [source]));
});
test('a generated silence-only project needs no original media reference', () => {
  let m = M.edit(M.create(source), 'insertSilence', { time: 0, length: 2 });
  m = M.edit(m, 'trim', { start: 0, end: 2 });
  const saved = M.exportProject(m, { format: 'wav' }, [source]);
  const restored = M.importProject(saved, []);
  assert.equal(restored.model.clips[0].sourceId, null);
  assert.equal(M.estimateBytes(restored.model, restored.output), 384044);
});
test('looped mix duration matches graph with source longer than voice and offsets', () => {
  const m = M.create(source);
  m.mix = { sourceId: 'two', start: 0, end: 7, offset: 9, loop: true, voiceOffset: 2, lengthMode: 'longest' };
  assert.equal(M.duration(m), 16);
  m.mix.offset = 3; assert.equal(M.duration(m), 12);
  m.mix.lengthMode = 'voice'; m.mix.offset = 40; assert.equal(M.duration(m), 12);
});
test('duration matches the actual engine graph across combined operations', () => {
  const context = vm.createContext({ importScripts() {}, self: { postMessage() {} }, Map, Set, console });
  vm.runInContext(fs.readFileSync(require.resolve('../engine-worker.js'), 'utf8'), context);
  context.testSources = [source, second];
  vm.runInContext('for (const s of testSources) sources.set(s.id, { path:s.id+".wav", metadata:s.metadata, track:0 });', context);
  for (const speed of [0.5, 1, 1.75, 2]) for (const repeat of [1, 3]) for (const crossed of [0, 0.7]) {
    let m = M.edit(M.create(source), 'append', { source: second });
    m = M.edit(m, 'settings', { speed, repeat, gap: .4, padStart: .25, padEnd: .7, crossfade: crossed });
    for (const loop of [false, true]) for (const lengthMode of ['voice', 'longest']) {
      m.mix = { sourceId: 'two', start: .5, end: 6, offset: 8, gainDb: -12, loop, duck: false, duckThreshold: -30, duckAmount: 12, duckRelease: .4, fadeIn: .5, fadeOut: .5, muted: false, solo: false, voiceMuted: false, voiceGainDb: 0, voiceOffset: 2, lengthMode };
      context.testModel = m;
      const graph = vm.runInContext('buildGraph(testModel,{rate:48000,channels:2})', context);
      assert.ok(Math.abs(graph.duration - M.duration(m)) < 1e-8, `duration mismatch at speed ${speed}, repeat ${repeat}, crossfade ${crossed}, loop ${loop}, mode ${lengthMode}`);
    }
  }
});
test('encoder options: low-rate MP3 keeps working and OGG uses its quality scale', () => {
  const context = vm.createContext({ importScripts() {}, self: { postMessage() {} }, Map, Set, console });
  vm.runInContext(fs.readFileSync(require.resolve('../engine-worker.js'), 'utf8'), context);
  vm.runInContext('caps={formats:Object.fromEntries(Object.keys(FORMATS).map(k=>[k,{supported:k!=="opus"}]))}', context);
  const low = { sampleRate: 22050, channels: 1 };
  context.testOutput = { format: 'mp3', bitrate: 192, sampleRate: 0 }; context.testMeta = low;
  assert.equal(vm.runInContext('formatOptions(testOutput,testMeta).rate', context), 44100);
  context.testOutput = { format: 'mp3', bitrate: 128, sampleRate: 0 };
  assert.equal(vm.runInContext('formatOptions(testOutput,testMeta).rate', context), 22050);
  context.testOutput = { format: 'mp3', bitrate: 192, sampleRate: 22050 };
  assert.throws(() => vm.runInContext('formatOptions(testOutput,testMeta)', context), /160 kbps/);
  context.testOutput = { format: 'ogg', bitrate: 192, oggQuality: 6 };
  assert.equal(vm.runInContext('formatOptions(testOutput,testMeta).args.join(" ")', context), '-c:a libvorbis -ar 22050 -ac 1 -q:a 6');
});
test('encoder options for the added formats follow each codec\'s real limits', () => {
  const context = vm.createContext({ importScripts() {}, self: { postMessage() {} }, Map, Set, console });
  vm.runInContext(fs.readFileSync(require.resolve('../engine-worker.js'), 'utf8'), context);
  vm.runInContext('caps={formats:Object.fromEntries(Object.keys(FORMATS).map(k=>[k,{supported:true}]))}', context);
  const stereo = { sampleRate: 44100, channels: 2 }, mono = { sampleRate: 22050, channels: 1 };
  const opt = (output, meta) => { context.testOutput = output; context.testMeta = meta; return vm.runInContext('formatOptions(testOutput,testMeta)', context); };
  let o = opt({ format: 'opus', bitrate: 96, channels: 2 }, stereo);
  assert.equal(o.rate, 48000); assert.equal(o.channels, 1, 'stereo libopus aborts in this core, so Opus is always mono');
  assert.ok(o.args.join(' ').includes('-ac 1') && o.args.join(' ').includes('-compression_level 10'), 'mono Opus at the default level');
  assert.equal(opt({ format: 'webm', bitrate: 64 }, stereo).channels, 1, 'WebM audio (Opus) is mono too');
  o = opt({ format: 'ac3', bitrate: 200, sampleRate: 22050 }, stereo);
  assert.equal(o.rate, 32000); assert.ok(o.args.join(' ').includes('-b:a 192k'), 'AC3 snaps to its table');
  o = opt({ format: 'mp2', bitrate: 192 }, mono);
  assert.equal(o.rate, 22050); assert.ok(o.args.join(' ').includes('-b:a 160k'), 'MP2 below 32 kHz tops out at 160 kbps');
  assert.equal(opt({ format: 'wma', sampleRate: 96000, bitrate: 128 }, stereo).rate, 48000);
  assert.equal(opt({ format: 'm4a', sampleRate: 50000 }, stereo).rate, 48000);
  o = opt({ format: 'wav', bitDepth: 32 }, stereo); assert.equal(o.encoder, 'pcm_f32le'); assert.equal(o.depth, 32);
  o = opt({ format: 'aiff', bitDepth: 24 }, stereo); assert.equal(o.encoder, 'pcm_s24be'); assert.equal(o.extension, 'aiff');
  o = opt({ format: 'aiff', bitDepth: 32 }, stereo); assert.equal(o.depth, 16, 'unsupported depth falls back to 16');
  o = opt({ format: 'alac', bitDepth: 24 }, stereo); assert.ok(o.args.join(' ').includes('s32p')); assert.equal(o.extension, 'm4a');
  o = opt({ format: 'mp4', bitrate: 160, channels: 6 }, { sampleRate: 48000, channels: 6 }); assert.equal(o.channels, 2); assert.ok(o.args.join(' ').includes('-aac_coder fast'));
  assert.equal(opt({ format: 'ac3', channels: 6 }, { sampleRate: 48000, channels: 6 }).channels, 6);
  assert.equal(opt({ format: 'm4r', bitrate: 128 }, stereo).extension, 'm4r');
  assert.equal(vm.runInContext('videoOptions({videoStyle:"waves",videoSize:"1080x1920"})', context).fps, 6);
  assert.deepEqual(vm.runInContext('(({width,height,fps})=>[width,height,fps])(videoOptions({}))', context), [1280, 720, 1]);
});
test('a real MJPEG/PNG video counts as video, a cover picture does not', () => {
  const context = vm.createContext({ importScripts() {}, self: { postMessage() {} }, Map, Set, console });
  vm.runInContext(fs.readFileSync(require.resolve('../engine-worker.js'), 'utf8'), context);
  const audio = { codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '44100', channels: 2, duration: '5', index: 0 };
  const meta = video => { context.testJson = { streams: [audio, video].filter(Boolean), format: { duration: '5' } }; return vm.runInContext('metadata(testJson,0).video', context); };
  assert.equal(meta({ codec_type: 'video', codec_name: 'mjpeg', width: 640, height: 480, avg_frame_rate: '30/1', nb_frames: '150', disposition: { attached_pic: 0 } }).width, 640, 'MJPEG camera video');
  assert.equal(meta({ codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, avg_frame_rate: '0/0', disposition: { attached_pic: 1 } }), null, 'MP3 cover art');
  assert.equal(meta({ codec_type: 'video', codec_name: 'png', width: 500, height: 500, avg_frame_rate: '0/0', nb_frames: '1', disposition: { attached_pic: 0 } }), null, 'one-frame picture without the flag');
  assert.equal(meta({ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '30000/1001', disposition: { attached_pic: 0 } }).fps, 29.97);
  assert.equal(meta(null), null, 'audio only');
});
test('file names keep dots that are not a media extension', () => {
  assert.equal(M.safeFilename('실험 v1.2 정리', 'mp3'), '실험 v1.2 정리.mp3');
  assert.equal(M.safeFilename('lecture.part1_변환', 'wav'), 'lecture.part1_변환.wav');
  assert.equal(M.safeFilename('수업 녹음.webm', 'mp3'), '수업 녹음.mp3');
  assert.equal(M.safeFilename('1.5배속', 'm4a'), '1.5배속.m4a');
});
test('trailing silence removal snaps to the end and leaves no sliver; old mute/solo flags are ignored', () => {
  const m = M.create(source);
  const cut = M.edit(m, 'removeRanges', { ranges: [{ start: 2, end: 3 }, { start: 9.2, end: 10.0004 }] });
  assert.ok(Math.abs(M.duration(cut) - 8.2) < 1e-9, 'length ' + M.duration(cut));
  assert.ok(cut.clips.every(c => c.end - c.start > 0.001), 'no 0-second clip');
  const near = M.edit(m, 'removeRanges', { ranges: [{ start: 9, end: 9.9995 }] });
  assert.ok(near.clips.every(c => c.end - c.start > 0.001) && Math.abs(M.duration(near) - 9) < 1e-9, 'near-end range snaps');
  const mixed = M.create(source);
  mixed.mix = { sourceId: 'two', start: 0, end: 7, offset: 0, gainDb: -12, loop: true, duck: false, duckThreshold: -30, duckAmount: 12, duckRelease: .4, fadeIn: 0, fadeOut: 0, muted: true, solo: true, voiceMuted: true, voiceGainDb: 0, voiceOffset: 0, lengthMode: 'voice' };
  const v = M.validateModel(mixed, [source, second]);
  assert.deepEqual([v.mix.muted, v.mix.solo, v.mix.voiceMuted], [false, false, false]);
});
test('engine graph: fixed-gain channel conversion, fades before pads, background fade inside the mix', () => {
  const context = vm.createContext({ importScripts() {}, self: { postMessage() {} }, Map, Set, console });
  vm.runInContext(fs.readFileSync(require.resolve('../engine-worker.js'), 'utf8'), context);
  context.testSources = [source, second];
  vm.runInContext('for (const s of testSources) sources.set(s.id, { path:s.id+".wav", metadata:s.metadata, track:0 });', context);
  context.testModel = M.create(source);
  const mono = vm.runInContext('buildGraph(testModel,{rate:48000,channels:1}).graph', context);
  assert.ok(mono.includes('pan=mono|c0=0.5*c0+0.5*c1'), 'stereo to mono averages instead of summing');
  context.testModel = M.create(second);
  assert.ok(vm.runInContext('buildGraph(testModel,{rate:48000,channels:2}).graph', context).includes('pan=stereo|c0=c0|c1=c0'), 'mono to stereo copies at the same level');
  const padded = M.edit(M.create(source), 'settings', { padStart: 2, padEnd: 1, fadeIn: 1, fadeOut: 1 });
  context.testModel = padded;
  const g = vm.runInContext('buildGraph(testModel,{rate:48000,channels:2})', context);
  assert.ok(g.graph.indexOf('afade=t=in') < g.graph.indexOf('adelay='), 'fade-in comes before the leading silence');
  assert.ok(g.graph.includes('afade=t=out:st=9:d=1'), 'fade-out ends where the sound ends, before the trailing silence');
  assert.ok(Math.abs(g.duration - 13) < 1e-9);
  const mixed = M.create(source);
  mixed.mix = { sourceId: 'two', start: 0, end: 7, offset: 6, gainDb: -12, loop: false, duck: false, duckThreshold: -30, duckAmount: 12, duckRelease: .4, fadeIn: 0, fadeOut: 2, muted: false, solo: false, voiceMuted: false, voiceGainDb: 0, voiceOffset: 0, lengthMode: 'voice' };
  context.testModel = mixed;
  const bg = vm.runInContext('buildGraph(testModel,{rate:48000,channels:2}).graph', context);
  assert.ok(bg.includes('afade=t=out:st=2:d=2'), 'music cut at 4 s by the voice fades out over its last 2 s');
});
test('engine graph: pieces seek where the container is exact, read MP3 from the start, reordered pieces get their own input', () => {
  const context = vm.createContext({ importScripts() {}, self: { postMessage() {} }, Map, Set, console });
  vm.runInContext(fs.readFileSync(require.resolve('../engine-worker.js'), 'utf8'), context);
  const long = (id, container, codec) => ({ id, metadata: { duration: 3600, sampleRate: 48000, channels: 1, codec, container } });
  context.testSources = [long('w', 'wav', 'pcm_s16le'), long('p', 'mp3', 'mp3')];
  vm.runInContext('for (const s of testSources) sources.set(s.id, { path:s.id+".media", metadata:s.metadata, track:0 });', context);
  const pieces = (id, ranges) => { const m = M.create(context.testSources.find(s => s.id === id)); m.clips = ranges.map(([start, end]) => ({ ...m.clips[0], start, end })); return m; };
  context.testModel = pieces('w', [[1800, 1900], [1950, 2000], [100, 200]]);
  let built = vm.runInContext('buildGraph(testModel,{rate:48000,channels:1})', context);
  assert.deepEqual(built.args, ['-ss', '1799', '-i', 'w.media', '-ss', '99', '-i', 'w.media'], 'WAV: seek near the first piece, reuse it for the next, new input for the piece that goes back');
  assert.ok(built.graph.includes('[0:a:0]atrim=start=1:end=101') && built.graph.includes('[0:a:0]atrim=start=151:end=201') && built.graph.includes('[1:a:0]atrim=start=1:end=101'), 'trims are relative to each input\'s seek point');
  context.testModel = pieces('w', [[10, 20], [2000, 2010]]);
  built = vm.runInContext('buildGraph(testModel,{rate:48000,channels:1})', context);
  assert.deepEqual(built.args, ['-ss', '9', '-i', 'w.media', '-ss', '1999', '-i', 'w.media'], 'a far jump ahead opens a new input at the piece');
  context.testModel = pieces('p', [[1800, 1900], [100, 200]]);
  built = vm.runInContext('buildGraph(testModel,{rate:48000,channels:1})', context);
  assert.deepEqual(built.args, ['-i', 'p.media', '-i', 'p.media'], 'MP3: no seeking, but the piece that goes back still gets its own input');
  assert.ok(built.graph.includes('[0:a:0]atrim=start=1800:end=1900') && built.graph.includes('[1:a:0]atrim=start=100:end=200'));
});
console.log(`\n${count} model tests passed.`);
