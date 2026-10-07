/* Regression checks for the v1.2.2 bug fixes, driven through the real UI.
 * Load into the running app page like tests/app-smoke.js, then: await runRegression()
 * The microphone is replaced by a synthetic tone so the real 녹음 buttons can be pressed. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const idle = async (ms = 60000) => { const t0 = Date.now(); await sleep(150); while (Date.now() - t0 < ms) { if ($('busy').hidden) return true; await sleep(150); } return false; };
  // Record what would be saved (file names) without really writing to the Downloads folder.
  const saves = []; const origClick = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { saves.push(this.download); return; } return origClick.call(this); };
  const warns = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
  const blobs = []; const origURL = URL.createObjectURL.bind(URL); URL.createObjectURL = b => { if (b instanceof Blob) blobs.push(b); return origURL(b); };
  const fixture = async (name, type) => new File([await (await fetch('tests/fixtures/' + encodeURIComponent(name), { cache: 'no-store' })).blob()], name, { type });
  const drop = async files => { const dt = new DataTransfer(); for (const f of files) dt.items.add(f); document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); await sleep(250); await idle(); await sleep(150); };
  const click = async sel => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!el) throw new Error('없는 단추: ' + sel); el.click(); await sleep(200); await idle(); await sleep(100); };
  const act = name => click(`[data-action="${name}"]:not([disabled])`);
  const tool = name => click(`[data-tool="${name}"]`);
  const setSel = async (a, b) => { $('selectionStart').value = a; $('selectionStart').dispatchEvent(new Event('change', { bubbles: true })); $('selectionEnd').value = b; $('selectionEnd').dispatchEvent(new Event('change', { bubbles: true })); await sleep(150); };
  const setField = async (key, value, scope) => { const el = document.querySelector(`[data-key="${key}"]${scope ? `[data-scope="${scope}"]` : ''}`); if (!el) throw new Error('없는 입력칸: ' + key); if (el.type === 'checkbox') el.checked = value; else el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); await sleep(200); };
  const toastText = () => $('toast').hidden ? '' : $('toast').textContent;
  const convert = async () => { const rc = $('resultCard'), was = rc.textContent; document.querySelector('#panelBody [data-action="export"]').click(); await sleep(300); await idle(180000); await sleep(200); if (rc.hidden || rc.textContent === was || !rc.textContent.includes('저장했어요')) throw new Error('변환 실패: ' + toastText()); };
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
      ok(warns(), '저장 안 한 녹음인데 창 닫기 경고 없음'); await click('#headerExport'); ok(!warns(), '저장했는데도 경고');
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
      ok($('resultCard').textContent !== was && $('resultCard').textContent.includes('저장했어요'), '첫 클릭이 사라짐');
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
    await test('R13 변환하면 바로 저장돼 창 닫기 경고 없음 · 설정을 바꾸면 다시 경고', async () => {
      const fire = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
      ok(!fire(), '변환과 함께 저장했는데 경고'); const again = await download(); ok(again && again.size > 100, '「다시 저장」 안 됨');
      await setField('bitDepth', 24, 'output'); const warned = fire(); await setField('bitDepth', 16, 'output');
      ok(warned, '설정을 바꿨는데 경고 없음'); ok(document.querySelector('#resultCard [data-action="export"]'), '바뀐 결과 카드에 「변환하고 저장」 없음');
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
      const t0 = performance.now(); let done = 0; for (let i = 0; i < 150; i++) { const r = await eng.render(m, { format: i % 2 ? 'mp3' : 'wav', bitrate: 128 }); if (r.size > 64) done++; }
      eng.dispose(); ok(done === 150, '성공 ' + done); return { done, seconds: Math.round((performance.now() - t0) / 1000) };
    });
    await test('R19 녹음 마치고 바로 저장 → 한 번에 파일', async () => {
      await tool('record'); await act('recordStart'); await sleep(1600);
      ok(document.querySelector('[data-action="recordStopSave"]')?.textContent.includes('바로 저장'), '「녹음 마치고 바로 저장」 단추 없음');
      const s0 = saves.length; await act('recordStopSave'); await sleep(600); await idle(); await sleep(400);
      const got = saves.slice(s0); ok(got.length === 1, '저장 수 ' + got.length + ' ' + got.join(','));
      ok(/^수업_녹음_\d{4}-\d{2}-\d{2}_\d{4}\.\w+$/.test(got[0]), '파일 이름 ' + got[0]);
      ok($('resultCard').textContent.includes('저장했어요') && !$('workbench').hidden, '결과 카드 없음'); ok(document.querySelector('.menu-summary [data-action="export"]'), '녹음 뒤 「이대로 저장」 요약 없음');
      return got[0];
    });
    await test('R20 헤더 변환하고 저장 · 이대로 저장 · 다시 저장 · MP3로도 저장은 각각 한 번', async () => {
      await drop([await fixture('tone.mp3', 'audio/mpeg')]); ok($('headerExport').textContent.includes('변환하고 저장'), '헤더 단추 이름');
      let s0 = saves.length; await click('#headerExport'); ok(saves.length === s0 + 1, '헤더 단추 한 번에 저장 안 됨');
      if (!document.querySelector('[data-menu="m-96"]')) await click('[data-action="toggleMenu"]'); await click('[data-menu="m-96"]');
      const sum = document.querySelector('.menu-summary [data-action="export"]'); ok(sum && sum.textContent.includes('이대로 저장'), '요약 단추 이름');
      s0 = saves.length; await click(sum); ok(saves.length === s0 + 1 && /\.mp3$/.test(saves.at(-1)), '이대로 저장 ' + saves.slice(s0));
      s0 = saves.length; await act('download'); ok(saves.length === s0 + 1, '다시 저장');
      await click('[data-action="toggleMenu"]'); await click('[data-menu="v-still"]'); s0 = saves.length; await click('#panelBody [data-action="export"]');
      ok(saves.length === s0 + 1 && /\.mp4$/.test(saves.at(-1)), '영상 저장 ' + saves.slice(s0));
      s0 = saves.length; await act('toMp3'); ok(saves.length === s0 + 1 && /\.mp3$/.test(saves.at(-1)), 'MP3로도 저장 ' + saves.slice(s0));
      return saves.slice(-4);
    });
    await test('R21 바로 저장할 녹음을 열지 못하면 녹음 원본을 그대로 저장', async () => {
      const orig = AudioEngine.prototype.analyze; AudioEngine.prototype.analyze = function () { AudioEngine.prototype.analyze = orig; return Promise.reject(new Error('시험용 실패')); };
      await tool('record'); await act('recordStart'); await sleep(1200); const s0 = saves.length; await act('recordStopSave'); await sleep(500); await idle(); await sleep(300);
      ok(saves.slice(s0).some(n => /\.(webm|ogg|m4a)$/.test(n)), '원본 녹음 저장 안 됨 ' + saves.slice(s0)); ok(document.querySelector('[data-action="recordSave"]')?.textContent.includes('다시 저장'), '「녹음 파일 다시 저장」 없음'); ok(!warns(), '저장했는데 경고');
    });
    await test('R22 저장하지 않은 녹음 → 「이전 녹음 저장하고 새로 녹음」 한 번', async () => {
      const orig = AudioEngine.prototype.analyze; AudioEngine.prototype.analyze = function () { AudioEngine.prototype.analyze = orig; return Promise.reject(new Error('시험용 실패')); };
      await tool('record'); await act('recordStart'); await sleep(1200); await act('recordStop'); await sleep(500); await idle(); await sleep(300);
      ok(document.querySelector('[data-action="recordSave"]'), '「녹음 파일 저장」 없음'); await act('recordStart'); ok($('modal').open, '확인 창 없음');
      const s0 = saves.length; await act('recordSaveStart'); await sleep(600);
      ok(saves.length === s0 + 1, '이전 녹음 저장 안 됨'); ok(!$('modal').open && document.querySelector('[data-action="recordStopSave"]'), '새 녹음이 시작되지 않음');
      await act('recordCancel'); await sleep(300);
    });
    await test('R23 일괄 변환 파일 하나는 ZIP 없이 그 파일로 바로 저장', async () => {
      await tool('batch'); const el = $('batchInput'), dt = new DataTransfer(); dt.items.add(await fixture('tone.mp3', 'audio/mpeg')); el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true })); await sleep(300);
      ok(document.querySelector('[data-action="batchStart"]').textContent.includes('변환하고 저장'), '일괄 단추 이름');
      const s0 = saves.length; await act('batchStart'); const t0 = Date.now(); while (Date.now() - t0 < 60000 && !document.querySelector('.batch-row.done,.batch-row.failed')) await sleep(200); await sleep(500);
      const got = saves.slice(s0); ok(got.length === 1 && !/\.zip$/.test(got[0]), '저장 ' + got.join(','));
      ok(document.querySelector('.batch-row small').textContent.includes('저장함'), '줄에 저장함 표시 없음'); const start = document.querySelector('[data-action="batchStart"]'); ok(start.disabled && start.textContent.includes('모두 변환했어요'), '할 일이 없는데 주 단추가 켜져 있음'); ok(document.querySelector('#auxPanel .saved-note'), '저장 안내 없음');
      await act('batchClear'); await tool('convert'); return got[0];
    });
    await test('R24 구간이 하나면 구간별 저장은 창 없이 그 파일로 바로 저장', async () => {
      await drop([await fixture('수업 소리 & 테스트.wav', 'audio/wav')]); await tool('classroom');
      const s0 = saves.length; await act('exportClips'); ok(saves.length === s0 + 1 && !$('modal').open, '저장 ' + saves.slice(s0) + ' 창 ' + $('modal').open); await tool('convert');
    });
    await test('R25 구간별 저장을 취소하면 아무것도 저장하지 않음', async () => {
      await drop([await fixture('수업 소리 & 테스트.wav', 'audio/wav')]); await tool('classroom'); $('splitSeconds').value = '0.1'; await act('splitFixed');
      const s0 = saves.length; document.querySelector('[data-action="exportClips"]').click(); for (let i = 0; i < 300 && $('busy').hidden; i++) await sleep(5); await sleep(400); $('cancelBtn').click(); await sleep(800); await idle(); await sleep(200);
      ok(saves.length === s0, '취소했는데 저장 ' + saves.slice(s0)); ok(!$('modal').open, '취소했는데 창이 열림');
      await act('undo'); await tool('convert');
    });
    await test('R26 저장한 뒤 이름을 바꾸면 「새 이름으로 저장」 · 같은 결과는 다시 변환하지 않음 · 두 번 눌러도 한 번', async () => {
      await tool('convert'); await click('#headerExport'); await setField('outputName', '새_이름_시험', 'special');
      ok($('resultCard').textContent.includes('이름을 바꿨어요'), '이름 바뀜 안내 없음'); const btn = document.querySelector('#resultCard [data-action="download"]'); ok(btn.textContent.includes('새 이름으로 저장') && btn.classList.contains('primary'), '새 이름 저장 단추');
      let s0 = saves.length; await act('download'); ok(saves.length === s0 + 1 && saves.at(-1).startsWith('새_이름_시험'), '새 이름 저장 ' + saves.slice(s0)); ok($('resultCard').textContent.includes('저장했어요'), '저장 상태로 돌아오지 않음');
      await sleep(1600); s0 = saves.length; $('headerExport').click(); await sleep(120); ok($('busy').hidden && saves.length === s0 + 1, '같은 결과인데 다시 변환함');
      $('headerExport').click(); await sleep(120); ok(saves.length === s0 + 1, '두 번 눌러 두 번 저장됨');
    });
    await test('R27 저장 안 한 녹음 위에 새로 녹음·다른 파일 열기는 먼저 물어보고 한 번에 저장', async () => {
      await tool('record'); await act('recordStart'); await sleep(1200); await act('recordStop'); await sleep(500); await idle(); await sleep(300); ok(warns(), '열어 둔 녹음에 닫기 경고 없음');
      await tool('record'); await act('recordStart'); ok($('modal').open && $('modalContent').textContent.includes('편집 중인 녹음'), '새로 녹음하기 전에 묻지 않음');
      let s0 = saves.length; await act('recordExportStart'); await sleep(500); ok(saves.length === s0 + 1, '저장하고 새로 녹음: 저장 안 됨'); ok(document.querySelector('[data-action="recordStopSave"]'), '새 녹음이 시작되지 않음');
      await act('recordCancel'); await sleep(300); ok(!warns(), '저장했는데 경고');
      await act('recordStart'); await sleep(1000); await act('recordStop'); await sleep(500); await idle(); await sleep(300);
      document.querySelector('.top-bar [data-action="open"]').click(); await sleep(200); ok($('modal').open && $('modalContent').textContent.includes('다른 파일을 열면'), '다른 파일 열기 전에 묻지 않음');
      s0 = saves.length; await act('recordSaveNow'); ok(saves.length === s0 + 1 && !warns(), '녹음 먼저 저장');
    });
    await test('R28 Ctrl/Cmd+S는 웹 페이지 대신 소리를 저장', async () => {
      await tool('convert'); await sleep(1600); const s0 = saves.length; const e = new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); await sleep(300); await idle(); await sleep(200);
      ok(e.defaultPrevented, '페이지 저장을 막지 않음'); ok(saves.length === s0 + 1, '저장 안 됨 ' + saves.slice(s0));
    });
    await test('R29 바로 저장 중 파일 분석을 취소하면 내려받지 않고 녹음 원본을 보관', async () => {
      const orig = AudioEngine.prototype.analyze; AudioEngine.prototype.analyze = function () { AudioEngine.prototype.analyze = orig; return new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('시험용 취소'), { code: 'CANCELLED' })), 900)); };
      await tool('record'); await act('recordStart'); await sleep(1000); const s0 = saves.length; document.querySelector('[data-action="recordStopSave"]').click();
      for (let i = 0; i < 200 && $('busy').hidden; i++) await sleep(10); await sleep(200); $('cancelBtn').click(); await sleep(1200); await idle(); await sleep(300);
      ok(saves.length === s0, '취소했는데 저장 ' + saves.slice(s0)); ok(document.querySelector('[data-action="recordSave"]')?.textContent.trim().endsWith('녹음 파일 저장'), '녹음 원본 보관 단추 없음'); ok(warns(), '보관 중인 녹음에 닫기 경고 없음');
      await act('recordSave'); ok(!warns(), '저장했는데 경고'); await tool('convert');
    });
    return { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok), results };
  };
})();
