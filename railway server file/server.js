// ======================================================
// NDONI UPTIME SERVER (Railway)
// REARRANGED FOR AUTO-EDITING — ALL FEATURES PRESERVED
// ======================================================

/* ===================== IMPORTS ===================== */
import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

/* ===================== CONFIG ===================== */
const PORT = process.env.PORT || 8080;
const DB_FILE = "/data/uptime.db";
const TZ_OFFSET_MS = 3600000; // Nigeria +1

const DAY_MS = 86400000;
const MIDNIGHT_CHECK_MS = 15000;
const DEVICE_STALE_MS = 4 * 60 * 1000;

/* ===================== FIRMWARE URL MAP ===================== */
const FW_URLS = {
  esp32:   "https://github.com/carboncoin19/esp32-uptime-ota/releases/latest/download/firmware-esp32.bin",
  esp32c3: "https://github.com/carboncoin19/esp32-uptime-ota/releases/latest/download/firmware-esp32c3.bin",
};

/* ===================== MULTI BOT CONFIG ===================== */
const BOTS = [];
for (let i = 1; i <= 10; i++) {
  const token  = process.env[`TG_BOT_TOKEN_${i}`];
  const device = process.env[`TG_BOT_DEVICE_${i}`];
  const board  = (process.env[`TG_BOT_BOARD_${i}`] || "esp32").toLowerCase().replaceAll("-", "");
  if (token && device) {
    BOTS.push({
      token,
      device: device.trim(),
      deviceNorm: device.trim().toUpperCase(),
      board,
      fwUrl: FW_URLS[board] || FW_URLS.esp32,
    });
  }
}
console.log("🤖 Bots loaded:", BOTS.map(b => `${b.device} (${b.board})`));

/* ===================== FILESYSTEM ===================== */
if (!fs.existsSync("/data")) fs.mkdirSync("/data", { recursive: true });

/* ===================== APP INIT ===================== */
const app = express();
const __dirname = new URL(".", import.meta.url).pathname;

app.use("/firmware", express.static(path.join(__dirname, "firmware")));
app.use(express.json());
app.get("/", (req, res) => res.status(200).send("OK"));

/* ===================== DATABASE ===================== */
const db = new sqlite3.Database(DB_FILE, err => {
  if (err) console.log("❌ DB error:", err.message);
  else console.log("✅ SQLite ready:", DB_FILE);
});

db.run("PRAGMA journal_mode=WAL;", err => {
  if (err) console.error("❌ WAL mode error:", err.message);
  else console.log("✅ WAL mode enabled");
});
let firmwareSchemaReady = false;


/* ===================== DB INIT ===================== */
db.serialize(() => {

  db.run(`
    CREATE TABLE IF NOT EXISTS firmware_control (
      device TEXT PRIMARY KEY,
      update_requested INTEGER DEFAULT 0
    )
  `);

  db.all(`PRAGMA table_info(firmware_control)`, (err, cols) => {
    if (err) return;
    console.log(
  "✅ firmware_control columns:",
  cols.map(c => c.name)
);
const has = name => cols.some(c => c.name === name);

let pending = 0;
let migrationError = false;

const migrationCallback = (err) => {
    if (err) {
      console.error("❌ firmware migration error:", err.message);
      migrationError = true;
    }
    if (--pending === 0) {
      if (!migrationError) firmwareSchemaReady = true;
      else console.error("❌ firmwareSchemaReady NOT set — migration had errors");
    }
  };

  if (!has("latest_version")) {
    pending++;
    db.run(
      `ALTER TABLE firmware_control ADD COLUMN latest_version TEXT`,
      migrationCallback
    );
  }

  if (!has("firmware_url")) {
    pending++;
    db.run(
      `ALTER TABLE firmware_control ADD COLUMN firmware_url TEXT`,
      migrationCallback
    );
  }

  if (!has("current_version")) {
    pending++;
    db.run(
      `ALTER TABLE firmware_control ADD COLUMN current_version TEXT`,
      migrationCallback
    );
  }

  if (!has("force_update")) {
    pending++;
    db.run(
      `ALTER TABLE firmware_control ADD COLUMN force_update INTEGER DEFAULT 0`,
      migrationCallback
    );
  }

  if (!has("reset_config")) {
    pending++;
    db.run(
      `ALTER TABLE firmware_control ADD COLUMN reset_config INTEGER DEFAULT 0`,
      migrationCallback
    );
  }

// If nothing to migrate, mark ready immediately
if (pending === 0) {
  firmwareSchemaReady = true;
}



  });


  // 3️⃣ Other tables AFTER
     db.run(`
  CREATE TABLE IF NOT EXISTS chats (
    chat_id TEXT,
    bot_token TEXT,
    PRIMARY KEY (chat_id, bot_token)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS devices (
    device TEXT PRIMARY KEY,
    last_seen INTEGER,
    status TEXT
  )
`);

db.all(`PRAGMA table_info(devices)`, (err, cols) => {
  if (err) return;
  const hasCol = name => cols.some(c => c.name === name);
  if (!hasCol("wifi_ssid"))
    db.run(`ALTER TABLE devices ADD COLUMN wifi_ssid TEXT`);
  if (!hasCol("wifi_ip"))
    db.run(`ALTER TABLE devices ADD COLUMN wifi_ip TEXT`);
  if (!hasCol("last_broadcast"))
    db.run(`ALTER TABLE devices ADD COLUMN last_broadcast TEXT`, err => {
      if (err) console.error("❌ devices migration error (last_broadcast):", err.message);
      else console.log("✅ devices: last_broadcast column added");
    });
  if (!hasCol("site_status"))
    db.run(`ALTER TABLE devices ADD COLUMN site_status INTEGER`, err => {
      if (err) console.error("❌ devices migration error (site_status):", err.message);
      else console.log("✅ devices: site_status column added");
    });
});

db.run(`
  CREATE TABLE IF NOT EXISTS daily_uptime (
    device TEXT,
    day INTEGER,
    uptime_ms INTEGER,
    PRIMARY KEY (device, day)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS monthly_uptime (
    device TEXT,
    month INTEGER,
    uptime_ms INTEGER,
    PRIMARY KEY (device, month)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS device_config (
    device TEXT PRIMARY KEY,
    wifi1_ssid TEXT,
    wifi1_pass TEXT,
    wifi2_ssid TEXT,
    wifi2_pass TEXT
  )
`);

});


