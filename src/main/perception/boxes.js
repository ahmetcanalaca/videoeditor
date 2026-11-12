'use strict';
// Reads the bounding boxes a vision model writes as text and turns them into normalised boxes { x1, y1, x2, y2 } (0..1, origin top-left).
//
// Models write boxes in different coordinate systems (measured with the built-in model and the alternative one, see docs/internal):
//   k1000    [x1, y1, x2, y2] on a 0..1000 grid   (Qwen family - the built-in model)
//   k1000yx  [y1, x1, y2, x2] on a 0..1000 grid   (Gemma family)
//   px       [x1, y1, x2, y2] in pixels of the image the model was shown
//   unit     [x1, y1, x2, y2] as fractions 0..1
// The text may be wrapped in a code fence, have words around it, or be cut off at the token limit.
const FORMATS = ['k1000', 'k1000yx', 'px', 'unit'];
const BOX_KEYS = ['bbox_2d', 'bbox', 'box_2d', 'box', 'bounding_box'];
const NUM = '(-?\\d+(?:\\.\\d+)?)';
const FOUR = new RegExp('\\[\\s*' + NUM + '\\s*,\\s*' + NUM + '\\s*,\\s*' + NUM + '\\s*,\\s*' + NUM + '\\s*\\]', 'g');

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Every balanced [...] or {...} piece of the text, outermost first.
function balancedPieces(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== '[' && open !== '{') continue;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) { if (c === '\\') j++; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end > i) { out.push(text.slice(i, end + 1)); i = end; }
  }
  return out;
}

function collectFourNumbers(value, out, label, key) {
  if (Array.isArray(value)) {
    if (value.length === 4 && value.every(isNum)) { out.push({ raw: value, label, key }); return; }
    for (const v of value) collectFourNumbers(v, out, label, key);
  } else if (value && typeof value === 'object') {
    const lab = typeof value.label === 'string' ? value.label : (typeof value.name === 'string' ? value.name : label);
    let used = false;
    for (const k of BOX_KEYS) {
      if (value[k] !== undefined) { collectFourNumbers(value[k], out, lab, k); used = true; break; }
    }
    if (!used) for (const k of Object.keys(value)) collectFourNumbers(value[k], out, lab, key);
  }
}

