/**
 * ticker.js — background-tab frame ticker
 * ----------------------------------------
 * Runs inside a Web Worker so it keeps firing at a steady rate even when
 * the tab is hidden and requestAnimationFrame gets throttled/paused.
 * Posts a plain 'tick' message back to the main thread; core.js does the
 * actual frame computation + HID write (Workers can't touch WebHID).
 *
 * It also answers 'wait' requests: page timers are throttled to ~1/second
 * while the tab is hidden, but worker timers are not, so the 13ms 2.4GHz
 * chunk gap is timed here instead of on the main thread.
 */

let intervalId = null;
const waitTimers = new Set();

self.onmessage = (e) => {
  const { cmd, fps, id, ms } = e.data || {};
  if (cmd === 'start') {
    stop();
    const period = Math.max(1, Math.round(1000 / (fps || 30)));
    intervalId = setInterval(() => self.postMessage('tick'), period);
  } else if (cmd === 'stop') {
    stop();
  } else if (cmd === 'wait') {
    const timer = setTimeout(() => {
      waitTimers.delete(timer);
      self.postMessage({ cmd: 'waited', id });
    }, Math.max(0, ms || 0));
    waitTimers.add(timer);
  }
};

function stop() {
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  for (const timer of waitTimers) clearTimeout(timer);
  waitTimers.clear();
}
