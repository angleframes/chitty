/**
 * ANGLE FRAMES CHITTY — live draw backend that lives inside the Google Sheet (Google Apps Script).
 *
 * The sheet is the only source of truth:
 *   Sheet1 (no header row)
 *     ₹1,000 chitty → column A = name, column B = status ("WINNER" or blank)
 *     ₹3,000 chitty → column C = name, column D = status ("WINNER" or blank)
 *   Each row is its own slot. The two chitties are independent.
 *   "Draw Log" tab (created automatically) = permanent history of draws made by this script.
 *
 * Flow per draw: admin session check → script lock → fresh read of Sheet1 → validate rows →
 * eligible = blank status and not already in the Draw Log → crypto-secure pick →
 * write "WINNER" into the status cell + append to Draw Log (both inside the lock) → return winner.
 *
 * Setup (once): Extensions → Apps Script → paste this file → Deploy → New deployment →
 * Web app, Execute as: Me, Who has access: Anyone → copy the /exec URL.
 * Then in the sheet: menu "Chitty draw" → "Set admin PIN".
 */

var CONFIG = {
  participantsTab: 'Sheet1',
  logTab: 'Draw Log',
  headerRows: 0,
  categories: {
    '1000': { label: '₹1,000 Chitty', amount: 1000, nameCol: 1, statusCol: 2 }, // A, B
    '3000': { label: '₹3,000 Chitty', amount: 3000, nameCol: 3, statusCol: 4 }, // C, D
  },
  winnerMark: 'WINNER',
  sessionSeconds: 6 * 60 * 60,
  maxPinFailures: 5,
  pinLockSeconds: 10 * 60,
};

var LOG_HEADER = ['Draw ID', 'Request ID', 'Drawn at (IST, ISO 8601)', 'Chitty', 'Participant', 'Name cell', 'Status cell',
  'Eligible in pool', 'Pool SHA-256', 'Admin', 'Sheet write'];

// ---------------------------------------------------------------------------
// Sheet menu: admin PIN setup
// ---------------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Chitty draw')
    .addItem('Set admin PIN', 'setAdminPin')
    .addItem('Show draw log', 'showLog')
    .addToUi();
}

function setAdminPin() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Admin PIN for the live draw', 'Enter a new PIN of 6–12 digits. Admins type this in the chitty app to run draws.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var pin = String(r.getResponseText() || '').trim();
  if (!/^\d{6,12}$/.test(pin)) { ui.alert('The PIN must be 6–12 digits. Nothing was changed.'); return; }
  var salt = Utilities.getUuid();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('PIN_SALT', salt);
  props.setProperty('PIN_HASH', sha256Hex_(salt + ':' + pin));
  props.setProperty('SESSION_EPOCH', Utilities.getUuid()); // signs out every existing session
  ui.alert('Admin PIN saved. Existing admin sessions were signed out.');
}

function showLog() {
  SpreadsheetApp.getActive().setActiveSheet(logSheet_());
}

