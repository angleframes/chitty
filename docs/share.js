'use strict';
// ANGLE FRAMES CHITTY — winners report sharing (admin).
// Builds a branded report from /api/winners-report (real DB data), previews it, and exports it as
// WhatsApp text, copied text, PNG, PDF or a native share. WhatsApp opens with the message ready;
// the admin chooses the group and sends it themselves.
(() => {
  const A = window.AFC;
  if (!A) return;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const TZ = 'Asia/Kolkata';

  const fmtLong = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtShort = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
  const fmtTime = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true });
  const dayDate = (iso) => new Date(`${iso}T12:00:00+05:30`);

  const SCOPE_TITLE = {
    today: "Today's Winners",
    previous: 'Current Draw Cycle Winners',
    all: 'All Winners · Current Draw',
    history: 'Archived Draw Results',
  };

  const st = { open: false, scope: 'today', category: 'all', cycle: null, report: null, canvas: null, seq: 0, timer: 0 };

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  async function load() {
    const seq = ++st.seq;
    const p = new URLSearchParams({ scope: st.scope, category: String(st.category) });
    if (st.scope === 'history' && st.cycle) p.set('cycle', st.cycle);
    try {
      const r = await A.api('GET', `/api/winners-report?${p}`);
      if (seq !== st.seq || !st.open) return;
      st.report = r;
      if (st.scope === 'history') st.cycle = r.groups[0]?.cycle ?? null;
      await render(seq);
    } catch (e) {
      if (seq === st.seq) A.toast(e.message, 'error');
    }
  }

  function dateLabel(r) {
    if (r.scope === 'today') return fmtLong.format(dayDate(r.today));
    const days = [...new Set(r.groups.flatMap((g) => g.winners.map((w) => w.dateIst)))].sort();
    if (!days.length) return fmtLong.format(dayDate(r.today));
    if (days.length === 1) return fmtLong.format(dayDate(days[0]));
    return `${fmtShort.format(dayDate(days[0]))} – ${fmtShort.format(dayDate(days[days.length - 1]))}`;
  }
  function titleOf(r) {
    if (r.scope === 'history' && r.groups[0]) return `Draw Results · Cycle ${r.groups[0].cycle}${r.groups[0].archived ? ' (archived)' : ''}`;
    return SCOPE_TITLE[r.scope];
  }

  // ---------------------------------------------------------------------------
  // WhatsApp / plain text
  // ---------------------------------------------------------------------------
  function buildText(r) {
    const lines = ['*ANGLE FRAMES CHITTY*', `*${titleOf(r)}*`, dateLabel(r), ''];
    if (!r.total) lines.push('No winners yet.', '');
    for (const g of r.groups) {
      if (!g.winners.length) continue;
      lines.push(`*${g.name}* · ${A.inr.format(g.amount)} · Draw cycle ${g.cycle}`);
      for (const w of g.winners) {
        const when = r.scope === 'today' || dateLabel(r).indexOf('–') === -1
          ? fmtTime.format(new Date(w.drawnAt))
          : `${fmtShort.format(new Date(w.drawnAt))}, ${fmtTime.format(new Date(w.drawnAt))}`;
        lines.push(`${w.drawNumber}. *${w.name}*${w.uid ? ` (${w.uid})` : ''} — ${when}`);
      }
      lines.push('');
    }
    lines.push(`Total winners: *${r.total}*`);
    lines.push(`_Drawn live with a secure random draw · ${fmtShort.format(new Date(r.generatedAt))}, ${fmtTime.format(new Date(r.generatedAt))} IST_`);
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Branded report image (canvas) — used for preview, PNG, PDF and native share
  // ---------------------------------------------------------------------------
  let logoP = null;
  const logo = () => (logoP ||= new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = 'logo.png';
  }));

  async function drawReport(r) {
    const W = 1080, P = 72;
    const ROW = 92, GROUP_HEAD = 120, GROUP_GAP = 36;
    const groups = r.groups.filter((g) => g.winners.length);
    let H = 210 + 8 + 250;
    if (!groups.length) H += 160;
    for (const g of groups) H += GROUP_HEAD + g.winners.length * ROW + GROUP_GAP;
    H += 170;

    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const font = (w, s) => `${w} ${s}px Poppins, system-ui, sans-serif`;
    const ls = (v) => { if ('letterSpacing' in g) g.letterSpacing = `${v}px`; };
    const fit = (t, max) => {
      if (!max || g.measureText(t).width <= max) return t;
      while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
      return t + '…';
    };
    const txt = (t, x, y, o = {}) => {
      g.font = font(o.w || 400, o.s || 24); ls(o.ls || 0);
      g.fillStyle = o.c || '#0a0a0a'; g.textAlign = o.a || 'left'; g.textBaseline = 'alphabetic';
      g.fillText(fit(String(t ?? ''), o.max), x, y); ls(0);
    };
    const width = (t, w, s, l = 0) => { g.font = font(w, s); ls(l); const m = g.measureText(t).width; ls(0); return m; };

    // Page
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);

    // Header band with logo
    g.fillStyle = '#0a0a0a'; g.fillRect(0, 0, W, 210);
    const img = await logo();
    let lx = P;
    if (img) { const lh = 104, lw = (lh * img.naturalWidth) / img.naturalHeight; g.drawImage(img, P, 53, lw, lh); lx = P + lw; }
    g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(lx + 30, 74, 2, 62);
    txt('CHITTY', lx + 58, 104, { w: 700, s: 28, c: '#fff', ls: 8 });
    txt('Official winners report', lx + 58, 140, { s: 22, c: '#a2a2a2' });
    g.fillStyle = '#b3141b'; g.fillRect(0, 210, W, 8);

    // Title block
    let y = 218 + 86;
    g.fillStyle = '#b3141b'; g.fillRect(P, y - 16, 40, 6);
    txt(titleOf(r).toUpperCase(), P + 56, y - 4, { w: 600, s: 22, c: '#b3141b', ls: 4, max: W - P * 2 - 56 });
    y += 66;
    txt(dateLabel(r), P, y, { w: 700, s: 50, max: W - P * 2 });
    y += 52;
    const nCats = groups.length;
    txt(`${r.total} winner${r.total === 1 ? '' : 's'}${nCats ? ` · ${nCats} chitt${nCats === 1 ? 'y' : 'ies'}` : ''} · Generated ${fmtTime.format(new Date(r.generatedAt))} IST`, P, y, { s: 24, c: '#6b6b6b' });
    y += 46;
    g.fillStyle = '#ececec'; g.fillRect(P, y, W - P * 2, 2);
    y += 2;

    if (!groups.length) {
      y += 100;
      txt('No winners yet.', W / 2, y, { s: 30, c: '#8a8a8a', a: 'center' });
      y += 60;
    }

    for (const grp of groups) {
      y += 70;
      txt(grp.name, P, y, { w: 700, s: 36, max: 620 });
      const meta = `${A.inr.format(grp.amount)} · Draw cycle ${grp.cycle}${grp.archived ? ' · archived' : ''}`;
      txt(meta, W - P, y, { s: 22, c: '#6b6b6b', a: 'right' });
      y += 50;
      for (const w of grp.winners) {
        const cy = y + ROW / 2 - 8;
        g.beginPath(); g.arc(P + 28, cy, 28, 0, Math.PI * 2);
        g.fillStyle = '#0a0a0a'; g.fill();
        const num = String(w.drawNumber);
        txt(num, P + 28, cy + 9, { w: 700, s: num.length > 2 ? 18 : 24, c: '#fff', a: 'center' });
        txt(w.name, P + 82, cy - 2, { w: 600, s: 32, max: 620 });
        if (w.uid) txt(w.uid, P + 82, cy + 32, { s: 20, c: '#8a8a8a', ls: 1 });
        const when = fmtTime.format(new Date(w.drawnAt));
        txt(when, W - P, cy - 2, { w: 500, s: 24, a: 'right' });
        txt(fmtShort.format(new Date(w.drawnAt)), W - P, cy + 30, { s: 19, c: '#8a8a8a', a: 'right' });
        y += ROW;
        g.fillStyle = '#f1f1f1'; g.fillRect(P + 82, y - 10, W - P * 2 - 82, 2);
      }
      y += GROUP_GAP - 40;
    }

    // Footer
    const fy = H - 120;
    g.fillStyle = '#f6f6f6'; g.fillRect(0, fy - 50, W, H - fy + 50);
    g.fillStyle = '#b3141b'; g.fillRect(0, fy - 50, 8, H - fy + 50);
    txt(`Total winners: ${r.total}`, P, fy + 6, { w: 700, s: 28 });
    txt('Winners selected server-side with a secure random generator. Every draw is recorded.', P, fy + 48, { s: 20, c: '#6b6b6b', max: W - P * 2 });
    const tw = width('ANGLE FRAMES CHITTY', 700, 18, 4);
    txt('ANGLE FRAMES CHITTY', W - P - tw, fy + 6, { w: 700, s: 18, c: '#b3141b', ls: 4 });
    return cv;
  }

  // Minimal single-page PDF with the report embedded as a JPEG (no external libraries).
  async function makePdf(canvas) {
    const jpgBlob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
    const jpg = new Uint8Array(await jpgBlob.arrayBuffer());
    const pw = 595.28;
    const ph = +(pw * canvas.height / canvas.width).toFixed(2);
    const enc = new TextEncoder();
    const parts = [];
    const offsets = [];
    let len = 0;
    const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
    obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
    obj(4, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
      push(jpg);
      push('\nendstream');
    });
    obj(5, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    const xref = len;
    let x = 'xref\n0 6\n0000000000 65535 f \n';
    for (let i = 1; i <= 5; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    push(`${x}trailer\n<< /Size 6 /Root 1 0 R /Info << /Title (ANGLE FRAMES CHITTY Winners) /Producer (ANGLE FRAMES CHITTY) >> >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  function renderControls() {
    $$('#shareScope button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.scope));
    const cats = A.data()?.categories || [];
    const chips = (st.scope === 'history' ? [] : [{ id: 'all', name: 'All chitties' }]).concat(cats);
    $('#shareCats').innerHTML = chips.map((c) =>
      `<button data-v="${c.id}" class="${String(c.id) === String(st.category) ? 'on' : ''}">${A.esc(c.name)}</button>`).join('');
    const cyc = $('#shareCycles');
    cyc.hidden = st.scope !== 'history';
    if (st.scope === 'history' && st.report?.cycles) {
      cyc.innerHTML = st.report.cycles.map((c) => {
        const tag = c.end_reason === 'reset' ? ' · reset' : c.ended_at ? ' · closed' : ' · active';
        return `<button data-v="${c.cycle}" class="${c.cycle === st.cycle ? 'on' : ''}">Cycle ${c.cycle} · ${c.winners} winner${c.winners === 1 ? '' : 's'}${tag}</button>`;
      }).join('');
    }
  }

  async function render(seq) {
    renderControls();
    const r = st.report;
    if (!r) return;
    $('#shareTitle').textContent = titleOf(r);
    $('#shareText').textContent = buildText(r);
    const cv = await drawReport(r);
    if (seq !== st.seq) return; // a newer report replaced this one while drawing
    st.canvas = cv;
    $('#shareImg').src = cv.toDataURL('image/png');
    const empty = !r.total;
    ['#shareWa', '#shareNative', '#shareCopy'].forEach((s) => { $(s).disabled = empty; });
  }

  function refreshSoon() {
    clearTimeout(st.timer);
    st.timer = setTimeout(load, 350);
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  const fileBase = () => {
    const r = st.report;
    const cat = r.groups.length === 1 ? r.groups[0].name.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') : 'All-Chitties';
    return `AngleFrames-Chitty_${r.scope}_${cat}_${r.today}`;
  };
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
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
  const pngBlob = () => new Promise((res) => st.canvas.toBlob(res, 'image/png'));

  $('#shareWa').addEventListener('click', () => {
    if (!st.report) return;
    window.open(`https://wa.me/?text=${encodeURIComponent(buildText(st.report))}`, '_blank', 'noopener');
  });
  $('#shareCopy').addEventListener('click', async () => {
    if (!st.report) return;
    A.toast((await copyText(buildText(st.report))) ? 'Winner details copied' : 'Copy failed — select the message text and copy it', 'ok');
  });
  $('#sharePng').addEventListener('click', async () => {
    if (!st.canvas) return;
    saveBlob(await pngBlob(), `${fileBase()}.png`);
  });
  $('#sharePdf').addEventListener('click', async () => {
    if (!st.canvas) return;
    try { saveBlob(await makePdf(st.canvas), `${fileBase()}.pdf`); }
    catch (e) { A.toast(`PDF could not be created: ${e.message}`, 'error'); }
  });
  $('#shareNative').addEventListener('click', async () => {
    if (!st.canvas) return;
    const file = new File([await pngBlob()], `${fileBase()}.png`, { type: 'image/png' });
    const text = buildText(st.report);
    try {
      await navigator.share({ files: [file], text, title: 'ANGLE FRAMES CHITTY — Winners' });
    } catch (e) {
      if (e.name !== 'AbortError') { saveBlob(file, file.name); A.toast('Sharing is not available here — the image was downloaded instead.'); }
    }
  });
  const canShareFiles = (() => {
    try { return !!navigator.canShare?.({ files: [new File([new Blob(['x'])], 'x.png', { type: 'image/png' })] }); } catch { return false; }
  })();
  $('#shareNative').hidden = !canShareFiles;

  // ---------------------------------------------------------------------------
  // Modal
  // ---------------------------------------------------------------------------
  function open(scope) {
    if (!A.isAdmin()) return;
    const cur = A.data()?.category?.id;
    st.scope = scope;
    st.category = scope === 'previous' || scope === 'history' ? (cur ?? 'all') : 'all';
    st.cycle = null;
    st.report = null;
    st.open = true;
    $('#shareImg').removeAttribute('src');
    $('#shareText').textContent = 'Loading…';
    renderControls();
    $('#shareModal').hidden = false;
    load();
  }
  function close() {
    st.open = false;
    clearTimeout(st.timer);
    $('#shareModal').hidden = true;
  }
  $$('.share-btn').forEach((b) => b.addEventListener('click', () => open(b.dataset.share)));
  $('#shareClose').addEventListener('click', close);
  $('#shareModal').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#shareModal').hidden) { e.stopImmediatePropagation(); close(); }
  }, true);
  $('#shareScope').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || b.dataset.v === st.scope) return;
    st.scope = b.dataset.v;
    st.cycle = null;
    if (st.scope === 'history' && st.category === 'all') st.category = A.data()?.category?.id ?? 'all';
    if (st.scope === 'previous' && st.category === 'all') st.category = A.data()?.category?.id ?? 'all';
    renderControls();
    load();
  });
  $('#shareCats').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    st.category = b.dataset.v === 'all' ? 'all' : Number(b.dataset.v);
    st.cycle = null;
    renderControls();
    load();
  });
  $('#shareCycles').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    st.cycle = Number(b.dataset.v);
    renderControls();
    load();
  });

  function syncButtons() {
    const admin = A.isAdmin();
    $$('.share-btn').forEach((b) => { b.hidden = !admin; });
    if (!admin && st.open) close();
  }
  setInterval(syncButtons, 1000);

  window.AFCShare = {
    // Called by app.js whenever live state changes (after every spin, reset, edit).
    onState() {
      syncButtons();
      if (st.open) refreshSoon();
    },
  };
  syncButtons();
})();
