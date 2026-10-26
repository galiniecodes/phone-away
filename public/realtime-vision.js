/** Geometry and pixel conversion shared by the local vision worker and tests. */

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const positiveInteger = value => Number.isInteger(value) && value > 0;
// Keep weaker phone candidates for the Very high alert setting. Hand contact
// and the session's confidence/dwell gate still decide whether audio plays.
const MIN_DETECTION_SCORE = 0.2;

/** Match the centered, 114-gray letterbox used by the pretrained YOLO export. */
export function letterboxGeometry(width, height, inputWidth = 640, inputHeight = 640) {
  if (![width, height, inputWidth, inputHeight].every(positiveInteger)) {
    throw new TypeError('Invalid camera or model dimensions.');
  }
  const ratio = Math.min(inputWidth / width, inputHeight / height);
  const drawWidth = Math.max(1, Math.round(width * ratio));
  const drawHeight = Math.max(1, Math.round(height * ratio));
  return {
    width, height, inputWidth, inputHeight, drawWidth, drawHeight,
    padX: Math.floor((inputWidth - drawWidth) / 2),
    padY: Math.floor((inputHeight - drawHeight) / 2),
    // Rounding can make the two scales differ slightly on odd-sized frames.
    scaleX: drawWidth / width,
    scaleY: drawHeight / height,
  };
}

/** RGBA canvas pixels -> normalized RGB planes, never BGR or interleaved RGB. */
export function rgbaToCHW(rgba, width, height, destination) {
  if (![width, height].every(positiveInteger)
    || !(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray)
    || rgba.length !== width * height * 4) {
    throw new TypeError('Invalid RGBA frame.');
  }
  const plane = width * height;
  const output = destination ?? new Float32Array(plane * 3);
  if (!(output instanceof Float32Array) || output.length !== plane * 3) {
    throw new TypeError('Invalid RGB tensor buffer.');
  }
  for (let pixel = 0, offset = 0; pixel < plane; pixel++, offset += 4) {
    output[pixel] = rgba[offset] / 255;
    output[plane + pixel] = rgba[offset + 1] / 255;
    output[plane * 2 + pixel] = rgba[offset + 2] / 255;
  }
  return output;
}

/** Decode YOLO26's end-to-end [1, N, 6] xyxy/score/class output. No NMS needed. */
export function decodeYoloDetections(data, dims, geometry, { minScore = MIN_DETECTION_SCORE } = {}) {
  if (!Array.isArray(dims) || dims.length !== 3 || dims[0] !== 1 || dims[2] !== 6
    || !positiveInteger(dims[1]) || dims[1] > 10000 || data?.length !== dims[1] * 6) {
    throw new Error('The local phone model has an unsupported output shape.');
  }
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    throw new TypeError('Invalid detector confidence threshold.');
  }
  const { width, height, padX, padY, scaleX, scaleY } = geometry;
  const boxes = [];
  for (let index = 0; index < data.length; index += 6) {
    const [left, top, right, bottom, score, classId] = data.subarray
      ? data.subarray(index, index + 6) : data.slice(index, index + 6);
    if (![left, top, right, bottom, score, classId].every(Number.isFinite)
      || score < minScore || score > 1 || ![0, 67].includes(classId)
      || right <= left || bottom <= top) continue;
    const x1 = clamp((left - padX) / scaleX, 0, width);
    const y1 = clamp((top - padY) / scaleY, 0, height);
    const x2 = clamp((right - padX) / scaleX, 0, width);
    const y2 = clamp((bottom - padY) / scaleY, 0, height);
    if (x2 - x1 < 2 || y2 - y1 < 2) continue;
    boxes.push({
      label: classId === 67 ? 'cell phone' : 'person',
      score,
      bbox: [x1, y1, x2 - x1, y2 - y1],
    });
  }
  return boxes;
}

const area = ([, , width, height]) => width * height;
const contains = ([x, y, width, height], point, margin = 0) =>
  point.x >= x - margin && point.x <= x + width + margin
  && point.y >= y - margin && point.y <= y + height + margin;
/** MediaPipe already applies palm/presence thresholds; handedness is not confidence. */
export function normalizeHands(landmarks, width, height) {
  if (![width, height].every(positiveInteger)) throw new TypeError('Invalid hand frame dimensions.');
  if (!Array.isArray(landmarks)) return [];
  return landmarks.filter(points => Array.isArray(points) && points.length === 21
    && points.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y)
      && point.x >= -0.2 && point.x <= 1.2 && point.y >= -0.2 && point.y <= 1.2))
    .map(points => {
      const pixels = points.map(({ x, y }) => ({ x: x * width, y: y * height }));
      const xs = pixels.map(point => point.x);
      const ys = pixels.map(point => point.y);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      return { landmarks: pixels, bbox: [left, top, Math.max(...xs) - left, Math.max(...ys) - top] };
    }).filter(hand => hand.bbox[2] >= 4 && hand.bbox[3] >= 4);
}

/**
 * A held-phone hint requires several hand landmarks touching a plausible phone.
 * This cannot infer attention or distinguish every phone resting near a hand.
 * A visible phone with an occluded/missed hand stays unknown, so an existing
 * alert cannot repeatedly rearm just because hand tracking temporarily fails.
 */
export function classifyPhoneUse(boxes, landmarks, width, height) {
  const validBoxes = (Array.isArray(boxes) ? boxes : []).filter(box =>
    box && ['person', 'cell phone'].includes(box.label)
    && Number.isFinite(box.score) && box.score >= MIN_DETECTION_SCORE && box.score <= 1
    && Array.isArray(box.bbox) && box.bbox.length === 4 && box.bbox.every(Number.isFinite)
    && box.bbox[2] >= 2 && box.bbox[3] >= 2);
  const hands = normalizeHands(landmarks, width, height);
  const phones = validBoxes.filter(box => box.label === 'cell phone');
  let confidence = 0;
  const heldPhones = new Set();

  for (const phone of phones) {
    const [, , phoneWidth, phoneHeight] = phone.bbox;
    const margin = Math.max(5, Math.min(phoneWidth, phoneHeight) * 0.2);
    // A detected hand is enough human evidence. Cropped bodies and people in
    // the background must not suppress a clearly held foreground phone.
    for (const hand of hands) {
      const nearby = hand.landmarks.filter(point => contains(phone.bbox, point, margin));
      const relativeSize = area(phone.bbox) / area(hand.bbox);
      if (nearby.length < 3 || relativeSize < 0.04 || relativeSize > 12) continue;
      confidence = Math.max(confidence, phone.score);
      heldPhones.add(phone);
      break;
    }
  }

  const phoneUse = heldPhones.size > 0;
  // Two visible hands clearly away from every phone provide an explicit clear
  // sample even if a desk phone remains in view. One missing hand is unknown.
  const handsAway = !phoneUse && hands.length >= 2 && phones.every(phone => {
    const margin = Math.max(20, Math.min(phone.bbox[2], phone.bbox[3]) * 0.5);
    return hands.every(hand => !hand.landmarks.some(point => contains(phone.bbox, point, margin)));
  });
  return {
    phoneUse,
    confidence: phoneUse ? confidence : phones.length ? (handsAway ? 0.9 : 0) : 1,
    uncertain: !phoneUse && phones.length > 0 && !handsAway,
    reason: phoneUse
      ? 'Phone detected in a hand.'
      : phones.length
        ? handsAway ? 'Phone visible; both hands are away.' : 'Phone visible; holding is not confirmed.'
        : 'No phone detected.',
    boxes: validBoxes.map(box => ({ ...box, held: heldPhones.has(box) })),
    hands,
  };
}
