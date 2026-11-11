'use strict';
// Keeps ffmpeg / ffprobe (and fs.stat) from being pointed at the network by something the user did not choose.
//
// Threat (security review, finding 1): a crafted .vedproj (media path "\\attacker\share\x.mp4") or a media file that is really a DASH / HLS playlist
// ("\\attacker\share\seg.ts", http://...) makes Windows / FFmpeg open an SMB share or a URL, which sends the user's NTLM hash to that server.
//
// Rules
//   1. Whatever is handed to FFmpeg must be a plain local file path: never a URL ("http:", "smb:", "file:", "concat:", "pipe:" ...) and never a
//      Windows device path ("\\.\", "\\?\").
//   2. UNC paths (\\server\share\...) are fine when the USER chose the file (open dialog, drag and drop: network shares are normal at work),
//      but are never opened automatically from a project file: they are reported as "blocked" and the user adds them again by hand.
//   3. Every input is opened with -format_whitelist (only the container formats the app offers; DASH, HLS, concat, image2 ... are refused) and
//      -protocol_whitelist file,pipe, so a file cannot make FFmpeg open anything else from the inside.
const path = require('path');

// Demuxer names (any one of the comma-separated names of a demuxer matches): MP4/MOV/M4V/3GP, Matroska/WebM, AVI, WMV/ASF, FLV, MPEG-PS (MPG/VOB), MPEG-TS (TS/M2TS/MTS), Ogg, MXF
const FORMAT_WHITELIST = 'mov,matroska,webm,avi,asf,flv,mpeg,mpegts,ogg,mxf';
const PROTOCOL_WHITELIST = 'file,pipe';

const SCHEME = /^[a-z][a-z0-9+.-]+:/i; // a drive letter is a single character, so "C:\x" does not match
const UNC = /^[\\/]{2}(?![?.][\\/])/; // \\server\share, //server/share and \\?\UNC\server\share are normalised by the check below
const DEVICE = /^[\\/]{2}[?.][\\/]/; // \\?\C:\x, \\.\PhysicalDrive0, \\.\pipe\x

function classify(p) {
  const s = String(p);
  if (!s || s.includes('\0')) return 'invalid';
  if (SCHEME.test(s)) return 'url';
  if (DEVICE.test(s)) return /^[\\/]{2}[?][\\/]UNC[\\/]/i.test(s) ? 'unc' : 'device';
  if (UNC.test(s)) return 'unc';
  return 'local';
}

// Returns the absolute, normalised path or throws an error with code REMOTE_PATH.
// opts.allowNetwork: UNC paths are accepted (user-chosen files). URLs, device paths and invalid strings never are.
function assertLocalMediaPath(p, opts) {
  const allowNetwork = !!(opts && opts.allowNetwork);
  const raw = String(p);
  let kind = classify(raw);
  if (kind === 'local') kind = classify(path.resolve(raw)); // path.resolve("//host/x") -> "\\host\x"
  if (kind === 'local' || (kind === 'unc' && allowNetwork)) return path.resolve(raw);
  const err = new Error('Remote or device path is not allowed (' + kind + '): ' + raw.slice(0, 200));
  err.code = 'REMOTE_PATH';
  err.kind = kind;
  throw err;
}

const guardArgs = () => ['-format_whitelist', FORMAT_WHITELIST, '-protocol_whitelist', PROTOCOL_WHITELIST];
const inputArgs = (file) => guardArgs().concat(['-i', file]);

module.exports = { FORMAT_WHITELIST, PROTOCOL_WHITELIST, classify, assertLocalMediaPath, guardArgs, inputArgs };
