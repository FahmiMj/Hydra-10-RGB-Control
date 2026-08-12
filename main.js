/**
 * main.js — Arc Console Electron main process
 * -------------------------------------------
 * Boots the same web UI (index.html / core.js / ui.js / style.css) inside
 * a Chromium window. WebHID works in Electron's renderer just like in
 * Chrome, so the entire RGB protocol in core.js is untouched.
 *
 * Pages are loaded with loadFile() over file:// — the exact setup used in
 * Electron's official WebHID docs fiddle — since file:// is a secure
 * context and WebHID is available there. core.js's Web Worker
 * (ticker.js) already falls back to requestAnimationFrame if file://
 * blocks worker construction, so streaming still works.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');

// Keyboards sit on the WebHID blocklist candidate set; our board's vendor
// interface must be connectable, so lift the blocklist.
app.commandLine.appendSwitch('disable-hid-blocklist');

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#070a14',
    title: 'Arc Console — Hydra 10',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Forward renderer console output to the OS terminal so crashes and
  // WebHID errors are visible when running the app from the CLI.
  win.webContents.on('console-message', (event, level, message) => {
    console.log(`[renderer:${level}] ${message}`);
  });

  const ses = win.webContents.session;

  // Mirror Electron's official WebHID fiddle: both permission surfaces must
  // grant 'hid' or navigator.hid throws before the chooser opens.
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (permission === 'hid') return true;
    return false;
  });

  ses.setDevicePermissionHandler((details) => {
    // Only ever grant access to the Portronics Hydra 10 (0x258A / 0x010C).
    // Granting every HID device would auto-expose a mouse/pad/gamepad to the
    // renderer, where the probe loop could otherwise grab the first vendor
    // interface that accepts a feature write.
    if (details.deviceType !== 'hid') return false;
    return details.device.vendorId === 0x258a && details.device.productId === 0x010c;
  });

  // No 'select-hid-device' listener: when unhandled, Electron displays its
  // built-in device chooser, letting the user pick the board's RGB interface.

  win.loadFile('index.html');
  return win;
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});