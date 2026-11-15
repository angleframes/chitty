'use strict';
// ANGLE FRAMES CHITTY — Google Sheet mode for the GitHub Pages build.
//
// When window.AFC_SHEET_API (the Apps Script web-app URL, see apps-script/Code.gs) is set,
// participants, winners and the draw itself come from the Google Sheet:
//   • the eligible pool is read live from the sheet (₹1,000 = A/B, ₹3,000 = C/D)
//   • START SPIN asks the sheet script to draw — it picks the winner securely under a lock,
//     writes "WINNER" into the sheet and logs it in the "Draw Log" tab
//   • this page only animates the wheel to the winner the sheet chose
// Recordings, sharing and the display stay on this device (handled by local-backend.js).
// Loaded after local-backend.js and before app.js.
(() => {
  const API = (window.AFC_SHEET_API || '').trim();
  if (!API) return; // not configured → plain browser-only mode
  window.AFC_SHEET = true;
  document.documentElement.classList.add('sheet-mode');

  const TZ = 'Asia/Kolkata';
  const TAU = Math.PI * 2;
  const TOKEN_KEY = 'afc_sheet_token';
  const SPIN_KEY = 'afc_sheet_spin';
  const ROT_KEY = 'afc_sheet_rotation';
  const POOL_TTL_MS = 20000; // display refresh only — every draw re-reads the sheet on the server
  const CATS = [
    { id: 1000, key: '1000', name: '₹1,000 Chitty', amount: 1000 },
    { id: 3000, key: '3000', name: '₹3,000 Chitty', amount: 3000 },
  ];
  const istDate = (d = new Date()) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };
  const randInt = (n) => { const b = new Uint32Array(1); const lim = Math.floor(0x100000000 / n) * n; do crypto.getRandomValues(b); while (b[0] >= lim); return b[0] % n; };
  const broadcast = (e) => window.AFC_LOCAL?.broadcast(e);

  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

  // ---------------------------------------------------------------------------
  // Apps Script calls (text/plain POST = no CORS preflight)
  // ---------------------------------------------------------------------------
  const realFetch = window.fetch.bind(window); // local-backend's fetch (for recordings etc.)
  async function sheetCall(body) {
    let res;
    try {
      res = await realFetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
    } catch {
      throw new HttpError(503, 'The Google Sheet could not be reached. Check the internet connection — no draw was made.');
    }
    let j;
    try { j = await res.json(); } catch { throw new HttpError(503, 'The Google Sheet draw service did not answer correctly. No draw was made.'); }
    if (j.error) {
      if (j.status === 401) { setToken(null); }
      throw new HttpError(j.status || 500, j.error);
    }
    return j;
  }

  let token = ls.get(TOKEN_KEY);
  function setToken(t) {
    if (token) window.AFC_LOCAL?.revokeSession(token);
    token = t;
    ls.set(TOKEN_KEY, t);
    if (t) window.AFC_LOCAL?.grantSession(t, 6 * 60 * 60 * 1000); // lets the same token use local recordings
  }
  if (token) window.AFC_LOCAL?.grantSession(token, 6 * 60 * 60 * 1000);
  const bearer = (headers) => { const h = headers.Authorization || headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; };

  // ---------------------------------------------------------------------------
  // Cached sheet data (display only)
  // ---------------------------------------------------------------------------
  let pools = null, history = [], loadedAt = 0, loadError = null, loading = null;
  async function reload(force = false) {
    if (!token) { pools = null; history = []; return; }
    if (!force && pools && Date.now() - loadedAt < POOL_TTL_MS) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        const [p, h] = await Promise.all([sheetCall({ action: 'pool', token }), sheetCall({ action: 'history', token })]);
        pools = p.categories; history = h.draws || []; loadedAt = Date.now(); loadError = null;
      } catch (e) {
        loadError = e.message;
        if (e.status === 401) { pools = null; history = []; }
      } finally {
        loading = null;
        renderSheetBar();
      }
    })();
    return loading;
  }

  const catOf = (id) => CATS.find((c) => c.id === Number(id)) || CATS[0];
  const poolOf = (cat) => pools?.find((p) => p.key === cat.key);
  const pid = (cell) => { let h = 0; for (const ch of cell) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 2_000_000_000; };
  const drawNo = (cat) => { const list = history.filter((d) => d.category === cat.key).slice().reverse(); return (drawId) => list.findIndex((d) => d.drawId === drawId) + 1; };
  function publicWinner(d) {
    const cat = CATS.find((c) => c.key === String(d.category)) || CATS[0];
    return {
      id: pid(d.drawId), categoryId: cat.id, cycle: 1, participantId: pid(d.nameCell), participantUid: d.nameCell,
      name: d.name, categoryName: cat.name, amount: cat.amount, drawNumber: drawNo(cat)(d.drawId), drawnAt: new Date(d.drawnAt).toISOString(),
    };
  }

  // Local animation record for the spin the sheet just decided.
  const spinRec = () => { try { return JSON.parse(ls.get(SPIN_KEY) || 'null'); } catch { return null; } };
  const rotations = () => { try { return JSON.parse(ls.get(ROT_KEY) || '{}'); } catch { return {}; } };

  async function buildState(categoryId) {
    reload(); // background refresh if stale
    const now = Date.now();
    const today = istDate();
    const local = await realFetch('/api/state').then((r) => r.json()).catch(() => ({}));
    const spin = spinRec();
    const live = spin && spin.revealAt > now ? spin : null;
    const revealed = (d) => !(live && live.drawId === d.drawId);
    const vis = history.filter(revealed);
    const cat = catOf(categoryId);
    const pool = poolOf(cat);

    const state = {
      serverTime: now,
      today,
      categories: CATS.map((c) => ({ id: c.id, name: c.name, amount: c.amount, cycle: 1, winners: vis.filter((d) => d.category === c.key).length })),
      todayWinners: vis.filter((d) => istDate(new Date(d.drawnAt)) === today).map(publicWinner),
      recording: local.recording || null,
      category: null,
    };
    const winnerCells = new Set((pool?.winners || []).map((w) => w.cell));
    const participants = pool ? [...pool.eligible, ...pool.winners].sort((a, b) => a.row - b.row).map((s) => {
      const d = history.find((x) => x.category === cat.key && x.nameCell === s.cell && revealed(x));
      return { id: pid(s.cell), uid: s.cell, name: s.name, phone: null, createdAt: null, won: winnerCells.has(s.cell) && !(live && live.cell === s.cell), wonAt: d?.drawnAt ?? null, drawNumber: d ? drawNo(cat)(d.drawId) : null };
    }) : [];
    const catLive = live && live.category === cat.key ? live : null;
    let wheel = pool ? pool.eligible.map((s) => ({ id: pid(s.cell), uid: s.cell, name: s.name })) : [];
    if (catLive) wheel = catLive.wheel;
    const cycleWinners = vis.filter((d) => d.category === cat.key).map(publicWinner);
    state.category = {
      id: cat.id, name: cat.name, amount: cat.amount, cycle: 1,
      rotation: rotations()[cat.key] || 0,
      participants,
      totalParticipants: participants.length,
      eligibleCount: catLive ? wheel.length - 1 : wheel.length,
      wheel,
      activeSpin: catLive ? {
        id: pid(catLive.drawId), startedAt: catLive.startedAt, revealAt: catLive.revealAt, duration: catLive.duration,
        startRotation: catLive.startRotation, endRotation: catLive.endRotation, winnerIndex: catLive.winnerIndex, winner: catLive.winner,
      } : null,
      latestWinner: cycleWinners[0] || null,
      cycleWinners,
      cycles: [{ cycle: 1, started_at: new Date(0).toISOString(), ended_at: null, end_reason: null, winners: cycleWinners.length }],
    };
    return state;
  }

  async function doSpin(cat) {
    if (!token) throw new HttpError(401, 'Admin sign-in required');
    const live = spinRec();
    if (live && live.revealAt > Date.now()) throw new HttpError(409, 'A spin is already in progress');
    const requestId = `cw-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const r = await sheetCall({ action: 'draw', category: cat.key, requestId, token, admin: 'Chitty app' });
    if (!r.pool || r.winnerIndex == null) { await reload(true); broadcast({ type: 'changed', categoryId: cat.id }); return { ok: true }; }
    const wheel = r.pool.map((s) => ({ id: pid(s.cell), uid: s.cell, name: s.name }));
    const n = wheel.length, seg = TAU / n;
    const start = rotations()[cat.key] || 0;
    const offset = 0.2 + (randInt(10001) / 10000) * 0.6;
    const target = -Math.PI / 2 - (r.winnerIndex + offset) * seg;
    const end = start + (7 + randInt(4)) * TAU + ((((target - start) % TAU) + TAU) % TAU);
    const duration = 9000 + randInt(2001);
    const now = Date.now();
    history.unshift(r.draw); // so the winner shows the moment the wheel stops
    const rec = {
      drawId: r.draw.drawId, category: cat.key, cell: r.draw.nameCell, startedAt: now, revealAt: now + duration, duration,
      startRotation: start, endRotation: end, winnerIndex: r.winnerIndex, wheel, winner: publicWinner(r.draw),
    };
    ls.set(SPIN_KEY, JSON.stringify(rec));
    const rot = rotations(); rot[cat.key] = end % TAU; ls.set(ROT_KEY, JSON.stringify(rot));
    broadcast({ type: 'spin', categoryId: cat.id });
    setTimeout(async () => { await reload(true); broadcast({ type: 'revealed', categoryId: cat.id }); }, duration + 100);
    return { ok: true, spinId: rec.drawId };
  }

  function report(url) {
    const scope = url.searchParams.get('scope') || 'today';
    const catParam = url.searchParams.get('category') || 'all';
    const today = istDate();
    const cats = catParam === 'all' ? CATS : CATS.filter((c) => c.id === Number(catParam));
    const groups = cats.map((c) => {
      let rows = history.filter((d) => d.category === c.key);
      if (scope === 'today') rows = rows.filter((d) => istDate(new Date(d.drawnAt)) === today);
      return {
        categoryId: c.id, name: c.name, amount: c.amount, cycle: 1, archived: false, endReason: null,
        winners: rows.slice().reverse().map((d) => { const w = publicWinner(d); return { id: w.id, drawNumber: w.drawNumber, name: w.name, uid: w.participantUid, drawnAt: w.drawnAt, dateIst: istDate(new Date(d.drawnAt)) }; }),
      };
    });
    const shown = cats.length === 1 ? groups : groups.filter((g) => g.winners.length);
    return { scope, category: catParam, today, generatedAt: new Date().toISOString(), total: shown.reduce((n, g) => n + g.winners.length, 0), groups: shown,
      cycles: scope === 'history' ? [{ cycle: 1, started_at: new Date(0).toISOString(), ended_at: null, end_reason: null, winners: groups[0]?.winners.length || 0 }] : null };
  }

  // ---------------------------------------------------------------------------
  // fetch() routing — sheet routes here, everything else to local-backend
  // ---------------------------------------------------------------------------
  const SHEET_MANAGED = 'In Google Sheet mode, participants and winners are managed in the Google Sheet. Edit the sheet, then press Refresh.';
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const i = url.pathname.indexOf('/api/');
    if (url.origin !== location.origin || i === -1) return realFetch(input, init);
    const path = url.pathname.slice(i);
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers || {});
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const admin = () => { if (!token || bearer(headers) !== token) throw new HttpError(401, 'Admin sign-in required'); };
    try {
      let m;
      if (method === 'GET' && path === '/api/state') return reply(200, await buildState(url.searchParams.get('category')));
      if (method === 'GET' && path === '/api/session') return reply(200, { admin: !!token && bearer(headers) === token });
      if (method === 'POST' && path === '/api/login') {
        const { pin } = JSON.parse(init.body || '{}');
        const r = await sheetCall({ action: 'login', pin: String(pin || '') });
        setToken(r.token);
        reload(true).then(() => broadcast({ type: 'changed' }));
        return reply(200, { token: r.token });
      }
      if (method === 'POST' && path === '/api/logout') {
        if (token) sheetCall({ action: 'logout', token }).catch(() => {});
        setToken(null); pools = null; history = [];
        renderSheetBar();
        return reply(200, { ok: true });
      }
      if (method === 'POST' && (m = path.match(/^\/api\/categories\/(\d+)\/spin$/))) { admin(); return reply(200, await doSpin(catOf(m[1]))); }
      if (method === 'GET' && path === '/api/winners-report') { admin(); await reload(); return reply(200, report(url)); }
      if (method === 'GET' && (m = path.match(/^\/api\/categories\/(\d+)\/cycles\/\d+$/))) {
        admin(); const c = catOf(m[1]);
        return reply(200, { winners: history.filter((d) => d.category === c.key).slice().reverse().map(publicWinner) });
      }
      if (/^\/api\/(categories|participants|reset)/.test(path) && method !== 'GET') { admin(); throw new HttpError(409, SHEET_MANAGED); }
      return realFetch(input, init); // recordings and anything else
    } catch (e) {
      return reply(e.status || 500, { error: e.message || 'Something went wrong. No draw was made.' });
    }
  };

  // ---------------------------------------------------------------------------
  // UI: sheet status + refresh, sign-in hint
  // ---------------------------------------------------------------------------
  function ago(t) { const s = Math.round((Date.now() - t) / 1000); return s < 5 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`; }
  function renderSheetBar() {
    const bar = document.getElementById('sheetBar');
    if (!bar) return;
    bar.hidden = !token;
    const txt = bar.querySelector('span');
    if (loadError) { bar.classList.add('err'); txt.textContent = loadError; }
    else { bar.classList.remove('err'); txt.textContent = loadedAt ? `Google Sheet · updated ${ago(loadedAt)}` : 'Google Sheet · loading…'; }
  }
  document.addEventListener('DOMContentLoaded', () => {
    const hint = document.querySelector('#loginModal .muted');
    if (hint) hint.textContent = 'Enter the admin PIN set in the Google Sheet (menu Chitty draw → Set admin PIN).';
    const badges = document.querySelector('.stage-badges');
    if (badges) {
      const bar = document.createElement('button');
      bar.id = 'sheetBar'; bar.className = 'sheet-bar'; bar.hidden = true;
      bar.innerHTML = '<i></i><span>Google Sheet</span>';
      bar.addEventListener('click', async () => { bar.classList.add('busy'); await reload(true); bar.classList.remove('busy'); broadcast({ type: 'changed' }); });
      badges.prepend(bar);
    }
    const panel = document.querySelector('[data-panel="participants"] .block');
    if (panel) {
      const note = document.createElement('p');
      note.className = 'sheet-note';
      note.textContent = 'Participants come live from the Google Sheet (₹1,000 = columns A/B, ₹3,000 = columns C/D). Add or correct names in the sheet, then press the "Google Sheet" button to refresh.';
      panel.before(note);
    }
    renderSheetBar();
    setInterval(renderSheetBar, 5000);
    reload(true).then(() => broadcast({ type: 'changed' }));
  });
})();
