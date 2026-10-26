/** Store the original custom audio locally, separately from decoded playback buffers. */
const DATABASE = 'phone-away';
const STORE = 'audio';
const KEY = 'custom';
const TIMEOUT_MS = 3000;
const MAX_BYTES = 10 * 1024 * 1024;

function storageError(error) {
  if (error?.name === 'QuotaExceededError') {
    return new Error('Browser storage is full. Free some space and upload the audio again.');
  }
  return new Error('Custom audio could not be saved or loaded. Allow local storage for this site and try again.');
}

function validate(record) {
  if (!record || typeof record.name !== 'string' || !record.name
    || typeof record.type !== 'string' || !(record.bytes instanceof ArrayBuffer)
    || !record.bytes.byteLength || record.bytes.byteLength > MAX_BYTES
    || !Number.isFinite(record.duration) || record.duration <= 0 || record.duration > 30) {
    throw new Error('The saved audio is invalid. Upload an audio file under 10 MB and up to 30 seconds.');
  }
  return { name: record.name, bytes: record.bytes, type: record.type, duration: record.duration };
}

export function createAudioStore(indexedDB = globalThis.indexedDB) {
  function open() {
    return new Promise((resolve, reject) => {
      if (!indexedDB) {
        reject(new Error('This browser cannot save custom audio. Use a browser with local storage enabled.'));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => fail(new Error('Audio storage took too long to open. Close other Phone Away tabs and try again.')), TIMEOUT_MS);
      function fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
      try {
        const request = indexedDB.open(DATABASE, 1);
        request.onblocked = () => fail(new Error('Audio storage is blocked. Close other Phone Away tabs and try again.'));
        request.onerror = () => fail(storageError(request.error));
        request.onupgradeneeded = () => {
          if (settled) { request.transaction?.abort(); return; }
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
        };
        request.onsuccess = () => {
          const database = request.result;
          if (settled) { database.close(); return; }
          settled = true;
          clearTimeout(timer);
          database.onversionchange = () => database.close();
          resolve(database);
        };
      } catch (error) { fail(storageError(error)); }
    });
  }

  async function transact(mode, operation) {
    const database = await open();
    return new Promise((resolve, reject) => {
      let transaction, request, settled = false;
      const timer = setTimeout(() => {
        try { transaction?.abort(); } catch { /* It may already have finished. */ }
        finish(new Error('Audio storage took too long. Try uploading the audio again.'));
      }, TIMEOUT_MS);
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        database.close();
        error ? reject(error) : resolve(request.result);
      }
      try {
        transaction = database.transaction(STORE, mode);
        // A successful put request can still roll back. Only a committed
        // transaction means the audio will survive the next page load.
        transaction.oncomplete = () => finish();
        transaction.onabort = () => finish(storageError(transaction.error || request?.error));
        request = operation(transaction.objectStore(STORE));
      } catch (error) {
        try { transaction?.abort(); } catch { /* It may already have finished. */ }
        finish(storageError(error));
      }
    });
  }

  return {
    async load() {
      const record = await transact('readonly', store => store.get(KEY));
      return record == null ? null : validate(record);
    },
    async save(record) {
      const checked = validate(record);
      await transact('readwrite', store => store.put(checked, KEY));
    },
    async clear() {
      await transact('readwrite', store => store.delete(KEY));
    },
  };
}