// ---------------------------------------------------------------------------
// Web app entry point (POST, JSON in a text/plain body to avoid CORS preflight)
// ---------------------------------------------------------------------------
function doPost(e) {
  var out;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = String(body.action || '');
    if (action === 'ping') out = { ok: true };
    else if (action === 'login') out = login_(String(body.pin || ''));
    else {
      requireSession_(String(body.token || ''));
      if (action === 'logout') out = logout_(String(body.token || ''));
      else if (action === 'pool') out = pool_();
      else if (action === 'history') out = { draws: history_() };
      else if (action === 'draw') out = draw_(String(body.category || ''), String(body.requestId || ''), String(body.admin || 'Admin'));
      else throw httpError_(400, 'Unknown action.');
    }
  } catch (err) {
    out = { error: err && err.publicMessage ? err.publicMessage : 'Something went wrong. No draw was made.', status: (err && err.status) || 500 };
    if (!(err && err.publicMessage)) console.error(err);
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, service: 'ANGLE FRAMES CHITTY draw' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function httpError_(status, message) { var e = new Error(message); e.status = status; e.publicMessage = message; return e; }

function login_(pin) {
  var props = PropertiesService.getScriptProperties();
  var cache = CacheService.getScriptCache();
  if (!props.getProperty('PIN_HASH')) throw httpError_(503, 'The admin PIN has not been set yet. In the sheet, use menu Chitty draw → Set admin PIN.');
  if (cache.get('pin_locked')) throw httpError_(429, 'Too many wrong PINs. Try again in 10 minutes.');
  var ok = /^\d{6,12}$/.test(pin) && sha256Hex_(props.getProperty('PIN_SALT') + ':' + pin) === props.getProperty('PIN_HASH');
  if (!ok) {
    var fails = Number(cache.get('pin_fails') || 0) + 1;
    cache.put('pin_fails', String(fails), CONFIG.pinLockSeconds);
    if (fails >= CONFIG.maxPinFailures) cache.put('pin_locked', '1', CONFIG.pinLockSeconds);
    throw httpError_(401, 'Incorrect admin PIN.');
  }
  cache.remove('pin_fails');
  var token = Utilities.getUuid() + Utilities.getUuid();
  cache.put('sess:' + token, props.getProperty('SESSION_EPOCH') || '-', CONFIG.sessionSeconds);
  return { token: token, expiresIn: CONFIG.sessionSeconds };
}

function requireSession_(token) {
  if (!/^[0-9a-f-]{72}$/.test(token)) throw httpError_(401, 'Admin sign-in required.');
  var v = CacheService.getScriptCache().get('sess:' + token);
  if (!v || v !== (PropertiesService.getScriptProperties().getProperty('SESSION_EPOCH') || '-')) {
    throw httpError_(401, 'Your admin session has expired. Sign in again.');
  }
}

function logout_(token) { CacheService.getScriptCache().remove('sess:' + token); return { ok: true }; }

// ---------------------------------------------------------------------------
// Sheet reading and eligibility
// ---------------------------------------------------------------------------
function participantsSheet_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.participantsTab);
  if (!sh) throw httpError_(503, 'The participants tab "' + CONFIG.participantsTab + '" was not found.');
  return sh;
}

function logSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CONFIG.logTab);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.logTab);
    sh.appendRow(LOG_HEADER);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, LOG_HEADER.length).setFontWeight('bold');
    sh.getRange('A:K').setNumberFormat('@'); // keep IDs and timestamps as plain text
    sh.protect().setDescription('Chitty draw history — written by the draw script').setWarningOnly(true);
  }
  return sh;
}

function colLetter_(n) { return String.fromCharCode(64 + n); }
function clean_(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
function validName_(n) { return n.length > 0 && n.length <= 80 && /[A-Za-zÀ-￿]/.test(n); }

function readLog_() {
  var sh = logSheet_();
  var n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, LOG_HEADER.length).getValues().map(function (r) {
    return { drawId: r[0], requestId: r[1], drawnAt: r[2] instanceof Date ? r[2].toISOString() : String(r[2]), category: String(r[3]),
      name: String(r[4]), nameCell: String(r[5]), statusCell: String(r[6]), eligibleCount: Number(r[7]), poolSha256: String(r[8]),
      admin: String(r[9]), sheetWrite: String(r[10]) };
  });
}

/** Builds one category's pool from a fresh read. Winners = "WINNER" in the sheet or recorded in the Draw Log. */
function buildPool_(values, key, log) {
  var cfg = CONFIG.categories[key];
  var recorded = {};
  log.forEach(function (d) { if (d.category === key) recorded[d.nameCell + '|' + d.name.toLowerCase()] = true; });
  var pool = { key: key, label: cfg.label, amount: cfg.amount, total: 0, eligible: [], winners: [], flags: [], duplicateNames: [] };
  var seen = {};
  values.forEach(function (row, i) {
    var r = i + 1;
    if (r <= CONFIG.headerRows) return;
    var name = clean_(row[cfg.nameCol - 1]);
    var status = clean_(row[cfg.statusCol - 1]);
    var nameCell = colLetter_(cfg.nameCol) + r;
    var statusCell = colLetter_(cfg.statusCol) + r;
    if (!name) { if (status) pool.flags.push({ cell: statusCell, issue: 'Status "' + status + '" has no name next to it' }); return; }
    if (!validName_(name)) { pool.flags.push({ cell: nameCell, issue: 'Not a valid participant name' }); return; }
    var slot = { row: r, cell: nameCell, statusCell: statusCell, name: name };
    pool.total++;
    var k = name.toLowerCase();
    (seen[k] = seen[k] || []).push(nameCell);
    if (status.toUpperCase() === CONFIG.winnerMark) pool.winners.push(slot);
    else if (status) pool.flags.push({ cell: statusCell, issue: 'Unrecognised status "' + status + '" — left out of the draw' });
    else if (recorded[nameCell + '|' + k]) pool.winners.push(slot);
    else pool.eligible.push(slot);
  });
  Object.keys(seen).forEach(function (k) { if (seen[k].length > 1) pool.duplicateNames.push({ name: k, cells: seen[k] }); });
  return pool;
}

