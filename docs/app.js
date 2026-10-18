'use strict';
(() => {
  const TZ = 'Asia/Kolkata';
  const TAU = Math.PI * 2;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };

  const app = {
    categoryId: Number(store.get('afc_category')) || null,
    data: null,
    token: store.get('afc_token'),
    admin: false,
    offset: 0, // serverTime - clientTime
    reqSeq: 0,
    sound: store.get('afc_sound') !== 'off',
    anim: null, // { spinId, ... }
    finishedSpins: new Set(),
    completedSpin: null, // winner shown after the latest animation
    seenToday: null,
    seenPrev: null,
    lastWheelKey: '',
    rotation: 0,
    editingParticipant: null,
    editingCategory: null,
    today: null,
  };
  const serverNow = () => Date.now() + app.offset;

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  const fmtTime = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true });
  const fmtClock = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  const fmtDate = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
  const fmtLongDate = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------
  async function api(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (app.token) headers.Authorization = `Bearer ${app.token}`;
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && app.admin && url !== '/api/login') { setAdmin(false, null); }
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json;
  }

  async function refresh() {
    const seq = ++app.reqSeq;
    const t0 = Date.now();
    try {
      const data = await api('GET', `/api/state${app.categoryId ? `?category=${app.categoryId}` : ''}`);
      if (seq !== app.reqSeq) return;
      const rtt = Date.now() - t0;
      app.offset = data.serverTime + rtt / 2 - Date.now();
      apply(data);
    } catch (e) {
      if (seq === app.reqSeq) toast(e.message, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  function apply(data) {
    const prevCatId = app.data?.category?.id;
    app.data = data;
    app.today = data.today;
    const cat = data.category;
    if (cat && cat.id !== app.categoryId) { app.categoryId = cat.id; store.set('afc_category', cat.id); }
    if (cat?.id !== prevCatId) { app.completedSpin = null; app.seenPrev = null; if (app.anim) stopAnim(); }

    renderCategorySelect();
    renderStage();
    renderCurrent();
    renderPrev();
    renderToday();
    renderDrawer();
    window.AFCRecorder?.onState(data);
    window.AFCShare?.onState(data);
  }

  // Avoid "₹1,000 Chitty — ₹1,000" when the name already states the amount.
  const catLabel = (c) => {
    const amt = inr.format(c.amount);
    const digits = String(c.amount);
    return c.name.replace(/[^\d]/g, '').includes(digits) ? c.name : `${c.name} — ${amt}`;
  };


  const ICONS = {
    edit: '<svg viewBox="0 0 24 24" class="ico"><path d="M4 20h4L19 9l-4-4L4 16v4z" fill="none"/></svg>',
    del: '<svg viewBox="0 0 24 24" class="ico"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none"/></svg>',
    ok: '<svg viewBox="0 0 24 24" class="ico"><path d="M5 12l5 5 9-10" fill="none"/></svg>',
    x: '<svg viewBox="0 0 24 24" class="ico"><path d="M6 6l12 12M18 6L6 18" fill="none"/></svg>',
  };

  function renderCategorySelect() {
    const cats = app.data.categories;
    const cur = cats.find((c) => c.id === app.categoryId);
    $('#catPickerValue').innerHTML = cur ? esc(catLabel(cur)) : 'No categories';
    $('#catPickerMenu').innerHTML = cats.length
      ? cats.map((c) => `<li role="option" data-id="${c.id}" aria-selected="${c.id === app.categoryId}">
          ${esc(c.name)}<span>${inr.format(c.amount)} · Cycle ${c.cycle}</span></li>`).join('')
      : '<li class="empty">No categories yet</li>';
  }

  const picker = $('#catPicker');
  const pickerMenu = $('#catPickerMenu');
  let pickerActive = -1;
  function pickerItems() { return [...pickerMenu.querySelectorAll('li[data-id]')]; }
  function setPickerActive(i) {
    const items = pickerItems();
    if (!items.length) return;
    pickerActive = (i + items.length) % items.length;
    items.forEach((el, j) => el.classList.toggle('active', j === pickerActive));
    items[pickerActive].scrollIntoView({ block: 'nearest' });
  }
  function openPicker() {
    picker.classList.add('open');
    pickerMenu.hidden = false;
    $('#catPickerBtn').setAttribute('aria-expanded', 'true');
    setPickerActive(Math.max(0, pickerItems().findIndex((el) => Number(el.dataset.id) === app.categoryId)));
  }
  function closePicker() {
    picker.classList.remove('open');
    pickerMenu.hidden = true;
    $('#catPickerBtn').setAttribute('aria-expanded', 'false');
  }
  function selectCategory(id) {
    closePicker();
    if (!id || id === app.categoryId) return;
    app.categoryId = id;
    store.set('afc_category', id);
    app.editingParticipant = null;
    refresh();
  }
  $('#catPickerBtn').addEventListener('click', () => (pickerMenu.hidden ? openPicker() : closePicker()));
  pickerMenu.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) selectCategory(Number(li.dataset.id));
  });
  document.addEventListener('pointerdown', (e) => { if (!picker.contains(e.target)) closePicker(); });
  picker.addEventListener('keydown', (e) => {
    const open = !pickerMenu.hidden;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) openPicker(); else setPickerActive(pickerActive + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      const el = pickerItems()[pickerActive];
      if (el) selectCategory(Number(el.dataset.id));
    } else if (e.key === 'Escape' && open) { e.stopPropagation(); closePicker(); }
  });

  function setStat(id, value) {
    const el = $(id);
    const v = String(value);
    if (el.textContent !== v) {
      const bump = el.textContent !== '' && el.textContent !== '—';
      el.textContent = v;
      if (bump) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
    }
  }

  function renderStage() {
    const cat = app.data.category;
    const spin = cat?.activeSpin;
    const spinningNow = !!(app.anim || (spin && !app.finishedSpins.has(spin.id)));

    setStat('#statAmount', cat ? inr.format(cat.amount) : '—');
    setStat('#statTotal', cat?.totalParticipants ?? 0);
    setStat('#statRemaining', cat?.eligibleCount ?? 0);
    setStat('#statWinners', cat?.cycleWinners.length ?? 0);
    $('#cycleBadge').textContent = cat ? `Draw cycle ${cat.cycle}` : 'No category';

    // Wheel
    if (cat && spin && !app.finishedSpins.has(spin.id)) {
      if (!app.anim || app.anim.spinId !== spin.id) startAnim(spin, cat.wheel);
    } else if (cat && spin && app.finishedSpins.has(spin.id)) {
      // Finished locally, waiting for server reveal: keep showing the final position.
      setWheel(cat.wheel, spin.endRotation);
    } else if (!app.anim) {
      setWheel(cat ? cat.wheel : [], cat ? cat.rotation : 0);
    }

    // Status
    let status = 'ready';
    let label = 'Ready';
    if (spinningNow) { status = 'spinning'; label = 'Spinning'; }
    else if (app.completedSpin || (cat && cat.totalParticipants > 0 && cat.eligibleCount === 0)) { status = 'completed'; label = 'Completed'; }
    const pill = $('#statusPill');
    pill.dataset.status = status;
    pill.querySelector('span').textContent = label;
    $('#wheelWrap').classList.toggle('spinning', spinningNow);

    // Spin button
    const btn = $('#spinBtn');
    const hint = $('#spinHint');
    const eligible = cat?.eligibleCount ?? 0;
    btn.disabled = !cat || spinningNow || eligible === 0;
    btn.querySelector('.spin-label').textContent = spinningNow ? 'SPINNING…' : 'START SPIN';
    let h = '';
    if (!cat) h = 'Create a chitty category to begin.';
    else if (spinningNow) h = 'Draw in progress — please wait.';
    else if (cat.totalParticipants === 0) h = app.admin ? 'Add participants from the Admin panel to begin.' : 'Waiting for participants to be added.';
    else if (eligible === 0) h = 'Every participant has won in this cycle. Start a new draw cycle from the Admin panel.';
    else if (!app.admin) h = 'Admin sign-in is required to spin. This screen updates live.';
    else h = `${eligible} eligible participant${eligible === 1 ? '' : 's'} on the wheel.`;
    hint.textContent = h;
  }

  function winnerMeta(w, withCat = true) {
    const d = new Date(w.drawnAt);
    return `${withCat ? `<span><b>${esc(w.categoryName)}</b> · ${inr.format(w.amount)}</span>` : ''}
      <span>Draw #${w.drawNumber} · Cycle ${w.cycle}</span>
      <span>${fmtDate.format(d)}, ${fmtTime.format(d)}</span>`;
  }

  function renderCurrent() {
    const cat = app.data.category;
    const body = $('#currentBody');
    const spinning = app.anim && !app.completedSpin;
    const w = app.completedSpin || (spinning ? null : cat?.latestWinner);
    let html;
    if (spinning) html = '<p class="current-empty">Drawing a winner…</p>';
    else if (w) html = `<p class="current-name">${esc(w.name)}</p>
        <p class="current-uid">${esc(w.participantUid)}</p>
        <div class="current-meta">${winnerMeta(w)}</div>`;
    else html = '<p class="current-empty">No winner drawn yet in this category.</p>';
    if (body.dataset.html !== html) { body.innerHTML = html; body.dataset.html = html; }
    $('#currentMeta').textContent = cat ? cat.name : '';
  }

  function listItem(w, rank, isNew, showCat) {
    const d = new Date(w.drawnAt);
    return `<li class="${isNew ? 'new' : ''}">
      <span class="w-rank">${rank}</span>
      <div class="w-main"><div class="w-name">${esc(w.name)}</div>
        <div class="w-sub">${showCat ? `${esc(w.categoryName)} · ${inr.format(w.amount)}` : `${esc(w.participantUid)} · ${esc(w.categoryName)}`}</div></div>
      <div class="w-time"><b>${fmtTime.format(d)}</b>${fmtDate.format(d)}</div>
    </li>`;
  }

  function renderPrev() {
    const cat = app.data.category;
    const list = cat?.cycleWinners ?? [];
    const seen = app.seenPrev;
    $('#prevCount').textContent = list.length;
    $('#prevSub').textContent = cat ? `${cat.name} · draw cycle ${cat.cycle}` : 'No category selected';
    $('#prevList').innerHTML = list.length
      ? list.map((w) => listItem(w, `#${w.drawNumber}`, seen && !seen.has(w.id), false)).join('')
      : '<li class="list-empty">No winners yet in this draw cycle.</li>';
    app.seenPrev = new Set(list.map((w) => w.id));
  }

  function renderToday() {
    const list = app.data.todayWinners;
    const seen = app.seenToday;
    $('#todayCount').textContent = list.length;
    $('#todayLabel').textContent = fmtDate.format(new Date(serverNow()));
    $('#todayList').innerHTML = list.length
      ? list.map((w, i) => listItem(w, list.length - i, seen && !seen.has(w.id), true)).join('')
      : '<li class="list-empty">No winners drawn today yet.</li>';
    app.seenToday = new Set(list.map((w) => w.id));
  }

  // ---------------------------------------------------------------------------
  // Wheel
  // ---------------------------------------------------------------------------
  const canvas = $('#wheel');
  const ctx = canvas.getContext('2d');
  const face = document.createElement('canvas'); // pre-rendered wheel face (rotation 0)
  const fctx = face.getContext('2d');
  let wheelNames = [];
  let px = 0;
  // Brand palette: charcoal, graphite, Angle Frames red.
  const COLORS = ['#151515', '#262626', '#88090c'];

  function segColor(i, n) {
    if (n === 1) return COLORS[1];
    if (n === 2) return COLORS[i ? 2 : 1];
    let c = i % COLORS.length;
    // The last segment touches the first: never let neighbours share a colour.
    if (i === n - 1 && c === 0) c = 1;
    return COLORS[c];
  }

  function sizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const s = Math.round(rect.width * dpr);
    if (s && s !== px) {
      px = s;
      canvas.width = canvas.height = s;
      face.width = face.height = s;
      paintFace();
    }
  }

  function fitText(text, maxW, font) {
    fctx.font = font;
    if (fctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && fctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function paintFace() {
    const s = px;
    if (!s) return;
    const c = s / 2;
    const R = s * 0.455; // face radius (rim drawn outside)
    fctx.clearRect(0, 0, s, s);
    const n = wheelNames.length;
    $('#wheelEmpty').hidden = n > 0;
    if (!n) {
      const ph = 12, ps = TAU / ph;
      for (let i = 0; i < ph; i++) {
        fctx.beginPath(); fctx.moveTo(c, c); fctx.arc(c, c, R, i * ps, (i + 1) * ps); fctx.closePath();
        fctx.fillStyle = i % 2 ? '#121212' : '#161616'; fctx.fill();
        fctx.strokeStyle = 'rgba(255,255,255,.05)'; fctx.lineWidth = Math.max(1, s * 0.0015); fctx.stroke();
      }
      fctx.setLineDash([s * 0.006, s * 0.01]);
      fctx.strokeStyle = 'rgba(255,255,255,.12)'; fctx.lineWidth = Math.max(1, s * 0.002);
      fctx.beginPath(); fctx.arc(c, c, R * 0.62, 0, TAU); fctx.stroke();
      fctx.setLineDash([]);
      return;
    }
    const seg = TAU / n;
    for (let i = 0; i < n; i++) {
      const a0 = i * seg;
      fctx.beginPath(); fctx.moveTo(c, c); fctx.arc(c, c, R, a0, a0 + seg); fctx.closePath();
      const g = fctx.createRadialGradient(c, c, R * 0.15, c, c, R);
      const base = segColor(i, n);
      g.addColorStop(0, shade(base, -0.35)); g.addColorStop(0.8, base); g.addColorStop(1, shade(base, 0.06));
      fctx.fillStyle = g; fctx.fill();
      if (n > 1) { fctx.strokeStyle = 'rgba(255,255,255,.14)'; fctx.lineWidth = Math.max(1, s * 0.0018); fctx.stroke(); }
    }
    // Labels
    const fontSize = Math.max(s * 0.012, Math.min(s * 0.034, (seg * R * 0.62) * 0.62));
    const font = `600 ${fontSize}px Poppins, system-ui, sans-serif`;
    const maxW = R * 0.66;
    fctx.fillStyle = '#ffffff';
    fctx.textAlign = 'right';
    fctx.textBaseline = 'middle';
    fctx.shadowColor = 'rgba(0,0,0,.55)'; fctx.shadowBlur = s * 0.004;
    const labelEvery = n > 120 ? Math.ceil(n / 120) : 1;
    for (let i = 0; i < n; i += labelEvery) {
      const mid = (i + 0.5) * seg;
      fctx.save();
      fctx.translate(c, c); fctx.rotate(mid);
      fctx.font = font;
      fctx.fillText(fitText(wheelNames[i].name, maxW, font), R * 0.93, 0);
      fctx.restore();
    }
    fctx.shadowBlur = 0;
    // inner shading
    const ig = fctx.createRadialGradient(c, c, R * 0.5, c, c, R);
    ig.addColorStop(0, 'rgba(0,0,0,0)'); ig.addColorStop(1, 'rgba(0,0,0,.28)');
    fctx.beginPath(); fctx.arc(c, c, R, 0, TAU); fctx.fillStyle = ig; fctx.fill();
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const f = (v) => Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt);
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  }

  function drawFrame(rotation, bulbPhase = 0) {
    const s = px;
    if (!s) return;
    const c = s / 2;
    ctx.clearRect(0, 0, s, s);
    // Rim
    const rimOuter = s * 0.495, rimInner = s * 0.455;
    ctx.beginPath(); ctx.arc(c, c, rimOuter, 0, TAU); ctx.arc(c, c, rimInner, 0, TAU, true);
    ctx.fillStyle = '#0d0d0d'; ctx.fill();
    ctx.lineWidth = Math.max(1, s * 0.003); ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.beginPath(); ctx.arc(c, c, rimOuter - ctx.lineWidth / 2, 0, TAU); ctx.stroke();
    ctx.lineWidth = Math.max(1, s * 0.002); ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.beginPath(); ctx.arc(c, c, rimInner, 0, TAU); ctx.stroke();
    // Bulbs
    const bulbs = 36, br = (rimOuter + rimInner) / 2;
    for (let i = 0; i < bulbs; i++) {
      const a = (i / bulbs) * TAU;
      const on = (i + bulbPhase) % 2 === 0;
      ctx.beginPath(); ctx.arc(c + Math.cos(a) * br, c + Math.sin(a) * br, s * 0.0045, 0, TAU);
      const lit = bulbPhase === 0 ? i % 2 === 0 : on;
      ctx.fillStyle = lit ? (bulbPhase === 0 ? 'rgba(255,255,255,.55)' : '#ff2d36') : 'rgba(255,255,255,.12)';
      if (lit && bulbPhase !== 0) { ctx.shadowColor = '#ff2d36'; ctx.shadowBlur = s * 0.014; }
      ctx.fill(); ctx.shadowBlur = 0;
    }
    // Face
    ctx.save();
    ctx.translate(c, c); ctx.rotate(rotation); ctx.translate(-c, -c);
    ctx.drawImage(face, 0, 0);
    ctx.restore();
  }

  function setWheel(names, rotation) {
    const key = names.map((p) => `${p.id}:${p.name}`).join('|');
    if (key !== app.lastWheelKey) {
      wheelNames = names;
      app.lastWheelKey = key;
      paintFace();
      canvas.animate?.([{ opacity: 0.4, transform: 'scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 400, easing: 'ease-out' });
    }
    app.rotation = rotation;
    $('#wheelEmpty').textContent = app.data?.category
      ? (app.data.category.totalParticipants ? 'All participants have won in this draw cycle' : 'No participants yet')
      : 'No category';
    drawFrame(rotation);
  }

  // Smooth accelerate → long decelerate. Velocity ramps linearly up for the first
  // ACCEL fraction, then decays quadratically to zero; position is its integral (C¹-continuous).
  const ACCEL = 0.12;
  const TOTAL = ACCEL / 2 + (1 - ACCEL) / 3;
  function ease(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    if (t < ACCEL) return (t * t) / (2 * ACCEL) / TOTAL;
    const u = (t - ACCEL) / (1 - ACCEL);
    return (ACCEL / 2 + ((1 - ACCEL) * (1 - Math.pow(1 - u, 3))) / 3) / TOTAL;
  }

  function startAnim(spin, names) {
    stopAnim();
    app.completedSpin = null;
    closeCelebration();
    setWheel(names, spin.startRotation);
    const n = names.length;
    const seg = TAU / n;
    const pointerIndex = (rot) => Math.floor((((-Math.PI / 2 - rot) % TAU) + TAU) % TAU / seg);
    const elapsedAtStart = serverNow() - spin.startedAt;
    const anim = {
      spinId: spin.id, spin, lastIdx: pointerIndex(spin.startRotation), raf: 0,
      watchedFromStart: elapsedAtStart < spin.duration - 400,
    };
    app.anim = anim;
    renderCurrent();
    const step = () => {
      if (app.anim !== anim) return;
      const t = (serverNow() - spin.startedAt) / spin.duration;
      const p = ease(t);
      const rot = spin.startRotation + (spin.endRotation - spin.startRotation) * p;
      const idx = pointerIndex(rot);
      if (idx !== anim.lastIdx && n > 1) { anim.lastIdx = idx; tick(); }
      drawFrame(rot, 1 + (Math.floor(serverNow() / 160) % 2));
      if (t >= 1) { finishAnim(anim); return; }
      anim.raf = requestAnimationFrame(step);
    };
    anim.raf = requestAnimationFrame(step);
  }

  function stopAnim() {
    if (app.anim) cancelAnimationFrame(app.anim.raf);
    app.anim = null;
  }

  function finishAnim(anim) {
    const { spin } = anim;
    app.finishedSpins.add(spin.id);
    app.anim = null;
    app.rotation = spin.endRotation;
    drawFrame(spin.endRotation);
    app.completedSpin = spin.winner;
    renderStage();
    renderCurrent();
    const card = $('#currentCard');
    card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
    if (anim.watchedFromStart) celebrate(spin.winner);
    clearTimeout(completedTimer);
    completedTimer = setTimeout(clearCompleted, 15000);
    // The server reveal event also triggers a refresh; this is a fallback.
    setTimeout(refresh, Math.max(200, spin.revealAt - serverNow() + 250));
  }

  // ---------------------------------------------------------------------------
  // Sound
  // ---------------------------------------------------------------------------
  let audio, master;
  function ac() {
    if (!audio) {
      try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
      master = audio.createGain();
      master.connect(audio.destination);
    }
    if (audio.state === 'suspended') audio.resume().catch(() => {});
    return audio;
  }
  let lastTick = 0;
  function tick() {
    const p = $('.pointer');
    p.classList.remove('tick'); void p.offsetWidth; p.classList.add('tick');
    if (!app.sound) return;
    const now = performance.now();
    if (now - lastTick < 35) return;
    lastTick = now;
    const a = ac(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = 'triangle'; o.frequency.value = 1400;
    g.gain.setValueAtTime(0.08, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.04);
    o.connect(g).connect(master); o.start(); o.stop(a.currentTime + 0.05);
  }
  function fanfare() {
    if (!app.sound) return;
    const a = ac(); if (!a) return;
    [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5].forEach((f, i) => {
      const t = a.currentTime + i * 0.12 + (i > 3 ? 0.08 : 0);
      const o = a.createOscillator(), g = a.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (i === 5 ? 0.9 : 0.3));
      o.connect(g).connect(master); o.start(t); o.stop(t + 1);
    });
  }

  // ---------------------------------------------------------------------------
  // Celebration
  // ---------------------------------------------------------------------------
  let confettiRaf = 0, celebrateTimer = 0, completedTimer = 0;
  function clearCompleted() {
    closeCelebration();
    clearTimeout(completedTimer);
    app.completedSpin = null;
    if (app.data) { renderStage(); renderCurrent(); }
  }
  function celebrate(w) {
    $('#celebrateName').textContent = w.name;
    $('#celebrateUid').textContent = w.participantUid;
    $('#celebrateDraw').textContent = `Draw #${w.drawNumber}`;
    $('#celebrateCat').innerHTML = `${esc(w.categoryName)} · <b>${inr.format(w.amount)}</b>`;
    $('#celebrate').hidden = false;
    fanfare();
    runConfetti();
    clearTimeout(celebrateTimer);
    celebrateTimer = setTimeout(clearCompleted, 15000);
  }
  function closeCelebration() {
    if ($('#celebrate').hidden) return;
    $('#celebrate').hidden = true;
    cancelAnimationFrame(confettiRaf);
    clearTimeout(celebrateTimer);
  }
  function runConfetti() {
    const cv = $('#confetti');
    const c = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.width = innerWidth * dpr, H = cv.height = innerHeight * dpr;
    const colors = ['#ffffff', '#ffffff', '#b3141b', '#d01b23', '#a2a2a2'];
    const parts = Array.from({ length: 220 }, () => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.2, y: H * 0.45,
      vx: (Math.random() - 0.5) * 26 * dpr, vy: (-Math.random() * 22 - 8) * dpr,
      w: (6 + Math.random() * 8) * dpr, h: (4 + Math.random() * 6) * dpr,
      r: Math.random() * TAU, vr: (Math.random() - 0.5) * 0.4, color: colors[(Math.random() * colors.length) | 0],
    }));
    const t0 = performance.now();
    cancelAnimationFrame(confettiRaf);
    const frame = (t) => {
      c.clearRect(0, 0, W, H);
      const life = (t - t0) / 1000;
      for (const p of parts) {
        p.vy += 0.55 * dpr; p.vx *= 0.985; p.vy *= 0.985;
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        c.save(); c.translate(p.x, p.y); c.rotate(p.r);
        c.globalAlpha = Math.max(0, 1 - life / 5);
        c.fillStyle = p.color; c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
        c.restore();
      }
      if (life < 5) confettiRaf = requestAnimationFrame(frame);
    };
    confettiRaf = requestAnimationFrame(frame);
  }
  $('#celebrateClose').addEventListener('click', clearCompleted);

  // ---------------------------------------------------------------------------
  // Clock
  // ---------------------------------------------------------------------------
  function clock() {
    const d = new Date(serverNow());
    $('#clock').textContent = fmtClock.format(d).toUpperCase();
    $('#today').textContent = fmtLongDate.format(d);
    const key = fmtKey.format(d);
    if (app.today && key !== app.today) { app.today = key; refresh(); } // midnight IST rollover
  }
  setInterval(clock, 250);
  clock();

  // ---------------------------------------------------------------------------
  // Live sync (SSE)
  // ---------------------------------------------------------------------------
  function connect() {
    const es = new EventSource('/api/events');
    const dot = $('#liveDot');
    es.onopen = () => { dot.className = 'live-dot on'; dot.title = 'Live — synced with server'; refresh(); };
    es.onerror = () => { dot.className = 'live-dot off'; dot.title = 'Reconnecting…'; };
    es.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'spin' && msg.categoryId !== app.categoryId && !drawerOpen()) {
        // Follow the live draw on display screens.
        app.categoryId = msg.categoryId;
        store.set('afc_category', msg.categoryId);
      }
      if (msg.type === 'recordings') { window.AFCRecorder?.onEvent(msg); return; }
      if (msg.type === 'reset') onReset(msg);
      if (msg.type !== 'hello') refresh();
    };
  }

  // ---------------------------------------------------------------------------
  // Toasts & confirm
  // ---------------------------------------------------------------------------
  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), 3800);
  }

  let confirmResolve = null;
  function confirmBox(title, text, okLabel = 'Confirm', danger = true) {
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    const ok = $('#confirmOk');
    ok.textContent = okLabel;
    ok.className = `btn ${danger ? 'danger' : 'primary'}`;
    $('#confirmModal').hidden = false;
    ok.focus();
    return new Promise((resolve) => { confirmResolve = resolve; });
  }
  function closeConfirm(result) {
    $('#confirmModal').hidden = true;
    if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
  }
  $('#confirmOk').addEventListener('click', () => closeConfirm(true));
  $('#confirmCancel').addEventListener('click', () => closeConfirm(false));
  $('#confirmModal').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) closeConfirm(false); });

  // ---------------------------------------------------------------------------
  // Admin session
  // ---------------------------------------------------------------------------
  function setAdmin(on, token) {
    app.admin = on;
    app.token = token;
    store.set('afc_token', token);
    const b = $('#adminBtn');
    b.textContent = on ? 'Manage' : 'Admin';
    b.classList.toggle('admin-on', on);
    if (!on) closeDrawer();
    if (app.data) renderStage();
  }

  async function checkSession() {
    if (!app.token) return setAdmin(false, null);
    try { const r = await api('GET', '/api/session'); setAdmin(r.admin, r.admin ? app.token : null); }
    catch { /* offline: keep token, try again later */ }
  }

  function openLogin() {
    $('#loginError').textContent = '';
    $('#pinInput').value = '';
    $('#loginModal').hidden = false;
    $('#pinInput').focus();
  }
  const closeLogin = () => { $('#loginModal').hidden = true; $('#pinInput').value = ''; };
  async function submitLogin() {
    const pin = $('#pinInput').value.trim();
    if (!pin) return;
    try {
      const r = await api('POST', '/api/login', { pin });
      setAdmin(true, r.token);
      closeLogin();
      toast('Signed in as admin', 'ok');
      openDrawer();
    } catch (err) {
      $('#loginError').textContent = err.message;
      $('#pinInput').select();
    }
  }
  $('#loginCancel').addEventListener('click', closeLogin);
  $('#loginSubmit').addEventListener('click', submitLogin);
  $('#pinInput').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); });
  $('#pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
  $('#loginModal').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) closeLogin(); });
  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('POST', '/api/logout'); } catch {}
    setAdmin(false, null);
    toast('Signed out');
  });
  $('#adminBtn').addEventListener('click', () => (app.admin ? openDrawer() : openLogin()));

  // ---------------------------------------------------------------------------
  // Main controls
  // ---------------------------------------------------------------------------
  $('#spinBtn').addEventListener('click', async () => {
    if (!app.admin) return openLogin();
    const cat = app.data?.category;
    if (!cat) return;
    ac(); // unlock audio on user gesture
    const btn = $('#spinBtn');
    btn.disabled = true;
    if (window.AFCRecorder && !(await window.AFCRecorder.beforeSpin())) { renderStage(); return; }
    try {
      await api('POST', `/api/categories/${cat.id}/spin`);
      await refresh();
    } catch (e) {
      toast(e.message, 'error');
      renderStage();
    }
  });

  $('#soundBtn').addEventListener('click', () => {
    app.sound = !app.sound;
    store.set('afc_sound', app.sound ? 'on' : 'off');
    $('#soundBtn').setAttribute('aria-pressed', String(app.sound));
    if (app.sound) ac();
  });
  $('#soundBtn').setAttribute('aria-pressed', String(app.sound));

  // ---------------------------------------------------------------------------
  // Drawer
  // ---------------------------------------------------------------------------
  const drawerOpen = () => $('#drawer').classList.contains('open');
  function openDrawer() {
    if (!app.admin) return openLogin();
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#drawerBackdrop').hidden = false;
    renderDrawer();
  }
  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    $('#drawerBackdrop').hidden = true;
    app.editingParticipant = null;
    app.editingCategory = null;
  }
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerBackdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#celebrate').hidden) clearCompleted();
    else if (e.key === 'Escape' && !$('#confirmModal').hidden) closeConfirm(false);
    else if (e.key === 'Escape' && !$('#loginModal').hidden) closeLogin();
    else if (e.key === 'Escape' && !$('#resetModal').hidden) closeReset();
    else if (e.key === 'Escape' && drawerOpen() && !app.editingParticipant && !app.editingCategory) closeDrawer();
  });

  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab));
  }));

  function renderDrawer() {
    if (!drawerOpen() || !app.data) return;
    const cat = app.data.category;
    $('#drawerTitle').textContent = cat ? cat.name : 'Manage draw';
    $('#addTarget').textContent = cat ? cat.name : '—';
    const cats = app.data.categories;
    $('#drawerCats').innerHTML = cats.map((c) =>
      `<button data-id="${c.id}" class="${c.id === app.categoryId ? 'on' : ''}"><b>${esc(c.name)}</b><span>${inr.format(c.amount)} · Cycle ${c.cycle}</span></button>`).join('');
    $('#tcParticipants').textContent = cat ? cat.totalParticipants : '';
    $('#tcCategories').textContent = cats.length;
    $('#tcCycle').textContent = cat ? `C${cat.cycle}` : '';
    if ($('#bulkNames').value) renderBulkPreview();
    renderParticipants();
    renderCategories();
    renderCycle();
  }

  // Participants ---------------------------------------------------------------
  const parseNames = (s) => s.split(/[\n,;]+/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const BULK_TIP = $('#bulkCount').innerHTML;
  function renderBulkPreview() {
    const names = parseNames($('#bulkNames').value);
    const box = $('#bulkPreview');
    if (!names.length) { box.hidden = true; $('#bulkCount').innerHTML = BULK_TIP; return; }
    const existing = new Set((app.data?.category?.participants || []).map((p) => p.name.toLowerCase()));
    const seen = new Set();
    let fresh = 0, dup = 0;
    const chips = names.map((n) => {
      const k = n.toLowerCase();
      const isDup = existing.has(k) || seen.has(k);
      seen.add(k);
      if (isDup) dup++; else fresh++;
      return `<span class="${isDup ? 'dup' : ''}">${esc(n)}</span>`;
    });
    const MAX = 30;
    box.innerHTML = chips.slice(0, MAX).join('') + (chips.length > MAX ? `<span class="more">+${chips.length - MAX} more</span>` : '');
    box.hidden = false;
    $('#bulkCount').textContent = `${fresh} new${dup ? ` · ${dup} duplicate${dup === 1 ? '' : 's'} will be skipped` : ''}`;
  }
  $('#bulkNames').addEventListener('input', renderBulkPreview);
  $('#bulkNames').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#addBtn').click(); }
  });
  $('#drawerCats').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) selectCategory(Number(b.dataset.id));
  });
  $('#addBtn').addEventListener('click', async () => {
    const cat = app.data?.category;
    if (!cat) return toast('Create a category first', 'error');
    const names = parseNames($('#bulkNames').value);
    if (!names.length) return toast('Enter at least one name', 'error');
    try {
      const r = await api('POST', `/api/categories/${cat.id}/participants`, { names });
      $('#bulkNames').value = '';
      renderBulkPreview();
      let msg = `Added ${r.added.length} participant${r.added.length === 1 ? '' : 's'}`;
      if (r.skipped.length) msg += ` · skipped ${r.skipped.length} duplicate${r.skipped.length === 1 ? '' : 's'}`;
      toast(msg, r.added.length ? 'ok' : 'error');
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#pSearch').addEventListener('input', renderParticipants);
  let pFilter = 'all';
  $('#pFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    pFilter = b.dataset.v;
    $$('#pFilter button').forEach((x) => x.classList.toggle('on', x === b));
    renderParticipants();
  });

  function renderParticipants() {
    const cat = app.data?.category;
    const list = $('#pList');
    if (!cat) { list.innerHTML = ''; $('#pSummary').textContent = ''; return; }
    const qv = $('#pSearch').value.trim().toLowerCase();
    const f = pFilter;
    const rows = cat.participants.filter((p) =>
      (!qv || p.name.toLowerCase().includes(qv) || p.uid.toLowerCase().includes(qv)) &&
      (f === 'all' || (f === 'won' ? p.won : !p.won)));
    const wonCount = cat.participants.filter((p) => p.won).length;
    $('#psTotal').textContent = cat.totalParticipants;
    $('#psEligible').textContent = cat.eligibleCount;
    $('#psWon').textContent = wonCount;
    $('#pSummary').textContent = qv || f !== 'all' ? `Showing ${rows.length} of ${cat.totalParticipants}` : '';
    if (!rows.length) {
      list.innerHTML = cat.participants.length
        ? '<li class="empty-state"><b>No matches</b><span>Try a different name, ID or filter.</span></li>'
        : `<li class="empty-state"><b>No participants in ${esc(cat.name)} yet</b><span>Paste a list of names above to add them all at once. Each person gets a unique ID.</span></li>`;
      return;
    }
    const initials = (n) => n.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    list.innerHTML = rows.map((p) => {
      const editing = app.editingParticipant === p.id;
      return `<li data-id="${p.id}" class="p-row${p.won ? ' is-won' : ''}">
        <span class="avatar">${esc(initials(p.name))}</span>
        <span class="p-name">${editing ? `<input value="${esc(p.name)}" maxlength="60" data-edit autocomplete="off" spellcheck="false">` : `<b>${esc(p.name)}</b><small>${esc(p.uid)}</small>`}</span>
        ${editing ? '' : `<span class="tag ${p.won ? 'won' : 'eligible'}">${p.won ? `Won #${p.drawNumber}` : 'Eligible'}</span>`}
        <span class="p-actions">
          ${editing
            ? `<button class="icon-btn sm" data-act="save" aria-label="Save">${ICONS.ok}</button><button class="icon-btn sm" data-act="cancel" aria-label="Cancel">${ICONS.x}</button>`
            : `<button class="icon-btn sm" data-act="edit" aria-label="Edit name">${ICONS.edit}</button><button class="icon-btn sm del" data-act="remove" aria-label="Remove">${ICONS.del}</button>`}
        </span>
      </li>`;
    }).join('');
    const input = list.querySelector('[data-edit]');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  async function saveParticipant(id, name) {
    try {
      await api('PUT', `/api/participants/${id}`, { name });
      app.editingParticipant = null;
      toast('Participant updated', 'ok');
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  $('#pList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const li = btn.closest('li');
    const id = Number(li.dataset.id);
    const p = app.data.category.participants.find((x) => x.id === id);
    const act = btn.dataset.act;
    if (act === 'edit') { app.editingParticipant = id; renderParticipants(); }
    else if (act === 'cancel') { app.editingParticipant = null; renderParticipants(); }
    else if (act === 'save') saveParticipant(id, li.querySelector('[data-edit]').value);
    else if (act === 'remove') {
      const ok = await confirmBox(`Remove ${p.name}?`,
        p.won ? 'They will be removed from the participant list. Their past winning record is kept in the draw history.'
              : 'They will be removed from this category and the wheel.', 'Remove');
      if (!ok) return;
      try { await api('DELETE', `/api/participants/${id}`); toast(`Removed ${p.name}`, 'ok'); await refresh(); }
      catch (err) { toast(err.message, 'error'); }
    }
  });
  $('#pList').addEventListener('keydown', (e) => {
    if (!e.target.matches('[data-edit]')) return;
    if (e.key === 'Enter') saveParticipant(app.editingParticipant, e.target.value);
    if (e.key === 'Escape') { e.stopPropagation(); app.editingParticipant = null; renderParticipants(); }
  });

  // Categories -----------------------------------------------------------------
  function renderCategories() {
    const list = $('#catList');
    const cats = app.data.categories;
    if (!cats.length) { list.innerHTML = '<li class="note">No categories yet.</li>'; return; }
    list.innerHTML = cats.map((c) => {
      const editing = app.editingCategory === c.id;
      return `<li data-id="${c.id}">
        ${editing
          ? `<div class="cat-edit"><input data-f="name" value="${esc(c.name)}" maxlength="60" autocomplete="off" spellcheck="false"><input data-f="amount" type="text" inputmode="numeric" value="${c.amount}" autocomplete="off"></div>
             <span class="p-actions"><button class="icon-btn sm" data-act="save" aria-label="Save">${ICONS.ok}</button><button class="icon-btn sm" data-act="cancel" aria-label="Cancel">${ICONS.x}</button></span>`
          : `<div class="cat-main"><b>${esc(c.name)}</b><span>${inr.format(c.amount)} · Draw cycle ${c.cycle}${c.id === app.categoryId ? ' · <span class="sel">selected</span>' : ''}</span></div>
             <span class="p-actions">
               ${c.id === app.categoryId ? '' : '<button class="btn sm" data-act="select">Open</button>'}
               <button class="icon-btn sm" data-act="edit" aria-label="Edit">${ICONS.edit}</button>
               <button class="icon-btn sm del" data-act="archive" aria-label="Archive">${ICONS.del}</button>
             </span>`}
      </li>`;
    }).join('');
  }

  // Digits only for amount fields (no native number spinners).
  document.addEventListener('input', (e) => {
    if (e.target.matches('#catAmount, [data-f=amount]')) e.target.value = e.target.value.replace(/\D/g, '');
  });
  $('#catName').addEventListener('keydown', (e) => { if (e.key === 'Enter') createCategory(); });
  $('#catAmount').addEventListener('keydown', (e) => { if (e.key === 'Enter') createCategory(); });
  $('#catCreate').addEventListener('click', createCategory);
  async function createCategory() {
    if (!$('#catAmount').value) return toast('Enter an amount', 'error');
    try {
      const r = await api('POST', '/api/categories', { name: $('#catName').value, amount: $('#catAmount').value });
      $('#catName').value = ''; $('#catAmount').value = '';
      app.categoryId = r.id; store.set('afc_category', r.id);
      toast('Category created', 'ok');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  }

  $('#catList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const li = btn.closest('li');
    const id = Number(li.dataset.id);
    const c = app.data.categories.find((x) => x.id === id);
    const act = btn.dataset.act;
    if (act === 'select') { app.categoryId = id; store.set('afc_category', id); refresh(); }
    else if (act === 'edit') { app.editingCategory = id; renderCategories(); }
    else if (act === 'cancel') { app.editingCategory = null; renderCategories(); }
    else if (act === 'save') {
      try {
        await api('PUT', `/api/categories/${id}`, {
          name: li.querySelector('[data-f=name]').value, amount: li.querySelector('[data-f=amount]').value,
        });
        app.editingCategory = null; toast('Category updated', 'ok'); await refresh();
      } catch (err) { toast(err.message, 'error'); }
    } else if (act === 'archive') {
      const ok = await confirmBox(`Archive "${c.name}"?`,
        'The category will be hidden from the draw. Its participants and full winner history remain stored in the database.', 'Archive');
      if (!ok) return;
      try {
        await api('DELETE', `/api/categories/${id}`);
        if (app.categoryId === id) app.categoryId = null;
        toast('Category archived', 'ok'); await refresh();
      } catch (err) { toast(err.message, 'error'); }
    }
  });

  // Cycle -----------------------------------------------------------------------
  function renderCycle() {
    const cat = app.data.category;
    $('#cycleCatName').textContent = cat ? cat.name : '—';
    $('#cycleNum').textContent = cat?.cycle ?? '—';
    $('#cycleWinners').textContent = cat?.cycleWinners.length ?? 0;
    $('#cycleRemaining').textContent = cat?.eligibleCount ?? 0;
    $('#resetOneBtn').disabled = !cat;
    $('#resetAllBtn').disabled = !app.data.categories.length;
    $('#cycleList').innerHTML = cat
      ? cat.cycles.map((c) => {
          const cur = c.cycle === cat.cycle;
          const reason = c.end_reason === 'reset' ? '<span class="reason reset">Reset</span>' : c.end_reason ? '<span class="reason">Closed</span>' : '';
          const open = app.openCycle?.key === `${cat.id}:${c.cycle}`;
          const list = open ? `<div class="cyc-winners">${app.openCycle.winners.length
            ? app.openCycle.winners.map((w) => `<div><b>#${w.drawNumber} ${esc(w.name)}</b><span>${esc(w.participantUid)} · ${fmtDate.format(new Date(w.drawnAt))}, ${fmtTime.format(new Date(w.drawnAt))}</span></div>`).join('')
            : '<span>No winners in this cycle.</span>'}</div>` : '';
          return `<li class="cycle-row" data-cycle="${c.cycle}"><span class="${cur ? 'cur' : ''}">Cycle ${c.cycle}${cur ? ' · active' : ''}${reason}</span>
          <span class="cyc-meta">${c.winners} winner${c.winners === 1 ? '' : 's'} · ${fmtDate.format(new Date(c.started_at))}${c.ended_at ? ` – ${fmtDate.format(new Date(c.ended_at))}` : ''}</span>${list}</li>`;
        }).join('')
      : '';
  }
  // Archived cycle results (click a cycle to show its winners).
  $('#cycleList').addEventListener('click', async (e) => {
    const li = e.target.closest('.cycle-row');
    const cat = app.data?.category;
    if (!li || !cat) return;
    const key = `${cat.id}:${li.dataset.cycle}`;
    if (app.openCycle?.key === key) { app.openCycle = null; return renderCycle(); }
    try {
      const r = await api('GET', `/api/categories/${cat.id}/cycles/${li.dataset.cycle}`);
      app.openCycle = { key, winners: r.winners };
      renderCycle();
    } catch (err) { toast(err.message, 'error'); }
  });

  // Clear all / fresh start ------------------------------------------------------
  let resetScope = 'category';
  function renderResetModal() {
    const cat = app.data?.category;
    const cats = app.data?.categories || [];
    $$('#resetScope button').forEach((b) => b.classList.toggle('on', b.dataset.v === resetScope));
    const targets = resetScope === 'all' ? cats : cats.filter((c) => c.id === cat?.id);
    const winners = targets.reduce((n, c) => n + (c.winners || 0), 0);
    $('#resetHeadline').textContent = resetScope === 'all'
      ? `Reset all ${targets.length} chitt${targets.length === 1 ? 'y' : 'ies'}?`
      : `Reset ${cat ? cat.name : 'the selected chitty'}?`;
    $('#resetEffects').innerHTML = [
      `Clears the current winner, previous spin winners and today's winners${resetScope === 'all' ? ' for every chitty' : ` for ${esc(cat?.name || '')}`}.`,
      `${winners} winner${winners === 1 ? '' : 's'} from the active cycle${targets.length === 1 ? '' : 's'} will be archived and become eligible again.`,
      'Resets the wheel and starts a new, empty draw cycle.',
      '<span class="keep">Participants, categories, archived results and recordings are kept.</span>',
    ].map((t) => `<li>${t}</li>`).join('');
    $('#resetGo').textContent = resetScope === 'all' ? 'Clear all draws' : 'Reset selected chitty';
    $('#resetGo').disabled = $('#resetConfirm').value.trim().toUpperCase() !== 'RESET';
  }
  function openReset(scope) {
    resetScope = scope;
    $('#resetConfirm').value = '';
    $('#resetError').textContent = '';
    renderResetModal();
    $('#resetModal').hidden = false;
    $('#resetConfirm').focus();
  }
  const closeReset = () => { $('#resetModal').hidden = true; };
  $('#resetOneBtn').addEventListener('click', () => openReset('category'));
  $('#resetAllBtn').addEventListener('click', () => openReset('all'));
  $('#resetScope').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) { resetScope = b.dataset.v; renderResetModal(); }
  });
  $('#resetConfirm').addEventListener('input', renderResetModal);
  $('#resetConfirm').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#resetGo').disabled) doReset(); });
  $('#resetCancel').addEventListener('click', closeReset);
  $('#resetModal').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) closeReset(); });
  $('#resetGo').addEventListener('click', doReset);
  async function doReset() {
    const btn = $('#resetGo');
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/reset', { scope: resetScope, categoryId: app.data?.category?.id, confirm: 'RESET' });
      closeReset();
      const n = r.reset.length;
      toast(n === 1 ? `${r.reset[0].name} reset — fresh draw cycle ${r.reset[0].cycle} started` : `All ${n} chitties reset — fresh draw started`, 'ok');
      onReset({ categoryIds: r.reset.map((x) => x.id) });
    } catch (e) {
      $('#resetError').textContent = e.message;
      renderResetModal();
    }
  }

  // Every screen: drop locally shown results for reset categories, then reload.
  function onReset(msg) {
    const ids = msg.categoryIds || [];
    if (ids.includes(app.categoryId)) {
      closeCelebration();
      clearTimeout(completedTimer);
      app.completedSpin = null;
      app.seenPrev = null;
    }
    app.seenToday = null;
    app.openCycle = null;
    refresh();
  }

  // Read-only bridge for the recorder module (public/recorder.js).
  window.AFC = {
    data: () => app.data,
    isAdmin: () => app.admin,
    token: () => app.token,
    api, toast, confirmBox, serverNow, esc, inr, fmtDate, fmtTime,
    audio: () => (ac() ? { ctx: audio, master } : null),
    drawerOpen: () => drawerOpen(),
  };

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  new ResizeObserver(() => { sizeCanvas(); if (!app.anim) drawFrame(app.rotation); }).observe($('#wheelWrap'));
  sizeCanvas();
  if (document.fonts?.ready) document.fonts.ready.then(() => { paintFace(); if (!app.anim) drawFrame(app.rotation); });
  checkSession().then(refresh);
  connect();
})();
