import { LocalDetector, IncidentGate } from './detection.js';
import { AlertAudioPlayer } from './audio-player.js';
import { createAudioStore } from './audio-store.js';

const $ = id => document.getElementById(id);
const video = $('camera');
const overlay = $('overlay');
const capture = document.createElement('canvas');
const detector = new LocalDetector();
let gate = makeGate();
let phase = 'idle', isDemo = false, stream = null, timer = null, epoch = 0;
let elapsed = 0, activeSince = 0, nudges = 0, checks = 0, consecutiveErrors = 0;
let previewHidden = false, demoStep = 0;
let localAnalysis = null;
let setupReady = false;
let soundEnabled = true, audioBusy = false, customAudio = null;
const audioStore = createAudioStore();
const audioPlayer = new AlertAudioPlayer({
  createContext: () => {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error('This browser does not support audio playback.');
    return new Context();
  },
  loadDefault: async () => {
    const response = await fetch('/audio/phone-away.wav');
    if (!response.ok) throw new Error('The sample audio file is missing.');
    return response.arrayBuffer();
  },
  onPlaying: playing => document.querySelector('.audio-card').classList.toggle('is-playing', playing),
});
const settings = [$('delay'), $('sensitivity'), $('camera-select'), $('speed')];
const checkIntervals = {fast: 100, balanced: 200, economy: 500};

function makeGate() {
  // A brief missed detection must not rearm an alert at video-rate cadence.
  return new IncidentGate({holdMs: Number($('delay').value), clearMs: 1000,
    confidence: Number($('sensitivity').value), maxGapMs: 15000});
}

