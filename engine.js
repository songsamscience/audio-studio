/* Local-only FFmpeg engine. No media or metadata leaves this origin. */
(() => {
  'use strict';
  const BASE = new URL('.', document.currentScript.src);
  // Decoded sound from the engine: 16-bit interleaved PCM in Blob parts of `partFrames` frames. Only the parts being
  // played become AudioBuffers (a few at a time), so a three-hour recording never has to fit in memory as float.
  class PcmTrack {
    constructor({rate, channels, frames, partFrames, parts, rms = 0, peak = 0}) {
      Object.assign(this, {sampleRate: rate, numberOfChannels: channels, length: frames, partFrames, parts, rms, peak});
      this.duration = frames / rate; this.cache = new Map(); this.loading = new Map();
    }
    partAt(frame) { return Math.max(0, Math.min(this.parts.length - 1, Math.floor(frame / this.partFrames))); }
    cached(index) { const b = this.cache.get(index); if (b) { this.cache.delete(index); this.cache.set(index, b); } return b || null; }
    load(index) {
      const ready = this.cached(index); if (ready) return Promise.resolve(ready);
      if (this.loading.has(index)) return this.loading.get(index);
      const job = this.parts[index].arrayBuffer().then(bytes => {
        const s = new Int16Array(bytes), ch = this.numberOfChannels, n = Math.floor(s.length / ch);
        const buffer = new AudioBuffer({length: Math.max(1, n), numberOfChannels: ch, sampleRate: this.sampleRate});
        for (let c = 0; c < ch; c++) { const d = buffer.getChannelData(c); for (let f = 0, i = c; f < n; f++, i += ch) d[f] = s[i] / 32768; }
        this.cache.set(index, buffer); while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
        return buffer;
      }).finally(() => this.loading.delete(index));
      this.loading.set(index, job); return job;
    }
  }
  const toTrack = pcm => pcm ? new PcmTrack(pcm) : null;
  class AudioEngine {
    // 4 GiB, so camera clips split at the FAT32 limit (4 GiB − 1 byte) still open.
    static MAX_FILE = 4 * 1024 ** 3;
    // The worker reads originals on demand (WORKERFS), so a 4 GB video never has to fit in memory. Up to this many
    // bytes are still copied once, as before, so smaller work survives the original being moved or re-saved.
    static MAX_COPIED = 200000000;
    constructor(onStatus = () => {}) {
      this.onStatus = onStatus; this.sources = new Map(); this.pending = new Map();
      this.serial = Promise.resolve(); this.sequence = 0; this.generation = 0; this.worker = null;
    }
    _status(status) { try { this.onStatus(status); } catch (_) {} }
    async _ensure() {
      if (this.worker) return;
      if (location.protocol === 'file:') throw new Error('HTML 더블클릭으로는 처리 도구를 불러올 수 없습니다. 포함된 실행 서버를 이용해 HTTP 주소로 열어 주세요.');
      const generation = this.generation;
      this._status({phase:'loading', message:'처리 도구 준비 중'});
      const worker = new Worker(new URL('engine-worker.js', BASE)); this.worker = worker;
      worker.onmessage = ({data}) => {
        if (worker !== this.worker) return;
        if (data.status) { this._status(data.status); return; }
        const pending = this.pending.get(data.requestId); if (!pending) return;
        this.pending.delete(data.requestId);
        if (data.error) { if(data.error.fatal){worker.terminate();this.worker=null;} const e = new Error(data.error.message); e.code = data.error.code; e.details = data.error.details; pending.reject(e); }
        else { pending.resolve(data.result); if (data.recycle) { worker.terminate(); this.worker = null; } } // fresh core; sources are restored on the next job
      };
      worker.onerror = () => { if (worker !== this.worker) return; const e = new Error('처리 도구를 불러오지 못했습니다. 사이트의 Worker와 WASM 파일을 확인하거나 새로고침해 주세요.'); for (const p of this.pending.values()) p.reject(e); this.pending.clear(); worker.terminate(); this.worker = null; };
      try {
        await this._request('init');
        if (generation !== this.generation) throw this._cancelError();
        for (const source of this.sources.values()) {
          if (generation !== this.generation) throw this._cancelError();
          await this._request('restore', {id:source.id, file:source.data, metadata:source.metadata, track:source.track});
        }
      } catch (e) { if (this.worker === worker) { worker.terminate(); this.worker = null; } throw e; }
    }
    _cancelError() { const e = new Error('작업이 취소되었습니다. 설정을 유지한 채 다시 시작할 수 있습니다.'); e.code = 'CANCELLED'; return e; }
    _request(type, payload = {}, transfer = []) {
      const requestId = ++this.sequence;
      return new Promise((resolve,reject) => { this.pending.set(requestId, {resolve,reject}); try { this.worker.postMessage({type,requestId,...payload}, transfer); } catch(e) { this.pending.delete(requestId); reject(e); } });
    }
    _queue(fn) {
      const generation = this.generation;
      const promise = this.serial.then(async () => { if (generation !== this.generation) throw this._cancelError(); await this._ensure(); if (generation !== this.generation) throw this._cancelError(); return fn(generation); });
      this.serial = promise.catch(() => {}); return promise;
    }
    capabilities() { return this._queue(() => this._request('capabilities')); }
    // options: replacing (the file replaces the current work), pcmRate (playback rate), pcm:false (only measure).
    analyze(file, track = 0, options = {}) {
      return this._queue(async generation => {
        if (!file || !file.size) throw new Error('빈 파일은 열 수 없습니다. 소리가 담긴 파일을 선택해 주세요.');
        if (file.size > AudioEngine.MAX_FILE) throw new Error('한 파일은 4 GB까지 열 수 있습니다. 더 큰 영상은 먼저 나눠서 준비해 주세요.');
        // When the new file replaces the current work, the old sources are released right after it opens.
        const copiedBytes = options.replacing ? 0 : [...this.sources.values()].reduce((n,s) => n+(s.copied?s.data.size:0), 0);
        const copied = copiedBytes + file.size <= AudioEngine.MAX_COPIED;
        const data = copied ? new Blob([await file.arrayBuffer()], {type:file.type}) : file;
        if (generation !== this.generation) throw this._cancelError();
        const id = `source_${Date.now().toString(36)}_${++this.sequence}`;
        const result = await this._request('analyze', {id,file:data,track:Number(track)||0,pcmRate:options.pcmRate,pcm:options.pcm});
        this.sources.set(id,{id,data,copied,track:Number(track)||0,metadata:result.metadata});
        return {...result, pcm:toTrack(result.pcm), originalName:file.name || '녹음.webm', size:file.size};
      });
    }
    // Result: {blob, size, mime, extension, metadata, summary, pcm}; with options.preview only {pcm, metadata, summary},
    // with options.analysis only {envelope}. options.listen adds the decoded result (pcm) for 최종 파일 듣기.
    async render(model, output = {}, options = {}) {
      const result = await this._queue(() => this._request('render', {model:structuredClone(model),output:{...output},options:{...options}}));
      return {...result, pcm:toTrack(result.pcm)};
    }
    async extractCopy(sourceId, {start=0,end=null,format=null,metadataMode='remove',listen=false,pcmRate=48000}={}) {
      const result = await this._queue(() => this._request('copy', {sourceId,start,end,format,metadataMode,listen,pcmRate}));
      return {...result, pcm:toTrack(result.pcm)};
    }
    removeSource(id) { this.sources.delete(id); if (!this.worker) return Promise.resolve(); return this._queue(() => this._request('remove',{id})); }
    cancel() {
      ++this.generation;
      if (this.worker) this.worker.terminate(); this.worker = null;
      const e = this._cancelError(); for (const p of this.pending.values()) p.reject(e); this.pending.clear(); this.serial = Promise.resolve();
      this._status({phase:'cancelled',message:e.message});
    }
    dispose() { this.cancel(); this.sources.clear(); }
  }
  window.AudioEngine = AudioEngine;
})();
