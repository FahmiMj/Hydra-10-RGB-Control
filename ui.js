/**
 * ui.js — HUD interface layer
 * ----------------------------
 * Pure presentation + interaction. All protocol/effect logic lives in
 * core.js (window.RGB); this file only reads/writes that API and renders.
 */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const EFFECT_META = {
    'solid':          { label: 'Solid',          preview: 'pv-solid' },
    'rainbow':        { label: 'Rainbow',         preview: 'pv-rainbow' },
    'rainbow-wave':   { label: 'Rainbow Wave',    preview: 'pv-rainbow-wave' },
    'spectrum-cycle': { label: 'Spectrum Cycle',  preview: 'pv-spectrum-cycle' },
    'breathing':      { label: 'Breathing',       preview: 'pv-breathing' },
    'pulse-wave':     { label: 'Pulse Wave',      preview: 'pv-pulse-wave' },
    'per-key':        { label: 'Per-Key Paint',   preview: 'pv-per-key' },
    'off':            { label: 'Off',             preview: 'pv-off' },
  };

  const SPECTRUM_SWATCH = 'spectrum';

  let brushSpectrum = false; // true = next painted key(s) get the rainbow cycle

  const PRESET_COLORS = [
    '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff',
    '#5856d6', '#af52de', '#ff2d55', SPECTRUM_SWATCH, '#a2845e', '#8e8e93', '#1c1c1e', '#ffffff',
  ];

  const prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    pathErrorsToLog();
    initCursor();
    initStars();
    buildEffectGrid();
    buildPresets();
    buildKeyboard();
    bindControls();
    bindDebugPanel();
    bindGimbalDrag();
    hydrateFromState();

    RGB.onStatus(handleStatus);
    RGB.onLog(handleLog);
    RGB.onFps((fps) => { $('#fps-counter').textContent = `${fps} fps`; });
    RGB.onFrame(renderFrame);
    RGB.onPickDevice(pickDevice);
  });

  // Surface renderer errors and console noise in the Live log so failures
  // aren't hidden in the void when running inside Electron.
  function pathErrorsToLog() {
    const origConsole = { log: console.log, warn: console.warn, error: console.error };
    const forward = (level) => (...args) => {
      const line = { t: Date.now(), msg: args.map(String).join(' '), level };
      const list = $('#log-list');
      if (list) {
        const entry = document.createElement('div');
        entry.className = `log-entry level-${level}`;
        const time = new Date(line.t).toLocaleTimeString([], { hour12: false });
        entry.innerHTML = `<span class="t">${time}</span>${escapeHtml(line.msg)}`;
        list.appendChild(entry);
        while (list.children.length > MAX_LOG_LINES) list.removeChild(list.firstChild);
      }
      origConsole[level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'log')](...args);
    };
    addEventListener('error', (e) => forward('error')(`window error: ${e.message} @ ${e.filename}:${e.lineno}`));
    addEventListener('unhandledrejection', (e) => forward('error')(`unhandled rejection: ${e.reason}`));
    ['log', 'warn', 'error'].forEach((lvl) => {
      console[lvl] = (...args) => { forward(lvl)(...args); };
    });
  }

  // ---------------------------------------------------------------------
  // Starfield (lightweight canvas, GPU-friendly)
  // ---------------------------------------------------------------------
  function initStars() {
    const canvas = $('#bg-stars');
    const ctx = canvas.getContext('2d');
    let stars = [];
    let w, h, dpr;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.width = innerWidth * dpr;
      h = canvas.height = innerHeight * dpr;
      canvas.style.width = innerWidth + 'px';
      canvas.style.height = innerHeight + 'px';
      const count = Math.round((innerWidth * innerHeight) / 9000);
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.3 * dpr + 0.2,
        phase: Math.random() * Math.PI * 2,
        speed: 0.4 + Math.random() * 0.8,
      }));
    }
    resize();
    addEventListener('resize', resize, { passive: true });

    if (prefersReducedMotion) {
      // Static single paint, no animation loop.
      ctx.clearRect(0, 0, w, h);
      stars.forEach((s) => paintStar(ctx, s, 0.6));
      return;
    }

    let t0 = performance.now();
    function frame(t) {
      const dt = (t - t0) / 1000; t0 = t;
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        s.phase += dt * s.speed;
        const twinkle = 0.5 + 0.5 * Math.sin(s.phase);
        paintStar(ctx, s, twinkle);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  function paintStar(ctx, s, alpha) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(226,233,255,${(0.15 + alpha * 0.65).toFixed(2)})`;
    ctx.fill();
  }

  // ---------------------------------------------------------------------
  // Custom cursor
  // ---------------------------------------------------------------------
  function initCursor() {
    const el = $('#cursor-reticle');
    if (!el) return;
    let x = innerWidth / 2, y = innerHeight / 2, tx = x, ty = y;

    addEventListener('pointermove', (e) => { tx = e.clientX; ty = e.clientY; }, { passive: true });
    (function loop() {
      x += (tx - x) * 0.35; y += (ty - y) * 0.35;
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      requestAnimationFrame(loop);
    })();

    const hoverSelector = 'button, a, input, select, .keycap, [data-cursor-hover]';
    document.addEventListener('pointerover', (e) => {
      if (e.target.closest && e.target.closest(hoverSelector)) el.classList.add('hover');
    });
    document.addEventListener('pointerout', (e) => {
      if (e.target.closest && e.target.closest(hoverSelector)) el.classList.remove('hover');
    });
    document.addEventListener('pointerdown', () => {
      el.classList.add('active');
      const spark = document.createElement('span');
      spark.className = 'spark';
      el.appendChild(spark);
      setTimeout(() => spark.remove(), 520);
    });
    document.addEventListener('pointerup', () => el.classList.remove('active'));
  }

  // ---------------------------------------------------------------------
  // Effect grid
  // ---------------------------------------------------------------------
  function buildEffectGrid() {
    const grid = $('#effect-grid');
    const names = RGB.effectNames.length ? RGB.effectNames : Object.keys(EFFECT_META);
    names.forEach((name) => {
      const meta = EFFECT_META[name] || { label: name, preview: 'pv-solid' };
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'effect-tile';
      tile.dataset.effect = name;
      tile.setAttribute('role', 'option');
      tile.setAttribute('aria-selected', 'false');
      tile.innerHTML = `<span class="tile-preview ${meta.preview}"></span><span class="tile-label">${meta.label}</span>`;
      tile.addEventListener('click', () => selectEffect(name));
      grid.appendChild(tile);
    });
  }

  function selectEffect(name) {
    RGB.setEffect(name);
    const stage = $('.stage-center');
    stage.classList.toggle('paint-mode', name === 'per-key');
    if (name === 'per-key') {
      // The drag handler may have left an inline transform from a previous
      // tilt — inline beats the stylesheet, so clear it to let the CSS
      // flatten the keyboard and make every row hit-testable.
      const gimbal = $('#keyboard-gimbal');
      gimbal.style.transform = '';
      gimbal.style.transition = '';
      const drag = gimbal.__rgbDrag;
      if (drag) drag.reset();
    }
    $$('.effect-tile').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.effect === name)));
    $('#per-key-hint').hidden = name !== 'per-key';
    flyTransition(stage);
  }

  // ---------------------------------------------------------------------
  // Color controls
  // ---------------------------------------------------------------------
  function buildPresets() {
    const row = $('#preset-row');
    PRESET_COLORS.forEach((hex) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset-swatch';
      if (hex === SPECTRUM_SWATCH) {
        b.style.background = 'linear-gradient(135deg,#ff3b30,#ffcc00,#34c759,#00c7be,#007aff,#af52de)';
        b.title = 'Spectrum — paint the rainbow cycle onto individual keys';
        b.classList.add('preset-swatch-spectrum');
        b.addEventListener('click', () => {
          brushSpectrum = true;
          selectEffect('per-key');
        });
      } else {
        b.style.background = hex;
        b.title = hex;
        b.addEventListener('click', () => applyColor(hex));
      }
      row.appendChild(b);
    });
  }

  function applyColor(hex) {
    brushSpectrum = false;
    RGB.setColor(hex);
    $('#color-picker').value = hex;
    $('#hex-input').value = hex.toUpperCase();
  }

  function bindControls() {
    $('#color-picker').addEventListener('input', (e) => applyColor(e.target.value));
    $('#hex-input').addEventListener('change', (e) => {
      let v = e.target.value.trim();
      if (!v.startsWith('#')) v = '#' + v;
      if (/^#[0-9a-f]{6}$/i.test(v)) applyColor(v);
      else e.target.value = RGB.getState().color.toUpperCase();
    });

    const bSlider = $('#brightness-slider');
    const bValue = $('#brightness-value');
    bSlider.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      RGB.setBrightness(v);
      bValue.textContent = v + '%';
      bSlider.style.setProperty('--fill', v + '%');
    });

    const sSlider = $('#speed-slider');
    const sValue = $('#speed-value');
    sSlider.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      RGB.setSpeed(v);
      sValue.textContent = v + '%';
      sSlider.style.setProperty('--fill', v + '%');
    });

    $('#clear-per-key').addEventListener('click', () => RGB.clearPerKey());

    $('#error-banner-close').addEventListener('click', () => { $('#error-banner').hidden = true; });

    $('#connect-btn').addEventListener('click', async () => {
      const state = $('#status-pill').dataset.state;
      if (state === 'connected' || state === 'connecting' || state === 'reconnecting') {
        await RGB.disconnect(false);
      } else {
        await RGB.connect();
      }
    });
  }

  function hydrateFromState() {
    const s = RGB.getState();
    applyColor(s.color);
    const bSlider = $('#brightness-slider'), sSlider = $('#speed-slider');
    bSlider.value = s.brightness; bSlider.style.setProperty('--fill', s.brightness + '%');
    $('#brightness-value').textContent = s.brightness + '%';
    sSlider.value = s.speed; sSlider.style.setProperty('--fill', s.speed + '%');
    $('#speed-value').textContent = s.speed + '%';
    selectEffect(s.effect || 'solid');
  }

  // ---------------------------------------------------------------------
  // Status / log / connect button
  // ---------------------------------------------------------------------
  function handleStatus({ status, detail }) {
    const pill = $('#status-pill');
    const text = $('#status-text');
    const btn = $('#connect-btn');
    const label = $('#connect-label');
    pill.dataset.state = status;

    const copy = {
      idle: 'Standby',
      connecting: 'Connecting…',
      connected: `Linked${detail && detail.name ? ' · ' + detail.name : ''}`,
      reconnecting: 'Reconnecting…',
      error: `Error${detail ? ' · ' + detail : ''}`,
    };
    text.textContent = copy[status] || status;

    // Big, unmissable error banner (the Live log is easy to overlook).
    const banner = $('#error-banner');
    if (status === 'error' && detail) {
      $('#error-banner-text').textContent = String(detail);
      banner.hidden = false;
    } else if (status !== 'error') {
      banner.hidden = true;
    }

    if (status === 'connected') {
      btn.dataset.connected = 'true';
      label.textContent = 'Disconnect';
      $('#dd-device').textContent = (detail && detail.name) || '—';
      $('#dd-strategy').textContent = detail && detail.strategy
        ? `${detail.strategy.kind} #${detail.strategy.reportId} · ${detail.strategy.size}B` : '—';
      populateReportSelect();
    } else {
      btn.dataset.connected = 'false';
      label.textContent = status === 'connecting' ? 'Connecting…' : 'Connect keyboard';
      if (status === 'idle' || status === 'error') {
        $('#dd-device').textContent = '—';
        $('#dd-strategy').textContent = '—';
      }
    }
  }

  const MAX_LOG_LINES = 80;
  function handleLog({ t, msg, level }) {
    const list = $('#log-list');
    const entry = document.createElement('div');
    entry.className = `log-entry level-${level || 'info'}`;
    const time = new Date(t).toLocaleTimeString([], { hour12: false });
    entry.innerHTML = `<span class="t">${time}</span>${escapeHtml(msg)}`;
    list.appendChild(entry);
    while (list.children.length > MAX_LOG_LINES) list.removeChild(list.firstChild);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Modal asking the user to pick one unit when multiple Hydra 10s are
  // attached. Resolves with the chosen HIDDevice, or null on cancel.
  function pickDevice(devices) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'device-picker-overlay';

      const card = document.createElement('div');
      card.className = 'device-picker';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-label', 'Select keyboard');

      const title = document.createElement('h2');
      title.className = 'device-picker-title';
      title.textContent = 'Multiple Hydra 10 keyboards detected';

      const sub = document.createElement('p');
      sub.className = 'device-picker-sub';
      sub.textContent = `${devices.length} units found — pick which one to control:`;

      const list = document.createElement('div');
      list.className = 'device-picker-list';
      devices.forEach((d, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn device-picker-item';
        const name = d.productName || `HID device #${i + 1}`;
        const serial = d.serialNumber ? ` · ${d.serialNumber}` : '';
        b.innerHTML =
          `<span class="dp-badge">#${i + 1}</span>` +
          `<span class="dp-text">` +
            `<span class="dp-name">${escapeHtml(name)}</span>` +
            `<span class="dp-meta">VID 0x${RGB.VENDOR_ID.toString(16).toUpperCase()} / PID 0x${RGB.PRODUCT_ID.toString(16).toUpperCase()}${escapeHtml(serial)}</span>` +
          `</span>`;
        b.addEventListener('click', () => {
          overlay.remove();
          resolve(d);
        });
        list.appendChild(b);
      });

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn-ghost device-picker-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        overlay.remove();
        resolve(null);
      });

      card.appendChild(title);
      card.appendChild(sub);
      card.appendChild(list);
      card.appendChild(cancel);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.remove();
          resolve(null);
        }
      });
    });
  }

  // ---------------------------------------------------------------------
  // Debug panel
  // ---------------------------------------------------------------------
  function bindDebugPanel() {
    const panel = $('#debug-panel');
    const toggle = $('#debug-toggle');
    toggle.addEventListener('click', () => {
      const open = panel.dataset.open !== 'true';
      panel.dataset.open = String(open);
      toggle.setAttribute('aria-expanded', String(open));
    });
    // Always-open on wide layouts (CSS handles the fixed-overlay only <=1180px);
    // on narrow layouts it stays a manually-toggled overlay. Track live so a
    // resize/orientation change updates behaviour, not just the initial load.
    const wideQuery = matchMedia('(min-width: 1181px)');
    const syncWide = (e) => { panel.dataset.open = e.matches ? 'true' : 'false'; toggle.setAttribute('aria-expanded', String(e.matches)); };
    syncWide(wideQuery);
    wideQuery.addEventListener('change', syncWide);

    $('#send-test-btn').addEventListener('click', () => {
      const size = Number($('#report-size').value) || undefined;
      const sel = $('#report-select').value;
      let reportId;
      if (sel) reportId = Number(sel.split(':')[1]);
      RGB.sendTestReport(size, reportId);
    });

    $('#report-select').addEventListener('change', (e) => {
      const [kind, id] = e.target.value.split(':');
      if (!kind) return;
      const size = Number($('#report-size').value) || undefined;
      RGB.forceReportStrategy(kind, Number(id), size);
    });
  }

  function populateReportSelect() {
    const select = $('#report-select');
    const options = RGB.listReportOptions();
    select.innerHTML = '';
    if (!options.length) {
      const o = document.createElement('option');
      o.textContent = `feature #${RGB.DEFAULT_REPORT_ID} (default)`;
      o.value = `feature:${RGB.DEFAULT_REPORT_ID}`;
      select.appendChild(o);
      return;
    }
    options.forEach(({ kind, reportId }) => {
      const o = document.createElement('option');
      o.value = `${kind}:${reportId}`;
      o.textContent = `${kind} #${reportId}`;
      select.appendChild(o);
    });
  }

  // ---------------------------------------------------------------------
  // 3D keyboard
  // ---------------------------------------------------------------------
  const keycapEls = []; // parallel array to RGB.KEY_LAYOUT

  function buildKeyboard() {
    const body = $('#keyboard-body');
    const totalW = RGB.LAYOUT_TOTAL_W || 17.5;
    const rows = RGB.LAYOUT_ROWS || 5;

    RGB.KEY_LAYOUT.forEach((key, i) => {
      const cap = document.createElement('div');
      cap.className = 'keycap' + (key.nav ? ' keycap-nav' : '');
      cap.dataset.ledIndex = key.ledIndex;
      cap.style.left = (key.x / totalW * 100) + '%';
      cap.style.width = (key.w / totalW * 100) + '%';
      cap.style.top = (key.row / rows * 100) + '%';
      cap.style.height = (1 / rows * 100) + '%';

      const top = document.createElement('div');
      top.className = 'key-top';
      const label = document.createElement('span');
      label.className = 'key-label';
      label.textContent = ICONS[key.label] || key.label;
      top.appendChild(label);
      const edge = document.createElement('div');
      edge.className = 'key-edge';

      cap.appendChild(top);
      cap.appendChild(edge);
      body.appendChild(cap);
      keycapEls[i] = cap;
      cap.dataset.index = i;
    });

    // Paint by picking the keycap whose rendered bounding box contains the
    // pointer. The whole (large, easy-to-hit) keyboard body owns the press,
    // so we never depend on the browser hit-testing the tiny, foreshortened
    // top-row keycaps individually.
    body.addEventListener('pointerdown', (e) => {
      if (!isPaintMode()) return;
      const key = pickKey(e.clientX, e.clientY);
      if (key) {
        RGB.setPerKeyColor(key.ledIndex, brushSpectrum ? RGB.SPECTRUM : RGB.getState().color);
      }
    });
  }

  const ICONS = { Up: '\u2191', Down: '\u2193', Left: '\u2190', Right: '\u2192' };

  const isPaintMode = () => RGB.getState().effect === 'per-key';

  function pickKey(px, py) {
    let best = null;
    let bestRect = null;
    for (let i = 0; i < keycapEls.length; i++) {
      const cap = keycapEls[i];
      if (!cap) continue;
      const r = cap.getBoundingClientRect();
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
        return RGB.KEY_LAYOUT[Number(cap.dataset.index)];
      }
      // Track nearest centre as a fallback for pressing in the gutters.
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const d = Math.hypot(px - cx, py - cy);
      if (!best || d < best.d) { best = { key: RGB.KEY_LAYOUT[i], d }; }
    }
    return best && best.d < 28 ? best.key : null;
  }

  function renderFrame(perLed) {
    for (let i = 0; i < keycapEls.length; i++) {
      const cap = keycapEls[i];
      if (!cap) continue;
      const ledIndex = RGB.KEY_LAYOUT[i].ledIndex;
      const [r, g, b] = perLed[ledIndex] || [0, 0, 0];
      const top = cap.firstChild;
      if (!top) continue;
      const bright = (r + g + b) / 3;
      top.style.backgroundColor = `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
      top.style.boxShadow = bright > 6
        ? `inset 0 1px 0 rgba(255,255,255,.18), 0 0 ${6 + bright / 8}px rgba(${r | 0},${g | 0},${b | 0},.85)`
        : 'inset 0 1px 0 rgba(255,255,255,.08)';
    }
  }

  // ---------------------------------------------------------------------
  // Pointer-drag rotation of the keyboard gimbal
  // ---------------------------------------------------------------------
  function bindGimbalDrag() {
    const gimbal = $('#keyboard-gimbal');
    const BASE = { rx: 38, rz: -18 };
    const DRAG_THRESHOLD = 4; // px moved before we treat it as a drag
    let rx = BASE.rx, ry = 0;
    let activePointer = null;
    let startX = 0, startY = 0, lastX = 0, lastY = 0;

    apply();
    function apply() {
      // When paint mode flattens the keyboard (CSS), don't fight it with an
      // inline transform — inline styles beat the stylesheet rule.
      if ($('.stage-center').classList.contains('paint-mode')) {
        gimbal.style.transform = '';
        return;
      }
      gimbal.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;
    }
    function reset() {
      rx = BASE.rx; ry = 0; activePointer = null;
      apply();
    }
    gimbal.__rgbDrag = { reset };
    function springBack() {
      gimbal.style.transition = 'transform .6s var(--ease-spring)';
      rx = BASE.rx; ry *= 0.15;
      activePointer = null;
      apply();
    }

    gimbal.addEventListener('pointerdown', (e) => {
      if (!(e.buttons & 1)) return; // primary button only
      // In per-key paint mode the whole keyboard click area belongs to the
      // keys — don't start any drag so every click paints reliably, not
      // even the tops rows where a 1px jitter would otherwise cross the
      // drag threshold and swallow the click.
      if (isPaintMode()) return;
      activePointer = e.pointerId;
      lastX = startX = e.clientX; lastY = startY = e.clientY;
      gimbal.style.transition = 'none';
    });
    gimbal.addEventListener('pointermove', (e) => {
      // Ignore moves that aren't part of an active primary-button press.
      if (activePointer === null || !(e.buttons & 1)) return;
      if (!gimbal.hasPointerCapture(e.pointerId)) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) <= DRAG_THRESHOLD) return;
        gimbal.setPointerCapture(e.pointerId);
      }
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      ry = Math.max(-60, Math.min(60, ry + dx * 0.35));
      rx = Math.max(20, Math.min(80, rx - dy * 0.25));
      apply();
    });
    gimbal.addEventListener('pointerup', (e) => {
      if (activePointer === null || e.pointerId !== activePointer) return;
      springBack();
    });
    gimbal.addEventListener('pointercancel', (e) => {
      if (activePointer === null || e.pointerId !== activePointer) return;
      springBack();
    });
  }

  // ---------------------------------------------------------------------
  // 3D "fly" transition helper — brief perspective flip on state changes
  // ---------------------------------------------------------------------
  function flyTransition(el) {
    if (prefersReducedMotion || !el) return;
    el.animate(
      [
        { transform: 'perspective(900px) rotateY(0deg)' },
        { transform: 'perspective(900px) rotateY(4deg)' },
        { transform: 'perspective(900px) rotateY(0deg)' },
      ],
      { duration: 480, easing: 'cubic-bezier(.22,1,.36,1)' }
    );
  }
})();
