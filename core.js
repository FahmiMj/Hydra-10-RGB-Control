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
  const PRODUCT_ID = 0x010C; // wired USB build

  // 2.4GHz receiver (Compx 3554:fa09, used across the F75/Hydra 10 family).
  // It does NOT carry the wired 519-byte feature protocol; it speaks a
  // chunked output-report protocol on interface 1 (vendor page 0xFF02).
  const DONGLE_VID = 0x3554;
  const DONGLE_PID = 0xFA09;
  const DONGLE_REPORT_ID = 0x13;
  const DONGLE_REPORT_SIZE = 19;
  const DONGLE_CHUNK = 14; // payload bytes per 19-byte output report
  const DONGLE_MAX_CHUNKS = 10; // <- keep a single frame under the link budget
  const DONGLE_CHUNK_GAP_MS = 13; // vendor-measured minimum, start-to-start
  const DONGLE_CMD_LIGHTING = 0x88; // the ONLY command this app ever sends
  // Measured clean ceiling is ~64 chunks/s; 60 leaves a small safety margin.
  // Pace by chunks, not frames: a sparse frame can run more often than a
  // full-board one on the same link.
  const DONGLE_CHUNKS_PER_SEC = 60;
  // Re-send a full 96-slot frame at least this often. The unmapped slots are
  // held black; refreshing them inside the firmware's repaint window keeps the
  // keyboard's own effect from flashing through.
  const DONGLE_KEYFRAME_MS = 1000;

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
  // 68 mapped key LEDs vs. all 96 matrix slots (the rest are held black).
  const KEY_LED_INDICES = LED_LAYOUT;
  const ALL_LED_INDICES = Array.from({ length: LED_COUNT }, (_, i) => i);
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

  // 2.4GHz support is opt-in. The receiver's protocol is different from the
  // wired board's, so lighting writes stay blocked until the user has
  // inspected the dongle and explicitly allowed them for this session.
  let transport = loadTransport();
  let dongleWritesConfirmed = false;
  let sendIntervalMs = 0; // wired pacing only; the dongle paces by chunks/s
  let lastDongleKeyHash = null;
  let lastDongleFullAt = 0;
  let lastDongleFrameAt = 0;

  const state = loadState();

  function loadTransport() {
    const fallback = { dongle: false, vid: DONGLE_VID, pid: DONGLE_PID };
    try {
      const vid = parseInt(localStorage.getItem('rgb-dongle-vid') || '', 16);
      const pid = parseInt(localStorage.getItem('rgb-dongle-pid') || '', 16);
      return {
        dongle: localStorage.getItem('rgb-dongle-enabled') === '1',
        vid: Number.isFinite(vid) && vid > 0 ? vid : DONGLE_VID,
        pid: Number.isFinite(pid) && pid > 0 ? pid : DONGLE_PID,
      };
    } catch (e) {
      return fallback;
    }
  }

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
  // 2.4GHz dongle frame builder
  // ---------------------------------------------------------------------
  // Frame (20B on the wire, 19B in WebHID's sendReport payload):
  //   [0x13][cmd][totalChunks][chunkIndex][0x10+len][14 payload][checksum]
  // Lighting payload is a sequence of groups: [R,G,B,count,ledIndex...].
  // Only command 0x88 (live lighting) is ever emitted. The config command
  // 0x04 is deliberately not implemented: it writes non-volatile storage.
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, max === 0 ? 0 : d / max, max];
  }

  function quantizeHsv(rgb, hSteps, sSteps, vSteps) {
    const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    if (v < 0.04) return [0, 0, 0];
    const hq = hSteps <= 1 ? 0 : (Math.round((h / 360) * hSteps) % hSteps);
    const sq = sSteps <= 1 ? s : Math.round(s * (sSteps - 1)) / (sSteps - 1);
    // Floor non-black colours to one value step so dim effects don't vanish.
    const vq = vSteps <= 1 ? v : Math.max(1 / (vSteps - 1), Math.round(v * (vSteps - 1)) / (vSteps - 1));
    return hsvToRgb((hq / hSteps) * 360, sq, vq);
  }

  function buildDongleGroups(perLed, palette, indices) {
    const buckets = new Map();
    for (const i of indices) {
      let c = perLed[i] || [0, 0, 0];
      c = [c[0] | 0, c[1] | 0, c[2] | 0];
      if (!palette.exact) c = quantizeHsv(c, palette.h, palette.s, palette.v);
      const k = `${c[0]},${c[1]},${c[2]}`;
      if (!buckets.has(k)) buckets.set(k, { color: c, indices: [] });
      buckets.get(k).indices.push(i);
    }
    return Array.from(buckets.values());
  }

  function encodeDongleGroups(groups) {
    const out = [];
    for (const g of groups) {
      out.push(g.color[0], g.color[1], g.color[2], g.indices.length);
      for (const idx of g.indices) out.push(idx);
    }
    return out;
  }

  function chunkDonglePayload(payload) {
    if (!payload.length) return [];
    const total = Math.ceil(payload.length / DONGLE_CHUNK);
    if (total > 255) return [];
    const chunks = [];
    for (let i = 0; i < total; i++) {
      const part = payload.slice(i * DONGLE_CHUNK, (i + 1) * DONGLE_CHUNK);
      const data = new Uint8Array(DONGLE_REPORT_SIZE);
      data[0] = DONGLE_CMD_LIGHTING;
      data[1] = total;
      data[2] = i;
      data[3] = 0x10 + part.length;
      for (let j = 0; j < part.length; j++) data[4 + j] = part[j];
      // Checksum covers the real report-ID byte (0x13) + bytes 0..17.
      let sum = DONGLE_REPORT_ID;
      for (let j = 0; j < 18; j++) sum = (sum + data[j]) & 0xff;
      data[18] = sum;
      chunks.push(data);
    }
    return chunks;
  }

  const DONGLE_PALETTES = [
    { exact: true },
    { h: 12, s: 2, v: 4 },
    { h: 8, s: 2, v: 3 },
    { h: 6, s: 2, v: 2 },
    { h: 4, s: 2, v: 2 },
    { h: 3, s: 2, v: 1 },
    { h: 2, s: 2, v: 1 },
    { h: 1, s: 1, v: 1 },
  ];

  function averageDongleGroups(perLed, indices) {
    let r = 0, g = 0, b = 0;
    for (const i of indices) {
      const c = perLed[i] || [0, 0, 0];
      r += c[0]; g += c[1]; b += c[2];
    }
    return [{
      color: [Math.round(r / indices.length), Math.round(g / indices.length), Math.round(b / indices.length)],
      indices,
    }];
  }

  // Pick the richest palette that still fits one frame's chunk budget.
  // `indices` lets the animation path send only the 68 key LEDs, while the
  // periodic keyframe covers all 96 slots so the unmapped ones stay black.
  function buildDongleChunks(perLed, indices) {
    const slots = indices || ALL_LED_INDICES;
    for (const palette of DONGLE_PALETTES) {
      const chunks = chunkDonglePayload(encodeDongleGroups(buildDongleGroups(perLed, palette, slots)));
      if (chunks.length && chunks.length <= DONGLE_MAX_CHUNKS) return chunks;
    }
    return chunkDonglePayload(encodeDongleGroups(averageDongleGroups(perLed, slots)));
  }

  function hashChunks(chunks) {
    let h = 2166136261 >>> 0;
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++) {
        h ^= c[i];
        h = Math.imul(h, 16777619);
      }
    }
    return h >>> 0;
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

      // NEVER probe, link to, or auto-grant anything but supported Hydra
      // hardware. Every path back into the probe loop below is hard-filtered
      // on VID/PID — including the device-chooser result, which is re-checked
      // in case the browser's picker ever ignores the requestDevice() filter.
      devices = devices.filter(isHydra);
      if (!devices.length) {
        const raw = await navigator.hid.requestDevice({ filters: deviceFilters() });
        devices = raw.filter(isHydra);
        log(`requestDevice(): ${devices.length} supported device(s) returned`);
        if (raw.length && !devices.length) {
          log(`Picker returned ${raw.map((d) => `0x${d.vendorId.toString(16)}:0x${d.productId.toString(16)}`).join(', ')} — none matched a supported ID`, 'warn');
        }
      }
      if (!devices.length) {
        if (transport.dongle) {
          log(`Dongle mode is on but no matching receiver was found. Expected 0x${DONGLE_VID.toString(16)}:0x${DONGLE_PID.toString(16)} (or the manual VID:PID).`, 'warn');
        }
        setStatus('idle');
        return false;
      }

      // If dongle mode was requested but only the wired board is present, say
      // so plainly instead of silently switching transport.
      if (transport.dongle && devices.every((d) => transportMode(d) === 'wired')) {
        log('Dongle mode is on, but only the wired keyboard (0x258A:0x010C) is attached. Connect the 2.4GHz receiver, or unplug the cable and switch the board to 2.4GHz mode.', 'warn');
      }

      // A single physical keyboard exposes several HID interfaces (boot
      // keyboard, mouse, consumer, vendor). Only interfaces that advertise a
      // verified RGB channel can ever be driven, so drop the rest before the
      // multi-device picker. Without this, the 2.4GHz receiver shows up twice
      // under the same name and the user can pick the dead keyboard interface.
      const rgbCapable = devices.filter(hasRgbReportChannel);
      if (rgbCapable.length) devices = rgbCapable;
      log(`Interfaces with a verified RGB channel: ${devices.length}`);

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

      // The keyboard exposes multiple HID interfaces. Only the vendor page
      // (0xFF00) carries the RGB bulk channel. Never probe keyboard/boot
      // interfaces: some accept feature writes and silently misinterpret
      // them, which is how config zones get trashed.
      const vendorDevices = devices.filter(isVendorDevice);
      if (!vendorDevices.length) {
        setStatus('error', transport.dongle
          ? 'Dongle exposes no vendor RGB interface'
          : 'No vendor RGB interface found');
        log(`No vendor-page (0xFF00) interface found. ${devices.map((d) => summarizeCollections(d.collections)).join(' | ')}`, 'error');
        log('If this is the 2.4GHz receiver, its report map may not carry keyboard lighting at all.', 'warn');
        return false;
      }

      let picked = null;
      let openFailures = 0;
      for (const d of vendorDevices) {
        device = d;
        try {
          if (!device.opened) await device.open();
        } catch (e) {
          openFailures++;
          log(
            `Could not open ${d.productName || 'device'} (0x${d.vendorId.toString(16).toUpperCase()}:0x${d.productId.toString(16).toUpperCase()}): ${e.message || e}`,
            'error'
          );
          log('On Linux this usually means /dev/hidraw* is root-only. Replug resets permissions; grant your user access or add a udev uaccess rule.', 'warn');
          continue;
        }
        const mode = transportMode(d);
        log(`Probing ${device.productName || 'device'} [${mode.toUpperCase()}]: ${summarizeCollections(device.collections)}`);

        if (!hasRgbReportChannel(d)) {
          log('No verified RGB channel (wired feature #6 / output #0, or dongle output #0x13) advertised — skipping, no blind writes', 'warn');
          try { await d.close(); } catch (e) {}
          continue;
        }

        if (mode === 'dongle' && !dongleWritesConfirmed) {
          setStatus('error', 'Dongle is read-only until writes are allowed');
          log('Refusing to write RGB frames over 2.4GHz. Tick "Allow RGB writes" in Diagnostics first.', 'warn');
          try { await d.close(); } catch (e) {}
          device = null;
          return false;
        }

        if (await detectReportStrategy()) {
          // A vendor-page interface is authoritative. The readback echo is a
          // bonus signal, not a requirement (some receivers cannot echo).
          await verifyEcho();
          picked = d;
          break;
        }
        log('Device rejected the advertised RGB reports — trying next vendor interface', 'warn');
        try { await d.close(); } catch (e) {}
      }

      if (!picked) {
        device = null;
        reportStrategy = null;
        if (openFailures && openFailures === vendorDevices.length) {
          setStatus('error', 'Could not open the device (permission denied)');
          log('Every RGB interface failed to open — fix device permissions and connect again.', 'error');
        } else {
          setStatus('error', 'No working report strategy found');
          log('Could not find a report the device accepts', 'error');
        }
        return false;
      }
      // close interfaces we won't use
      for (const d of devices) {
        if (d !== picked) { try { await d.close(); } catch (e) {} }
      }

      const pickedMode = transportMode(picked);
      sendIntervalMs = 0; // dongle pacing is handled per frame in sendDongleFrame
      if (pickedMode === 'dongle') {
        // Fresh stream: force an initial 96-slot keyframe and reset pacing.
        lastDongleKeyHash = null;
        lastDongleFullAt = 0;
        lastDongleFrameAt = 0;
      }
      device.addEventListener('inputreport', onInputReport);
      bindVisibility();
      startStreaming();
      setStatus('connected', { name: device.productName, strategy: reportStrategy, mode: pickedMode });
      log(`Streaming via ${reportStrategy.kind} report #${reportStrategy.reportId} (${reportStrategy.size}B) in ${pickedMode} mode`);
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
    if (!device) return false;

    const mode = transportMode(device);

    if (forced) {
      const validDongle = forced.kind === 'dongle' &&
        forced.reportId === DONGLE_REPORT_ID && forced.size === DONGLE_REPORT_SIZE;
      const validWired =
        (forced.kind === 'feature' && forced.reportId === DEFAULT_REPORT_ID && forced.size === REPORT_SIZE) ||
        (forced.kind === 'output' && forced.reportId === 0 && forced.size === REPORT_SIZE + 1);
      if (!validDongle && !validWired) {
        log('Refusing unknown report strategy — only the verified wired and dongle RGB channels are allowed', 'error');
        return false;
      }
      if (validDongle) {
        if (!findReport(device, 'output', DONGLE_REPORT_ID)) {
          log('This device does not advertise output report 0x13', 'error');
          return false;
        }
        reportStrategy = forced;
        log('Using dongle lighting channel output #0x13 (19B chunked, command 0x88)');
        return true;
      }
      reportStrategy = forced;
      const testBuf = new Uint8Array(forced.size);
      testBuf.set(HEADER, 0);
      return tryWrite(forced, testBuf);
    }

    // 2.4GHz receiver: output report 0x13 on interface 1. Detection is
    // descriptor-only — no probe write is needed (and the receiver's 7-byte
    // feature report #6 is a status report, not a colour pipe).
    if (mode === 'dongle') {
      const o13 = findReport(device, 'output', DONGLE_REPORT_ID);
      if (!o13) {
        log('Dongle does not advertise the 19-byte output report 0x13 — refusing to probe other reports', 'error');
        return false;
      }
      reportStrategy = { kind: 'dongle', reportId: DONGLE_REPORT_ID, size: DONGLE_REPORT_SIZE };
      log('Using dongle lighting channel output #0x13 (19B chunked, command 0x88)');
      return true;
    }

    // Wired: only the two verified RGB channels, and only when the report
    // descriptor advertises them. No fallback scan over other report IDs —
    // writing a large frame into an unknown vendor report can corrupt the
    // board's config zone.
    const candidates = [];
    if (findReport(device, 'feature', DEFAULT_REPORT_ID)) {
      candidates.push({ kind: 'feature', reportId: DEFAULT_REPORT_ID, size: REPORT_SIZE });
    }
    if (findReport(device, 'output', 0)) {
      candidates.push({ kind: 'output', reportId: 0, size: REPORT_SIZE + 1 });
    }

    if (!candidates.length) {
      log('Device advertises neither feature #6 nor output #0 — not a wired RGB channel', 'error');
      return false;
    }

    for (const cand of candidates) {
      // Read-only fingerprint first: proves the channel exists without
      // writing anything. A write is only attempted on an advertised channel.
      if (cand.kind === 'feature') {
        try {
          const view = await device.receiveFeatureReport(DEFAULT_REPORT_ID);
          log(`Feature #6 readable (${view.byteLength}B)`, 'debug');
        } catch (e) {
          log('Feature #6 is write-only on this interface — relying on its descriptor', 'debug');
        }
      }
      const testBuf = new Uint8Array(cand.size);
      testBuf.set(HEADER, 0);
      if (await tryWrite(cand, testBuf)) {
        reportStrategy = cand;
        log(`Using ${cand.kind} report #${cand.reportId} (${cand.size}B)`);
        return true;
      }
      log(`${cand.kind} report #${cand.reportId} rejected`, 'debug');
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

  // Strict identity check for supported Hydra hardware. Both transports are
  // hard-coded after inspection; a manual VID/PID override is only consulted
  // while dongle mode is explicitly enabled.
  function supportedDevice(d) {
    if (!d) return null;
    if (d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID) return 'wired';
    if (d.vendorId === DONGLE_VID && d.productId === DONGLE_PID) return 'dongle';
    if (transport.dongle && d.vendorId === transport.vid && d.productId === transport.pid) return 'dongle';
    return null;
  }

  function isHydra(d) {
    return !!supportedDevice(d);
  }

  function transportMode(d) {
    if (!d) return 'wired';
    if (d.vendorId === DONGLE_VID && d.productId === DONGLE_PID) return 'dongle';
    // The wired board is a known, distinct VID/PID. If it is attached, treat
    // it as wired even when dongle mode was left enabled — otherwise the
    // dongle detector would look for output report 0x13 on a board that does
    // not have it and falsely report the link as unsupported.
    if (d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID) return 'wired';
    // Any other explicitly-enabled manual VID/PID is treated as a receiver.
    if (transport.dongle) return 'dongle';
    const name = String(d.productName || '').toLowerCase();
    if (/receiver|dongle|2\.4\s*ghz|wireless/.test(name)) return 'dongle';
    return 'wired';
  }

  // requestDevice() can only be filtered by VID/PID, so build the filter from
  // both known transports plus any manual override.
  function deviceFilters() {
    const ids = [
      { vendorId: VENDOR_ID, productId: PRODUCT_ID },
      { vendorId: DONGLE_VID, productId: DONGLE_PID },
    ];
    if (transport.dongle && (transport.vid !== DONGLE_VID || transport.pid !== DONGLE_PID)) {
      ids.push({ vendorId: transport.vid, productId: transport.pid });
    }
    return ids;
  }

  // The RGB channel lives on a vendor page (0xF000 range): 0xFF00 for the
  // wired board, 0xFF02 for the receiver's output channel, 0xFF04 for its
  // (useless) 7-byte status feature report.
  function isVendorDevice(d) {
    return (d.collections || []).some(
      (c) => c.usagePage >= 0xff00 && c.usagePage <= 0xffff
    );
  }

  function findReport(d, kind, reportId) {
    for (const col of d.collections || []) {
      const list = kind === 'feature' ? col.featureReports : col.outputReports;
      const hit = (list || []).find((r) => r.reportId === reportId);
      if (hit) return hit;
    }
    return null;
  }

  // HIDReportInfo reports its payload as reportSize * reportCount bits.
  function reportBytes(report) {
    const bits = (report.items || []).reduce(
      (n, it) => n + (it.reportSize || 0) * (it.reportCount || 0),
      0
    );
    return Math.ceil(bits / 8);
  }

  // Only treat a device as an RGB target when its descriptors actually
  // advertise one of the verified channels:
  //   wired : feature #6 (~519B) or output #0 (~520B)
  //   dongle: output #0x13 (19B) on the receiver's vendor interface
  // This is what prevents writing a large frame into an unrelated vendor
  // report on a receiver whose report map we have not verified.
  function hasRgbReportChannel(d) {
    const f6 = findReport(d, 'feature', DEFAULT_REPORT_ID);
    const o0 = findReport(d, 'output', 0);
    const o13 = findReport(d, 'output', DONGLE_REPORT_ID);
    const f6bytes = f6 ? reportBytes(f6) : 0;
    const o0bytes = o0 ? reportBytes(o0) : 0;
    const o13bytes = o13 ? reportBytes(o13) : 0;
    return !!(
      (f6 && (f6bytes === 0 || f6bytes >= REPORT_SIZE - 8)) ||
      (o0 && (o0bytes === 0 || o0bytes >= REPORT_SIZE)) ||
      (o13 && (o13bytes === 0 || o13bytes >= DONGLE_REPORT_SIZE))
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

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Chunked 2.4GHz frame writer. Only DONGLE_CMD_LIGHTING (0x88) frames are
  // produced by buildDongleChunks(); the config command is unreachable here.
  //
  // Two frame shapes:
  //   - animation frames: only the 68 mapped key LEDs (cheaper, higher cadence)
  //   - keyframes: all 96 slots, including the unmapped ones held black
  // A keyframe is forced every DONGLE_KEYFRAME_MS and whenever the content is
  // static, which keeps the firmware effect from flashing through.
  async function sendDongleFrame(perLed, force) {
    if (!device || !device.opened || !reportStrategy) return false;
    // Live re-check: toggling "Allow RGB writes" off mid-stream must stop the
    // very next frame, not just the next reconnect.
    if (!dongleWritesConfirmed) {
      log('Dongle writes are blocked — tick "Allow RGB writes" in Diagnostics to resume', 'warn');
      return false;
    }

    const now = performance.now();
    const keyChunks = buildDongleChunks(perLed, KEY_LED_INDICES);
    if (!keyChunks.length) return false;
    const keyHash = hashChunks(keyChunks);
    const keyChanged = keyHash !== lastDongleKeyHash;
    const keyframeDue = force || !lastDongleFullAt || now - lastDongleFullAt >= DONGLE_KEYFRAME_MS;

    if (!force && !keyChanged && !keyframeDue) return true;

    const useFull = keyframeDue;
    const chunks = useFull ? buildDongleChunks(perLed, ALL_LED_INDICES) : keyChunks;
    if (!chunks.length) return false;

    // Budget by chunks per second, not frames. The whole frame (gaps included)
    // counts, so a 6-chunk frame may start every ~100ms, an 8-chunk every ~133ms.
    const budgetMs = chunks.length * (1000 / DONGLE_CHUNKS_PER_SEC);
    if (!force && now - lastDongleFrameAt < budgetMs) return true;

    lastDongleFrameAt = now;
    isSending = true;
    let ok = true;
    for (let i = 0; i < chunks.length; i++) {
      const chunkStart = performance.now();
      try {
        await device.sendReport(DONGLE_REPORT_ID, chunks[i]);
      } catch (e) {
        ok = false;
        log(`Dongle chunk ${i + 1}/${chunks.length} rejected: ${e.message || e}`, 'warn');
        break;
      }
      // Space write *starts* 13ms apart, matching the vendor's measured
      // minimum. Sleeping the full gap after the transfer would be ~15ms.
      if (i < chunks.length - 1) {
        const elapsed = performance.now() - chunkStart;
        if (elapsed < DONGLE_CHUNK_GAP_MS) await sleep(DONGLE_CHUNK_GAP_MS - elapsed);
      }
    }
    isSending = false;

    if (!ok) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        log('Dongle writes failing repeatedly — link idle. Check that the keyboard is awake and in 2.4GHz mode.', 'warn');
      }
      return false;
    }

    lastDongleKeyHash = keyHash;
    if (useFull) lastDongleFullAt = performance.now();
    lastFrameTime = performance.now();
    consecutiveFailures = 0;
    return true;
  }

  async function sendFrame(perLed) {
    // Never overlap writes: the USB device can't queue them. If a frame is
    // still in flight (async write outstanding), drop this one and let the
    // next rAF tick carry the latest frame data instead.
    if (!device || !device.opened || !reportStrategy || isSending) return;
    if (reportStrategy.kind === 'dongle') {
      await sendDongleFrame(perLed);
      return;
    }
    // Wired links are not throttled; keep the verified 30fps+ behaviour.
    if (sendIntervalMs && performance.now() - lastFrameTime < sendIntervalMs) return;
    isSending = true;
    const buf = buildPacket(perLed);
    const ok = await tryWrite(reportStrategy, buf);
    isSending = false;

    // Only re-detect after repeated failures, not on every rejection —
    // a single hiccup should not tear down the working stream.
    if (ok) {
      lastFrameTime = performance.now();
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
    if (!device || !reportStrategy) {
      log('Connect first — refusing to write a test report to an unverified channel', 'warn');
      return false;
    }
    if (reportStrategy.kind === 'dongle') {
      if (!dongleWritesConfirmed) {
        log('Refusing test write over 2.4GHz — allow writes in Diagnostics first', 'warn');
        return false;
      }
      if (isSending) {
        log('Stream is busy — try the test again in a moment', 'warn');
        return false;
      }
      const test = new Array(LED_COUNT).fill(null).map(() => [0, 255, 255]);
      const ok = await sendDongleFrame(test, true);
      log(`Dongle test frame (all cyan, cmd 0x88): ${ok ? 'sent' : 'failed'}`, ok ? 'info' : 'error');
      return ok;
    }
    const size = overrideSize || reportStrategy.size;
    const reportId = overrideReportId != null ? overrideReportId : reportStrategy.reportId;
    const allowed =
      (reportStrategy.kind === 'feature' && reportId === DEFAULT_REPORT_ID && size === REPORT_SIZE) ||
      (reportStrategy.kind === 'output' && reportId === 0 && size === REPORT_SIZE + 1);
    if (!allowed) {
      log(`Refusing test write to ${reportStrategy.kind} #${reportId} @ ${size}B — only the verified RGB channel is allowed`, 'error');
      return false;
    }
    const strategy = { kind: reportStrategy.kind, reportId, size };
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
      const match = known.find(isHydra);
      if (match) {
        device = match;
        try {
          if (!device.opened) await device.open();
          const mode = transportMode(device);
          if (mode === 'dongle' && !dongleWritesConfirmed) {
            device = null;
            scheduleReconnect();
            return;
          }
          const ok = await detectReportStrategy();
          if (ok) {
            sendIntervalMs = 0;
            if (mode === 'dongle') {
              lastDongleKeyHash = null;
              lastDongleFullAt = 0;
              lastDongleFrameAt = 0;
            }
            device.addEventListener('inputreport', onInputReport);
            startStreaming();
            setStatus('connected', { name: device.productName, strategy: reportStrategy, mode });
            log(`Auto-reconnected in ${mode} mode`);
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
    if (!device) {
      log('Connect first — no device to switch reports on', 'warn');
      return;
    }
    // Normalise: the dongle lighting channel is output report 0x13. Accept it
    // under either name so the Diagnostics dropdown keeps working.
    let nextKind = kind;
    let nextId = reportId;
    let defaultSize = REPORT_SIZE;
    if (reportId === DONGLE_REPORT_ID) {
      nextKind = 'dongle';
      nextId = DONGLE_REPORT_ID;
      defaultSize = DONGLE_REPORT_SIZE;
    } else if (reportId === 0) {
      defaultSize = REPORT_SIZE + 1;
    }
    detectReportStrategy({ kind: nextKind, reportId: nextId, size: size || defaultSize });
  }

  // ---------------------------------------------------------------------
  // 2.4GHz dongle controls (opt-in; see transport block at the top)
  // ---------------------------------------------------------------------
  function setDongleMode(enabled, vid, pid, allowWrites) {
    const nextVid = Number.isFinite(vid) && vid > 0 ? vid : DONGLE_VID;
    const nextPid = Number.isFinite(pid) && pid > 0 ? pid : DONGLE_PID;
    transport = { dongle: !!enabled, vid: nextVid, pid: nextPid };
    dongleWritesConfirmed = !!(enabled && allowWrites);
    try {
      localStorage.setItem('rgb-dongle-enabled', transport.dongle ? '1' : '0');
      localStorage.setItem('rgb-dongle-vid', nextVid.toString(16).padStart(4, '0'));
      localStorage.setItem('rgb-dongle-pid', nextPid.toString(16).padStart(4, '0'));
    } catch (e) { /* storage unavailable, non-fatal */ }
    log(
      `Dongle mode ${transport.dongle ? 'enabled' : 'disabled'} ` +
      `(VID 0x${nextVid.toString(16).toUpperCase()} / PID 0x${nextPid.toString(16).toUpperCase()})` +
      `, RGB writes ${dongleWritesConfirmed ? 'ALLOWED' : 'blocked'}`,
      transport.dongle && dongleWritesConfirmed ? 'warn' : 'info'
    );
  }

  function getDongleMode() {
    return {
      enabled: transport.dongle,
      vid: transport.vid,
      pid: transport.pid,
      allowWrites: dongleWritesConfirmed,
      writesAllowed: dongleWritesConfirmed,
    };
  }

  function getMode() {
    return device ? transportMode(device) : null;
  }

  return {
    VENDOR_ID, PRODUCT_ID, DONGLE_VID, DONGLE_PID, DONGLE_REPORT_ID,
    DEFAULT_REPORT_ID, REPORT_SIZE, LED_COUNT, SPECTRUM,
    LED_LAYOUT, KEY_LAYOUT, LAYOUT_TOTAL_W, LAYOUT_ROWS,
    connect, disconnect, sendTestReport,
    setEffect, setColor, setBrightness, setSpeed, setPerKeyColor, clearPerKey,
    getState, onStatus, onFrame, onLog, onFps,
    onPickDevice,
    listReportOptions, forceReportStrategy,
    setDongleMode, getDongleMode, getMode,
    // Exposed for offline encoder tests / diagnostics only.
    buildDongleChunks,
    effectNames: Object.keys(EFFECTS),
    hexToRgb, rgbToHex,
  };
})();

if (typeof window !== 'undefined') window.RGB = RGB;
