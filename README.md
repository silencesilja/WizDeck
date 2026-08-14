# WizDeck

Desktop control for WiZ smart bulbs. Finds them on your LAN by MAC address — so a
DHCP lease change does not break anything — and gives you full control of power,
brightness, colour, colour temperature, scenes and rooms.

Local only: plain JSON over UDP port 38899. No cloud, no account, no pairing.

![app](build/icon.png)

## Requirements

- macOS (Apple silicon or Intel), Node 20+
- Bulbs and computer on the same Wi-Fi/subnet
- "Local control" left enabled in the WiZ app (it is on by default)

## Run

```bash
npm install
npm start
```

## Install as a real app

```bash
npm run install:app
```

Builds `WizDeck.app`, ad-hoc signs it (required on Apple silicon after the bundle
is modified), installs it to `/Applications`, and forces a Spotlight reindex.
Then just `Cmd+Space` → `WizDeck`.

Related scripts:

| script | what it does |
| --- | --- |
| `npm start` | run from source |
| `npm run verify` | hardware test against a real bulb (see below) |
| `npm run package` | build `dist/WizDeck-darwin-*/WizDeck.app` without installing |
| `npm run icon` | regenerate `build/icon.icns` |

CLI flags when running from source: `--bulb=192.168.1.146` pins one bulb and skips
discovery, `--store=<path>` relocates saved state (default
`~/Library/Application Support/WizDeck/wiz.json`).

## What you can control

- **Power** per bulb, per room, and **All on / All off** for every reachable bulb
- **Brightness** 0–100 %, clamped up to the bulb's own minimum dim level (10 % on
  most models — asking for less is silently refused by the firmware)
- **Colour** via HS wheel or `#rrggbb` field
- **Colour temperature** across the range the bulb reports (2200–6500 K on
  `ESP24_SHRGBC_01`), with a real kelvin gradient on the slider
- **Exact numbers by hand**: every slider's readout is also an input — type
  `4200` into the temperature box, or `40` into brightness, and press Enter.
  Arrow keys step (50 K / 1 %), Shift+arrows step coarse (500 K / 10 %), Escape
  reverts, out-of-range values clamp to what the bulb accepts.
- **Transition time** (instant … 1 s) applies to every write and is remembered
  between launches
- **All 35 built-in WiZ scenes** (Ocean, Cozy, Party, Candlelight, …); animated
  ones also take a speed
- **Rooms** grouped by the bulb's own `roomId`, with 10 scene chips per room
- **Identify** — pulses the bulb so you can tell which one it is
- Live state: the app registers for the bulb's `syncPilot` pushes, so changes
  made in the WiZ app or at a wall switch show up here too

Capabilities are read from the hardware (`getModelConfig` / `getSystemConfig`), so
a white-only bulb simply does not render colour controls.

## How discovery survives DHCP

Bulbs are keyed by **MAC**, never by IP.

1. Known addresses from `wiz.json` are probed directly.
2. A `registration` + `getPilot` broadcast goes out on every interface.
3. Every host on the local subnet is unicast-probed (~253 datagrams, ~2.5 s).

macOS routinely drops the replies to a `255.255.255.255` probe, so in practice
step 3 is what finds bulbs on a Mac; the broadcast is kept because it is free and
works elsewhere. Anything that answers with a matching MAC is adopted at its new
address and re-persisted. A rescan runs every 20 s while a known bulb is missing,
and on demand from the **Rescan** button or `Cmd+R`.

## Verify against your own hardware

```bash
npm run verify          # or: node tools/verify.mjs 192.168.1.146
```

Drives the real engine against a real bulb and confirms **every** write by reading
the bulb back over raw UDP, never through the app's cache: brightness, dim-floor
clamping, hex → RGB, kelvin → temp, out-of-range clamping, scenes with speed,
group writes, scene recall, identify, external-change propagation, unreachable
handling, and rediscovery by MAC. The bulb's original state is restored at the
end. 33 checks; exits non-zero on any failure.

## Protocol notes

Learned from `ESP24_SHRGBC_01` firmware 1.38.0 and enforced in `buildPilot()`:

- `sceneId` may **not** be sent together with `r/g/b` or `temp` — the bulb answers
  `-32602 Invalid params` and ignores the whole command.
- `c` / `w` (white channels) may not accompany RGB.
- Writing colour or temperature implicitly drops the bulb out of its scene.
- "No effect" has no wire representation, so leaving a scene re-asserts the
  current colour temperature.
- `dimming` below the model's `minDimLevel` is rejected; the app clamps instead.

## Layout

```
src/main/main.js        Electron main: window, menu, IPC
src/preload.js          sandboxed bridge (contextIsolation, no node in renderer)
src/main/wiz/
  protocol.js           UDP transport, discovery, syncPilot listener, scene table
  engine.js             app state, capability model, patch → setPilot mapping
  color.js              hex/RGB/xy, kelvin ↔ mired, blackbody swatches
  store.js              atomic JSON state (bulbs keyed by MAC)
src/renderer/           vanilla HTML/CSS/JS UI, no framework, no build step
tools/verify.mjs        hardware test
tools/make-icon.mjs     dependency-free .icns generator
tools/install-macos.mjs package + ad-hoc sign + install
```

Only Node built-ins at runtime; Electron and the packager are the sole
devDependencies.

## Troubleshooting

- **No bulbs found** — confirm the bulb answers:
  `echo -n '{"method":"getPilot","params":{}}' | nc -u -w1 192.168.1.146 38899`.
  If that is silent the bulb is on another subnet/VLAN or off.
- **Found but not controllable** — some routers block client-to-client UDP
  ("AP isolation"); turn it off.
- **Name shows as `WiZ Bulb .146`** — WiZ does not expose the name you set in its
  app over the local protocol, only MAC/room ids.
- **Firewall prompt on first run** — macOS asks because the app listens on UDP
  38900 for state pushes; allow it, or the UI falls back to polling.
