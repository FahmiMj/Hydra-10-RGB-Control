# Hydra 10 RGB Control

A desktop RGB control console for the [Portronics Hydra 10](https://www.portronics.com)
(SinoWealth 68-key, VID `0x258A` / PID `0x010C`) keyboard. Built with
Electron and WebHID, it streams lighting frames to the board in real time at
~30fps and renders a live 3D preview of the current effect.

Wired USB is fully supported. **2.4 GHz dongle support is experimental** and
depends on the receiver exposing the same vendor RGB report channel as the
wired board.

![Arc Console screenshot](docs/screenshot.png)

> **Try it in your browser** — no install needed: open the
> [live in-browser demo](https://fahmimj.github.io/Hydra-10-RGB-Control/)
> in Chrome, Edge, or Brave (WebHID requires a secure context and a
> Chromium-based browser).

## Features

- **8 lighting effects** — Off, Solid, Breathing, Spectrum Cycle, Rainbow,
  Rainbow Wave, Pulse Wave, and Per-Key Paint, each with a live preview tile.
- **Per-Key Paint** — click keys directly on the on-screen keyboard to assign
  individual colors, or paint the rainbow spectrum onto a single key.
- **Color, brightness & speed** — a color picker, hex field, quick presets,
  and glowing sliders that apply live to the physical board.
- **3D keyboard preview** — drag to orbit; mirrors the exact frame data being
  sent to the board at 30fps.
- **Continuous streaming** — a Web Worker keeps the 30fps tick running even
  when the window is in the background, so lighting never falls back to the
  board's built-in animation.
- **Diagnostics panel** — live report strategy, report options, a test-report
  sender, device info, an FPS counter, and a scrolling log.
- **Settings persistence** — color/effect/brightness/speed are saved across
  sessions via `localStorage`; unexpected disconnects auto-reconnect.

## Requirements

- **Wired USB is the supported transport.** 2.4 GHz dongle support is
  experimental and only works if the receiver advertises feature report #6
  (519 bytes) or output report #0 (520 bytes) on a vendor page (`0xFF00`).
  WebHID cannot see the keyboard over Bluetooth.
- Windows 10/11 (target platform)
- Google Chrome, Microsoft Edge, or Brave — Chromium-based browsers only,
  as WebHID is not supported in Firefox or Safari.
- A secure context: `http://localhost` or `https://`. The packaged Electron
  app runs over `file://`, which is always a secure context.

## Usage

1. Download the latest installer or portable build from the
   [Releases](../../releases) page.
2. **Plug the keyboard in with the USB cable (wired mode)**, or insert the
   2.4 GHz receiver and switch the board to wireless mode.
3. Launch **Arc Console** and click **Connect keyboard**.
3. Choose the Hydra 10 (or its receiver) in the device picker.
4. Pick an effect, adjust color/brightness/speed, and paint individual keys
   directly on the 3D keyboard.

If multiple devices are connected, a menu lets you select which one to
control. Any non-Hydra HID device is always ignored.

### Experimental: 2.4 GHz dongle

The receiver is a **separate USB device** with its own VID/PID and report
map, so it must be identified before anything is written to it.

1. Open **Diagnostics → Inspect HID devices (read-only)**.
2. Insert the dongle (and switch the keyboard to 2.4 GHz mode), then
   **Scan again / add device**. Note the receiver's VID/PID and whether it
   exposes `feature #6` (roughly 519 bytes) or `output #0` (roughly 520 bytes)
   on usage page `0xFF00`.
3. In Diagnostics, tick **Dongle mode**, enter the receiver PID (hex), and
   connect.
4. Only after confirming the report channel, tick **Allow RGB writes over
   2.4 GHz**. Writes stay blocked until then, and the stream is capped at
   20 fps on the wireless link.

If the receiver only exposes a boot keyboard collection (no vendor page),
the 2.4 GHz link simply does not tunnel lighting and this project cannot
control it. Do **not** force other report IDs — that risks writing into the
keyboard's config zone.

## Development

```sh
npm install
npm start           # run the app
npm run dev         # run with dev flag
```

### Building the installers

```sh
npm run dist:win    # produces NSIS installer + portable exe in release/
```

## Project structure

| File | Purpose |
|---|---|
| `main.js` | Electron main process — window setup, WebHID permission grants. |
| `core.js` | Protocol engine (`window.RGB`) — connect, report detection, effects, packet builder, streaming. |
| `ticker.js` | Web Worker for background-tab 30fps ticking. |
| `ui.js` | Presentation layer — HUD, 3D keyboard, diagnostics, device picker. |
| `index.html` / `style.css` | Markup and the neon-ing theme. |

## Troubleshooting

- **"WebHID not supported"** — use a Chromium-based browser or the packaged
  app; WebHID requires a secure context.
- **Keyboard doesn't appear / no device found** — use a Chromium-based
  browser or the packaged app; WebHID requires a secure context. For the
  2.4 GHz receiver, run the read-only HID inspector and enter its PID.
- **Keyboard doesn't light up** — confirm your board is the Portronics
  Hydra 10 (wired VID `0x258A`, PID `0x010C`) and try the test report buttons
  in the Diagnostics panel. Over 2.4 GHz, check that the receiver exposes
  the vendor RGB report channel first.
- **Preview works but board is dark** — check that the status pill shows
  `Linked`; if the strategy was auto-negotiated as an output report, the
  diagnostics panel will show which report is in use.

## Credits

The key-to-LED mapping and protocol details are based on MRtojisan's
[portronics-hydra-10-SignalRGB-Plugin](https://github.com/MRtojisan/portronics-hydra-10-SignalRGB-Plugin) —
an unofficial SignalRGB plugin for the Portronics Hydra 10. Check it out if
you want full desktop synchronization and game sync via SignalRGB.

## License

[MIT](LICENSE)