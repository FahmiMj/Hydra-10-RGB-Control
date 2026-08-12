/**
 * core.js — Portronics Hydra 10 (SinoWealth 68-key) RGB engine
 * ------------------------------------------------------------
 * WebHID transport, effect math, and packet builder, exposed as a small
 * public API (window.RGB) that the UI layer drives.
 *
 * Protocol notes
 *   - VID/PID, report ID 6, 519-byte feature report, 7-byte header,
 *     96-LED x 3-byte RGB buffer, zero-padded tail.
 *   - The 68 key -> LED-index mapping comes from the official SinoWealth
 *     plugin, so ledIndex values reflect the real hardware indices.
 *   - Report-strategy auto-detection, streaming cadence, worker ticker,
 *     localStorage persistence, and auto-reconnect are all implemented
 *     here; no UI code lives in this file.
 */

const RGB = (() => {
  'use strict';

  // ---------------------------------------------------------------------
  // Protocol constants
  // ---------------------------------------------------------------------
  const VENDOR_ID = 0x258A;
  const PRODUCT_ID = 0x010C;

  const DEFAULT_REPORT_ID = 6;
  const REPORT_SIZE = 519; // total payload length, including RGB data + padding
  const HEADER = [0x08, 0x00, 0x00, 0x01, 0x00, 0x7A, 0x01]; // 7 bytes, fixed
  const HEADER_NO_ID = [0x06, 0x08, 0x00, 0x00, 0x01, 0x00, 0x7A, 0x01]; // 8 bytes, full packet for output report (report ID 0)
  const LED_COUNT = 96;
  const RGB_BYTES = LED_COUNT * 3; // 288
  const PAD_BYTES = REPORT_SIZE - HEADER.length - RGB_BYTES; // 224 zero bytes
  const SPECTRUM = '__spectrum__'; // special per-key value: cycles the full rainbow on that key

  // Verified 68 physical keys -> LED index mapping, taken from the working
  // Portronics Hydra 10 SinoWealth plugin. Order: 5 physical rows, in
  // reading order 15/15/14/14/10 keys, each mapping to its LED strip index
  // (0..95). The on-screen geometry below (label/row/x/w) models the real
  // board — a 65%-style TKL: 60% base block (no F-row; those are Fn+number
  // shortcuts on the real board) + a 4-key nav column (Del/Home/PgUp/PgDn)
  // + a 65%-style arrow cluster, Fn on the right of the bottom row. The
  // ledIndex values are the ones the hardware actually uses.
  const KEY_LAYOUT = [
    { label: "Esc", row: 0, x: 0, w: 1, ledIndex: 1, colFrac: 0.0286 },
    { label: "1", row: 0, x: 1, w: 1, ledIndex: 7, colFrac: 0.0857 },
    { label: "2", row: 0, x: 2, w: 1, ledIndex: 13, colFrac: 0.1429 },
    { label: "3", row: 0, x: 3, w: 1, ledIndex: 19, colFrac: 0.2 },
    { label: "4", row: 0, x: 4, w: 1, ledIndex: 25, colFrac: 0.2571 },
    { label: "5", row: 0, x: 5, w: 1, ledIndex: 31, colFrac: 0.3143 },
    { label: "6", row: 0, x: 6, w: 1, ledIndex: 37, colFrac: 0.3714 },
    { label: "7", row: 0, x: 7, w: 1, ledIndex: 43, colFrac: 0.4286 },
    { label: "8", row: 0, x: 8, w: 1, ledIndex: 49, colFrac: 0.4857 },
    { label: "9", row: 0, x: 9, w: 1, ledIndex: 55, colFrac: 0.5429 },
    { label: "0", row: 0, x: 10, w: 1, ledIndex: 61, colFrac: 0.6 },
    { label: "-", row: 0, x: 11, w: 1, ledIndex: 67, colFrac: 0.6571 },
    { label: "=", row: 0, x: 12, w: 1, ledIndex: 73, colFrac: 0.7143 },
    { label: "Backspace", row: 0, x: 13, w: 2, ledIndex: 79, colFrac: 0.8 },
    { label: "Del", row: 0, x: 16.25, w: 1, ledIndex: 91, colFrac: 0.9571, nav: true },
    { label: "Tab", row: 1, x: 0, w: 1.5, ledIndex: 2, colFrac: 0.0429 },
    { label: "Q", row: 1, x: 1.5, w: 1, ledIndex: 8, colFrac: 0.1143 },
    { label: "W", row: 1, x: 2.5, w: 1, ledIndex: 14, colFrac: 0.1714 },
    { label: "E", row: 1, x: 3.5, w: 1, ledIndex: 20, colFrac: 0.2286 },
    { label: "R", row: 1, x: 4.5, w: 1, ledIndex: 26, colFrac: 0.2857 },
    { label: "T", row: 1, x: 5.5, w: 1, ledIndex: 32, colFrac: 0.3429 },
    { label: "Y", row: 1, x: 6.5, w: 1, ledIndex: 38, colFrac: 0.4 },
    { label: "U", row: 1, x: 7.5, w: 1, ledIndex: 44, colFrac: 0.4571 },
    { label: "I", row: 1, x: 8.5, w: 1, ledIndex: 50, colFrac: 0.5143 },
    { label: "O", row: 1, x: 9.5, w: 1, ledIndex: 56, colFrac: 0.5714 },
    { label: "P", row: 1, x: 10.5, w: 1, ledIndex: 62, colFrac: 0.6286 },
    { label: "[", row: 1, x: 11.5, w: 1, ledIndex: 68, colFrac: 0.6857 },
    { label: "]", row: 1, x: 12.5, w: 1, ledIndex: 74, colFrac: 0.7429 },
    { label: "\\", row: 1, x: 13.5, w: 1.5, ledIndex: 80, colFrac: 0.8143 },
    { label: "Home", row: 1, x: 16.25, w: 1, ledIndex: 92, colFrac: 0.9571, nav: true },
    { label: "Caps", row: 2, x: 0, w: 1.75, ledIndex: 3, colFrac: 0.05 },
    { label: "A", row: 2, x: 1.75, w: 1, ledIndex: 9, colFrac: 0.1286 },
    { label: "S", row: 2, x: 2.75, w: 1, ledIndex: 15, colFrac: 0.1857 },
    { label: "D", row: 2, x: 3.75, w: 1, ledIndex: 21, colFrac: 0.2429 },
    { label: "F", row: 2, x: 4.75, w: 1, ledIndex: 27, colFrac: 0.3 },
    { label: "G", row: 2, x: 5.75, w: 1, ledIndex: 33, colFrac: 0.3571 },
    { label: "H", row: 2, x: 6.75, w: 1, ledIndex: 39, colFrac: 0.4143 },
    { label: "J", row: 2, x: 7.75, w: 1, ledIndex: 45, colFrac: 0.4714 },
    { label: "K", row: 2, x: 8.75, w: 1, ledIndex: 51, colFrac: 0.5286 },
    { label: "L", row: 2, x: 9.75, w: 1, ledIndex: 57, colFrac: 0.5857 },
    { label: ";", row: 2, x: 10.75, w: 1, ledIndex: 63, colFrac: 0.6429 },
    { label: "'", row: 2, x: 11.75, w: 1, ledIndex: 69, colFrac: 0.7 },
    { label: "Enter", row: 2, x: 12.75, w: 2.25, ledIndex: 81, colFrac: 0.7929 },
    { label: "PgUp", row: 2, x: 16.25, w: 1, ledIndex: 93, colFrac: 0.9571, nav: true },
    { label: "Shift", row: 3, x: 0, w: 2.25, ledIndex: 4, colFrac: 0.0643 },
    { label: "Z", row: 3, x: 2.25, w: 1, ledIndex: 10, colFrac: 0.1571 },
    { label: "X", row: 3, x: 3.25, w: 1, ledIndex: 16, colFrac: 0.2143 },
    { label: "C", row: 3, x: 4.25, w: 1, ledIndex: 22, colFrac: 0.2714 },
    { label: "V", row: 3, x: 5.25, w: 1, ledIndex: 28, colFrac: 0.3286 },
    { label: "B", row: 3, x: 6.25, w: 1, ledIndex: 34, colFrac: 0.3857 },
    { label: "N", row: 3, x: 7.25, w: 1, ledIndex: 40, colFrac: 0.4429 },
    { label: "M", row: 3, x: 8.25, w: 1, ledIndex: 46, colFrac: 0.5 },
    { label: ",", row: 3, x: 9.25, w: 1, ledIndex: 52, colFrac: 0.5571 },
    { label: ".", row: 3, x: 10.25, w: 1, ledIndex: 58, colFrac: 0.6143 },
    { label: "/", row: 3, x: 11.25, w: 1, ledIndex: 64, colFrac: 0.6714 },
    { label: "Shift", row: 3, x: 12.25, w: 1.75, ledIndex: 82, colFrac: 0.75 },
    { label: "Up", row: 3, x: 15.25, w: 1, ledIndex: 88, colFrac: 0.9, nav: true },
    { label: "PgDn", row: 3, x: 16.25, w: 1, ledIndex: 94, colFrac: 0.9571, nav: true },
    { label: "Ctrl", row: 4, x: 0, w: 1.25, ledIndex: 5, colFrac: 0.0357 },
    { label: "Win", row: 4, x: 1.25, w: 1.25, ledIndex: 11, colFrac: 0.1071 },
    { label: "Alt", row: 4, x: 2.5, w: 1.25, ledIndex: 17, colFrac: 0.1786 },
    { label: "Space", row: 4, x: 3.75, w: 6.25, ledIndex: 35, colFrac: 0.3929 },
    { label: "Alt", row: 4, x: 10, w: 1.25, ledIndex: 53, colFrac: 0.6071 },
    { label: "Fn", row: 4, x: 11.25, w: 1.25, ledIndex: 59, colFrac: 0.6786 },
    { label: "Ctrl", row: 4, x: 12.5, w: 1.25, ledIndex: 65, colFrac: 0.75 },
    { label: "Left", row: 4, x: 14, w: 1, ledIndex: 83, colFrac: 0.8286, nav: true },
    { label: "Down", row: 4, x: 15.25, w: 1, ledIndex: 89, colFrac: 0.9, nav: true },
    { label: "Right", row: 4, x: 16.25, w: 1, ledIndex: 95, colFrac: 0.9571, nav: true },
  ];
  const LED_LAYOUT = KEY_LAYOUT.map((k) => k.ledIndex);
  const LAYOUT_TOTAL_W = 17.5; // key-units, for physical rendering
  const LAYOUT_ROWS = 5;

  if (LED_LAYOUT.length !== 68) {
    console.warn('[RGB] LED_LAYOUT does not have 68 entries — check the KEY_LAYOUT mapping.');
  }

  // ---------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------
  let device = null;
  let reportStrategy = null; // { kind: 'feature'|'output', reportId, size }
  let statusCb = null;
  let frameCb = null;
  let logCb = null;

  let rafHandle = null;
  let worker = null;
  let visibilityBound = false;
  let reconnectTimer = null;
  let lastFrameTime = 0;
  let fpsWindow = [];
  let fpsCb = null;
  let pickCb = null; // async (device[]) => HIDDevice | null
  let isSending = false;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 5;

  const state = loadState();

  function loadState() {
    const fallback = {
      effect: 'solid',
      color: '#22d3ee',
      brightness: 100,
      speed: 50,
      perKey: {}, // ledIndex -> '#rrggbb'
    };
    try {
      const raw = localStorage.getItem('rgb-hud-state');
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return { ...fallback, ...parsed };
    } catch (e) {
      return fallback;
    }
  }

  function saveState() {
    try {
      localStorage.setItem('rgb-hud-state', JSON.stringify(state));
    } catch (e) { /* storage unavailable, non-fatal */ }
  }

  function log(msg, level = 'info') {
    const line = { t: Date.now(), msg, level };
    if (logCb) logCb(line);
  }

  function setStatus(status, detail) {
    if (statusCb) statusCb({ status, detail });
  }

  // ---------------------------------------------------------------------
  // Color helpers
  // ---------------------------------------------------------------------
  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return [255, 255, 255];
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  }

  function hex(v) {
    return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(4, '0');
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
  }

  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r, g, b;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  function scaleBrightness([r, g, b], pct) {
    const k = Math.max(0, Math.min(100, pct)) / 100;
    return [r * k, g * k, b * k];
  }

  // Speed slider (0-100) -> a per-effect time multiplier. Kept as one
  // curve so every effect feels consistent as you drag the slider.
  function speedFactor() {
    return 0.15 + (state.speed / 100) * 2.35; // ~0.15x .. 2.5x
  }

  // ---------------------------------------------------------------------
  // Effect math — produces an [r,g,b] per key for a given time `t` (ms)
  // ---------------------------------------------------------------------
  const EFFECTS = {
    off() {
      return () => [0, 0, 0];
    },
    solid() {
      const base = scaleBrightness(hexToRgb(state.color), state.brightness);
      return () => base;
    },
    breathing() {
      const [r, g, b] = hexToRgb(state.color);
      return (t) => {
        const phase = (t * 0.001 * speedFactor()) % (2 * Math.PI);
        const wave = (Math.sin(phase) + 1) / 2; // 0..1
        const k = 0.08 + wave * 0.92;
        return scaleBrightness([r, g, b], state.brightness * k);
      };
    },
    'spectrum-cycle'() {
      return (t) => {
        const hue = (t * 0.06 * speedFactor()) % 360;
        return scaleBrightness(hsvToRgb(hue, 1, 1), state.brightness);
      };
    },
    rainbow() {
      return (t, key) => {
        const hue = ((key.colFrac * 360) + t * 0.03 * speedFactor()) % 360;
        return scaleBrightness(hsvToRgb(hue, 1, 1), state.brightness);
      };
    },
    'rainbow-wave'() {
      return (t, key) => {
        const hue = (key.row * 40 + key.colFrac * 220 + t * 0.08 * speedFactor()) % 360;
        return scaleBrightness(hsvToRgb(hue, 0.95, 1), state.brightness);
      };
    },
    'pulse-wave'() {
      const [r, g, b] = hexToRgb(state.color);
      return (t, key) => {
        const centerCol = 0.5, centerRow = 2;
        const dist = Math.hypot(key.colFrac - centerCol, (key.row - centerRow) / 4);
        const phase = (t * 0.0035 * speedFactor()) - dist * 4.2;
        const wave = (Math.sin(phase) + 1) / 2;
        const k = 0.06 + wave * 0.94;
        return scaleBrightness([r, g, b], state.brightness * k);
      };
    },
    'per-key'() {
      return (t, key) => {
        const val = state.perKey[key.ledIndex];
        if (!val) return [0, 0, 0];
        if (val === SPECTRUM) {
          const hue = (key.colFrac * 360 + t * 0.03 * speedFactor()) % 360;
          return scaleBrightness(hsvToRgb(hue, 1, 1), state.brightness);
        }
        return scaleBrightness(hexToRgb(val), state.brightness);
      };
    },
  };

  function computeFrame(t) {
    const fn = (EFFECTS[state.effect] || EFFECTS.solid)();
    const perLed = new Array(LED_COUNT).fill(null).map(() => [0, 0, 0]);
    for (const key of KEY_LAYOUT) {
      perLed[key.ledIndex] = fn(t, key);
    }
    return perLed;
  }

  // ---------------------------------------------------------------------
  // Packet builder
  // ---------------------------------------------------------------------
  function buildPacket(perLed) {
    const buf = new Uint8Array(REPORT_SIZE);
    buf.set(HEADER, 0);
    let offset = HEADER.length;
    for (let i = 0; i < LED_COUNT; i++) {
      const [r, g, b] = perLed[i];
      buf[offset++] = r & 0xff;
      buf[offset++] = g & 0xff;
      buf[offset++] = b & 0xff;
    }
    // remaining PAD_BYTES are already zero from Uint8Array init
    return buf;
  }

  // ---------------------------------------------------------------------
  // Transport — connect, strategy auto-detection, send
  // ---------------------------------------------------------------------
  async function connect() {
    if (!('hid' in navigator)) {
      setStatus('error', 'WebHID not supported in this browser');
      log('navigator.hid unavailable — use Chrome/Edge/Brave over localhost or HTTPS', 'error');
      return false;
    }
    try {
      setStatus('connecting');

      // Prefer already-granted devices (Electron's setDevicePermissionHandler
      // auto-grants HID access, so getDevices() returns the board without the
      // picker). Fall back to the device chooser only if nothing is granted.
      let devices = [];
      try {
        devices = await navigator.hid.getDevices();
        log(`getDevices(): ${devices.length} granted device(s)`);
      } catch (e) {
        log(`getDevices failed: ${e}`, 'warn');
      }

      // NEVER probe, link to, or auto-grant anything but the Hydra 10. Every
      // path back into the probe loop below is hard-filtered on VID/PID —
      // including the device-chooser result, which is re-checked in case the
      // browser's picker ever ignores the requestDevice() filter.
      devices = devices.filter(isHydra);
      if (!devices.length) {
        devices = (await navigator.hid.requestDevice({
          filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }],
        })).filter(isHydra);
        log(`requestDevice(): ${devices.length} Hydra device(s) returned`);
      }
      if (!devices.length) {
        setStatus('idle');
        return false;
      }

      // More than one Hydra 10 attached: hand them to the UI for selection
      // instead of silently grabbing the first unit. Falls back to the first
      // (with a warning) if no picker handler is wired up.
      if (devices.length > 1) {
        if (pickCb) {
          const chosen = await pickCb(devices);
          if (!chosen) {
            setStatus('idle');
            log('Device selection cancelled');
            return false;
          }
          devices = [chosen];
        } else {
          log(`${devices.length} Hydra devices found — no picker wired, using the first`, 'warn');
          devices = devices.slice(0, 1);
        }
      }

      // The keyboard exposes multiple HID interfaces. Report 6 (the RGB
      // bulk-channel) lives ONLY on the vendor interface (usage page
      // 0xFF00). The boot-keyboard interface can silently accept-and-pad a
      // feature write, so probe vendor-interface devices FIRST and pick the
      // first one that both accepts the write AND echoes it back.
      const vendorDevices = devices.filter(isVendorDevice);
      const ordered = [...vendorDevices, ...devices.filter((d) => !vendorDevices.includes(d))];

      let picked = null;
      for (const d of ordered) {
        device = d;
        try {
          if (!device.opened) await device.open();
        } catch (e) {
          continue;
        }
        const isVendor = isVendorDevice(d);
        log(`Probing ${device.productName || 'device'}${isVendor ? ' [VENDOR]' : ' [non-vendor]'}: ${summarizeCollections(device.collections)}`);
        if (await detectReportStrategy()) {
          // The board's RGB bulk-channel only exists on a vendor-page (0xFF00)
          // interface, and after a SET it echoes the command header back on
          // GET. A keyboard-only interface may accept feature writes but
          // ignore them (Windows), so: only accept an interface that is
          // vendor-page, OR that positively echoes the header.
          const echoed = await verifyEcho();
          if (echoed === true || isVendor) {
            picked = d;
            break;
          }
          log('Write accepted but interface is not vendor RGB — trying next interface', 'warn');
        }
      }

      if (!picked) {
        setStatus('error', 'No working report strategy found');
        log('Could not find a report the device accepts', 'error');
        return false;
      }
      // close interfaces we won't use
      for (const d of devices) {
        if (d !== picked) { try { await d.close(); } catch (e) {} }
      }

      device.addEventListener('inputreport', onInputReport);
      bindVisibility();
      startStreaming();
      setStatus('connected', { name: device.productName, strategy: reportStrategy });
      log(`Streaming via ${reportStrategy.kind} report #${reportStrategy.reportId} (${reportStrategy.size}B)`);
      return true;
    } catch (err) {
      const detail = {
        name: err && err.name,
        message: err && err.message,
        code: err && err.code,
      };
      setStatus('error', `${detail.name || 'Error'}: ${detail.message || err}`);
      log(`Connect failed: name=${detail.name} code=${detail.code} msg=${detail.message}`, 'error');
      log(`navigator.hid present=${'hid' in navigator}, vendor=${hex(VENDOR_ID)}/${hex(PRODUCT_ID)}`, 'debug');
      return false;
    }
  }

  async function detectReportStrategy(forced) {
    if (forced) {
      reportStrategy = forced;
      const testBuf = new Uint8Array(forced.size);
      const ok = await tryWrite(forced, testBuf);
      return ok;
    }

    // Known-working report formats for this board, probed in deterministic
    // order (the original verified plugin's order):
    //   1. Feature report #6  — 519-byte feature report, 7-byte header.
    //   2. Output report #0   — 520-byte interrupt OUT, 8-byte header.
    const proven = [
      { kind: 'feature', reportId: DEFAULT_REPORT_ID, size: REPORT_SIZE },
      { kind: 'output', reportId: 0, size: REPORT_SIZE + 1 },
    ];
    for (const cand of proven) {
      const testBuf = new Uint8Array(cand.size);
      testBuf.set(HEADER, 0);
      const ok = await tryWrite(cand, testBuf);
      if (ok) {
        reportStrategy = cand;
        log(`Using ${cand.kind} report #${cand.reportId} (${cand.size}B)`);
        return true;
      }
    }

    // Last-resort: scan whatever reports the HID collection advertises.
    const candidates = [];
    for (const col of device.collections) {
      const reportIds = new Set();
      (col.featureReports || []).forEach((r) => reportIds.add(r.reportId));
      (col.outputReports || []).forEach((r) => reportIds.add(r.reportId));
      reportIds.add(DEFAULT_REPORT_ID);
      for (const id of reportIds) {
        candidates.push({ kind: 'feature', reportId: id, size: REPORT_SIZE });
        candidates.push({ kind: 'output', reportId: id, size: REPORT_SIZE });
      }
    }
    candidates.sort((a, b) => (a.reportId === DEFAULT_REPORT_ID ? -1 : 1) - (b.reportId === DEFAULT_REPORT_ID ? -1 : 1));

    for (const cand of candidates) {
      const testBuf = new Uint8Array(cand.size);
      testBuf.set(HEADER, 0);
      const ok = await tryWrite(cand, testBuf);
      if (ok) {
        reportStrategy = cand;
        log(`Using ${cand.kind} report #${cand.reportId} (${cand.size}B)`);
        return true;
      }
    }
    return false;
  }

  async function tryWrite(strategy, buf) {
    try {
      if (strategy.kind === 'feature') {
        await device.sendFeatureReport(strategy.reportId, buf);
      } else {
        if (strategy.reportId === 0 && strategy.size === REPORT_SIZE + 1) {
          // Output report #0 carries the full 8-byte header (report ID byte + header).
          const pkt = new Uint8Array(REPORT_SIZE + 1);
          pkt.set(HEADER_NO_ID, 0);
          const body = buf.subarray(HEADER.length, HEADER.length + (REPORT_SIZE - HEADER.length));
          pkt.set(body, HEADER_NO_ID.length);
          await device.sendReport(0, pkt);
        } else {
          await device.sendReport(strategy.reportId, buf);
        }
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  // Strict identity check for the supported board. Every device list that can
  // reach the connect/probe path passes through this first.
  function isHydra(d) {
    return d && d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID;
  }

  // The board's RGB bulk-channel (report 6) exists only on collections with
  // the vendor usage page 0xFF00. Prefer devices whose collections expose one.
  function isVendorDevice(d) {
    return (d.collections || []).some(
      (c) => c.usagePage === 0xff00 || (c.featureReports || []).some((r) => r.reportId === DEFAULT_REPORT_ID)
    );
  }

  function summarizeCollections(cols) {
    if (!cols || !cols.length) return 'no collections';
    return cols
      .map((c) => {
        const feats = (c.featureReports || []).map((r) => r.reportId).join(',') || '-';
        return `page=0x${(c.usagePage >>> 0).toString(16)} feat[${feats}]`;
      })
      .join(' ; ');
  }

  // After writing a frame, try to read report 6 back. The vendor interface
  // echoes the 8-byte command header + payload; a bare keyboard interface
  // returns/basically nothing. If we get the header echoed, we are sure the
  // write landed on the interface the board actually reads.
  async function verifyEcho(strategyKey) {
    try {
      const before = performance.now();
      const view = await device.receiveFeatureReport(DEFAULT_REPORT_ID);
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      // The board echoes the 8-byte report (report ID 0x06 + 7-byte header).
      // WebHID's receiveFeatureReport returns data with the report-ID byte
      // stripped; guard against both by checking whichever prefix fits.
      const head = [DEFAULT_REPORT_ID, ...HEADER];
      const hasId = bytes[0] === DEFAULT_REPORT_ID;
      const ref = hasId ? head : HEADER;
      const match = ref.every((b, i) => bytes[i] === b);
      log(`Readback report #${DEFAULT_REPORT_ID}: ${bytes.length}B echoed=${match} hasId=${hasId} (${Math.round(performance.now() - before)}ms)`, 'debug');
      return match;
    } catch {
      log('Readback report 6 not supported on this interface', 'debug');
      return null; // cannot read back; non-vendor interfaces get rejected anyway
    }
  }

  function onInputReport(e) {
    // The board doesn't push meaningful telemetry today; hook kept for
    // future firmware / debug echo without touching the streaming path.
    log(`inputreport id=${e.reportId} len=${e.data.byteLength}`, 'debug');
  }

  async function sendFrame(perLed) {
    // Never overlap writes: the USB device can't queue them. If a frame is
    // still in flight (async write outstanding), drop this one and let the
    // next rAF tick carry the latest frame data instead.
    if (!device || !device.opened || !reportStrategy || isSending) return;
    isSending = true;
    const buf = buildPacket(perLed);
    const ok = await tryWrite(reportStrategy, buf);
    isSending = false;

    // Only re-detect after repeated failures, not on every rejection —
    // a single hiccup should not tear down the working stream.
    if (ok) {
      consecutiveFailures = 0;
      return;
    }
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      consecutiveFailures = 0;
      log('Frame write rejected repeatedly — re-detecting report strategy', 'warn');
      await detectReportStrategy();
    }
  }

  async function sendTestReport(overrideSize, overrideReportId) {
    const size = overrideSize || (reportStrategy ? reportStrategy.size : REPORT_SIZE);
    const reportId = overrideReportId != null ? overrideReportId : (reportStrategy ? reportStrategy.reportId : DEFAULT_REPORT_ID);
    const strategy = { kind: reportStrategy ? reportStrategy.kind : 'feature', reportId, size };
    const buf = new Uint8Array(size);
    buf.set(HEADER.slice(0, Math.min(HEADER.length, size)), 0);
    const ok = await tryWrite(strategy, buf);
    log(`Test report -> id ${reportId}, ${size}B via ${strategy.kind}: ${ok ? 'accepted' : 'rejected'}`, ok ? 'info' : 'error');
    return ok;
  }

  async function disconnect(auto) {
    stopStreaming();
    if (device) {
      try { device.removeEventListener('inputreport', onInputReport); } catch (e) {}
      try { await device.close(); } catch (e) {}
    }
    device = null;
    reportStrategy = null;
    setStatus(auto ? 'reconnecting' : 'idle');
    log(auto ? 'Device disconnected — will retry' : 'Disconnected');
    if (auto) scheduleReconnect();
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
      if (!navigator.hid) return;
      const known = await navigator.hid.getDevices();
      const match = known.find((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);
      if (match) {
        device = match;
        try {
          if (!device.opened) await device.open();
          const ok = await detectReportStrategy();
          if (ok) {
            device.addEventListener('inputreport', onInputReport);
            startStreaming();
            setStatus('connected', { name: device.productName, strategy: reportStrategy });
            log('Auto-reconnected');
            return;
          }
        } catch (e) { /* fall through to retry */ }
      }
      scheduleReconnect();
    }, 2500);
  }

  if (typeof navigator !== 'undefined' && navigator.hid) {
    navigator.hid.addEventListener('disconnect', (e) => {
      if (device && e.device === device) disconnect(true);
    });
  }

  // ---------------------------------------------------------------------
  // Streaming loop — rAF in foreground, Worker ticker in background
  // ---------------------------------------------------------------------
  function tick(t) {
    const perLed = computeFrame(t);
    sendFrame(perLed);
    trackFps(t);
    if (frameCb) frameCb(perLed, KEY_LAYOUT);
  }

  function trackFps(t) {
    fpsWindow.push(t);
    while (fpsWindow.length && t - fpsWindow[0] > 1000) fpsWindow.shift();
    if (fpsWindow.length % 15 === 0 && fpsCb) {
      const dt = (fpsWindow[fpsWindow.length - 1] - fpsWindow[0]) / 1000 || 1;
      fpsCb(Math.round((fpsWindow.length - 1) / dt) || fpsWindow.length);
    }
  }

  function startStreaming() {
    stopStreaming();
    if (document.hidden) {
      startWorkerTicker();
    } else {
      const loop = (t) => {
        tick(t);
        rafHandle = requestAnimationFrame(loop);
      };
      rafHandle = requestAnimationFrame(loop);
    }
  }

  function stopStreaming() {
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = null;
    stopWorkerTicker();
  }

  function startWorkerTicker() {
    if (worker) return;
    try {
      worker = new Worker('ticker.js');
      worker.onmessage = (e) => {
        if (e.data === 'tick') tick(performance.now());
      };
      worker.postMessage({ cmd: 'start', fps: 30 });
    } catch (err) {
      log(`Worker ticker unavailable, falling back to rAF: ${err}`, 'warn');
      const loop = (t) => { tick(t); rafHandle = requestAnimationFrame(loop); };
      rafHandle = requestAnimationFrame(loop);
    }
  }

  function stopWorkerTicker() {
    if (!worker) return;
    worker.postMessage({ cmd: 'stop' });
    worker.terminate();
    worker = null;
  }

  function bindVisibility() {
    if (visibilityBound) return;
    visibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      if (!device) return;
      // Immediate refresh + strategy swap on visibility change, per spec.
      tick(performance.now());
      startStreaming();
    });
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------
  function setEffect(name) {
    if (!EFFECTS[name]) return;
    state.effect = name;
    saveState();
  }
  function setColor(hex) {
    state.color = hex;
    saveState();
  }
  function setBrightness(pct) {
    state.brightness = Math.max(0, Math.min(100, pct));
    saveState();
  }
  function setSpeed(pct) {
    state.speed = Math.max(0, Math.min(100, pct));
    saveState();
  }
  function setPerKeyColor(ledIndex, hex) {
    state.perKey[ledIndex] = hex;
    saveState();
  }
  function clearPerKey() {
    state.perKey = {};
    saveState();
  }
  function getState() {
    return JSON.parse(JSON.stringify(state));
  }
  function onStatus(cb) { statusCb = cb; }
  function onFrame(cb) { frameCb = cb; }
  function onLog(cb) { logCb = cb; }
  function onFps(cb) { fpsCb = cb; }
  function onPickDevice(cb) { pickCb = cb; }

  function listReportOptions() {
    if (!device) return [];
    const out = [];
    for (const col of device.collections) {
      (col.featureReports || []).forEach((r) => out.push({ kind: 'feature', reportId: r.reportId }));
      (col.outputReports || []).forEach((r) => out.push({ kind: 'output', reportId: r.reportId }));
    }
    return out;
  }

  function forceReportStrategy(kind, reportId, size) {
    detectReportStrategy({ kind, reportId, size: size || REPORT_SIZE });
  }

  return {
    VENDOR_ID, PRODUCT_ID, DEFAULT_REPORT_ID, REPORT_SIZE, LED_COUNT, SPECTRUM,
    LED_LAYOUT, KEY_LAYOUT, LAYOUT_TOTAL_W, LAYOUT_ROWS,
    connect, disconnect, sendTestReport,
    setEffect, setColor, setBrightness, setSpeed, setPerKeyColor, clearPerKey,
    getState, onStatus, onFrame, onLog, onFps,
    onPickDevice,
    listReportOptions, forceReportStrategy,
    effectNames: Object.keys(EFFECTS),
    hexToRgb, rgbToHex,
  };
})();

if (typeof window !== 'undefined') window.RGB = RGB;
