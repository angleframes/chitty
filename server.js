'use strict';
// ANGLE FRAMES CHITTY — Live Chitty Draw Management System
// Zero-dependency Node.js server: HTTP + SQLite (node:sqlite) + Server-Sent Events.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TZ = 'Asia/Kolkata';
const SPIN_MIN_MS = 9000;
const SPIN_MAX_MS = 11000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Admin PIN
// ---------------------------------------------------------------------------
function loadAdminPin() {
  if (process.env.ADMIN_PIN) return String(process.env.ADMIN_PIN);
  const file = path.join(DATA_DIR, 'admin-pin.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const pin = String(crypto.randomInt(100000, 1000000));
  fs.writeFileSync(file, pin + '\n', { mode: 0o600 });
  return pin;
}
const ADMIN_PIN = loadAdminPin();

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new DatabaseSync(path.join(DATA_DIR, 'chitty.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS categories (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    amount         INTEGER NOT NULL,
    current_cycle  INTEGER NOT NULL DEFAULT 1,
    wheel_rotation REAL    NOT NULL DEFAULT 0,
    archived       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS participants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uid         TEXT    NOT NULL UNIQUE,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    name        TEXT    NOT NULL,
    phone       TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_participants_cat ON participants(category_id, active);

  CREATE TABLE IF NOT EXISTS cycles (
    category_id INTEGER NOT NULL REFERENCES categories(id),
    cycle       INTEGER NOT NULL,
    started_at  TEXT    NOT NULL,
    PRIMARY KEY (category_id, cycle)
  );

  CREATE TABLE IF NOT EXISTS winners (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id      INTEGER NOT NULL REFERENCES categories(id),
    cycle            INTEGER NOT NULL,
    participant_id   INTEGER NOT NULL REFERENCES participants(id),
    participant_uid  TEXT    NOT NULL,
    participant_name TEXT    NOT NULL,
    category_name    TEXT    NOT NULL,
    amount           INTEGER NOT NULL,
    draw_number      INTEGER NOT NULL,
    drawn_at         TEXT    NOT NULL,
    draw_date_ist    TEXT    NOT NULL,
    started_at_ms    INTEGER NOT NULL,
    reveal_at_ms     INTEGER NOT NULL,
    duration_ms      INTEGER NOT NULL,
    start_rotation   REAL    NOT NULL,
    end_rotation     REAL    NOT NULL,
    winner_index     INTEGER NOT NULL,
    wheel_snapshot   TEXT    NOT NULL,
    UNIQUE (category_id, cycle, participant_id)
  );
  CREATE INDEX IF NOT EXISTS idx_winners_cat ON winners(category_id, cycle);
  CREATE INDEX IF NOT EXISTS idx_winners_day ON winners(draw_date_ist);
`);

// Archive metadata for closed draw cycles (added after first release).
{
  const cols = db.prepare('PRAGMA table_info(cycles)').all().map((c) => c.name);
  if (!cols.includes('ended_at')) db.exec('ALTER TABLE cycles ADD COLUMN ended_at TEXT');
  if (!cols.includes('end_reason')) db.exec('ALTER TABLE cycles ADD COLUMN end_reason TEXT');
}

const nowIso = () => new Date().toISOString();
const istDate = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

// Seed default categories on first run.
if (db.prepare('SELECT COUNT(*) c FROM categories').get().c === 0) {
  tx(() => {
    const ins = db.prepare('INSERT INTO categories (name, amount, created_at) VALUES (?, ?, ?)');
    const cyc = db.prepare('INSERT INTO cycles (category_id, cycle, started_at) VALUES (?, 1, ?)');
    for (const amt of [1000, 2000, 3000]) {
      const r = ins.run(`₹${amt.toLocaleString('en-IN')} Chitty`, amt, nowIso());
      cyc.run(r.lastInsertRowid, nowIso());
    }
  });
}

const q = {
  categories: db.prepare('SELECT * FROM categories WHERE archived = 0 ORDER BY amount, id'),
  category: db.prepare('SELECT * FROM categories WHERE id = ? AND archived = 0'),
  participants: db.prepare(`
    SELECT p.id, p.uid, p.name, p.phone, p.created_at,
           w.id AS win_id, w.drawn_at AS won_at, w.draw_number
    FROM participants p
    LEFT JOIN winners w
      ON w.participant_id = p.id AND w.category_id = p.category_id AND w.cycle = ? AND w.reveal_at_ms <= ?
    WHERE p.category_id = ? AND p.active = 1
    ORDER BY p.id`),
  // Eligible = active, and has not won in this cycle (including a win still being revealed).
  eligible: db.prepare(`
    SELECT p.id, p.uid, p.name FROM participants p
    WHERE p.category_id = ? AND p.active = 1
      AND NOT EXISTS (SELECT 1 FROM winners w
                      WHERE w.category_id = p.category_id AND w.cycle = ? AND w.participant_id = p.id)
    ORDER BY p.id`),
  cycleWinners: db.prepare(`
    SELECT * FROM winners WHERE category_id = ? AND cycle = ? AND reveal_at_ms <= ?
    ORDER BY id DESC`),
  // Today's winners: only from each category's active draw cycle (archived cycles stay out of the live display).
  todayWinners: db.prepare(`
    SELECT w.* FROM winners w JOIN categories c ON c.id = w.category_id
    WHERE w.draw_date_ist = ? AND w.reveal_at_ms <= ? AND w.cycle = c.current_cycle
    ORDER BY w.id DESC`),
  activeSpin: db.prepare(`
    SELECT * FROM winners WHERE category_id = ? AND reveal_at_ms > ? ORDER BY id DESC LIMIT 1`),
  anyActiveSpin: db.prepare('SELECT category_id FROM winners WHERE reveal_at_ms > ? LIMIT 1'),
  latestWinner: db.prepare(`
    SELECT * FROM winners WHERE category_id = ? AND cycle = ? AND reveal_at_ms <= ? ORDER BY id DESC LIMIT 1`),
  cycles: db.prepare(`
    SELECT c.cycle, c.started_at, c.ended_at, c.end_reason,
      (SELECT COUNT(*) FROM winners w WHERE w.category_id = c.category_id AND w.cycle = c.cycle AND w.reveal_at_ms <= ?) AS winners
    FROM cycles c WHERE c.category_id = ? ORDER BY c.cycle DESC`),
};

function publicWinner(w) {
  if (!w) return null;
  return {
    id: w.id,
    categoryId: w.category_id,
    cycle: w.cycle,
    participantId: w.participant_id,
    participantUid: w.participant_uid,
    name: w.participant_name,
    categoryName: w.category_name,
    amount: w.amount,
    drawNumber: w.draw_number,
    drawnAt: new Date(w.reveal_at_ms).toISOString(),
  };
}

function publicCategory(c) {
  return { id: c.id, name: c.name, amount: c.amount, cycle: c.current_cycle };
}

function buildState(categoryId) {
  const now = Date.now();
  const activeCounts = new Map(db.prepare(`
    SELECT w.category_id id, COUNT(*) n FROM winners w JOIN categories c ON c.id = w.category_id
    WHERE w.cycle = c.current_cycle AND w.reveal_at_ms <= ? GROUP BY w.category_id`).all(now).map((r) => [r.id, r.n]));
  const categories = q.categories.all().map((c) => ({ ...publicCategory(c), winners: activeCounts.get(c.id) || 0 }));
  const today = istDate();
  const state = {
    serverTime: now,
    today,
    categories,
    todayWinners: q.todayWinners.all(today, now).map(publicWinner),
    recording: recordings.active(),
    category: null,
  };
  const cat = q.category.get(Number(categoryId)) || q.category.get(categories[0]?.id ?? -1);
  if (!cat) return state;

  const participants = q.participants.all(cat.current_cycle, now, cat.id, ).map((p) => ({
    id: p.id, uid: p.uid, name: p.name, phone: p.phone, createdAt: p.created_at,
    won: !!p.win_id, wonAt: p.won_at, drawNumber: p.draw_number,
  }));
  const spinRow = q.activeSpin.get(cat.id, now);
  let wheel;
  let activeSpin = null;
  if (spinRow) {
    // During a spin every screen shows the wheel as it was when the spin started.
    wheel = JSON.parse(spinRow.wheel_snapshot);
    activeSpin = {
      id: spinRow.id,
      startedAt: spinRow.started_at_ms,
      revealAt: spinRow.reveal_at_ms,
      duration: spinRow.duration_ms,
      startRotation: spinRow.start_rotation,
      endRotation: spinRow.end_rotation,
      winnerIndex: spinRow.winner_index,
      winner: publicWinner(spinRow),
    };
  } else {
    wheel = q.eligible.all(cat.id, cat.current_cycle).map((p) => ({ id: p.id, uid: p.uid, name: p.name }));
  }
  state.category = {
    ...publicCategory(cat),
    rotation: cat.wheel_rotation,
    participants,
    totalParticipants: participants.length,
    eligibleCount: spinRow ? wheel.length - 1 : wheel.length,
    wheel,
    activeSpin,
    latestWinner: publicWinner(q.latestWinner.get(cat.id, cat.current_cycle, now)),
    cycleWinners: q.cycleWinners.all(cat.id, cat.current_cycle, now).map(publicWinner),
    cycles: q.cycles.all(now, cat.id),
  };
  return state;
}

// ---------------------------------------------------------------------------
// Real-time: Server-Sent Events
// ---------------------------------------------------------------------------
const clients = new Set();
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// ---------------------------------------------------------------------------
// Admin sessions
// ---------------------------------------------------------------------------
const sessions = new Map(); // token -> expiry
const loginAttempts = new Map(); // ip -> { count, until }

function isAdmin(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// Domain operations
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function requireCategory(id) {
  const cat = q.category.get(Number(id));
  if (!cat) throw new HttpError(404, 'Category not found');
  return cat;
}

function assertNotSpinning(categoryId) {
  if (q.activeSpin.get(categoryId, Date.now())) {
    throw new HttpError(409, 'A spin is in progress for this category. Please wait for it to finish.');
  }
}

function nextUid(categoryId) {
  // Unique, human-friendly participant IDs: AF-<category>-<sequence>
  const row = db.prepare('SELECT COUNT(*) c FROM participants WHERE category_id = ?').get(categoryId);
  let n = row.c + 1;
  const exists = db.prepare('SELECT 1 FROM participants WHERE uid = ?');
  let uid;
  do { uid = `AF${String(categoryId).padStart(2, '0')}-${String(n++).padStart(4, '0')}`; } while (exists.get(uid));
  return uid;
}

function createCategory({ name, amount }) {
  const amt = Math.round(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) throw new HttpError(400, 'Enter a valid amount greater than zero');
  const nm = cleanName(name) || `₹${amt.toLocaleString('en-IN')} Chitty`;
  if (nm.length > 60) throw new HttpError(400, 'Category name is too long (max 60 characters)');
  return tx(() => {
    const r = db.prepare('INSERT INTO categories (name, amount, created_at) VALUES (?, ?, ?)').run(nm, amt, nowIso());
    db.prepare('INSERT INTO cycles (category_id, cycle, started_at) VALUES (?, 1, ?)').run(r.lastInsertRowid, nowIso());
    return Number(r.lastInsertRowid);
  });
}

function updateCategory(id, { name, amount }) {
  const cat = requireCategory(id);
  const amt = amount === undefined ? cat.amount : Math.round(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) throw new HttpError(400, 'Enter a valid amount greater than zero');
  const nm = name === undefined ? cat.name : cleanName(name);
  if (!nm) throw new HttpError(400, 'Category name is required');
  if (nm.length > 60) throw new HttpError(400, 'Category name is too long (max 60 characters)');
  db.prepare('UPDATE categories SET name = ?, amount = ? WHERE id = ?').run(nm, amt, cat.id);
}

function archiveCategory(id) {
  const cat = requireCategory(id);
  assertNotSpinning(cat.id);
  // Archived, never deleted: winner history is preserved.
  db.prepare('UPDATE categories SET archived = 1 WHERE id = ?').run(cat.id);
}

function addParticipants(categoryId, rawNames) {
  const cat = requireCategory(categoryId);
  let names = Array.isArray(rawNames) ? rawNames : String(rawNames ?? '').split(/[\n,;]+/);
  names = names.map(cleanName).filter(Boolean);
  if (!names.length) throw new HttpError(400, 'Enter at least one participant name');
  if (names.some((n) => n.length > 60)) throw new HttpError(400, 'Participant names must be 60 characters or fewer');
  if (names.length > 1000) throw new HttpError(400, 'Add at most 1000 participants at a time');

  return tx(() => {
    const existing = new Set(
      db.prepare('SELECT name FROM participants WHERE category_id = ? AND active = 1').all(cat.id)
        .map((r) => r.name.toLowerCase()));
    const ins = db.prepare(`INSERT INTO participants (uid, category_id, name, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?)`);
    const added = [];
    const skipped = [];
    for (const n of names) {
      const key = n.toLowerCase();
      if (existing.has(key)) { skipped.push(n); continue; }
      existing.add(key);
      const uid = nextUid(cat.id);
      ins.run(uid, cat.id, n, nowIso(), nowIso());
      added.push({ uid, name: n });
    }
    return { added, skipped };
  });
}

function updateParticipant(id, { name }) {
  const p = db.prepare('SELECT * FROM participants WHERE id = ? AND active = 1').get(Number(id));
  if (!p) throw new HttpError(404, 'Participant not found');
  assertNotSpinning(p.category_id);
  const nm = cleanName(name);
  if (!nm) throw new HttpError(400, 'Participant name is required');
  if (nm.length > 60) throw new HttpError(400, 'Participant names must be 60 characters or fewer');
  const dup = db.prepare(`SELECT 1 FROM participants WHERE category_id = ? AND active = 1 AND id != ? AND lower(name) = lower(?)`)
    .get(p.category_id, p.id, nm);
  if (dup) throw new HttpError(409, `"${nm}" is already in this category`);
  db.prepare('UPDATE participants SET name = ?, updated_at = ? WHERE id = ?').run(nm, nowIso(), p.id);
  return p.category_id;
}

function removeParticipant(id) {
  const p = db.prepare('SELECT * FROM participants WHERE id = ? AND active = 1').get(Number(id));
  if (!p) throw new HttpError(404, 'Participant not found');
  assertNotSpinning(p.category_id);
  // Soft delete keeps winner records intact.
  db.prepare('UPDATE participants SET active = 0, updated_at = ? WHERE id = ?').run(nowIso(), p.id);
  return p.category_id;
}

function startNewCycle(categoryId) {
  const cat = requireCategory(categoryId);
  return tx(() => {
    if (q.activeSpin.get(cat.id, Date.now())) throw new HttpError(409, 'Wait for the current spin to finish');
    const next = cat.current_cycle + 1;
    db.prepare('UPDATE cycles SET ended_at = ?, end_reason = ? WHERE category_id = ? AND cycle = ?')
      .run(nowIso(), 'new-cycle', cat.id, cat.current_cycle);
    db.prepare('UPDATE categories SET current_cycle = ? WHERE id = ?').run(next, cat.id);
    db.prepare('INSERT INTO cycles (category_id, cycle, started_at) VALUES (?, ?, ?)').run(cat.id, next, nowIso());
    return next;
  });
}

/**
 * Fresh start: archive the active draw cycle and open a new, empty one.
 * scope 'category' → one category; 'all' → every active category. One transaction:
 * if any target is mid-spin nothing is reset. Participants, categories, winners
 * history and recordings are never deleted.
 */
function resetDraws(scope, categoryId) {
  return tx(() => {
    const now = Date.now();
    const targets = scope === 'all' ? q.categories.all() : [requireCategory(categoryId)];
    if (!targets.length) throw new HttpError(400, 'There are no chitty categories to reset');
    const busy = targets.filter((c) => q.activeSpin.get(c.id, now));
    if (busy.length) {
      throw new HttpError(409, `A spin is in progress in ${busy.map((c) => c.name).join(', ')}. Wait for it to finish, then reset.`);
    }
    const closeCycle = db.prepare('UPDATE cycles SET ended_at = ?, end_reason = ? WHERE category_id = ? AND cycle = ?');
    const openCycle = db.prepare('INSERT INTO cycles (category_id, cycle, started_at) VALUES (?, ?, ?)');
    const bump = db.prepare('UPDATE categories SET current_cycle = ?, wheel_rotation = 0 WHERE id = ?');
    const count = db.prepare('SELECT COUNT(*) c FROM winners WHERE category_id = ? AND cycle = ?');
    return targets.map((c) => {
      const next = c.current_cycle + 1;
      const archived = count.get(c.id, c.current_cycle).c;
      closeCycle.run(nowIso(), 'reset', c.id, c.current_cycle);
      bump.run(next, c.id);
      openCycle.run(c.id, next, nowIso());
      return { id: c.id, name: c.name, archivedCycle: c.current_cycle, archivedWinners: archived, cycle: next };
    });
  });
}

/**
 * Atomic, unbiased winner selection.
 * Runs inside BEGIN IMMEDIATE so concurrent requests (even from separate processes)
 * serialize; the UNIQUE(category_id, cycle, participant_id) constraint is a second guard.
 */
function spin(categoryId) {
  const TAU = Math.PI * 2;
  return tx(() => {
    const cat = requireCategory(categoryId);
    const now = Date.now();
    if (q.activeSpin.get(cat.id, now)) throw new HttpError(409, 'A spin is already in progress');

    const eligible = q.eligible.all(cat.id, cat.current_cycle);
    if (!eligible.length) throw new HttpError(409, 'No eligible participants left in this draw cycle');

    const winnerIndex = crypto.randomInt(eligible.length); // CSPRNG, uniform
    const winner = eligible[winnerIndex];
    const duration = crypto.randomInt(SPIN_MIN_MS, SPIN_MAX_MS + 1);
    const seg = TAU / eligible.length;
    // Land somewhere inside the winning segment, away from its edges.
    const offset = 0.2 + (crypto.randomInt(0, 10001) / 10000) * 0.6;
    // Pointer is at the top (-90°). Segment i spans [i*seg, (i+1)*seg] relative to wheel rotation.
    const target = -Math.PI / 2 - (winnerIndex + offset) * seg;
    const start = cat.wheel_rotation;
    const delta = (((target - start) % TAU) + TAU) % TAU;
    const turns = 7 + crypto.randomInt(0, 4);
    const end = start + turns * TAU + delta;

    const drawNumber = db.prepare('SELECT COUNT(*) c FROM winners WHERE category_id = ? AND cycle = ?')
      .get(cat.id, cat.current_cycle).c + 1;
    const revealAt = now + duration;
    const r = db.prepare(`
      INSERT INTO winners (category_id, cycle, participant_id, participant_uid, participant_name,
        category_name, amount, draw_number, drawn_at, draw_date_ist, started_at_ms, reveal_at_ms,
        duration_ms, start_rotation, end_rotation, winner_index, wheel_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      cat.id, cat.current_cycle, winner.id, winner.uid, winner.name, cat.name, cat.amount, drawNumber,
      new Date(revealAt).toISOString(), istDate(new Date(revealAt)), now, revealAt, duration,
      start, end, winnerIndex, JSON.stringify(eligible.map((p) => ({ id: p.id, uid: p.uid, name: p.name }))));
    db.prepare('UPDATE categories SET wheel_rotation = ? WHERE id = ?').run(end % TAU, cat.id);
    return { id: Number(r.lastInsertRowid), categoryId: cat.id, revealAt };
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// Tell every screen when a pending spin is revealed, so winner lists update everywhere.
function scheduleReveal(categoryId, revealAt) {
  setTimeout(() => broadcast({ type: 'revealed', categoryId }), Math.max(0, revealAt - Date.now()) + 50);
}

const routes = [];
const route = (method, pattern, admin, handler) =>
  routes.push({ method, re: new RegExp(`^${pattern}$`), admin, handler });

route('GET', '/api/state', false, (req, res, m, url) => send(res, 200, buildState(url.searchParams.get('category'))));

route('GET', '/api/session', false, (req, res) => send(res, 200, { admin: isAdmin(req) }));

route('POST', '/api/login', false, async (req, res) => {
  const ip = req.socket.remoteAddress;
  const a = loginAttempts.get(ip) || { count: 0, until: 0 };
  if (a.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a minute.');
  const { pin } = await readJson(req);
  if (!safeEqual(pin ?? '', ADMIN_PIN)) {
    a.count += 1;
    if (a.count >= 5) { a.until = Date.now() + 60000; a.count = 0; }
    loginAttempts.set(ip, a);
    throw new HttpError(401, 'Incorrect admin PIN');
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  send(res, 200, { token });
});

route('POST', '/api/logout', false, (req, res) => {
  const h = req.headers.authorization || '';
  sessions.delete(h.slice(7));
  send(res, 200, { ok: true });
});

route('POST', '/api/categories', true, async (req, res) => {
  const id = createCategory(await readJson(req));
  broadcast({ type: 'changed', categoryId: id });
  send(res, 201, { id });
});

route('PUT', '/api/categories/(\\d+)', true, async (req, res, m) => {
  updateCategory(m[1], await readJson(req));
  broadcast({ type: 'changed', categoryId: Number(m[1]) });
  send(res, 200, { ok: true });
});

route('DELETE', '/api/categories/(\\d+)', true, (req, res, m) => {
  archiveCategory(m[1]);
  broadcast({ type: 'changed', categoryId: Number(m[1]) });
  send(res, 200, { ok: true });
});

route('POST', '/api/categories/(\\d+)/participants', true, async (req, res, m) => {
  const body = await readJson(req);
  const result = addParticipants(m[1], body.names);
  broadcast({ type: 'changed', categoryId: Number(m[1]) });
  send(res, 201, result);
});

route('PUT', '/api/participants/(\\d+)', true, async (req, res, m) => {
  const catId = updateParticipant(m[1], await readJson(req));
  broadcast({ type: 'changed', categoryId: catId });
  send(res, 200, { ok: true });
});

route('DELETE', '/api/participants/(\\d+)', true, (req, res, m) => {
  const catId = removeParticipant(m[1]);
  broadcast({ type: 'changed', categoryId: catId });
  send(res, 200, { ok: true });
});

route('POST', '/api/categories/(\\d+)/new-cycle', true, (req, res, m) => {
  const cycle = startNewCycle(m[1]);
  broadcast({ type: 'changed', categoryId: Number(m[1]) });
  send(res, 200, { cycle });
});

route('POST', '/api/reset', true, async (req, res) => {
  const body = await readJson(req);
  if (body.confirm !== 'RESET') throw new HttpError(400, 'Type RESET to confirm');
  const scope = body.scope === 'all' ? 'all' : 'category';
  const result = resetDraws(scope, body.categoryId);
  broadcast({ type: 'reset', scope, categoryIds: result.map((r) => r.id) });
  send(res, 200, { scope, reset: result });
});

// Winners report for sharing (admin). Real DB data only: revealed winners, de-duplicated,
// grouped by category, ordered by draw number.
//   scope=today    → today's (IST) winners from each category's active cycle
//   scope=previous → all winners of the active cycle (default: one category)
//   scope=all      → all winners of every active cycle (current draw session)
//   scope=history  → one archived cycle of one category (&cycle=N)
route('GET', '/api/winners-report', true, (req, res, m, url) => {
  const scopes = ['today', 'previous', 'all', 'history'];
  const scope = scopes.includes(url.searchParams.get('scope')) ? url.searchParams.get('scope') : 'today';
  const catParam = url.searchParams.get('category') || 'all';
  const now = Date.now();
  const today = istDate();
  let cats = q.categories.all();
  if (catParam !== 'all') cats = cats.filter((c) => c.id === Number(catParam));
  if (catParam !== 'all' && !cats.length) throw new HttpError(404, 'Category not found');
  if (scope === 'history' && cats.length !== 1) throw new HttpError(400, 'Choose one chitty category to view its history');

  const winnersOf = db.prepare('SELECT * FROM winners WHERE category_id = ? AND cycle = ? AND reveal_at_ms <= ? ORDER BY draw_number, id');
  const cycleRows = db.prepare(`SELECT c.cycle, c.started_at, c.ended_at, c.end_reason,
      (SELECT COUNT(*) FROM winners w WHERE w.category_id = c.category_id AND w.cycle = c.cycle AND w.reveal_at_ms <= ?) AS winners
    FROM cycles c WHERE c.category_id = ? ORDER BY c.cycle DESC`);
  let cycles = null;
  const groups = cats.map((c) => {
    let cycle = c.current_cycle;
    if (scope === 'history') {
      cycles = cycleRows.all(now, c.id);
      const wanted = Number(url.searchParams.get('cycle'));
      const pick = cycles.find((x) => x.cycle === wanted) || cycles.find((x) => x.cycle !== c.current_cycle) || cycles[0];
      cycle = pick ? pick.cycle : c.current_cycle;
    }
    let rows = winnersOf.all(c.id, cycle, now);
    if (scope === 'today') rows = rows.filter((w) => w.draw_date_ist === today);
    const seen = new Set();
    rows = rows.filter((w) => (seen.has(w.participant_id) ? false : seen.add(w.participant_id)));
    const cyc = db.prepare('SELECT * FROM cycles WHERE category_id = ? AND cycle = ?').get(c.id, cycle);
    return {
      categoryId: c.id, name: c.name, amount: c.amount, cycle,
      archived: cycle !== c.current_cycle, endReason: cyc?.end_reason || null,
      winners: rows.map((w) => ({
        id: w.id, drawNumber: w.draw_number, name: w.participant_name, uid: w.participant_uid,
        drawnAt: new Date(w.reveal_at_ms).toISOString(), dateIst: w.draw_date_ist,
      })),
    };
  });
  const shown = cats.length === 1 ? groups : groups.filter((g) => g.winners.length);
  send(res, 200, {
    scope, category: catParam, today, generatedAt: new Date(now).toISOString(),
    total: shown.reduce((n, g) => n + g.winners.length, 0),
    groups: shown, cycles,
  });
});

// Archived results of one draw cycle (admin records).
route('GET', '/api/categories/(\\d+)/cycles/(\\d+)', true, (req, res, m) => {
  const rows = db.prepare('SELECT * FROM winners WHERE category_id = ? AND cycle = ? AND reveal_at_ms <= ? ORDER BY id')
    .all(Number(m[1]), Number(m[2]), Date.now());
  send(res, 200, { winners: rows.map(publicWinner) });
});

route('POST', '/api/categories/(\\d+)/spin', true, (req, res, m) => {
  const r = spin(m[1]);
  scheduleReveal(r.categoryId, r.revealAt);
  broadcast({ type: 'spin', categoryId: r.categoryId });
  send(res, 200, { ok: true, spinId: r.id });
});

route('GET', '/api/events', false, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 2000\ndata: ${JSON.stringify({ type: 'hello', serverTime: Date.now() })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Live draw recordings (separate module; does not touch draw logic).
const recordings = require('./recordings')({
  db, route, HttpError, send, broadcast, dataDir: DATA_DIR, istDate, nowIso, TZ,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        if (r.admin && !isAdmin(req)) throw new HttpError(401, 'Admin login required');
        return await r.handler(req, res, m, url);
      }
      throw new HttpError(404, 'Not found');
    }
    if (recordings.handlePublic(req, res, url.pathname)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    serveStatic(req, res, url.pathname);
  } catch (e) {
    let status = e.status || 500;
    let message = e.message;
    if (!e.status && /UNIQUE constraint/.test(String(e.message))) { status = 409; message = 'Duplicate winner prevented'; }
    if (status >= 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Server error' : message });
    else res.end();
  }
});

// Re-arm reveal broadcasts for spins that were in flight when the server restarted.
for (const w of db.prepare('SELECT category_id, reveal_at_ms FROM winners WHERE reveal_at_ms > ?').all(Date.now())) {
  scheduleReveal(w.category_id, w.reveal_at_ms);
}

server.listen(PORT, () => {
  console.log(`\n  ANGLE FRAMES CHITTY is running at http://localhost:${PORT}`);
  console.log(`  Recordings: ${recordings.mp4 ? 'MP4 (ffmpeg)' : 'browser format (install ffmpeg for MP4)'}`);
  console.log(`  Admin PIN: ${process.env.ADMIN_PIN ? '(from ADMIN_PIN env var)' : ADMIN_PIN + '  (stored in data/admin-pin.txt)'}\n`);
});
