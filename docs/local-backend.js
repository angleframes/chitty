'use strict';
// ANGLE FRAMES CHITTY — browser-only backend for static hosting (GitHub Pages).
//
// The full app normally talks to server.js. When hosted as static files there is no server,
// so this script answers the same /api/* requests inside the browser:
//   • data (categories, participants, cycles, winners) → localStorage, mutations serialised
//     across tabs with the Web Locks API (the equivalent of the server's BEGIN IMMEDIATE)
//   • recordings → IndexedDB (video stays on this device)
//   • live updates → BroadcastChannel (tabs/windows of this browser stay in sync)
//   • winner selection → crypto.getRandomValues (unbiased, cryptographically secure)
// It must load before app.js.
(() => {
  window.AFC_STATIC = true;
  document.documentElement.classList.add('static-mode');

  const TZ = 'Asia/Kolkata';
  const TAU = Math.PI * 2;
  const SPIN_MIN_MS = 9000;
  const SPIN_MAX_MS = 11000;
  const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
  const DB_KEY = 'afc_local_db_v1';
  const PIN_KEY = 'afc_local_pin_v1';
  const SESS_KEY = 'afc_local_sessions_v1';

  const nowIso = () => new Date().toISOString();
  const istDate = (d = new Date()) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

  // Unbiased random integer in [min, max) using rejection sampling.
  function randomInt(min, max) {
    if (max === undefined) { max = min; min = 0; }
    const range = max - min;
    if (range <= 0) return min;
    const limit = Math.floor(0x100000000 / range) * range;
    const buf = new Uint32Array(1);
    let x;
    do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return min + (x % range);
  }
  const randomToken = (bytes = 18) => {
    const b = crypto.getRandomValues(new Uint8Array(bytes));
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  async function sha256(text) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { localStorage.setItem(k, v); },
  };

  function seed() {
    const db = { seq: { cat: 0, p: 0, w: 0, rec: 0 }, categories: [], participants: [], cycles: [], winners: [], recordings: [] };
    for (const amt of [1000, 2000, 3000]) {
      const id = ++db.seq.cat;
      db.categories.push({ id, name: `₹${amt.toLocaleString('en-IN')} Chitty`, amount: amt, current_cycle: 1, wheel_rotation: 0, archived: 0, created_at: nowIso() });
      db.cycles.push({ category_id: id, cycle: 1, started_at: nowIso(), ended_at: null, end_reason: null });
    }
    return db;
  }
  function load() {
    const raw = ls.get(DB_KEY);
    if (raw) { try { return JSON.parse(raw); } catch {} }
    const db = seed();
    save(db);
    return db;
  }
  function save(db) {
    try { ls.set(DB_KEY, JSON.stringify(db)); }
    catch { throw new HttpError(507, 'This browser\'s storage is full. Free up space and try again.'); }
  }

  // Serialise read-modify-write across tabs (Web Locks), like a DB transaction.
  async function tx(fn) {
    const run = async () => { const db = load(); const r = await fn(db); save(db); return r; };
    if (navigator.locks?.request) return navigator.locks.request('afc-local-db', run);
    return run();
  }

  // ---------------------------------------------------------------------------
  // Live events (replaces Server-Sent Events)
  // ---------------------------------------------------------------------------
  const listeners = new Set();
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('afc-live') : null;
  const deliver = (event) => { for (const l of listeners) l(event); };
  channel?.addEventListener('message', (e) => deliver(e.data));
  function broadcast(event) { channel?.postMessage(event); setTimeout(() => deliver(event), 0); }
  function scheduleReveal(categoryId, revealAt) {
    setTimeout(() => broadcast({ type: 'revealed', categoryId }), Math.max(0, revealAt - Date.now()) + 50);
  }

  class LocalEventSource {
    constructor() {
      this.readyState = 0;
      this.onopen = null; this.onmessage = null; this.onerror = null;
      this._l = (event) => this.onmessage?.({ data: JSON.stringify(event) });
      listeners.add(this._l);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({});
        this.onmessage?.({ data: JSON.stringify({ type: 'hello', serverTime: Date.now() }) });
      }, 0);
    }
    close() { this.readyState = 2; listeners.delete(this._l); }
    addEventListener(type, fn) { if (type === 'message') this.onmessage = fn; else if (type === 'open') this.onopen = fn; }
  }
  window.EventSource = LocalEventSource;

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------
  const activeCats = (db) => db.categories.filter((c) => !c.archived).sort((a, b) => a.amount - b.amount || a.id - b.id);
  const getCat = (db, id) => db.categories.find((c) => c.id === Number(id) && !c.archived);
  function requireCategory(db, id) {
    const c = getCat(db, id);
    if (!c) throw new HttpError(404, 'Category not found');
    return c;
  }
  const activeSpinOf = (db, catId, now = Date.now()) =>
    db.winners.filter((w) => w.category_id === catId && w.reveal_at_ms > now).sort((a, b) => b.id - a.id)[0] || null;
  function assertNotSpinning(db, catId) {
    if (activeSpinOf(db, catId)) throw new HttpError(409, 'A spin is in progress for this category. Please wait for it to finish.');
  }
  const eligibleOf = (db, cat) => db.participants
    .filter((p) => p.category_id === cat.id && p.active &&
      !db.winners.some((w) => w.category_id === cat.id && w.cycle === cat.current_cycle && w.participant_id === p.id))
    .sort((a, b) => a.id - b.id);

  function publicWinner(w) {
    if (!w) return null;
    return {
      id: w.id, categoryId: w.category_id, cycle: w.cycle, participantId: w.participant_id,
      participantUid: w.participant_uid, name: w.participant_name, categoryName: w.category_name,
      amount: w.amount, drawNumber: w.draw_number, drawnAt: new Date(w.reveal_at_ms).toISOString(),
    };
  }
  const publicCategory = (c) => ({ id: c.id, name: c.name, amount: c.amount, cycle: c.current_cycle });

  function activeRecording(db) {
    const r = db.recordings.filter((x) => x.status === 'recording').sort((a, b) => b.id - a.id)[0];
    return r && Date.now() - r.last_chunk_at < 2 * 60 * 1000
      ? { id: r.id, startedAt: Date.parse(r.started_at), categoryName: r.category_name } : null;
  }

  function buildState(db, categoryId) {
    const now = Date.now();
    const cats = activeCats(db);
    const revealed = (w) => w.reveal_at_ms <= now;
    const curCycle = new Map(db.categories.map((c) => [c.id, c.current_cycle]));
    const inActive = (w) => curCycle.get(w.category_id) === w.cycle;
    const today = istDate();
    const state = {
      serverTime: now,
      today,
      categories: cats.map((c) => ({ ...publicCategory(c), winners: db.winners.filter((w) => w.category_id === c.id && inActive(w) && revealed(w)).length })),
      todayWinners: db.winners.filter((w) => w.draw_date_ist === today && revealed(w) && inActive(w)).sort((a, b) => b.id - a.id).map(publicWinner),
      recording: activeRecording(db),
      category: null,
    };
    const cat = getCat(db, categoryId) || cats[0];
    if (!cat) return state;
    const cycleWins = db.winners.filter((w) => w.category_id === cat.id && w.cycle === cat.current_cycle);
    const participants = db.participants.filter((p) => p.category_id === cat.id && p.active).sort((a, b) => a.id - b.id).map((p) => {
      const w = cycleWins.find((x) => x.participant_id === p.id && revealed(x));
      return { id: p.id, uid: p.uid, name: p.name, phone: null, createdAt: p.created_at, won: !!w, wonAt: w?.drawn_at ?? null, drawNumber: w?.draw_number ?? null };
    });
    const spinRow = activeSpinOf(db, cat.id, now);
    let wheel, activeSpin = null;
    if (spinRow) {
      wheel = spinRow.wheel_snapshot;
      activeSpin = {
        id: spinRow.id, startedAt: spinRow.started_at_ms, revealAt: spinRow.reveal_at_ms, duration: spinRow.duration_ms,
        startRotation: spinRow.start_rotation, endRotation: spinRow.end_rotation, winnerIndex: spinRow.winner_index,
        winner: publicWinner(spinRow),
      };
    } else {
      wheel = eligibleOf(db, cat).map((p) => ({ id: p.id, uid: p.uid, name: p.name }));
    }
    const revealedCycle = cycleWins.filter(revealed).sort((a, b) => b.id - a.id);
    state.category = {
      ...publicCategory(cat),
      rotation: cat.wheel_rotation,
      participants,
      totalParticipants: participants.length,
      eligibleCount: spinRow ? wheel.length - 1 : wheel.length,
      wheel,
      activeSpin,
      latestWinner: publicWinner(revealedCycle[0]),
      cycleWinners: revealedCycle.map(publicWinner),
      cycles: cyclesOf(db, cat.id, now),
    };
    return state;
  }
  function cyclesOf(db, catId, now = Date.now()) {
    return db.cycles.filter((c) => c.category_id === catId).sort((a, b) => b.cycle - a.cycle).map((c) => ({
      cycle: c.cycle, started_at: c.started_at, ended_at: c.ended_at, end_reason: c.end_reason,
      winners: db.winners.filter((w) => w.category_id === catId && w.cycle === c.cycle && w.reveal_at_ms <= now).length,
    }));
  }

  // ---------------------------------------------------------------------------
  // Admin sessions (this device only)
  // ---------------------------------------------------------------------------
  const sessions = () => { try { return JSON.parse(ls.get(SESS_KEY) || '{}'); } catch { return {}; } };
  function isAdmin(headers) {
    const h = headers.Authorization || headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const s = sessions();
    return !!(token && s[token] && s[token] > Date.now());
  }
  let attempts = { count: 0, until: 0 };

  // ---------------------------------------------------------------------------
  // Recordings (IndexedDB)
  // ---------------------------------------------------------------------------
  const idb = (() => {
    let p = null;
    const open = () => (p ||= new Promise((res, rej) => {
      const r = indexedDB.open('afc-local-media', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('chunks', { keyPath: ['recId', 'seq'] });
        r.result.createObjectStore('files', { keyPath: 'recId' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const run = async (store, mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => res(req?.result);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error('Storage aborted'));
      });
    };
    return {
      putChunk: (c) => run('chunks', 'readwrite', (s) => s.put(c)),
      chunks: (recId) => run('chunks', 'readonly', (s) => s.getAll(IDBKeyRange.bound([recId, 0], [recId, Infinity]))),
      dropChunks: (recId) => run('chunks', 'readwrite', (s) => s.delete(IDBKeyRange.bound([recId, 0], [recId, Infinity]))),
      putFile: (f) => run('files', 'readwrite', (s) => s.put(f)),
      file: (recId) => run('files', 'readonly', (s) => s.get(recId)),
      dropFile: (recId) => run('files', 'readwrite', (s) => s.delete(recId)),
    };
  })();

  const mediaUrls = new Map(); // recId → object URL
  async function blobOf(rec) {
    const f = await idb.file(rec.id).catch(() => null);
    if (f?.blob) return f.blob;
    const parts = await idb.chunks(rec.id).catch(() => []);
    return parts.length ? new Blob(parts.sort((a, b) => a.seq - b.seq).map((c) => c.blob), { type: rec.mime.split(';')[0] }) : null;
  }
  async function prepareMedia(recs) {
    for (const r of recs) {
      if (mediaUrls.has(r.id) || !['ready', 'interrupted'].includes(r.status)) continue;
      const b = await blobOf(r);
      if (b) mediaUrls.set(r.id, URL.createObjectURL(b));
    }
  }
  window.AFC_MEDIA = (r) => mediaUrls.get(r.id) || '#';
  window.AFC_MEDIA_BLOB = async (r) => {
    const db = load();
    const rec = db.recordings.find((x) => x.id === r.id);
    return rec ? blobOf(rec) : null;
  };

  function publicRec(r) {
    return {
      id: r.id, token: r.token, categoryId: r.category_id, categoryName: r.category_name,
      categoryNames: r.category_names || [r.category_name], mode: r.mode, size: r.size,
      durationMs: r.duration_ms, spins: r.spins, status: r.status, note: r.note,
      startedAt: r.started_at, endedAt: r.ended_at, dateIst: r.date_ist, ext: r.ext,
    };
  }

  // Recordings left open by a closed tab become playable "interrupted" recordings.
  async function sweepRecordings() {
    const stale = await tx((db) => {
      const out = [];
      for (const r of db.recordings) {
        if (r.status === 'recording' && Date.now() - r.last_chunk_at > 2 * 60 * 1000) {
          r.status = 'interrupted'; r.ended_at = new Date(r.last_chunk_at).toISOString();
          r.note = 'Recording was interrupted; the saved part is kept.';
          out.push(r.id);
        }
      }
      return out;
    });
    if (stale.length) broadcast({ type: 'recordings' });
  }
  setTimeout(sweepRecordings, 2000);
  setInterval(sweepRecordings, 30000);

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------
  const routes = [];
  const route = (method, pattern, admin, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), admin, handler });
  const json = (body) => { try { return body ? JSON.parse(body) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); } };

  route('GET', '/api/state', false, async ({ url }) => buildState(load(), url.searchParams.get('category')));
  route('GET', '/api/session', false, async ({ headers }) => ({ admin: isAdmin(headers) }));

  route('POST', '/api/login', false, async ({ body }) => {
    if (attempts.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a minute.');
    const pin = String(json(body).pin ?? '').trim();
    if (!/^\d{4,12}$/.test(pin)) throw new HttpError(400, 'Enter a PIN of 4–12 digits');
    let stored = ls.get(PIN_KEY);
    const hash = await sha256(`afc-chitty:${pin}`);
    if (!stored) { ls.set(PIN_KEY, hash); stored = hash; } // first sign-in on this device sets the PIN
    if (hash !== stored) {
      attempts.count++;
      if (attempts.count >= 5) attempts = { count: 0, until: Date.now() + 60000 };
      throw new HttpError(401, 'Incorrect admin PIN');
    }
    attempts = { count: 0, until: 0 };
    const token = randomToken(32);
    const s = sessions();
    for (const k of Object.keys(s)) if (s[k] < Date.now()) delete s[k];
    s[token] = Date.now() + SESSION_TTL_MS;
    ls.set(SESS_KEY, JSON.stringify(s));
    return { token };
  });
  route('POST', '/api/logout', false, async ({ headers }) => {
    const h = headers.Authorization || '';
    const s = sessions(); delete s[h.slice(7)]; ls.set(SESS_KEY, JSON.stringify(s));
    return { ok: true };
  });

  route('POST', '/api/categories', true, async ({ body }) => {
    const { name, amount } = json(body);
    const amt = Math.round(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) throw new HttpError(400, 'Enter a valid amount greater than zero');
    const nm = cleanName(name) || `₹${amt.toLocaleString('en-IN')} Chitty`;
    if (nm.length > 60) throw new HttpError(400, 'Category name is too long (max 60 characters)');
    const id = await tx((db) => {
      const id = ++db.seq.cat;
      db.categories.push({ id, name: nm, amount: amt, current_cycle: 1, wheel_rotation: 0, archived: 0, created_at: nowIso() });
      db.cycles.push({ category_id: id, cycle: 1, started_at: nowIso(), ended_at: null, end_reason: null });
      return id;
    });
    broadcast({ type: 'changed', categoryId: id });
    return { id, _status: 201 };
  });
  route('PUT', '/api/categories/(\\d+)', true, async ({ m, body }) => {
    const { name, amount } = json(body);
    await tx((db) => {
      const cat = requireCategory(db, m[1]);
      const amt = amount === undefined ? cat.amount : Math.round(Number(amount));
      if (!Number.isFinite(amt) || amt <= 0) throw new HttpError(400, 'Enter a valid amount greater than zero');
      const nm = name === undefined ? cat.name : cleanName(name);
      if (!nm) throw new HttpError(400, 'Category name is required');
      if (nm.length > 60) throw new HttpError(400, 'Category name is too long (max 60 characters)');
      cat.name = nm; cat.amount = amt;
    });
    broadcast({ type: 'changed', categoryId: Number(m[1]) });
    return { ok: true };
  });
  route('DELETE', '/api/categories/(\\d+)', true, async ({ m }) => {
    await tx((db) => { const cat = requireCategory(db, m[1]); assertNotSpinning(db, cat.id); cat.archived = 1; });
    broadcast({ type: 'changed', categoryId: Number(m[1]) });
    return { ok: true };
  });

  route('POST', '/api/categories/(\\d+)/participants', true, async ({ m, body }) => {
    const raw = json(body).names;
    let names = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n,;]+/);
    names = names.map(cleanName).filter(Boolean);
    if (!names.length) throw new HttpError(400, 'Enter at least one participant name');
    if (names.some((n) => n.length > 60)) throw new HttpError(400, 'Participant names must be 60 characters or fewer');
    if (names.length > 1000) throw new HttpError(400, 'Add at most 1000 participants at a time');
    const result = await tx((db) => {
      const cat = requireCategory(db, m[1]);
      const existing = new Set(db.participants.filter((p) => p.category_id === cat.id && p.active).map((p) => p.name.toLowerCase()));
      const uids = new Set(db.participants.map((p) => p.uid));
      let n = db.participants.filter((p) => p.category_id === cat.id).length + 1;
      const added = [], skipped = [];
      for (const name of names) {
        const key = name.toLowerCase();
        if (existing.has(key)) { skipped.push(name); continue; }
        existing.add(key);
        let uid;
        do { uid = `AF${String(cat.id).padStart(2, '0')}-${String(n++).padStart(4, '0')}`; } while (uids.has(uid));
        uids.add(uid);
        db.participants.push({ id: ++db.seq.p, uid, category_id: cat.id, name, active: 1, created_at: nowIso(), updated_at: nowIso() });
        added.push({ uid, name });
      }
      return { added, skipped };
    });
    broadcast({ type: 'changed', categoryId: Number(m[1]) });
    return { ...result, _status: 201 };
  });
  route('PUT', '/api/participants/(\\d+)', true, async ({ m, body }) => {
    const nm = cleanName(json(body).name);
    const catId = await tx((db) => {
      const p = db.participants.find((x) => x.id === Number(m[1]) && x.active);
      if (!p) throw new HttpError(404, 'Participant not found');
      assertNotSpinning(db, p.category_id);
      if (!nm) throw new HttpError(400, 'Participant name is required');
      if (nm.length > 60) throw new HttpError(400, 'Participant names must be 60 characters or fewer');
      if (db.participants.some((x) => x.category_id === p.category_id && x.active && x.id !== p.id && x.name.toLowerCase() === nm.toLowerCase())) {
        throw new HttpError(409, `"${nm}" is already in this category`);
      }
      p.name = nm; p.updated_at = nowIso();
      return p.category_id;
    });
    broadcast({ type: 'changed', categoryId: catId });
    return { ok: true };
  });
  route('DELETE', '/api/participants/(\\d+)', true, async ({ m }) => {
    const catId = await tx((db) => {
      const p = db.participants.find((x) => x.id === Number(m[1]) && x.active);
      if (!p) throw new HttpError(404, 'Participant not found');
      assertNotSpinning(db, p.category_id);
      p.active = 0; p.updated_at = nowIso(); // soft delete keeps winner records intact
      return p.category_id;
    });
    broadcast({ type: 'changed', categoryId: catId });
    return { ok: true };
  });

  route('POST', '/api/categories/(\\d+)/new-cycle', true, async ({ m }) => {
    const cycle = await tx((db) => {
      const cat = requireCategory(db, m[1]);
      if (activeSpinOf(db, cat.id)) throw new HttpError(409, 'Wait for the current spin to finish');
      const old = db.cycles.find((c) => c.category_id === cat.id && c.cycle === cat.current_cycle);
      if (old) { old.ended_at = nowIso(); old.end_reason = 'new-cycle'; }
      cat.current_cycle += 1;
      db.cycles.push({ category_id: cat.id, cycle: cat.current_cycle, started_at: nowIso(), ended_at: null, end_reason: null });
      return cat.current_cycle;
    });
    broadcast({ type: 'changed', categoryId: Number(m[1]) });
    return { cycle };
  });

  route('POST', '/api/reset', true, async ({ body }) => {
    const b = json(body);
    if (b.confirm !== 'RESET') throw new HttpError(400, 'Type RESET to confirm');
    const scope = b.scope === 'all' ? 'all' : 'category';
    const reset = await tx((db) => {
      const targets = scope === 'all' ? activeCats(db) : [requireCategory(db, b.categoryId)];
      if (!targets.length) throw new HttpError(400, 'There are no chitty categories to reset');
      const busy = targets.filter((c) => activeSpinOf(db, c.id));
      if (busy.length) throw new HttpError(409, `A spin is in progress in ${busy.map((c) => c.name).join(', ')}. Wait for it to finish, then reset.`);
      return targets.map((c) => {
        const archived = db.winners.filter((w) => w.category_id === c.id && w.cycle === c.current_cycle).length;
        const old = db.cycles.find((x) => x.category_id === c.id && x.cycle === c.current_cycle);
        if (old) { old.ended_at = nowIso(); old.end_reason = 'reset'; }
        const from = c.current_cycle;
        c.current_cycle += 1; c.wheel_rotation = 0;
        db.cycles.push({ category_id: c.id, cycle: c.current_cycle, started_at: nowIso(), ended_at: null, end_reason: null });
        return { id: c.id, name: c.name, archivedCycle: from, archivedWinners: archived, cycle: c.current_cycle };
      });
    });
    broadcast({ type: 'reset', scope, categoryIds: reset.map((r) => r.id) });
    return { scope, reset };
  });

  route('GET', '/api/categories/(\\d+)/cycles/(\\d+)', true, async ({ m }) => {
    const db = load();
    const now = Date.now();
    return { winners: db.winners.filter((w) => w.category_id === Number(m[1]) && w.cycle === Number(m[2]) && w.reveal_at_ms <= now).sort((a, b) => a.id - b.id).map(publicWinner) };
  });

  route('POST', '/api/categories/(\\d+)/spin', true, async ({ m }) => {
    const r = await tx((db) => {
      const cat = requireCategory(db, m[1]);
      const now = Date.now();
      if (activeSpinOf(db, cat.id, now)) throw new HttpError(409, 'A spin is already in progress');
      const eligible = eligibleOf(db, cat);
      if (!eligible.length) throw new HttpError(409, 'No eligible participants left in this draw cycle');
      const winnerIndex = randomInt(eligible.length);
      const winner = eligible[winnerIndex];
      if (db.winners.some((w) => w.category_id === cat.id && w.cycle === cat.current_cycle && w.participant_id === winner.id)) {
        throw new HttpError(409, 'Duplicate winner prevented');
      }
      const duration = randomInt(SPIN_MIN_MS, SPIN_MAX_MS + 1);
      const seg = TAU / eligible.length;
      const offset = 0.2 + (randomInt(0, 10001) / 10000) * 0.6;
      const target = -Math.PI / 2 - (winnerIndex + offset) * seg;
      const start = cat.wheel_rotation;
      const delta = (((target - start) % TAU) + TAU) % TAU;
      const end = start + (7 + randomInt(0, 4)) * TAU + delta;
      const drawNumber = db.winners.filter((w) => w.category_id === cat.id && w.cycle === cat.current_cycle).length + 1;
      const revealAt = now + duration;
      const id = ++db.seq.w;
      db.winners.push({
        id, category_id: cat.id, cycle: cat.current_cycle, participant_id: winner.id, participant_uid: winner.uid,
        participant_name: winner.name, category_name: cat.name, amount: cat.amount, draw_number: drawNumber,
        drawn_at: new Date(revealAt).toISOString(), draw_date_ist: istDate(new Date(revealAt)),
        started_at_ms: now, reveal_at_ms: revealAt, duration_ms: duration, start_rotation: start, end_rotation: end,
        winner_index: winnerIndex, wheel_snapshot: eligible.map((p) => ({ id: p.id, uid: p.uid, name: p.name })),
      });
      cat.wheel_rotation = end % TAU;
      return { id, categoryId: cat.id, revealAt };
    });
    scheduleReveal(r.categoryId, r.revealAt);
    broadcast({ type: 'spin', categoryId: r.categoryId });
    return { ok: true, spinId: r.id };
  });

  route('GET', '/api/winners-report', true, async ({ url }) => {
    const db = load();
    const scopes = ['today', 'previous', 'all', 'history'];
    const scope = scopes.includes(url.searchParams.get('scope')) ? url.searchParams.get('scope') : 'today';
    const catParam = url.searchParams.get('category') || 'all';
    const now = Date.now();
    const today = istDate();
    let cats = activeCats(db);
    if (catParam !== 'all') cats = cats.filter((c) => c.id === Number(catParam));
    if (catParam !== 'all' && !cats.length) throw new HttpError(404, 'Category not found');
    if (scope === 'history' && cats.length !== 1) throw new HttpError(400, 'Choose one chitty category to view its history');
    let cycles = null;
    const groups = cats.map((c) => {
      let cycle = c.current_cycle;
      if (scope === 'history') {
        cycles = cyclesOf(db, c.id, now);
        const wanted = Number(url.searchParams.get('cycle'));
        const pick = cycles.find((x) => x.cycle === wanted) || cycles.find((x) => x.cycle !== c.current_cycle) || cycles[0];
        cycle = pick ? pick.cycle : c.current_cycle;
      }
      let rows = db.winners.filter((w) => w.category_id === c.id && w.cycle === cycle && w.reveal_at_ms <= now)
        .sort((a, b) => a.draw_number - b.draw_number || a.id - b.id);
      if (scope === 'today') rows = rows.filter((w) => w.draw_date_ist === today);
      const seen = new Set();
      rows = rows.filter((w) => (seen.has(w.participant_id) ? false : seen.add(w.participant_id)));
      const cyc = db.cycles.find((x) => x.category_id === c.id && x.cycle === cycle);
      return {
        categoryId: c.id, name: c.name, amount: c.amount, cycle, archived: cycle !== c.current_cycle, endReason: cyc?.end_reason || null,
        winners: rows.map((w) => ({ id: w.id, drawNumber: w.draw_number, name: w.participant_name, uid: w.participant_uid, drawnAt: new Date(w.reveal_at_ms).toISOString(), dateIst: w.draw_date_ist })),
      };
    });
    const shown = cats.length === 1 ? groups : groups.filter((g) => g.winners.length);
    return { scope, category: catParam, today, generatedAt: new Date(now).toISOString(), total: shown.reduce((n, g) => n + g.winners.length, 0), groups: shown, cycles };
  });

  // Recordings
  route('GET', '/api/recordings', true, async () => {
    const db = load();
    const recs = db.recordings.slice().sort((a, b) => b.id - a.id);
    await prepareMedia(recs);
    return { recordings: recs.map(publicRec), publicUrl: null, mp4: false };
  });
  route('POST', '/api/recordings', true, async ({ body }) => {
    const b = json(body);
    const mime = String(b.mime || '').slice(0, 100);
    if (!/^video\/(webm|mp4|x-matroska)/.test(mime)) throw new HttpError(400, 'Unsupported recording format');
    const rec = await tx((db) => {
      const live = db.recordings.filter((r) => r.status === 'recording' && Date.now() - r.last_chunk_at < 2 * 60 * 1000);
      if (live.length && !b.force) throw new HttpError(409, 'Another recording is already in progress.');
      for (const r of live) { r.status = 'interrupted'; r.ended_at = nowIso(); r.note = 'Recording was interrupted; the saved part is kept.'; }
      const cat = db.categories.find((c) => c.id === Number(b.categoryId));
      const now = new Date();
      const r = {
        id: ++db.seq.rec, token: randomToken(), category_id: cat?.id ?? null, category_name: cat?.name ?? 'Live draw', category_names: null,
        mode: b.mode === 'screen' ? 'screen' : 'studio', mime, ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm',
        size: 0, next_seq: 0, duration_ms: 0, spins: 0, status: 'recording', note: null,
        started_at: now.toISOString(), ended_at: null, date_ist: istDate(now), last_chunk_at: Date.now(),
      };
      db.recordings.push(r);
      return r;
    });
    broadcast({ type: 'changed' });
    broadcast({ type: 'recordings' });
    return { ...publicRec(rec), _status: 201 };
  });
  route('PUT', '/api/recordings/(\\d+)/chunk', true, async ({ m, url, rawBody }) => {
    const seq = Number(url.searchParams.get('seq'));
    if (!Number.isInteger(seq) || seq < 0) throw new HttpError(400, 'Invalid chunk sequence');
    const blob = rawBody instanceof Blob ? rawBody : new Blob([rawBody ?? '']);
    return tx(async (db) => {
      const r = db.recordings.find((x) => x.id === Number(m[1]));
      if (!r) throw new HttpError(404, 'Recording not found');
      if (!['recording', 'interrupted'].includes(r.status)) throw new HttpError(409, 'Recording is already finalised');
      if (seq < r.next_seq) return { ok: true, duplicate: true, next: r.next_seq };
      if (seq > r.next_seq) throw new HttpError(409, 'Out-of-order chunk', { expected: r.next_seq });
      try { await idb.putChunk({ recId: r.id, seq, blob }); }
      catch { throw new HttpError(507, 'Not enough storage on this device to keep recording.'); }
      r.next_seq = seq + 1; r.size += blob.size; r.last_chunk_at = Date.now();
      return { ok: true, next: seq + 1 };
    });
  });
  route('POST', '/api/recordings/(\\d+)/finish', true, async ({ m, body }) => {
    const b = json(body);
    const rec = await tx(async (db) => {
      const r = db.recordings.find((x) => x.id === Number(m[1]));
      if (!r) throw new HttpError(404, 'Recording not found');
      if (!['recording', 'interrupted'].includes(r.status)) return r;
      const parts = (await idb.chunks(r.id)).sort((a, b2) => a.seq - b2.seq);
      if (!parts.length) { r.status = 'failed'; r.note = 'No video data was received.'; return r; }
      const blob = new Blob(parts.map((c) => c.blob), { type: r.mime.split(';')[0] });
      await idb.putFile({ recId: r.id, blob });
      await idb.dropChunks(r.id);
      const names = Array.isArray(b.categoryNames) ? [...new Set(b.categoryNames.map(String).filter(Boolean))].slice(0, 20) : [];
      r.status = 'ready'; r.ended_at = nowIso(); r.size = blob.size;
      r.duration_ms = Math.max(r.duration_ms, Math.round(Number(b.durationMs) || 0));
      r.spins = Math.max(r.spins, Number(b.spins) || 0);
      if (names.length) r.category_names = names;
      r.note = b.recovered ? 'Recovered after the page was closed.' : null;
      return r;
    });
    broadcast({ type: 'changed' });
    broadcast({ type: 'recordings' });
    return publicRec(rec);
  });
  route('POST', '/api/recordings/(\\d+)/new-link', true, async ({ m }) => {
    const rec = await tx((db) => {
      const r = db.recordings.find((x) => x.id === Number(m[1]));
      if (!r) throw new HttpError(404, 'Recording not found');
      r.token = randomToken();
      return r;
    });
    broadcast({ type: 'recordings' });
    return publicRec(rec);
  });
  route('DELETE', '/api/recordings/(\\d+)', true, async ({ m }) => {
    const id = Number(m[1]);
    await tx((db) => {
      const r = db.recordings.find((x) => x.id === id);
      if (!r) throw new HttpError(404, 'Recording not found');
      if (r.status === 'recording' && Date.now() - r.last_chunk_at < 2 * 60 * 1000) throw new HttpError(409, 'Stop this recording before deleting it');
      db.recordings = db.recordings.filter((x) => x.id !== id);
    });
    await idb.dropFile(id).catch(() => {});
    await idb.dropChunks(id).catch(() => {});
    if (mediaUrls.has(id)) { URL.revokeObjectURL(mediaUrls.get(id)); mediaUrls.delete(id); }
    broadcast({ type: 'recordings' });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // fetch() interception for /api/*
  // ---------------------------------------------------------------------------
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const i = url.pathname.indexOf('/api/');
    if (url.origin !== location.origin || i === -1) return realFetch(input, init);
    const path = url.pathname.slice(i);
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers || {});
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    try {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = path.match(r.re);
        if (!m) continue;
        if (r.admin && !isAdmin(headers)) throw new HttpError(401, 'Admin login required');
        const body = typeof init.body === 'string' ? init.body : '';
        const out = await r.handler({ m, url, headers, body, rawBody: init.body });
        const status = out?._status || 200;
        if (out && '_status' in out) delete out._status;
        return reply(status, out);
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (e instanceof HttpError) return reply(e.status, { error: e.message, ...(e.extra || {}) });
      console.error(e);
      return reply(500, { error: 'Something went wrong on this device. Please try again.' });
    }
  };

  // First sign-in on a device sets its PIN — say so in the sign-in box.
  document.addEventListener('DOMContentLoaded', () => {
    const hint = document.querySelector('#loginModal .muted');
    if (hint && !ls.get(PIN_KEY)) hint.textContent = 'First time on this device: the PIN you enter now (4–12 digits) becomes the admin PIN. Remember it.';
  });
})();
