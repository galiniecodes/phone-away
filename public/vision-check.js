import {LocalDetector} from './detection.js';

const detector = new LocalDetector();
const canvas = document.querySelector('#test-canvas');
const context = canvas.getContext('2d');
const source = document.createElement('canvas');
const input = document.querySelector('#test-image');
const button = document.querySelector('#run-check');
const status = document.querySelector('#test-status');
const output = document.querySelector('#test-result');
source.width = 640; source.height = 480;
source.getContext('2d').fillRect(0, 0, 640, 480);
context.drawImage(source, 0, 0);

input.addEventListener('change', async () => {
  const file = input.files[0];
  if (!file) return;
  try {
    const image = await createImageBitmap(file);
    source.width = 640; source.height = Math.round(640 * image.height / image.width);
    source.getContext('2d').drawImage(image, 0, 0, source.width, source.height);
    image.close();
    canvas.width = source.width; canvas.height = source.height;
    context.drawImage(source, 0, 0);
    status.textContent = 'Test image ready. Processed only in this browser.';
  } catch (error) { status.textContent = error.message; }
});

button.addEventListener('click', async () => {
  button.disabled = true; input.disabled = true; output.textContent = '';
  try {
    const started = performance.now();
    await detector.load(progress => { status.textContent = progress; });
    const loadMs = Math.round(performance.now() - started);
    const times = [];
    let result;
    for (let i = 0; i < 20; i++) {
      status.textContent = `Checking frame ${i + 1} of 20…`;
      const at = performance.now();
      result = await detector.detect(source);
      times.push(performance.now() - at);
    }
    const sorted = times.slice(3).sort((a, b) => a - b);
    const medianMs = sorted[Math.floor(sorted.length / 2)];
    context.drawImage(source, 0, 0);
    context.strokeStyle = '#ffd43b'; context.lineWidth = 3;
    for (const box of result.boxes || []) if (box.label === 'cell phone') context.strokeRect(...box.bbox);
    status.textContent = `Check complete · ${Math.round(medianMs)} ms per frame · ${result.phoneUse ? 'Phone in hand' : result.reason} · Camera off.`;
    output.textContent = JSON.stringify({backend: result.backend || detector.backend,
      loadMs, firstFrameMs: Math.round(times[0]), medianMs: Math.round(medianMs),
      possibleChecksPerSecond: Number((1000 / medianMs).toFixed(1)),
      note: 'Still-image throughput, excluding live camera scheduling. Not an accuracy guarantee.', result: {...result, hands: undefined, handsDetected: result.hands?.length || 0}}, null, 2);
  } catch (error) { status.textContent = `Check failed: ${error.message}`; }
  finally { button.disabled = false; input.disabled = false; }
});
window.addEventListener('pagehide', () => detector.dispose());
