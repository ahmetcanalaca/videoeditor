(function () {
  'use strict';
  window.VE = window.VE || {};
  const M = VE.model;

  /* ---------- tiny event bus ---------- */
  const listeners = Object.create(null);
  const bus = {
    on(evt, fn) { (listeners[evt] || (listeners[evt] = [])).push(fn); },
    emit(evt, payload) {
      const list = listeners[evt];
      if (!list) return;
      list.slice().forEach((fn) => {
        try { fn(payload); } catch (e) { console.error('[bus:' + evt + ']', e); }
      });
    },
  };

  /* ---------- state ---------- */
  // Segments are immutable (frozen) and always replaced, never edited in place: snapshots for undo are just array references.
  const S = {
    media: new Map(), // id -> media info (+ thumbsReady:Set, waveform, proxyState)
    segments: Object.freeze([]),
    selectedId: null,
    playhead: 0,
    exportSettings: { resolution: 'original', aspect: 'auto', fps: 'auto', quality: 'high' },
    projectPath: '',
    dirty: false,
  };

  const HISTORY_LIMIT = 200;
  const undoStack = [];
  const redoStack = [];
  let last = { key: null, time: 0 };
  let layoutCache = null;

  function layout() {
    if (!layoutCache) layoutCache = M.layout(S.segments);
    return layoutCache;
  }

  function snapshot() {
    return { segments: S.segments, selectedId: S.selectedId };
  }

  function setSegments(segments, selectedId, markDirty) {
    segments.forEach((s) => Object.freeze(s));
    S.segments = Object.freeze(segments.slice());
    S.selectedId = selectedId && S.segments.some((s) => s.id === selectedId) ? selectedId : null;
    layoutCache = null;
    if (markDirty !== false) S.dirty = true;
    const total = layout().total;
    if (S.playhead > total) S.playhead = total;
    bus.emit('segments');
    bus.emit('project');
  }

  // opts.coalesce: edits sharing a key within 1 s (e.g. dragging a slider) become one undo step.
  function commit(segments, opts) {
    const o = opts || {};
    const key = o.coalesce || null;
    const now = Date.now();
    const merge = !!key && last.key === key && now - last.time < 1000 && undoStack.length > 0;
    if (!merge) {
      undoStack.push(snapshot());
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    }
    redoStack.length = 0;
    last = { key, time: now };
    if (o.playhead !== undefined) S.playhead = Math.max(0, Number(o.playhead) || 0);
    setSegments(segments, o.selectedId !== undefined ? o.selectedId : S.selectedId, true);
    bus.emit('history');
  }

  function undo() {
    if (!undoStack.length) return false;
    redoStack.push(snapshot());
    const snap = undoStack.pop();
    last = { key: null, time: 0 };
    setSegments(snap.segments.slice(), snap.selectedId, true);
    bus.emit('history');
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    undoStack.push(snapshot());
    const snap = redoStack.pop();
    last = { key: null, time: 0 };
    setSegments(snap.segments.slice(), snap.selectedId, true);
    bus.emit('history');
    return true;
  }

  const canUndo = () => undoStack.length > 0;
  const canRedo = () => redoStack.length > 0;

  function select(id) {
    const next = id && S.segments.some((s) => s.id === id) ? id : null;
    if (next === S.selectedId) return;
    S.selectedId = next;
    bus.emit('selection');
  }

  // source: 'user' (UI initiated; the player must seek) or 'player' (it comes from the playback clock).
  function setPlayhead(t, source) {
    const total = layout().total;
    const v = Math.min(Math.max(Number.isFinite(t) ? t : 0, 0), total);
    S.playhead = v;
    bus.emit('playhead', { t: v, source: source || 'user' });
  }

  function reset() {
    S.media.clear();
    S.segments = Object.freeze([]);
    S.selectedId = null;
    S.playhead = 0;
    S.projectPath = '';
    S.dirty = false;
    undoStack.length = 0;
    redoStack.length = 0;
    last = { key: null, time: 0 };
    layoutCache = null;
    bus.emit('segments');
    bus.emit('history');
    bus.emit('project');
  }

  // Replaces the whole project (open project): clean state, no history.
  function load(segments, projectPath) {
    undoStack.length = 0;
    redoStack.length = 0;
    last = { key: null, time: 0 };
    S.playhead = 0;
    setSegments(segments, null, false);
    S.dirty = false;
    S.projectPath = projectPath || '';
    bus.emit('history');
    bus.emit('project');
  }

  function markClean(projectPath) {
    S.dirty = false;
    if (projectPath !== undefined) S.projectPath = projectPath;
    bus.emit('project');
  }

  const getSeg = (id) => S.segments.find((s) => s.id === id) || null;
  const mediaOf = (seg) => (seg ? S.media.get(seg.mediaId) || null : null);
  const selectedSeg = () => (S.selectedId ? getSeg(S.selectedId) : null);

  function firstMedia() {
    const s = S.segments[0];
    return s ? S.media.get(s.mediaId) || null : null;
  }

  // Every source file gets its own hue so that clips of the same file are recognisable on the timeline.
  function hueOf(mediaId) {
    let i = 0;
    for (const k of S.media.keys()) {
      if (k === mediaId) break;
      i += 1;
    }
    return (212 + i * 58) % 360;
  }

  VE.state = { S, bus, layout, commit, undo, redo, canUndo, canRedo, select, setPlayhead, reset, load, markClean, getSeg, mediaOf, selectedSeg, firstMedia, hueOf };
})();
