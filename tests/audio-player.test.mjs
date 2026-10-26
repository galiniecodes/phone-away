import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertAudioPlayer } from '../public/audio-player.js';

const bytes = value => Uint8Array.of(value).buffer;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Model the Web Audio constraint responsible for replay failures: a source node
// is single-use, but the decoded AudioBuffer can be used by many fresh sources.
function harness({ state = 'running', resumeGate, loadDefault = async () => bytes(0) } = {}) {
  const contexts = [], sources = [], playing = [];
  const createContext = () => {
    const context = {
      state, destination: {}, resumes: 0,
      async resume() {
        this.resumes++;
        if (resumeGate) await resumeGate.promise;
        this.state = 'running';
      },
      createGain: () => ({ gain: {}, connect() {} }),
      async decodeAudioData(input) { return { identity: new Uint8Array(input)[0], duration: 3 }; },
      createBufferSource() {
        const source = {
          buffer: null, starts: [], stopped: false, disconnected: false,
          connect() {}, disconnect() { this.disconnected = true; },
          start(when) {
            if (this.starts.length) throw new Error('A source cannot be started twice.');
            this.starts.push(when);
          },
          stop() { this.stopped = true; },
          finish() { this.onended?.(); },
        };
        sources.push(source);
        return source;
      },
    };
    contexts.push(context);
    return context;
  };
  const player = new AlertAudioPlayer({ createContext, loadDefault, onPlaying: value => playing.push(value) });
  return { player, contexts, sources, playing };
}

test('each custom alert creates a fresh source using the same decoded clip', async () => {
  const app = harness();
  const clip = await app.player.decode(bytes(42));
  app.player.select(bytes(42), clip);
  assert.equal(await app.player.play(), true);
  assert.equal(await app.player.play(), true);
  assert.equal(app.sources.length, 2);
  assert.notEqual(app.sources[0], app.sources[1]);
  assert.equal(app.sources[0].buffer, clip);
  assert.equal(app.sources[1].buffer, clip);
  assert.deepEqual(app.sources.map(source => source.starts), [[0], [0]]);
  assert.equal(app.sources[0].stopped, true, 'Replacement alert stops the previous playback.');
  assert.equal(app.sources[0].disconnected, true);
  app.player.stop();
});

test('a naturally completed custom clip can play again from its beginning', async () => {
  const app = harness();
  app.player.select(bytes(42));
  await app.player.play();
  app.sources[0].finish();
  assert.equal(app.playing.at(-1), false);
  assert.equal(app.sources[0].disconnected, true);
  await app.player.play();
  assert.equal(app.sources.length, 2);
  assert.equal(app.sources[1].buffer.identity, 42);
  assert.deepEqual(app.sources[1].starts, [0]);
  assert.equal(app.playing.at(-1), true);
  app.player.stop();
});

test('overlapping alerts waiting for browser resume produce only the latest playback', async () => {
  const resumeGate = deferred();
  const app = harness({ state: 'suspended', resumeGate });
  app.player.select(bytes(42));
  const earlier = app.player.play();
  const latest = app.player.play();
  await flush();
  assert.equal(app.sources.length, 0);
  assert.equal(app.contexts[0].resumes, 1, 'Concurrent alerts share the pending resume.');
  resumeGate.resolve();
  assert.equal(await earlier, false);
  assert.equal(await latest, true);
  assert.equal(app.sources.length, 1);
  app.player.stop();
});

test('stop cancels a playback waiting for the browser to resume audio', async () => {
  const resumeGate = deferred();
  const app = harness({ state: 'suspended', resumeGate });
  app.player.select(bytes(42));
  const pending = app.player.play();
  await flush();
  app.player.stop();
  resumeGate.resolve();
  assert.equal(await pending, false);
  assert.equal(app.sources.length, 0);
});

test('a closed audio context is recreated and the selected custom clip remains available', async () => {
  const app = harness();
  app.player.setVolume(0.4);
  app.player.select(bytes(42));
  await app.player.play();
  app.sources[0].finish();
  app.contexts[0].state = 'closed';
  await app.player.play();
  assert.equal(app.contexts.length, 2);
  assert.equal(app.sources[1].buffer.identity, 42);
  assert.equal(app.player.gain.gain.value, 0.4);
  app.player.stop();
});

test('a late default audio fetch cannot replace a newly selected custom clip', async () => {
  const download = deferred();
  const app = harness({ loadDefault: () => download.promise });
  const preparing = app.player.prepare();
  await flush();
  const clip = await app.player.decode(bytes(42));
  app.player.select(bytes(42), clip);
  download.resolve(bytes(0));
  await preparing;
  await app.player.play();
  assert.equal(app.sources.length, 1);
  assert.equal(app.sources[0].buffer, clip);
  app.player.stop();
});

test('playback checks whether its session is still allowed after asynchronous setup', async () => {
  const download = deferred();
  const app = harness({ loadDefault: () => download.promise });
  let allowed = true;
  const pending = app.player.play(() => allowed);
  await flush();
  allowed = false;
  download.resolve(bytes(0));
  assert.equal(await pending, false);
  assert.equal(app.sources.length, 0);
});