/* ===================== DB HELPERS ===================== */
const dbRun = (s, p = []) =>
  new Promise((resolve, reject) =>
    db.run(s, p, function (err) {
      if (err) {
        console.error("❌ SQL ERROR:", err.message, s);
        reject(err);
      } else {
        resolve(true);
      }
    })
  );

const dbGet = (s, p = []) =>
  new Promise((resolve, reject) =>
    db.get(s, p, (err, row) => {
      if (err) {
        console.error("❌ SQL ERROR:", err.message, s);
        reject(err);
      } else {
        resolve(row || null);
      }
    })
  );

const dbAll = (s, p = []) =>
  new Promise((resolve, reject) =>
    db.all(s, p, (err, rows) => {
      if (err) {
        console.error("❌ SQL ERROR:", err.message, s);
        reject(err);
      } else {
        resolve(rows || []);
      }
    })
  );

function normalizeDevice(device) {
  return String(device || "").trim().toUpperCase();
}

/* ===================== TIME HELPERS ===================== */
function todayEpochSec() {
  // Compute midnight in Nigeria time (UTC+1) without relying on setHours(),
  // which uses the JS engine's local timezone (UTC on Railway) — not Nigeria time.
  const nowNigeria = Date.now() + TZ_OFFSET_MS;
  return Math.floor(nowNigeria / DAY_MS) * 86400 - (TZ_OFFSET_MS / 1000);
}

function epochSecToLabel(s) {
  return new Date(s * 1000 + TZ_OFFSET_MS)
    .toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });
}

function formatTime(ms) {
  return new Date(ms + TZ_OFFSET_MS).toLocaleString("en-US", { timeZone: "UTC" });
}

const slaPercent = up => Math.min(100, (up / DAY_MS) * 100);
const bar = p =>
  "█".repeat(Math.round((p / 100) * 10)) +
  "░".repeat(10 - Math.round((p / 100) * 10));

function lastSeenAgo(ts) {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function formatSiteStatus(devRow) {
  const stale = !devRow?.last_seen || Date.now() - devRow.last_seen > DEVICE_STALE_MS;
  if (stale) {
    const label = devRow?.site_status === 1 ? "ONLINE" : devRow?.site_status === 0 ? "OFFLINE" : "UNKNOWN";
    return `${label} ⚠️ (last known — device unreachable)`;
  }
  if (devRow.site_status === 1) return "ONLINE ✅";
  if (devRow.site_status === 0) return "OFFLINE ❌";
  return "UNKNOWN ⚠️";
}


function buildSlaMessage({ title, device, devRow, label, uptimeMs }) {
  const p = slaPercent(uptimeMs);
  return (
    `📊 ${title}\n` +
    `📟 ${device}\n\n` +
    `🌐 Site: ${formatSiteStatus(devRow)}\n` +
    `(Device last seen: ${lastSeenAgo(devRow?.last_seen)})\n` +
    `📅 ${label}\n\n` +
    `SLA: ${p.toFixed(2)}%\n` +
    `Uptime: ${(uptimeMs / 3600000).toFixed(2)}h\n` +
    `${bar(p)}`
  );
}

/* ===================== TELEGRAM HELPERS ===================== */
async function tg(token, chat, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    const data = await r.json();
    if (!data.ok) console.error(`❌ TG send failed chat=${chat}:`, data.description);
  } catch (e) {
    console.error(`❌ TG fetch error chat=${chat}:`, e.message);
  }
}

