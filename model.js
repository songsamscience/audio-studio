/* Song science audio studio: pure, non-destructive edit decisions. */
(function (global) {
  'use strict';

  const VERSION = 1;
  const MAX_PROJECT_BYTES = 1024 * 1024;
  const EPS = 1e-7;
  const clone = value => JSON.parse(JSON.stringify(value));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const fail = message => { throw new Error(message); };
  const number = (value, min, max, label, integer = false) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${label} 값이 올바르지 않습니다.`);
    return value;
  };
  const str = (value, max, label) => {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(`${label} 값이 올바르지 않습니다.`);
    return value;
  };
  const bool = (value, label) => {
    if (typeof value !== 'boolean') fail(`${label} 값이 올바르지 않습니다.`);
    return value;
  };
  const object = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 형식이 올바르지 않습니다.`);
    return value;
  };
  const enumValue = (value, values, label) => {
    if (!values.includes(value)) fail(`${label} 값이 지원되지 않습니다.`);
    return value;
  };
  // libvorbis nominal bitrate per quality step for 44.1 kHz stereo; an estimate only.
  const OGG_KBPS = [64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 500];
  // Every output the engine can write. Video formats carry a still or animated picture next to the sound.
  const OUTPUT_FORMATS = ['mp3', 'm4a', 'aac', 'm4r', 'ogg', 'opus', 'webm', 'wma', 'mp2', 'ac3', 'wav', 'flac', 'alac', 'aiff', 'caf', 'au', 'mp4', 'webmv'];
  const VIDEO_FORMATS = ['mp4', 'webmv'];
  const PCM_FORMATS = ['wav', 'aiff', 'caf', 'au'];
  const VIDEO_SIZES = ['1280x720', '1920x1080', '1080x1080', '1080x1920'];
  const CHANNEL_MODES = ['keep', 'left', 'right', 'swap'];
  const effectsDefault = () => ({ gainDb: 0, noise: 'off', highpass: false, clarity: 0, eqLow: 0, eqMid: 0, eqHigh: 0, normalize: false, compressor: false, limiter: true, channelMode: 'keep' });
  const sourceList = sources => sources instanceof Map ? [...sources.values()] : Array.isArray(sources) ? sources : Object.values(sources || {});
  const sourceDuration = source => source.metadata?.duration ?? source.buffer?.duration ?? source.duration;

  function create(source) {
    if (!source || typeof source.id !== 'string') fail('먼저 원본 음원을 선택해 주세요.');
    const end = number(sourceDuration(source), 0.000001, 86400, '원본 길이');
    return {
      clips: [{ sourceId: source.id, start: 0, end, gain: 1, muted: false }],
      selection: { start: 0, end }, bookmarks: [], fadeIn: 0, fadeOut: 0, crossfade: 0,
      effects: effectsDefault(), speed: 1, pitch: 0, repeat: 1, gap: 0, padStart: 0, padEnd: 0, edgeFade: false, reverse: false, mix: null
    };
  }

  // Editable coordinates are the concatenated clip timeline. A crossfade is a
  // rendering setting, so edits remain precise even when speed/repeat changes.
  function timeline(model, crossed = false) {
    let cursor = 0;
    return model.clips.map((clip, index) => {
      const len = clip.end - clip.start;
      const prev = model.clips[index - 1];
      const overlap = crossed && prev ? Math.min(model.crossfade || 0, (prev.end - prev.start) / 2, len / 2) : 0;
      const start = cursor - overlap;
      cursor = start + len;
      return { clip, index, start, end: cursor, overlap };
    });
  }
  const baseDuration = model => model.clips.reduce((sum, c) => sum + c.end - c.start, 0);
  const arrangementDuration = model => timeline(model, true).at(-1)?.end || 0;
  function voiceDuration(model) {
    return (arrangementDuration(model) * model.repeat + Math.max(0, model.repeat - 1) * model.gap) / model.speed + model.padStart + model.padEnd;
  }
  function duration(model) {
    const voice = voiceDuration(model);
    const mix = model.mix;
    if (!mix) return voice;
    const endVoice = voice + (mix.voiceOffset || 0);
    const originalBg = Math.max(0, mix.end - mix.start);
    const bgLength = mix.loop ? Math.max(originalBg, endVoice - mix.offset) : originalBg;
    return mix.lengthMode === 'longest' ? Math.max(endVoice, bgLength + mix.offset) : endVoice;
  }
  function checkedRange(model, args = {}) {
    const limit = baseDuration(model);
    const start = args.start ?? model.selection.start;
    const end = args.end ?? model.selection.end;
    number(start, 0, limit, '선택 시작'); number(end, 0, limit, '선택 끝');
    if (end - start < 0.000001) fail('선택 끝은 시작보다 뒤여야 합니다.');
    return { start, end };
  }
  function sliceClips(model, start, end) {
    const result = [];
    for (const item of timeline(model)) {
      const from = Math.max(start, item.start), to = Math.min(end, item.end);
      if (to - from > EPS) result.push({ ...item.clip, start: item.clip.start + from - item.start, end: item.clip.start + to - item.start });
    }
    return result;
  }
  function normalizeAfterEdit(model) {
    const len = baseDuration(model);
    if (len < 0.000001 || !model.clips.length) fail('음원이 0초가 되는 편집은 적용할 수 없습니다.');
    if (model.clips.length > 200) fail('편집 구간은 200개까지 사용할 수 있습니다.');
    model.selection.start = clamp(model.selection.start, 0, len);
    model.selection.end = clamp(model.selection.end, model.selection.start, len);
    if (model.selection.end - model.selection.start < 0.000001) model.selection = { start: 0, end: len };
    model.bookmarks = model.bookmarks.filter(b => b.time <= len + EPS);
    model.fadeIn = Math.min(model.fadeIn, voiceDuration(model));
    model.fadeOut = Math.min(model.fadeOut, voiceDuration(model));
    return model;
  }
  function shiftBookmarks(model, start, end, inserted = 0) {
    model.bookmarks = model.bookmarks.filter(b => b.time < start || b.time >= end).map(b => ({ ...b, time: b.time >= end ? b.time - (end - start) + inserted : b.time }));
  }
  function edit(input, operation, args = {}) {
    const m = clone(input);
    const len = baseDuration(m);
    const op = ({ 'remove-clip': 'removeClip', 'duplicate-clip': 'duplicateClip', 'insert-silence': 'insertSilence', 'split-fixed': 'splitFixed', 'remove-ranges': 'removeRanges' })[operation] || operation;
    if (['trim', 'delete', 'silence', 'gain', 'duplicate'].includes(op)) {
      const { start, end } = checkedRange(m, args);
      const selected = sliceClips(m, start, end);
      if (op === 'trim') {
        m.clips = selected;
        m.bookmarks = m.bookmarks.filter(b => b.time >= start && b.time <= end).map(b => ({ ...b, time: b.time - start }));
        m.selection = { start: 0, end: end - start };
      } else if (op === 'delete') {
        if (end - start >= len - EPS) fail('전체를 삭제할 수 없습니다. 남길 구간이 필요합니다.');
        m.clips = [...sliceClips(m, 0, start), ...sliceClips(m, end, len)];
        shiftBookmarks(m, start, end);
        m.selection = { start: 0, end: len - (end - start) };
      } else if (op === 'duplicate') {
        const at = number(args.at ?? end, 0, len, '삽입 위치');
        m.clips = [...sliceClips(m, 0, at), ...selected, ...sliceClips(m, at, len)];
        m.bookmarks = m.bookmarks.map(b => ({ ...b, time: b.time >= at ? b.time + end - start : b.time }));
        m.selection = { start: at, end: at + end - start };
      } else {
        if (op === 'silence') selected.forEach(c => { c.muted = true; });
        else {
          const multiplier = args.db !== undefined || args.gainDb !== undefined ? Math.pow(10, number(args.db ?? args.gainDb, -60, 24, '선택 음량') / 20) : number(args.gain ?? 1, 0, 8, '선택 음량');
          selected.forEach(c => { c.gain = clamp(c.gain * multiplier, 0, 8); });
        }
        m.clips = [...sliceClips(m, 0, start), ...selected, ...sliceClips(m, end, len)];
        m.selection = { start, end };
      }
      m.crossfade = 0;
    } else if (op === 'selection') {
      m.selection = checkedRange(m, args);
    } else if (op === 'split') {
      const time = number(args.time ?? m.selection.start, 0, len, '분할 위치');
      if (time <= EPS || time >= len - EPS) fail('음원 안쪽의 위치에서 분할해 주세요.');
      m.clips = [...sliceClips(m, 0, time), ...sliceClips(m, time, len)];
      m.crossfade = 0;
    } else if (op === 'splitFixed') {
      const seconds = number(args.seconds ?? args.length, 0.01, 86400, '분할 길이');
      if (Math.ceil(len / seconds) > 200) fail('구간이 너무 많습니다. 더 긴 분할 길이를 사용해 주세요.');
      m.clips = [];
      for (let at = 0; at < len - EPS; at += seconds) m.clips.push(...sliceClips(input, at, Math.min(at + seconds, len)));
      m.crossfade = 0;
    } else if (op === 'removeClip' || op === 'duplicateClip') {
      const index = number(args.index, 0, m.clips.length - 1, '구간 번호', true);
      const item = timeline(m)[index];
      if (op === 'removeClip') {
        if (m.clips.length === 1) fail('마지막 구간은 삭제할 수 없습니다.');
        m.clips.splice(index, 1); shiftBookmarks(m, item.start, item.end);
      } else {
        m.clips.splice(index + 1, 0, clone(m.clips[index]));
        m.bookmarks = m.bookmarks.map(b => ({ ...b, time: b.time >= item.end ? b.time + item.end - item.start : b.time }));
      }
      m.crossfade = 0;
    } else if (op === 'reorder') {
      const from = number(args.from, 0, m.clips.length - 1, '이전 구간 번호', true);
      const to = number(args.to, 0, m.clips.length - 1, '이동할 구간 번호', true);
      // Bookmarks are attached to their clip when the order changes.
      const before = timeline(m);
      const attached = m.bookmarks.map(b => ({ ...b, oldIndex: before.findIndex((t, i) => b.time >= t.start && (b.time < t.end || i === before.length - 1)), local: 0 }));
      attached.forEach(b => { b.local = b.time - before[b.oldIndex].start; });
      const order = m.clips.map((_, i) => i); order.splice(to, 0, order.splice(from, 1)[0]);
      m.clips = order.map(i => clone(input.clips[i]));
      const after = timeline(m);
      m.bookmarks = attached.map(({ oldIndex, local, ...b }) => ({ ...b, time: after[order.indexOf(oldIndex)].start + local }));
      m.crossfade = 0;
    } else if (op === 'append') {
      const sourceId = args.source?.id ?? args.sourceId;
      str(sourceId, 200, '원본 식별자');
      const end = number(args.source ? sourceDuration(args.source) : args.duration, 0.000001, 86400, '추가 음원 길이');
      m.clips.push({ sourceId, start: 0, end, gain: 1, muted: false });
      m.selection = { start: len, end: len + end };
    } else if (op === 'insertSilence') {
      const time = number(args.time ?? m.selection.end, 0, len, '무음 삽입 위치');
      const length = number(args.length ?? args.seconds, 0.001, 600, '무음 길이');
      m.clips = [...sliceClips(m, 0, time), { sourceId: null, start: 0, end: length, gain: 1, muted: true }, ...sliceClips(m, time, len)];
      m.bookmarks = m.bookmarks.map(b => ({ ...b, time: b.time >= time ? b.time + length : b.time }));
      m.selection = { start: time, end: time + length }; m.crossfade = 0;
    } else if (op === 'removeRanges') {
      if (!Array.isArray(args.ranges)) fail('제거할 무음 구간을 먼저 확인해 주세요.');
      const sorted = args.ranges.map(r => checkedRange(m, r)).sort((a, b) => a.start - b.start);
      const merged = [];
      for (const r of sorted) {
        if (merged.length && r.start <= merged.at(-1).end) merged.at(-1).end = Math.max(merged.at(-1).end, r.end);
        else merged.push(r);
      }
      let result = m;
      for (const r of merged.reverse()) result = edit(result, 'delete', r);
      return result;
    } else if (op === 'bookmark') {
      if (m.bookmarks.length >= 1000) fail('북마크는 1,000개까지 사용할 수 있습니다.');
      const time = number(args.time ?? m.selection.start, 0, len, '북마크 위치');
      const name = str(args.name || `구간 ${m.bookmarks.length + 1}`, 100, '북마크 이름');
      let n = 1; while (m.bookmarks.some(b => b.id === `bookmark-${n}`)) n++;
      m.bookmarks.push({ id: `bookmark-${n}`, name, time }); m.bookmarks.sort((a, b) => a.time - b.time);
    } else if (op === 'removeBookmark' || op === 'renameBookmark') {
      const index = args.id !== undefined ? m.bookmarks.findIndex(b => b.id === args.id) : args.index;
      number(index, 0, m.bookmarks.length - 1, '북마크 번호', true);
      if (op === 'removeBookmark') m.bookmarks.splice(index, 1);
      else m.bookmarks[index].name = str(args.name, 100, '북마크 이름');
    } else if (op === 'settings') {
      const patch = args.patch || args;
      for (const key of ['fadeIn', 'fadeOut', 'crossfade', 'speed', 'pitch', 'repeat', 'gap', 'padStart', 'padEnd', 'edgeFade', 'reverse', 'mix']) if (Object.hasOwn(patch, key)) m[key] = clone(patch[key]);
      if (patch.effects) m.effects = { ...m.effects, ...patch.effects };
      return validateModel(normalizeAfterEdit(m));
    } else if (op === 'reset') return create(args.source);
    else fail('지원하지 않는 편집 도구입니다.');
    return normalizeAfterEdit(m);
  }

  class History {
    constructor(initial, limit = 100) { this.limit = limit; this.reset(initial); }
    get current() { return clone(this.states[this.position].model); }
    get canUndo() { return this.position > 0; }
    get canRedo() { return this.position < this.states.length - 1; }
    get entries() { return this.states.map((s, index) => ({ label: s.label, active: index === this.position, index })); }
    updateSelection(start, end) {
      const current = this.states[this.position].model;
      current.selection = checkedRange(current, { start, end });
      return this.current;
    }
    commit(next, label = '설정 변경') {
      if (JSON.stringify(next) === JSON.stringify(this.states[this.position].model)) return this.current;
      this.states.splice(this.position + 1);
      this.states.push({ model: clone(next), label: String(label) });
      if (this.states.length > this.limit + 1) this.states.shift();
      this.position = this.states.length - 1; return this.current;
    }
    undo() { if (this.canUndo) this.position--; return this.current; }
    redo() { if (this.canRedo) this.position++; return this.current; }
    reset(initial) { this.states = [{ model: clone(initial), label: '원본 불러오기' }]; this.position = 0; return this.current; }
  }

  // This is a measured RMS silence detector, not speech recognition. The loudest
  // channel determines silence, protecting a quiet channel beside speech.
  function detectSilence(buffer, options = {}) {
    if (!buffer || !buffer.numberOfChannels || !buffer.length) fail('분석할 음원 데이터가 없습니다.');
    const thresholdDb = number(options.thresholdDb ?? -42, -96, -6, '무음 기준');
    const minDuration = number(options.minDuration ?? 0.6, 0.02, 120, '최소 무음 길이');
    const padding = number(options.padding ?? 0.08, 0, 10, '남길 여백');
    const rate = buffer.sampleRate, step = Math.max(1, Math.round(rate * 0.01));
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const threshold = Math.pow(10, thresholdDb / 20), ranges = [];
    let start = null;
    const total = buffer.length / rate;
    function finish(end) {
      if (start === null) return;
      if (end - start >= minDuration - EPS) {
        const edgeStart = start < EPS, edgeEnd = end >= total - EPS;
        if (!options.edgesOnly || edgeStart || edgeEnd) {
          const from = start + (edgeStart ? 0 : padding), to = end - (edgeEnd ? 0 : padding);
          if (to - from > EPS) ranges.push({ start: from, end: to, duration: to - from });
        }
      }
      start = null;
    }
    for (let at = 0; at < buffer.length; at += step) {
      const end = Math.min(at + step, buffer.length);
      let peakRms = 0;
      for (const ch of channels) {
        let power = 0;
        for (let i = at; i < end; i++) power += ch[i] * ch[i];
        peakRms = Math.max(peakRms, Math.sqrt(power / (end - at)));
      }
      if (peakRms <= threshold) { if (start === null) start = at / rate; }
      else finish(at / rate);
    }
    finish(total); return ranges;
  }

  // A reversed or mixed result has no one-to-one time with the edit timeline.
  function mapTime(model, outputTime) {
    if (!Number.isFinite(outputTime) || outputTime < 0 || outputTime > duration(model) || model.mix || model.reverse) return null;
    let t = (outputTime - model.padStart) * model.speed;
    const len = arrangementDuration(model), stride = len + model.gap;
    if (t < 0 || t >= len * model.repeat + model.gap * (model.repeat - 1)) return null;
    const repeatIndex = Math.min(model.repeat - 1, Math.floor(t / stride));
    t -= repeatIndex * stride;
    if (t >= len) return null;
    const hits = timeline(model, true).filter(item => t >= item.start && t < item.end);
    if (hits.length !== 1 || hits[0].clip.sourceId === null || hits[0].clip.muted) return null;
    const item = hits[0];
    return { sourceId: item.clip.sourceId, time: item.clip.start + t - item.start, clipIndex: item.index, repeatIndex };
  }
  function reverseMapTime(model, sourceId, sourceTime, nearTime = 0) {
    if (model.mix || model.reverse || !Number.isFinite(sourceTime)) return null;
    const candidates = [], len = arrangementDuration(model);
    for (const item of timeline(model, true)) {
      if (item.clip.sourceId !== sourceId || item.clip.muted || sourceTime < item.clip.start || sourceTime >= item.clip.end) continue;
      for (let repeat = 0; repeat < model.repeat; repeat++) {
        const output = model.padStart + (item.start + sourceTime - item.clip.start + repeat * (len + model.gap)) / model.speed;
        const mapped = mapTime(model, output);
        if (mapped && mapped.clipIndex === item.index) candidates.push(output);
      }
    }
    return candidates.length ? candidates.sort((a, b) => Math.abs(a - nearTime) - Math.abs(b - nearTime))[0] : null;
  }

  function validateModel(raw, sources) {
    object(raw, '편집 설정');
    if (!Array.isArray(raw.clips) || !raw.clips.length || raw.clips.length > 200) fail('편집 구간 목록이 올바르지 않습니다.');
    const known = sources ? new Map(sourceList(sources).map(s => [s.id, s])) : null;
    const clips = raw.clips.map(c => {
      object(c, '편집 구간');
      const sourceId = c.sourceId === null ? null : str(c.sourceId, 200, '원본 식별자');
      const start = number(c.start, 0, 86400, '구간 시작'), end = number(c.end, 0.000001, 86400, '구간 끝');
      if (end <= start || sourceId === '') fail('편집 구간의 길이가 올바르지 않습니다.');
      if (known && sourceId !== null) {
        if (!known.has(sourceId)) fail('이 프로젝트에 필요한 원본 음원을 모두 선택해 주세요.');
        if (end > sourceDuration(known.get(sourceId)) + 0.002) fail('편집 구간이 원본 음원의 길이를 벗어납니다.');
      }
      return { sourceId, start, end, gain: number(c.gain, 0, 8, '구간 음량'), muted: sourceId === null ? true : bool(c.muted, '구간 음소거') };
    });
    const m = { clips, selection: { start: 0, end: baseDuration({ clips }) } };
    if (baseDuration(m) > 86400) fail('편집 길이는 24시간 이내로 설정해 주세요.');
    object(raw.selection, '선택 구간');
    m.selection = checkedRange(m, raw.selection);
    for (const [key, min, max, integer] of [['speed', 0.5, 2], ['pitch', -12, 12], ['repeat', 1, 20, true], ['gap', 0, 600], ['padStart', 0, 600], ['padEnd', 0, 600], ['fadeIn', 0, 600], ['fadeOut', 0, 600], ['crossfade', 0, 10]]) m[key] = number(raw[key], min, max, key, integer);
    m.edgeFade = raw.edgeFade === undefined ? false : bool(raw.edgeFade, '경계의 짧은 페이드');
    m.reverse = raw.reverse === undefined ? false : bool(raw.reverse, '거꾸로 재생');
    const fx = object(raw.effects, '소리 보정');
    m.effects = {
      gainDb: number(fx.gainDb, -60, 24, '전체 음량'), noise: enumValue(fx.noise, ['off', 'light', 'medium', 'strong'], '잡음 감소'),
      highpass: bool(fx.highpass, '저음 줄이기'), clarity: number(fx.clarity, 0, 12, '말소리 선명도'),
      eqLow: number(fx.eqLow, -12, 12, '저음'), eqMid: number(fx.eqMid, -12, 12, '중음'), eqHigh: number(fx.eqHigh, -12, 12, '고음'),
      normalize: bool(fx.normalize, '음량 균일화'), compressor: bool(fx.compressor, '컴프레서'), limiter: bool(fx.limiter, '리미터'),
      channelMode: enumValue(fx.channelMode === undefined ? 'keep' : fx.channelMode, CHANNEL_MODES, '채널 처리')
    };
    if (!Array.isArray(raw.bookmarks) || raw.bookmarks.length > 1000) fail('북마크 목록이 올바르지 않습니다.');
    const ids = new Set();
    m.bookmarks = raw.bookmarks.map(b => {
      object(b, '북마크'); const id = str(b.id, 200, '북마크 식별자');
      if (ids.has(id)) fail('북마크 식별자가 중복되었습니다.'); ids.add(id);
      return { id, name: str(b.name, 100, '북마크 이름'), time: number(b.time, 0, baseDuration(m), '북마크 위치') };
    }).sort((a, b) => a.time - b.time);
    m.mix = null;
    if (raw.mix !== null && raw.mix !== undefined) {
      const mix = object(raw.mix, '혼합 설정');
      m.mix = { sourceId: str(mix.sourceId, 200, '배경음 식별자'), lengthMode: enumValue(mix.lengthMode, ['voice', 'longest'], '혼합 길이') };
      for (const [key, min, max] of [['start', 0, 86400], ['end', 0.000001, 86400], ['offset', 0, 600], ['gainDb', -60, 24], ['duckThreshold', -60, -6], ['duckAmount', 0, 30], ['duckRelease', 0.05, 5], ['fadeIn', 0, 600], ['fadeOut', 0, 600], ['voiceGainDb', -60, 24], ['voiceOffset', 0, 600]]) m.mix[key] = number(mix[key], min, max, key);
      for (const key of ['loop', 'duck', 'muted', 'solo', 'voiceMuted']) m.mix[key] = bool(mix[key], key);
      if (mix.end <= mix.start) fail('배경음의 시작과 끝을 확인해 주세요.');
      if (known && (!known.has(mix.sourceId) || mix.end > sourceDuration(known.get(mix.sourceId)) + 0.002)) fail('프로젝트의 배경음과 선택한 원본이 일치하지 않습니다.');
    }
    if (duration(m) > 86400) fail('최종 음원은 24시간 이내로 설정해 주세요.');
    if (m.fadeIn > voiceDuration(m) + EPS || m.fadeOut > voiceDuration(m) + EPS) fail('페이드 길이가 음원 길이를 넘습니다.');
    return m;
  }

  function validateOutput(raw) {
    object(raw, '출력 설정');
    const output = {
      format: enumValue(raw.format ?? 'mp3', OUTPUT_FORMATS, '출력 형식'),
      bitrate: number(raw.bitrate ?? 192, 6, 640, '비트레이트', true),
      sampleRate: number(raw.sampleRate ?? 0, 0, 192000, '샘플레이트', true),
      channels: number(raw.channels ?? 0, 0, 8, '출력 채널', true),
      bitDepth: enumValue(raw.bitDepth ?? 16, [8, 16, 24, 32], '비트 깊이'),
      vbr: bool(raw.vbr ?? false, '가변 비트레이트'),
      quality: number(raw.quality ?? 3, 0, 9, 'VBR 품질', true),
      compression: number(raw.compression ?? 5, 0, 12, 'FLAC 압축 수준', true),
      oggQuality: number(raw.oggQuality ?? 4, 0, 10, 'OGG 음질', true),
      metadataMode: enumValue(raw.metadataMode ?? 'remove', ['remove', 'keep', 'edit'], '태그 처리'),
      title: str(raw.title ?? '', 500, '제목'), artist: str(raw.artist ?? '', 500, '제작자'), album: str(raw.album ?? '', 500, '앨범'),
      // Video outputs: the picture is drawn in the browser from these values plus an optional picture file that is not saved here.
      videoStyle: enumValue(raw.videoStyle ?? 'cover', ['cover', 'waves'], '영상 모양'),
      videoSize: enumValue(raw.videoSize ?? '1280x720', VIDEO_SIZES, '영상 크기'),
      videoColor: str(raw.videoColor ?? '#49301f', 7, '영상 바탕색'),
      videoTitle: str(raw.videoTitle ?? '', 120, '영상 제목'), videoSubtitle: str(raw.videoSubtitle ?? '', 120, '영상 부제목')
    };
    if (!/^#[0-9a-fA-F]{6}$/.test(output.videoColor)) fail('영상 바탕색 값이 올바르지 않습니다.');
    if ((output.bitDepth === 8 || output.bitDepth === 32) && output.format !== 'wav') fail('8비트와 32비트(float)는 WAV에서만 선택할 수 있습니다.');
    if (output.sampleRate > 0 && output.sampleRate < 8000) fail('샘플레이트는 원본 유지 또는 8 kHz 이상이어야 합니다.');
    if (output.format === 'mp3' && ![64, 96, 128, 160, 192, 256, 320].includes(output.bitrate)) fail('지원되는 MP3 비트레이트를 선택해 주세요.');
    return output;
  }
  function exportProject(model, output, sources) {
    const validated = validateModel(model, sources);
    const used = new Set(validated.clips.map(c => c.sourceId).filter(Boolean));
    if (validated.mix) used.add(validated.mix.sourceId);
    const refs = sourceList(sources).filter(s => used.has(s.id)).map(s => ({
      id: str(s.id, 200, '원본 식별자'), name: str(s.originalName ?? s.name ?? s.file?.name, 500, '원본 이름'),
      size: number(s.size ?? s.file?.size, 0, Number.MAX_SAFE_INTEGER, '원본 크기', true), duration: number(sourceDuration(s), 0.000001, 86400, '원본 길이'),
      sampleRate: number(s.metadata?.sampleRate ?? s.buffer?.sampleRate ?? 44100, 1000, 384000, '원본 샘플레이트'), channels: number(s.metadata?.channels ?? s.buffer?.numberOfChannels ?? 1, 1, 64, '원본 채널', true),
      ...(Number.isInteger(s.track) ? { track: number(s.track, 0, 64, '오디오 트랙', true) } : {})
    }));
    if (refs.length !== used.size) fail('프로젝트에 필요한 원본 정보가 없습니다.');
    const result = JSON.stringify({ app: 'song-science-audio-studio', schemaVersion: VERSION, notice: '이 파일은 편집 설정만 담고 있습니다. 다시 열 때 원본 음원이 필요합니다.', sources: refs, model: validated, output: validateOutput(output) }, null, 2);
    if (new TextEncoder().encode(result).length > MAX_PROJECT_BYTES) fail('프로젝트 파일은 1 MB까지 저장할 수 있습니다.');
    return result;
  }
  function importProject(json, sources) {
    if (typeof json !== 'string' || new TextEncoder().encode(json).length > MAX_PROJECT_BYTES) fail('프로젝트 파일은 1 MB 이하의 JSON이어야 합니다.');
    let project;
    try { project = JSON.parse(json); } catch { fail('프로젝트 JSON을 읽을 수 없습니다. 파일 내용을 확인해 주세요.'); }
    object(project, '프로젝트');
    if (project.schemaVersion !== VERSION || project.app !== 'song-science-audio-studio') fail('지원하지 않는 프로젝트 버전입니다.');
    if (!Array.isArray(project.sources) || project.sources.length > 100) fail('프로젝트의 원본 목록이 올바르지 않습니다.');
    const originals = sourceList(sources), replacements = new Map(), oldIds = new Set(), matched = new Set();
    for (const r of project.sources) {
      object(r, '원본 정보'); const id = str(r.id, 200, '원본 식별자');
      if (oldIds.has(id)) fail('프로젝트의 원본 식별자가 중복되었습니다.'); oldIds.add(id);
      str(r.name, 500, '원본 이름'); number(r.size, 0, Number.MAX_SAFE_INTEGER, '원본 크기', true); number(r.duration, 0.000001, 86400, '원본 길이');
      number(r.sampleRate, 1000, 384000, '원본 샘플레이트'); number(r.channels, 1, 64, '원본 채널', true);
      if (r.track !== undefined) number(r.track, 0, 64, '오디오 트랙', true);
      // Older project files have no track; when both sides know it, a different video track is not the same source.
      const sameTrack = s => r.track === undefined || !Number.isInteger(s.track) || s.track === r.track;
      const candidates = originals.filter(s => (s.originalName ?? s.name ?? s.file?.name) === r.name && (s.size ?? s.file?.size) === r.size && Math.abs(sourceDuration(s) - r.duration) <= 0.01 && (s.metadata?.sampleRate ?? s.buffer?.sampleRate) === r.sampleRate && (s.metadata?.channels ?? s.buffer?.numberOfChannels) === r.channels && sameTrack(s));
      const source = candidates.find(s => s.id === id && !matched.has(s.id)) || candidates.find(s => !matched.has(s.id));
      if (!source) fail(`원본 음원이 일치하지 않습니다: ${r.name}. 같은 파일을 먼저 선택해 주세요.`);
      replacements.set(id, source.id); matched.add(source.id);
    }
    const raw = object(project.model, '편집 설정');
    if (!Array.isArray(raw.clips)) fail('편집 구간 목록이 올바르지 않습니다.');
    // Rebuild only validated primitive fields; never evaluate or spread unknown keys.
    for (const c of raw.clips) {
      object(c, '편집 구간');
      if (c.sourceId !== null && !replacements.has(c.sourceId)) fail('프로젝트 원본 연결 정보가 잘못되었습니다.');
      if (c.sourceId !== null) c.sourceId = replacements.get(c.sourceId);
    }
    if (raw.mix) {
      object(raw.mix, '혼합 설정');
      if (!replacements.has(raw.mix.sourceId)) fail('프로젝트 배경음 연결 정보가 잘못되었습니다.');
      raw.mix.sourceId = replacements.get(raw.mix.sourceId);
    }
    return { model: validateModel(raw, originals), output: validateOutput(project.output) };
  }

  function safeFilename(name, extension, used) {
    let clean = String(name || '송쌤과학_음원').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 180) || '음원';
    let ext = extension ? String(extension).replace(/^\./, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : '';
    if (ext) clean = clean.replace(/\.[^. ]{1,8}$/, '');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = `_${clean}`;
    const suffix = ext ? `.${ext}` : '', original = clean;
    const has = candidate => used && (typeof used.has === 'function' ? used.has(candidate) : used.includes(candidate));
    let result = clean + suffix, count = 2;
    while (has(result)) result = `${original}_${count++}${suffix}`;
    if (used && typeof used.add === 'function') used.add(result);
    return result;
  }
  function estimateBytes(model, output, sources = []) {
    const original = sourceList(sources).find(s => s.id === model.clips.find(c => c.sourceId)?.sourceId);
    const sampleRate = Number(output.sampleRate) || original?.metadata?.sampleRate || 48000;
    const channels = output.channels === 'mono' ? 1 : output.channels === 'stereo' ? 2 : Number(output.channels) || original?.metadata?.channels || 2;
    const seconds = duration(model), format = output.format || 'mp3';
    const pcm = seconds * sampleRate * (output.bitDepth || 16) * channels / 8;
    const vorbis = seconds * OGG_KBPS[clamp(Math.round(output.oggQuality ?? 4), 0, 10)] * (channels === 1 ? 0.6 : 1) * 1000 / 8 + 4096;
    const coded = seconds * (Number(output.bitrate) || 192) * 1000 / 8 + 1024;
    if (PCM_FORMATS.includes(format)) return Math.ceil(pcm + 44);
    if (format === 'flac' || format === 'alac') return Math.ceil(pcm * 0.6);
    if (format === 'ogg') return Math.ceil(vorbis);
    if (VIDEO_FORMATS.includes(format)) {
      // Measured on the pinned core: a still picture at 1 fps costs little; animated waves at 6 fps cost about 1.6 Mbps at 720p.
      const [w, h] = (VIDEO_SIZES.includes(output.videoSize) ? output.videoSize : '1280x720').split('x').map(Number);
      const pixelRatio = w * h / (1280 * 720);
      const videoKbps = (output.videoStyle === 'waves' ? 1600 : 120) * pixelRatio;
      return Math.ceil(seconds * videoKbps * 1000 / 8 + (format === 'webmv' ? vorbis : coded) + 8192);
    }
    return Math.ceil(coded);
  }
  function suggestBitrate(model, targetMB) {
    number(Number(targetMB), 0.001, 100000, '목표 용량');
    const max = Math.max(0, (Number(targetMB) * 1000000 - 4096) * 8 / duration(model) / 1000);
    const choices = [64, 96, 128, 160, 192, 256, 320];
    const bitrate = choices.filter(n => n <= max).at(-1) || 64;
    return { bitrate, possible: max >= 64, estimatedBytes: Math.ceil(duration(model) * bitrate * 125 + 4096) };
  }
  function bookmarkSegments(model) {
    const length = baseDuration(model), sorted = model.bookmarks.slice().sort((a, b) => a.time - b.time);
    if (!sorted.length || sorted[0].time > EPS) sorted.unshift({ time: 0, name: '시작' });
    return sorted.map((b, i) => ({ name: b.name, start: b.time, end: sorted[i + 1]?.time ?? length })).filter(r => r.end - r.start > EPS);
  }
  global.StudioModel = Object.freeze({ VERSION, MAX_PROJECT_BYTES, OUTPUT_FORMATS, VIDEO_FORMATS, PCM_FORMATS, VIDEO_SIZES, CHANNEL_MODES, create, defaultModel: create, clone, effectsDefault, timeline, baseDuration, arrangementDuration, voiceDuration, duration, checkedRange, sliceClips, edit, History, detectSilence, mapTime, reverseMapTime, validateModel, validateOutput, exportProject, importProject, safeFilename, estimateBytes, suggestBitrate, bookmarkSegments });
})(typeof window === 'undefined' ? globalThis : window);
