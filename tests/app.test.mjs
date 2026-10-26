import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { IncidentGate } from '../public/detection.js';
import { AlertAudioPlayer } from '../public/audio-player.js';

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]*\n/gm, '');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const clear = { phoneUse: false, confidence: 0.95, reason: 'No phone.' };
const phone = { phoneUse: true, confidence: 0.95, reason: 'Phone held.' };

// Exercise the app entrypoint and its real event handlers. These substitutes
// expose only browser boundaries: DOM, clock, media, audio, and worker results.
// No camera, browser, credentials, or network connection are used by this suite.
async function harness({ speed = 'fast', delay = '3000', sensitivity = '0.55', storage = { record: null }, ready = true, cameraReady } = {}) {
  let now = 1000, nextTimer = 0, audioStarts = 0, stoppedTracks = 0, cameraRequests = 0;
  const timers = new Map(), captures = [], requests = [], audioSources = [], drawOperations = [];
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const setTimer = (callback, ms = 0, interval = null) => {
    const id = ++nextTimer;
    timers.set(id, { at: now + Math.max(0, Number(ms)), callback, interval });
    return id;
  };
  const clock = {
    get now() { return now; },
    async advance(ms) {
      const until = now + ms;
      for (let count = 0; count < 1000; count++) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) { now = until; await flush(); return; }
        const [id, timer] = next;
        now = timer.at;
        timers.delete(id);
        if (timer.interval !== null) timers.set(id, { ...timer, at: now + timer.interval });
        timer.callback();
        await flush();
      }
      throw new Error('Runaway application timers.');
    },
  };

  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.value = ''; this.textContent = '';
      this.hidden = false; this.disabled = false; this.style = {}; this.children = [];
      this.listeners = new Map(); this.classes = new Set();
      this.classList = {
        add: (...names) => names.forEach(name => this.classes.add(name)),
        remove: (...names) => names.forEach(name => this.classes.delete(name)),
        toggle: (name, force) => {
          const enabled = force ?? !this.classes.has(name);
          enabled ? this.classes.add(name) : this.classes.delete(name);
          return enabled;
        },
      };
    }
    addEventListener(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(fn);
    }
    async dispatch(name, extra = {}) {
      await Promise.all((this.listeners.get(name) || []).map(fn => fn({ target: this, ...extra })));
      await flush();
    }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    prepend(...children) { this.children.unshift(...children); }
    add(child) { this.append(child); }
    setAttribute(name, value) { this[name] = value; }
    getContext() {
      return this.context ??= {
        clearRect(...args) { drawOperations.push({ type: 'clear', args }); },
        strokeRect(...args) { drawOperations.push({ type: 'stroke', args, color: this.strokeStyle }); },
        fillRect(...args) { drawOperations.push({ type: 'fill', args, color: this.fillStyle }); },
        fillText(...args) { drawOperations.push({ type: 'text', args, color: this.fillStyle }); },
        measureText: text => ({ width: text.length * 8 }),
        drawImage: () => { this.capturedAt = now; captures.push(now); },
      };
    }
    async play() {}
  }
  const elements = new Map([...html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)]
    .map(([, tag, id]) => [id, new Element(tag)]));
  const $ = id => { assert.ok(elements.has(id), `Missing DOM element: ${id}`); return elements.get(id); };
  for (const [id, value] of Object.entries({ delay, sensitivity, volume: '75', 'camera-select': '', speed })) $(id).value = value;
  Object.assign($('camera'), { videoWidth: 960, videoHeight: 720, readyState: 4 });
  const selectors = new Map([['.session-card h2', new Element('h2')], ['.audio-card', new Element('article')]]);
  const document = new Element('document');
  Object.assign(document, {
    hidden: false, getElementById: id => elements.get(id) || null,
    createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }),
    querySelector: selector => { assert.ok(selectors.has(selector), `Unexpected selector: ${selector}`); return selectors.get(selector); },
  });
  const track = { stop: () => stoppedTracks++, addEventListener() {} };
  const mediaStream = { getTracks: () => [track], getVideoTracks: () => [track] };
  class AudioContext {
    constructor() { this.destination = {}; this.state = 'running'; }
    async resume() { this.state = 'running'; }
    createGain() { return { gain: {}, connect() {} }; }
    async decodeAudioData(bytes) { return { duration: 3, identity: new Uint8Array(bytes)[0] ?? 0 }; }
    createBufferSource() {
      const source = {
        starts: [], stopped: false, connect() {}, disconnect() {}, stop() { this.stopped = true; },
        start(when) {
          assert.equal(this.starts.length, 0, 'Audio source nodes cannot be reused.');
          this.starts.push(when); audioStarts++;
        },
        finish() { this.onended?.(); },
      };
      audioSources.push(source);
      return source;
    }
  }
  const window = new Element('window'); window.AudioContext = AudioContext;
  const fetch = async url => {
    assert.equal(url, '/audio/phone-away.wav', 'The app must not upload frames or call provider APIs.');
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const context = vm.createContext({ document, window, fetch, IncidentGate, AlertAudioPlayer, console,
    createAudioStore: () => ({
      async load() { await storage.readBarrier; return storage.record; },
      async save(record) { storage.record = { ...record, bytes: record.bytes.slice(0) }; },
      async clear() { storage.record = null; },
    }),
    LocalDetector: class {
      async load() {}
      dispose() {}
      detect(canvas) {
        return new Promise((resolve, reject) => requests.push({
          at: now, local: true, capturedAt: canvas.capturedAt,
          async respond(result = clear) { resolve(result); await flush(); },
          async reject(error) { reject(error); await flush(); },
        }));
      }
    },
    performance: { now: () => now },
    setTimeout: (fn, ms) => setTimer(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => setTimer(fn, ms, ms), clearInterval: id => timers.delete(id),
    Option: class extends Element { constructor(label, value) { super('option'); this.textContent = label; this.value = value; } },
    navigator: { mediaDevices: {
      getUserMedia: async () => { cameraRequests++; await cameraReady; return mediaStream; },
      enumerateDevices: async () => [], addEventListener() {},
    } },
  });
  vm.runInContext(appSource, context, { filename: 'app.js' });
  await flush();
  if (ready) assert.equal($('start-button').disabled, false, 'App initialization completed.');
  return {
    $, clock, requests, captures, audioSources, storage, flush, drawOperations,
    get audioStarts() { return audioStarts; },
    get stoppedTracks() { return stoppedTracks; },
    get cameraRequests() { return cameraRequests; },
    async setHidden(hidden) { document.hidden = hidden; await document.dispatch('visibilitychange'); },
    pageHide: () => window.dispatch('pagehide'),
    start: () => $('start-button').dispatch('click'),
    pause: () => $('start-button').dispatch('click'),
    end: () => $('end-button').dispatch('click'),
    async upload({ name = 'custom-callout.wav', value = 42 } = {}) {
      const bytes = Uint8Array.of(value).buffer;
      $('audio-upload').files = [{ name, type: 'audio/wav', size: bytes.byteLength,
        arrayBuffer: async () => bytes.slice(0) }];
      await $('audio-upload').dispatch('change');
    },
  };
}

test('slow inference is followed immediately by a fresh capture, with no queued frames', async () => {
  const app = await harness();
  await app.start();
  assert.equal(app.requests.length, 1);
  await app.clock.advance(2000);
  assert.equal(app.requests.length, 1, 'Never overlap inference requests.');
  assert.equal(app.captures.length, 1, 'Never build a backlog of stale camera frames.');
  await app.requests[0].respond();
  assert.equal(app.$('checks-count').textContent, '1');
  assert.equal(app.$('latency-value').textContent, '2000 ms');
  assert.equal(app.$('result-value').textContent, 'No phone.');
  await app.clock.advance(0);
  assert.equal(app.requests.length, 2, 'No extra delay after a response exceeds the target cadence.');
  assert.deepEqual(app.captures, [1000, 3000]);
  assert.equal(app.requests[1].capturedAt, 3000);
  await app.end();
});

test('slow responses cannot manufacture phone dwell from time after the frame was captured', async () => {
  const app = await harness({ delay: '3000' });
  await app.start();
  await app.clock.advance(200);
  await app.requests[0].respond(phone);
  await app.clock.advance(800);
  await app.clock.advance(4000);
  await app.requests[1].respond(phone);
  assert.equal(app.$('nudge-count').textContent, '0', 'The two frames were captured only one second apart.');
  assert.equal(app.audioStarts, 0);
  await app.clock.advance(0);
  await app.clock.advance(200);
  await app.requests[2].respond(phone);
  assert.equal(app.$('nudge-count').textContent, '1', 'A later capture confirms the sustained incident.');
  assert.equal(app.audioStarts, 1);
  await app.end();
});

test('pausing ignores a successful late worker result', async () => {
  const app = await harness({ delay: '0' });
  await app.start();
  await app.clock.advance(200);
  await app.requests[0].respond(phone);
  await app.clock.advance(800);
  const late = app.requests[1];
  const latency = app.$('latency-value').textContent;
  const result = app.$('result-value').textContent;
  await app.pause();
  assert.equal(app.stoppedTracks, 1);
  await app.clock.advance(4000);
  await late.respond(phone);
  await app.clock.advance(20000);
  assert.equal(app.requests.length, 2);
  assert.equal(app.$('checks-count').textContent, '1');
  assert.equal(app.$('nudge-count').textContent, '0');
  assert.equal(app.$('latency-value').textContent, latency);
  assert.equal(app.$('result-value').textContent, result);
  assert.equal(app.audioStarts, 0);
  await app.end();
});

test('hidden tabs retain the camera and in-flight check, capture fresh frames, and play alerts', async () => {
  const app = await harness({ delay: '0' });
  await app.upload();
  await app.start();
  const camera = app.$('camera').srcObject;
  const first = app.requests[0];
  await app.clock.advance(200);
  await app.setHidden(true);
  assert.equal(app.$('session-status').textContent, 'ACTIVE');
  assert.equal(app.$('camera').srcObject, camera);
  assert.equal(app.stoppedTracks, 0);

  await first.respond(phone);
  await app.clock.advance(800);
  assert.equal(app.requests.length, 2);
  assert.deepEqual(app.captures, [1000, 1200], 'Background checks still take fresh photographs.');
  await app.requests[1].respond(phone);
  assert.equal(app.$('checks-count').textContent, '2');
  assert.equal(app.$('nudge-count').textContent, '1');
  assert.equal(app.audioStarts, 1);
  assert.equal(app.audioSources[0].buffer.identity, 42, 'Background alerts use the selected custom audio.');
  await app.end();
});

test('hiding a tab while camera permission is pending still completes startup', async () => {
  let allowCamera;
  const cameraReady = new Promise(resolve => { allowCamera = resolve; });
  const app = await harness({ cameraReady });
  const starting = app.start();
  await app.flush();
  assert.equal(app.cameraRequests, 1);
  assert.equal(app.$('session-status').textContent, 'STARTING');
  await app.setHidden(true);
  allowCamera();
  await starting;
  assert.equal(app.$('session-status').textContent, 'ACTIVE');
  assert.ok(app.$('camera').srcObject);
  assert.equal(app.stoppedTracks, 0);
  assert.equal(app.requests.length, 1);
  await app.requests[0].respond(clear);
  await app.clock.advance(1000);
  assert.equal(app.requests.length, 2);
  await app.end();
});

test('returning to a visible tab preserves one camera and one detection loop', async () => {
  const app = await harness();
  await app.start();
  await app.setHidden(true);
  await app.requests[0].respond(clear);
  await app.clock.advance(50);
  await app.setHidden(false);
  await app.setHidden(true);
  await app.setHidden(false);
  assert.equal(app.requests.length, 1, 'Visibility events must not start extra checks.');
  await app.clock.advance(50);
  assert.equal(app.requests.length, 2);
  assert.equal(app.cameraRequests, 1, 'Tab switching must retain the original camera.');
  assert.equal(app.stoppedTracks, 0);
  await app.setHidden(true);
  await app.setHidden(false);
  await app.clock.advance(3000);
  assert.equal(app.requests.length, 2, 'An in-flight check must remain the only check after returning.');
  await app.requests[1].respond(clear);
  await app.clock.advance(0);
  assert.equal(app.requests.length, 3, 'Only one fresh check follows the slow response.');
  assert.deepEqual(app.captures, [1000, 1100, 4100]);
  await app.end();
});

for (const action of ['pause', 'pageHide']) {
  test(`${action} still stops hidden-tab camera, pending checks, and audio`, async () => {
    const app = await harness({ delay: '0' });
    await app.start();
    await app.requests[0].respond(phone);
    await app.clock.advance(1000);
    await app.requests[1].respond(phone);
    assert.equal(app.audioStarts, 1);
    await app.clock.advance(1000);
    const pending = app.requests[2];
    await app.setHidden(true);
    await app[action]();
    assert.equal(app.stoppedTracks, 1);
    assert.equal(app.$('camera').srcObject, null);
    assert.equal(app.audioSources[0].stopped, true);
    assert.equal(app.$('session-status').textContent, 'PAUSED');
    await pending.respond(phone);
    await app.setHidden(false);
    await app.clock.advance(5000);
    assert.equal(app.requests.length, 3, 'A stopped session must not restart when the tab becomes visible.');
    assert.equal(app.$('checks-count').textContent, '2', 'Late responses must not affect a stopped session.');
    assert.equal(app.audioStarts, 1);
    await app.end();
  });
}

test('leaving the page during startup stops a camera granted after pagehide', async () => {
  let allowCamera;
  const app = await harness({ cameraReady: new Promise(resolve => { allowCamera = resolve; }) });
  const starting = app.start();
  await app.flush();
  assert.equal(app.cameraRequests, 1);
  await app.pageHide();
  allowCamera();
  await starting;
  assert.equal(app.stoppedTracks, 1);
  assert.equal(app.$('camera').srcObject, null);
  assert.equal(app.$('session-status').textContent, 'PAUSED');
  assert.equal(app.requests.length, 0);
  await app.clock.advance(5000);
  assert.equal(app.requests.length, 0);
  await app.end();
});

test('ending and restarting resets results and prevents the previous session from changing them', async () => {
  const app = await harness();
  await app.start();
  const initialLatency = app.$('latency-value').textContent;
  const initialResult = app.$('result-value').textContent;
  await app.clock.advance(200);
  await app.requests[0].respond(phone);
  assert.notEqual(app.$('latency-value').textContent, initialLatency);
  assert.notEqual(app.$('result-value').textContent, initialResult);
  await app.clock.advance(800);
  const oldRequest = app.requests[1];
  await app.end();
  await app.start();
  assert.equal(app.requests.length, 2, 'Restart waits for the previous worker check.');
  assert.equal(app.$('checks-count').textContent, '0');
  assert.equal(app.$('latency-value').textContent, initialLatency);
  assert.equal(app.$('result-value').textContent, initialResult);
  await oldRequest.respond(phone);
  assert.equal(app.requests.length, 3);
  assert.equal(app.$('checks-count').textContent, '0');
  assert.equal(app.$('nudge-count').textContent, '0');
  assert.equal(app.$('latency-value').textContent, initialLatency);
  assert.equal(app.$('result-value').textContent, initialResult);
  assert.equal(app.audioStarts, 0);
  await app.end();
});

test('local detector failures back off five then ten seconds and pause after the third failure', async () => {
  const app = await harness();
  await app.start();
  for (const [index, retryDelay] of [[0, 5000], [1, 10000]]) {
    await app.clock.advance(200);
    await app.requests[index].reject(new Error('Detector unavailable.'));
    await app.clock.advance(retryDelay - 1);
    assert.equal(app.requests.length, index + 1, 'A failure cannot trigger an immediate retry loop.');
    await app.clock.advance(1);
    assert.equal(app.requests.length, index + 2);
  }
  await app.clock.advance(200);
  await app.requests[2].reject(new Error('Detector unavailable.'));
  assert.match(app.$('message').textContent, /three failed checks/i);
  assert.match(app.$('start-label').textContent, /resume/i);
  assert.equal(app.stoppedTracks, 1);
  await app.clock.advance(30000);
  assert.equal(app.requests.length, 3);
  assert.equal(app.$('checks-count').textContent, '0');
  assert.equal(app.audioStarts, 0);
  await app.end();
});

test('custom audio is committed with its metadata and restored after a fresh page load', async () => {
  const storage = { record: null };
  const original = await harness({ storage });
  await original.upload();
  assert.equal(storage.record?.name, 'custom-callout.wav');
  assert.equal(storage.record.type, 'audio/wav');
  assert.equal(storage.record.duration, 3);
  assert.deepEqual([...new Uint8Array(storage.record.bytes)], [42]);
  assert.equal(original.$('audio-name').textContent, 'custom-callout.wav');
  assert.match(original.$('audio-detail').textContent, /3(?:\.0)? seconds/);

  // A separate VM has no previous AudioContext, decoded buffer, or app state.
  const refreshed = await harness({ storage });
  assert.equal(refreshed.$('audio-name').textContent, 'custom-callout.wav');
  assert.match(refreshed.$('audio-detail').textContent, /3(?:\.0)? seconds/);
  await refreshed.$('test-audio').dispatch('click');
  assert.equal(refreshed.audioStarts, 1);
  assert.equal(refreshed.audioSources[0].buffer.identity, 42, 'Play uses restored custom bytes, not the default sample.');
  refreshed.audioSources[0].finish();
  await refreshed.$('test-audio').dispatch('click');
  assert.equal(refreshed.audioStarts, 2);
  assert.equal(refreshed.audioSources[1].buffer.identity, 42);
  await refreshed.end();
});

test('two separate phone-use incidents each play the uploaded clip', async () => {
  const app = await harness({ delay: '0' });
  await app.upload();
  await app.start();
  await app.requests[0].respond(phone);
  await app.clock.advance(1000);
  await app.requests[1].respond(phone);
  assert.equal(app.$('nudge-count').textContent, '1');
  assert.equal(app.audioStarts, 1);
  assert.equal(app.audioSources[0].buffer.identity, 42);
  app.audioSources[0].finish();

  // Continued phone use belongs to the same incident and must not replay.
  await app.clock.advance(1000);
  await app.requests[2].respond(phone);
  assert.equal(app.audioStarts, 1);
  // Five clear photographs span four seconds, rearming the detector.
  for (let index = 3; index <= 7; index++) {
    await app.clock.advance(1000);
    await app.requests[index].respond(clear);
  }
  for (let index = 8; index <= 9; index++) {
    await app.clock.advance(1000);
    await app.requests[index].respond(phone);
  }
  assert.equal(app.$('nudge-count').textContent, '2');
  assert.equal(app.audioStarts, 2, 'Every new incident receives an audible alert.');
  assert.notEqual(app.audioSources[0], app.audioSources[1]);
  assert.equal(app.audioSources[1].buffer.identity, 42);
  assert.deepEqual(app.audioSources.map(source => source.starts), [[0], [0]]);
  await app.end();
});

test('two clear checks one second apart rearm custom audio, while a single clear check does not', async () => {
  const app = await harness({ delay: '0' });
  await app.upload();
  await app.start();
  const check = async result => {
    await app.requests.at(-1).respond(result);
    await app.clock.advance(1000);
  };
  await check(phone);
  await check(phone);
  assert.equal(app.audioStarts, 1);
  assert.equal(app.audioSources[0].buffer.identity, 42);
  app.audioSources[0].finish();

  await check(phone);
  assert.equal(app.audioStarts, 1, 'Sustained phone use must not repeat the alert.');
  await check(clear);
  await check(phone);
  await check(phone);
  assert.equal(app.audioStarts, 1, 'One missed phone detection must not create another incident.');

  await check(clear);
  await check(clear);
  await check(phone);
  await check(phone);
  assert.equal(app.$('nudge-count').textContent, '2');
  assert.equal(app.audioStarts, 2, 'A brief confirmed put-down must allow the next audible alert.');
  assert.equal(app.audioSources[1].buffer.identity, 42);
  assert.notEqual(app.audioSources[0], app.audioSources[1]);
  assert.deepEqual(app.audioSources.map(source => source.starts), [[0], [0]]);
  await app.end();
});

test('an uncertain no-phone result cannot substitute for the second clear check', async () => {
  const app = await harness({ delay: '0' });
  await app.upload();
  await app.start();
  const check = async result => {
    await app.requests.at(-1).respond(result);
    await app.clock.advance(1000);
  };
  await check(phone);
  await check(phone);
  assert.equal(app.audioStarts, 1);
  app.audioSources[0].finish();

  await check(clear);
  await check({ phoneUse: false, confidence: 0, uncertain: true, reason: 'Hands obscured.' });
  await check(phone);
  await check(phone);
  assert.equal(app.audioStarts, 1, 'Uncertain hand observations cannot rearm an active incident.');
  assert.equal(app.$('nudge-count').textContent, '1');

  await check(clear);
  await check(clear);
  await check(phone);
  await check(phone);
  assert.equal(app.audioStarts, 2, 'Two confident clear results still enable a later incident.');
  assert.equal(app.audioSources[1].buffer.identity, 42);
  await app.end();
});

test('resetting custom audio clears persistent storage and restores the sample after refresh', async () => {
  const storage = { record: null };
  const app = await harness({ storage });
  await app.upload();
  await app.$('audio-reset').dispatch('click');
  assert.equal(storage.record, null);
  const refreshed = await harness({ storage });
  await refreshed.$('test-audio').dispatch('click');
  assert.equal(refreshed.audioSources[0].buffer.identity, 0);
  assert.notEqual(refreshed.$('audio-name').textContent, 'custom-callout.wav');
  await refreshed.end();
});

test('monitoring waits for saved audio restoration instead of racing the default sample', async () => {
  let completeRestore;
  const storage = {
    record: { name: 'saved-callout.wav', type: 'audio/wav', duration: 3, bytes: Uint8Array.of(42).buffer },
    readBarrier: new Promise(resolve => { completeRestore = resolve; }),
  };
  const app = await harness({ storage, ready: false });
  for (const id of ['start-button', 'demo-button', 'audio-upload', 'audio-reset', 'test-audio']) {
    assert.equal(app.$(id).disabled, true, `${id} waits for the saved selection.`);
  }
  await app.start();
  assert.equal(app.requests.length, 0, 'Even a programmatic click cannot start before restoration.');
  assert.equal(app.audioStarts, 0);
  completeRestore();
  await app.flush();
  assert.equal(app.$('start-button').disabled, false);
  assert.equal(app.$('audio-name').textContent, 'saved-callout.wav');
  await app.$('test-audio').dispatch('click');
  assert.equal(app.audioSources[0].buffer.identity, 42);
  await app.end();
});

test('monitoring uses the local worker without provider setup or image uploads', async () => {
  const app = await harness();
  await app.start();
  assert.equal(app.requests[0].local, true);
  await app.requests[0].respond(clear);
  assert.equal(app.$('checks-count').textContent, '1');
  await app.end();
});

for (const [speed, interval] of [['fast', 100], ['balanced', 200], ['economy', 500]]) {
  test(`local ${speed} targets ${interval}ms start-to-start with fresh frames`, async () => {
    const app = await harness({ speed });
    await app.start();
    assert.equal(app.requests[0].local, true);
    await app.clock.advance(30);
    await app.requests[0].respond(clear);
    assert.equal(app.$('latency-value').textContent, '30 ms');
    await app.clock.advance(interval - 31);
    assert.equal(app.requests.length, 1);
    await app.clock.advance(1);
    assert.equal(app.requests.length, 2);
    assert.deepEqual(app.captures, [1000, 1000 + interval]);
    await app.end();
  });
}

test('slow local inference never queues frames or overlaps checks', async () => {
  const app = await harness({});
  await app.start();
  await app.clock.advance(700);
  assert.equal(app.requests.length, 1);
  assert.deepEqual(app.captures, [1000]);
  await app.requests[0].respond(clear);
  await app.clock.advance(0);
  assert.equal(app.requests.length, 2);
  assert.deepEqual(app.captures, [1000, 1700]);
  await app.end();
});

test('resuming waits for the old local check before taking a new frame and ignores its result', async () => {
  const app = await harness({ delay: '0' });
  await app.start();
  await app.clock.advance(200);
  await app.pause();
  await app.start();
  await app.clock.advance(500);
  assert.equal(app.requests.length, 1, 'A resumed session must not overlap a still-running worker check.');
  assert.deepEqual(app.captures, [1000]);
  await app.requests[0].respond(phone);
  assert.equal(app.requests.length, 2);
  assert.deepEqual(app.captures, [1000, 1700], 'Take the next image after the worker is ready.');
  assert.equal(app.$('checks-count').textContent, '0', 'Discard the previous session’s result.');
  assert.equal(app.audioStarts, 0);
  await app.requests[1].respond(clear);
  assert.equal(app.$('checks-count').textContent, '1');
  await app.end();
});

test('phone boxes are yellow with a dark outline and readable labels aligned with mirrored video', async () => {
  const app = await harness({});
  await app.start();
  await app.requests[0].respond({ ...phone, boxes: [
    { label: 'cell phone', score: 0.95, bbox: [120, 80, 50, 100] },
    { label: 'person', score: 0.99, bbox: [0, 0, 640, 480] },
  ] });
  const strokes = app.drawOperations.filter(operation => operation.type === 'stroke');
  assert.equal(strokes.length, 2, 'Only outline the phone.');
  assert.equal(strokes[0].color, '#000');
  assert.equal(strokes[1].color, '#ffd43b');
  assert.deepEqual(strokes[1].args, [470, 80, 50, 100], 'The phone aligns with the mirrored preview.');
  const label = app.drawOperations.find(operation => operation.type === 'text');
  assert.equal(label.args[0], 'Phone 95%');
  assert.equal(label.color, '#000');
  await app.end();
});

test('a failed local check clears stale phone outlines while waiting to retry', async () => {
  const app = await harness({});
  await app.start();
  await app.requests[0].respond({ ...phone, boxes: [{ label: 'cell phone', score: 0.95, bbox: [120, 80, 50, 100] }] });
  assert.ok(app.drawOperations.some(operation => operation.type === 'stroke'));
  await app.clock.advance(100);
  const previousOperations = app.drawOperations.length;
  await app.requests[1].reject(new Error('The local vision check failed.'));
  const afterFailure = app.drawOperations.slice(previousOperations);
  assert.deepEqual(afterFailure, [{ type: 'clear', args: [0, 0, 640, 480] }],
    'A failed frame must clear the previous location and confidence label.');
  assert.match(app.$('frame-caption').textContent, /CHECK FAILED/);
  await app.clock.advance(4999);
  assert.equal(app.requests.length, 2, 'The overlay stays clear throughout the retry wait.');
  await app.clock.advance(1);
  assert.equal(app.requests.length, 3);
  await app.end();
});

test('local alerts rearm after one second of clear observations, not two fast clear frames', async () => {
  const app = await harness({ delay: '0' });
  await app.upload();
  await app.start();
  const check = async result => {
    await app.requests.at(-1).respond(result);
    await app.clock.advance(100);
  };
  await check(phone);
  await check(phone);
  assert.equal(app.audioStarts, 1);
  app.audioSources[0].finish();
  await check(clear);
  await check(clear);
  await check(phone);
  await check(phone);
  assert.equal(app.audioStarts, 1, 'A 100ms missed detection cannot trigger another alert.');
  for (let index = 0; index < 11; index++) await check(clear);
  await check(phone);
  await check(phone);
  assert.equal(app.audioStarts, 2, 'A new pickup after a sustained clear period plays again.');
  assert.equal(app.audioSources[1].buffer.identity, 42);
  assert.notEqual(app.audioSources[0], app.audioSources[1]);
  await app.end();
});

test('selected UI defaults alert on a weaker held phone after one second and only repeat after a new pickup', async () => {
  const selectedValue = id => {
    const select = html.match(new RegExp(`<select\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</select>`));
    assert.ok(select, `Missing settings control: ${id}`);
    const selected = select[1].match(/<option\b(?=[^>]*\bselected\b)[^>]*\bvalue="([^"]+)"/);
    assert.ok(selected, `Missing selected default: ${id}`);
    return selected[1];
  };
  const sensitivity = selectedValue('sensitivity');
  const delay = selectedValue('delay');
  assert.equal(sensitivity, '0.25');
  assert.equal(delay, '1000');
  const app = await harness({ sensitivity, delay });
  await app.upload();
  await app.start();
  const weakPhone = { ...phone, confidence: 0.28 };
  const check = async result => {
    await app.requests.at(-1).respond(result);
    await app.clock.advance(100);
  };
  for (let index = 0; index < 10; index++) await check(weakPhone);
  assert.equal(app.audioStarts, 0, '900ms of weak but valid evidence is still confirming.');
  await check(weakPhone);
  assert.equal(app.audioStarts, 1, 'The selected sensitivity accepts the 28% signal at one second.');
  assert.equal(app.$('nudge-count').textContent, '1');
  app.audioSources[0].finish();
  for (let index = 0; index < 20; index++) await check(weakPhone);
  assert.equal(app.audioStarts, 1, 'Continued use must not produce repeated screams.');
  for (let index = 0; index < 11; index++) await check(clear);
  for (let index = 0; index < 11; index++) await check(weakPhone);
  assert.equal(app.audioStarts, 2, 'A separate pickup produces another alert with the same audio.');
  assert.equal(app.$('nudge-count').textContent, '2');
  assert.equal(app.audioSources[1].buffer.identity, 42);
  assert.notEqual(app.audioSources[0], app.audioSources[1]);
  await app.end();
});

