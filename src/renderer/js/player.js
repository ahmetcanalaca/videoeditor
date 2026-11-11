(function () {
  'use strict';
  window.VE = window.VE || {};
  const { $, clamp } = VE.util;
  const M = VE.model;
  const st = VE.state;
  const S = st.S;
  const t = (key, vars) => VE.i18n.t(key, vars);

  /*
   * Preview player.
   * Two <video> "decks" are used so that the next clip is already decoded and positioned while the current one plays
   * (gap-free cuts). Zoom is a CSS transform of the video inside a clipping box that has the letterboxed source geometry,
   * i.e. the same geometry the FFmpeg export uses (see exporter.js), so the preview matches the exported result.
   */

  let canvas = null;
  let stage = null;
  let overlay = null;
  let badge = null;
  let emptyState = null;
  let decks = [];
  let active = 0;
  let playing = false;
  let busy = false;
  let raf = 0;
  let token = 0;
  let curIndex = -1;
  let nextPrepared = null;
  let seekRaf = 0;
  let pendingSeekT = 0;
  let canvasW = 640;
  let canvasH = 360;
  let vol = 1;
  let muted = false;
  let resumeAfterProxy = false;

  const persistAudio = VE.util.debounce(() => { window.api.setSettings({ previewVolume: vol, previewMuted: muted }); }, 400);

  /* ---------- decks ---------- */

  function makeDeck(selector) {
    const root = $(selector);
    const video = $('video', root);
    const box = document.createElement('div');
    box.className = 'vbox';
    root.insertBefore(box, video);
    box.appendChild(video);
    const deck = { root, box, video, mediaId: null, srcKey: '', bw: 0, bh: 0, cancelWait: null, retries: 0, errorAt: -100 };
    video.addEventListener('error', () => onVideoError(deck));
    return deck;
  }

  const canLoad = (media) => !media.needsProxy || media.proxyState === 'ready';
  const srcKeyOf = (media) => (media.proxyState === 'ready' ? 'p' : 'o');
  const urlOf = (media) => 'vemedia://media/' + media.id + '/v?k=' + srcKeyOf(media);

  function clearDeck(deck) {
    try { deck.video.pause(); } catch (e) { /* ignore */ }
    deck.video.removeAttribute('src');
    deck.video.load();
    deck.mediaId = null;
    deck.srcKey = '';
    deck.video.style.transform = '';
  }

  function fitBox(deck) {
    const m = S.media.get(deck.mediaId);
    if (!m) return;
    const r = M.fitRect(m.displayWidth, m.displayHeight, canvasW, canvasH, false);
    deck.bw = r.w;
    deck.bh = r.h;
    const s = deck.box.style;
    s.left = r.x.toFixed(2) + 'px';
    s.top = r.y.toFixed(2) + 'px';
    s.width = r.w.toFixed(2) + 'px';
    s.height = r.h.toFixed(2) + 'px';
  }

  function setTransform(deck, z, fx, fy) {
    if (z <= 1.00001) {
      deck.video.style.transform = '';
      return;
    }
    const w = M.cropWindow(z, fx, fy);
    const tx = -w.x * deck.bw * z;
    const ty = -w.y * deck.bh * z;
    deck.video.style.transform = 'translate(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px) scale(' + z.toFixed(5) + ')';
  }

  // Points a deck at a segment position. Returns false when the media cannot be shown (yet).
  function configure(deck, item, srcTime, frac) {
    const seg = item.seg;
    const media = S.media.get(seg.mediaId);
    if (!media || !canLoad(media)) return false;
    const key = srcKeyOf(media);
    if (deck.mediaId !== media.id || deck.srcKey !== key) {
      deck.mediaId = media.id;
      deck.srcKey = key;
      deck.video.src = urlOf(media);
    }
    fitBox(deck);
    deck.video.defaultPlaybackRate = seg.speed;
    deck.video.playbackRate = seg.speed;
    if (Math.abs(deck.video.currentTime - srcTime) > 0.0005 || deck.video.readyState === 0) {
      try { deck.video.currentTime = srcTime; } catch (e) { /* metadata not loaded yet: applied after load */ }
    }
    setTransform(deck, M.zoomAt(seg, frac), seg.fx, seg.fy);
    return true;
  }

  // Resolves when the deck shows the frame it was asked for (or failed / timed out).
  function whenReady(deck, timeoutMs) {
    if (deck.cancelWait) deck.cancelWait();
    const v = deck.video;
    return new Promise((resolve) => {
      let finished = false;
      const events = ['loadeddata', 'seeked', 'canplay', 'error'];
      const done = () => {
        if (finished) return;
        finished = true;
        events.forEach((e) => v.removeEventListener(e, check));
        clearTimeout(timer);
        if (deck.cancelWait === done) deck.cancelWait = null;
        resolve();
      };
      const check = () => { if (v.error || (v.readyState >= 2 && !v.seeking)) done(); };
      events.forEach((e) => v.addEventListener(e, check));
      const timer = setTimeout(done, timeoutMs || 3500);
      deck.cancelWait = done;
      check();
    });
  }

  function applyFrame(deck, item, frac) {
    const seg = item.seg;
    const media = S.media.get(seg.mediaId);
    setTransform(deck, M.zoomAt(seg, frac), seg.fx, seg.fy);
    const f = M.fadeFactor(seg, frac * item.dur, item.dur);
    overlay.style.opacity = String(Math.round((1 - f) * 1000) / 1000);
    const v = deck.video;
    v.volume = clamp(seg.volume, 0, 1) * vol * f;
    v.muted = !!(seg.mute || muted || !media || !media.hasAudio);
  }

  function reapply() {
    const lay = st.layout();
    const loc = M.locate(lay, S.playhead);
    if (loc && decks[active] && decks[active].mediaId) applyFrame(decks[active], loc.item, loc.frac);
  }

  /* ---------- positioning ---------- */

  const continuous = (a, b) => a.mediaId === b.mediaId && Math.abs(a.out - b.in) < 0.0005;

  function setPlaying(v) {
    if (playing === v) return;
    playing = v;
    const btn = $('#btn-play');
    VE.icons.set(btn, v ? 'pause' : 'play');
    const label = t(v ? 'tp.pause' : 'tp.play');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    st.bus.emit('player', { playing: v });
  }

  function showDeck(index) {
    decks.forEach((d, i) => d.root.classList.toggle('active', i === index));
  }

  // Makes the active deck show timeline time `time`; resumes playback afterwards when asked to.
  async function goto(time, resume) {
    const my = ++token;
    nextPrepared = null;
    const lay = st.layout();
    const loc = M.locate(lay, time);
    const deck = decks[active];
    const other = decks[1 - active];
    other.video.pause();
    if (!loc) {
      busy = false;
      curIndex = -1;
      if (playing) setPlaying(false);
      clearDeck(deck);
      clearDeck(other);
      overlay.style.opacity = '0';
      return;
    }
    busy = true;
    deck.video.pause();
    curIndex = loc.index;
    const seg = loc.item.seg;
    const media = S.media.get(seg.mediaId);
    const lastFrame = Math.max(seg.in, seg.out - 0.5 / ((media && media.fps) || 30));
    const srcTime = Math.min(loc.srcTime, lastFrame);
    showDeck(active);
    if (!configure(deck, loc.item, srcTime, loc.frac)) {
      clearDeck(deck);
      busy = false;
      overlay.style.opacity = '0';
      if (playing) setPlaying(false);
      updateBadge();
      return;
    }
    await whenReady(deck);
    if (my !== token) return;
    busy = false;
    applyFrame(deck, loc.item, loc.frac);
    if (resume && playing) startPlaying();
  }

  function startPlaying() {
    const deck = decks[active];
    const p = deck.video.play();
    if (p && p.catch) p.catch(() => {});
    prepareNext();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function prepareNext() {
    nextPrepared = null;
    const lay = st.layout();
    const cur = lay.items[curIndex];
    const next = lay.items[curIndex + 1];
    if (!cur || !next || continuous(cur.seg, next.seg)) return;
    const idle = decks[1 - active];
    idle.video.pause();
    if (!configure(idle, next, next.seg.in, 0)) return;
    nextPrepared = { segId: next.seg.id, deck: idle };
  }

  function finishAtEnd() {
    const lay = st.layout();
    decks.forEach((d) => d.video.pause());
    cancelAnimationFrame(raf);
    nextPrepared = null;
    setPlaying(false);
    st.setPlayhead(lay.total, 'player');
  }

  function advance() {
    const lay = st.layout();
    const cur = lay.items[curIndex];
    const next = lay.items[curIndex + 1];
    const deck = decks[active];
    if (!next) { finishAtEnd(); return; }
    if (cur && continuous(cur.seg, next.seg) && deck.mediaId === next.seg.mediaId) {
      curIndex += 1;
      deck.video.defaultPlaybackRate = next.seg.speed;
      deck.video.playbackRate = next.seg.speed;
      prepareNext();
      return;
    }
    if (nextPrepared && nextPrepared.segId === next.seg.id) {
      const nd = nextPrepared.deck;
      const p = nd.video.play();
      if (p && p.catch) p.catch(() => {});
      active = decks.indexOf(nd);
      showDeck(active);
      deck.video.pause();
      curIndex += 1;
      nextPrepared = null;
      prepareNext();
      return;
    }
    goto(next.start, true);
  }

  function step() {
    if (!playing || busy) return;
    const lay = st.layout();
    const item = lay.items[curIndex];
    const deck = decks[active];
    if (!item) { finishAtEnd(); return; }
    const v = deck.video;
    // A pending media error is handled by onVideoError (retry / proxy); stepping on a broken element would be pointless.
    if (v.error) return;
    const seg = item.seg;
    const srcT = v.currentTime;
    if (srcT >= seg.out - 0.012 || (v.ended && srcT > seg.in)) {
      advance();
    } else {
      const local = clamp((srcT - seg.in) / seg.speed, 0, item.dur);
      st.setPlayhead(item.start + local, 'player');
      applyFrame(deck, item, item.dur > 0 ? local / item.dur : 0);
    }
  }

  function tick() {
    if (!playing) return;
    step();
    if (playing) raf = requestAnimationFrame(tick);
  }

  /* ---------- public controls ---------- */

  function play() {
    const lay = st.layout();
    if (!lay.items.length || playing) return;
    if (S.playhead >= lay.total - 0.03) st.setPlayhead(0, 'player');
    setPlaying(true);
    goto(S.playhead, true);
  }

  function pause() {
    resumeAfterProxy = false;
    if (!playing) return;
    setPlaying(false);
    cancelAnimationFrame(raf);
    decks.forEach((d) => d.video.pause());
    nextPrepared = null;
  }

  function toggle() { if (playing) pause(); else play(); }

  // Seek requests from the UI are coalesced to one per animation frame (smooth scrubbing).
  function requestSeek(time) {
    pendingSeekT = time;
    if (seekRaf) return;
    seekRaf = requestAnimationFrame(() => {
      seekRaf = 0;
      goto(pendingSeekT, playing);
    });
  }

  // Called after the segment list changed: reposition on the (edited) timeline.
  function sync() {
    relayout();
    const lay = st.layout();
    emptyState.hidden = lay.items.length > 0;
    if (!lay.items.length) {
      pause();
      goto(0, false);
      return;
    }
    goto(clamp(S.playhead, 0, lay.total), playing);
  }

  function relayout() {
    const c = M.canvasSize(S.exportSettings, st.firstMedia());
    const aw = Math.max(120, stage.clientWidth - 24);
    const ah = Math.max(80, stage.clientHeight - 24);
    const aspect = c.width / c.height;
    let w = aw;
    let h = w / aspect;
    if (h > ah) { h = ah; w = h * aspect; }
    canvasW = Math.max(40, Math.floor(w));
    canvasH = Math.max(30, Math.floor(h));
    canvas.style.width = canvasW + 'px';
    canvas.style.height = canvasH + 'px';
    decks.forEach((d) => { if (d.mediaId) fitBox(d); });
    reapply();
  }

  function reloadMedia(id) {
    let hit = false;
    decks.forEach((d) => { if (d.mediaId === id) { d.srcKey = ''; hit = true; } });
    if (hit || S.segments.some((s) => s.mediaId === id)) goto(S.playhead, playing);
  }

  /* ---------- proxy / errors ---------- */

  function onVideoError(deck) {
    const m = S.media.get(deck.mediaId);
    const err = deck.video.error;
    if (!m || !err) return;
    // MEDIA_ERR_NETWORK (2) / MEDIA_ERR_DECODE (3) on a normal file are usually transient decoder hiccups:
    // reload the source (up to twice per spot) and carry on from the same position before escalating to a proxy.
    // The budget is per location: errors repeating at the same place (damaged data) exhaust it, a new place gets a fresh one.
    const here = deck.video.currentTime;
    if (Math.abs(here - deck.errorAt) > 1) deck.retries = 0;
    deck.errorAt = here;
    if ((err.code === 2 || err.code === 3) && !m.needsProxy && deck.retries < 2) {
      deck.retries += 1;
      deck.srcKey = '';
      if (deck === decks[active]) {
        goto(S.playhead, playing);
      } else {
        nextPrepared = null;
        if (playing) prepareNext();
      }
      return;
    }
    // Give up on the original file: stop, let FFmpeg build a tolerant 480p proxy, and continue when it is ready.
    const wasPlaying = playing;
    pause();
    resumeAfterProxy = wasPlaying;
    if (!m.proxyState || m.proxyState === 'none') {
      m.proxyState = 'building';
      m.proxyProgress = 0;
      window.api.requestProxy(m.id);
    }
    updateBadge();
  }

  function onProxyEvent(ev) {
    const m = S.media.get(ev.id);
    if (!m) return;
    m.proxyState = ev.state;
    m.proxyProgress = ev.progress || 0;
    if (ev.state === 'ready') {
      reloadMedia(ev.id);
      if (resumeAfterProxy) { resumeAfterProxy = false; play(); }
    } else if (ev.state === 'error') {
      resumeAfterProxy = false;
    }
    updateBadge();
  }

  function updateBadge() {
    let building = null;
    let failed = null;
    const used = new Set(S.segments.map((s) => s.mediaId));
    for (const m of S.media.values()) {
      if (!used.has(m.id)) continue;
      if (m.proxyState === 'building') building = building || m;
      else if (m.proxyState === 'error') failed = failed || m;
    }
    if (building) {
      badge.hidden = false;
      badge.textContent = t('proxy.building', { p: Math.round((building.proxyProgress || 0) * 100) });
    } else if (failed) {
      badge.hidden = false;
      badge.textContent = t('proxy.error');
    } else {
      badge.hidden = true;
    }
  }

  /* ---------- transport audio controls ---------- */

  function updateAudioUI() {
    const range = $('#vol-range');
    range.value = String(Math.round(vol * 100));
    VE.util.fillRange(range);
    const btn = $('#btn-mute');
    const off = muted || vol === 0;
    VE.icons.set(btn, off ? 'volumeOff' : 'volume');
    const label = t(off ? 'tp.unmute' : 'tp.mute');
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  function refreshTexts() {
    const btn = $('#btn-play');
    const label = t(playing ? 'tp.pause' : 'tp.play');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    updateAudioUI();
    updateBadge();
  }

  function init(settings) {
    canvas = $('#canvas');
    stage = $('#stage');
    overlay = $('#fade-overlay');
    badge = $('#proxy-badge');
    emptyState = $('#empty-state');
    decks = [makeDeck('#deck-a'), makeDeck('#deck-b')];
    vol = typeof settings.previewVolume === 'number' ? clamp(settings.previewVolume, 0, 1) : 1;
    muted = !!settings.previewMuted;

    $('#btn-play').addEventListener('click', toggle);
    $('#btn-mute').addEventListener('click', () => {
      muted = !muted;
      persistAudio();
      updateAudioUI();
      reapply();
    });
    const range = $('#vol-range');
    range.addEventListener('input', () => {
      vol = Number(range.value) / 100;
      if (vol > 0) muted = false;
      persistAudio();
      updateAudioUI();
      reapply();
    });

    st.bus.on('playhead', (p) => { if (p.source === 'user') requestSeek(p.t); });
    // Safety net: animation frames stop when the window is hidden (e.g. minimised); keep clips advancing with a timer.
    setInterval(() => { if (playing && document.hidden) step(); }, 100);
    new ResizeObserver(() => relayout()).observe(stage);
    VE.i18n.onChange(refreshTexts);
    updateAudioUI();
    showDeck(0);
    relayout();
  }

  VE.player = {
    init, sync, relayout, play, pause, toggle, onProxyEvent, reloadMedia, updateBadge, reapply,
    isPlaying: () => playing,
    // Read-only snapshot used by the automated UI tests.
    debug: () => ({
      playing, busy, active, curIndex, canvasW, canvasH, hidden: document.hidden,
      decks: decks.map((d) => ({
        mediaId: d.mediaId, readyState: d.video.readyState, seeking: d.video.seeking, paused: d.video.paused,
        currentTime: d.video.currentTime, playbackRate: d.video.playbackRate, w: d.video.videoWidth, h: d.video.videoHeight,
        transform: d.video.style.transform, active: d.root.classList.contains('active'), muted: d.video.muted, volume: d.video.volume,
        error: d.video.error ? d.video.error.code + ':' + d.video.error.message : null,
      })),
    }),
  };
})();
