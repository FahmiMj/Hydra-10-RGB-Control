/**
 * ticker.js — background-tab frame ticker
 * ----------------------------------------
 * Runs inside a Web Worker so it keeps firing at a steady rate even when
 * the tab is hidden and requestAnimationFrame gets throttled/paused.
 * Posts a plain 'tick' message back to the main thread; core.js does the
 * actual frame computation + HID write (Workers can't touch WebHID).
 */

let intervalId = null;

self.onmessage = (e) => {
  const { cmd, fps } = e.data || {};
  if (cmd === 'start') {
    stop();
    const period = Math.max(1, Math.round(1000 / (fps || 30)));
    intervalId = setInterval(() => self.postMessage('tick'), period);
  } else if (cmd === 'stop') {
    stop();
  }
};

function stop() {
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
