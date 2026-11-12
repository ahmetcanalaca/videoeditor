'use strict';
// The fake world of the end-to-end tests of locate_in_video (desktop: tests/ui-locate.js, web: web/tests/locate.test.js):
//   - a 14 s film with an orange "car" on the LEFT from 1 to 5 s and on the RIGHT from 9 to 13 s, nothing in between, a blue square that never moves and a white bar
//     that moves (so that no two pictures are alike, as in a real video),
//   - a stand-in for a vision model that really DECODES every JPEG it is sent (ffmpeg) and answers with the box of the orange pixels it finds, so that the position a
//     zoom aims at can be compared with where the car really is.
// h = the media helpers of the suite (tests/helpers.js or web/tests/lib/media-tools.js: ff, bins, patternSource).
const fs = require('fs');
const { spawnSync } = require('child_process');
const { jpegSize } = require('../src/main/perception/cloud-vlm');

// where the car is (centre of its box, fractions of the picture) and when
const TRUTH = { left: { from: 1, to: 5, cx: 0.25, cy: 0.5 }, right: { from: 9, to: 13, cx: 0.75, cy: 0.5 }, seconds: 14 };

function makeFilm(h, file) {
  if (fs.existsSync(file)) return file;
  h.ff(['-f', 'lavfi', '-i', h.patternSource(640, 360, 25, TRUTH.seconds, '0x202830', 40), '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + TRUTH.seconds + ':sample_rate=48000',
    '-vf', "drawbox=x=100:y=140:w=120:h=80:color=0xFF7F00:t=fill:enable='between(t,1,5)',drawbox=x=420:y=140:w=120:h=80:color=0xFF7F00:t=fill:enable='between(t,9,13)',drawbox=x=300:y=20:w=60:h=60:color=0x2040FF:t=fill,format=yuv420p",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-g', '25', '-c:a', 'aac', '-b:a', '96k', '-shortest', '-y', file]);
  return file;
}

// The box of the orange pixels of a JPEG (fractions of the picture), or null when there are none
function orangeBox(h, jpeg) {
  const size = jpegSize(jpeg);
  const r = spawnSync(h.bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: jpeg, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !size || r.stdout.length < size.width * size.height * 3) throw new Error('the picture cannot be decoded: ' + (r.stderr ? r.stderr.toString().slice(0, 200) : ''));
  const { width: w, height: hh } = size;
  const px = r.stdout;
  let x1 = w; let y1 = hh; let x2 = -1; let y2 = -1; let n = 0;
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const R = px[i]; const G = px[i + 1]; const B = px[i + 2];
      if (R > 190 && G > 70 && G < 190 && B < 110 && R - B > 110) { n++; if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; }
    }
  }
  const round = (v) => Math.round(v * 1000) / 1000;
  return n >= 60 ? { x1: round(x1 / w), y1: round(y1 / hh), x2: round((x2 + 1) / w), y2: round((y2 + 1) / hh), pixels: n } : null;
}

// A request of the OpenAI protocol that carries a picture (what the locator sends to the vision model)
const isPictureRequest = (body) => !!body && Array.isArray(body.messages) && body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p && p.type === 'image_url'));

// What the stand-in model says to one question about one picture: YES / NO to "is there ... ? Answer with one word: YES or NO", the JSON boxes to "Locate the ...".
// mode: 'orange' (looks at the picture) | 'none' (sees nothing). -> { text, box }
function visionAnswer(h, prompt, jpeg, mode) {
  const box = mode === 'none' ? null : orangeBox(h, jpeg);
  if (/Answer with one word: YES or NO/.test(String(prompt))) return { text: box ? 'YES' : 'NO', box };
  return { text: box ? JSON.stringify([{ bbox: [box.x1, box.y1, box.x2, box.y2], label: 'orange car' }]) : '[]', box };
}

// What the model got: the JPEG, its size, the question, the system message
function pictureOf(body, headers, key) {
  const user = body.messages.filter((m) => m.role === 'user').pop();
  const part = user.content.find((p) => p.type === 'image_url');
  const url = part.image_url.url;
  const jpeg = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  const q = user.content.find((p) => p.type === 'text');
  return {
    jpeg,
    record: {
      size: jpegSize(jpeg), bytes: jpeg.length, jpegHeader: jpeg[0] === 0xff && jpeg[1] === 0xd8, mime: url.slice(0, url.indexOf(',')), prompt: q && q.text,
      keyInBody: key ? JSON.stringify(body).includes(key) : false, system: body.messages[0].role === 'system' ? body.messages[0].content : '', headers: headers || {},
    },
  };
}

module.exports = { TRUTH, makeFilm, orangeBox, visionAnswer, isPictureRequest, pictureOf };
