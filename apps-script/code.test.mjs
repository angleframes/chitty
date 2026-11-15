// Tests for apps-script/Code.gs with in-memory stand-ins for Apps Script services.
// Run: node --test apps-script/code.test.mjs            (synthetic sheet)
//      SHEET_CSV=path/to/export.csv node --test ...      (also checks a real sheet export)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

const CODE = readFileSync(new URL('./Code.gs', import.meta.url), 'utf8');

function makeSheet(name, rows) {
  const data = rows.map((r) => [...r]);
  const width = () => Math.max(4, ...data.map((r) => r.length));
  const sheet = {
    name,
    getLastRow: () => data.length,
    getRange(a, b, c, d) {
      if (typeof a === 'string') return { setNumberFormat() {}, setFontWeight() {} };
      const row = a, col = b, nr = c ?? 1, nc = d ?? 1;
      const get = () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => data[row - 1 + i]?.[col - 1 + j] ?? ''));
      return {
        getValues: get,
        getDisplayValues: () => get().map((r) => r.map((v) => String(v ?? ''))),
        setValue(v) { while (data.length < row) data.push([]); data[row - 1][col - 1] = v; },
        setFontWeight() { return this; },
        setNumberFormat() { return this; },
      };
    },
    appendRow(r) { data.push([...r]); },
    setFrozenRows() {},
    protect: () => ({ setDescription() { return this; }, setWarningOnly() { return this; } }),
    data,
    width,
  };
  return sheet;
}

