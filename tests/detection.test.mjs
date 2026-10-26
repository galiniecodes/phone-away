import test from 'node:test';
import assert from 'node:assert/strict';
import { IncidentGate, LocalDetector } from '../public/detection.js';

const phone = { phoneUse: true, confidence: 0.8 };
const clear = { phoneUse: false, confidence: 0.9 };

test('requires sustained evidence then alerts only once for an incident', () => {
  const gate = new IncidentGate();
  assert.deepEqual(gate.update(phone, 0), { state: 'confirming', trigger: false, progress: 0 });
  assert.equal(gate.update(phone, 1500).trigger, false);
  assert.deepEqual(gate.update(phone, 3000), { state: 'alerted', trigger: true, progress: 1 });
  for (const time of [4500, 6000, 10000, 20000]) assert.equal(gate.update(phone, time).trigger, false);
});

test('a negative during confirmation resets dwell', () => {
  const gate = new IncidentGate();
  gate.update(phone, 0);
  gate.update(phone, 1500);
  assert.equal(gate.update(clear, 1600).state, 'clear');
  assert.equal(gate.update(phone, 2000).progress, 0);
  assert.equal(gate.update(phone, 4000).trigger, false);
  assert.equal(gate.update(phone, 5000).trigger, true);
});

test('brief dropouts do not rearm; a confirmed clear interval does', () => {
  const gate = new IncidentGate();
  gate.update(phone, 0);
  gate.update(phone, 3000);
  assert.equal(gate.update(clear, 4000).state, 'clearing');
  assert.equal(gate.update(phone, 5000).trigger, false);
  gate.update(clear, 6000);
  assert.equal(gate.update(clear, 9999).state, 'clearing');
  assert.equal(gate.update(clear, 10000).state, 'clear');
  assert.equal(gate.update(phone, 11000).trigger, false);
  assert.equal(gate.update(phone, 14000).trigger, true);
});

test('unknown samples freeze dwell and do not count the unobserved interval', () => {
  const gate = new IncidentGate();
  gate.update(phone, 0);
  assert.equal(gate.update(phone, 1000).progress, 1 / 3);
  assert.equal(gate.invalidate(5000).progress, 1 / 3);
  assert.equal(gate.update(phone, 8000).progress, 1 / 3);
  assert.equal(gate.update(phone, 9999).trigger, false);
  assert.equal(gate.update(phone, 10000).trigger, true);
});

test('weak phone evidence is unknown and does not rearm an existing alert', () => {
  const gate = new IncidentGate();
  gate.update(phone, 0);
  gate.update(phone, 3000);
  const weak = { phoneUse: true, confidence: 0.4 };
  for (const time of [4000, 8000, 14000]) assert.equal(gate.update(weak, time).state, 'alerted');
  assert.equal(gate.update(phone, 15000).trigger, false);
});

test('unknown and excessively delayed samples do not accumulate clear time', () => {
  const gate = new IncidentGate({ maxGapMs: 5000 });
  gate.update(phone, 0);
  gate.update(phone, 3000);
  gate.update(clear, 4000);
  gate.update(clear, 5000);
  gate.invalidate(6000);
  assert.equal(gate.update(clear, 12000).progress, 0.25);
  assert.equal(gate.update(clear, 25000).progress, 0.25);
  assert.equal(gate.update(clear, 28000).state, 'clear');
});

test('large gaps and a backwards clock do not manufacture positive dwell', () => {
  const gate = new IncidentGate({ maxGapMs: 5000 });
  gate.update(phone, 0);
  assert.equal(gate.update(phone, 10000).progress, 0);
  assert.equal(gate.update(phone, 9000).progress, 0);
  assert.equal(gate.update(phone, 10000).trigger, false);
  assert.equal(gate.update(phone, 12000).trigger, true);
});

test('zero dwell settings still require two positive and two clear samples', () => {
  const gate = new IncidentGate({ holdMs: 0, clearMs: 0 });
  assert.equal(gate.update(phone, 0).trigger, false);
  assert.equal(gate.update(phone, 100).trigger, true);
  assert.equal(gate.update(clear, 200).state, 'clearing');
  assert.equal(gate.update(clear, 300).state, 'clear');
});

test('reset clears the latch and invalid input is treated as unknown', () => {
  const gate = new IncidentGate();
  gate.update(phone, 0);
  gate.update(phone, 3000);
  assert.equal(gate.update(null, 4000).state, 'alerted');
  assert.equal(gate.update({ phoneUse: false, confidence: NaN }, 5000).state, 'alerted');
  assert.deepEqual(gate.reset(), { state: 'clear', trigger: false, progress: 0 });
  assert.equal(gate.update(phone, 8000).trigger, false);
});

