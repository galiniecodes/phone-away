/** Local object detection plus a time-based, once-per-incident alert gate. */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class LocalDetector {
  constructor() {
    this.loading = null;
    this.worker = null;
    this.workerReady = false;
    this.requestId = 0;
    this.pending = new Map();
    this.detecting = false;
    this.backend = '';
  }

  async load(onProgress = () => {}) {
    if (this.workerReady) return this;
    if (this.loading) return this.loading;
    this.loading = this._load(onProgress);
    try { return await this.loading; }
    finally { this.loading = null; }
  }

  async _load(onProgress) {
    if (typeof globalThis.Worker !== 'function') {
      throw new Error('Local vision needs Web Workers. Open Phone Away in a current Chrome or Safari browser.');
    }
    onProgress('Preparing YOLO26 and hand tracking…');
    // Classic workers support MediaPipe's importScripts WASM loader; the
    // worker imports ONNX Runtime and our helpers with dynamic import().
    this.worker = new Worker(new URL('./detection-worker.js', import.meta.url));
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      if (data.type === 'progress') { pending.onProgress?.(data.message); return; }
      clearTimeout(pending.timeout);
      this.pending.delete(data.id);
      if (data.type === 'error') pending.reject(new Error(data.error || 'Local vision failed.'));
      else pending.resolve(data.result);
    };
    this.worker.onerror = event => {
      event.preventDefault?.();
      this._stopWorker(new Error(event.message || 'The local vision worker stopped unexpectedly.'));
    };
    this.worker.onmessageerror = () => this._stopWorker(new Error('Could not read a local vision result.'));
    try {
      const info = await this._callWorker('load', {}, [], onProgress);
      this.workerReady = true;
      this.backend = info?.backend || '';
      onProgress('Local vision is ready');
      return this;
    } catch (error) {
      this._stopWorker(error);
      throw error;
    }
  }

  async detect(canvas) {
    if (!this.workerReady) throw new Error('Local vision is not ready yet.');
    if (this.detecting) throw new Error('A local vision check is already running.');
    if (typeof canvas?.getContext !== 'function' || !canvas.width || !canvas.height) {
      throw new Error('The camera frame is not ready yet.');
    }
    this.detecting = true;
    try {
      const frame = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      return await this._callWorker('detect', {
        width: frame.width, height: frame.height, pixels: frame.data.buffer,
      }, [frame.data.buffer]);
    } finally { this.detecting = false; }
  }

  dispose() { this._stopWorker(new Error('Local vision was stopped.')); }

  _callWorker(action, payload = {}, transfer = [], onProgress) {
    if (!this.worker) return Promise.reject(new Error('The local vision worker is unavailable.'));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._stopWorker(new Error(action === 'load'
          ? 'Local vision took too long to load. Restart the session to try again.'
          : 'The local vision check took too long. Restart the session to try again.'));
      }, action === 'load' ? 90000 : 15000);
      this.pending.set(id, { resolve, reject, timeout, onProgress });
      try { this.worker.postMessage({ id, action, ...payload }, transfer); }
      catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _stopWorker(error) {
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    this.backend = '';
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Time only accumulates between consecutive matching, valid samples.
 * Unknown frames/errors freeze the timers. An alert remains latched until at
 * least two clear samples cover clearMs; one clear frame never rearms it.
 */
export class IncidentGate {
  constructor({ holdMs = 3000, clearMs = 4000, confidence = 0.55,
    minPositiveSamples = 2, maxGapMs = 15000 } = {}) {
    if (![holdMs, clearMs, maxGapMs].every(value => Number.isFinite(value) && value >= 0)
      || !Number.isFinite(confidence) || confidence < 0 || confidence > 1
      || !Number.isInteger(minPositiveSamples) || minPositiveSamples < 2) {
      throw new TypeError('Invalid incident gate settings.');
    }
    Object.assign(this, { holdMs, clearMs, confidence, minPositiveSamples, maxGapMs });
    this.reset();
  }

  reset() {
    this.alerted = false;
    this.holdElapsed = 0;
    this.clearElapsed = 0;
    this.positiveSamples = 0;
    this.clearSamples = 0;
    this.lastAt = null;
    this.lastKind = null;
    this.state = 'clear';
    return this._result(false);
  }

  invalidate(nowMs = performance.now()) {
    this.lastAt = Number.isFinite(nowMs) ? nowMs : null;
    this.lastKind = null;
    return this._result(false);
  }

  update(result, nowMs = performance.now()) {
    if (!Number.isFinite(nowMs) || !result || typeof result.phoneUse !== 'boolean'
      || !Number.isFinite(result.confidence)
      || result.confidence < 0 || result.confidence > 1) {
      return this.invalidate(nowMs);
    }
    if (result.phoneUse && result.confidence < this.confidence) return this.invalidate(nowMs);

    const kind = result.phoneUse ? 'positive' : 'clear';
    const gap = this.lastAt === null ? 0 : nowMs - this.lastAt;
    const elapsed = this.lastKind === kind && gap >= 0 && gap <= this.maxGapMs ? gap : 0;
    this.lastAt = nowMs;
    this.lastKind = kind;
    let trigger = false;

    if (kind === 'positive') {
      this.clearSamples = 0;
      this.clearElapsed = 0;
      if (this.alerted) {
        this.state = 'alerted';
      } else {
        this.positiveSamples += 1;
        this.holdElapsed += elapsed;
        this.state = 'confirming';
        if (this.holdElapsed >= this.holdMs && this.positiveSamples >= this.minPositiveSamples) {
          this.alerted = true;
          this.state = 'alerted';
          trigger = true;
        }
      }
    } else {
      this.positiveSamples = 0;
      this.holdElapsed = 0;
      if (this.alerted) {
        this.clearSamples += 1;
        this.clearElapsed += elapsed;
        this.state = 'clearing';
        if (this.clearElapsed >= this.clearMs && this.clearSamples >= 2) {
          this.alerted = false;
          this.clearElapsed = 0;
          this.clearSamples = 0;
          this.state = 'clear';
        }
      } else {
        this.state = 'clear';
      }
    }
    return this._result(trigger);
  }

  _result(trigger) {
    const progress = this.state === 'confirming'
      ? (this.holdMs === 0 ? 1 : clamp(this.holdElapsed / this.holdMs, 0, 1))
      : this.state === 'clearing'
        ? (this.clearMs === 0 ? 1 : clamp(this.clearElapsed / this.clearMs, 0, 1))
        : this.state === 'alerted' ? 1 : 0;
    return { state: this.state, trigger, progress };
  }
}
