import test from 'node:test';
import assert from 'node:assert/strict';
import { letterboxGeometry, rgbaToCHW, decodeYoloDetections, normalizeHands,
  classifyPhoneUse } from '../public/realtime-vision.js';

test('letterbox maps a wide camera frame back from model pixels without padding drift', () => {
  const geometry = letterboxGeometry(1280, 720);
  assert.equal(geometry.drawWidth, 640);
  assert.equal(geometry.drawHeight, 360);
  assert.equal(geometry.padY, 140);
  const boxes = decodeYoloDetections(new Float32Array([100, 190, 150, 290, 0.8, 67]), [1, 1, 6], geometry);
  assert.deepEqual(boxes[0].bbox, [200, 100, 100, 200]);
  assert.equal(boxes[0].label, 'cell phone');
});

test('portrait letterbox and odd sizes preserve their independent rounded scales', () => {
  const geometry = letterboxGeometry(301, 501);
  const source = [37, 41, 20, 70];
  const [x, y, width, height] = source;
  const boxes = decodeYoloDetections([
    x * geometry.scaleX + geometry.padX, y * geometry.scaleY + geometry.padY,
    (x + width) * geometry.scaleX + geometry.padX, (y + height) * geometry.scaleY + geometry.padY,
    0.9, 67,
  ], [1, 1, 6], geometry);
  source.forEach((value, index) => assert.ok(Math.abs(value - boxes[0].bbox[index]) < 1e-8));
});

test('decode clips edge boxes and rejects padding-only, wrong classes, and corrupt predictions', () => {
  const geometry = letterboxGeometry(640, 360);
  const rows = [
    [-10, 130, 40, 200, 0.7, 67],
    [10, 10, 50, 50, 0.9, 67],
    [1, 200, 20, 230, 0.9, 2],
    [1, 200, 20, 230, 1.1, 67],
    [1, 200, 20, 230, 0.19, 67],
    [1, 200, NaN, 230, 0.9, 67],
    [20, 200, 1, 230, 0.9, 67],
    [1, 200, 20, 230, 0.9, 67.1],
  ];
  const boxes = decodeYoloDetections(rows.flat(), [1, rows.length, 6], geometry);
  assert.equal(boxes.length, 1);
  assert.deepEqual(boxes[0].bbox, [0, 0, 40, 60]);
  assert.throws(() => decodeYoloDetections([], [1, 84, 8400], geometry), /unsupported output/);
  assert.throws(() => letterboxGeometry(0, 360), /dimensions/);
});

test('pixel conversion is RGB CHW with alpha ignored and reusable output', () => {
  const rgba = new Uint8ClampedArray([255, 128, 0, 2, 0, 64, 255, 3]);
  const destination = new Float32Array(6);
  assert.equal(rgbaToCHW(rgba, 2, 1, destination), destination);
  const expected = [1, 0, 128 / 255, 64 / 255, 0, 1];
  destination.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-6));
  assert.throws(() => rgbaToCHW(rgba, 3, 1), /Invalid RGBA/);
});

const person = { label: 'person', score: 0.9, bbox: [50, 20, 400, 430] };
const phone = { label: 'cell phone', score: 0.8, bbox: [210, 150, 40, 80] };
const handAt = (x, y) => Array.from({ length: 21 }, (_, index) => ({
  x: (x + index % 5 * 7) / 640,
  y: (y + Math.floor(index / 5) * 10) / 480,
  z: 0,
}));

test('held phone needs plausible hand contact', () => {
  const result = classifyPhoneUse([person, phone], [handAt(215, 180)], 640, 480);
  assert.equal(result.phoneUse, true);
  assert.equal(result.confidence, 0.8);
  assert.equal(result.uncertain, false);
  assert.equal(result.boxes[1].held, true);
  assert.equal(result.boxes[0].held, false);
  assert.equal(result.hands.length, 1);
});

test('weak phone predictions survive decoding and hand classification without inflating confidence', () => {
  const geometry = letterboxGeometry(640, 480);
  const rows = [
    [210, 230, 250, 310, 0.28, 67],
    [310, 230, 350, 310, 0.19, 67],
  ];
  const boxes = decodeYoloDetections(rows.flat(), [1, 2, 6], geometry);
  assert.equal(boxes.length, 1, 'Sub-floor predictions must still be discarded.');
  const held = classifyPhoneUse(boxes, [handAt(215, 180)], 640, 480);
  assert.equal(held.phoneUse, true);
  assert.equal(held.confidence, 0.28);
  assert.equal(held.boxes[0].held, true);
  const unheld = classifyPhoneUse(boxes, [], 640, 480);
  assert.equal(unheld.phoneUse, false, 'Greater sensitivity still requires hand contact.');
  assert.equal(unheld.uncertain, true);
});

test('visible phone without hand contact is uncertain, including missing or malformed hands', () => {
  for (const landmarks of [[], [handAt(400, 300)], [handAt(215, 180).slice(0, 20)],
    [[{ x: NaN, y: 0 }]], [handAt(215, 180).map(point => ({ ...point, x: 5 }))]]) {
    const result = classifyPhoneUse([person, phone], landmarks, 640, 480);
    assert.equal(result.phoneUse, false);
    assert.equal(result.uncertain, true);
    assert.equal(result.confidence, 0);
  }
});

test('a cropped hand and phone can be recognized without a person box', () => {
  assert.equal(classifyPhoneUse([phone], [handAt(215, 180)], 640, 480).phoneUse, true);
});

test('a desk phone rearms only when both visible hands are clearly away', () => {
  const leftHand = handAt(90, 300);
  const rightHand = handAt(350, 300);
  const clear = classifyPhoneUse([person, phone], [leftHand, rightHand], 640, 480);
  assert.equal(clear.phoneUse, false);
  assert.equal(clear.uncertain, false);
  assert.equal(clear.confidence, 0.9);
  assert.match(clear.reason, /both hands are away/);
  const missingHand = classifyPhoneUse([person, phone], [leftHand], 640, 480);
  assert.equal(missingHand.uncertain, true);
  const adjacentHand = classifyPhoneUse([person, phone], [leftHand, handAt(260, 180)], 640, 480);
  assert.equal(adjacentHand.uncertain, true);
});

test('a background person does not suppress a foreground hand holding a phone', () => {
  const outside = { ...phone, bbox: [500, 150, 40, 80] };
  const result = classifyPhoneUse([person, outside], [handAt(505, 180)], 640, 480);
  assert.equal(result.phoneUse, true);
  assert.equal(result.uncertain, false);
});

test('implausibly giant phone boxes cannot turn a small hand into a phone incident', () => {
  const giant = { ...phone, bbox: [50, 20, 390, 420] };
  assert.equal(classifyPhoneUse([person, giant], [handAt(215, 180)], 640, 480).phoneUse, false);
  assert.equal(classifyPhoneUse([giant], [handAt(215, 180)], 640, 480).phoneUse, false);
});

test('no detected phone provides a clear sample and hand landmarks are pixel coordinates', () => {
  const result = classifyPhoneUse([person], [], 640, 480);
  assert.equal(result.phoneUse, false);
  assert.equal(result.uncertain, false);
  assert.equal(result.confidence, 1);
  const hand = normalizeHands([handAt(210, 180)], 640, 480)[0];
  assert.deepEqual(hand.landmarks[0], { x: 210, y: 180 });
  assert.deepEqual(hand.bbox, [210, 180, 28, 40]);
});