test('rejects invalid settings', () => {
  for (const options of [{ holdMs: -1 }, { clearMs: NaN }, { confidence: 2 }, { minPositiveSamples: 1 }]) {
    assert.throws(() => new IncidentGate(options), TypeError);
  }
});

test('LocalDetector reports unsupported browsers instead of blocking the UI thread', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = undefined;
  try { await assert.rejects(new LocalDetector().load(), /Web Workers/); }
  finally { globalThis.Worker = previous; }
});

test('worker bridge shares startup, transfers frame pixels, and preserves hand-aware results', async () => {
  const originalWorker = globalThis.Worker;
  const workers = [];
  class TestWorker {
    constructor(url) {
      assert.match(url.href, /\/detection-worker\.js$/);
      this.messages = [];
      workers.push(this);
    }
    postMessage(message, transfer) {
      this.messages.push({ message, transfer });
      queueMicrotask(() => {
        if (message.action === 'load') {
          this.onmessage({ data: { id: message.id, type: 'progress', message: 'Loading test worker' } });
        }
        this.onmessage({ data: { id: message.id, type: 'result', result:
          message.action === 'load' ? { ready: true, backend: 'webgpu' } : {phoneUse: true, confidence: .8, boxes: [], uncertain: false} } });
      });
    }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = TestWorker;
  const detector = new LocalDetector();
  try {
    const progress = [];
    await Promise.all([detector.load(message => progress.push(message)), detector.load()]);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].messages.length, 1);
    assert.ok(progress.includes('Loading test worker'));
    const frame = { width: 2, height: 1, data: new Uint8ClampedArray([0, 1, 2, 255, 3, 4, 5, 255]) };
    const canvas = { width: 2, height: 1, getContext: () => ({ getImageData: () => frame }) };
    assert.equal((await detector.detect(canvas)).phoneUse, true);
    const { message, transfer } = workers[0].messages[1];
    assert.equal(message.width, 2);
    assert.equal(message.height, 1);
    assert.equal(message.pixels, frame.data.buffer);
    assert.deepEqual(transfer, [frame.data.buffer]);
    detector.dispose();
    assert.equal(workers[0].terminated, true);
    assert.equal(detector.pending.size, 0);
    await assert.rejects(detector.detect(canvas), /not ready/);
  } finally {
    detector.dispose();
    globalThis.Worker = originalWorker;
  }
});

test('worker startup failures reject cleanly and allow retry', async () => {
  const originalWorker = globalThis.Worker;
  const workers = [];
  class FailingWorker {
    constructor() { workers.push(this); }
    postMessage(message) {
      queueMicrotask(() => {
        if (workers.length === 1) this.onerror({ message: 'Model could not load', preventDefault() {} });
        else this.onmessage({ data: { id: message.id, type: 'result', result: { ready: true } } });
      });
    }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = FailingWorker;
  const detector = new LocalDetector();
  try {
    await assert.rejects(detector.load(), /Model could not load/);
    assert.equal(workers[0].terminated, true);
    assert.equal(detector.pending.size, 0);
    await detector.load();
    assert.equal(workers.length, 2);
    assert.equal(detector.workerReady, true);
  } finally {
    detector.dispose();
    globalThis.Worker = originalWorker;
  }
});

test('disposing a worker cancels pending startup without leaving promises hanging', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class {
    postMessage() {}
    terminate() {}
  };
  const detector = new LocalDetector();
  try {
    const loading = detector.load();
    detector.dispose();
    await assert.rejects(loading, /stopped/);
    assert.equal(detector.pending.size, 0);
    assert.equal(detector.workerReady, false);
  } finally {
    detector.dispose();
    globalThis.Worker = originalWorker;
  }
});


test('worker bridge rejects overlapping frames instead of queuing stale photos', async () => {
  const originalWorker = globalThis.Worker;
  let worker;
  globalThis.Worker = class {
    constructor() { worker = this; this.frames = []; }
    postMessage(message) {
      if (message.action === 'load') queueMicrotask(() => this.onmessage({data: {id: message.id, type: 'result', result: {ready: true}}}));
      else this.frames.push(message);
    }
    terminate() {}
  };
  const detector = new LocalDetector();
  const canvas = { width: 1, height: 1, getContext: () => ({getImageData: () => ({width: 1, height: 1, data: new Uint8ClampedArray(4)})}) };
  try {
    await detector.load();
    const first = detector.detect(canvas);
    await assert.rejects(detector.detect(canvas), /already running/);
    assert.equal(worker.frames.length, 1);
    const result = {phoneUse: false, confidence: 0, uncertain: true, boxes: []};
    worker.onmessage({data: {id: worker.frames[0].id, type: 'result', result}});
    assert.deepEqual(await first, result);
    assert.equal(detector.detecting, false);
  } finally { detector.dispose(); globalThis.Worker = originalWorker; }
});
