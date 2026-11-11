'use strict';
// What the assistant asked find_in_video for, made safe and checked against what the USER actually wrote.
//
// A small language model sometimes invents details: the measured failure was "Soldaki arabayı yakınlaştır" (zoom on the car on the left)
// being sent as position "right", and colours or positions nobody mentioned. Words the user did not write are therefore dropped, and the
// position / colour the user did write win over what the model sent. All of it works for Turkish and English.
const POSITIONS = ['left', 'right', 'top', 'bottom', 'center'];

// Turkish letters folded to ASCII so that "sağdaki", "sagdaki" and "SAĞDAKİ" are the same word.
function fold(s) {
  return String(s == null ? '' : s)
    .replace(/İ/g, 'i').replace(/I/g, 'i')
    .toLowerCase()
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/[^a-z0-9\s]/g, ' ');
}

// "sol" alone is also the beginning of "solmak" (to fade), so only whole position words count. The Turkish words below are unambiguous.
const POSITION_WORDS_TR = {
  left: /\b(sol|solda|soldaki|solundaki|solunda|soluna|soldan)\b/,
  right: /\b(sag|sagda|sagdaki|sagindaki|saginda|sagina|sagdan)\b/,
  top: /\b(ust|ustte|ustteki|ustundeki|yukari|yukarida|yukaridaki)\b/,
  bottom: /\b(alt|altta|alttaki|altindaki|asagi|asagida|asagidaki)\b/,
  center: /\b(orta|ortada|ortadaki|ortasindaki)\b/,
};
// The English words are everyday words as well ("right at the start", "left alone", "in the middle of the video", "lower the volume"): in
// a USER's text they only count as a position inside a place phrase. (Measured by the review: "zoom in on the dog right at the start" used to
// search for a dog "on the right side" and report nothing.) For cleaning the model's own short object phrase every position word is taken out.
const EN_POSITION_WORDS = { left: ['left'], right: ['right'], top: ['top', 'upper'], bottom: ['bottom', 'lower'], center: ['center', 'centre', 'middle'] };
const POSITION_WORDS = {};
for (const k of Object.keys(EN_POSITION_WORDS)) POSITION_WORDS[k] = new RegExp(POSITION_WORDS_TR[k].source.slice(0, -3) + '|' + EN_POSITION_WORDS[k].join('|') + ')\\b');

