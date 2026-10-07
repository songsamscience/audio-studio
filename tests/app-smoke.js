/* End-to-end smoke test that drives the real UI the way a teacher would.
 * Load into the running app page (same origin, allowed by serve.py's CSP):
 *   const s=document.createElement('script');s.src='tests/app-smoke.js';document.head.append(s);  then  await runSmoke()
 * Uses only tests/fixtures and a synthetic MediaRecorder recording. Nothing leaves the browser. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Record what would be saved (file names) without really writing to the Downloads folder.
  const saves = []; const origClick = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { saves.push(this.download); return; } return origClick.call(this); };
  const blobs = [];
  const origURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = b => { if (b instanceof Blob) blobs.push(b); return origURL(b); };
  const lastBlob = type => blobs.filter(b => !type || b.type.startsWith(type)).at(-1);
  const fixture = async (name, type) => new File([await (await fetch('tests/fixtures/' + encodeURIComponent(name), { cache: 'no-store' })).blob()], name, { type });
  const idle = async (ms = 60000) => { const t0 = Date.now(); await sleep(150); while (Date.now() - t0 < ms) { if ($('busy').hidden) return true; await sleep(150); } return false; };
  const toastText = () => $('toast').hidden ? '' : $('toast').textContent;
  const toastError = () => !$('toast').hidden && $('toast').classList.contains('error');
  const drop = async files => { const dt = new DataTransfer(); for (const f of files) dt.items.add(f); document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); await sleep(250); await idle(); await sleep(150); };
  const input = async (id, files) => { const el = $(id), dt = new DataTransfer(); for (const f of files) dt.items.add(f); el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true })); await sleep(250); await idle(); await sleep(150); };
  const click = async sel => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!el) throw new Error('없는 단추: ' + sel); (window.__smokeProgress || []).push('click ' + (typeof sel === 'string' ? sel : el.textContent.trim().slice(0, 20))); el.click(); await sleep(200); await idle(); await sleep(100); };
  const act = name => click(`[data-action="${name}"]:not([disabled])`);
  const tool = name => click(`[data-tool="${name}"]`);
  const setField = async (key, value, scope) => { const el = document.querySelector(`[data-key="${key}"]${scope ? `[data-scope="${scope}"]` : ''}`); if (!el) throw new Error('없는 입력칸: ' + key); if (el.type === 'checkbox') el.checked = value; else el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); await sleep(200); };
  const setSel = async (a, b) => { $('selectionStart').value = a; $('selectionStart').dispatchEvent(new Event('change', { bubbles: true })); $('selectionEnd').value = b; $('selectionEnd').dispatchEvent(new Event('change', { bubbles: true })); await sleep(150); };
  const seek = async t => { $('seek').value = t; $('seek').dispatchEvent(new Event('change', { bubbles: true })); await sleep(120); };
  const resetEdits = async () => { await tool('edit'); await act('resetEdits'); await tool('convert'); };
  const finalSeconds = () => { const m = $('clipSummary').textContent.match(/최종 (\d+):(\d+\.\d+)/); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
  const convert = async () => { const rc = $('resultCard'), was = rc.textContent, n0 = saves.length; document.querySelector('#panelBody [data-action="export"]').click(); await sleep(300); await idle(180000); await sleep(200); if (rc.hidden || rc.textContent === was || !rc.textContent.includes('저장했어요')) throw new Error('변환 실패: ' + toastText()); if (saves.length !== n0 + 1) throw new Error('한 번 눌렀는데 저장(다운로드) ' + (saves.length - n0) + '번'); return rc.querySelector('.result-body p').textContent; };
  const download = async () => { const n = blobs.length; await act('download'); await sleep(200); const b = blobs.slice(n).find(x => !x.type.startsWith('application/json')); if (!b) throw new Error('다운로드 Blob 없음'); return b; };
  let ctx;
  const analyse = async blob => { ctx = ctx || new AudioContext(); const buf = await ctx.decodeAudioData(await blob.arrayBuffer()); const ch = i => buf.getChannelData(Math.min(i, buf.numberOfChannels - 1)); const stat = (from = 0, to = buf.duration, c = 0) => { const d = ch(c), s = Math.floor(from * buf.sampleRate), e = Math.min(d.length, Math.floor(to * buf.sampleRate)); let sum = 0, cross = 0; for (let i = s; i < e; i++) { sum += d[i] * d[i]; if (i > s && d[i - 1] <= 0 && d[i] > 0) cross++; } return { rms: Math.sqrt(sum / Math.max(1, e - s)), hz: Math.round(cross / Math.max(1e-9, (e - s) / buf.sampleRate)) }; }; return { duration: buf.duration, channels: buf.numberOfChannels, rate: buf.sampleRate, stat }; };
  const near = (a, b, eps = 0.06) => Math.abs(a - b) <= eps;
  const record = async (seconds, freqs) => { const c = new AudioContext(), dest = c.createMediaStreamDestination(), o = c.createOscillator(), g = c.createGain(); g.gain.value = .3; freqs.forEach(([t, f]) => o.frequency.setValueAtTime(f, c.currentTime + t)); o.connect(g); g.connect(dest); o.start(); const rec = new MediaRecorder(dest.stream, MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus' } : {}); const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data); const done = new Promise(r => rec.onstop = r); rec.start(250); await sleep(seconds * 1000); rec.stop(); await done; o.stop(); await c.close(); return new File([new Blob(chunks, { type: rec.mimeType })], '수업_녹음_시험.webm', { type: rec.mimeType }); };

  window.runSmoke = async (only) => {
    const results = [];
    window.__smokeProgress = [];
    const test = async (name, fn) => { if (only && !only.some(o => name.includes(o))) return; window.__smokeProgress.push(name); const t0 = performance.now(); try { const detail = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('2분 안에 끝나지 않음')), 120000))]); results.push({ name, ok: true, ms: Math.round(performance.now() - t0), detail }); } catch (e) { results.push({ name, ok: false, ms: Math.round(performance.now() - t0), error: e.message, toast: toastText() }); await idle(); if ($('modal').open) $('modal').close(); } };
    const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
    const open = async (name, type) => { await drop([await fixture(name, type)]); ok(!$('workbench').hidden, name + ' 열기 실패: ' + toastText()); };

    await test('01 WAV 열기 · 파일 메뉴 · MP3 변환', async () => {
      await open('수업 소리 & 테스트.wav', 'audio/wav');
      const groups = [...document.querySelectorAll('#convertMenu .catalog-group h3')].map(h => h.textContent);
      ok(groups.length === 3, '메뉴 갈래 ' + groups.join(','));
      await click('[data-menu="m-192"]');
      const info = await convert(); const a = await analyse(await download());
      ok(info.startsWith('mp3') && near(a.duration, 4.03, .08) && near(a.stat(.2, 1.8, 0).hz, 440, 3), 'MP3 결과 ' + info);
      return { info, hz: a.stat(.2, 1.8).hz };
    });
    await test('02 선택 삭제 → 재생은 편집본 B, 길이 3초', async () => {
      await tool('convert'); await setSel(1, 2); await act('delete');
      ok(near(finalSeconds(), 3, .002), '최종 길이 ' + finalSeconds());
      ok(document.querySelector('[data-listen].on').dataset.listen === 'edited', '편집 뒤 듣기 대상이 B가 아님');
      await act('play'); await sleep(300); ok($('playBtn').getAttribute('aria-label').startsWith('일시정지'), '재생 시작 안 됨');
      const total = $('totalTime').textContent; await act('play');
      ok(total.startsWith('00:03'), 'B 길이 ' + total); return { total };
    });
    await test('03 실행 취소 → 원본 A로, 다시 실행', async () => {
      await act('undo'); ok(near(finalSeconds(), 4, .002), '취소 뒤 ' + finalSeconds());
      ok(document.querySelector('[data-listen].on').dataset.listen === 'original', '편집 없음인데 B');
      await act('redo'); ok(near(finalSeconds(), 3, .002), '다시 실행 뒤 ' + finalSeconds()); await act('undo');
    });
    await test('04 분할 · 순서 바꾸기 · 구간 삭제', async () => {
      await seek(1.5); await act('split');
      ok($('clipList').querySelectorAll('.clip-row').length === 2, '분할 실패');
      await click('[data-clip-action="down"][data-index="0"]');
      const first = $('clipList').querySelector('.clip-row small').textContent;
      ok(first.startsWith('00:01.5'), '순서 ' + first);
      await click('[data-clip-action="remove"][data-index="0"]'); ok(near(finalSeconds(), 1.5, .01), '구간 삭제 ' + finalSeconds());
      await resetEdits(); ok(near(finalSeconds(), 4, .002), '초기화 ' + finalSeconds());
    });
    await test('05 페이드·자르기 결과 소리 확인 (WAV)', async () => {
      await tool('edit'); await setField('fadeIn', 1); await tool('convert'); await setSel(.5, 3.5); await act('trim');
      await setField('format', 'wav', 'output'); const info = await convert(); const a = await analyse(await download());
      ok(near(a.duration, 3, .002), '길이 ' + a.duration);
      ok(a.stat(0, .05).rms < a.stat(1.5, 2).rms * .2, '페이드 인 없음');
      await resetEdits(); return { info };
    });
    await test('06 소리 보정(균일화·컴프레서·채널 왼쪽만)', async () => {
      await tool('effects'); await setField('normalize', true, 'effects'); await setField('compressor', true, 'effects'); await setField('channelMode', 'left', 'effects');
      await tool('convert'); await setField('channels', 2, 'output'); const info = await convert(); const a = await analyse(await download());
      ok(near(a.stat(.2, 1.8, 1).hz, 440, 3), '오른쪽이 왼쪽 소리가 아님 ' + a.stat(.2, 1.8, 1).hz);
      await tool('effects'); await act('resetEffects'); await setField('channelMode', 'keep', 'effects'); await tool('convert'); await setField('channels', 0, 'output');
      return { info };
    });
    await test('07 속도 2배 · 음높이 유지', async () => {
      await tool('speed'); await setField('speed', 2); await tool('convert'); const a = await analyse(await download_after_convert());
      ok(near(a.duration, 2, .05) && near(a.stat(.2, 1.5).hz, 440, 4), `속도 ${a.duration} ${a.stat(.2, 1.5).hz}`);
      await tool('speed'); await setField('speed', 1); await tool('convert');
    });
    async function download_after_convert() { await convert(); return download(); }
    await test('08 반복 2회 + 사이 무음 0.5초', async () => {
      await tool('classroom'); await setField('repeat', 2); await setField('gap', .5); await tool('convert');
      const a = await analyse(await download_after_convert()); ok(near(a.duration, 8.5, .02), '반복 길이 ' + a.duration);
      ok(a.stat(4.1, 4.4).rms < .001, '사이 무음 없음');
      await tool('classroom'); await setField('repeat', 1); await setField('gap', 0); await tool('convert');
    });
    await test('09 북마크 · 북마크별 파일 · ZIP', async () => {
      await tool('classroom'); await seek(1.5); $('bookmarkName').value = '도입'; await act('bookmark'); await seek(3); $('bookmarkName').value = '전개'; await act('bookmark');
      ok(document.querySelectorAll('.bookmark-row').length === 2, '북마크 수');
      const n0 = blobs.length; await act('exportBookmarks'); ok($('modal').open, '구간 파일 창 안 열림'); ok(blobs.slice(n0).some(b => b.type === 'application/zip'), '한 번에 ZIP 저장 안 됨');
      const rows = [...document.querySelectorAll('#modalContent .batch-row small')].map(x => x.textContent);
      ok(rows.length === 3, '구간 파일 ' + rows.length);
      const n = blobs.length; await click('[data-action="segmentZip"]'); const zip = blobs.slice(n).find(b => b.type === 'application/zip');
      ok(zip && zip.size > 1000, 'ZIP 없음'); if ($('modal').open) await act('closeModal');
      return { rows, zip: zip.size };
    });
    await test('10 무음 찾기 · 제거', async () => {
      await open('silence-gaps.wav', 'audio/wav'); await tool('classroom');
      document.querySelector('#panelBody details').open = true; $('silenceEdges').checked = false;
      await act('detectSilence'); const found = document.querySelectorAll('#silenceResults .bookmark-row').length;
      ok(found >= 2, '무음 구간 ' + found); const before = finalSeconds(); await act('applySilence');
      ok(finalSeconds() < before - 1, `제거 전 ${before} 후 ${finalSeconds()}`); return { found, before, after: finalSeconds() };
    });
    await test('11 목소리 + 배경음 혼합', async () => {
      await open('수업 소리 & 테스트.wav', 'audio/wav'); await tool('mix');
      await input('mixInput', [await fixture('tone-mono-22050.wav', 'audio/wav')]);
      ok(document.querySelector('#mixCanvas'), '배경음 패널 없음'); await tool('convert');
      await setField('format', 'mp3', 'output'); const info = await convert(); await tool('mix'); await act('removeBackground'); await tool('convert'); return { info };
    });
    await test('12 이어 붙이기 · 크로스페이드', async () => {
      await input('appendInput', [await fixture('tone.mp3', 'audio/mpeg')]);
      ok($('clipList').querySelectorAll('.clip-row').length === 2, '이어 붙이기 실패');
      await tool('edit'); await setField('crossfade', .5); await tool('convert');
      ok(finalSeconds() > 7.3 && finalSeconds() < 7.7, '4초 + 4초 - 겹침 0.5초가 아님: ' + finalSeconds());
      await resetEdits();
    });
    await test('13 영상에서 소리 꺼내기 · 원본 그대로', async () => {
      await open('video-with-audio.mp4', 'video/mp4');
      ok(document.querySelectorAll('#convertMenu .catalog-group').length === 1, '영상 메뉴 갈래');
      await click('[data-menu="x-m4a"]'); const info = await convert(); ok(info.startsWith('aac'), info);
      await click('[data-action="toggleMenu"]'); const n0 = blobs.length; await click('[data-menu="x-copy"]'); ok(!$('modal').open, '확인 창 없이 바로 저장해야 함');
      ok($('resultCard').textContent.includes('원본 코덱 그대로'), '원본 그대로 결과 아님'); ok(blobs.slice(n0).length >= 1, '원본 그대로 저장 안 됨'); return { info };
    });
    await test('14 다중 오디오 트랙 선택', async () => {
      await open('video-multi-track.mp4', 'video/mp4'); const sel = $('audioTrack'); ok(sel && sel.options.length === 2, '트랙 목록');
      sel.value = '1'; sel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(300); await idle();
      ok($('sourceMeta').textContent.includes('1채널'), '2번 트랙 아님 ' + $('sourceMeta').textContent);
    });
    await test('15 마이크 녹음 파일(MediaRecorder WebM) 열기·자르기·재생', async () => {
      await drop([await record(3, [[0, 440], [1.5, 880]])]);
      ok(!$('workbench').hidden && $('sourceName').textContent.includes('녹음'), '녹음 열기 실패: ' + toastText());
      await setSel(2, 2.8); await act('trim'); ok(document.querySelector('[data-listen].on').dataset.listen === 'edited', 'B 아님');
      await setField('format', 'wav', 'output'); const a = await analyse(await download_after_convert());
      ok(near(a.duration, .8, .01) && near(a.stat(.05, .75).hz, 880, 6), `녹음 자르기 ${a.duration} ${a.stat(.05, .75).hz}`);
      return { duration: a.duration, hz: a.stat(.05, .75).hz };
    });
    await test('16 음원 → MP4 정지 화면 영상', async () => {
      await open('수업 소리 & 테스트.wav', 'audio/wav'); await click('[data-menu="v-still"]');
      const info = await convert(); const v = document.querySelector('#resultCard video');
      await new Promise(r => { if (v.readyState >= 1) r(); else { v.onloadedmetadata = r; setTimeout(r, 4000); } });
      ok(v.videoWidth === 1280 && v.videoHeight === 720 && near(v.duration, 4, .1), `영상 ${v.videoWidth}x${v.videoHeight} ${v.duration}`);
      await click('[data-action="toggleMenu"]'); await click('[data-menu="m-192"]'); return { info };
    });
    await test('17 작업 설정 저장 → 불러오기', async () => {
      await setSel(.5, 2.5); await act('trim'); await act('project'); const n = blobs.length; await act('saveProject');
      const json = blobs.slice(n).find(b => b.type === 'application/json'); ok(json, '설정 파일 없음');
      await resetEdits(); ok(near(finalSeconds(), 4, .002), '초기화 실패');
      await drop([new File([await json.text()], '작업설정.json', { type: 'application/json' })]);
      ok(near(finalSeconds(), 2, .002), '불러온 길이 ' + finalSeconds()); await resetEdits();
    });
    await test('18 잘못된 파일은 하던 작업을 지우지 않음', async () => {
      const name = $('sourceName').textContent; const out = [];
      for (const [f, t] of [['corrupt.mp3', 'audio/mpeg'], ['video-no-audio.mp4', 'video/mp4']]) { await drop([await fixture(f, t)]); out.push(toastText()); ok(toastError(), f + ' 오류 안내 없음'); ok($('sourceName').textContent === name, f + ' 뒤 작업 사라짐'); }
      return out;
    });
    await test('19 일괄 변환 (손상 파일 1개 포함) · ZIP', async () => {
      await tool('batch'); await input('batchInput', [await fixture('tone.mp3', 'audio/mpeg'), await fixture('corrupt.mp3', 'audio/mpeg'), await fixture('tone-mono-22050.wav', 'audio/wav')]);
      const n0 = blobs.length; await act('batchStart'); const t0 = Date.now(); while (Date.now() - t0 < 120000 && document.querySelectorAll('.batch-row.done,.batch-row.failed').length < 3) await sleep(300); await sleep(500);
      ok(blobs.slice(n0).some(b => b.type === 'application/zip'), '끝나면 ZIP 하나로 바로 저장 안 됨');
      const done = document.querySelectorAll('.batch-row.done').length, failed = document.querySelectorAll('.batch-row.failed').length;
      ok(done === 2 && failed === 1, `완료 ${done} 실패 ${failed}`);
      const n = blobs.length; await act('batchZip'); ok(blobs.slice(n).some(b => b.type === 'application/zip'), 'ZIP 없음');
      await act('batchClear'); await tool('convert'); return { done, failed };
    });
    await test('20 도움말 창 · Esc · 테마', async () => {
      await act('help'); ok($('modal').open, '도움말 안 열림'); document.querySelector('#modal').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); $('modal').close(); await sleep(150);
      const before = document.documentElement.dataset.theme; await act('theme'); ok(document.documentElement.dataset.theme !== before, '테마'); await act('theme');
    });
    await test('21 작업 데이터 지우기', async () => {
      await act('clear'); await act('clearConfirm'); ok(!$('welcome').hidden && $('workbench').hidden, '첫 화면 아님');
    });
    return { passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok), results };
  };
})();