test('phone-visible uncertainty cannot rearm local audio even when hands remain hidden', async () => {
  const app = await harness({ delay: '0' });
  await app.start();
  const check = async result => {
    await app.requests.at(-1).respond(result);
    await app.clock.advance(100);
  };
  await check(phone);
  await check(phone);
  assert.equal(app.audioStarts, 1);
  app.audioSources[0].finish();
  for (let index = 0; index < 20; index++) {
    await check({ phoneUse: false, confidence: 0.99, uncertain: true, reason: 'Phone visible; hands obscured.' });
  }
  assert.match(app.$('frame-caption').textContent, /UNCERTAIN/);
  await check(phone);
  await check(phone);
  assert.equal(app.audioStarts, 1, 'Unknown hand position cannot manufacture a new incident.');
  for (let index = 0; index < 11; index++) await check(clear);
  await check(phone);
  await check(phone);
  assert.equal(app.audioStarts, 2);
  await app.end();
});

test('hidden local sessions keep capturing at their target cadence without starting extra loops', async () => {
  const app = await harness({});
  await app.start();
  await app.setHidden(true);
  await app.requests[0].respond(clear);
  await app.clock.advance(100);
  assert.equal(app.requests.length, 2);
  assert.equal(app.stoppedTracks, 0);
  await app.setHidden(false);
  await app.clock.advance(500);
  assert.equal(app.requests.length, 2, 'Visibility changes must not overlap the in-flight check.');
  await app.requests[1].respond(clear);
  await app.clock.advance(0);
  assert.equal(app.requests.length, 3);
  assert.equal(app.cameraRequests, 1);
  await app.end();
});
