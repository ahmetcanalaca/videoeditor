/*
 * Edit engine of the AI assistant. Pure functions on the same segment model the editor uses (model.js), no I/O.
 *
 * Time coordinates: every time an assistant tool receives is on the ORIGINAL timeline, i.e. the timeline as it was when the
 * user sent the request. Each piece of the working timeline remembers which part of that original timeline it came from
 * (b0..b1) and how it maps to the source file (s0 + (t - b0) * v0). Removing or re-timing parts earlier in the same request
 * therefore never shifts what a later "from 30 s to 40 s" refers to.
 *
 * Every tool call is atomic: it works on a draft and is committed only if it succeeded.
 */
(function (root, factory) {
  const model = typeof module === 'object' && module.exports ? require('./model') : root.VE.model;
  const api = factory(model);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VE = root.VE || {};
    root.VE.agentOps = api;
  }
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';

  const EPS = 1e-6;
  const MAX_PIECES = 500;
  const DEFAULT_ZOOM = 2;
  const FOCUS_NAMES = {
    center: [0.5, 0.5], middle: [0.5, 0.5],
    top: [0.5, 0.25], bottom: [0.5, 0.75], left: [0.25, 0.5], right: [0.75, 0.5],
    'top-left': [0.25, 0.25], 'top-right': [0.75, 0.25], 'bottom-left': [0.25, 0.75], 'bottom-right': [0.75, 0.75],
  };
  const EXPORT_ENUMS = {
    resolution: ['original', '1080', '720', '480'],
    aspect: ['auto', '16:9', '9:16', '1:1', '4:3'],
    fps: ['auto', '24', '25', '30', '50', '60'],
    quality: ['high', 'medium', 'low'],
  };
  const START_KEYS = ['start', 'start_s', 'start_seconds', 'start_time'];
  const END_KEYS = ['end', 'end_s', 'end_seconds', 'end_time'];

  const clamp = M.clamp;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const r2 = (v) => Math.round(v * 100) / 100;
  const outDur = (seg) => (seg.out - seg.in) / seg.speed;
  function fmtT(sec) {
    const cs = Math.round(Math.max(0, sec) * 100);
    const frac = cs % 100;
    return M.formatTime(Math.floor(cs / 100), false) + (frac ? '.' + String(frac).padStart(2, '0') : '');
  }
  const fmtRange = (a, b) => fmtT(a) + '–' + fmtT(b);
  const fail = (error) => ({ ok: false, error });

  function pick(args, keys) {
    for (const k of keys) if (args[k] !== undefined && args[k] !== null && args[k] !== '') return args[k];
    return undefined;
  }

  // Seconds as a number, or "m:ss(.cc)" / "h:mm:ss", or a numeric string (decimal comma allowed).
  function parseTime(v) {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    const s = String(v).trim().replace(',', '.');
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
    if (m) return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
    return NaN;
  }

  // A file name goes into the prompt: no control characters, and no angle brackets (a name such as "</timeline_summary> ..." could otherwise
  // pretend that the summary has ended and what follows is an instruction).
  function cleanName(name, fallback) {
    const s = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    return s || fallback;
  }

  const copySeg = (s) => Object.assign({}, s);
  const zoomCurve = (z0, z1, f) => (z0 === z1 ? z0 : z0 * Math.pow(z1 / z0, clamp(f, 0, 1)));

  function sameSegments(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      const keys = new Set(Object.keys(x).concat(Object.keys(y)));
      for (const k of keys) {
        if (typeof x[k] === 'number' && typeof y[k] === 'number') { if (Math.abs(x[k] - y[k]) > 1e-9) return false; } else if (x[k] !== y[k]) return false;
      }
    }
    return true;
  }

  /* ------------------------------------------------------------------ session */

  class Session {
    // opts: { segments, media: Map|object (id -> {name,duration,fps,hasAudio,displayWidth,displayHeight}), exportSettings, playhead, selectedId, shareNames }
    constructor(opts) {
      const o = opts || {};
      this.media = o.media instanceof Map ? o.media : new Map(Object.entries(o.media || {}));
      this.shareNames = o.shareNames !== false;
      this.initialSegments = (o.segments || []).map((s) => M.sanitizeSegment(copySeg(s), this.media.get(s.mediaId)));
      this.initialExport = Object.assign({ resolution: 'original', aspect: 'auto', fps: 'auto', quality: 'high' }, o.exportSettings || {});
      this.pieces = [];
      let t = 0;
      this.initialSegments.forEach((seg, i) => {
        const d = outDur(seg);
        this.pieces.push({ seg: copySeg(seg), origin: i + 1, b0: t, b1: t + d, s0: seg.in, v0: seg.speed });
        t += d;
      });
      this.initialPieces = this.pieces.slice();
      this.baseTotal = t;
      this.origins = this.pieces.map((p) => ({ clip: p.origin, b0: p.b0, b1: p.b1 }));
      this.playhead = clamp(Number(o.playhead) || 0, 0, t);
      const sel = o.selectedId ? this.initialSegments.findIndex((s) => s.id === o.selectedId) : -1;
      this.selectedClip = sel >= 0 ? sel + 1 : null;
      this.exportSettings = Object.assign({}, this.initialExport);
      this.actions = [];
      this.uiActions = [];
      this.nameOf = this._nameMap();
      this.found = new Map(); // results of find_in_video: id -> { id, label, intervals: [{ start, end, box? }] }, times on the original timeline
    }

    // The original timeline as a list of pieces of source files: lets the vision scan turn a time on the timeline into a frame of a file.
    originalMap() {
      return this.initialSegments.map((seg, i) => ({ b0: this.origins[i].b0, b1: this.origins[i].b1, mediaId: seg.mediaId, in: seg.in, speed: seg.speed }));
    }

    // Keeps what find_in_video found so that editing tools can refer to it by id (found="f1").
    registerFound(spec) {
      const intervals = (spec.intervals || [])
        .map((iv) => ({ start: clamp(Number(iv.start), 0, this.baseTotal), end: clamp(Number(iv.end), 0, this.baseTotal), box: iv.box && Number.isFinite(iv.box.x1) ? { x1: clamp(iv.box.x1, 0, 1), y1: clamp(iv.box.y1, 0, 1), x2: clamp(iv.box.x2, 0, 1), y2: clamp(iv.box.y2, 0, 1) } : undefined }))
        .filter((iv) => iv.end - iv.start > 0.01)
        .sort((a, b) => a.start - b.start);
      const id = 'f' + (this.found.size + 1);
      this.found.set(id, { id, label: cleanName(spec.label, 'object'), intervals });
      return id;
    }

    _nameMap() {
      const map = new Map();
      for (const seg of this.initialSegments) {
        if (map.has(seg.mediaId)) continue;
        const n = map.size + 1;
        const media = this.media.get(seg.mediaId);
        map.set(seg.mediaId, this.shareNames ? cleanName(media && media.name, 'video ' + n) : 'video ' + n);
      }
      return map;
    }

    currentTotal() {
      return this.pieces.reduce((sum, p) => sum + outDur(p.seg), 0);
    }

    _listPieces(offset, limit) {
      let t = 0;
      const rows = this.pieces.map((p, i) => {
        const d = outDur(p.seg);
        const media = this.media.get(p.seg.mediaId);
        const row = {
          n: i + 1,
          clip: p.origin,
          file: this.nameOf.get(p.seg.mediaId) || 'video',
          now_start: r3(t),
          now_end: r3(t + d),
          orig_start: r3(p.b0),
          orig_end: r3(p.b1),
          speed: r2(p.seg.speed),
          zoom: [r2(p.seg.zoomFrom), r2(p.seg.zoomTo)],
          focus: [r2(p.seg.fx), r2(p.seg.fy)],
          volume_percent: Math.round(p.seg.volume * 100),
          mute: !!p.seg.mute,
          fade_in: r2(p.seg.fadeIn),
          fade_out: r2(p.seg.fadeOut),
          has_audio: !!(media && media.hasAudio),
        };
        t += d;
        return row;
      });
      return rows.slice(offset, offset + limit);
    }

    // Compact description of the timeline for the model (this is what the model sees instead of the video).
    describe(limit) {
      const lim = Math.max(1, Math.min(Number(limit) || 80, 200));
      const rows = this._listPieces(0, lim).map((r) => {
        const p = this.pieces[r.n - 1];
        const media = this.media.get(p.seg.mediaId);
        return {
          clip: r.clip,
          file: r.file,
          start: r.now_start,
          end: r.now_end,
          duration: r3(r.now_end - r.now_start),
          source_in: r3(p.seg.in),
          source_out: r3(p.seg.out),
          speed: r.speed,
          zoom: r.zoom,
          focus: r.focus,
          volume_percent: r.volume_percent,
          mute: r.mute,
          fade_in: r.fade_in,
          fade_out: r.fade_out,
          has_audio: r.has_audio,
          resolution: media && media.displayWidth ? media.displayWidth + 'x' + media.displayHeight : null,
          fps: media && media.fps ? r2(media.fps) : null,
        };
      });
      return {
        total_seconds: r3(this.currentTotal()),
        playhead_seconds: r3(this.playhead),
        selected_clip: this.selectedClip,
        clip_count: this.pieces.length,
        clips_listed: rows.length,
        export_settings: Object.assign({}, this.exportSettings),
        clips: rows,
      };
    }

    apply(name, rawArgs) {
      const tool = TOOLS[name];
      if (!tool) return fail('Unknown tool "' + name + '". Available tools: ' + Object.keys(TOOLS).join(', ') + '.');
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      const draft = { pieces: this.pieces.slice(), exportSettings: Object.assign({}, this.exportSettings), actions: [], uiActions: [], revert: false };
      let res;
      try {
        res = RANGE_TOOLS.has(name) && args.found !== undefined && args.found !== null && args.found !== '' ? this._runOnFound(name, tool, draft, args) : tool.run(this, draft, args);
      } catch (e) {
        return fail('Internal error while running ' + name + ': ' + (e && e.message));
      }
      if (!res || res.ok === false) return fail((res && res.error) || 'The tool failed.');
      if (tool.readOnly) return Object.assign({ ok: true }, res.data || {});
      if (draft.pieces.length > MAX_PIECES) return fail('That would create more than ' + MAX_PIECES + ' clips. Use fewer, larger ranges.');
      if (draft.revert) {
        this.pieces = this.initialPieces.slice();
        this.exportSettings = Object.assign({}, this.initialExport);
        this.actions = [];
        this.uiActions = [];
      } else {
        this.pieces = draft.pieces;
        this.exportSettings = draft.exportSettings;
        this.actions.push(...draft.actions);
        draft.uiActions.forEach((u) => { if (!this.uiActions.includes(u)) this.uiActions.push(u); });
      }
      return Object.assign({ ok: true, message: res.message, current_total_seconds: r3(this.currentTotal()) }, res.data || {});
    }

    // A range tool that was given found="f1": the tool runs once for every part of the video where the thing was seen. Everything happens
    // on the same draft, so the whole call is still atomic. (set_zoom gets the found object's position as its focus point.)
    _runOnFound(name, tool, d, args) {
      const key = String(args.found).trim();
      const f = this.found.get(key);
      if (!f) return fail('Unknown found id "' + key + '". ' + (this.found.size ? 'Known ids: ' + Array.from(this.found.keys()).join(', ') + '.' : 'Call find_in_video first.'));
      if (!f.intervals.length) return fail('Nothing was found for "' + f.label + '", so there is nothing to edit. Tell the user.');
      const occ = pickOccurrence(f.intervals, args.occurrence);
      if (occ.error) return fail(occ.error);
      let list = occ.list;
      if (hasRangeArgs(args)) {
        const r = resolveRange(this, args, false);
        if (r.error) return fail(r.error);
        list = list.map((iv) => ({ start: Math.max(iv.start, r.a), end: Math.min(iv.end, r.b), box: iv.box })).filter((iv) => iv.end - iv.start > 0.05);
        if (!list.length) return fail('The parts where "' + f.label + '" was found are not inside that time range.');
      }
      const base = Object.assign({}, args);
      for (const k of ['found', 'occurrence', 'clip', 'first_seconds', 'last_seconds'].concat(START_KEYS, END_KEYS)) delete base[k];

      if (name === 'keep_range') {
        const gaps = [];
        let cur = 0;
        for (const iv of mergeIntervals(list)) {
          if (iv.start > cur + 0.01) gaps.push([cur, iv.start]);
          cur = Math.max(cur, iv.end);
        }
        if (this.baseTotal > cur + 0.01) gaps.push([cur, this.baseTotal]);
        let removed = 0;
        for (const g of gaps) {
          const r = TOOLS.remove_range.run(this, d, { start: g[0], end: g[1] });
          if (r && r.ok !== false && r.data) removed += r.data.removed_seconds || 0;
        }
        const kept = mergeIntervals(list).map((iv) => fmtRange(iv.start, iv.end)).join(', ');
        return { ok: true, message: 'Kept only the part(s) where "' + f.label + '" was found (' + kept + '); everything else was removed (' + r2(removed) + ' s).' };
      }

      const msgs = [];
      const errors = [];
      let okCount = 0;
      let removedSeconds = 0;
      for (const iv of list) {
        const a = Object.assign({}, base, { start: r3(iv.start), end: r3(iv.end) });
        let r;
        if (name === 'set_zoom') r = runZoomOnFound(this, tool, d, a, iv);
        else r = tool.run(this, d, a);
        if (!r || r.ok === false) { errors.push((r && r.error) || 'The tool failed.'); continue; }
        okCount++;
        msgs.push(r.message);
        if (r.data && r.data.removed_seconds) removedSeconds += r.data.removed_seconds;
      }
      if (!okCount) return fail(errors[0]);
      const where = 'Applied to ' + okCount + ' part(s) where "' + f.label + '" was found (' + key + '): ';
      return { ok: true, message: where + msgs.join(' ') + (errors.length ? ' Skipped ' + errors.length + ' part(s): ' + errors[0] : ''), data: removedSeconds ? { removed_seconds: r2(removedSeconds) } : undefined };
    }

    result() {
      const segments = this.pieces.map((p) => M.sanitizeSegment(copySeg(p.seg), this.media.get(p.seg.mediaId)));
      const exportChanged = Object.keys(this.exportSettings).some((k) => this.exportSettings[k] !== this.initialExport[k]);
      return {
        segments,
        changed: !sameSegments(segments, this.initialSegments),
        exportSettings: Object.assign({}, this.exportSettings),
        exportChanged,
        actions: this.actions.slice(),
        uiActions: this.uiActions.slice(),
        currentTotal: this.currentTotal(),
        baseTotal: this.baseTotal,
      };
    }
  }

  /* ------------------------------------------------------------------ draft helpers */

  // Smallest piece (in original-timeline seconds) that a cut may leave behind.
  function minPieceBase(s, p) {
    const media = s.media.get(p.seg.mediaId);
    const fps = media && media.fps > 0 ? media.fps : 30;
    return Math.max(M.LIMITS.minSourceDur, 0.5 / fps) / p.v0;
  }

  // Splits the draft at original-timeline time t. A cut that would leave a sliver snaps to the nearest piece boundary.
  // Returns the effective time.
  function cutAt(s, d, t) {
    const pcs = d.pieces;
    for (let i = 0; i < pcs.length; i++) {
      const p = pcs[i];
      if (t > p.b0 + EPS && t < p.b1 - EPS) {
        const minBase = minPieceBase(s, p);
        if (t - p.b0 < minBase) return p.b0;
        if (p.b1 - t < minBase) return p.b1;
        const srcMid = p.s0 + (t - p.b0) * p.v0;
        const frac = (srcMid - p.seg.in) / (p.seg.out - p.seg.in);
        const parts = M.splitSegment(p.seg, frac);
        pcs.splice(i, 1,
          { seg: parts[0], origin: p.origin, b0: p.b0, b1: t, s0: p.s0, v0: p.v0 },
          { seg: parts[1], origin: p.origin, b0: t, b1: p.b1, s0: srcMid, v0: p.v0 });
        return t;
      }
    }
    return t;
  }

  const coveredIdx = (pcs, a, b) => {
    const out = [];
    pcs.forEach((p, i) => { if (p.b0 >= a - EPS && p.b1 <= b + EPS) out.push(i); });
    return out;
  };

  function patchPieces(s, d, idx, patch) {
    idx.forEach((i) => {
      const p = d.pieces[i];
      const change = typeof patch === 'function' ? patch(p, i) : patch;
      d.pieces[i] = Object.assign({}, p, { seg: M.sanitizeSegment(Object.assign({}, p.seg, change), s.media.get(p.seg.mediaId)) });
    });
  }

  // Resolves {start,end,clip,first_seconds,last_seconds} to a range on the original timeline.
  function resolveRange(s, args, required) {
    const a0 = parseTime(pick(args, START_KEYS));
    const b0 = parseTime(pick(args, END_KEYS));
    if (Number.isNaN(a0) || Number.isNaN(b0)) return { error: 'Invalid time value. Use seconds (e.g. 90) or m:ss (e.g. 1:30).' };
    // "the first N seconds" / "the last N seconds" without any arithmetic on the model's side
    const first = parseTime(pick(args, ['first_seconds']));
    const last = parseTime(pick(args, ['last_seconds']));
    if (Number.isNaN(first) || Number.isNaN(last) || (first !== undefined && first <= 0) || (last !== undefined && last <= 0)) return { error: 'first_seconds and last_seconds must be positive numbers of seconds.' };
    let lo = 0;
    let hi = s.baseTotal;
    const hasClip = args.clip !== undefined && args.clip !== null && args.clip !== '';
    if (hasClip) {
      const n = Number(args.clip);
      const o = Number.isInteger(n) ? s.origins[n - 1] : null;
      if (!o) return { error: 'clip must be an integer between 1 and ' + s.origins.length + ' (the clip numbers of the timeline summary).' };
      lo = o.b0;
      hi = o.b1;
    } else if (a0 === undefined && b0 === undefined && first === undefined && last === undefined && required) {
      return { error: 'Specify start and/or end (seconds on the original timeline), first_seconds / last_seconds, or a clip number.' };
    }
    if (first !== undefined) hi = Math.min(hi, lo + first);
    if (last !== undefined) lo = Math.max(lo, hi - last);
    // An end far beyond the video WITHOUT a start is a misreading (e.g. "the last 5 seconds" understood as total+5), not a rounding slip:
    // clamping it would silently change the whole video, so the model is told instead.
    if (a0 === undefined && first === undefined && last === undefined && !hasClip && b0 !== undefined && b0 > s.baseTotal + 1) {
      return { error: 'end (' + r3(b0) + ' s) is beyond the end of the video (' + r3(s.baseTotal) + ' s) and no start was given, so the whole video would be affected. For "the last N seconds" use last_seconds=N; otherwise give a start and an end inside 0–' + r3(s.baseTotal) + '.' };
    }
    const a = a0 === undefined ? lo : Math.max(a0, lo, 0);
    const b = b0 === undefined ? hi : Math.min(b0, hi, s.baseTotal);
    if (!(b - a > 0.01)) {
      return { error: 'Empty or inverted range ' + r3(a) + '–' + r3(b) + ' s. The original timeline is ' + r3(s.baseTotal) + ' s long' + (hasClip ? ' and that clip spans ' + r3(lo) + '–' + r3(hi) + ' s' : '') + '.' };
    }
    return { a, b };
  }

  function hasRangeArgs(args) {
    return pick(args, START_KEYS) !== undefined || pick(args, END_KEYS) !== undefined || pick(args, ['first_seconds', 'last_seconds']) !== undefined || (args.clip !== undefined && args.clip !== null && args.clip !== '');
  }

  // Range tools share the same preparation: resolve, cut at both ends, find the pieces inside.
  function prepareRange(s, d, args) {
    const r = resolveRange(s, args, true);
    if (r.error) return { error: r.error };
    const a = cutAt(s, d, r.a);
    const b = cutAt(s, d, r.b);
    const idx = coveredIdx(d.pieces, a, b);
    if (!idx.length) return { error: 'There is no remaining content in ' + fmtRange(a, b) + ' (it may already have been removed earlier in this request).' };
    idx.sort((x, y) => d.pieces[x].b0 - d.pieces[y].b0);
    return { a, b, idx };
  }

  function parseFocus(args) {
    const named = typeof args.focus === 'string' ? args.focus.trim().toLowerCase().replace(/[\s_]+/g, '-') : '';
    if (named) {
      if (!FOCUS_NAMES[named]) return { error: 'Unknown focus "' + args.focus + '". Use one of: ' + Object.keys(FOCUS_NAMES).join(', ') + ' or focus_x/focus_y (0–1).' };
      return { fx: FOCUS_NAMES[named][0], fy: FOCUS_NAMES[named][1] };
    }
    const fx = args.focus_x === undefined || args.focus_x === null ? undefined : Number(args.focus_x);
    const fy = args.focus_y === undefined || args.focus_y === null ? undefined : Number(args.focus_y);
    if ((fx !== undefined && !Number.isFinite(fx)) || (fy !== undefined && !Number.isFinite(fy))) return { error: 'focus_x and focus_y must be numbers between 0 and 1.' };
    if (fx === undefined && fy === undefined) return {};
    return { fx: fx === undefined ? undefined : clamp(fx, 0, 1), fy: fy === undefined ? undefined : clamp(fy, 0, 1) };
  }

  /* ------------------------------------------------------------------ things found by find_in_video */

  const RANGE_TOOLS = new Set(['remove_range', 'keep_range', 'set_speed', 'set_zoom', 'set_volume', 'set_fade', 'reset_effects']);

  function pickOccurrence(list, v) {
    if (v === undefined || v === null || v === '') return { list };
    const t = String(v).trim().toLowerCase();
    if (t === 'all') return { list };
    if (t === 'first') return { list: [list[0]] };
    if (t === 'last') return { list: [list[list.length - 1]] };
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1 || n > list.length) return { error: 'occurrence must be "all", "first", "last" or a number from 1 to ' + list.length + ' (this result has ' + list.length + ' part(s)).' };
    return { list: [list[n - 1]] };
  }

  function mergeIntervals(list) {
    const out = [];
    for (const iv of list.slice().sort((x, y) => x.start - y.start)) {
      const last = out[out.length - 1];
      if (last && iv.start <= last.end + 0.01) last.end = Math.max(last.end, iv.end); else out.push({ start: iv.start, end: iv.end });
    }
    return out;
  }

  // How far to zoom so that the object takes up about 60 % of the picture (never so far that it is cut off, never beyond 3.5×).
  function autoZoomFactor(box) {
    const m = Math.max(box.x2 - box.x1, box.y2 - box.y1, 0.02);
    return r2(Math.max(1.1, Math.min(clamp(0.6 / m, 1.25, 3.5), 0.95 / m)));
  }

  // Zoom on something that was found: focus on the object, a short zoom in at the start, held while it is visible and a short zoom out at the end.
  function runZoomOnFound(s, tool, d, a, iv) {
    const mode = String(a.mode || 'in').toLowerCase();
    const given = (v) => v !== undefined && v !== null && v !== '';
    if (iv.box) {
      if (!given(a.focus) && !given(a.focus_x) && !given(a.focus_y)) { a.focus_x = r3((iv.box.x1 + iv.box.x2) / 2); a.focus_y = r3((iv.box.y1 + iv.box.y2) / 2); }
      if (!given(a.factor) && (mode === 'in' || mode === 'out' || mode === 'hold')) a.factor = autoZoomFactor(iv.box);
    }
    const len = iv.end - iv.start;
    if ((mode !== 'in' && mode !== 'hold') || len < 1.2) return tool.run(s, d, a);
    const ramp = clamp(len * 0.2, 0.4, 1);
    const rampOut = iv.end >= s.baseTotal - 0.05 ? 0 : ramp; // no zoom out at the very end of the video
    const steps = [Object.assign({}, a, { mode: 'in', end: r3(iv.start + ramp) }), Object.assign({}, a, { mode: 'hold', start: r3(iv.start + ramp), end: r3(iv.end - rampOut) })];
    if (rampOut) steps.push(Object.assign({}, a, { mode: 'out', start: r3(iv.end - rampOut) }));
    const before = d.actions.length;
    for (const step of steps) {
      const r = tool.run(s, d, step);
      if (!r || r.ok === false) return r;
    }
    const factor = clamp(given(a.factor) ? Number(a.factor) : DEFAULT_ZOOM, M.LIMITS.zoomMin, M.LIMITS.zoomMax);
    const focus = parseFocus(a);
    const fx = focus.fx !== undefined ? focus.fx : 0.5;
    const fy = focus.fy !== undefined ? focus.fy : 0.5;
    d.actions.splice(before, d.actions.length - before, { op: 'zoom', start: r3(iv.start), end: r3(iv.end), from: 1, to: r2(factor), focus: [r2(fx), r2(fy)], eased: true });
    return { ok: true, message: 'Zoom 1×→' + r2(factor) + '× on ' + fmtRange(iv.start, iv.end) + ' (eased in and out, focus ' + r2(fx) + ', ' + r2(fy) + ').' };
  }

  /* ------------------------------------------------------------------ tools */

  const TOOLS = {
    get_timeline: {
      readOnly: true,
      run(s, d, args) {
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        const limit = Math.max(1, Math.min(Math.floor(Number(args.limit) || 60), 200));
        return {
          ok: true,
          data: {
            current_total_seconds: r3(s.currentTotal()),
            original_total_seconds: r3(s.baseTotal),
            piece_count: s.pieces.length,
            note: 'now_* = position on the timeline as it is now; orig_* = position on the original timeline (use these for tool arguments).',
            pieces: s._listPieces(offset, limit),
          },
        };
      },
    },

    split_at: {
      run(s, d, args) {
        const raw = Array.isArray(args.times) ? args.times : (args.time !== undefined ? [args.time] : []);
        if (!raw.length) return fail('Provide times: an array of seconds on the original timeline.');
        if (raw.length > 100) return fail('At most 100 split points per call.');
        const done = [];
        const skipped = [];
        for (const v of raw) {
          const t = parseTime(v);
          if (t === undefined || Number.isNaN(t)) return fail('Invalid time value ' + JSON.stringify(v) + '. Use seconds (e.g. 90) or m:ss (e.g. 1:30).');
          if (t <= EPS || t >= s.baseTotal - EPS) { skipped.push(t); continue; }
          const before = d.pieces.length;
          const eff = cutAt(s, d, t);
          if (d.pieces.length > before) done.push(eff); else skipped.push(t);
        }
        if (!done.length) return fail('Nothing was split: ' + skipped.map(r3).join(', ') + ' s are at the very start/end of the video, on an existing cut, or inside content that was already removed.');
        done.sort((x, y) => x - y);
        d.actions.push({ op: 'split', times: done.map(r3) });
        return { ok: true, message: 'Split at ' + done.map(fmtT).join(', ') + '.' + (skipped.length ? ' Skipped (already a cut or outside): ' + skipped.map(fmtT).join(', ') + '.' : '') };
      },
    },

    remove_range: {
      run(s, d, args) {
        const r = resolveRange(s, args, true);
        if (r.error) return fail(r.error);
        const a = cutAt(s, d, r.a);
        const b = cutAt(s, d, r.b);
        const idx = coveredIdx(d.pieces, a, b);
        if (!idx.length) return fail('There is no remaining content in ' + fmtRange(a, b) + ' (it may already have been removed earlier in this request).');
        if (idx.length === d.pieces.length) return fail('That would delete the entire video. Ask the user to confirm, or tell them to start a new project instead.');
        const seconds = idx.reduce((sum, i) => sum + outDur(d.pieces[i].seg), 0);
        d.pieces = d.pieces.filter((p, i) => !idx.includes(i));
        d.actions.push({ op: 'remove', start: r3(a), end: r3(b), seconds: r3(seconds) });
        return { ok: true, message: 'Removed ' + fmtRange(a, b) + ' (' + r2(seconds) + ' s); the following content moved earlier.', data: { removed_seconds: r2(seconds) } };
      },
    },

    keep_range: {
      run(s, d, args) {
        const p = prepareRange(s, d, args);
        if (p.error) return fail(p.error);
        d.pieces = d.pieces.filter((x, i) => p.idx.includes(i));
        d.actions.push({ op: 'keep', start: r3(p.a), end: r3(p.b) });
        return { ok: true, message: 'Kept only ' + fmtRange(p.a, p.b) + '; everything before and after was removed.' };
      },
    },

    set_speed: {
      run(s, d, args) {
        let sp = Number(args.speed);
        if (!Number.isFinite(sp) || sp <= 0) return fail('speed must be a positive number between 0.25 and 8 (1 = normal speed).');
        const clampedTo = sp > M.LIMITS.speedMax ? M.LIMITS.speedMax : (sp < M.LIMITS.speedMin ? M.LIMITS.speedMin : null);
        const requested = sp;
        if (clampedTo !== null) sp = clampedTo;
        const p = prepareRange(s, d, args);
        if (p.error) return fail(p.error);
        patchPieces(s, d, p.idx, { speed: sp });
        d.actions.push({ op: 'speed', start: r3(p.a), end: r3(p.b), speed: r3(sp), clamped: clampedTo !== null });
        return {
          ok: true,
          message: 'Speed of ' + fmtRange(p.a, p.b) + ' set to ' + r2(sp) + '×.' + (clampedTo !== null ? ' The requested ' + requested + '× is outside the supported 0.25–8× range, so ' + clampedTo + '× was used; tell the user.' : ''),
        };
      },
    },

    set_zoom: {
      run(s, d, args) {
        const mode = String(args.mode || 'in').toLowerCase();
        if (!['in', 'out', 'hold', 'custom', 'none'].includes(mode)) return fail('mode must be one of: in, out, hold, custom, none.');
        const num = (v, def) => (v === undefined || v === null || v === '' ? def : Number(v));
        const factor = clamp(num(args.factor, DEFAULT_ZOOM), M.LIMITS.zoomMin, M.LIMITS.zoomMax);
        let z0;
        let z1;
        if (mode === 'in') { z0 = 1; z1 = factor; } else if (mode === 'out') { z0 = factor; z1 = 1; } else if (mode === 'hold') { z0 = factor; z1 = factor; } else if (mode === 'none') { z0 = 1; z1 = 1; } else {
          z0 = num(args.zoom_from, NaN);
          z1 = num(args.zoom_to, NaN);
          if (!Number.isFinite(z0) || !Number.isFinite(z1)) return fail('mode "custom" needs zoom_from and zoom_to (1–4).');
          z0 = clamp(z0, M.LIMITS.zoomMin, M.LIMITS.zoomMax);
          z1 = clamp(z1, M.LIMITS.zoomMin, M.LIMITS.zoomMax);
        }
        if (!Number.isFinite(factor)) return fail('factor must be a number between 1 and 4.');
        const focus = parseFocus(args);
        if (focus.error) return fail(focus.error);
        const p = prepareRange(s, d, args);
        if (p.error) return fail(p.error);
        // One focus for the whole range (otherwise the picture would jump at piece boundaries): the given one, else the first piece's.
        const first = d.pieces[p.idx[0]].seg;
        const fx = focus.fx !== undefined ? focus.fx : first.fx;
        const fy = focus.fy !== undefined ? focus.fy : first.fy;
        const total = p.idx.reduce((sum, i) => sum + outDur(d.pieces[i].seg), 0);
        let acc = 0;
        patchPieces(s, d, p.idx, (piece) => {
          const dur = outDur(piece.seg);
          const patch = { zoomFrom: zoomCurve(z0, z1, total > 0 ? acc / total : 0), zoomTo: zoomCurve(z0, z1, total > 0 ? (acc + dur) / total : 1), fx, fy };
          acc += dur;
          return patch;
        });
        d.actions.push({ op: 'zoom', start: r3(p.a), end: r3(p.b), from: r2(z0), to: r2(z1), focus: [r2(fx), r2(fy)] });
        const what = mode === 'none' ? 'Zoom removed from ' : 'Zoom ' + r2(z0) + '×→' + r2(z1) + '× over ';
        return { ok: true, message: what + fmtRange(p.a, p.b) + (mode === 'none' ? '.' : ' (focus ' + r2(fx) + ', ' + r2(fy) + ').') };
      },
    },

    set_volume: {
      run(s, d, args) {
        const hasVol = args.volume_percent !== undefined && args.volume_percent !== null && args.volume_percent !== '';
        const hasMute = args.mute !== undefined && args.mute !== null;
        if (!hasVol && !hasMute) return fail('Provide volume_percent (0–200, 100 = unchanged) and/or mute (true/false).');
        let vp = hasVol ? Number(args.volume_percent) : undefined;
        if (hasVol && !Number.isFinite(vp)) return fail('volume_percent must be a number between 0 and 200.');
        const clampedVol = hasVol && (vp < 0 || vp > 200);
        if (hasVol) vp = clamp(vp, 0, 200);
        const mute = hasMute ? (args.mute === true || args.mute === 'true') : undefined;
        const p = prepareRange(s, d, args);
        if (p.error) return fail(p.error);
        const patch = {};
        if (hasVol) { patch.volume = vp / 100; if (!hasMute && vp > 0) patch.mute = false; }
        if (hasMute) patch.mute = mute;
        patchPieces(s, d, p.idx, patch);
        const anyAudio = p.idx.some((i) => { const m = s.media.get(d.pieces[i].seg.mediaId); return m && m.hasAudio; });
        d.actions.push({ op: 'volume', start: r3(p.a), end: r3(p.b), volume_percent: hasVol ? Math.round(vp) : undefined, mute });
        const bits = [];
        if (hasVol) bits.push('volume ' + Math.round(vp) + '%');
        if (hasMute) bits.push(mute ? 'muted' : 'unmuted');
        return { ok: true, message: fmtRange(p.a, p.b) + ': ' + bits.join(', ') + '.' + (clampedVol ? ' (volume limited to 0–200%.)' : '') + (anyAudio ? '' : ' Note: that part has no audio track, so nothing will be audible either way.') };
      },
    },

    set_fade: {
      run(s, d, args) {
        const get = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
        const fi = get(args.fade_in);
        const fo = get(args.fade_out);
        if (fi === undefined && fo === undefined) return fail('Provide fade_in and/or fade_out in seconds (0–5).');
        if ((fi !== undefined && !Number.isFinite(fi)) || (fo !== undefined && !Number.isFinite(fo))) return fail('fade_in / fade_out must be numbers (seconds).');
        let idx;
        let a;
        let b;
        if (hasRangeArgs(args)) {
          const p = prepareRange(s, d, args);
          if (p.error) return fail(p.error);
          idx = p.idx; a = p.a; b = p.b;
        } else {
          if (!d.pieces.length) return fail('The timeline is empty.');
          idx = d.pieces.map((p, i) => i);
          a = 0; b = s.baseTotal;
        }
        const firstI = idx[0];
        const lastI = idx[idx.length - 1];
        if (fi !== undefined) patchPieces(s, d, [firstI], { fadeIn: clamp(fi, 0, 5) });
        if (fo !== undefined) patchPieces(s, d, [lastI], { fadeOut: clamp(fo, 0, 5) });
        d.actions.push({ op: 'fade', start: r3(a), end: r3(b), fade_in: fi === undefined ? undefined : r2(clamp(fi, 0, 5)), fade_out: fo === undefined ? undefined : r2(clamp(fo, 0, 5)) });
        const bits = [];
        if (fi !== undefined) bits.push('fade-in ' + r2(clamp(fi, 0, 5)) + ' s at the start');
        if (fo !== undefined) bits.push('fade-out ' + r2(clamp(fo, 0, 5)) + ' s at the end');
        return { ok: true, message: 'Applied ' + bits.join(' and ') + ' of ' + fmtRange(a, b) + ' (shortened automatically if the piece is shorter).' };
      },
    },

    reorder_clips: {
      run(s, d, args) {
        const order = args.order;
        if (!Array.isArray(order) || !order.length) return fail('order must be an array of clip numbers, e.g. [2,1,3].');
        const n = s.origins.length;
        const seen = new Set();
        for (const v of order) {
          const k = Number(v);
          if (!Number.isInteger(k) || k < 1 || k > n) return fail('order may only contain clip numbers from 1 to ' + n + '.');
          if (seen.has(k)) return fail('order must not repeat clip number ' + k + '.');
          seen.add(k);
        }
        const rest = [];
        for (let k = 1; k <= n; k++) if (!seen.has(k)) rest.push(k);
        const full = order.map(Number).concat(rest);
        const next = [];
        for (const k of full) d.pieces.filter((p) => p.origin === k).forEach((p) => next.push(p));
        const same = next.every((p, i) => p === d.pieces[i]);
        if (same) return fail('The clips are already in that order.');
        d.pieces = next;
        d.actions.push({ op: 'reorder', order: full });
        return { ok: true, message: 'Clips rearranged to the order ' + full.join(', ') + '.' };
      },
    },

    reset_effects: {
      run(s, d, args) {
        const p = prepareRange(s, d, args);
        if (p.error) return fail(p.error);
        patchPieces(s, d, p.idx, { speed: 1, zoomFrom: 1, zoomTo: 1, fx: 0.5, fy: 0.5, volume: 1, mute: false, fadeIn: 0, fadeOut: 0 });
        d.actions.push({ op: 'reset', start: r3(p.a), end: r3(p.b) });
        return { ok: true, message: 'Speed, zoom, volume and fades reset to defaults for ' + fmtRange(p.a, p.b) + '.' };
      },
    },

    set_export_settings: {
      run(s, d, args) {
        const changes = {};
        for (const key of Object.keys(EXPORT_ENUMS)) {
          if (args[key] === undefined || args[key] === null || args[key] === '') continue;
          const v = String(args[key]).toLowerCase().replace(/p$/, '');
          if (!EXPORT_ENUMS[key].includes(v)) return fail(key + ' must be one of: ' + EXPORT_ENUMS[key].join(', ') + '.');
          changes[key] = v;
        }
        if (!Object.keys(changes).length) return fail('Provide at least one of: resolution, aspect, fps, quality.');
        Object.assign(d.exportSettings, changes);
        d.actions.push(Object.assign({ op: 'export_settings' }, changes));
        return { ok: true, message: 'Export settings updated: ' + Object.keys(changes).map((k) => k + '=' + changes[k]).join(', ') + '. The user still has to choose the output file in the Export dialog.' };
      },
    },

    open_export_dialog: {
      run(s, d) {
        if (!d.pieces.length) return fail('The timeline is empty.');
        d.uiActions.push('open_export');
        d.actions.push({ op: 'open_export' });
        return { ok: true, message: 'The Export dialog will be opened for the user when you finish; they choose the file and start the export.' };
      },
    },

    revert_all: {
      run(s, d) {
        d.revert = true;
        return { ok: true, message: 'All changes made in this request were discarded; the timeline is back to its original state.' };
      },
    },
  };

  /* ------------------------------------------------------------------ tool definitions (the model's view) */

  const T = 'All times are seconds on the ORIGINAL timeline: the timeline as it was when the user sent this request (the start/end values in the timeline summary). They stay valid even after you removed or re-timed other parts earlier in the same request. ';
  const RANGE = {
    start: { type: 'number', description: 'Range start in seconds (original timeline). Omit to start at 0.' },
    end: { type: 'number', description: 'Range end in seconds (original timeline). Omit to run to the end of the video.' },
    first_seconds: { type: 'number', description: 'Alternative to start/end: the FIRST N seconds of the video, e.g. 10 for "the first 10 seconds".' },
    last_seconds: { type: 'number', description: 'Alternative to start/end: the LAST N seconds of the video, e.g. 5 for "the last 5 seconds".' },
    clip: { type: 'integer', description: 'Alternative to start/end: the clip number from the timeline summary; the whole clip is the range (start/end, if also given, narrow it).' },
  };
  const obj = (properties, required) => (required && required.length ? { type: 'object', properties, required } : { type: 'object', properties });

  const TOOL_DEFS = [
    {
      name: 'get_timeline',
      description: 'Return the current working timeline after the edits you made in this request: one row per piece with its current position (now_*) and its original position (orig_*).',
      parameters: obj({ offset: { type: 'integer', description: 'First row to return (default 0).' }, limit: { type: 'integer', description: 'Rows to return (default 60, max 200).' } }),
    },
    {
      name: 'split_at',
      description: T + 'Split the video into separate clips at the given times. Nothing is removed.',
      parameters: obj({ times: { type: 'array', items: { type: 'number' }, description: 'Split points in seconds.' } }, ['times']),
    },
    {
      name: 'remove_range',
      description: T + 'Cut out (delete) a range and close the gap. Use for "cut/delete/remove/skip this part" and "trim the first/last N seconds". Give start/end or clip.',
      parameters: obj(RANGE),
    },
    {
      name: 'keep_range',
      description: T + 'Keep ONLY the given range and delete everything before and after it. Use for "trim the video to X–Y", "only keep X–Y", "extract X–Y".',
      parameters: obj(RANGE),
    },
    {
      name: 'set_speed',
      description: T + 'Change the playback speed of a range: 1 = normal, 2 = twice as fast, 0.5 = half speed (slow motion). Supported 0.25–8; audio pitch is preserved; the range gets shorter or longer on the timeline.',
      parameters: obj(Object.assign({ speed: { type: 'number', description: 'Speed factor, 0.25–8.' } }, RANGE), ['speed']),
    },
    {
      name: 'set_zoom',
      description: T + 'Apply a smooth zoom animation over a range. mode "in" zooms from 1× to factor, "out" from factor to 1×, "hold" keeps factor for the whole range, "custom" goes from zoom_from to zoom_to, "none" removes zoom. factor defaults to 2 (allowed 1–4). The zoom runs over the whole range. You cannot see the video, so only choose a focus the user described (e.g. "top left"); otherwise use the center.',
      parameters: obj(Object.assign({
        mode: { type: 'string', enum: ['in', 'out', 'hold', 'custom', 'none'], description: 'Zoom type (default "in").' },
        factor: { type: 'number', description: 'Target zoom for in/out/hold, 1–4 (default 2).' },
        zoom_from: { type: 'number', description: 'Start zoom for mode custom, 1–4.' },
        zoom_to: { type: 'number', description: 'End zoom for mode custom, 1–4.' },
        focus: { type: 'string', enum: Object.keys(FOCUS_NAMES), description: 'Where to zoom into.' },
        focus_x: { type: 'number', description: 'Horizontal focus 0–1 (0 = left, 1 = right); alternative to focus.' },
        focus_y: { type: 'number', description: 'Vertical focus 0–1 (0 = top, 1 = bottom); alternative to focus.' },
      }, RANGE)),
    },
    {
      name: 'set_volume',
      description: T + 'Set the audio volume of a range and/or mute it. volume_percent 100 = unchanged, 0 = silent, up to 200. Setting a volume above 0 also unmutes unless mute is given.',
      parameters: obj(Object.assign({ volume_percent: { type: 'number', description: '0–200.' }, mute: { type: 'boolean', description: 'true = mute, false = unmute.' } }, RANGE)),
    },
    {
      name: 'set_fade',
      description: T + 'Add a fade-in (picture from black, audio up) at the start of the range and/or a fade-out at its end. With no range, fade_in is applied to the very start of the video and fade_out to the very end. Seconds, 0–5.',
      parameters: obj(Object.assign({ fade_in: { type: 'number', description: 'Fade-in length in seconds.' }, fade_out: { type: 'number', description: 'Fade-out length in seconds.' } }, RANGE)),
    },
    {
      name: 'reorder_clips',
      description: 'Rearrange the clips. order lists the clip numbers (the "clip" field of the timeline summary) in the desired new order; clips you do not list keep their relative order after the listed ones.',
      parameters: obj({ order: { type: 'array', items: { type: 'integer' }, description: 'Clip numbers, e.g. [2,1,3].' } }, ['order']),
    },
    {
      name: 'reset_effects',
      description: T + 'Remove speed, zoom, volume/mute and fade settings from a range. It does not bring back removed content.',
      parameters: obj(RANGE),
    },
    {
      name: 'set_export_settings',
      description: 'Change the options that the Export dialog will use. resolution is the shorter side (original, 1080, 720, 480), aspect auto/16:9/9:16/1:1/4:3, fps auto/24/25/30/50/60, quality high/medium/low. The user still chooses the output file.',
      parameters: obj({
        resolution: { type: 'string', enum: EXPORT_ENUMS.resolution },
        aspect: { type: 'string', enum: EXPORT_ENUMS.aspect },
        fps: { type: 'string', enum: EXPORT_ENUMS.fps },
        quality: { type: 'string', enum: EXPORT_ENUMS.quality },
      }),
    },
    {
      name: 'open_export_dialog',
      description: 'Open the Export dialog for the user when you are done. You cannot choose the output file or start the export yourself.',
      parameters: obj({}),
    },
    {
      name: 'revert_all',
      description: 'Discard every change made so far in THIS request and return to the original timeline (use it to start over after a mistake).',
      parameters: obj({}),
    },
  ];

  /* ------------------------------------------------------------------ the video as seen by find_in_video */

  const FOUND_PROPS = {
    found: { type: 'string', description: 'Instead of start/end: the id returned by find_in_video (e.g. "f1"). The tool is applied to every part of the video where that thing was seen.' },
    occurrence: { type: 'string', description: 'Only with found: "all" (default), "first", "last" or a part number (1, 2, ...).' },
  };

  const FIND_TOOL = {
    name: 'find_in_video',
    description: 'LOOK at the video: find WHEN a person, animal, object, screen or other thing is visible (and where in the picture). Returns time ranges and an id; then pass found="<id>" to remove_range, keep_range, set_speed, set_zoom, set_volume, set_fade or reset_effects. It examines frames and takes seconds to minutes, so call it once per thing. object: a short English noun ("dog", "person", "laptop screen"). Give color or position ONLY if the user said so.',
    parameters: obj({
      object: { type: 'string', description: 'Short English noun phrase for the thing to find, e.g. "dog", "car", "person", "whiteboard".' },
      color: { type: 'string', description: 'Colour of the thing, only if the user named one (English, e.g. "red").' },
      position: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'center'], description: 'Where in the picture, only if the user said so (e.g. "the car on the left").' },
      attributes: { type: 'string', description: 'Other words that tell it apart (optional, English), e.g. "wearing a hat".' },
      start: { type: 'number', description: 'Only look from this time (seconds, original timeline). Optional.' },
      end: { type: 'number', description: 'Only look until this time (seconds, original timeline). Optional.' },
    }, ['object']),
  };

  // The tool list for a model that can LOOK at the video: every range tool also takes found=, and find_in_video is added.
  // Everybody else keeps TOOL_DEFS unchanged.
  function getToolDefs(opts) {
    if (!(opts && opts.perception)) return TOOL_DEFS;
    const defs = TOOL_DEFS.map((def) => (RANGE_TOOLS.has(def.name)
      ? Object.assign({}, def, { parameters: Object.assign({}, def.parameters, { properties: Object.assign({}, def.parameters.properties, FOUND_PROPS) }) })
      : def));
    defs.push(FIND_TOOL);
    return defs;
  }

  return { Session, TOOL_DEFS, TOOL_NAMES: Object.keys(TOOLS), getToolDefs, FIND_TOOL_NAME: FIND_TOOL.name, autoZoomFactor, parseTime, FOCUS_NAMES, EXPORT_ENUMS, MAX_PIECES };
});
