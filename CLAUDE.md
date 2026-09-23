# NDONI Uptime Monitor

IoT power/network uptime monitor. An ESP32 or ESP32-C3 senses whether a
remote device is powered on (via a PC817C optocoupler on a GPIO pin),
reports state to a Railway-hosted Node.js/SQLite backend, and the backend
alerts operators over Telegram. Firmware supports OTA updates and remote
WiFi reconfiguration pushed from Telegram commands. Deployed at remote
sites in Nigeria (Ndoni, Kainji, Akabuga).

Full architectural detail (NVS keys, event types, heartbeat payload, WiFi
failover state machine, DB schema) lives in this assistant's memory under
`project_ndoni_architecture.md` — read it for anything non-trivial. This
file covers the day-to-day mechanics: building, flashing, and debugging.

## Repo layout

- `src/main.cpp` — firmware, all boards (~900 lines)
- `src/clear_dev_name.cpp` — utility firmware to wipe the saved device name from NVS
- `platformio.ini` — build environments (see below)
- `railway server file/server.js` — backend: HTTP API + Telegram bot (~1250 lines)
- `.github/workflows/release.yml` — CI: tag push → builds all firmware envs → GitHub Release
- `BOT_COMMANDS.txt` — Telegram command reference and release/tag workflow notes
- `OPTOCOUPLER_WIRING.txt` — hardware wiring notes
- `legacy/arduino_ide/` — old Arduino IDE sketch, reference only; do not use; PlatformIO (`src/main.cpp`) is the maintained firmware

Scope note: a sibling folder `esp 32 pdu driver` exists next to this project
but is unrelated — do not scan it or include it when reasoning about this repo.

## Build environments (platformio.ini)

| Env | Board | Use for |
|-----|-------|---------|
| `esp32` | esp32dev | New ESP32 deployments — device name set via USB serial on first boot |
| `esp32c3` | esp32-c3-devkitm-1 | New ESP32-C3 deployments |
| `ndoni` | esp32dev | Legacy — hardcoded name NDONI-UPTIME, transitional only |
| `kainji` | esp32dev | Legacy — hardcoded name KAINJI-UPTIME, transitional only |
| `clear_dev_name` | esp32-c3-devkitm-1 | Utility — wipes NVS `dev_name`, then reflash `esp32c3` to re-prompt |

Prefer `esp32` / `esp32c3` for anything new. The `ndoni`/`kainji` envs exist
only to OTA-migrate already-deployed legacy devices onto the universal
firmware; don't add new hardcoded-name envs.

## Common commands

```bash
# Build (no upload) — fastest way to check compile errors
pio run -e esp32
pio run -e esp32c3

# Flash over USB (device must be connected; check port first)
pio run -e esp32 -t upload
pio run -e esp32c3 -t upload --upload-port COM10

# Serial monitor (9600 baud, set in platformio.ini)
pio device monitor -b 9600

# List connected serial devices (Windows)
powershell.exe -Command "Get-PnpDevice -Class Ports | Select-Object Name, DeviceID, Status"

# esptool chip identification (swap COM port as needed)
~/.platformio/penv/Scripts/python.exe ~/.platformio/packages/tool-esptoolpy/esptool.py --port COM10 chip_id
```

Releasing new firmware (triggers CI build + GitHub Release with all board
binaries attached). First bump `FW_VERSION` in `src/main.cpp` — the tag
must match it exactly (`v1.1.7` ↔ `"1.1.7"`) or CI fails the release.
Tags continue from `v1.1.x`; never go back to `v1.0.x`.

```bash
git add .
git commit -m "..."
git tag v1.1.X
git push origin main
git push origin v1.1.X
```

The tagged commit must already be pushed to `main` before pushing the tag —
CI builds from the tag, not from local state.

## Debugging playbook

**Device won't come online / stuck reconnecting WiFi:**
1. Serial monitor at 9600 baud — firmware logs WiFi state transitions,
   backoff timers, and hard-reset events.
2. Check whether it's stuck on WiFi1 or already failed over to WiFi2
   (STARLINK fallback). Failover triggers after 6 consecutive internet
   check failures (~10 min); it retries WiFi1 after 60s stable on WiFi2.
3. A hard radio reset (WiFi OFF/ON) happens every 5 failed retries — if
   you see connects failing repeatedly with `NO_SSID_AVAIL`, this is the
   expected recovery path, not a bug.

**Device shows online in serial but not on the dashboard/Telegram:**
1. Hit the backend debug endpoints directly:
   ```bash
   curl -s "https://uptime-bot-production-9a37.up.railway.app/__debug/devices"
   curl -s "https://uptime-bot-production-9a37.up.railway.app/__debug/db"
   curl -s "https://uptime-bot-production-9a37.up.railway.app/__debug/firmware-raw"
   ```
2. Check the device's `dev_name` in NVS matches what the server expects
   (Telegram bots are bound to one device name each — see `BOT_COMMANDS.txt`).
3. Confirm DNS pre-check isn't silently failing (firmware does a DNS
   resolve before every HTTPS call to dodge carrier DNS timeouts /
   watchdog reboots) — visible in serial log.

**OTA update not applying:**
1. `/fw` in Telegram shows device-reported version vs. server's target
   version — mismatch means the device hasn't polled/downloaded yet
   (heartbeat interval is 120s).
2. `/update <ver>` skips if the version already matches; use
   `/forceupdate <ver>` to force a reflash of the same version.
3. On boot, firmware checks the OTA partition is `PENDING_VERIFY` and
   marks it valid — an `OTA_FAILED` event usually means the new binary
   crashed before reaching that point (check the binary was built for
   the right board/env, ESP32 vs ESP32-C3 binaries are not interchangeable).

**WiFi credentials need to change on a deployed device:**
Use `/setwifi <ssid1> <pass1> <ssid2> <pass2>` then `/resetwifi` (see
`BOT_COMMANDS.txt`) rather than reflashing — credentials live in NVS and
survive OTA, so a reflash won't fix bad WiFi config.

**Server-side debugging:** the backend is a single `server.js`; check
Railway logs for stack traces. `/webhook/{token}` is the live Telegram
webhook — if bot commands stop responding, verify the webhook is still
registered with Telegram (it was migrated from long-polling in April 2026
because polling hit `ECONNRESET` on Railway; don't revert to polling).

## Gotchas / conventions

- No ISR on the track pin — GPIO state is debounced in `loop()` to avoid
  WiFi radio context issues. Don't "fix" this by adding an interrupt.
- Do not add new hardcoded-device-name build envs (`ndoni`/`kainji`
  pattern) — new devices get their name via USB serial + NVS.
- ESP32 and ESP32-C3 firmware binaries are built and released separately
  and are **not** interchangeable — always match the OTA binary to the
  target board.
- **Don't add real WiFi credentials to `platformio.ini` build_flags.**
  `WIFI1_SSID`/`WIFI1_PASSWORD`/etc. are only a first-boot bootstrap
  fallback (see `main.cpp` lines ~49-59, ~672-682) — real credentials are
  meant to live server-side (`/setwifi` → DB → `/api/config/{deviceName}`)
  and get cached in device NVS after first successful `fetchConfig()`.
  The `ndoni` env previously hardcoded its real site password here (fixed
  2026-09-18); all envs now fall back to the generic placeholder
  `"Mifi"/"12345678"` bootstrap network like `esp32`/`esp32c3` already did.
  Note the old real password is still in git history — rotate the actual
  router credentials if that matters, since editing this file doesn't
  erase history.