function message(text, kind = 'error') {
  $('message').textContent = text;
  $('message').className = `message ${kind === 'info' ? 'info' : ''}`;
  $('message').hidden = !text;
}
function sessionMs() { return elapsed + (activeSince ? performance.now() - activeSince : 0); }
function formatTime(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function renderTimer() {
  const [minutes, seconds] = formatTime(sessionMs()).split(':');
  $('session-time').replaceChildren(document.createTextNode(minutes), Object.assign(document.createElement('span'), {textContent: ':'}), document.createTextNode(seconds));
}
setInterval(renderTimer, 500);

function renderSession() {
  const busy = phase === 'starting';
  const running = phase === 'running';
  $('start-button').disabled = busy || !setupReady || (audioBusy && !running);
  $('demo-button').disabled = !setupReady || audioBusy;
  $('audio-upload').disabled = !setupReady || audioBusy;
  $('audio-reset').disabled = !setupReady || audioBusy;
  $('test-audio').disabled = !setupReady || audioBusy;
  $('start-label').textContent = !setupReady ? 'Checking setup…' : busy ? 'Starting…' : running ? 'Pause' : phase === 'paused' ? 'Resume' : 'Start monitoring';
  $('end-button').hidden = phase === 'idle';
  settings.forEach(input => { input.disabled = phase !== 'idle'; });
  $('demo-button').hidden = phase !== 'idle';
  $('camera-status').classList.toggle('active', running);
  $('camera-status').replaceChildren(Object.assign(document.createElement('span'), {className:'dot'}), document.createTextNode(busy ? 'Starting…' : running ? (isDemo ? 'Demo active' : 'Camera on') : phase === 'paused' ? 'Paused' : 'Camera off'));
  $('session-status').textContent = running ? (isDemo ? 'TEST' : 'ACTIVE') : phase === 'paused' ? 'PAUSED' : busy ? 'STARTING' : 'READY';
  document.querySelector('.session-card h2').textContent = running ? (isDemo ? 'Alert test' : 'Monitoring') : phase === 'paused' ? 'Paused' : 'Session';
  $('start-hint').textContent = running ? (isDemo ? 'Simulated detection. Camera off.' : 'Monitoring continues when you switch tabs.') : phase === 'paused' ? 'Camera off. Resume to continue.' : !setupReady ? 'Restoring saved audio…' : 'Camera turns on when you start.';
  $('hide-preview').hidden = !running || isDemo;
  $('live-label').hidden = !running;
  $('live-label').replaceChildren(Object.assign(document.createElement('span'), {className:'dot'}), document.createTextNode(isDemo ? 'DEMO · SIMULATED SIGNALS' : 'LIVE · ON THIS DEVICE'));
}

async function prepareAudio() {
  audioPlayer.setVolume(Number($('volume').value) / 100);
  await audioPlayer.prepare();
}
function stopAudio() { audioPlayer.stop(); }
async function playCallout(test = false) {
  if (!test && !soundEnabled) return;
  try {
    audioPlayer.setVolume(Number($('volume').value) / 100);
    return await audioPlayer.play(() => test || (soundEnabled && phase === 'running'));
  } catch (error) { message(`Audio couldn’t play: ${error.message} Use the play button to enable it.`); }
}

function renderAudioSelection() {
  $('audio-name').textContent = customAudio ? customAudio.name : 'Goat scream';
  $('audio-detail').textContent = customAudio
    ? `${customAudio.duration.toFixed(1)} seconds · ${customAudio.saved ? 'Saved in this browser' : 'Not saved — this session only'}`
    : 'Default audio · 1.8 seconds';
  $('audio-reset').hidden = !customAudio;
}

async function restoreAudio() {
  try {
    const saved = await audioStore.load();
    if (saved) {
      customAudio = {...saved, saved: true};
      audioPlayer.select(saved.bytes);
    }
  } catch (error) { message(`Couldn’t restore saved audio. ${error.message}`); }
  renderAudioSelection();
}

async function listCameras() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
    const selected = $('camera-select').value;
    $('camera-select').replaceChildren(new Option('Default camera', ''));
    devices.forEach((device, index) => $('camera-select').add(new Option(device.label || `Camera ${index + 1}`, device.deviceId)));
    if (devices.some(device => device.deviceId === selected)) $('camera-select').value = selected;
  } catch { /* Camera names are optional before permission is granted. */ }
}
function clearCamera() {
  if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
  video.srcObject = null;
  overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  $('camera-stage').classList.remove('is-live', 'preview-hidden', 'demo');
  $('camera-idle').hidden = false;
  $('detection-banner').hidden = true;
  $('stage-title').textContent = phase === 'paused' ? 'Monitoring paused' : 'Camera off';
  $('stage-description').textContent = phase === 'paused' ? 'Resume to continue checking.' : 'Start monitoring to detect phone use.';
  previewHidden = false; $('hide-preview').textContent = 'Hide preview';
}
function cancelLoop() {
  epoch++; clearTimeout(timer);
  gate.invalidate(performance.now()); stopAudio();
  if (activeSince) { elapsed += performance.now() - activeSince; activeSince = 0; }
}
function pauseSession(reason = '') {
  if (!['running', 'starting'].includes(phase)) return;
  phase = 'paused'; cancelLoop(); clearCamera(); renderSession();
  $('frame-caption').textContent = 'PAUSED';
  if (reason) message(reason, 'info');
}
function endSession() {
  phase = 'idle'; cancelLoop(); clearCamera(); renderSession(); gate.reset();
  $('frame-caption').textContent = 'READY';
  message('');
}

