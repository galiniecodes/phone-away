/** Reusable decoded audio; each playback gets its own one-shot source node. */
export class AlertAudioPlayer {
  constructor({ createContext, loadDefault, onPlaying = () => {} } = {}) {
    this.createContext = createContext || (() => {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Context) throw new Error('This browser does not support audio playback.');
      return new Context();
    });
    this.loadDefault = loadDefault || (async () => {
      const response = await fetch('/audio/phone-away.wav');
      if (!response.ok) throw new Error('The sample audio file is missing.');
      return response.arrayBuffer();
    });
    this.onPlaying = onPlaying;
    this.context = null;
    this.gain = null;
    this.source = null;
    this.buffer = null;
    this.bytes = null;
    this.loading = null;
    this.resumePending = null;
    this.volume = 0.75;
    this.revision = 0;
    this.playRequest = 0;
  }

  _context() {
    if (!this.context || this.context.state === 'closed') {
      this.context = this.createContext();
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      this.gain.gain.value = this.volume;
      this.resumePending = null;
    }
    return this.context;
  }

  async _resume() {
    const context = this._context();
    if (context.state === 'running') return;
    if (!this.resumePending) {
      let timeout;
      const pending = Promise.race([
        context.resume(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Audio is blocked. Press Play audio to enable it.')), 3000); }),
      ]).then(() => {
        if (context.state && context.state !== 'running') throw new Error('Audio is paused by the browser. Press Play audio to enable it.');
      }).finally(() => {
        clearTimeout(timeout);
        if (this.resumePending === pending) this.resumePending = null;
      });
      this.resumePending = pending;
    }
    await this.resumePending;
  }

  async decode(bytes) {
    // decodeAudioData may detach its argument. Keep the original bytes for storage.
    return this._context().decodeAudioData(bytes.slice(0));
  }

  select(bytes = null, decoded = null) {
    this.stop();
    this.revision++;
    this.bytes = bytes;
    this.buffer = decoded;
    this.loading = null;
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  async prepare() {
    // Called directly by Start/Play so the browser receives the user gesture.
    await this._resume();
    while (!this.buffer) {
      if (!this.loading) {
        const revision = this.revision;
        const bytes = this.bytes;
        const loading = (async () => {
          const buffer = await this.decode(bytes || await this.loadDefault());
          // A late sample fetch must not overwrite a newly selected custom clip.
          if (revision === this.revision) this.buffer = buffer;
        })().finally(() => { if (this.loading === loading) this.loading = null; });
        this.loading = loading;
      }
      await this.loading;
    }
  }

  _stopSource() {
    const source = this.source;
    this.source = null;
    if (source) {
      source.onended = null;
      try { source.stop(); } catch {}
      source.disconnect?.();
    }
    this.onPlaying(false);
  }

  stop() {
    this.playRequest++; // Explicit pause/mute/replacement cancels pending playback.
    this._stopSource();
  }

  async play(allowed = () => true) {
    const request = ++this.playRequest;
    await this.prepare();
    // If several calls waited for resume/decode, the newest alert owns playback.
    if (request !== this.playRequest || !allowed()) return false;
    this._stopSource(); // Starting a clip does not invalidate pending requests.
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.loop = false;
    source.connect(this.gain);
    this.source = source;
    source.onended = () => {
      source.disconnect?.();
      if (this.source === source) {
        this.source = null;
        this.onPlaying(false);
      }
    };
    try {
      source.start(0); // Always replay from the beginning, including after onended.
      this.onPlaying(true);
      return true;
    } catch (error) {
      this._stopSource();
      throw error;
    }
  }
}
