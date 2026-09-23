# NDONI Uptime Monitor

A small IoT system that tracks whether remote equipment has power and
alerts operators on Telegram when it doesn't. It is deployed at remote
sites in Nigeria (Ndoni, Kainji, Akabuga).

An ESP32 or ESP32-C3 at each site senses the monitored device's power
through an optocoupler and reports state changes and periodic heartbeats
to a Node.js backend on Railway. The backend stores history in SQLite,
calculates uptime/SLA, and runs a Telegram bot for alerts and remote
control: OTA firmware updates, WiFi reconfiguration and health checks.

```
[Monitored 5V supply] → PC817C optocoupler → ESP32 GPIO
        ESP32 ──HTTPS──► Railway backend (Node.js + SQLite) ──► Telegram bot
```

## Hardware

| Part | Notes |
|------|-------|
| ESP32 DevKit (`esp32dev`) or ESP32-C3 DevKitM-1 | Sense pin: GPIO27 (ESP32) / GPIO10 (ESP32-C3) |
| PC817C optocoupler | Isolates the 5V signal from the 3.3V GPIO |
| 390 Ω resistor | LED-side current limit |
| 10 kΩ resistor | GPIO pull-down |

A status LED mirrors the sensed state (GPIO2 on ESP32, GPIO8 on ESP32-C3).
Full wiring, with pinout and step-by-step connections, is in
[`OPTOCOUPLER_WIRING.txt`](OPTOCOUPLER_WIRING.txt).

## Repository layout

| Path | What it is |
|------|------------|
| `src/main.cpp` | Firmware for all boards |
| `src/clear_dev_name.cpp` | Utility firmware that wipes the saved device name |
| `platformio.ini` | Build environments |
| `railway server file/server.js` | Backend: HTTP API + Telegram bot |
| `.github/workflows/` | CI: firmware release builds, server sync |
| `BOT_COMMANDS.txt` | Telegram command reference and release workflow |
| `OPTOCOUPLER_WIRING.txt` | Hardware wiring guide |
| `legacy/` | Old Arduino IDE sketch, reference only, not maintained |

## Firmware quickstart

Requires [PlatformIO](https://platformio.org/) (CLI or the VS Code
extension).

### Build environments

| Env | Board | Use for |
|-----|-------|---------|
| `esp32` | esp32dev | New ESP32 deployments |
| `esp32c3` | esp32-c3-devkitm-1 | New ESP32-C3 deployments |
| `ndoni`, `kainji` | esp32dev | Legacy, for migrating old devices only |
| `clear_dev_name` | esp32-c3-devkitm-1 | Utility: wipe the saved device name |

Use `esp32` or `esp32c3` for anything new. ESP32 and ESP32-C3 binaries
are **not** interchangeable.

### Build, flash, monitor

```bash
# Build only (quick compile check)
pio run -e esp32
pio run -e esp32c3

# Flash over USB
pio run -e esp32 -t upload
pio run -e esp32c3 -t upload --upload-port COM10

# Serial monitor (9600 baud)
pio device monitor -b 9600

# List serial ports (Windows)
powershell.exe -Command "Get-PnpDevice -Class Ports | Select-Object Name, DeviceID, Status"
```

### First boot

On first boot the device asks for its name over USB serial and saves it
to flash (NVS). It connects to a placeholder bootstrap WiFi network
defined in `platformio.ini`, then pulls its real WiFi credentials from the
backend. From then on, change WiFi remotely from Telegram
(`/setwifi` then `/resetwifi`) rather than reflashing.

Don't put real WiFi credentials in `platformio.ini`.

## Releasing firmware

Pushing a `v*` tag triggers CI, which builds every environment and
attaches the binaries to a GitHub Release. Devices then update over the
air via the `/update <version>` Telegram command.

First set `FW_VERSION` in `src/main.cpp` to the release number and commit
it. The tag must match (`v1.1.7` ↔ `"1.1.7"`), or CI refuses to build.

```bash
git tag v1.1.X
git push origin main       # the tagged commit must be on main first
git push origin v1.1.X
```

## Backend

`railway server file/server.js` is a single Node.js (ESM) service using
`express`, `sqlite3` and `node-fetch`. It runs on Railway and receives
Telegram updates through a webhook. Changes pushed to `main` are synced by
CI to the separate deployment repo that Railway builds from.

## Telegram commands

See [`BOT_COMMANDS.txt`](BOT_COMMANDS.txt). Commonly used: `/status`,
`/statusweek`, `/health`, `/fw`, `/update <ver>`, `/setwifi`.