async function startSession(demo = false) {
  if (!setupReady || (audioBusy && phase !== 'running')) return;
  if (phase === 'running') { pauseSession(); return; }
  if (phase === 'starting') return;
  const fresh = phase === 'idle';
  if (fresh) {
    isDemo = demo; elapsed = 0; nudges = 0; checks = 0; demoStep = 0; gate = makeGate();
    $('nudge-count').textContent = '0'; $('checks-count').textContent = '0';
    $('latency-value').textContent = '—'; $('result-value').textContent = 'No checks yet';
  }
  phase = 'starting'; renderSession(); message('');
  const token = ++epoch;
  // Resume the audio context directly from the user gesture, before model/camera awaits.
  const audioReady = prepareAudio().catch(error => { message(`Camera detection is available, but audio setup failed: ${error.message}`); });
  try {
    if (!isDemo) {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires a supported browser on localhost. Open this app in Chrome or Safari.');
      await detector.load(progress => { if (token === epoch) $('start-hint').textContent = progress; });
      if (token !== epoch) return;
      const deviceId = $('camera-select').value;
      $('start-hint').textContent = 'Allow camera access in your browser’s permission prompt.';
      const newStream = await navigator.mediaDevices.getUserMedia({audio:false, video:{width:{ideal:960},height:{ideal:720},facingMode:'user', ...(deviceId ? {deviceId:{exact:deviceId}} : {})}});
      if (token !== epoch) { newStream.getTracks().forEach(track => track.stop()); return; }
      stream = newStream; video.srcObject = stream;
      await video.play();
      if (token !== epoch) return;
      stream.getVideoTracks()[0].addEventListener('ended', () => { if (phase === 'running') pauseSession('The camera disconnected. Check the camera and resume when ready.'); });
      await listCameras();
      if (token !== epoch) return;
      $('camera-stage').classList.add('is-live'); $('camera-idle').hidden = true;
    } else {
      $('camera-stage').classList.add('demo'); $('stage-title').textContent = 'Testing alert';
      $('stage-description').textContent = 'Simulated phone detection. Camera off.';
    }
    await audioReady;
    if (token !== epoch) return;
    phase = 'running'; activeSince = performance.now(); consecutiveErrors = 0; gate.invalidate(performance.now()); renderSession();
    runLoop(token);
  } catch (error) {
    if (token !== epoch) return;
    phase = fresh ? 'idle' : 'paused'; cancelLoop(); clearCamera(); renderSession();
    const explanations = {NotAllowedError:'Camera access wasn’t allowed. Enable camera access in your browser’s site settings, then try again.',NotFoundError:'No camera was found. Connect a camera, then try again.',NotReadableError:'The camera is busy or unavailable. Close other camera apps and try again.',OverconstrainedError:'The selected camera is unavailable. Choose the default camera and try again.'};
    let detail = explanations[error.name] || error.message || 'The session couldn’t start. Please try again.';
    if (error.message?.includes('Local vision took too long')) {
      detail = 'The local detector timed out. Reload the page and try again in a recent Chrome browser.';
    }
    message(detail);
  }
}

async function analyzeFrame() {
  if (!video.videoWidth || video.readyState < 2) throw new Error('Waiting for a camera frame.');
  const width = 640, height = Math.round(video.videoHeight / video.videoWidth * width);
  capture.width = width; capture.height = height;
  capture.getContext('2d').drawImage(video, 0, 0, width, height);
  const pending = detector.detect(capture);
  localAnalysis = pending;
  try {
    const result = await pending;
    if (typeof result?.phoneUse !== 'boolean' || !Number.isFinite(result.confidence)) {
      throw new Error('The local detector returned an invalid result.');
    }
    return result;
  } finally { if (localAnalysis === pending) localAnalysis = null; }
}