function readValues_() {
  var sh = participantsSheet_();
  var last = sh.getLastRow();
  if (last < 1) return [];
  return sh.getRange(1, 1, last, 4).getDisplayValues();
}

function view_(p) {
  return { key: p.key, label: p.label, amount: p.amount, total: p.total, eligibleCount: p.eligible.length,
    winnersCount: p.winners.length, eligible: p.eligible, winners: p.winners, flags: p.flags, duplicateNames: p.duplicateNames };
}

function pool_() {
  var values = readValues_();
  var log = readLog_();
  return { fetchedAt: new Date().toISOString(), categories: Object.keys(CONFIG.categories).map(function (k) { return view_(buildPool_(values, k, log)); }) };
}

function history_() { return readLog_().reverse(); }

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------
/** Unbiased integer in [0, n) from Java SecureRandom (UUID v4 random bits), with rejection sampling. */
function secureIndex_(n) {
  if (!(n > 0)) throw httpError_(409, 'No eligible participants left.');
  var limit = Math.floor(4294967296 / n) * n;
  for (;;) {
    var x = parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16); // first 32 bits are fully random in v4
    if (x < limit) return x % n;
  }
}

function sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function draw_(key, requestId, admin) {
  var cfg = CONFIG.categories[key];
  if (!cfg) throw httpError_(400, 'Choose the ₹1,000 or ₹3,000 chitty.');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) throw httpError_(400, 'Missing draw request id.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw httpError_(409, 'Another draw is in progress. Wait for it to finish.');
  try {
    var log = readLog_();
    var prior = log.filter(function (d) { return d.requestId === requestId; })[0];
    if (prior) return { replay: true, draw: prior, pool: null, winnerIndex: null }; // retried request: same result

    // Fresh read right before the draw, inside the lock.
    var values = readValues_();
    var pool = buildPool_(values, key, log);
    if (!pool.eligible.length) throw httpError_(409, 'No eligible participants left in the ' + cfg.label + '.');

    var index = secureIndex_(pool.eligible.length);
    var winner = pool.eligible[index];
    var poolSha = sha256Hex_(pool.eligible.map(function (s) { return s.cell + '\t' + s.name; }).join('\n'));

    // Re-check the exact cells, then write WINNER and the log entry together.
    var sh = participantsSheet_();
    var rowVals = sh.getRange(winner.row, cfg.nameCol, 1, 2).getDisplayValues()[0];
    if (clean_(rowVals[0]) !== winner.name || clean_(rowVals[1])) {
      throw httpError_(409, 'The sheet changed during the draw. No winner was recorded — please draw again.');
    }
    sh.getRange(winner.row, cfg.statusCol).setValue(CONFIG.winnerMark);
    var drawnAt = Utilities.formatDate(new Date(), 'Asia/Kolkata', "yyyy-MM-dd'T'HH:mm:ss'+05:30'");
    var draw = { drawId: Utilities.getUuid(), requestId: requestId, drawnAt: drawnAt, category: key,
      name: winner.name, nameCell: winner.cell, statusCell: winner.statusCell, eligibleCount: pool.eligible.length,
      poolSha256: poolSha, admin: admin.slice(0, 60), sheetWrite: 'written' };
    logSheet_().appendRow([draw.drawId, draw.requestId, draw.drawnAt,
      key, draw.name, draw.nameCell, draw.statusCell, draw.eligibleCount, draw.poolSha256, draw.admin, draw.sheetWrite]);
    SpreadsheetApp.flush();
    return { draw: draw, pool: pool.eligible, winnerIndex: index };
  } finally {
    lock.releaseLock();
  }
}
