/* Regression checks for the v1.2.2 bug fixes, driven through the real UI.
 * Load into the running app page like tests/app-smoke.js, then: await runRegression()
 * The microphone is replaced by a synthetic tone so the real 녹음 buttons can be pressed. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const idle = async (ms = 60000) => { const t0 = Date.now(); await sleep(150); while (Date.now() - t0 < ms) { if ($('busy').hidden) return true; await sleep(150); } return false; };
  const blobs = []; const origURL = URL.createObjectURL.bind(URL); URL.createObjectURL = b => { if (b instanceof Blob) blobs.push(b); return origURL(b); };
  const fixture = async (name, type) => new File([await (await fetch('tests/fixtures/' + encodeURIComponent(name), { cache: 'no-store' })).blob()], name, { type });
  const drop = async files => { const dt = new DataTransfer(); for (const f of files) dt.items.add(f); document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); await sleep(250); await idle(); await sleep(150); };
  const click = async sel => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!el) throw new Error('없는 단추: ' + sel); el.click(); await sleep(200); await idle(); await sleep(100); };
  const act = name => click(`[data-action="${name}"]:not([disabled])`);
  const tool = name => click(`[data-tool="${name}"]`);
  const setSel = async (a, b) => { $('selectionStart').value = a; $('selectionStart').dispatchEvent(new Event('change', { bubbles: true })); $('selectionEnd').value = b; $('selectionEnd').dispatchEvent(new Event('change', { bubbles: true })); await sleep(150); };
  const setField = async (key, value, scope) => { const el = document.querySelector(`[data-key="${key}"]${scope ? `[data-scope="${scope}"]` : ''}`); if (!el) throw new Error('없는 입력칸: ' + key); if (el.type === 'checkbox') el.checked = value; else el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); await sleep(200); };
  const toastText = () => $('toast').hidden ? '' : $('toast').textContent;
  const convert = async () => { const rc = $('resultCard'), was = rc.textContent; document.querySelector('#panelBody [data-action="export"]').click(); await sleep(300); await idle(180000); await sleep(200); if (rc.hidden || rc.textContent === was || !rc.textContent.includes('변환이 완료')) throw new Error('변환 실패: ' + toastText()); };
  const download = async () => { const n = blobs.length; await act('download'); await sleep(150); return blobs.slice(n).find(b => !b.type.startsWith('application/json')); };
  let ctx; const buf = async blob => { ctx = ctx || new AudioContext(); return ctx.decodeAudioData(await blob.arrayBuffer()); };
  const hz = (b, ch, from, to) => { const d = b.getChannelData(ch), s = Math.floor(from * b.sampleRate), e = Math.floor(to * b.sampleRate); let c = 0; for (let i = s + 1; i < e; i++) if (d[i - 1] <= 0 && d[i] > 0) c++; return Math.round(c / (to - from)); };
  const peak = (b, ch, from = 0, to = b.duration) => { const d = b.getChannelData(ch); let p = 0; for (let i = Math.floor(from * b.sampleRate); i < Math.min(d.length, Math.floor(to * b.sampleRate)); i++) p = Math.max(p, Math.abs(d[i])); return p; };
  const rms = (b, ch, from, to) => { const d = b.getChannelData(ch); let s = 0, n = 0; for (let i = Math.floor(from * b.sampleRate); i < Math.floor(to * b.sampleRate); i++) { s += d[i] * d[i]; n++; } return Math.sqrt(s / Math.max(1, n)); };
  const readWav = async blob => { const bytes = new Uint8Array(await blob.arrayBuffer()), v = new DataView(bytes.buffer); let p = 12, fmt = null, data = null; while (p + 8 <= bytes.length) { const id = String.fromCharCode(...bytes.slice(p, p + 4)), size = v.getUint32(p + 4, true); if (id === 'fmt ') fmt = { ch: v.getUint16(p + 10, true), rate: v.getUint32(p + 12, true) }; if (id === 'data') { data = { off: p + 8, size }; break; } p += 8 + size + (size & 1); } const n = Math.floor(data.size / fmt.ch / 2); return { channels: fmt.ch, rate: fmt.rate, ch: c => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = v.getInt16(data.off + (i * fmt.ch + c) * 2, true) / 32768; return a; } }; };
  const hzArr = (a, rate) => { let c = 0; for (let i = 1; i < a.length; i++) if (a[i - 1] <= 0 && a[i] > 0) c++; return Math.round(c / (a.length / rate)); };
  const wav = (seconds, rate, freqs, amp = .4) => { const ch = freqs.length, frames = Math.round(seconds * rate), data = new Int16Array(frames * ch); for (let i = 0; i < frames; i++) for (let c = 0; c < ch; c++) data[i * ch + c] = Math.round(Math.sin(2 * Math.PI * freqs[c] * i / rate) * amp * 32767); const bytes = new Uint8Array(44 + data.byteLength), v = new DataView(bytes.buffer), tag = (at, s) => [...s].forEach((x, i) => bytes[at + i] = x.charCodeAt(0)); tag(0, 'RIFF'); v.setUint32(4, 36 + data.byteLength, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, data.byteLength, true); bytes.set(new Uint8Array(data.buffer), 44); return bytes; };
  // A fake microphone: a 440 Hz tone that switches to 880 Hz after 1.5 s.
  const fakeMic = () => { navigator.mediaDevices.getUserMedia = async () => { const c = new AudioContext(), d = c.createMediaStreamDestination(), o = c.createOscillator(), g = c.createGain(); g.gain.value = .3; o.frequency.setValueAtTime(440, c.currentTime); o.frequency.setValueAtTime(880, c.currentTime + 1.5); o.connect(g); g.connect(d); o.start(); const stream = d.stream; const stop = stream.getTracks()[0].stop.bind(stream.getTracks()[0]); stream.getTracks()[0].stop = () => { stop(); o.stop(); c.close(); }; return stream; }; };

  window.runRegression = async (only) => {
    const results = []; window.__regProgress = [];
    const test = async (name, fn) => { if (only && !only.some(o => name.startsWith(o))) return; window.__regProgress.push(name); const t0 = performance.now(); try { const detail = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('2분 초과')), 120000))]); results.push({ name, ok: true, ms: Math.round(performance.now() - t0), detail }); } catch (e) { results.push({ name, ok: false, error: e.message, toast: toastText() }); await idle(); if ($('modal').open) $('modal').close(); } };
    const ok = (c, m) => { if (!c) throw new Error(m); };
    fakeMic();

    await test('R01 녹음 단추로 녹음 → 녹음 마치고 편집 → 편집 화면', async () => {
      await tool('record'); await act('recordStart'); await sleep(2600);
      await act('recordStop'); await sleep(400); await idle(); await sleep(300);
      ok(!$('workbench').hidden && $('sourceName').textContent.includes('녹음'), '편집 화면이 아님: ' + toastText());
      return $('sourceMeta').textContent;
    });
    await test('R02 녹음 시작 두 번 눌러도 녹음기는 하나', async () => {
      await tool('record'); const btn = document.querySelector('[data-action="recordStart"]'); btn.click(); btn.click(); await sleep(800);
      ok(document.querySelectorAll('[data-action="recordStop"]').length === 1, '정지 단추 수');
      await act('recordCancel'); await sleep(300);
    });
    await test('R03 녹음 중 파일 열기는 막고 녹음은 유지', async () => {
      await tool('record'); await act('recordStart'); await sleep(500);
      document.querySelector('.top-bar [data-action="open"]').click(); await sleep(200);
      ok(toastText().includes('녹음 중'), '안내 없음: ' + toastText()); ok(!!document.querySelector('[data-action="recordStop"]'), '녹음이 멈춤');
      await act('recordCancel'); await sleep(300);
    });
    await test('R04 녹음을 열지 못하면 녹음 파일을 보관하고 저장할 수 있음', async () => {
      const orig = AudioEngine.prototype.analyze; AudioEngine.prototype.analyze = function () { AudioEngine.prototype.analyze = orig; return Promise.reject(new Error('시험용 실패')); };
      await tool('record'); await act('recordStart'); await sleep(1200); await act('recordStop'); await sleep(500); await idle(); await sleep(300);
      ok(!!document.querySelector('[data-action="recordSave"]'), '「녹음 파일 저장」 단추 없음');
      const n = blobs.length; await act('recordSave'); const saved = blobs.slice(n).find(b => b.type.includes('webm') || b.type.includes('ogg') || b.type.includes('mp4'));
      ok(saved && saved.size > 1000, '녹음 Blob 저장 안 됨'); return saved.size;
    });
    await test('R05 선택만 듣기는 선택 끝에서 오디오가 직접 멈추고 시작점으로 돌아감', async () => {
      await drop([await fixture('수업 소리 & 테스트.wav', 'audio/wav')]); await setSel(1, 1.4);
      $('playSelection').checked = true; $('loop').checked = false; await act('play'); await sleep(900);
      const stopped = $('playBtn').getAttribute('aria-label').startsWith('재생'); const at = $('currentTime').textContent;
      $('playSelection').checked = false; ok(stopped && at.startsWith('00:01.0'), `멈춤 ${stopped} 위치 ${at}`); return at;
    });
    await test('R06 재생 중 위치 막대를 잡고 있으면 덮어쓰지 않음', async () => {
      await act('play'); await sleep(200); const seek = $('seek'); seek.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); seek.value = 3.2; await sleep(300);
      const held = Number(seek.value); document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); seek.dispatchEvent(new Event('change', { bubbles: true })); await sleep(200);
      const now = $('currentTime').textContent; await act('play'); ok(Math.abs(held - 3.2) < .01 && now >= '00:03.2', `값 ${held} 위치 ${now}`); return now;
    });
    await test('R07 구간 미리 듣기 뒤 원본 A → 편집본 B는 전체로 다시 만듦', async () => {
      await setSel(1, 2); await act('trim'); await act('resetEdits').catch(() => {}); await tool('edit'); await act('resetEdits'); await tool('convert');
      await setSel(0, 3); await act('delete'); await setSel(.2, .6); await act('previewSelection'); await sleep(200); if (!$('playBtn').getAttribute('aria-label').startsWith('재생')) await act('play');
      await click('[data-listen="original"]'); await click('[data-listen="edited"]');
      const total = $('totalTime').textContent; ok(total.startsWith('00:01.0'), '편집본 B 길이 ' + total); return total;
    });
    await test('R08 트랙을 바꾸면 편집이 사라진다고 먼저 물어봄', async () => {
      await drop([await fixture('video-multi-track.mp4', 'video/mp4')]); await setSel(.5, 2); await act('trim');
      const sel = $('audioTrack'); sel.value = '1'; sel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(300);
      ok($('modal').open && $('modalTitle').textContent.includes('트랙'), '확인 창 없음'); await act('closeModal');
      ok($('clipSummary').textContent.includes('00:01.500'), '편집이 사라짐 ' + $('clipSummary').textContent);
    });
    await test('R09 입력칸에 쓰고 바로 누른 단추가 먹힘', async () => {
      await drop([await fixture('수업 소리 & 테스트.wav', 'audio/wav')]); await click('[data-menu="v-still"]');
      const input = document.querySelector('[data-key="videoTitle"]'); input.focus(); input.value = '바로 누르기 시험';
      const btn = document.querySelector('#panelBody [data-action="export"]'), was = $('resultCard').textContent;
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); input.blur();
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); ok(btn.isConnected, '누르는 중에 단추가 다시 그려짐'); btn.click(); await sleep(300); await idle(); await sleep(300);
      ok($('resultCard').textContent !== was && $('resultCard').textContent.includes('변환이 완료'), '첫 클릭이 사라짐');
    });
    await test('R10 설정을 바꿔도 키보드 포커스 유지', async () => {
      const s = document.querySelector('[data-key="videoSize"]'); s.focus(); s.value = '1080x1080'; s.dispatchEvent(new Event('change', { bubbles: true })); await sleep(300);
      ok(document.activeElement?.dataset?.key === 'videoSize', '포커스 ' + (document.activeElement?.dataset?.key || document.activeElement?.tagName));
      await click('[data-action="toggleMenu"]'); await click('[data-menu="m-192"]');
    });
    await test('R11 창 안쪽 여백을 눌러도 닫히지 않음, 바깥은 닫힘', async () => {
      await act('help'); const d = $('modal'), r = d.getBoundingClientRect();
      const fire = (x, y) => { d.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y })); d.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y })); };
      fire(r.left + 8, r.top + 8); await sleep(100); ok(d.open, '여백 클릭에 닫힘'); fire(r.left - 20, r.top + 20); await sleep(150); ok(!d.open, '바깥 클릭에 안 닫힘');
    });
    await test('R12 처리 중에는 작업 취소에 포커스, 뒤 화면은 잠김', async () => {
      await setField('format', 'flac', 'output'); document.querySelector('#panelBody [data-action="export"]').click();
      const focused = document.activeElement === $('cancelBtn'), inert = document.querySelector('.app-body').inert; await idle(); await sleep(200);
      ok(focused && inert, `포커스 ${focused} 잠김 ${inert}`); ok(!document.querySelector('.app-body').inert, '끝난 뒤에도 잠김');
    });
    await test('R13 내려받지 않은 결과가 있으면 창 닫기 경고', async () => {
      const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); const warnedBefore = e.defaultPrevented;
      await download(); const e2 = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e2);
      ok(warnedBefore, '경고 없음'); return { afterDownloadStillWarns: e2.defaultPrevented };
    });
    await test('R14 일괄 변환은 작업 취소로 멈춤', async () => {
      await tool('batch'); const files = [await fixture('수업 소리 & 테스트.wav', 'audio/wav'), await fixture('tone.mp3', 'audio/mpeg'), await fixture('silence-gaps.wav', 'audio/wav')];
      const el = $('batchInput'), dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true })); await sleep(300);
      document.querySelector('[data-action="batchStart"]').click(); for (let i = 0; i < 200 && $('busy').hidden; i++) await sleep(5); $('cancelBtn').click(); await sleep(800); await idle();
      const states = [...document.querySelectorAll('.batch-row')].map(r => r.className.replace('batch-row', '').trim() || 'waiting');
      ok(states.filter(s => s === 'waiting').length >= 1 && !document.querySelector('.batch-row.running'), '멈추지 않음 ' + states.join(','));
      await act('batchClear'); await tool('convert'); return states;
    });
    await test('R15 4채널 원본은 채널 순서 그대로', async () => {
      await drop([new File([wav(3, 48000, [200, 300, 450, 600])], '4채널.wav', { type: 'audio/wav' })]);
      await setField('format', 'wav', 'output'); await setField('channels', 0, 'output'); await convert(); const b = await readWav(await download());
      const f = [0, 1, 2, 3].map(c => hzArr(b.ch(c), b.rate)); ok(b.channels === 4 && Math.abs(f[0] - 200) < 3 && Math.abs(f[1] - 300) < 3 && Math.abs(f[2] - 450) < 3 && Math.abs(f[3] - 600) < 3, '채널 주파수 ' + f.join(','));
      return f;
    });
    await test('R16 스테레오 → 모노는 찌그러지지 않음', async () => {
      await drop([new File([wav(2, 48000, [440, 440], .9)], '큰소리.wav', { type: 'audio/wav' })]);
      await setField('format', 'wav', 'output'); await setField('channels', 1, 'output'); await tool('effects'); await setField('limiter', false, 'effects'); await tool('convert');
      await convert(); const w = await readWav(await download()); const p = w.ch(0).reduce((m, x) => Math.max(m, Math.abs(x)), 0); const b = { numberOfChannels: w.channels }; await setField('channels', 0, 'output'); await tool('effects'); await setField('limiter', true, 'effects'); await tool('convert');
      ok(b.numberOfChannels === 1 && p < .95 && p > .8, '모노 최고값 ' + p.toFixed(3)); return p;
    });
    await test('R17 앞 무음이 있어도 페이드 인이 소리에 걸림', async () => {
      await drop([await fixture('수업 소리 & 테스트.wav', 'audio/wav')]); await tool('edit'); await setField('fadeIn', 1); await tool('classroom'); await setField('padStart', 1); await tool('convert');
      await setField('format', 'wav', 'output'); await convert(); const b = await buf(await download());
      const silent = rms(b, 0, .1, .9), start = rms(b, 0, 1.0, 1.1), full = rms(b, 0, 3, 3.5);
      ok(silent < .001 && start < full * .3 && full > .1, `무음 ${silent.toFixed(4)} 시작 ${start.toFixed(3)} 본소리 ${full.toFixed(3)}`); return { silent, start, full };
    });
    await test('R18 엔진을 150번 연속 써도 멈추지 않음', async () => {
      const eng = new AudioEngine(), f = await fixture('tone-mono-22050.wav', 'audio/wav'), a = await eng.analyze(f), m = window.StudioModel.edit(window.StudioModel.create(a), 'trim', { start: 0, end: .3 });
      const t0 = performance.now(); let done = 0; for (let i = 0; i < 150; i++) { const r = await eng.render(m, { format: i % 2 ? 'mp3' : 'wav', bitrate: 128 }); if (r.bytes.length > 64) done++; }
      eng.dispose(); ok(done === 150, '성공 ' + done); return { done, seconds: Math.round((performance.now() - t0) / 1000) };
    });
    return { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok), results };
  };
})();
