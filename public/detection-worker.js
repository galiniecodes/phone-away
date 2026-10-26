/*
 * Dedicated classic worker: MediaPipe's WASM loader needs importScripts.
 * ES modules are imported dynamically, so neither library blocks the UI.
 * Every asset is same-origin. Camera pixels are never fetched, saved or sent.
 */
let ort;
let helpers;
let session;
let handLandmarker;
let backend = 'wasm';
let handBackend = 'cpu';
let busy = false;
let inputWidth = 640;
let inputHeight = 640;
let frameCanvas;
let frameContext;
let modelCanvas;
let modelContext;
let handCanvas;
let tensorPixels;
let lastHandTimestamp = 0;

const asset = path => new URL(path, self.location.href).href;
const progress = (id, message) => self.postMessage({ id, type: 'progress', message });

self.onmessage = ({ data }) => {
  // The client submits the newest frame only after the previous result.
  // Reject accidental overlap instead of building a stale camera-frame queue.
  if (busy) {
    self.postMessage({ id: data.id, type: 'error', error: 'Local vision is still processing the previous frame.' });
    return;
  }
  busy = true;
  handle(data).finally(() => { busy = false; });
};

async function handle({ id, action, width, height, pixels }) {
  try {
    let result;
    if (action === 'load') {
      if (!session || !handLandmarker) await load(id);
      result = { ready: true, backend, handBackend, inputWidth, inputHeight };
    } else if (action === 'detect') {
      if (!session || !handLandmarker) throw new Error('Local vision is not ready yet.');
      if (!Number.isInteger(width) || !Number.isInteger(height)
        || width < 1 || height < 1 || width > 4096 || height > 4096
        || !(pixels instanceof ArrayBuffer) || pixels.byteLength !== width * height * 4) {
        throw new Error('The camera frame could not be read.');
      }
      result = await detect(width, height, pixels);
    } else if (action === 'dispose') {
      await dispose();
      result = { disposed: true };
    } else {
      throw new Error('Unknown local vision request.');
    }
    self.postMessage({ id, type: 'result', result });
  } catch (error) {
    if (action === 'load') await dispose();
    self.postMessage({ id, type: 'error', error: error?.message || 'Local vision failed.' });
  }
}

async function createSession(provider) {
  const next = await ort.InferenceSession.create(asset('./models/yolo26/yolo26n.onnx'), {
    executionProviders: provider === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
    graphOptimizationLevel: 'all',
  });
  // The bundled export uses images: float32[1,3,640,640]. Read metadata where
  // the runtime exposes it; reject a mismatched export rather than stretching.
  const metadata = Array.isArray(next.inputMetadata)
    ? next.inputMetadata[0] : next.inputMetadata?.[next.inputNames[0]];
  const shape = metadata?.shape ?? metadata?.dimensions;
  if (shape && (shape.length !== 4 || shape[0] !== 1 || shape[1] !== 3
    || !Number.isInteger(shape[2]) || !Number.isInteger(shape[3]))) {
    await next.release();
    throw new Error('The local phone model has unsupported input dimensions.');
  }
  if (shape) [inputHeight, inputWidth] = [shape[2], shape[3]];
  return next;
}

async function load(id) {
  if (typeof OffscreenCanvas !== 'function') {
    throw new Error('This browser does not support local vision workers. Try a recent Chrome browser.');
  }
  progress(id, 'Loading YOLO26 and hand tracking…');
  const modules = await Promise.all([
    import('./vendor/onnxruntime/ort.webgpu.min.mjs'),
    import('./vendor/mediapipe/vision_bundle.mjs'),
    import('./realtime-vision.js'),
  ]);
  ort = modules[0];
  const { FilesetResolver, HandLandmarker } = modules[1];
  helpers = modules[2];
  ort.env.wasm.wasmPaths = asset('./vendor/onnxruntime/');
  // Single-threaded WASM works without cross-origin isolation headers and
  // remains in this worker, leaving camera preview and audio responsive.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;

  if (self.navigator?.gpu) {
    try {
      progress(id, 'Preparing GPU phone detection…');
      session = await createSession('webgpu');
      backend = 'webgpu';
      await warmup();
    } catch {
      try { await session?.release(); } catch { /* A lost GPU still permits CPU fallback. */ }
      session = null;
    }
  }
  if (!session) {
    progress(id, 'Preparing CPU phone detection…');
    session = await createSession('wasm');
    backend = 'wasm';
    await warmup();
  }
  modelCanvas = new OffscreenCanvas(inputWidth, inputHeight);
  modelContext = modelCanvas.getContext('2d', { willReadFrequently: true });
  frameCanvas = new OffscreenCanvas(640, 480);
  frameContext = frameCanvas.getContext('2d', { willReadFrequently: true });
  if (!modelContext || !frameContext) throw new Error('Could not prepare local camera processing.');
  // An opaque blank image exercises the actual hand input/inference path
  // before reporting ready; the first camera frame does not pay this cost.
  frameContext.fillStyle = '#000';
  frameContext.fillRect(0, 0, frameCanvas.width, frameCanvas.height);
  const fileset = await FilesetResolver.forVisionTasks(asset('./vendor/mediapipe/wasm'));
  await loadHands(id, HandLandmarker, fileset);
  tensorPixels = new Float32Array(inputWidth * inputHeight * 3);
  progress(id, backend === 'webgpu' ? 'Local vision ready · GPU' : 'Local vision ready · CPU');
}

