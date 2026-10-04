/* Worker for tests/engine-caps.html: loads the pinned core, lists its abilities and tries each candidate output. */
'use strict';
importScripts('../vendor/ffmpeg-core.js');
let core, logs = [];
function run(args) { logs = []; core.reset(); const code = core.exec('-hide_banner', '-loglevel', 'info', '-nostdin', ...args); core.reset(); return { code, text: logs.join('\n') }; }
function wav(seconds, rate, channels) {
  const frames = Math.round(seconds * rate), data = new Int16Array(frames * channels);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) data[i * channels + c] = Math.round(Math.sin(2 * Math.PI * (c ? 660 : 440) * i / rate) * 0.4 * 32767);
  const bytes = new Uint8Array(44 + data.byteLength), v = new DataView(bytes.buffer);
  const tag = (at, s) => [...s].forEach((ch, i) => bytes[at + i] = ch.charCodeAt(0));
  tag(0, 'RIFF'); v.setUint32(4, 36 + data.byteLength, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, data.byteLength, true);
  bytes.set(new Uint8Array(data.buffer), 44); return bytes;
}
// Extra test signals for Opus robustness: noise, chirp, speech-like bursts, 5.1, silence, long.
function signal(kind, seconds, rate, channels) {
  const frames = Math.round(seconds * rate), data = new Int16Array(frames * channels);
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    for (let c = 0; c < channels; c++) {
      let v = 0;
      if (kind === 'noise') v = rnd() * 0.5;
      else if (kind === 'chirp') v = Math.sin(2 * Math.PI * (100 * t + (8000 - 100) * t * t / (2 * seconds)) * (c ? 1.01 : 1)) * 0.5;
      else if (kind === 'speech') { const env = Math.max(0, Math.sin(2 * Math.PI * 3.3 * t)) ** 2 * (Math.sin(2 * Math.PI * 0.4 * t) > -0.3 ? 1 : 0); v = (rnd() * 0.3 + Math.sin(2 * Math.PI * (180 + 40 * Math.sin(2 * Math.PI * 5 * t)) * t) * 0.4) * env; }
      else if (kind === 'mix') v = Math.sin(2 * Math.PI * (c ? 330 : 220) * t) * 0.3 + rnd() * 0.15 + (Math.floor(t * 2) % 2 ? Math.sin(2 * Math.PI * 1760 * t) * 0.2 : 0);
      else if (kind === 'clipped') v = Math.max(-1, Math.min(1, Math.sin(2 * Math.PI * 440 * t) * 3));
      data[i * channels + c] = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
    }
  }
  const bytes = new Uint8Array(44 + data.byteLength), view = new DataView(bytes.buffer);
  const tag = (at, s) => [...s].forEach((ch, i) => bytes[at + i] = ch.charCodeAt(0));
  tag(0, 'RIFF'); view.setUint32(4, 36 + data.byteLength, true); tag(8, 'WAVE'); tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, rate, true); view.setUint32(28, rate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, data.byteLength, true);
  bytes.set(new Uint8Array(data.buffer), 44); return bytes;
}
function png(w, h) {
  // Minimal RGB PNG via stored (uncompressed) deflate blocks.
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 240; raw[o + 1] = 120 + (x % 60); raw[o + 2] = 40 + (y % 40); } }
  const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const adler = b => { let a = 1, s = 0; for (const x of b) { a = (a + x) % 65521; s = (s + a) % 65521; } return (s << 16 | a) >>> 0; };
  const blocks = [];
  for (let at = 0; at < raw.length; at += 65535) { const len = Math.min(65535, raw.length - at); blocks.push(new Uint8Array([at + len >= raw.length ? 1 : 0, len & 255, len >> 8, ~len & 255, (~len >> 8) & 255]), raw.subarray(at, at + len)); }
  const z = new Uint8Array(2 + blocks.reduce((n, b) => n + b.length, 0) + 4); z[0] = 0x78; z[1] = 1; let p = 2; for (const b of blocks) { z.set(b, p); p += b.length; } new DataView(z.buffer).setUint32(p, adler(raw));
  const chunk = (type, data) => { const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer); dv.setUint32(0, data.length); [...type].forEach((ch, i) => out[4 + i] = ch.charCodeAt(0)); out.set(data, 8); dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length))); return out; };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0)); let q = 0; for (const b of parts) { out.set(b, q); q += b.length; } return out;
}
let seconds = 8, opusSet = false;
function writeOpusInputs() {
  core.FS.writeFile('noise48.wav', signal('noise', 30, 48000, 2));
  core.FS.writeFile('noise48m.wav', signal('noise', 30, 48000, 1));
  core.FS.writeFile('chirp44.wav', signal('chirp', 30, 44100, 2));
  core.FS.writeFile('speech22m.wav', signal('speech', 30, 22050, 1));
  core.FS.writeFile('speech16m.wav', signal('speech', 30, 16000, 1));
  core.FS.writeFile('speech48.wav', signal('speech', 30, 48000, 2));
  core.FS.writeFile('mix51.wav', signal('mix', 20, 48000, 6));
  core.FS.writeFile('mix48.wav', signal('mix', 30, 48000, 2));
  core.FS.writeFile('silence48.wav', signal('silence', 10, 48000, 2));
  core.FS.writeFile('clip44.wav', signal('clipped', 10, 44100, 2));
  core.FS.writeFile('mix96.wav', signal('mix', 10, 96000, 2));
  core.FS.writeFile('long300.wav', signal('mix', 300, 48000, 2));
}
async function boot() {
  core = await createFFmpegCore({ mainScriptUrlOrBlob: new URL('../vendor/ffmpeg-core.js', self.location.href).href + '#' + btoa(JSON.stringify({ wasmURL: new URL('../vendor/ffmpeg-core.wasm', self.location.href).href })) });
  core.setLogger(({ message }) => { logs.push(message); if (logs.length > 20000) logs.shift(); });
  core.FS.writeFile('tone.wav', wav(seconds, 48000, 2));
  core.FS.writeFile('tone22.wav', wav(seconds, 22050, 1));
  core.FS.writeFile('cover.png', png(640, 360));
  core.FS.writeFile('cover720.png', png(1280, 720));
  core.FS.writeFile('cover1080.png', png(1920, 1080));
}
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    seconds = data.seconds || 8;
    await boot();
    if (data.opusSet) { opusSet = true; writeOpusInputs(); }
    if (false) {
      core.FS.writeFile('noise48.wav', signal('noise', 30, 48000, 2));
      core.FS.writeFile('chirp44.wav', signal('chirp', 30, 44100, 2));
      core.FS.writeFile('speech22m.wav', signal('speech', 30, 22050, 1));
      core.FS.writeFile('speech16m.wav', signal('speech', 30, 16000, 1));
      core.FS.writeFile('mix51.wav', signal('mix', 20, 48000, 6));
      core.FS.writeFile('silence48.wav', signal('silence', 10, 48000, 2));
      core.FS.writeFile('clip44.wav', signal('clipped', 10, 44100, 2));
      core.FS.writeFile('mix96.wav', signal('mix', 10, 96000, 2));
      core.FS.writeFile('long300.wav', signal('mix', 300, 48000, 2));
    }
    const lists = {};
    for (const key of ['version', 'encoders', 'muxers', 'filters', 'decoders', 'demuxers']) lists[key] = run(key === 'version' ? ['-version'] : ['-' + key]).text;
    self.postMessage({ type: 'lists', lists });
  } else if (data.type === 'trial') {
    const t0 = performance.now(); let ok = false, text = '', size = 0, probe = '', rebooted = false;
    try {
      try { core.FS.unlink(data.out); } catch (_) {}
      let r = run(data.args); text = r.text;
      if (r.code === 0 && data.then) { r = run(data.then); text += '\n---- then ----\n' + r.text; }
      if (r.code === 0) {
        const bytes = core.FS.readFile(data.out); size = bytes.length; ok = size > 100;
        logs = []; core.reset();
        core.ffprobe('-v', 'error', '-show_entries', 'stream=codec_name,codec_type,sample_rate,channels,width,height,r_frame_rate,duration:format=format_name,duration', '-of', 'compact', '-o', 'p.txt', data.out); core.reset();
        try { probe = core.FS.readFile('p.txt', { encoding: 'utf8' }); core.FS.unlink('p.txt'); } catch (_) {}
        core.FS.unlink(data.out);
      }
    } catch (e) { text += '\nEXC ' + (e && (e.message || String(e))); try { await boot(); rebooted = true; if (opusSet) writeOpusInputs(); } catch (b) { text += '\nREBOOT FAILED ' + b.message; } }
    self.postMessage({ type: 'trial', name: data.name, ok, ms: Math.round(performance.now() - t0), size, probe, tail: ok ? '' : (rebooted ? '[core rebooted] ' : '') + text.split('\n').slice(-12).join('\n') });
  }
};
