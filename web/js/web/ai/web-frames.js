// Pictures of the user's video for "look at the video" (find_in_video): the desktop pipeline (src/main/perception/) asks a frame source for
// "the picture at second t of this media" and hands it to the vision model. On the desktop ffmpeg cuts the picture out; here the browser's own decoder
// does (Mediabunny's CanvasSink, the same one the timeline thumbnails use). The result is what the desktop code calls a "jpeg": bytes with a
// toString('base64') - everything else of the pipeline (scan, bisection, boxes, caching by picture content) runs unchanged.
import { Input, BlobSource, ALL_FORMATS, CanvasSink } from '../../../vendor/mediabunny/mediabunny.min.mjs';

const codeError = (code, message) => Object.assign(new Error(message || code), { code });

// A JPEG as the desktop code expects to see one (a Node Buffer): the bytes, and toString('base64') for the data URL sent to the model.
export class JpegBytes extends Uint8Array {
  constructor(buffer, base64) {
    super(buffer);
    this.base64 = base64;
  }

  toString(encoding) { return encoding === 'base64' ? this.base64 : 'jpeg(' + this.length + ' bytes)'; }
}

function blobOf(canvas, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(codeError('FRAME_FAILED', 'The picture could not be encoded'))), 'image/jpeg', quality));
}

function base64Of(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(codeError('FRAME_FAILED', 'The picture could not be read'));
    r.readAsDataURL(blob);
  });
}

// getMedia(mediaId) -> { info, file } | null  (the editor's registry). One decoder per media and picture size is kept open while a request runs.
export function createFrameExtractor(getMedia) {
  const open = new Map();
  let closed = false;

  async function sinkFor(mediaId, media, side) {
    const key = mediaId + '|' + side;
    let entry = open.get(key);
    if (entry) return entry;
    const input = new Input({ source: new BlobSource(media.file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) { input.dispose(); throw codeError('FRAME_FAILED', 'No video stream'); }
    const w = Math.max(1, Number(media.info.displayWidth) || 1);
    const h = Math.max(1, Number(media.info.displayHeight) || 1);
    const scale = Math.min(1, side / Math.max(w, h));
    // even sizes: some decoders and the vision model's patching prefer them
    const width = Math.max(2, Math.round((w * scale) / 2) * 2);
    const height = Math.max(2, Math.round((h * scale) / 2) * 2);
    entry = { input, sink: new CanvasSink(track, { width, height, fit: 'fill', poolSize: 1 }), first: await track.getFirstTimestamp() };
    open.set(key, entry);
    return entry;
  }

  // the hook the desktop frame source calls: ({ file, seconds, maxSide, signal }) -> JPEG bytes
  async function extract(req) {
    if (closed) throw codeError('ABORTED', 'Cancelled');
    if (req.signal && req.signal.aborted) throw codeError('ABORTED', 'Cancelled');
    const media = getMedia(req.file);
    if (!media) throw codeError('FRAME_FAILED', 'The video is no longer open');
    const side = Math.max(64, Math.min(2048, Math.round(req.maxSide || 512)));
    const { sink, first } = await sinkFor(req.file, media, side);
    const t = Math.max(first, Math.min(Math.max(0, req.seconds), Math.max(0, (media.info.duration || 0) - 0.05)));
    let wrapped = null;
    try { wrapped = await sink.getCanvas(t); } catch (e) { wrapped = null; }
    if (!wrapped) throw codeError('FRAME_FAILED', 'No picture at ' + req.seconds.toFixed(1) + ' s');
    if (req.signal && req.signal.aborted) throw codeError('ABORTED', 'Cancelled');
    const blob = await blobOf(wrapped.canvas, 0.82);
    const bytes = await blob.arrayBuffer();
    return new JpegBytes(bytes, await base64Of(blob));
  }

  function close() {
    closed = true;
    open.forEach((e) => { try { e.input.dispose(); } catch (err) { /* already released */ } });
    open.clear();
  }

  return { extract, close };
}