async function loadHands(id, HandLandmarker, fileset) {
  const options = delegate => ({
    baseOptions: {
      modelAssetPath: asset('./models/hand_landmarker/hand_landmarker.task'),
      delegate,
    },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.35,
    minHandPresenceConfidence: 0.35,
    minTrackingConfidence: 0.5,
  });
  // MediaPipe's GPU delegate uses WebGL, separate from YOLO's WebGPU device.
  // Its canvas must not be the 2D canvas holding camera pixels.
  handCanvas = new OffscreenCanvas(1, 1);
  let supportsWorkerGL = false;
  try { supportsWorkerGL = Boolean(handCanvas.getContext('webgl2')); } catch { /* Use CPU below. */ }
  if (supportsWorkerGL) {
    try {
      progress(id, 'Preparing GPU hand tracking…');
      handLandmarker = await HandLandmarker.createFromOptions(fileset, {
        ...options('GPU'), canvas: handCanvas,
      });
      warmupHands();
      handBackend = 'gpu';
      return;
    } catch {
      closeHands();
    }
  } else {
    closeHands();
  }
  progress(id, 'Preparing CPU hand tracking…');
  handLandmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
  warmupHands();
  handBackend = 'cpu';
}

function warmupHands() {
  lastHandTimestamp = Math.max(performance.now(), lastHandTimestamp + 1);
  handLandmarker.detectForVideo(frameCanvas, lastHandTimestamp);
}

function closeHands() {
  try { handLandmarker?.close(); } catch { /* Preserve the original loading error. */ }
  handLandmarker = null;
  // A failed graph may have created GL resources before a tracker was returned.
  try { handCanvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* Already lost. */ }
  if (handCanvas) handCanvas.width = handCanvas.height = 1;
  handCanvas = null;
  lastHandTimestamp = 0;
}

async function warmup() {
  const input = new ort.Tensor('float32', new Float32Array(inputWidth * inputHeight * 3),
    [1, 3, inputHeight, inputWidth]);
  let outputs;
  try {
    outputs = await session.run({ [session.inputNames[0]]: input });
    const output = outputs[session.outputNames[0]];
    // Validates the actual output schema during startup, before the camera is used.
    helpers.decodeYoloDetections(output.data, output.dims,
      helpers.letterboxGeometry(inputWidth, inputHeight, inputWidth, inputHeight));
  } finally {
    input.dispose();
    if (outputs) Object.values(outputs).forEach(output => output.dispose());
  }
}

async function detect(width, height, pixels) {
  const started = performance.now();
  const geometry = helpers.letterboxGeometry(width, height, inputWidth, inputHeight);
  if (frameCanvas.width !== width || frameCanvas.height !== height) {
    frameCanvas.width = width;
    frameCanvas.height = height;
  }
  frameContext.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  modelContext.fillStyle = 'rgb(114, 114, 114)';
  modelContext.fillRect(0, 0, inputWidth, inputHeight);
  modelContext.drawImage(frameCanvas, geometry.padX, geometry.padY, geometry.drawWidth, geometry.drawHeight);
  helpers.rgbaToCHW(modelContext.getImageData(0, 0, inputWidth, inputHeight).data,
    inputWidth, inputHeight, tensorPixels);
  const input = new ort.Tensor('float32', tensorPixels, [1, 3, inputHeight, inputWidth]);
  let outputs;
  let boxes;
  try {
    outputs = await session.run({ [session.inputNames[0]]: input });
    const output = outputs[session.outputNames[0]];
    boxes = helpers.decodeYoloDetections(output.data, output.dims, geometry);
  } finally {
    input.dispose();
    if (outputs) Object.values(outputs).forEach(output => output.dispose());
  }
  let landmarks = [];
  // Hand inference is unnecessary when the phone detector finds no candidate.
  if (boxes.some(box => box.label === 'cell phone')) {
    lastHandTimestamp = Math.max(performance.now(), lastHandTimestamp + 1);
    const hands = handLandmarker.detectForVideo(frameCanvas, lastHandTimestamp);
    landmarks = hands.landmarks;
  }
  return {
    ...helpers.classifyPhoneUse(boxes, landmarks, width, height),
    backend,
    handBackend,
    inferenceMs: Math.round((performance.now() - started) * 10) / 10,
  };
}

async function dispose() {
  const previous = session;
  session = null;
  try { await previous?.release(); } catch { /* Already-lost GPU devices can reject release. */ }
  closeHands();
  if (frameCanvas) frameCanvas.width = frameCanvas.height = 1;
  if (modelCanvas) modelCanvas.width = modelCanvas.height = 1;
  frameCanvas = frameContext = modelCanvas = modelContext = tensorPixels = null;
  lastHandTimestamp = 0;
}