function drawBoxes(boxes = []) {
  overlay.width = capture.width || 640; overlay.height = capture.height || 480;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  for (const box of boxes) {
    if (box.label !== 'cell phone') continue;
    if (!Array.isArray(box.bbox) || box.bbox.length !== 4 || !box.bbox.every(Number.isFinite)) continue;
    const [rawX,y,w,h] = box.bbox;
    if (w <= 0 || h <= 0) continue;
    // Only the video is CSS-mirrored. Mirror box coordinates here so labels
    // stay readable while the outline follows the mirrored camera image.
    const x = overlay.width - rawX - w;
    ctx.strokeStyle = '#000'; ctx.lineWidth = 5; ctx.strokeRect(x,y,w,h);
    ctx.strokeStyle = '#ffd43b'; ctx.lineWidth = 2.5; ctx.strokeRect(x,y,w,h);
    const confidence = box.score ?? box.confidence;
    const label = Number.isFinite(confidence) ? `Phone ${Math.round(confidence * 100)}%` : 'Phone';
    ctx.font = '600 13px system-ui, sans-serif';
    const labelWidth = ctx.measureText(label).width + 12;
    const labelX = Math.max(0, Math.min(x, overlay.width - labelWidth));
    const labelY = Math.max(0, y - 24);
    ctx.fillStyle = '#ffd43b'; ctx.fillRect(labelX, labelY, labelWidth, 22);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'middle'; ctx.fillText(label, labelX + 6, labelY + 11);
  }
}
function renderDetection(result, state) {
  $('checks-count').textContent = String(checks);
  const uncertain = result.uncertain === true || (result.phoneUse && result.confidence < Number($('sensitivity').value));
  $('frame-caption').textContent = uncertain ? 'UNCERTAIN · WAITING' : state.state === 'clear' ? 'NO PHONE USE · ALERT READY' : `${Math.round(result.confidence * 100)}% · PHONE SIGNAL`;
  $('detection-banner').hidden = state.state === 'clear';
  $('detection-progress').style.width = `${state.progress * 100}%`;
  const labels = {
    confirming:['Phone detected', 'Confirming sustained phone use…'],
    alerted:['Phone use confirmed', soundEnabled ? 'Alert sent. Put the phone away to enable the next alert.' : 'Audio off. Put the phone away to enable the next alert.'],
    clearing:['Resetting alert', 'Confirming one second without phone use.'],
  };
  if (labels[state.state]) { $('detection-title').textContent = labels[state.state][0]; $('detection-description').textContent = labels[state.state][1]; }
  if (state.trigger) {
    nudges++; $('nudge-count').textContent = String(nudges);
    playCallout();
  }
}
async function runLoop(token) {
  if (token !== epoch || phase !== 'running') return;
  // A paused local check can finish in its worker. Wait before capturing the
  // resumed session's frame, so even pause/resume cannot queue stale images.
  if (!isDemo && localAnalysis) {
    try { await localAnalysis; } catch { /* The previous session owns its error. */ }
    if (token !== epoch || phase !== 'running') return;
  }
  // Capture only when ready to analyze. A photo backlog would make alerts stale.
  const startedAt = performance.now();
  try {
    let result;
    if (isDemo) {
      // A short clear lead-in, one continuous incident, then enough clear frames to rearm.
      demoStep++;
      const phone = demoStep >= 3 && demoStep <= Math.ceil(Number($('delay').value) / 1000) + 7;
      result = {phoneUse:phone, confidence:phone ? .92 : 1, reason:'Simulated phone signal for the camera-free demo.'};
      if (!phone && demoStep > 4) { $('stage-title').textContent = 'Phone cleared'; $('stage-description').textContent = 'Waiting to rearm the alert.'; }
    } else {
      if (checks === 0) $('frame-caption').textContent = 'CHECKING FRAME…';
      result = await analyzeFrame();
    }
    if (token !== epoch || phase !== 'running') return;
    if (consecutiveErrors) message('');
    consecutiveErrors = 0; checks++;
    const latency = performance.now() - startedAt;
    $('latency-value').textContent = isDemo ? 'Test' : `${Math.round(latency)} ms`;
    $('result-value').textContent = result.reason || (result.phoneUse ? 'Phone detected' : 'No phone detected');
    drawBoxes(result.boxes);
    const uncertainVision = result.uncertain === true;
    // Dwell is measured between photographed moments, not variable response times.
    const state = uncertainVision ? gate.invalidate(startedAt) : gate.update(result, startedAt);
    renderDetection(result, state);
    if (isDemo && demoStep > Math.ceil(Number($('delay').value) / 1000) + 13) {
      endSession(); message('Test complete: one alert for one phone-use incident.', 'info'); return;
    }
  } catch (error) {
    if (token !== epoch || phase !== 'running') return;
    gate.invalidate(performance.now()); consecutiveErrors++;
    drawBoxes([]);
    $('frame-caption').textContent = 'CHECK FAILED · RETRYING';
    const detail = error.message || 'The local detector could not check this frame.';
    $('latency-value').textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)} s`;
    $('result-value').textContent = 'Check failed';
    if (consecutiveErrors >= 3) { pauseSession(); message(`Monitoring paused after three failed checks. ${detail}`); return; }
    message(`A frame couldn’t be checked. Retrying (${consecutiveErrors}/3). ${detail}`);
  }
  if (token === epoch && phase === 'running') {
    // Start-to-start cadence includes model time: no extra 5-second wait after
    // a response, no overlapping requests, and no burst of queued old photos.
    const interval = isDemo ? 1000 : (checkIntervals[$('speed').value] || checkIntervals.fast);
    const delay = consecutiveErrors
      ? 5000 * 2 ** (consecutiveErrors - 1)
      : Math.max(0, interval - (performance.now() - startedAt));
    timer = setTimeout(() => runLoop(token), delay);
  }
}

$('start-button').addEventListener('click', () => startSession());
$('end-button').addEventListener('click', endSession);
$('demo-button').addEventListener('click', () => startSession(true));
$('delay').addEventListener('change', () => { gate = makeGate(); });
$('sensitivity').addEventListener('change', () => { gate = makeGate(); });
$('test-audio').addEventListener('click', () => playCallout(true));
$('audio-toggle').addEventListener('click', () => { soundEnabled = !soundEnabled; $('audio-toggle').setAttribute('aria-checked', String(soundEnabled)); if (!soundEnabled) stopAudio(); });
$('volume').addEventListener('input', () => { $('volume-value').textContent = `${$('volume').value}%`; audioPlayer.setVolume(Number($('volume').value) / 100); });
$('audio-upload').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  if (audioBusy || !setupReady) return;
  audioBusy = true; renderSession();
  try {
    if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('Choose a nonempty audio file up to 10 MB.');
    const bytes = await file.arrayBuffer();
    const decoded = await audioPlayer.decode(bytes);
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 30) throw new Error('Choose audio between 0 and 30 seconds long.');
    const record = {name: file.name, bytes, type: file.type || 'application/octet-stream', duration: decoded.duration};
    let storageError;
    try { await audioStore.save(record); } catch (error) { storageError = error; }
    customAudio = {...record, saved: !storageError};
    audioPlayer.select(bytes, decoded);
    renderAudioSelection();
    if (storageError) message(`Audio is ready for this session, but could not be saved. ${storageError.message} Refreshing will restore your previous audio.`);
    else message('Audio saved in this browser. It will be restored after a refresh.', 'info');
  } catch (error) { message(`Couldn’t use this audio file. ${error.message}`); }
  finally { audioBusy = false; event.target.value = ''; renderSession(); }
});
$('audio-reset').addEventListener('click', async () => {
  if (audioBusy || !setupReady) return;
  audioBusy = true; renderSession();
  try {
    await audioStore.clear();
    customAudio = null; audioPlayer.select(); renderAudioSelection();
    message('Default audio selected.', 'info');
  } catch (error) { message(`Couldn’t reset saved audio. ${error.message}`); }
  finally { audioBusy = false; renderSession(); }
});
$('hide-preview').addEventListener('click', () => { previewHidden = !previewHidden; $('camera-stage').classList.toggle('preview-hidden', previewHidden); $('hide-preview').textContent = previewHidden ? 'Show preview' : 'Hide preview'; });
const showHelp = () => $('help-dialog').showModal();
$('how-button').addEventListener('click', showHelp);
$('close-help').addEventListener('click', () => $('help-dialog').close());
$('help-dialog').addEventListener('click', event => { if (event.target === $('help-dialog')) { const rect = $('help-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('help-dialog').close(); } });
// Tab visibility does not change the session. Leaving the page itself still
// releases the camera and cancels pending detection and audio.
window.addEventListener('pagehide', () => {
  if (['running', 'starting'].includes(phase)) pauseSession();
  else { cancelLoop(); clearCamera(); }
  detector.dispose();
});
navigator.mediaDevices?.addEventListener?.('devicechange', listCameras);
async function initialize() {
  renderSession();
  await restoreAudio();
  setupReady = true;
  renderSession();
}
initialize();
