'use strict';
// Resolves the bundled FFmpeg / ffprobe executables.
// Packaged app: <resources>/bin/ffmpeg.exe (copied next to the app, NOT inside app.asar so it can be executed).
// Development : vendor/ffmpeg/bin (npm run ffmpeg:fetch downloads the pinned, SHA-256-verified release; ffmpeg and ffprobe come from the same package).
// There is deliberately no fallback to anything else: a stale ffprobe found by accident must not parse the user's files.
const fs = require('fs');
const path = require('path');

function firstExisting(list) {
  for (const p of list) {
    if (p && typeof p === 'string' && fs.existsSync(p)) return p;
  }
  return null;
}

function resolveBinaries(opts) {
  const options = opts || {};
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  const appRoot = options.appRoot || path.join(__dirname, '..', '..');
  const vendorBin = path.join(appRoot, 'vendor', 'ffmpeg', 'bin');
  const ffmpegList = [];
  const ffprobeList = [];

  if (resourcesPath) {
    ffmpegList.push(path.join(resourcesPath, 'bin', 'ffmpeg.exe'));
    ffprobeList.push(path.join(resourcesPath, 'bin', 'ffprobe.exe'));
  }
  ffmpegList.push(path.join(vendorBin, 'ffmpeg.exe'));
  ffprobeList.push(path.join(vendorBin, 'ffprobe.exe'));

  return {
    ffmpeg: firstExisting(ffmpegList),
    ffprobe: firstExisting(ffprobeList),
  };
}

module.exports = { resolveBinaries };