async function broadcast(token, text) {
  const chats = await dbAll(
    `SELECT chat_id FROM chats WHERE bot_token=?`,
    [token]
  );
  await Promise.allSettled(chats.map(c => tg(token, c.chat_id, text)));
}

/* ===================== EVENT API ===================== */

if (process.env.DEBUG === "true") {

// ===================== TEMP DEBUG: LIST ALL DEVICES =====================
// REMOVE AFTER VERIFICATION
app.get("/__debug/devices", async (req, res) => {
  try {
    const devices = await dbAll(
      `SELECT DISTINCT device FROM devices ORDER BY device`
    );

    const daily = await dbAll(
      `SELECT DISTINCT device FROM daily_uptime ORDER BY device`
    );

    const monthly = await dbAll(
      `SELECT DISTINCT device FROM monthly_uptime ORDER BY device`
    );

    res.json({
      devices_table: devices.map(d => d.device),
      daily_uptime_table: daily.map(d => d.device),
      monthly_uptime_table: monthly.map(d => d.device),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===================== CHATS DEBUG =====================
app.get("/__debug/chats", async (req, res) => {
  try {
    const chats = await dbAll("SELECT * FROM chats");
    res.json({ count: chats.length, chats });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===================== TEMP DB DEBUG (REMOVE AFTER USE) =====================
app.get("/__debug/db", async (req, res) => {
  try {
    const devices = await dbAll("SELECT * FROM devices");
    const firmware = await dbAll("SELECT * FROM firmware_control");
    res.json({ devices, firmware });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


// ===================== FIRMWARE ROW DIAG =====================
app.get("/__debug/firmware-raw", async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT
         device,
         length(device) AS len,
         hex(device) AS hex,
         latest_version,
         firmware_url
       FROM firmware_control`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


// ===================== TEMP OTA FIX (REMOVE AFTER USE) =====================
app.get("/__debug/fix-ota", async (req, res) => {
  if (!firmwareSchemaReady)
    return res.status(503).json({ error: "Firmware schema not ready" });
  console.log("🔥🔥🔥 FIX OTA ENDPOINT HIT 🔥🔥🔥");
  try {
    await dbRun(
      `INSERT INTO firmware_control
       (device, latest_version, firmware_url, update_requested, force_update)
       VALUES (?, ?, ?, 1, 0)
       ON CONFLICT(device)
       DO UPDATE SET
         latest_version = excluded.latest_version,
         firmware_url = excluded.firmware_url,
         update_requested = 1`,
      [
        "NDONI-UPTIME",
        "1.0.5",
        FW_URLS.esp32
      ]
    );

    res.json({ ok: true, message: "OTA fields fixed (UPSERT)" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
}


app.post("/api/event", async (req, res) => {
  const { device, event, uptime_ms, day, month, time, version } = req.body;
  if (event !== "HEARTBEAT") console.log("EVENT:", req.body);
  const now = Date.now();

  if (!device || typeof device !== "string" || !device.trim())
    return res.status(400).json({ ok: false, error: "missing device" });
  if (!event || typeof event !== "string")
    return res.status(400).json({ ok: false, error: "missing event" });

  const dev = normalizeDevice(device);

  try {
    // HEARTBEAT: update last_seen and return OTA + reset_config status inline
    // Device reads this response — eliminates a separate GET /api/fw round trip
    if (event === "HEARTBEAT") {
      const { ssid, ip, site } = req.body;
      await dbRun(
        `INSERT INTO devices(device,last_seen,status,wifi_ssid,wifi_ip,site_status)
         VALUES(?,?,'ONLINE',?,?,?)
         ON CONFLICT(device)
         DO UPDATE SET last_seen=excluded.last_seen,
                       status='ONLINE',
                       wifi_ssid=COALESCE(excluded.wifi_ssid, devices.wifi_ssid),
                       wifi_ip=COALESCE(excluded.wifi_ip, devices.wifi_ip),
                       site_status=COALESCE(excluded.site_status, devices.site_status)`,
        [dev, now, ssid || null, ip || null, site !== undefined ? site : null]
      );
      await dbRun(
        `INSERT INTO firmware_control(device)
         VALUES(?)
         ON CONFLICT(device) DO NOTHING`,
        [dev]
      );

      // Piggyback OTA + reset_config so device doesn't need a separate HTTPS round trip
      const fwRow = await dbGet(
        `SELECT latest_version, firmware_url, update_requested, force_update, reset_config
         FROM firmware_control WHERE device=?`,
        [dev]
      );
      const resetConfig = fwRow?.reset_config === 1;
      // Do NOT clear reset_config here — clear it only when device confirms via WIFI_RESET event.
      // This prevents silent loss if the device drops the connection before processing.
      const hasUpdate = fwRow?.update_requested === 1 && fwRow?.latest_version && fwRow?.firmware_url;
      return res.json({
        ok: true,
        reset_config: resetConfig,
        update: hasUpdate ? true : false,
        ...(hasUpdate && {
          version: fwRow.latest_version,
          url: fwRow.firmware_url,
          force: fwRow.force_update === 1,
        }),
      });
    }

    const status =
      event === "ONLINE" || event === "OFFLINE" ? event : null;

    const pinSite =
      event === "ONLINE" ? 1 : event === "OFFLINE" ? 0 : null;

    await dbRun(
      `INSERT INTO devices(device,last_seen,status,site_status)
       VALUES(?,?,?,?)
       ON CONFLICT(device)
       DO UPDATE SET last_seen=excluded.last_seen,
                     status=COALESCE(excluded.status, devices.status),
                     site_status=COALESCE(excluded.site_status, devices.site_status)`,
      [dev, now, status, pinSite]
    );

    if (event === "DAILY_SYNC") {
      if (!day || typeof day !== "number")
        return res.status(400).json({ ok: false, error: "missing day" });
      await dbRun(
        `INSERT OR REPLACE INTO daily_uptime VALUES(?,?,?)`,
        [dev, day, uptime_ms || 0]
      );
    }

    if (event === "MONTHLY_SYNC") {
      if (!month || typeof month !== "number")
        return res.status(400).json({ ok: false, error: "missing month" });
      await dbRun(
        `INSERT OR REPLACE INTO monthly_uptime VALUES(?,?,?)`,
        [dev, month, uptime_ms || 0]
      );
    }

    if (event === "ONLINE" || event === "OFFLINE") {
      const msg =
        `${event === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE"}\n` +
        `${dev}\n🕒 ${time || formatTime(now)}`;

      for (const bot of BOTS)
        if (bot.deviceNorm === dev)
          await broadcast(bot.token, msg);
    }

    if (event === "FW_REPORT" || event === "BOOT_REPORT") {
      const { ssid, ip } = req.body;
      await dbRun(
        `INSERT INTO firmware_control(device, current_version)
         VALUES(?,?)
         ON CONFLICT(device)
         DO UPDATE SET current_version=excluded.current_version`,
        [dev, version || "unknown"]
      );
      // Auto-clear stuck update_requested if device already has the target version
      const fwRow = await dbGet(
        `SELECT latest_version, update_requested FROM firmware_control WHERE device=?`,
        [dev]
      );
      if (fwRow && fwRow.update_requested === 1 && fwRow.latest_version === version) {
        await dbRun(
          `UPDATE firmware_control SET update_requested=0, force_update=0 WHERE device=?`,
          [dev]
        );
        console.log(`[BOOT_REPORT] Auto-cleared stuck update_requested for ${dev}`);
      }
      // BOOT_REPORT also carries WiFi info — send connected notification
      if (event === "BOOT_REPORT" && ssid) {
        await dbRun(
          `INSERT INTO devices(device,last_seen,status,wifi_ssid,wifi_ip)
           VALUES(?,?,'ONLINE',?,?)
           ON CONFLICT(device)
           DO UPDATE SET last_seen=excluded.last_seen,
                         status='ONLINE',
                         wifi_ssid=excluded.wifi_ssid,
                         wifi_ip=excluded.wifi_ip`,
          [dev, now, ssid, ip || null]
        );
        const msg =
          `📶 ${dev} booted\n` +
          `FW: ${version || "?"} | SSID: ${ssid}\n` +
          `IP: ${ip || "?"}\n` +
          `🕒 ${formatTime(now)}`;
        for (const bot of BOTS)
          if (bot.deviceNorm === dev)
            await broadcast(bot.token, msg);
      }
    }

    if (event === "OTA_SUCCESS") {
      await dbRun(
        `UPDATE firmware_control
         SET update_requested=0,
             force_update=0,
             current_version=?
         WHERE device=?`,
        [version || "unknown", dev]
      );

      const msg =
        `🚀 OTA UPDATE SUCCESS\n\n` +
        `📟 ${dev}\n` +
        `🆕 Version: ${version || "unknown"}\n` +
        `🕒 ${time || formatTime(now)}`;

      for (const bot of BOTS)
        if (bot.deviceNorm === dev)
          await broadcast(bot.token, msg);
    }

    if (event === "OTA_FAILED") {
      const msg =
        `❌ OTA UPDATE FAILED\n\n` +
        `📟 ${dev}\n` +
        `🆕 Version: ${version || "unknown"}\n` +
        `🕒 ${time || formatTime(now)}`;

      for (const bot of BOTS)
        if (bot.deviceNorm === dev)
          await broadcast(bot.token, msg);
    }

    if (event === "WIFI_RESET") {
      // Device confirmed it cleared NVS — now safe to clear the flag
      await dbRun(`UPDATE firmware_control SET reset_config=0 WHERE device=?`, [dev]);
      const msg =
        `🔄 WiFi reset applied on ${dev}\n` +
        `NVS cleared — rebooting to fetch new credentials\n` +
        `🕒 ${formatTime(now)}`;
      for (const bot of BOTS)
        if (bot.deviceNorm === dev)
          await broadcast(bot.token, msg);
    }

    if (event === "WIFI_CFG_OK") {
      const { wifi1, wifi2 } = req.body;
      const msg =
        `✅ New WiFi credentials loaded on ${dev}\n` +
        `📶 WiFi1: ${wifi1 || "?"}\n` +
        `📶 WiFi2: ${wifi2 || "?"}\n` +
        `🕒 ${formatTime(now)}`;
      for (const bot of BOTS)
        if (bot.deviceNorm === dev)
          await broadcast(bot.token, msg);
    }

    if (event === "WIFI_CFG_FAIL") {
      const { reason } = req.body;
      const hint = reason === "no_config"
        ? "Run /setwifi to set credentials first"
        : `HTTP error: ${reason}`;
      const msg =
        `⚠️ WiFi config fetch failed on ${dev}\n` +
        `${hint}\n` +
        `🕒 ${formatTime(now)}`;
      for (const bot of BOTS)
        if (bot.deviceNorm === dev)
          await broadcast(bot.token, msg);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("❌ /api/event error:", e.message);
    res.status(500).json({ ok: false });
  }
});

/* ===================== DEVICE CONFIG API ===================== */
app.get("/api/config/:device", async (req, res) => {
  const dev = req.params.device.trim().toUpperCase();
  try {
    const row = await dbGet(`SELECT * FROM device_config WHERE device=?`, [dev]);
    if (!row || !row.wifi1_ssid) return res.json({ ok: false });
    res.json({
      ok: true,
      wifi1_ssid: row.wifi1_ssid,
      wifi1_pass: row.wifi1_pass,
      wifi2_ssid: row.wifi2_ssid,
      wifi2_pass: row.wifi2_pass,
    });
  } catch (e) {
    console.error("❌ /api/config error:", e.message);
    res.status(500).json({ ok: false });
  }
});

/* ===================== TELEGRAM UPDATE HANDLER ===================== */
async function handleUpdate(bot, update) {
  const chat = update.message?.chat?.id;
  const cmd = update.message?.text;

  if (!chat || !cmd) return;

  try {
    await dbRun(
      `INSERT OR IGNORE INTO chats(chat_id,bot_token) VALUES(?,?)`,
      [chat, bot.token]
    );
  } catch (e) {
    console.error("❌ Chat registration error:", e.message);
    // Continue processing the command even if registration fails
  }

  if (cmd === "/start") {
    await tg(bot.token, chat, `📡 ${bot.device} uptime monitor active.`);
    return;
  }

  else if (cmd === "/update" || cmd.startsWith("/update ")) {
    console.log("TG /update received:", bot.deviceNorm, cmd);
    try {
      const parts = cmd.trim().split(/\s+/);
      const newVersion = parts[1]?.trim();
      const customUrl = parts[2]?.trim() || null;

      if (!newVersion) {
        await tg(bot.token, chat,
          "❌ Invalid version.\n" +
          "Usage: /update 1.0.13\n" +
          "With custom URL: /update 1.0.13 https://..."
        );
        return;
      }

      const fwUrl = customUrl || bot.fwUrl;

      await dbRun(
        `INSERT INTO firmware_control
         (device, latest_version, firmware_url, update_requested, force_update)
         VALUES(?,?,?,?,?)
         ON CONFLICT(device)
         DO UPDATE SET
           latest_version=excluded.latest_version,
           firmware_url=excluded.firmware_url,
           update_requested=1,
           force_update=0`,
        [bot.deviceNorm, newVersion, fwUrl, 1, 0]
      );

      await tg(
        bot.token,
        chat,
        "🚀 Update requested\n" +
        "📟 " + bot.device + "\n" +
        "🆕 " + newVersion + "\n" +
        "🔧 Board: " + bot.board +
        (customUrl ? "\n🔗 Custom URL" : "")
      );
    } catch (e) {
      console.error("/update error:", e);
      await tg(bot.token, chat, "⚠️ Update request failed, please try again");
    }
    return;
  }

  else if (cmd === "/forceupdate" || cmd.startsWith("/forceupdate ")) {
    try {
      const parts = cmd.trim().split(/\s+/);
      const newVersion = parts[1]?.trim();
      const customUrl = parts[2]?.trim() || null;

      if (!newVersion) {
        await tg(bot.token, chat,
          "❌ Invalid version.\n" +
          "Usage: /forceupdate 1.0.13\n" +
          "With custom URL: /forceupdate 1.0.13 https://..."
        );
        return;
      }

      const fwUrl = customUrl || bot.fwUrl;

      await dbRun(
        `INSERT INTO firmware_control
         (device, latest_version, firmware_url, update_requested, force_update)
         VALUES(?,?,?,?,?)
         ON CONFLICT(device)
         DO UPDATE SET
           latest_version=excluded.latest_version,
           firmware_url=excluded.firmware_url,
           update_requested=1,
           force_update=1`,
        [bot.deviceNorm, newVersion, fwUrl, 1, 1]
      );

      await tg(
        bot.token,
        chat,
        "🚀 Force update requested\n" +
        "📟 " + bot.device + "\n" +
        "🆕 " + newVersion + "\n" +
        "🔧 Board: " + bot.board + "\n" +
        "⚠️ Will flash even if version matches" +
        (customUrl ? "\n🔗 Custom URL" : "")
      );
    } catch (e) {
      console.error("/forceupdate error:", e);
      await tg(bot.token, chat, "⚠️ Force update request failed, please try again");
    }
    return;
  }

  else if (cmd.startsWith("/setwifi")) {
    try {
      // Parse: /setwifi <ssid1> <pass1> <ssid2> <pass2>
      // Use ! as space substitute in ssid1 and ssid2 only.
      // pass1, ssid2, pass2 are single tokens. ssid1 may span multiple tokens.
      const tokens = cmd.trim().split(/\s+/);
      const USAGE =
        "❌ Usage: /setwifi <ssid1> <pass1> <ssid2> <pass2>\n" +
        "Use ! in ssid1 and ssid2 where there is a space.\n" +
        "Example: /setwifi Star!Home 12345678 My!Network abc123\n" +
        "Example (no spaces): /setwifi mifi 12345678 Starlink abc123";
      if (tokens.length < 5) {
        await tg(bot.token, chat, USAGE);
        return;
      }
      const pass2 = tokens[tokens.length - 1];
      const ssid2Raw = tokens[tokens.length - 2];
      const pass1 = tokens[tokens.length - 3];
      const ssid1Raw = tokens.slice(1, tokens.length - 3).join(" ");
      // Replace ! with space in SSIDs only
      const ssid1 = ssid1Raw.replaceAll("!", " ");
      const ssid2 = ssid2Raw.replaceAll("!", " ");
      // Guard: ssid1 must not be empty after parsing
      if (!ssid1.trim()) {
        await tg(bot.token, chat, USAGE);
        return;
      }
      await dbRun(
        `INSERT INTO device_config(device,wifi1_ssid,wifi1_pass,wifi2_ssid,wifi2_pass)
         VALUES(?,?,?,?,?)
         ON CONFLICT(device) DO UPDATE SET
           wifi1_ssid=excluded.wifi1_ssid, wifi1_pass=excluded.wifi1_pass,
           wifi2_ssid=excluded.wifi2_ssid, wifi2_pass=excluded.wifi2_pass`,
        [bot.deviceNorm, ssid1, pass1, ssid2, pass2]
      );
      await tg(bot.token, chat,
        "✅ WiFi config saved for " + bot.device + "\n" +
        "📶 WiFi1 SSID: " + ssid1 + "\n" +
        "📶 WiFi1 Pass: " + pass1 + "\n" +
        "📶 WiFi2 SSID: " + ssid2 + "\n" +
        "📶 WiFi2 Pass: " + pass2 + "\n" +
        "⚠️ If any field looks wrong, re-send /setwifi\n" +
        "Send /resetwifi to push to device on next poll"
      );
    } catch (e) {
      console.error("/setwifi error:", e);
      await tg(bot.token, chat, "⚠️ Failed to save WiFi config");
    }
    return;
  }

  else if (cmd === "/resetwifi") {
    try {
      const cfgRow = await dbGet(
        `SELECT wifi1_ssid FROM device_config WHERE device=?`,
        [bot.deviceNorm]
      );
      if (!cfgRow || !cfgRow.wifi1_ssid) {
        await tg(bot.token, chat,
          "⚠️ No WiFi credentials saved for " + bot.device + "\n" +
          "Run /setwifi first, then /resetwifi"
        );
        return;
      }
      await dbRun(
        `INSERT INTO firmware_control(device, reset_config)
         VALUES(?,1)
         ON CONFLICT(device) DO UPDATE SET reset_config=1`,
        [bot.deviceNorm]
      );
      await tg(bot.token, chat,
        "🔄 Config reset requested for " + bot.device + "\n" +
        "Device will fetch new WiFi credentials on next poll (~60s) and reboot"
      );
    } catch (e) {
      console.error("/resetwifi error:", e);
      await tg(bot.token, chat, "⚠️ Failed to request config reset");
    }
    return;
  }

  else if (cmd === "/stopupdate") {
    try {
      await dbRun(
        `UPDATE firmware_control SET update_requested=0, force_update=0 WHERE device=?`,
        [bot.deviceNorm]
      );
      await tg(
        bot.token,
        chat,
        "🛑 OTA update cancelled\n" +
        "📟 " + bot.device + "\n" +
        "Device will no longer receive the pending update"
      );
    } catch (e) {
      console.error("/stopupdate error:", e);
      await tg(bot.token, chat, "⚠️ Stop update failed, please try again");
    }
    return;
  }

  else if (cmd === "/viewwifi") {
    try {
      const row = await dbGet(
        `SELECT wifi1_ssid, wifi1_pass, wifi2_ssid, wifi2_pass FROM device_config WHERE device=?`,
        [bot.deviceNorm]
      );
      if (!row || !row.wifi1_ssid) {
        await tg(bot.token, chat,
          "📋 " + bot.device + " stored credentials\n" +
          "No credentials saved — run /setwifi first"
        );
        return;
      }
      await tg(bot.token, chat,
        "📋 " + bot.device + " stored credentials\n" +
        "📶 WiFi1 SSID: " + row.wifi1_ssid + "\n" +
        "🔑 WiFi1 Pass: " + row.wifi1_pass + "\n" +
        "📶 WiFi2 SSID: " + (row.wifi2_ssid || "not set") + "\n" +
        "🔑 WiFi2 Pass: " + (row.wifi2_pass || "not set")
      );
    } catch (e) {
      console.error("/viewwifi error:", e);
      await tg(bot.token, chat, "⚠️ Could not retrieve WiFi credentials");
    }
    return;
  }

  else if (cmd === "/wifi") {
    try {
      const row = await dbGet(
        `SELECT wifi_ssid, wifi_ip, last_seen FROM devices WHERE device=?`,
        [bot.deviceNorm]
      );
      if (!row || !row.wifi_ssid) {
        await tg(bot.token, chat, "📶 " + bot.device + "\nNo WiFi info yet — waiting for next heartbeat (~2 min)");
        return;
      }
      const age = Math.round((Date.now() - row.last_seen) / 1000);
      const ageStr = age < 120 ? `${age}s ago` : `${Math.round(age/60)}m ago`;
      await tg(
        bot.token, chat,
        "📶 " + bot.device + " WiFi Status\n" +
        "SSID: " + row.wifi_ssid + "\n" +
        "IP: " + (row.wifi_ip || "unknown") + "\n" +
        "Last seen: " + ageStr
      );
    } catch (e) {
      console.error("/wifi error:", e);
      await tg(bot.token, chat, "⚠️ WiFi info unavailable");
    }
    return;
  }

  else if (cmd === "/fw") {
    try {
      const row = await dbGet(
        `SELECT current_version, latest_version FROM firmware_control WHERE device=?`,
        [bot.deviceNorm]
      );

      await tg(
        bot.token,
        chat,
        "📟 " + bot.device + "\n" +
        "Current Device Version: " + (row?.current_version || "Unknown") + "\n" +
        "Latest Server Version: " + (row?.latest_version || "Not set")
      );
    } catch (e) {
      console.error("/fw error:", e);
      await tg(bot.token, chat, "⚠️ Firmware info unavailable, please try again");
    }
  }

  else if (cmd === "/status") {
    try {
      const today = todayEpochSec();
      const yLabel = epochSecToLabel(today - 86400);

      const rows = await dbAll(
        `SELECT day,uptime_ms FROM daily_uptime WHERE device=? ORDER BY day DESC LIMIT 7`,
        [bot.deviceNorm]
      );

      const match = rows.find(r => epochSecToLabel(r.day) === yLabel);

      const devRow = await dbGet(
        `SELECT last_seen, status, site_status FROM devices WHERE device=?`,
        [bot.deviceNorm]
      );

      if (!match) {
        await tg(
          bot.token,
          chat,
          "📟 " + bot.device + "\n\n" +
          "🌐 Site: " + formatSiteStatus(devRow) + "\n" +
          "(Device last seen: " + lastSeenAgo(devRow?.last_seen) + ")\n\n" +
          "⚠️ No DAILY_SYNC for yesterday"
        );
      } else {
        await tg(
          bot.token,
          chat,
          buildSlaMessage({
            title: "Yesterday SLA (24h)",
            device: bot.device,
            devRow,
            label: yLabel,
            uptimeMs: match.uptime_ms,
          })
        );
      }
    } catch (e) {
      console.error("/status error:", e);
      await tg(bot.token, chat, "⚠️ Status temporarily unavailable");
    }
  }

  else if (cmd === "/statusweek") {
    try {
      const rows = await dbAll(
        `SELECT day, uptime_ms
         FROM daily_uptime
         WHERE device=?
         ORDER BY day DESC
         LIMIT 7`,
        [bot.deviceNorm]
      );

      if (!rows.length) {
        await tg(bot.token, chat, "⚠️ No uptime data for this week.");
        return;
      }

      const ordered = rows.reverse();

      let totalUp = 0;
      for (const r of ordered) totalUp += (r.uptime_ms || 0);

      const expected = ordered.length * DAY_MS;
      const overall = Math.min(100, (totalUp / expected) * 100);

      let text =
        "📈 Weekly SLA Summary\n" +
        "📟 " + bot.device + "\n\n" +
        "Overall SLA: " + overall.toFixed(2) + "%\n" +
        "Total Uptime: " + (totalUp / 3600000).toFixed(2) + "h\n\n";

      for (const r of ordered) {
        const p = slaPercent(r.uptime_ms || 0);
        text +=
          epochSecToLabel(r.day) + " " +
          bar(p) + " " +
          p.toFixed(1) + "%\n";
      }

      await tg(bot.token, chat, text);
    } catch (e) {
      console.error("/statusweek error:", e);
      await tg(bot.token, chat, "⚠️ Weekly status temporarily unavailable");
    }
  }

  else if (cmd === "/statusmonth") {
    try {
      const rows = await dbAll(
        `SELECT day, uptime_ms
         FROM daily_uptime
         WHERE device=?
         ORDER BY day DESC
         LIMIT 30`,
        [bot.deviceNorm]
      );

      if (!rows.length) {
        await tg(bot.token, chat, "⚠️ No uptime data for this month.");
        return;
      }

      let totalUp = 0;
      for (const r of rows) totalUp += (r.uptime_ms || 0);

      const expected = rows.length * DAY_MS;
      const sla = Math.min(100, (totalUp / expected) * 100);

      await tg(
        bot.token,
        chat,
        "📉 Monthly SLA Summary\n" +
        "📟 " + bot.device + "\n\n" +
        "Overall SLA: " + sla.toFixed(2) + "%\n" +
        "Total Uptime: " + (totalUp / 3600000).toFixed(2) + "h\n" +
        "Days counted: " + rows.length
      );
    } catch (e) {
      console.error("/statusmonth error:", e);
      await tg(bot.token, chat, "⚠️ Monthly status temporarily unavailable");
    }
  }

  else if (cmd.startsWith("/")) {
    await tg(bot.token, chat,
      "❓ Unknown command: " + cmd.split(" ")[0] + "\n" +
      "Available: /status /statusweek /statusmonth /fw /wifi /viewwifi /setwifi /resetwifi /update /forceupdate /stopupdate"
    );
  }
}

/* ===================== TELEGRAM WEBHOOK ENDPOINT ===================== */
app.post("/webhook/:token", async (req, res) => {
  res.sendStatus(200);
  const bot = BOTS.find(b => b.token === req.params.token);
  if (!bot) return;
  try {
    await handleUpdate(bot, req.body);
  } catch (e) {
    console.error("❌ Webhook handler error:", e.message);
  }
});

/* ===================== TELEGRAM WEBHOOK REGISTRATION ===================== */
async function registerWebhook(bot, attempt = 1) {
  const baseUrl = process.env.SERVER_BASE_URL || "https://uptime-bot-production-9a37.up.railway.app";
  const webhookUrl = `${baseUrl}/webhook/${bot.token}`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${bot.token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`🔗 Webhook for ${bot.device}: ✅ OK`);
    } else {
      console.error(`❌ Webhook for ${bot.device}: ${data.description}`);
      if (attempt < 3) {
        console.log(`↩️ Retrying webhook for ${bot.device} in 30s (attempt ${attempt}/3)`);
        setTimeout(() => registerWebhook(bot, attempt + 1), 30000);
      }
    }
  } catch (e) {
    console.error(`❌ Webhook registration failed for ${bot.device}:`, e.message);
    if (attempt < 3) {
      console.log(`↩️ Retrying webhook for ${bot.device} in 30s (attempt ${attempt}/3)`);
      setTimeout(() => registerWebhook(bot, attempt + 1), 30000);
    }
  }
}

/* ===================== DAILY SLA BROADCAST ===================== */
setInterval(async () => {
  try {
    const now = new Date(Date.now() + TZ_OFFSET_MS);
    const secondsToday = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

    if (secondsToday < 25200 || secondsToday > 25800) return;

    for (const bot of BOTS) {
      try {
        const yLabel = epochSecToLabel(todayEpochSec() - 86400);
        const devRow = await dbGet(
          `SELECT last_seen, status, site_status, last_broadcast FROM devices WHERE device=?`,
          [bot.deviceNorm]
        );
        if (devRow?.last_broadcast === yLabel) continue;

        const rows = await dbAll(
          `SELECT day,uptime_ms FROM daily_uptime
           WHERE device=? ORDER BY day DESC LIMIT 7`,
          [bot.deviceNorm]
        );

        const match = rows.find(r => epochSecToLabel(r.day) === yLabel);
        if (!match) {
          await broadcast(
            bot.token,
            `⚠️ No DAILY_SYNC received for ${yLabel}\n📟 ${bot.device}\nDevice may have been offline or disconnected all day.`
          );
          await dbRun(`UPDATE devices SET last_broadcast=? WHERE device=?`, [yLabel, bot.deviceNorm]);
          continue;
        }

        await broadcast(
          bot.token,
          buildSlaMessage({
            title: "Yesterday SLA (24h)",
            device: bot.device,
            devRow,
            label: yLabel,
            uptimeMs: match.uptime_ms,
          })
        );

        await dbRun(`UPDATE devices SET last_broadcast=? WHERE device=?`, [yLabel, bot.deviceNorm]);
      } catch (e) {
        console.error(`❌ SLA broadcast error for ${bot.device}:`, e.message);
      }
    }
  } catch (e) {
    console.error("❌ SLA broadcast error:", e.message);
  }
}, MIDNIGHT_CHECK_MS);

/* ===================== START SERVER ===================== */
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on port", PORT);
  for (const bot of BOTS) registerWebhook(bot);
});















