import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioStore } from '../public/audio-store.js';

const recording = () => ({
  name: 'my-reminder.wav', bytes: new Uint8Array([82, 73, 70, 70]).buffer,
  type: 'audio/wav', duration: 3,
});
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// An IndexedDB boundary substitute: requests succeed before transactions
// commit, writes clone the input and only become durable after a commit.
function fakeIndexedDB({ automatic = true } = {}) {
  const data = new Map(), transactions = [], connections = [], opens = [];
  const state = { automatic, blocked: false, silent: false, openError: null };
  let created = false;
  const indexedDB = {
    open(name, version) {
      assert.equal(name, 'phone-away'); assert.equal(version, 1);
      const request = {};
      opens.push(request);
      queueMicrotask(() => {
        if (state.silent) return;
        if (state.blocked) { request.onblocked?.(); return; }
        if (state.openError) { request.error = state.openError; request.onerror?.(); return; }
        const database = {
          closed: false,
          objectStoreNames: { contains: name => created && name === 'audio' },
          createObjectStore(name) { assert.equal(name, 'audio'); created = true; },
          close() { this.closed = true; },
          transaction(name, mode) {
            assert.equal(name, 'audio');
            const changes = [];
            const transaction = {
              done: false, mode,
              commit() {
                if (this.done) return;
                this.done = true;
                changes.forEach(change => change());
                this.oncomplete?.();
              },
              abort(error = new DOMException('Aborted', 'AbortError')) {
                if (this.done) return;
                this.done = true;
                this.error = error;
                queueMicrotask(() => this.onabort?.());
              },
              objectStore(name) {
                assert.equal(name, 'audio');
                function makeRequest(result, change) {
                  const operation = {};
                  if (change) changes.push(change);
                  queueMicrotask(() => {
                    operation.result = result;
                    operation.onsuccess?.();
                    if (state.automatic) queueMicrotask(() => transaction.commit());
                  });
                  return operation;
                }
                return {
                  get(key) { return makeRequest(structuredClone(data.get(key))); },
                  put(value, key) {
                    assert.equal(mode, 'readwrite');
                    const copied = structuredClone(value);
                    return makeRequest(key, () => data.set(key, copied));
                  },
                  delete(key) {
                    assert.equal(mode, 'readwrite');
                    return makeRequest(undefined, () => data.delete(key));
                  },
                };
              },
            };
            transactions.push(transaction);
            return transaction;
          },
        };
        request.result = database;
        connections.push(database);
        if (!created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { indexedDB, data, transactions, connections, opens, state };
}

test('custom bytes and metadata survive new store instances; clear restores an empty store', async () => {
  const fake = fakeIndexedDB();
  assert.equal(await createAudioStore(fake.indexedDB).load(), null);
  const file = recording();
  await createAudioStore(fake.indexedDB).save(file);
  const saved = await createAudioStore(fake.indexedDB).load();
  assert.deepEqual(saved, file);
  assert.notEqual(saved.bytes, file.bytes, 'Store retains independent original bytes.');
  new Uint8Array(saved.bytes)[0] = 0;
  assert.deepEqual(await createAudioStore(fake.indexedDB).load(), file);
  await createAudioStore(fake.indexedDB).clear();
  assert.equal(await createAudioStore(fake.indexedDB).load(), null);
  assert.ok(fake.connections.every(connection => connection.closed));
});

test('a successful write request is not reported saved until its transaction commits', async () => {
  const fake = fakeIndexedDB({ automatic: false });
  let resolved = false;
  const saving = createAudioStore(fake.indexedDB).save(recording()).then(() => { resolved = true; });
  await flush();
  assert.equal(resolved, false);
  assert.equal(fake.data.size, 0);
  fake.transactions[0].commit();
  await saving;
  assert.equal(resolved, true);
  assert.deepEqual(fake.data.get('custom'), recording());
});

test('a transaction abort rejects and preserves the previous audio', async () => {
  const fake = fakeIndexedDB();
  const store = createAudioStore(fake.indexedDB);
  await store.save(recording());
  fake.state.automatic = false;
  const saving = store.save({ ...recording(), name: 'replacement.wav' });
  const rejected = assert.rejects(saving, /storage is full/);
  await flush();
  fake.transactions.at(-1).abort(new DOMException('Quota', 'QuotaExceededError'));
  await rejected;
  fake.state.automatic = true;
  assert.equal((await store.load()).name, 'my-reminder.wav');
  assert.ok(fake.connections.every(connection => connection.closed));
});

test('unavailable, denied and blocked storage reject with actionable messages', async () => {
  await assert.rejects(createAudioStore(null).load(), /local storage enabled/);
  const fake = fakeIndexedDB();
  fake.state.openError = new DOMException('Disabled', 'SecurityError');
  await assert.rejects(createAudioStore(fake.indexedDB).save(recording()), /Allow local storage/);
  fake.state.openError = null;
  fake.state.blocked = true;
  await assert.rejects(createAudioStore(fake.indexedDB).load(), /Close other Phone Away tabs/);
});

test('an unresponsive browser storage request times out, and a late connection is closed', async () => {
  const fake = fakeIndexedDB();
  fake.state.silent = true;
  await assert.rejects(createAudioStore(fake.indexedDB).load(), /took too long to open/);
  const lateDatabase = { closed: false, close() { this.closed = true; } };
  fake.opens[0].result = lateDatabase;
  fake.opens[0].onsuccess();
  assert.equal(lateDatabase.closed, true);
});

test('invalid audio is rejected before writing, without replacing existing audio', async () => {
  const fake = fakeIndexedDB();
  const store = createAudioStore(fake.indexedDB);
  await store.save(recording());
  for (const record of [
    { ...recording(), duration: 31 }, { ...recording(), duration: NaN },
    { ...recording(), bytes: new ArrayBuffer(10 * 1024 * 1024 + 1) },
    { ...recording(), bytes: new ArrayBuffer(0) },
  ]) await assert.rejects(store.save(record), /invalid/);
  assert.deepEqual(await store.load(), recording());
  assert.equal(fake.transactions.length, 2, 'Invalid input never opens a write transaction.');
});

test('corrupt persisted data is rejected so the caller can retain its default', async () => {
  const fake = fakeIndexedDB();
  fake.data.set('custom', { ...recording(), bytes: 'broken' });
  await assert.rejects(createAudioStore(fake.indexedDB).load(), /saved audio is invalid/);
  assert.equal(fake.data.get('custom').bytes, 'broken', 'Loading never overwrites storage.');
});
