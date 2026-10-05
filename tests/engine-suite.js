/* Engine regression suite (real Worker + WASM). Runs in tests/engine-runner.html:
 * from Playwright (tests/browser-engine.cjs) or by hand in any browser console:  await runEngineSuite(fetchFixture)
 * `file(name)` must return a File for a tests/fixtures name. Nothing leaves the browser. */
window.fetchFixture = async name => new File([await (await fetch('fixtures/' + encodeURIComponent(name), { cache: 'no-store' })).blob()], name);
window.runEngineSuite = async (loadFile, progress = () => {}) => {
  const files = new Map();
  for (const name of ['수업 소리 & 테스트.wav', 'tone.mp3', 'video-with-audio.mp4', 'video-multi-track.mp4', 'video-no-audio.mp4', 'empty.wav', 'corrupt.mp3', 'silence.wav', 'quiet.wav', 'silence-gaps.wav']) files.set(name, await loadFile(name));
  const file = name => files.get(name);
  const results = [];
  const M = window.StudioModel;
  const engine = new window.AudioEngine();
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const close = (a, b, epsilon = .15) => Math.abs(a - b) <= epsilon;
  function stats(wav, channel = 0, from = 0, to = Infinity) {
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const tag = offset => String.fromCharCode(...wav.slice(offset, offset + 4));
    assert(tag(0) === 'RIFF' && tag(8) === 'WAVE', 'RIFF WAVE header');
    let rate, channels, depth, offset = 12, data;
    while (offset + 8 <= view.byteLength) {
      const size = view.getUint32(offset + 4, true), type = tag(offset);
      if (type === 'fmt ') { channels = view.getUint16(offset + 10, true); rate = view.getUint32(offset + 12, true); depth = view.getUint16(offset + 22, true); }
      if (type === 'data') { data = { offset: offset + 8, size }; break; }
      offset += 8 + size + (size % 2);
    }
    assert(data && depth === 16, 'decoded PCM16 data');
    const frames = data.size / channels / 2, start = Math.floor(from * rate), end = Math.min(frames, Math.floor(to * rate));
    let sum = 0, peak = 0, crosses = 0, previous = 0;
    for (let n = start; n < end; n++) {
      const sample = view.getInt16(data.offset + (n * channels + channel) * 2, true) / 32768;
      sum += sample * sample; peak = Math.max(peak, Math.abs(sample));
      if (n > start && previous <= 0 && sample > 0) crosses++;
      previous = sample;
    }
    return { rate, channels, depth, duration: frames / rate, rms: Math.sqrt(sum / Math.max(1, end - start)), peak, frequency: crosses * rate / Math.max(1, end - start) };
  }
  // Decoded sound comes back as PcmTrack parts (16-bit, at pcmRate); wrap them as WAV for stats().
  const wavOf = async t => { assert(t, 'decoded sound'); const data = new Uint8Array(await new Blob(t.parts).arrayBuffer()), out = new Uint8Array(44 + data.length), v = new DataView(out.buffer), w = (o, s) => [...s].forEach((c, i) => out[o + i] = c.charCodeAt(0));
    w(0, 'RIFF'); v.setUint32(4, 36 + data.length, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, t.numberOfChannels, true); v.setUint32(24, t.sampleRate, true); v.setUint32(28, t.sampleRate * t.numberOfChannels * 2, true); v.setUint16(32, t.numberOfChannels * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, data.length, true); out.set(data, 44); return out; };
  const LISTEN = { listen: true, pcmRate: 48000 };
  // The listening copy is resampled to pcmRate, so the file's own rate/channels come from its probed metadata.
  const inspect = async rendered => ({ ...stats(await wavOf(rendered.pcm)), rate: rendered.metadata.sampleRate, channels: rendered.metadata.channels });
  async function test(name, fn) {
    const start = performance.now();
    try { const detail = await fn(); results.push({ name, pass: true, ms: Math.round(performance.now() - start), detail }); await progress('PASS ' + name); }
    catch (error) { results.push({ name, pass: false, ms: Math.round(performance.now() - start), error: error.message }); await progress('FAIL ' + name + ': ' + error.message); }
  }
  let original, model;
  await test('실제 WASM 기능 목록 · 18가지 형식', async () => {
    const caps = await engine.capabilities();
    for (const format of M.OUTPUT_FORMATS) assert(caps.formats[format].supported, format + ' encoder');
    assert(caps.formats.opus.note, 'Opus stereo note'); return caps;
  });
  await test('한글 파일 분석·실제 stereo 파형', async () => {
    original = await engine.analyze(file('수업 소리 & 테스트.wav'), 0, { pcmRate: 48000 }); model = M.create(original);
    const wav = await wavOf(original.pcm), left = stats(wav, 0), right = stats(wav, 1);
    assert(original.originalName === '수업 소리 & 테스트.wav', 'name preserved');
    assert(left.channels === 2 && left.rate === 48000 && close(left.duration, 4, .001), 'input metadata');
    assert(close(left.frequency, 440, 2) && close(right.frequency, 660, 2), 'real channel frequency');
    return { metadata: original.metadata, left, right };
  });
  if (!model) { engine.dispose(); return { results }; }
  for (const format of M.OUTPUT_FORMATS.filter(f => !M.VIDEO_FORMATS.includes(f))) {
    await test(format + ' 실제 인코딩·재디코딩', async () => {
      const rendered = await engine.render(model, { format, sampleRate: 44100, channels: 1, bitrate: 128, bitDepth: 24, metadataMode: 'remove' }, LISTEN);
      const actual = await inspect(rendered);
      assert(rendered.size > 64 && rendered.blob.size === rendered.size && actual.rms > .01, 'nonempty audio');
      const expectedRate = ['opus', 'webm'].includes(format) ? 48000 : ['ac3'].includes(format) ? 44100 : 44100;
      assert(actual.rate === expectedRate && actual.channels === 1 && close(actual.duration, 4), 'output options');
      if (format === 'wav') assert(rendered.metadata.codec === 'pcm_s24le', 'WAV PCM24 encoder');
      if (format === 'aiff') assert(rendered.metadata.codec === 'pcm_s24be', 'AIFF PCM24 big-endian');
      return { bytes: rendered.size, mime: rendered.mime, extension: rendered.extension, metadata: rendered.metadata, actual };
    });
  }
  await test('Opus는 모노로 저장·WAV 32비트 float·8비트', async () => {
    const opus = await engine.render(model, { format: 'opus', bitrate: 96, channels: 2 }, LISTEN);
    const actual = await inspect(opus); assert(actual.channels === 1 && actual.rms > .01 && close(actual.duration, 4), 'Opus is saved mono');
    const f32 = await engine.render(model, { format: 'wav', bitDepth: 32 }); assert(f32.metadata.codec === 'pcm_f32le', 'float WAV');
    const u8 = await engine.render(model, { format: 'wav', bitDepth: 8 }); assert(u8.metadata.codec === 'pcm_u8', '8-bit WAV');
    return { opus: opus.metadata, f32: f32.metadata, u8: u8.metadata };
  });
  await test('음원 → MP4·WebM 영상 (정지 화면·파형)', async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#49301f'; ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = '#fff'; ctx.font = '700 64px sans-serif'; ctx.fillText('검증 영상', 90, 300);
    const cover = new Uint8Array(await (await new Promise(r => canvas.toBlob(r, 'image/png'))).arrayBuffer());
    const out = [];
    for (const [format, videoStyle] of [['mp4', 'cover'], ['mp4', 'waves'], ['webmv', 'cover']]) {
      const rendered = await engine.render(model, { format, bitrate: 160, videoStyle, videoSize: '1280x720', videoColor: '#49301f' }, { cover, waveColor: '#ffffff', ...LISTEN });
      assert(rendered.metadata.video && rendered.metadata.video.width === 1280 && rendered.metadata.video.height === 720, format + ' picture stream');
      assert(close(rendered.metadata.duration, 4, .3), format + ' duration');
      const actual = await inspect(rendered); assert(actual.rms > .05, format + ' sound kept');
      out.push({ format, videoStyle, bytes: rendered.size, metadata: rendered.metadata });
    }
    return out;
  });
  await test('거꾸로 재생·왼쪽 채널만', async () => {
    const reversed = await engine.render(M.edit(model, 'settings', { reverse: true }), { format: 'wav' }, LISTEN);
    const wav = await wavOf(reversed.pcm); assert(close(stats(wav).duration, 4, .001), 'reverse keeps length');
    const left = await engine.render(M.edit(model, 'settings', { effects: { channelMode: 'left' } }), { format: 'wav', channels: 2 }, LISTEN);
    const leftWav = await wavOf(left.pcm);
    assert(close(stats(leftWav, 0).frequency, 440, 2) && close(stats(leftWav, 1).frequency, 440, 2), 'both sides carry the left 440 Hz');
    return { reversed: reversed.metadata, left: left.metadata };
  });
  await test('MP3 입력 → WAV', async () => {
    const mp3 = await engine.analyze(file('tone.mp3'));
    const rendered = await engine.render(M.create(mp3), { format: 'wav', sampleRate: 48000, channels: 2 }, LISTEN);
    const actual = await inspect(rendered); assert(actual.rms > .1 && close(actual.duration, 4), 'MP3 decoded content'); return actual;
  });
  await test('MP4에서 MP3·WAV 추출', async () => {
    const video = await engine.analyze(file('video-with-audio.mp4')); const output = [];
    for (const format of ['mp3', 'wav']) {
      const rendered = await engine.render(M.create(video), { format }, LISTEN); const actual = await inspect(rendered);
      assert(actual.rms > .1 && close(actual.duration, 4), format + ' extracted content'); output.push({ format, metadata: rendered.metadata, actual });
    }
    const copied = await engine.extractCopy(video.id, { format: 'm4a', start: .5, end: 2.5 });
    assert(copied.metadata.codec === 'aac' && close(copied.metadata.duration, 2), 'AAC stream copy');
    output.push({ format: 'AAC copy', metadata: copied.metadata }); return output;
  });
  await test('다중 트랙 번호·언어·다른 실제 소리', async () => {
    const video = await engine.analyze(file('video-multi-track.mp4'), 1, { pcmRate: 48000 }); const actual = stats(await wavOf(video.pcm));
    assert(video.metadata.tracks.length === 2 && video.metadata.track === 1, 'track list and chosen index');
    assert(video.metadata.tracks[0].language === 'kor' && video.metadata.tracks[1].language === 'eng', 'track language');
    assert(close(actual.frequency, 880, 3) && actual.channels === 1, 'chosen track is 880Hz mono'); return { metadata: video.metadata, actual };
  });
  await test('무음 영상·빈 파일·손상 파일 오류 후 복구', async () => {
    const errors = [];
    for (const name of ['video-no-audio.mp4', 'empty.wav', 'corrupt.mp3']) {
      try { await engine.analyze(file(name)); throw new Error('accepted ' + name); }
      catch (error) { assert(!error.message.startsWith('accepted'), error.message); errors.push({ fixture: name, code: error.code, message: error.message }); }
    }
    assert(errors[0].code === 'NO_AUDIO', 'no audio classification');
    const rendered = await engine.render(model, { format: 'wav' }); assert(rendered.size > 64, 'recovery'); return errors;
  });
  await test('잘라내기·삭제·선택 무음 실제 출력', async () => {
    const trimmed = await engine.render(M.edit(model, 'trim', { start: .5, end: 2.5 }), { format: 'wav' });
    assert(close(trimmed.metadata.duration, 2, .001), 'trim length');
    const deleted = await engine.render(M.edit(model, 'delete', { start: 1, end: 2 }), { format: 'wav' });
    assert(close(deleted.metadata.duration, 3, .001), 'delete length');
    const silent = await engine.render(M.edit(model, 'silence', { start: 1, end: 2 }), { format: 'wav' }, LISTEN);
    const wav = await wavOf(silent.pcm);
    const inside = stats(wav, 0, 1.05, 1.95), outside = stats(wav, 0, .1, .9);
    assert(inside.rms < .0001 && outside.rms > .1, 'muted region only'); return { trimmed: trimmed.metadata.duration, deleted: deleted.metadata.duration, inside, outside };
  });
  await test('페이드·크로스페이드·반복·여백', async () => {
    let edited = M.edit(model, 'trim', { start: 0, end: 1 });
    edited = M.edit(edited, 'append', { source: original });
    edited = M.edit(edited, 'settings', { crossfade: .2, repeat: 2, gap: .3, padStart: .2, padEnd: .4, fadeIn: .5, fadeOut: .5 });
    const rendered = await engine.render(edited, { format: 'wav' }, LISTEN), actual = await inspect(rendered);
    assert(close(actual.duration, M.duration(edited), .02), 'crossfade/repeat/pad duration'); return { planned: M.duration(edited), actual };
  });
  await test('속도와 음높이 독립 변환', async () => {
    const fast = await engine.render(M.edit(model, 'settings', { speed: 2 }), { format: 'wav' }, LISTEN);
    const fastStats = stats(await wavOf(fast.pcm), 0, .2, 1.5);
    const high = await engine.render(M.edit(model, 'settings', { pitch: 12 }), { format: 'wav' }, LISTEN);
    const highStats = stats(await wavOf(high.pcm), 0, .2, 3.5);
    assert(close(fast.metadata.duration, 2) && close(fastStats.frequency, 440, 3), '2x duration and same pitch');
    assert(close(high.metadata.duration, 4) && close(highStats.frequency, 880, 4), '+12 semitone and same length');
    return { fast: { duration: fast.metadata.duration, ...fastStats }, high: { duration: high.metadata.duration, ...highStats } };
  });
  await test('무음·매우 작은 소리 음량 균일화 폭주 방지', async () => {
    const output = [];
    for (const name of ['silence.wav', 'quiet.wav']) {
      const source = await engine.analyze(file(name)), edited = M.edit(M.create(source), 'settings', { effects: { normalize: true } });
      const rendered = await engine.render(edited, { format: 'wav' }, LISTEN); const actual = await inspect(rendered);
      assert(Number.isFinite(actual.rms) && actual.peak < .01, 'no excessive amplification'); output.push({ name, actual, notes: rendered.summary.notes });
    }
    return output;
  });
  await test('실제 Worker 취소·원본 재연결 후 재변환', async () => {
    const edited = M.edit(model, 'settings', { repeat: 20 });
    let cancelled = false;
    engine.onStatus = status => { if (!cancelled && status.phase === 'processing') { cancelled = true; engine.cancel(); } };
    try { await engine.render(edited, { format: 'mp3' }); throw new Error('cancelled request resolved'); }
    catch (error) { assert(error.code === 'CANCELLED', 'true cancellation rejection'); }
    engine.onStatus = () => {};
    const rendered = await engine.render(model, { format: 'mp3' }, LISTEN); const actual = await inspect(rendered);
    assert(actual.rms > .1 && close(actual.duration, 4), 'source rehydrated after worker termination'); return actual;
  });
  await test('편집본 B·무음 찾기용 소리', async () => {
    const preview = await engine.render(M.edit(model, 'trim', { start: .5, end: 2.5 }), { format: 'mp3' }, { preview: true, pcmRate: 48000 });
    assert(!preview.blob && preview.pcm && close(preview.pcm.duration, 2, .001) && preview.pcm.sampleRate === 48000, 'preview is sound only');
    const gaps = await engine.analyze(file('silence-gaps.wav'));
    const analysis = await engine.render(M.create(gaps), { format: 'wav', sampleRate: 24000, channels: 0 }, { analysis: true });
    assert(!analysis.pcm && analysis.envelope.values.length > 100 && close(analysis.envelope.window, .01, 1e-9), '10 ms loudness envelope');
    return { preview: preview.metadata, ranges: M.silenceFromEnvelope(analysis.envelope, { thresholdDb: -45, minDuration: .5 }) };
  });
  await test('긴 원본 중간 구간·순서 바꾼 구간이 샘플 단위로 정확', async () => {
    // 150 s, 48 kHz mono WAV whose tone changes every second: a cut that lands one sample off shows up at once.
    const rate = 48000, seconds = 150, pcm = new Int16Array(rate * seconds);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(12000 * Math.sin(2 * Math.PI * (200 + 7 * Math.floor(i / rate)) * i / rate));
    const bytes = new Uint8Array(44 + pcm.byteLength), v = new DataView(bytes.buffer), w = (o, t) => [...t].forEach((c, i) => bytes[o + i] = c.charCodeAt(0));
    w(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, pcm.byteLength, true); bytes.set(new Uint8Array(pcm.buffer), 44);
    const long = await engine.analyze(new File([bytes], 'long.wav'), 0, { pcmRate: rate });
    const base = M.create(long), plain = { ...M.effectsDefault(), limiter: false };
    const pieces = [[100.25, 101.25], [10.5, 11], [100.25, 100.75]]; // middle, then back (reordered), then a duplicate
    const edited = { ...base, effects: plain, clips: pieces.map(([start, end]) => ({ ...base.clips[0], start, end })) };
    const out = await engine.render(edited, { format: 'wav', bitDepth: 16 }, LISTEN);
    const got = new Int16Array(await new Blob(out.pcm.parts).arrayBuffer());
    let at = 0, worst = 0;
    for (const [start, end] of pieces) { const from = Math.round(start * rate), n = Math.round((end - start) * rate); for (let k = 0; k < n; k++) worst = Math.max(worst, Math.abs(got[at + k] - pcm[from + k])); at += n; }
    assert(got.length === at && worst <= 1, `pieces differ from the original by up to ${worst} (length ${got.length}/${at})`);
    await engine.removeSource(long.id);
    return { samples: got.length, worstDifference: worst };
  });
  await test('작업 파일 정리(OPFS)', async () => {
    const caps = await engine.capabilities(); if (!caps.limits.disk) return { disk: false };
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('audio-studio-scratch');
    // A cancelled job's files are removed once the terminated engine's locks are released (a few seconds).
    let left = [];
    for (let i = 0; i < 20; i++) { left = []; for await (const name of dir.keys()) left.push(name); if (!left.length) break; await new Promise(r => setTimeout(r, 500)); }
    assert(!left.length, 'scratch files left: ' + left.join(', ')); return { disk: true, left };
  });
  const storage = { localStorage: Object.keys(localStorage), indexedDB: await indexedDB.databases(), caches: await caches.keys() };
  if (storage.localStorage.length || storage.indexedDB.length || storage.caches.length) results.push({ name: '자동 저장 없음', pass: false, error: 'no automatic persistent storage' });
  engine.dispose();
  return { results, storage };
};