function rawBoxes(text) {
  const s = String(text == null ? '' : text).replace(/```[a-z]*/gi, ' ');
  const out = [];
  for (const piece of balancedPieces(s)) {
    let parsed;
    try { parsed = JSON.parse(piece); } catch (e) { continue; }
    collectFourNumbers(parsed, out, undefined);
    if (out.length) return out;
  }
  // not valid JSON (cut off at the token limit, trailing commas, ...): the four-number lists are still readable
  let m;
  FOUR.lastIndex = 0;
  while ((m = FOUR.exec(s)) !== null) out.push({ raw: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])], label: undefined });
  return out;
}

// One list of four numbers, read in the given coordinate system -> a normalised box, or null when it is not a plausible box.
// size: { width, height } of the image that was shown (only needed for the "px" format)
function toBox(raw, label, format, size) {
  const [a, b, c, d] = raw;
  let x1; let y1; let x2; let y2;
  if (format === 'k1000') { x1 = a / 1000; y1 = b / 1000; x2 = c / 1000; y2 = d / 1000; }
  else if (format === 'k1000yx') { y1 = a / 1000; x1 = b / 1000; y2 = c / 1000; x2 = d / 1000; }
  else if (format === 'px') {
    if (!size || !(size.width > 0) || !(size.height > 0)) return null;
    x1 = a / size.width; y1 = b / size.height; x2 = c / size.width; y2 = d / size.height;
  } else { x1 = a; y1 = b; x2 = c; y2 = d; }
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  // far outside the picture = not a box in this coordinate system
  if (x1 < -0.05 || y1 < -0.05 || x2 > 1.15 || y2 > 1.15) return null;
  const box = { x1: clamp01(x1), y1: clamp01(y1), x2: clamp01(x2), y2: clamp01(y2) };
  if (box.x2 - box.x1 < 0.01 || box.y2 - box.y1 < 0.01 || (box.x2 - box.x1) * (box.y2 - box.y1) < 0.0003) return null;
  if (label) box.label = String(label).slice(0, 60);
  return box;
}

// size: { width, height } of the image that was shown (only needed for the "px" format)
function parseBoxes(text, format, size) {
  if (!FORMATS.includes(format)) throw new Error('Unknown box format ' + format);
  const out = [];
  for (const r of rawBoxes(text)) {
    const box = toBox(r.raw, r.label, format, size);
    if (box) out.push(box);
  }
  return out;
}

// A cloud model is asked for fractions, but it may still answer in pixels of the picture it was shown or on a 0..1000 grid. Which system a list of four
// numbers is in follows from its size: everything within 0..1 = fractions; within the picture's size = pixels; within 0..1000 = the grid. The key helps where the
// size cannot decide: a model that answers with "bbox_2d" (the name of the Qwen family's own format, measured with the built-in model: asked for fractions with the key
// "bbox", it still answered {"bbox_2d":[86,371,532,796]}) writes on the 0..1000 grid, which on a small picture also looks like pixels.
function guessFormat(v, size, key) {
  const lo = Math.min(v[0], v[1], v[2], v[3]);
  const hi = Math.max(v[0], v[1], v[2], v[3]);
  if (lo >= -0.05 && hi <= 1.15) return 'unit';
  if (key === 'bbox_2d' && lo >= -50 && hi <= 1100) return 'k1000';
  if (size && size.width > 0 && size.height > 0 && Math.max(v[0], v[2]) <= size.width * 1.05 && Math.max(v[1], v[3]) <= size.height * 1.05) return 'px';
  if (lo >= -50 && hi <= 1100) return 'k1000';
  return null;
}

// Like parseBoxes, for an answer whose coordinate system is not known in advance (every box is judged by itself).
function parseBoxesAuto(text, size) {
  const out = [];
  for (const r of rawBoxes(text)) {
    const format = guessFormat(r.raw, size, r.key);
    const box = format ? toBox(r.raw, r.label, format, size) : null;
    if (box) out.push(box);
  }
  return out;
}

const width = (b) => b.x2 - b.x1;
const height = (b) => b.y2 - b.y1;
const area = (b) => Math.max(0, width(b)) * Math.max(0, height(b));
const center = (b) => ({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 });

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

function median(values) {
  const v = values.slice().sort((p, q) => p - q);
  if (!v.length) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Per-coordinate median: robust against one frame whose box is off.
function medianBox(boxes) {
  if (!boxes.length) return null;
  return { x1: median(boxes.map((b) => b.x1)), y1: median(boxes.map((b) => b.y1)), x2: median(boxes.map((b) => b.x2)), y2: median(boxes.map((b) => b.y2)) };
}

// One box per picture: with several objects ("dogs") their union if it is not most of the picture, else the biggest one.
function representative(boxes) {
  if (!boxes.length) return null;
  if (boxes.length === 1) return boxes[0];
  const u = { x1: Math.min(...boxes.map((b) => b.x1)), y1: Math.min(...boxes.map((b) => b.y1)), x2: Math.max(...boxes.map((b) => b.x2)), y2: Math.max(...boxes.map((b) => b.y2)) };
  if (width(u) <= 0.7 && height(u) <= 0.7) return u;
  return boxes.slice().sort((p, q) => area(q) - area(p))[0];
}

// Is the box where the user said ("on the left")? Centre-based and generous: the prompt already asked for that side.
function inPosition(box, position) {
  if (!position) return true;
  const c = center(box);
  if (position === 'left') return c.x <= 0.55;
  if (position === 'right') return c.x >= 0.45;
  if (position === 'top') return c.y <= 0.55;
  if (position === 'bottom') return c.y >= 0.45;
  if (position === 'center') return Math.abs(c.x - 0.5) <= 0.25 && Math.abs(c.y - 0.5) <= 0.3;
  return true;
}

module.exports = { FORMATS, parseBoxes, parseBoxesAuto, iou, center, area, medianBox, representative, inPosition, median };
