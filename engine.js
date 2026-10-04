/* Local-only FFmpeg engine. No media or metadata leaves this origin. */
(() => {
  'use strict';
  const BASE = new URL('.', document.currentScript.src);
  class AudioEngine {
    constructor(onStatus = () => {}) {
      this.onStatus = onStatus; this.sources = new Map(); this.pending = new Map();
      this.serial = Promise.resolve(); this.sequence = 0; this.generation = 0; this.worker = null;
    }
    _status(status) { try { this.onStatus(status); } catch (_) {} }
    async _ensure() {
      if (this.worker) return;
      if (location.protocol === 'file:') throw new Error('HTML 더블클릭으로는 처리 도구를 불러올 수 없습니다. 포함된 실행 서버를 이용해 HTTP 주소로 열어 주세요.');
      const generation = this.generation;
      this._status({phase:'loading', message:'처리 도구 준비 중', progress:null});
      const worker = new Worker(new URL('engine-worker.js', BASE)); this.worker = worker;
      worker.onmessage = ({data}) => {
        if (worker !== this.worker) return;
        if (data.status) { this._status(data.status); return; }
        const pending = this.pending.get(data.requestId); if (!pending) return;
        this.pending.delete(data.requestId);
        if (data.error) { if(data.error.fatal){worker.terminate();this.worker=null;} const e = new Error(data.error.message); e.code = data.error.code; e.details = data.error.details; pending.reject(e); }
        else pending.resolve(data.result);
      };
      worker.onerror = () => { if (worker !== this.worker) return; const e = new Error('처리 도구를 불러오지 못했습니다. 사이트의 Worker와 WASM 파일을 확인하거나 새로고침해 주세요.'); for (const p of this.pending.values()) p.reject(e); this.pending.clear(); worker.terminate(); this.worker = null; };
      try {
        await this._request('init');
        if (generation !== this.generation) throw this._cancelError();
        for (const source of this.sources.values()) {
          const bytes = new Uint8Array(await source.file.arrayBuffer());
          if (generation !== this.generation) throw this._cancelError();
          await this._request('restore', {id:source.id, bytes, metadata:source.metadata, track:source.track}, [bytes.buffer]);
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
    analyze(file, track = 0, options = {}) {
      return this._queue(async generation => {
        if (!file || !file.size) throw new Error('빈 파일은 열 수 없습니다. 소리가 담긴 파일을 선택해 주세요.');
        if (file.size > 120000000) throw new Error('한 파일은 120 MB까지 열 수 있습니다. 긴 영상은 먼저 짧게 나누거나 작은 파일로 준비해 주세요.');
        // When the new file replaces the current work, the old sources are released right after it opens.
        const total = options.replacing ? 0 : [...this.sources.values()].reduce((n,s) => n+s.file.size, 0);
        if (total + file.size > 200000000) throw new Error('현재 작업의 원본 총용량이 200 MB를 넘습니다. 새 작업에서 처리하거나 사용하지 않는 파일을 제거해 주세요.');
        const id = `source_${Date.now().toString(36)}_${++this.sequence}`;
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (generation !== this.generation) throw this._cancelError();
        const result = await this._request('analyze', {id,bytes,track:Number(track)||0}, [bytes.buffer]);
        this.sources.set(id,{id,file,track:Number(track)||0,metadata:result.metadata});
        return {...result, originalName:file.name || '녹음.webm', size:file.size};
      });
    }
    render(model, output = {}, options = {}) { return this._queue(() => this._request('render', {model:structuredClone(model),output:{...output},options:{...options}})); }
    decodeResult(bytes, extension = 'bin') {
      return this._queue(() => { const copy = new Uint8Array(bytes); return this._request('decode', {bytes:copy,extension}, [copy.buffer]); });
    }
    extractCopy(sourceId, {start=0,end=null,format=null,metadataMode='remove'}={}) { return this._queue(() => this._request('copy', {sourceId,start,end,format,metadataMode})); }
    removeSource(id) { this.sources.delete(id); if (!this.worker) return Promise.resolve(); return this._queue(() => this._request('remove',{id})); }
    cancel() {
      ++this.generation;
      if (this.worker) this.worker.terminate(); this.worker = null;
      const e = this._cancelError(); for (const p of this.pending.values()) p.reject(e); this.pending.clear(); this.serial = Promise.resolve();
      this._status({phase:'cancelled',message:e.message,progress:null});
    }
    dispose() { this.cancel(); this.sources.clear(); }
  }
  window.AudioEngine = AudioEngine;
})();