const NOT_A_PLACE = '(?! of the (?:video|clip|film|movie|scene|timeline|recording|footage)\\b| (?:time|moment|point|place|spot|second|minute|hour|speed|pace|angle|way|answer|thing)\\b)';
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Which positions the USER wrote: Turkish position words, and English ones inside a place phrase ("on the left", "left side", "leftmost",
// "the left one", "the left <object>").
function writtenPositions(userText, object) {
  const t = fold(userText);
  const found = Object.keys(POSITION_WORDS_TR).filter((k) => POSITION_WORDS_TR[k].test(t));
  const obj = fold(object).replace(/\s+/g, ' ').trim();
  for (const k of Object.keys(EN_POSITION_WORDS)) {
    if (found.includes(k)) continue;
    const w = '(?:' + EN_POSITION_WORDS[k].join('|') + ')';
    const place = [
      '\\b(?:on|to|at|in|from|towards?|along) the ' + w + '\\b' + NOT_A_PLACE,
      '\\b' + w + '[- ](?:side|half|part|corner|edge|hand|third|portion)\\b',
      '\\b' + w + 'most\\b',
      '\\b(?:the )?' + w + ' (?:one|ones' + (obj ? '|' + escapeRe(obj) : '') + ')\\b',
    ];
    if (place.some((p) => new RegExp(p).test(t))) found.push(k);
  }
  return found;
}

const COLOR_WORDS = {
  red: /\b(red|kirmizi\w*)\b/,
  blue: /\b(blue|mavi\w*)\b/,
  green: /\b(green|yesil\w*)\b/,
  // "sari" is also the stem of "sarilmak" (to hug) and "mor" the start of "more" / "morning", "gri" of "grid" / "grill": explicit endings only
  yellow: /\b(yellow|sari(?:yi|ya|nin|da|daki|dan|lar|lari)?)\b/,
  white: /\b(white|beyaz\w*)\b/,
  black: /\b(black|siyah\w*)\b/,
  orange: /\b(orange|turuncu\w*)\b/,
  pink: /\b(pink|pembe\w*)\b/,
  purple: /\b(purple|violet|mor(?:u|un|a|da|daki|dan|lar|lari)?)\b/,
  brown: /\b(brown|kahverengi\w*)\b/,
  gray: /\b(gray|grey|gri(?:yi|ye|nin|de|deki|den|ler|leri)?)\b/,
};

// Names from the table that occur in the text, e.g. ['left'] for "soldaki arabayı".
function wordsIn(table, text) {
  const t = fold(text);
  return Object.keys(table).filter((k) => table[k].test(t));
}

const cleanWords = (s, max) => String(s == null ? '' : s).replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// query: { object, color?, position?, attributes? } as the model sent it; userText: what the user wrote.
// Returns { ok:true, object, color, position, attributes, phrase, notes[] } or { ok:false, error }.
function reconcile(query, userText) {
  const q = query && typeof query === 'object' ? query : {};
  const object = cleanWords(q.object, 60).toLowerCase();
  if (!object) return { ok: false, error: 'object is required: a short English noun such as "dog", "car" or "person".' };
  const notes = [];
  const text = fold(userText);

  // position: the user's words win; one the user never wrote is dropped
  let position = POSITIONS.includes(fold(q.position).trim()) ? fold(q.position).trim() : '';
  const userPositions = writtenPositions(userText, object);
  if (position && !userPositions.length) {
    notes.push('dropped position "' + position + '" (not in the request)');
    position = '';
  } else if (position && !userPositions.includes(position)) {
    position = userPositions[0];
    notes.push('position corrected to "' + position + '" (as written in the request)');
  } else if (!position && userPositions.length === 1 && (userPositions[0] === 'left' || userPositions[0] === 'right')) {
    position = userPositions[0];
    notes.push('added position "' + position + '" from the request');
  }

  // colour: same rules; a Turkish colour word from the model becomes the English one
  let color = cleanWords(q.color, 20).toLowerCase();
  const known = Object.keys(COLOR_WORDS).find((k) => COLOR_WORDS[k].test(fold(color)));
  if (known) color = known;
  const userColors = wordsIn(COLOR_WORDS, userText);
  if (color) {
    const written = userColors.includes(color) || (!known && text.includes(fold(color)));
    if (!written && userColors.length) { color = userColors[0]; notes.push('colour corrected to "' + color + '" (as written in the request)'); }
    else if (!written) { notes.push('dropped colour "' + color + '" (not in the request)'); color = ''; }
  } else if (userColors.length === 1) {
    color = userColors[0];
    notes.push('added colour "' + color + '" from the request');
  }

  // the colour and the position have their own fields: words of them inside the object ("red car" + colour "red", "left person") are taken out,
  // so that nothing is said twice ("red red car") and nothing the user did not write stays in
  let objectOnly = fold(object).replace(/\s+/g, ' ').trim();
  for (const re of Object.values(COLOR_WORDS).concat(Object.values(POSITION_WORDS))) objectOnly = objectOnly.replace(new RegExp(re.source, 'g'), ' ');
  objectOnly = objectOnly.replace(/\s+/g, ' ').trim() || object;

  // descriptive extras that only repeat the object or colour carry nothing
  let attributes = cleanWords(q.attributes, 50).toLowerCase();
  if (attributes && (objectOnly.includes(attributes) || attributes === color)) attributes = '';

  return { ok: true, object: objectOnly, color, position, attributes, phrase: [color, objectOnly, attributes].filter(Boolean).join(' '), notes };
}

const CLAUSES = { left: ' on the left side', right: ' on the right side', top: ' in the upper half', bottom: ' in the lower half', center: ' in the center' };
const article = (phrase) => (/^[aeiou]/i.test(phrase) ? 'an ' : 'a ') + phrase;

// The yes / no question for one picture.
function presencePrompt(phrase, position) {
  return 'Is there ' + article(phrase) + (CLAUSES[position] || '') + ' in this image? Answer with one word: YES or NO.';
}

// The question that makes the model draw the box. The wording is the one that was measured (11-12 of 12 boxes with IoU >= 0.5).
const WHERE = { left: 'on the left side of the image', right: 'on the right side of the image', top: 'in the upper half of the image', bottom: 'in the lower half of the image', center: 'in the center of the image' };
function groundingPrompt(phrase, position) {
  const format = ' Reply with only JSON in this format: [{"bbox_2d":[x1,y1,x2,y2],"label":"' + phrase + '"}].';
  if (!WHERE[position]) return 'Locate the ' + phrase + ' in this image.' + format + ' If there is no ' + phrase + ' in the image, reply with [].';
  return 'Locate the ' + phrase + ' ' + WHERE[position] + '.' + format + ' If there is none, reply with [].';
}

module.exports = { reconcile, presencePrompt, groundingPrompt, fold, POSITIONS, wordsIn, writtenPositions, POSITION_WORDS, COLOR_WORDS };
