/* Real Chromium Worker/WASM regression. Set NODE_PATH to installed Playwright. */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const base = process.argv[2] || 'http://127.0.0.1:8765';
  const out = path.join(__dirname, 'artifacts');
  fs.mkdirSync(out, { recursive: true });
  const files = Object.fromEntries(fs.readdirSync(path.join(__dirname, 'fixtures')).filter(name => name !== 'manifest.json')
    .map(name => [name, fs.readFileSync(path.join(__dirname, 'fixtures', name)).toString('base64')]));
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [], failures = [], consoleErrors = [];
  page.on('request', req => requests.push({ url: req.url(), method: req.method(), hasBody: !!req.postData() }));
  page.on('requestfailed', req => failures.push({ url: req.url(), error: req.failure()?.errorText }));
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.exposeFunction('qaProgress', message => console.log(message));
  await page.goto(base + '/tests/engine-runner.html', { waitUntil: 'networkidle' });
  const result = await page.evaluate(async files => {
    const results = [];
    const M = window.StudioModel;
    const engine = new window.AudioEngine();
    const file = name => new File([Uint8Array.from(atob(files[name]), c => c.charCodeAt(0))], name);
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
    const inspect = async rendered => stats((await engine.decodeResult(rendered.bytes, rendered.extension)).wav);
    async function test(name, fn) {
      const start = performance.now();
      try { const detail = await fn(); results.push({ name, pass: true, ms: Math.round(performance.now() - start), detail }); await window.qaProgress('PASS ' + name); }
      catch (error) { results.push({ name, pass: false, ms: Math.round(performance.now() - start), error: error.message }); await window.qaProgress('FAIL ' + name + ': ' + error.message); }
    }
    let original, model;
    await test('실제 WASM 기능 목록 · 18가지 형식', async () => {
      const caps = await engine.capabilities();
      for (const format of M.OUTPUT_FORMATS) assert(caps.formats[format].supported, format + ' encoder');
      assert(caps.formats.opus.note, 'Opus stereo note'); return caps;
    });
    await test('한글 파일 분석·실제 stereo 파형', async () => {
      original = await engine.analyze(file('수업 소리 & 테스트.wav')); model = M.create(original);
      const left = stats(original.wav, 0), right = stats(original.wav, 1);
      assert(original.originalName === '수업 소리 & 테스트.wav', 'name preserved');
      assert(left.channels === 2 && left.rate === 48000 && close(left.duration, 4, .001), 'input metadata');
      assert(close(left.frequency, 440, 2) && close(right.frequency, 660, 2), 'real channel frequency');
      return { metadata: original.metadata, left, right };
    });
    if (!model) { engine.dispose(); return { results }; }
    for (const format of M.OUTPUT_FORMATS.filter(f => !M.VIDEO_FORMATS.includes(f))) {
      await test(format + ' 실제 인코딩·재디코딩', async () => {
        const rendered = await engine.render(model, { format, sampleRate: 44100, channels: 1, bitrate: 128, bitDepth: 24, metadataMode: 'remove' });
        const actual = await inspect(rendered);
        assert(rendered.bytes.length > 64 && actual.rms > .01, 'nonempty audio');
        const expectedRate = ['opus', 'webm'].includes(format) ? 48000 : ['ac3'].includes(format) ? 44100 : 44100;
        assert(actual.rate === expectedRate && actual.channels === 1 && close(actual.duration, 4), 'output options');
        if (format === 'wav') assert(rendered.metadata.codec === 'pcm_s24le', 'WAV PCM24 encoder');
        if (format === 'aiff') assert(rendered.metadata.codec === 'pcm_s24be', 'AIFF PCM24 big-endian');
        return { bytes: rendered.bytes.length, mime: rendered.mime, extension: rendered.extension, metadata: rendered.metadata, actual };
      });
    }
    await test('Opus는 모노로 저장·WAV 32비트 float·8비트', async () => {
      const opus = await engine.render(model, { format: 'opus', bitrate: 96, channels: 2 });
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
        const rendered = await engine.render(model, { format, bitrate: 160, videoStyle, videoSize: '1280x720', videoColor: '#49301f' }, { cover, waveColor: '#ffffff' });
        assert(rendered.metadata.video && rendered.metadata.video.width === 1280 && rendered.metadata.video.height === 720, format + ' picture stream');
        assert(close(rendered.metadata.duration, 4, .3), format + ' duration');
        const actual = await inspect(rendered); assert(actual.rms > .05, format + ' sound kept');
        out.push({ format, videoStyle, bytes: rendered.bytes.length, metadata: rendered.metadata });
      }
      return out;
    });
    await test('거꾸로 재생·왼쪽 채널만', async () => {
      const reversed = await engine.render(M.edit(model, 'settings', { reverse: true }), { format: 'wav' });
      const wav = (await engine.decodeResult(reversed.bytes)).wav; assert(close(stats(wav).duration, 4, .001), 'reverse keeps length');
      const left = await engine.render(M.edit(model, 'settings', { effects: { channelMode: 'left' } }), { format: 'wav', channels: 2 });
      const leftWav = (await engine.decodeResult(left.bytes)).wav;
      assert(close(stats(leftWav, 0).frequency, 440, 2) && close(stats(leftWav, 1).frequency, 440, 2), 'both sides carry the left 440 Hz');
      return { reversed: reversed.metadata, left: left.metadata };
    });
    await test('MP3 입력 → WAV', async () => {
      const mp3 = await engine.analyze(file('tone.mp3'));
      const rendered = await engine.render(M.create(mp3), { format: 'wav', sampleRate: 48000, channels: 2 });
      const actual = await inspect(rendered); assert(actual.rms > .1 && close(actual.duration, 4), 'MP3 decoded content'); return actual;
    });
    await test('MP4에서 MP3·WAV 추출', async () => {
      const video = await engine.analyze(file('video-with-audio.mp4')); const output = [];
      for (const format of ['mp3', 'wav']) {
        const rendered = await engine.render(M.create(video), { format }); const actual = await inspect(rendered);
        assert(actual.rms > .1 && close(actual.duration, 4), format + ' extracted content'); output.push({ format, metadata: rendered.metadata, actual });
      }
      const copied = await engine.extractCopy(video.id, { format: 'm4a', start: .5, end: 2.5 });
      assert(copied.metadata.codec === 'aac' && close(copied.metadata.duration, 2), 'AAC stream copy');
      output.push({ format: 'AAC copy', metadata: copied.metadata }); return output;
    });
    await test('다중 트랙 번호·언어·다른 실제 소리', async () => {
      const video = await engine.analyze(file('video-multi-track.mp4'), 1); const actual = stats(video.wav);
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
      const rendered = await engine.render(model, { format: 'wav' }); assert(rendered.bytes.length > 64, 'recovery'); return errors;
    });
    await test('잘라내기·삭제·선택 무음 실제 출력', async () => {
      const trimmed = await engine.render(M.edit(model, 'trim', { start: .5, end: 2.5 }), { format: 'wav' });
      assert(close(trimmed.metadata.duration, 2, .001), 'trim length');
      const deleted = await engine.render(M.edit(model, 'delete', { start: 1, end: 2 }), { format: 'wav' });
      assert(close(deleted.metadata.duration, 3, .001), 'delete length');
      const silent = await engine.render(M.edit(model, 'silence', { start: 1, end: 2 }), { format: 'wav' });
      const wav = (await engine.decodeResult(silent.bytes)).wav;
      const inside = stats(wav, 0, 1.05, 1.95), outside = stats(wav, 0, .1, .9);
      assert(inside.rms < .0001 && outside.rms > .1, 'muted region only'); return { trimmed: trimmed.metadata.duration, deleted: deleted.metadata.duration, inside, outside };
    });
    await test('페이드·크로스페이드·반복·여백', async () => {
      let edited = M.edit(model, 'trim', { start: 0, end: 1 });
      edited = M.edit(edited, 'append', { source: original });
      edited = M.edit(edited, 'settings', { crossfade: .2, repeat: 2, gap: .3, padStart: .2, padEnd: .4, fadeIn: .5, fadeOut: .5 });
      const rendered = await engine.render(edited, { format: 'wav' }), actual = await inspect(rendered);
      assert(close(actual.duration, M.duration(edited), .02), 'crossfade/repeat/pad duration'); return { planned: M.duration(edited), actual };
    });
    await test('속도와 음높이 독립 변환', async () => {
      const fast = await engine.render(M.edit(model, 'settings', { speed: 2 }), { format: 'wav' });
      const fastWav = (await engine.decodeResult(fast.bytes)).wav, fastStats = stats(fastWav, 0, .2, 1.5);
      const high = await engine.render(M.edit(model, 'settings', { pitch: 12 }), { format: 'wav' });
      const highWav = (await engine.decodeResult(high.bytes)).wav, highStats = stats(highWav, 0, .2, 3.5);
      assert(close(fast.metadata.duration, 2) && close(fastStats.frequency, 440, 3), '2x duration and same pitch');
      assert(close(high.metadata.duration, 4) && close(highStats.frequency, 880, 4), '+12 semitone and same length');
      return { fast: { duration: fast.metadata.duration, ...fastStats }, high: { duration: high.metadata.duration, ...highStats } };
    });
    await test('무음·매우 작은 소리 음량 균일화 폭주 방지', async () => {
      const output = [];
      for (const name of ['silence.wav', 'quiet.wav']) {
        const source = await engine.analyze(file(name)), edited = M.edit(M.create(source), 'settings', { effects: { normalize: true } });
        const rendered = await engine.render(edited, { format: 'wav' }); const actual = await inspect(rendered);
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
      const rendered = await engine.render(model, { format: 'mp3' }); const actual = await inspect(rendered);
      assert(actual.rms > .1 && close(actual.duration, 4), 'source rehydrated after worker termination'); return actual;
    });
    const storage = { localStorage: Object.keys(localStorage), indexedDB: await indexedDB.databases(), caches: await caches.keys() };
    assert(storage.localStorage.length === 0 && storage.indexedDB.length === 0 && storage.caches.length === 0, 'no automatic persistent storage');
    engine.dispose();
    return { results, storage };
  }, files);
  const origin = new URL(base).origin;
  const unexpectedNetwork = requests.filter(r => new URL(r.url).origin !== origin || r.method !== 'GET' || r.hasBody);
  const report = { browser: await browser.version(), base, ...result, requests, unexpectedNetwork, failures, consoleErrors };
  fs.writeFileSync(path.join(out, 'browser-engine.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: result.results.filter(r => r.pass).length, failed: result.results.filter(r => !r.pass), unexpectedNetwork, failures, consoleErrors, storage: result.storage }, null, 2));
  await browser.close();
  if (result.results.some(r => !r.pass) || unexpectedNetwork.length || failures.length || consoleErrors.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
