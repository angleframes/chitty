'use strict';
// Live draw recordings: chunked upload, MP4 processing (ffmpeg if available),
// secure token share links, Range streaming. Independent of the draw logic.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const STALE_MS = Number(process.env.REC_STALE_MS) || 2 * 60 * 1000; // no chunk for this long → recording treated as interrupted
const MAX_CHUNK = 64 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

function findBinary(name) {
  const candidates = [process.env[`${name.toUpperCase()}_PATH`], name, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`];
  for (const c of candidates) {
    if (!c) continue;
    try { if (spawnSync(c, ['-version'], { stdio: 'ignore' }).status === 0) return c; } catch {}
  }
  return null;
}

module.exports = function setupRecordings({ db, route, HttpError, send, broadcast, dataDir, istDate, nowIso, TZ }) {
  const DIR = path.join(dataDir, 'recordings');
  fs.mkdirSync(DIR, { recursive: true });
  const FFMPEG = findBinary('ffmpeg');
  const FFPROBE = findBinary('ffprobe');
  const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

  db.exec(`
    CREATE TABLE IF NOT EXISTS recordings (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      token          TEXT    NOT NULL UNIQUE,
      category_id    INTEGER,
      category_name  TEXT    NOT NULL,
      category_names TEXT,
      mode           TEXT    NOT NULL,
      mime           TEXT    NOT NULL,
      raw_ext        TEXT    NOT NULL,
      final_ext      TEXT,
      size           INTEGER NOT NULL DEFAULT 0,
      next_seq       INTEGER NOT NULL DEFAULT 0,
      duration_ms    INTEGER NOT NULL DEFAULT 0,
      spins          INTEGER NOT NULL DEFAULT 0,
      status         TEXT    NOT NULL,
      note           TEXT,
      started_at     TEXT    NOT NULL,
      ended_at       TEXT,
      date_ist       TEXT    NOT NULL,
      last_chunk_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recordings_date ON recordings(date_ist);
  `);

  const newToken = () => crypto.randomBytes(18).toString('base64url');
  const rawPath = (r) => path.join(DIR, `rec-${r.id}.raw.${r.raw_ext}`);
  const finalPath = (r) => (r.final_ext ? path.join(DIR, `rec-${r.id}.${r.final_ext}`) : null);
  const getRec = (id) => db.prepare('SELECT * FROM recordings WHERE id = ?').get(Number(id));
  const changed = () => broadcast({ type: 'recordings' });

  function servedFile(r) {
    const f = finalPath(r);
    if (f && fs.existsSync(f)) return { file: f, ext: r.final_ext, mime: r.final_ext === 'mp4' ? 'video/mp4' : r.mime.split(';')[0] };
    const raw = rawPath(r);
    if (fs.existsSync(raw)) return { file: raw, ext: r.raw_ext, mime: r.mime.split(';')[0] };
    return null;
  }

  function publicRec(r) {
    return {
      id: r.id,
      token: r.token,
      categoryId: r.category_id,
      categoryName: r.category_name,
      categoryNames: r.category_names ? JSON.parse(r.category_names) : [r.category_name],
      mode: r.mode,
      size: r.size,
      durationMs: r.duration_ms,
      spins: r.spins,
      status: r.status,
      note: r.note,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      dateIst: r.date_ist,
      ext: r.final_ext || r.raw_ext,
    };
  }

  function isLive(r) { return r.status === 'recording' && Date.now() - r.last_chunk_at < STALE_MS; }

  function active() {
    const r = db.prepare("SELECT * FROM recordings WHERE status = 'recording' ORDER BY id DESC LIMIT 1").get();
    return r && isLive(r) ? { id: r.id, startedAt: Date.parse(r.started_at), categoryName: r.category_name } : null;
  }

  // ---- Processing --------------------------------------------------------
  const processing = new Set();
  const again = new Map(); // id → status to re-process with once the current run ends
  function probeDuration(file) {
    if (!FFPROBE) return 0;
    try {
      const out = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
      const s = parseFloat(out.stdout);
      return Number.isFinite(s) ? Math.round(s * 1000) : 0;
    } catch { return 0; }
  }

  function processRecording(id, finalStatus) {
    const r = getRec(id);
    if (!r) return;
    if (processing.has(id)) { again.set(id, finalStatus); return; }
    const raw = rawPath(r);
    if (!fs.existsSync(raw) || fs.statSync(raw).size === 0) {
      db.prepare("UPDATE recordings SET status = 'failed', note = ? WHERE id = ?").run('No video data was received.', id);
      return changed();
    }
    if (!FFMPEG) {
      // No ffmpeg: serve the browser's original file.
      db.prepare('UPDATE recordings SET status = ?, size = ?, final_ext = NULL WHERE id = ?').run(finalStatus, fs.statSync(raw).size, id);
      return changed();
    }
    processing.add(id);
    const tmp = path.join(DIR, `rec-${id}.tmp.mp4`);
    const isMp4 = r.raw_ext === 'mp4';
    const args = ['-y', '-v', 'error', '-fflags', '+genpts', '-i', raw];
    // MP4 from the browser: keep H.264 video, normalise audio to AAC (Opus-in-MP4 does not play everywhere).
    if (isMp4) args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k');
    else args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k');
    args.push('-movflags', '+faststart', tmp);
    let stderr = '';
    const p = spawn(FFMPEG, args);
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => {
      processing.delete(id);
      const rerun = again.get(id);
      again.delete(id);
      const cur = getRec(id);
      if (!cur) { fs.rmSync(tmp, { force: true }); return; }
      if (code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
        const dest = path.join(DIR, `rec-${id}.mp4`);
        fs.renameSync(tmp, dest);
        const size = fs.statSync(dest).size;
        const dur = probeDuration(dest) || cur.duration_ms;
        db.prepare('UPDATE recordings SET status = ?, final_ext = ?, size = ?, duration_ms = ?, note = NULL WHERE id = ?')
          .run(finalStatus, 'mp4', size, dur, id);
        // Keep the raw upload only while it could still be resumed.
        if (finalStatus === 'ready' && !rerun) fs.rmSync(raw, { force: true });
      } else {
        fs.rmSync(tmp, { force: true });
        console.error(`Recording ${id} processing failed:`, stderr.slice(-500));
        db.prepare('UPDATE recordings SET status = ?, size = ?, note = ? WHERE id = ?')
          .run(finalStatus, fs.statSync(raw).size, 'Saved in original browser format (conversion to MP4 failed).', id);
      }
      if (rerun) { db.prepare("UPDATE recordings SET status = 'processing' WHERE id = ?").run(id); processRecording(id, rerun); }
      changed();
    });
  }

  // Interrupted sessions (tab closed, crash): keep what was uploaded and make it playable.
  function sweep() {
    const stale = db.prepare("SELECT * FROM recordings WHERE status = 'recording' AND last_chunk_at < ?").all(Date.now() - STALE_MS);
    for (const r of stale) {
      db.prepare("UPDATE recordings SET status = 'processing', ended_at = ?, note = ? WHERE id = ?")
        .run(new Date(r.last_chunk_at).toISOString(), 'Recording was interrupted; the uploaded part was saved.', r.id);
      processRecording(r.id, 'interrupted');
    }
    for (const r of db.prepare("SELECT id FROM recordings WHERE status = 'processing'").all()) {
      if (!processing.has(r.id)) processRecording(r.id, getRec(r.id).note?.includes('interrupted') ? 'interrupted' : 'ready');
    }
    if (stale.length) changed();
  }
  setInterval(sweep, 30000).unref();
  setTimeout(sweep, 1000).unref();

  // ---- Raw body ----------------------------------------------------------
  function readRaw(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new HttpError(413, 'Chunk too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  async function readJsonBody(req) {
    const b = await readRaw(req, 1e6);
    if (!b.length) return {};
    try { return JSON.parse(b.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
  }

  // ---- Admin API ---------------------------------------------------------
  route('GET', '/api/recordings', true, (req, res) => {
    const rows = db.prepare('SELECT * FROM recordings ORDER BY id DESC').all();
    send(res, 200, { recordings: rows.map(publicRec), publicUrl: PUBLIC_URL || null, mp4: !!FFMPEG });
  });

  route('POST', '/api/recordings', true, async (req, res) => {
    const body = await readJsonBody(req);
    const mime = String(body.mime || '').slice(0, 100);
    if (!/^video\/(webm|mp4|x-matroska)/.test(mime)) throw new HttpError(400, 'Unsupported recording format');
    const mode = body.mode === 'screen' ? 'screen' : 'studio';
    const live = db.prepare("SELECT * FROM recordings WHERE status = 'recording'").all().filter(isLive);
    if (live.length && !body.force) throw new HttpError(409, 'Another recording is already in progress.');
    for (const r of live) {
      db.prepare("UPDATE recordings SET status = 'processing', ended_at = ?, note = ? WHERE id = ?")
        .run(nowIso(), 'Recording was interrupted; the uploaded part was saved.', r.id);
      processRecording(r.id, 'interrupted');
    }
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(body.categoryId));
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const now = new Date();
    const r = db.prepare(`INSERT INTO recordings (token, category_id, category_name, mode, mime, raw_ext, status, started_at, date_ist, last_chunk_at)
                          VALUES (?, ?, ?, ?, ?, ?, 'recording', ?, ?, ?)`)
      .run(newToken(), cat?.id ?? null, cat?.name ?? 'Live draw', mode, mime, ext, now.toISOString(), istDate(now), Date.now());
    const rec = getRec(r.lastInsertRowid);
    fs.writeFileSync(rawPath(rec), Buffer.alloc(0));
    broadcast({ type: 'changed' });
    changed();
    send(res, 201, publicRec(rec));
  });

  route('PUT', '/api/recordings/(\\d+)/chunk', true, async (req, res, m, url) => {
    const seq = Number(url.searchParams.get('seq'));
    if (!Number.isInteger(seq) || seq < 0) throw new HttpError(400, 'Invalid chunk sequence');
    const data = await readRaw(req, MAX_CHUNK);
    const r = getRec(m[1]);
    if (!r) throw new HttpError(404, 'Recording not found');
    const resumable = ['recording', 'interrupted'].includes(r.status) || (r.status === 'processing' && r.note?.includes('interrupted'));
    if (!resumable || !fs.existsSync(rawPath(r))) throw new HttpError(409, 'Recording is already finalised');
    if (seq < r.next_seq) return send(res, 200, { ok: true, duplicate: true, next: r.next_seq });
    if (seq > r.next_seq) return send(res, 409, { error: 'Out-of-order chunk', expected: r.next_seq });
    fs.appendFileSync(rawPath(r), data);
    db.prepare('UPDATE recordings SET next_seq = ?, size = size + ?, last_chunk_at = ? WHERE id = ?')
      .run(seq + 1, data.length, Date.now(), r.id);
    send(res, 200, { ok: true, next: seq + 1 });
  });

  route('POST', '/api/recordings/(\\d+)/finish', true, async (req, res, m) => {
    const body = await readJsonBody(req);
    const r = getRec(m[1]);
    if (!r) throw new HttpError(404, 'Recording not found');
    const resumable = ['recording', 'interrupted'].includes(r.status) || (r.status === 'processing' && r.note?.includes('interrupted'));
    if (!resumable) return send(res, 200, publicRec(r));
    const names = Array.isArray(body.categoryNames) ? body.categoryNames.map(String).filter(Boolean).slice(0, 20) : [];
    const dur = Math.max(0, Math.round(Number(body.durationMs) || 0));
    db.prepare(`UPDATE recordings SET status = 'processing', ended_at = ?, duration_ms = MAX(duration_ms, ?),
                spins = MAX(spins, ?), category_names = COALESCE(?, category_names), note = ? WHERE id = ?`)
      .run(nowIso(), dur, Math.max(0, Number(body.spins) || 0), names.length ? JSON.stringify([...new Set(names)]) : null,
        body.recovered ? 'Recovered after the page was closed.' : null, r.id);
    processRecording(r.id, 'ready');
    broadcast({ type: 'changed' });
    changed();
    send(res, 200, publicRec(getRec(r.id)));
  });

  route('POST', '/api/recordings/(\\d+)/new-link', true, (req, res, m) => {
    const r = getRec(m[1]);
    if (!r) throw new HttpError(404, 'Recording not found');
    db.prepare('UPDATE recordings SET token = ? WHERE id = ?').run(newToken(), r.id);
    changed();
    send(res, 200, publicRec(getRec(r.id)));
  });

  route('DELETE', '/api/recordings/(\\d+)', true, (req, res, m) => {
    const r = getRec(m[1]);
    if (!r) throw new HttpError(404, 'Recording not found');
    if (isLive(r)) throw new HttpError(409, 'Stop this recording before deleting it');
    if (processing.has(r.id)) throw new HttpError(409, 'This recording is still being processed');
    for (const f of [rawPath(r), finalPath(r)]) if (f) fs.rmSync(f, { force: true });
    db.prepare('DELETE FROM recordings WHERE id = ?').run(r.id);
    changed();
    send(res, 200, { ok: true });
  });

  // ---- Public (token) access --------------------------------------------
  const fmtDate = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
  const fmtTime = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDur = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const fileName = (r, ext) => `AngleFrames-Chitty_${r.category_name.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')}_${r.date_ist}_${r.id}.${ext}`;

  function streamMedia(req, res, r) {
    const f = servedFile(r);
    if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Recording not available'); }
    const size = fs.statSync(f.file).size;
    const url = new URL(req.url, 'http://x');
    const headers = {
      'Content-Type': f.mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=0',
      'X-Robots-Tag': 'noindex',
    };
    if (url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="${fileName(r, f.ext)}"`;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && size > 0) {
      let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
      let end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (!(start >= 0 && start <= end)) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(f.file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(f.file).pipe(res);
  }

  function sharePage(res, r) {
    const ready = ['ready', 'interrupted'].includes(r.status);
    const d = new Date(r.started_at);
    const cats = r.category_names ? JSON.parse(r.category_names).join(', ') : r.category_name;
    const ext = r.final_ext || r.raw_ext;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(cats)} · Live draw recording · ANGLE FRAMES CHITTY</title>
<meta property="og:title" content="ANGLE FRAMES CHITTY — Live draw recording">
<meta property="og:description" content="${esc(cats)} · ${esc(fmtDate.format(d))}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0a0a0a;color:#fff;font-family:Poppins,system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center}
header{width:100%;display:flex;align-items:center;justify-content:center;gap:14px;padding:22px 16px;border-bottom:1px solid rgba(255,255,255,.07)}
header img{height:40px}header .d{width:1px;height:28px;background:rgba(255,255,255,.13)}header b{font-size:13px;letter-spacing:.28em}header small{display:block;color:#a2a2a2;font-size:11px;letter-spacing:.08em}
main{width:min(960px,100%);padding:28px 16px 40px}
.eyebrow{display:inline-flex;align-items:center;gap:10px;font-size:11px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:#a2a2a2}.eyebrow i{width:22px;height:4px;background:#b3141b}
h1{font-size:clamp(24px,4vw,34px);margin:10px 0 4px}p.meta{color:#a2a2a2;margin:0 0 20px;font-size:13px}
video{width:100%;border-radius:14px;background:#000;border:1px solid rgba(255,255,255,.07)}
.actions{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
a.btn{display:inline-flex;align-items:center;height:42px;padding:0 20px;border-radius:999px;text-decoration:none;font-weight:600;font-size:14px}
a.primary{background:#fff;color:#0a0a0a}a.red{background:#b3141b;color:#fff}
.wait{padding:60px 20px;text-align:center;border:1px solid rgba(255,255,255,.07);border-radius:14px;color:#a2a2a2}
footer{color:#6b6b6b;font-size:11.5px;padding:0 16px 30px;text-align:center}
</style></head><body>
<header><img src="/logo.png" alt="Angle Frames"><span class="d"></span><div><b>CHITTY</b><small>Live draw recording</small></div></header>
<main>
<span class="eyebrow"><i></i>Official draw recording</span>
<h1>${esc(cats)}</h1>
<p class="meta">${esc(fmtDate.format(d))} · ${esc(fmtTime.format(d))} IST${r.duration_ms ? ` · ${fmtDur(r.duration_ms)}` : ''}${r.spins ? ` · ${r.spins} draw${r.spins === 1 ? '' : 's'}` : ''}</p>
${ready
    ? `<video controls playsinline preload="metadata" src="/media/${r.token}.${ext}"></video>
<div class="actions"><a class="btn primary" href="/media/${r.token}.${ext}?download=1">Download video</a></div>`
    : `<div class="wait">This recording is still being prepared. Please refresh in a minute.</div>`}
</main>
<footer>Winners are selected server-side with a secure random generator. Every draw is recorded permanently.</footer>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
    res.end(html);
  }

  // Returns true when the request was handled.
  function handlePublic(req, res, pathname) {
    let m = /^\/media\/([A-Za-z0-9_-]+)(?:\.(mp4|webm))?$/.exec(pathname);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) {
      const r = TOKEN_RE.test(m[1]) && db.prepare('SELECT * FROM recordings WHERE token = ?').get(m[1]);
      if (!r || r.status === 'recording' || r.status === 'processing') { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return true; }
      streamMedia(req, res, r);
      return true;
    }
    m = /^\/r\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (m && req.method === 'GET') {
      const r = TOKEN_RE.test(m[1]) && db.prepare('SELECT * FROM recordings WHERE token = ?').get(m[1]);
      if (!r) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta name="viewport" content="width=device-width"><body style="background:#0a0a0a;color:#a2a2a2;font-family:system-ui;display:grid;place-items:center;min-height:90vh">This recording link is invalid or has been revoked.</body>'); return true; }
      sharePage(res, r);
      return true;
    }
    return false;
  }

  return { active, handlePublic, mp4: !!FFMPEG };
};
