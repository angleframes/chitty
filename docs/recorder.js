'use strict';
// ANGLE FRAMES CHITTY — live draw recorder.
// Studio mode records an app-rendered draw board (canvas.captureStream); Screen mode uses
// getDisplayMedia with the browser's permission prompt. Chunks are kept in IndexedDB until the
// server confirms them, so a crash or refresh never loses uploaded or pending video.
(() => {
  const A = window.AFC;
  if (!A) return;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const canRecord = typeof window.MediaRecorder !== 'undefined';
  const canScreen = !!navigator.mediaDevices?.getDisplayMedia;
  const canStudio = canRecord && !!HTMLCanvasElement.prototype.captureStream;

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------
  const PREF_KEY = 'afc_rec_prefs';
  const prefs = { mode: 'studio', mic: false, systemAudio: true, autoRecord: false, autoStop: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch {}
  if (prefs.mode === 'screen' && !canScreen) prefs.mode = 'studio';
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} };

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  const fmtClock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')) + `:${String(sec).padStart(2, '0')}`;
  };
  const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

  // ---------------------------------------------------------------------------
  // IndexedDB chunk store (crash-safe buffer)
  // ---------------------------------------------------------------------------
  const idb = (() => {
    let dbp = null;
    const open = () => {
      if (!dbp) {
        dbp = new Promise((res, rej) => {
          if (!window.indexedDB) return rej(new Error('IndexedDB unavailable'));
          const r = indexedDB.open('afc-recorder', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('chunks', { keyPath: ['recId', 'seq'] });
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      }
      return dbp;
    };
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('chunks', mode);
        const req = fn(t.objectStore('chunks'));
        t.oncomplete = () => res(req?.result);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    };
    const safe = (p) => p.catch(() => undefined);
    return {
      put: (c) => safe(run('readwrite', (s) => s.put(c))),
      del: (recId, seq) => safe(run('readwrite', (s) => s.delete([recId, seq]))),
      all: () => run('readonly', (s) => s.getAll()).catch(() => []),
    };
  })();

  // ---------------------------------------------------------------------------
  // Upload queue (sequential, retried until the server confirms)
  // ---------------------------------------------------------------------------
  const queue = [];
  const dropped = new Set(); // recordings the server will no longer accept chunks for
  let pumping = false;
  let uploadError = null;

  async function uploadChunk(c) {
    const headers = { 'Content-Type': 'application/octet-stream' };
    const t = A.token();
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(`/api/recordings/${c.recId}/chunk?seq=${c.seq}`, { method: 'PUT', headers, body: c.blob });
    if (res.ok) return;
    const j = await res.json().catch(() => ({}));
    if (res.status === 409 && typeof j.expected === 'number' && j.expected > c.seq) return; // already stored
    if (res.status === 404 || (res.status === 409 && !('expected' in j)) || (res.status === 409 && j.expected < c.seq)) {
      const e = new Error(j.error || 'Recording no longer accepts uploads'); e.fatal = true; throw e;
    }
    if (res.status === 401) throw new Error('Admin session expired. Sign in again to continue uploading.');
    throw new Error(j.error || `Upload failed (${res.status})`);
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    let attempt = 0;
    while (queue.length) {
      const c = queue[0];
      if (dropped.has(c.recId)) { queue.shift(); idb.del(c.recId, c.seq); continue; }
      try {
        await uploadChunk(c);
        queue.shift();
        idb.del(c.recId, c.seq);
        rec.uploaded += c.blob.size;
        attempt = 0;
        uploadError = null;
      } catch (err) {
        if (err.fatal) {
          dropped.add(c.recId);
          A.toast(`Recording upload stopped: ${err.message}`, 'error');
          continue;
        }
        attempt++;
        uploadError = navigator.onLine === false ? 'You are offline. Video is kept on this device and will upload when the connection returns.' : err.message;
        render();
        await sleep(Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)));
      }
    }
    pumping = false;
    render();
  }
  window.addEventListener('online', pump);
  const pendingFor = (id) => queue.some((c) => c.recId === id);
  async function drained(id) { while (pendingFor(id)) await sleep(300); }

  // ---------------------------------------------------------------------------
  // Recorder state
  // ---------------------------------------------------------------------------
  const rec = {
    state: 'idle', // idle | starting | recording | stopping
    id: null, mr: null, streams: [], compositor: null, audioCleanup: null,
    startPerf: 0, seq: 0, bytes: 0, uploaded: 0, mode: 'studio',
    spins: new Set(), categoryNames: new Set(), autoStopTimer: 0,
  };

  function pickMime() {
    const types = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1,opus',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    return types.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
  }

  function friendlyError(e) {
    const n = e?.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Permission was denied. Allow screen or microphone access in the browser to record.';
    if (n === 'NotFoundError') return 'No capture device was found.';
    if (n === 'NotReadableError') return 'The screen or microphone is being used by another app.';
    if (n === 'AbortError') return 'Screen selection was cancelled.';
    if (n === 'NotSupportedError' || n === 'TypeError') return 'This browser does not support this kind of recording. Try Studio mode.';
    return e?.message || 'Recording could not start.';
  }

  async function createServerRecording(mime, mode) {
    const body = { categoryId: A.data()?.category?.id, mode, mime };
    try {
      return await A.api('POST', '/api/recordings', body);
    } catch (e) {
      if (!/already in progress/i.test(e.message)) throw e;
      const ok = await A.confirmBox('Another recording is in progress',
        'A recording is already running on another screen, or one was interrupted. Close it (its uploaded video is kept) and start a new recording?',
        'Start new recording', false);
      if (!ok) { const err = new Error('Recording cancelled.'); err.silent = true; throw err; }
      return A.api('POST', '/api/recordings', { ...body, force: true });
    }
  }

  function releaseStreams() {
    rec.compositor?.stop();
    rec.compositor = null;
    for (const s of rec.streams) s.getTracks().forEach((t) => t.stop());
    rec.streams = [];
    try { rec.audioCleanup?.(); } catch {}
    rec.audioCleanup = null;
  }

  async function start(opts = prefs) {
    if (rec.state !== 'idle') return rec.state === 'recording';
    if (!canRecord) { A.toast('This browser cannot record video. Use a recent Chrome, Edge, Firefox or Safari.', 'error'); return false; }
    const mode = opts.mode === 'screen' && canScreen ? 'screen' : 'studio';
    rec.state = 'starting';
    render();
    try {
      let videoTrack;
      let systemStream = null;
      if (mode === 'screen') {
        // Must be the first await so it runs inside the user's click (browser requirement).
        const ds = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: !!opts.systemAudio,
          preferCurrentTab: true,
          selfBrowserSurface: 'include',
          surfaceSwitching: 'include',
          systemAudio: opts.systemAudio ? 'include' : 'exclude',
        });
        rec.streams.push(ds);
        videoTrack = ds.getVideoTracks()[0];
        if (ds.getAudioTracks().length) systemStream = ds;
        else if (opts.systemAudio) A.toast('No tab or system audio was shared — recording without it.');
      } else {
        if (!canStudio) throw new Error('This browser cannot record the draw board. Try Screen mode on a desktop browser.');
        rec.compositor = createCompositor();
        videoTrack = rec.compositor.stream.getVideoTracks()[0];
      }

      let mic = null;
      if (opts.mic) {
        try {
          mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
          rec.streams.push(mic);
        } catch (e) {
          A.toast(`Microphone not available (${friendlyError(e)}) — recording without it.`, 'error');
        }
      }

      // Mix audio: app sounds (studio) or shared tab/system audio (screen) + optional mic.
      let audioTrack = null;
      const au = A.audio();
      if (au) {
        const dest = au.ctx.createMediaStreamDestination();
        const nodes = [];
        if (mode === 'studio') au.master.connect(dest);
        if (systemStream) { const n = au.ctx.createMediaStreamSource(systemStream); n.connect(dest); nodes.push(n); }
        if (mic) { const n = au.ctx.createMediaStreamSource(mic); n.connect(dest); nodes.push(n); }
        audioTrack = dest.stream.getAudioTracks()[0] || null;
        rec.audioCleanup = () => {
          if (mode === 'studio') try { au.master.disconnect(dest); } catch {}
          nodes.forEach((n) => { try { n.disconnect(); } catch {} });
        };
      }

      const mime = pickMime();
      if (!mime) throw new Error('No supported video format for recording in this browser.');
      const out = new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);
      const created = await createServerRecording(mime, mode);

      const mr = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: mode === 'screen' ? 6e6 : 4e6, audioBitsPerSecond: 128000 });
      Object.assign(rec, {
        id: created.id, mr, mode, seq: 0, bytes: 0, uploaded: 0, startPerf: performance.now(),
        spins: new Set(), categoryNames: new Set(),
      });
      const catName = A.data()?.category?.name;
      if (catName) rec.categoryNames.add(catName);
      const recId = created.id;
      mr.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        const c = { recId, seq: rec.seq++, blob: e.data };
        rec.bytes += e.data.size;
        queue.push(c);
        idb.put(c);
        pump();
      };
      mr.onerror = (e) => {
        A.toast(`Recording error: ${e.error?.message || 'unknown'}. Saving what was recorded.`, 'error');
        stop();
      };
      videoTrack.addEventListener('ended', () => {
        if (rec.state === 'recording') { A.toast('Screen sharing ended — saving the recording.'); stop(); }
      });
      mr.start(3000);
      rec.state = 'recording';
      render();
      A.toast(mode === 'screen' ? 'Recording started' : 'Recording started — keep this tab open and visible', 'ok');
      return true;
    } catch (e) {
      releaseStreams();
      rec.state = 'idle';
      rec.id = null;
      render();
      if (!e.silent) A.toast(`Recording did not start: ${friendlyError(e)}`, 'error');
      return false;
    }
  }

  async function stop() {
    if (rec.state !== 'recording') return;
    rec.state = 'stopping';
    clearTimeout(rec.autoStopTimer);
    rec.autoStopTimer = 0;
    render();
    const durationMs = Math.round(performance.now() - rec.startPerf);
    const { mr, id } = rec;
    await new Promise((resolve) => {
      if (!mr || mr.state === 'inactive') return resolve();
      mr.addEventListener('stop', resolve, { once: true });
      try { mr.stop(); } catch { resolve(); }
    });
    releaseStreams();
    A.toast('Saving recording…');
    await drained(id);
    try {
      if (!dropped.has(id)) {
        await A.api('POST', `/api/recordings/${id}/finish`, {
          durationMs, spins: rec.spins.size, categoryNames: [...rec.categoryNames],
        });
        A.toast('Recording saved', 'ok');
      }
    } catch (e) {
      A.toast(`Recording uploaded but could not be finalised: ${e.message}. It will be finalised automatically.`, 'error');
    }
    rec.state = 'idle';
    rec.id = null;
    rec.mr = null;
    render();
    loadList();
  }

  // Pending chunks from a previous page (crash, refresh, closed tab): upload and finalise.
  let recovered = false;
  async function recoverPending() {
    if (recovered || !A.isAdmin()) return;
    recovered = true;
    const chunks = (await idb.all()).filter((c) => c.recId !== rec.id);
    if (!chunks.length) return;
    chunks.sort((a, b) => a.recId - b.recId || a.seq - b.seq);
    const ids = [...new Set(chunks.map((c) => c.recId))];
    const bytes = chunks.reduce((n, c) => n + c.blob.size, 0);
    A.toast(`Recovering ${fmtBytes(bytes)} of an unsaved recording…`);
    queue.unshift(...chunks);
    pump();
    for (const id of ids) {
      await drained(id);
      if (dropped.has(id)) continue;
      try { await A.api('POST', `/api/recordings/${id}/finish`, { recovered: true }); } catch {}
    }
    A.toast('Recovered recording saved', 'ok');
    loadList();
  }

  window.addEventListener('beforeunload', (e) => {
    if (rec.state === 'recording' || rec.state === 'stopping') { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------------------------------------------------------------------
  // Studio compositor — draws the live draw board into a 1280×720 canvas.
  // Reads the page's own rendered state; never changes it.
  // ---------------------------------------------------------------------------
  function createCompositor() {
    const W = 1280, H = 720;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H; cv.className = 'rec-canvas';
    document.body.append(cv);
    const g = cv.getContext('2d');
    const logo = $('.brand-logo');
    const mark = $('.hub img');
    const wheel = $('#wheel');
    const confetti = $('#confetti');
    const pin = new Path2D('M20 50 L3 14 A17 17 0 1 1 37 14 Z');
    const font = (w, s) => `${w} ${s}px Poppins, system-ui, sans-serif`;
    const ls = (v) => { if ('letterSpacing' in g) g.letterSpacing = `${v}px`; };
    const fit = (t, max) => {
      if (!max || g.measureText(t).width <= max) return t;
      while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
      return t + '…';
    };
    const txt = (t, x, y, o = {}) => {
      g.font = font(o.weight || 400, o.size || 14);
      ls(o.ls || 0);
      g.fillStyle = o.color || '#fff';
      g.textAlign = o.align || 'left';
      g.textBaseline = 'alphabetic';
      g.fillText(fit(String(t ?? ''), o.max), x, y);
      ls(0);
    };
    const rr = (x, y, w, h, r) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); };
    const circle = (x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); };
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const ready = (img) => img && img.complete && img.naturalWidth > 0;

    function winnersPanel(x, y, w, h, title, list, rankOf) {
      rr(x, y, w, h, 14); g.fillStyle = '#111'; g.fill();
      g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1; g.stroke();
      txt(title, x + 18, y + 30, { size: 10.5, weight: 600, color: '#a2a2a2', ls: 2 });
      txt(String(list.length), x + w - 18, y + 30, { size: 12, weight: 600, align: 'right' });
      if (!list.length) { txt('No winners yet', x + 18, y + 68, { size: 12.5, color: '#6b6b6b' }); return; }
      list.slice(0, 6).forEach((wn, i) => {
        const ry = y + 48 + i * 40;
        if (i) { g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(x + 18, ry - 4, w - 36, 1); }
        circle(x + 32, ry + 15, 13); g.fillStyle = i === 0 ? '#b3141b' : '#181818'; g.fill();
        txt(rankOf(wn, i), x + 32, ry + 19, { size: 10, weight: 600, align: 'center', color: i === 0 ? '#fff' : '#a2a2a2' });
        txt(wn.name, x + 54, ry + 13, { size: 13, weight: 500, max: w - 150 });
        txt(wn.categoryName, x + 54, ry + 29, { size: 10.5, color: '#6b6b6b', max: w - 150 });
        txt(A.fmtTime.format(new Date(wn.drawnAt)), x + w - 18, ry + 20, { size: 11.5, color: '#fff', align: 'right' });
      });
    }

    function draw() {
      const d = A.data();
      const cat = d?.category;
      g.fillStyle = '#0a0a0a';
      g.fillRect(0, 0, W, H);

      // Header
      let hx = 40;
      if (ready(logo)) { const lh = 44, lw = (lh * logo.naturalWidth) / logo.naturalHeight; g.drawImage(logo, 40, 20, lw, lh); hx = 40 + lw + 16; }
      g.fillStyle = 'rgba(255,255,255,.13)'; g.fillRect(hx, 28, 1, 28);
      txt('CHITTY', hx + 16, 43, { size: 14, weight: 700, ls: 4 });
      txt('Live draw', hx + 16, 61, { size: 12, color: '#a2a2a2' });
      txt($('#clock')?.textContent, W / 2, 46, { size: 28, weight: 600, align: 'center' });
      txt(`${$('#today')?.textContent || ''} · IST`, W / 2, 66, { size: 12, color: '#a2a2a2', align: 'center' });
      const blink = Math.floor(performance.now() / 600) % 2 === 0;
      g.font = font(700, 12); ls(3);
      const liveW = g.measureText('LIVE DRAW').width;
      ls(0);
      circle(W - 40 - liveW - 14, 43, 5); g.fillStyle = blink ? '#d01b23' : 'rgba(208,27,35,.35)'; g.fill();
      txt('LIVE DRAW', W - 40, 47, { size: 12, weight: 700, ls: 3, align: 'right' });
      g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(0, 84, W, 1);

      // Wheel (the page's own animated canvas)
      const S = 560, wx = 40, wy = 124;
      if (wheel.width) g.drawImage(wheel, wx, wy, S, S);
      const empty = $('#wheelEmpty');
      if (empty && !empty.hidden) txt(empty.textContent, wx + S / 2, wy + S / 2 + S * 0.2, { size: 14, color: '#a2a2a2', align: 'center' });
      const pw = S * 0.07;
      g.save();
      g.translate(wx + S / 2 - pw / 2, wy - S * 0.03);
      g.scale(pw / 40, pw / 40);
      g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 8; g.shadowOffsetY = 4;
      g.fillStyle = '#b3141b'; g.fill(pin);
      g.shadowColor = 'transparent';
      circle(20, 17, 6); g.fillStyle = '#fff'; g.fill();
      g.restore();
      const cx = wx + S / 2, cy = wy + S / 2, hr = S * 0.11;
      circle(cx, cy, hr + 6); g.fillStyle = 'rgba(10,10,10,.9)'; g.fill();
      circle(cx, cy, hr); g.fillStyle = '#0a0a0a'; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
      if (ready(mark)) { const mw = hr * 2 * 0.66, mh = (mw * mark.naturalHeight) / mark.naturalWidth; g.drawImage(mark, cx - mw / 2, cy - mh / 2, mw, mh); }

      // Right column
      const x0 = 660, w = 580;
      txt('CHITTY CATEGORY', x0, 128, { size: 11, color: '#a2a2a2', ls: 2 });
      txt(clean($('#catPickerValue')?.textContent), x0, 164, { size: 30, weight: 700, max: 400 });
      const pill = $('#statusPill');
      const st = pill?.dataset.status || 'ready';
      const label = clean(pill?.textContent).toUpperCase();
      g.font = font(600, 11); ls(2);
      const tw = g.measureText(label).width + 40;
      ls(0);
      rr(x0 + w - tw, 122, tw, 30, 15);
      if (st === 'spinning') { g.fillStyle = '#b3141b'; g.fill(); } else { g.strokeStyle = 'rgba(255,255,255,.2)'; g.lineWidth = 1; g.stroke(); }
      const sc = st === 'ready' ? '#4ade80' : '#fff';
      circle(x0 + w - tw + 16, 137, 3.5); g.fillStyle = sc; g.fill();
      txt(label, x0 + w - tw + 26, 141, { size: 11, weight: 600, ls: 2, color: sc });
      txt(clean($('#cycleBadge')?.textContent), x0 + w, 172, { size: 12, color: '#a2a2a2', align: 'right' });

      g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(x0, 190, w, 1); g.fillRect(x0, 256, w, 1);
      [['AMOUNT', '#statAmount'], ['PARTICIPANTS', '#statTotal'], ['REMAINING', '#statRemaining'], ['WINNERS', '#statWinners']].forEach(([l, sel], i) => {
        const sx = x0 + i * (w / 4);
        if (i) { g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(sx, 190, 1, 66); }
        const px = i ? sx + 16 : sx;
        txt(l, px, 214, { size: 10.5, color: '#a2a2a2', ls: 1.5 });
        txt($(sel)?.textContent, px, 244, { size: 24, weight: 600, color: i === 2 ? '#ff4a52' : '#fff', max: w / 4 - 24 });
      });

      // Current winner
      const cy0 = 272, ch = 118;
      rr(x0, cy0, w, ch, 14); g.fillStyle = '#111'; g.fill(); g.strokeStyle = 'rgba(255,255,255,.07)'; g.stroke();
      g.fillStyle = '#b3141b'; g.fillRect(x0, cy0 + 18, 3, ch - 36);
      txt('CURRENT WINNER', x0 + 20, cy0 + 30, { size: 10.5, weight: 600, color: '#a2a2a2', ls: 2 });
      const nameEl = $('#currentBody .current-name');
      if (nameEl) {
        txt(nameEl.textContent, x0 + 20, cy0 + 74, { size: 34, weight: 700, max: w - 40 });
        txt(clean($('#currentBody .current-meta')?.textContent), x0 + 20, cy0 + 100, { size: 12.5, color: '#a2a2a2', max: w - 40 });
      } else {
        txt(clean($('#currentBody')?.textContent), x0 + 20, cy0 + 72, { size: 15, color: '#a2a2a2', max: w - 40 });
      }

      // Winner lists
      const ly = 408, lh = H - ly - 24, lw = (w - 16) / 2;
      winnersPanel(x0, ly, lw, lh, 'PREVIOUS WINNERS', cat?.cycleWinners || [], (wn) => `#${wn.drawNumber}`);
      const today = d?.todayWinners || [];
      winnersPanel(x0 + lw + 16, ly, lw, lh, "TODAY'S WINNERS", today, (wn, i) => String(today.length - i));

      // Celebration
      const cel = $('#celebrate');
      if (cel && !cel.hidden) {
        g.fillStyle = 'rgba(0,0,0,.82)'; g.fillRect(0, 0, W, H);
        if (confetti?.width) g.drawImage(confetti, 0, 0, W, H);
        const cw = 680, chh = 300, cx1 = (W - cw) / 2, cy1 = (H - chh) / 2;
        rr(cx1, cy1, cw, chh, 22); g.fillStyle = '#111'; g.fill(); g.strokeStyle = 'rgba(255,255,255,.13)'; g.lineWidth = 1; g.stroke();
        const eb = `WINNER · ${clean($('#celebrateDraw')?.textContent).toUpperCase()}`;
        g.font = font(600, 11); ls(3);
        const ebw = g.measureText(eb).width + 32;
        ls(0);
        g.fillStyle = '#b3141b'; g.fillRect(W / 2 - ebw / 2, cy1 + 56, 22, 4);
        txt(eb, W / 2 - ebw / 2 + 32, cy1 + 62, { size: 11, weight: 600, ls: 3, color: '#a2a2a2' });
        txt($('#celebrateName')?.textContent, W / 2, cy1 + 150, { size: 60, weight: 800, align: 'center', max: cw - 60 });
        txt($('#celebrateUid')?.textContent, W / 2, cy1 + 186, { size: 13, color: '#6b6b6b', align: 'center', ls: 1 });
        txt(clean($('#celebrateCat')?.textContent), W / 2, cy1 + 230, { size: 17, color: '#a2a2a2', align: 'center', max: cw - 60 });
      }
    }

    let raf = 0, to = 0, alive = true;
    const stream = cv.captureStream(30);
    const loop = () => {
      if (!alive) return;
      try { draw(); } catch (e) { console.error(e); }
      // rAF pauses in background tabs; fall back to timers so the video keeps moving.
      if (document.hidden) to = setTimeout(loop, 100); else raf = requestAnimationFrame(loop);
    };
    loop();
    return {
      stream,
      stop() {
        alive = false;
        cancelAnimationFrame(raf);
        clearTimeout(to);
        stream.getTracks().forEach((t) => t.stop());
        cv.remove();
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Recording controls UI
  // ---------------------------------------------------------------------------
  function render() {
    const admin = A.isAdmin();
    const btn = $('#recBtn');
    const label = $('#recBtnLabel');
    btn.hidden = !admin;
    btn.classList.toggle('on', rec.state === 'recording');
    btn.classList.toggle('busy', rec.state === 'starting' || rec.state === 'stopping');
    const elapsed = rec.state === 'recording' ? fmtClock(performance.now() - rec.startPerf) : '';
    label.textContent = { idle: 'Record', starting: 'Starting…', recording: `Stop · ${elapsed}`, stopping: 'Saving…' }[rec.state];

    // REC badge for every screen while any recording is live (from server state).
    const live = A.data()?.recording;
    const badge = $('#recBadge');
    const showBadge = !!live && !(admin && rec.state !== 'idle');
    badge.hidden = !showBadge;
    if (showBadge) $('#recBadgeTime').textContent = fmtClock(A.serverNow() - live.startedAt);

    // Admin panel status
    const st = $('#recPanelStatus');
    const pbtn = $('#recPanelBtn');
    if (st) {
      let s;
      if (rec.state === 'recording') {
        s = `Recording · ${elapsed} · ${fmtBytes(rec.bytes)} · ${rec.mode === 'screen' ? 'Screen' : 'Studio'}${rec.spins.size ? ` · ${rec.spins.size} draw${rec.spins.size === 1 ? '' : 's'}` : ''}`;
      } else if (rec.state === 'starting') s = 'Starting…';
      else if (rec.state === 'stopping') s = 'Saving — uploading the final part…';
      else if (live) s = 'A recording is running on another screen.';
      else s = prefs.autoRecord ? 'Not recording · auto-record on spin is on' : 'Not recording';
      if (uploadError && (queue.length || rec.state !== 'idle')) s += ` — ${uploadError}`;
      else if (queue.length && rec.state === 'idle') s += ` — uploading ${fmtBytes(queue.reduce((n, c) => n + c.blob.size, 0))}…`;
      st.textContent = s;
      pbtn.textContent = rec.state === 'recording' ? 'Stop recording' : rec.state === 'idle' ? 'Start recording' : '…';
      pbtn.className = `btn ${rec.state === 'recording' ? 'danger' : 'primary'}`;
      pbtn.disabled = rec.state === 'starting' || rec.state === 'stopping';
    }
  }
  setInterval(render, 500);

  function toggleFromButton() {
    if (rec.state === 'recording') stop();
    else if (rec.state === 'idle') openSetup();
  }
  $('#recBtn').addEventListener('click', toggleFromButton);
  $('#recPanelBtn').addEventListener('click', toggleFromButton);

  // Setup modal
  function syncSetup() {
    $$('#recMode button').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === prefs.mode);
      if (b.dataset.v === 'screen') b.disabled = !canScreen;
      if (b.dataset.v === 'studio') b.disabled = !canStudio;
    });
    $('#recModeHelp').textContent = prefs.mode === 'screen'
      ? "Records your screen, a window or this tab using the browser's screen-sharing permission. Desktop browsers only — choose “This tab” for the cleanest result."
      : `Records the live draw board — branding, date and time, category, wheel, winners and celebrations — directly from this app. No screen-sharing permission needed.${canScreen ? '' : ' (Screen mode is not supported in this browser.)'} Keep this tab open and visible while recording.`;
    $('#optSystemRow').hidden = prefs.mode !== 'screen';
    $$('#recModal .switch').forEach((s) => s.setAttribute('aria-checked', String(!!prefs[s.dataset.opt])));
  }
  function openSetup() {
    if (!canRecord) return A.toast('This browser cannot record video. Use a recent Chrome, Edge, Firefox or Safari.', 'error');
    syncSetup();
    $('#recModal').hidden = false;
  }
  const closeSetup = () => { $('#recModal').hidden = true; };
  $('#recMode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || b.disabled) return;
    prefs.mode = b.dataset.v;
    savePrefs();
    syncSetup();
  });
  $('#recModal').addEventListener('click', (e) => {
    const s = e.target.closest('.switch');
    if (!s) return;
    prefs[s.dataset.opt] = !prefs[s.dataset.opt];
    savePrefs();
    syncSetup();
    render();
  });
  $('#recCancel').addEventListener('click', closeSetup);
  $('#recModal').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) closeSetup(); });
  $('#recStart').addEventListener('click', () => { closeSetup(); start(prefs); });

  // ---------------------------------------------------------------------------
  // Recordings list (admin)
  // ---------------------------------------------------------------------------
  let list = [];
  let publicUrl = null;
  let filter = 'all';
  let current = null; // recording shown in preview

  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    dl: '<svg viewBox="0 0 24 24" class="ico"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" fill="none"/></svg>',
    link: '<svg viewBox="0 0 24 24" class="ico"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none"/></svg>',
    wa: '<svg viewBox="0 0 24 24" class="ico"><path d="M4 20l1.3-4A8 8 0 1 1 8 18.7L4 20z" fill="none"/></svg>',
    del: '<svg viewBox="0 0 24 24" class="ico"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none"/></svg>',
  };

  const baseUrl = () => publicUrl || location.origin;
  const shareUrl = (r) => `${baseUrl()}/r/${r.token}`;
  // Browser-only (GitHub Pages) builds serve recordings from the device via window.AFC_MEDIA.
  const mediaUrl = (r, dl) => window.AFC_MEDIA?.(r, dl) ?? `/media/${r.token}.${r.ext}${dl ? '?download=1' : ''}`;
  const fileNameOf = (r) => `AngleFrames-Chitty_${r.categoryName.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')}_${r.dateIst}_${r.id}.${r.ext}`;
  const playable = (r) => r.status === 'ready' || r.status === 'interrupted';
  const titleOf = (r) => r.categoryNames.join(', ');
  const fmtDay = (iso) => A.fmtDate.format(new Date(`${iso}T12:00:00+05:30`));

  async function loadList() {
    if (!A.isAdmin()) return;
    try {
      const r = await A.api('GET', '/api/recordings');
      list = r.recordings;
      publicUrl = r.publicUrl;
      renderList();
      if (current) { current = list.find((x) => x.id === current.id) || null; if (current) fillPreview(); else closePreview(); }
    } catch (e) { /* not admin / offline */ }
  }

  function renderList() {
    const warn = $('#recLinkWarn');
    const host = new URL(baseUrl()).hostname;
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
    warn.hidden = !local;
    if (local) warn.textContent = 'Share links currently point to this computer (localhost), so participants cannot open them. Host the app on a public address and start it with PUBLIC_URL=https://your-domain to share recordings.';

    const cats = [...new Set(list.flatMap((r) => r.categoryNames))];
    if (filter !== 'all' && !cats.includes(filter)) filter = 'all';
    $('#recFilter').innerHTML = ['all', ...cats].map((c) =>
      `<button data-v="${A.esc(c)}" class="${c === filter ? 'on' : ''}">${c === 'all' ? 'All' : A.esc(c)}</button>`).join('');
    const rows = list.filter((r) => filter === 'all' || r.categoryNames.includes(filter));
    const total = rows.reduce((n, r) => n + r.size, 0);
    $('#recCount').textContent = rows.length ? `${rows.length} recording${rows.length === 1 ? '' : 's'} · ${fmtBytes(total)}` : '';
    if (!rows.length) { $('#recList').innerHTML = '<p class="note" style="margin:10px 0 0">No recordings yet.</p>'; return; }

    let html = '';
    let day = '';
    for (const r of rows) {
      if (r.dateIst !== day) { day = r.dateIst; html += `<p class="rec-day">${A.esc(fmtDay(day))}</p>`; }
      const tag = {
        recording: '<span class="tag won">Live</span>',
        processing: '<span class="tag proc">Processing</span>',
        interrupted: '<span class="tag int">Interrupted</span>',
        failed: '<span class="tag fail">Failed</span>',
      }[r.status] || '';
      const ok = playable(r);
      const meta = [
        A.fmtTime.format(new Date(r.startedAt)),
        r.durationMs ? fmtClock(r.durationMs) : null,
        r.size ? fmtBytes(r.size) : null,
        r.spins ? `${r.spins} draw${r.spins === 1 ? '' : 's'}` : null,
        r.mode === 'screen' ? 'Screen' : 'Studio',
      ].filter(Boolean).join(' · ');
      html += `<div class="rec-item" data-id="${r.id}">
        <button class="rec-play" data-act="play" aria-label="Preview" ${ok ? '' : 'disabled'}>${ICON.play}</button>
        <div class="rec-info"><b>${A.esc(titleOf(r))} ${tag}</b><span>${A.esc(meta)}</span>${r.note ? `<span>${A.esc(r.note)}</span>` : ''}</div>
        <div class="rec-actions">
          <button class="icon-btn sm hide-sm" data-act="dl" aria-label="Download" ${ok ? '' : 'disabled'}>${ICON.dl}</button>
          <button class="icon-btn sm hide-sm" data-act="copy" aria-label="Copy link" ${ok ? '' : 'disabled'}>${ICON.link}</button>
          <button class="icon-btn sm" data-act="wa" aria-label="Share on WhatsApp" ${ok ? '' : 'disabled'}>${ICON.wa}</button>
          <button class="icon-btn sm del" data-act="del" aria-label="Delete" ${r.status === 'recording' ? 'disabled' : ''}>${ICON.del}</button>
        </div>
      </div>`;
    }
    $('#recList').innerHTML = html;
  }

  $('#recFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    filter = b.dataset.v;
    renderList();
  });

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
  function download(r) {
    const a = document.createElement('a');
    a.href = mediaUrl(r, true);
    a.rel = 'noopener';
    if (window.AFC_STATIC) a.download = fileNameOf(r);
    document.body.append(a); a.click(); a.remove();
  }
  // Browser-only build: there is no server link to share, so share the video file itself.
  async function shareVideoFile(r) {
    const blob = await window.AFC_MEDIA_BLOB?.(r);
    if (!blob) return A.toast('Recording file not found on this device', 'error');
    const file = new File([blob], fileNameOf(r), { type: blob.type || 'video/mp4' });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'ANGLE FRAMES CHITTY — Live draw recording' });
        return;
      }
    } catch (e) { if (e.name === 'AbortError') return; }
    download(r);
    A.toast('Video downloaded — attach it in your WhatsApp group.');
  }
  function whatsapp(r) {
    if (window.AFC_STATIC) return shareVideoFile(r);
    const when = A.fmtDate.format(new Date(r.startedAt));
    const text = `ANGLE FRAMES CHITTY — Live draw recording\n${titleOf(r)} · ${when}\n${shareUrl(r)}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }
  async function copyLink(r) {
    A.toast((await copyText(shareUrl(r))) ? 'Recording link copied' : shareUrl(r), 'ok');
  }
  async function remove(r) {
    const ok = await A.confirmBox('Delete this recording?',
      `“${titleOf(r)}” recorded ${A.fmtDate.format(new Date(r.startedAt))} will be permanently deleted, and its share link will stop working. This cannot be undone.`, 'Delete');
    if (!ok) return;
    try { await A.api('DELETE', `/api/recordings/${r.id}`); A.toast('Recording deleted', 'ok'); if (current?.id === r.id) closePreview(); loadList(); }
    catch (e) { A.toast(e.message, 'error'); }
  }

  $('#recList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const r = list.find((x) => x.id === Number(b.closest('.rec-item').dataset.id));
    if (!r) return;
    ({ play: () => openPreview(r), dl: () => download(r), copy: () => copyLink(r), wa: () => whatsapp(r), del: () => remove(r) })[b.dataset.act]?.();
  });

  // Preview
  function fillPreview() {
    const r = current;
    $('#previewTitle').textContent = titleOf(r);
    $('#previewMeta').textContent = [
      `${A.fmtDate.format(new Date(r.startedAt))}, ${A.fmtTime.format(new Date(r.startedAt))} IST`,
      r.durationMs ? fmtClock(r.durationMs) : null,
      r.size ? fmtBytes(r.size) : null,
      r.spins ? `${r.spins} draw${r.spins === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' · ');
    const v = $('#previewVideo');
    const src = mediaUrl(r);
    if (v.getAttribute('src') !== src) v.setAttribute('src', src);
    $('#previewDownload').href = mediaUrl(r, true);
    if (window.AFC_STATIC) $('#previewDownload').download = fileNameOf(r);
  }
  function openPreview(r) {
    current = r;
    fillPreview();
    $('#previewModal').hidden = false;
  }
  function closePreview() {
    const v = $('#previewVideo');
    v.pause(); v.removeAttribute('src'); v.load();
    $('#previewModal').hidden = true;
    current = null;
  }
  $('#previewClose').addEventListener('click', closePreview);
  $('#previewModal').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) closePreview(); });
  $('#previewCopy').addEventListener('click', () => current && copyLink(current));
  $('#previewWa').addEventListener('click', () => current && whatsapp(current));
  $('#previewNewLink').addEventListener('click', async () => {
    if (!current) return;
    const ok = await A.confirmBox('Reset share link?', 'The current link will stop working for everyone who has it. A new link will be created.', 'Reset link');
    if (!ok) return;
    try { await A.api('POST', `/api/recordings/${current.id}/new-link`); A.toast('New link created', 'ok'); loadList(); }
    catch (e) { A.toast(e.message, 'error'); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#confirmModal').hidden) return; // app handles its own confirm
    if (!$('#previewModal').hidden) { e.stopImmediatePropagation(); closePreview(); }
    else if (!$('#recModal').hidden) { e.stopImmediatePropagation(); closeSetup(); }
  }, true);

  // Load the list when the Recordings tab opens.
  $$('.tab').forEach((t) => t.addEventListener('click', () => { if (t.dataset.tab === 'recordings') loadList(); }));

  // ---------------------------------------------------------------------------
  // Hooks called by app.js
  // ---------------------------------------------------------------------------
  let wasAdmin = false;
  window.AFCRecorder = {
    // Auto-record: runs inside the START SPIN click. Returns false to cancel the spin.
    async beforeSpin() {
      if (!prefs.autoRecord || rec.state !== 'idle' || !canRecord) return true;
      const ok = await start(prefs);
      if (ok) { await sleep(700); return true; }
      return A.confirmBox('Recording did not start', 'The draw can continue without a recording. Spin now without recording?', 'Spin without recording', false);
    },
    onState(data) {
      const admin = A.isAdmin();
      if (admin && !wasAdmin) { recoverPending(); loadList(); }
      wasAdmin = admin;
      const cat = data.category;
      if (rec.state === 'recording' && cat) {
        if (cat.activeSpin && !rec.spins.has(cat.activeSpin.id)) {
          rec.spins.add(cat.activeSpin.id);
          rec.categoryNames.add(cat.name);
        }
        const done = cat.totalParticipants > 0 && cat.eligibleCount === 0 && !cat.activeSpin && rec.spins.size > 0;
        if (prefs.autoStop && done && !rec.autoStopTimer) {
          // Leave time for the final winner's celebration to be captured.
          rec.autoStopTimer = setTimeout(() => {
            rec.autoStopTimer = 0;
            A.toast('All participants have won — stopping the recording.');
            stop();
          }, 12000);
        } else if (!done && rec.autoStopTimer) {
          clearTimeout(rec.autoStopTimer);
          rec.autoStopTimer = 0;
        }
      }
      render();
    },
    onEvent() {
      loadList();
    },
  };
  render();
})();