function load(rows, { pin = '482913' } = {}) {
  const sheets = { Sheet1: makeSheet('Sheet1', rows) };
  const props = {};
  const cache = new Map();
  let locked = false;
  const ctx = {
    console,
    SpreadsheetApp: {
      getActive: () => ({
        getSheetByName: (n) => sheets[n] || null,
        insertSheet: (n) => (sheets[n] = makeSheet(n, [])),
        setActiveSheet() {},
      }),
      flush() {},
      getUi: () => { throw new Error('no UI in tests'); },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => (locked ? false : (locked = true)), releaseLock: () => { locked = false; } }) },
    Utilities: {
      getUuid: () => randomUUID(),
      computeDigest: (_a, text) => [...createHash('sha256').update(text, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      formatDate: (d) => d.toISOString(),
    },
    ContentService: {
      createTextOutput: (s) => ({ text: s, setMimeType() { return this; } }),
      MimeType: { JSON: 'json' },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  // Same as the "Set admin PIN" menu, without the UI prompt.
  const salt = 'test-salt';
  props.PIN_SALT = salt;
  props.PIN_HASH = ctx.sha256Hex_(`${salt}:${pin}`);
  props.SESSION_EPOCH = 'epoch-1';
  const call = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { ctx, call, sheets, props, setLocked: (v) => { locked = v; } };
}

const rows = [
  ['Asha', '', 'Bala', 'WINNER'],
  ['Ravi', 'WINNER', 'Cyril', ''],
  ['Asha', '', '', ''],
  ['', '', 'Devi', ''],
  ['  Meena ', 'winner', 'Ravi', ''],
  ['1234', '', '', 'WINNER'],
  ['Nisha', 'PAID', 'Eli', ''],
];

const signIn = (call) => call({ action: 'login', pin: '482913' }).token;

test('wrong PIN is refused; locked after 5 failures', () => {
  const { call } = load(rows);
  for (let i = 0; i < 5; i++) assert.equal(call({ action: 'login', pin: '000000' }).status, 401);
  assert.equal(call({ action: 'login', pin: '482913' }).status, 429);
});

test('everything except ping/login needs a session', () => {
  const { call } = load(rows);
  assert.equal(call({ action: 'pool' }).status, 401);
  assert.equal(call({ action: 'draw', category: '1000', requestId: 'abcdefgh1' }).status, 401);
  assert.equal(call({ action: 'pool', token: 'f'.repeat(72) }).status, 401);
});

test('pools: categories separate, winners/empties/invalid excluded, duplicates kept as slots', () => {
  const { call } = load(rows);
  const token = signIn(call);
  const { categories } = call({ action: 'pool', token });
  const [k1, k3] = categories;
  assert.deepEqual(k1.eligible.map((s) => s.cell), ['A1', 'A3']);
  assert.deepEqual(k1.winners.map((s) => s.name), ['Ravi', 'Meena']);
  assert.deepEqual(k1.flags.map((f) => f.cell).sort(), ['A6', 'B7']);
  assert.deepEqual(k3.eligible.map((s) => s.name), ['Cyril', 'Devi', 'Ravi', 'Eli']);
  assert.deepEqual(k3.flags.map((f) => f.cell), ['D6']);
});

test('draw writes WINNER + log once; winner never drawn again; replay is idempotent', () => {
  const { call, sheets } = load(rows);
  const token = signIn(call);
  const r1 = call({ action: 'draw', category: '1000', requestId: 'req-000001', token, admin: 'Test' });
  assert.ok(['Asha'].includes(r1.draw.name));
  const [row] = [Number(r1.draw.nameCell.slice(1))];
  assert.equal(sheets.Sheet1.data[row - 1][1], 'WINNER');
  assert.equal(sheets['Draw Log'].data.length, 2);
  const again = call({ action: 'draw', category: '1000', requestId: 'req-000001', token });
  assert.equal(again.replay, true);
  assert.equal(again.draw.drawId, r1.draw.drawId);
  assert.equal(sheets['Draw Log'].data.length, 2);
  const r2 = call({ action: 'draw', category: '1000', requestId: 'req-000002', token });
  assert.notEqual(r2.draw.nameCell, r1.draw.nameCell);
  assert.equal(call({ action: 'draw', category: '1000', requestId: 'req-000003', token }).status, 409); // pool empty
  assert.equal(call({ action: 'pool', token }).categories[1].eligibleCount, 4); // ₹3,000 untouched
});

test('a winner stays excluded even if WINNER is removed from the sheet by hand', () => {
  const { call, sheets } = load(rows);
  const token = signIn(call);
  const r = call({ action: 'draw', category: '1000', requestId: 'req-x00001', token });
  sheets.Sheet1.data[Number(r.draw.nameCell.slice(1)) - 1][1] = '';
  const p = call({ action: 'pool', token }).categories[0];
  assert.ok(!p.eligible.some((s) => s.cell === r.draw.nameCell));
});

test('concurrent draw is refused while another holds the lock', () => {
  const { call, setLocked } = load(rows);
  const token = signIn(call);
  setLocked(true);
  assert.equal(call({ action: 'draw', category: '3000', requestId: 'req-lock01', token }).status, 409);
});

test('secure index is unbiased', () => {
  const { ctx } = load(rows);
  const counts = [0, 0, 0];
  for (let i = 0; i < 30000; i++) counts[ctx.secureIndex_(3)]++;
  for (const c of counts) assert.ok(c > 9300 && c < 10700, `uneven ${counts}`);
});

test('real sheet export (optional)', { skip: !process.env.SHEET_CSV }, () => {
  const csv = readFileSync(process.env.SHEET_CSV, 'utf8').trim().split(/\r?\n/).map((l) => {
    const out = []; let cur = '', q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out;
  });
  const { call } = load(csv);
  const token = signIn(call);
  const [k1, k3] = call({ action: 'pool', token }).categories;
  console.log('₹1,000:', { total: k1.total, winners: k1.winnersCount, eligible: k1.eligibleCount, flags: k1.flags.length, dup: k1.duplicateNames.map((d) => d.cells.join('+')) });
  console.log('₹3,000:', { total: k3.total, winners: k3.winnersCount, eligible: k3.eligibleCount, flags: k3.flags.length });
  assert.equal(k1.total, k1.winnersCount + k1.eligibleCount + 0);
});
