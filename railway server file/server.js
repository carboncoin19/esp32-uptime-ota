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
  const d = new Date(Date.now() + TZ_OFFSET_MS);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
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

function computeLiveStatus(d) {
  if (!d?.last_seen) return "UNKNOWN";
  if (Date.now() - d.last_seen > DEVICE_STALE_MS) return "UNKNOWN";
  return d.status || "UNKNOWN";
}

function buildSlaMessage({ title, device, status, label, uptimeMs }) {
  const p = slaPercent(uptimeMs);
  return (
    `📊 ${title}\n` +
    `📟 ${device}\n` +
    `📡 Status: ${status}\n` +
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
  await Promise.all(chats.map(c => tg(token, c.chat_id, text)));
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
        "https://github.com/carboncoin19/esp32-uptime-ota/releases/latest/download/firmware.bin"
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
  const dev = normalizeDevice(device);

  if (!event || !dev) return res.json({ ok: true });

  try {
    // HEARTBEAT: still update last_seen so /status works
    if (event === "HEARTBEAT") {
      await dbRun(
        `INSERT INTO devices(device,last_seen)
         VALUES(?,?)
         ON CONFLICT(device)
         DO UPDATE SET last_seen=excluded.last_seen`,
        [dev, now]
      );
      await dbRun(
        `INSERT INTO firmware_control(device)
         VALUES(?)
         ON CONFLICT(device) DO NOTHING`,
        [dev]
      );
      return res.json({ ok: true });
    }

    const status =
      event === "ONLINE" || event === "OFFLINE" ? event : null;

    await dbRun(
      `INSERT INTO devices(device,last_seen,status)
       VALUES(?,?,?)
       ON CONFLICT(device)
       DO UPDATE SET last_seen=excluded.last_seen,
                     status=COALESCE(excluded.status, devices.status)`,
      [dev, now, status]
    );

    if (event === "DAILY_SYNC")
      await dbRun(
        `INSERT OR REPLACE INTO daily_uptime VALUES(?,?,?)`,
        [dev, day, uptime_ms || 0]
      );

    if (event === "MONTHLY_SYNC")
      await dbRun(
        `INSERT OR REPLACE INTO monthly_uptime VALUES(?,?,?)`,
        [dev, month, uptime_ms || 0]
      );

    if (event === "ONLINE" || event === "OFFLINE") {
      const msg =
        `${event === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE"}\n` +
        `${dev}\n🕒 ${time || formatTime(now)}`;

      for (const bot of BOTS)
        if (bot.deviceNorm === dev)
          await broadcast(bot.token, msg);
    }

    if (event === "FW_REPORT") {
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
        console.log(`[FW_REPORT] Auto-cleared stuck update_requested for ${dev} (version match: ${version})`);
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

    res.json({ ok: true });
  } catch (e) {
    console.error("❌ /api/event error:", e.message);
    res.status(500).json({ ok: false });
  }
});

/* ===================== OTA CHECK API ===================== */
app.get("/api/fw/:device", async (req, res) => {
  if (!firmwareSchemaReady)
    return res.json({ update: false });
  const dev = req.params.device.trim().toUpperCase();

  try {
    const row = await dbGet(
      `SELECT latest_version, firmware_url,
              update_requested, force_update
       FROM firmware_control
       WHERE device=?`,
      [dev]
    );

    if (!row || row.update_requested !== 1 || !row.latest_version || !row.firmware_url) {
      return res.json({ update: false });
    }

    res.json({
      update: true,
      version: row.latest_version,
      url: row.firmware_url,
      force: row.force_update === 1,
      trigger: true
    });
  } catch (e) {
    console.error("❌ /api/fw error:", e.message);
    res.json({ update: false });
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

  else if (cmd.startsWith("/update")) {
    console.log("TG /update received:", bot.deviceNorm, cmd);
    try {
      const parts = cmd.split(" ");
      const newVersion = parts[1]?.trim();

      if (!newVersion) {
        await tg(bot.token, chat,
          "❌ Invalid version.\nUsage: /update 1.0.5"
        );
        return;
      }

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
        [bot.deviceNorm, newVersion, bot.fwUrl, 1, 0]
      );

      await tg(
        bot.token,
        chat,
        "🚀 Update requested\n" +
        "📟 " + bot.device + "\n" +
        "🆕 " + newVersion + "\n" +
        "🔧 Board: " + bot.board
      );
    } catch (e) {
      console.error("/update error:", e);
      await tg(bot.token, chat, "⚠️ Update request failed, please try again");
    }
    return;
  }

  else if (cmd.startsWith("/forceupdate")) {
    try {
      const parts = cmd.split(" ");
      const newVersion = parts[1]?.trim();

      if (!newVersion) {
        await tg(bot.token, chat,
          "❌ Invalid version.\nUsage: /forceupdate 1.0.5"
        );
        return;
      }

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
        [bot.deviceNorm, newVersion, bot.fwUrl, 1, 1]
      );

      await tg(
        bot.token,
        chat,
        "🚀 Force update requested\n" +
        "📟 " + bot.device + "\n" +
        "🆕 " + newVersion + "\n" +
        "🔧 Board: " + bot.board + "\n" +
        "⚠️ Will flash even if version matches"
      );
    } catch (e) {
      console.error("/forceupdate error:", e);
      await tg(bot.token, chat, "⚠️ Force update request failed, please try again");
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
        `SELECT last_seen,status FROM devices WHERE device=?`,
        [bot.deviceNorm]
      );

      if (!match) {
        await tg(
          bot.token,
          chat,
          "⚠️ No DAILY_SYNC for yesterday\n" +
          "📟 " + bot.device + "\n" +
          "📡 Status: " + computeLiveStatus(devRow)
        );
      } else {
        await tg(
          bot.token,
          chat,
          buildSlaMessage({
            title: "Yesterday SLA (24h)",
            device: bot.device,
            status: computeLiveStatus(devRow),
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
const sent = {};

setInterval(async () => {
  try {
    const now = new Date(Date.now() + TZ_OFFSET_MS);
    const secondsToday = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

    if (secondsToday < 25200 || secondsToday > 25800) return;

    for (const bot of BOTS) {
      try {
        const yLabel = epochSecToLabel(todayEpochSec() - 86400);
        if (sent[bot.device] === yLabel) continue;

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
          sent[bot.device] = yLabel;
          continue;
        }

        const devRow = await dbGet(
          `SELECT last_seen,status FROM devices WHERE device=?`,
          [bot.deviceNorm]
        );

        await broadcast(
          bot.token,
          buildSlaMessage({
            title: "Yesterday SLA (24h)",
            device: bot.device,
            status: computeLiveStatus(devRow),
            label: yLabel,
            uptimeMs: match.uptime_ms,
          })
        );

        sent[bot.device] = yLabel;
      } catch (e) {
        console.error(`❌ SLA broadcast error for ${bot.device}:`, e.message);
      }
    }

    // clean up sent entries older than today to prevent unbounded growth
    for (const key of Object.keys(sent)) {
      if (sent[key] !== epochSecToLabel(todayEpochSec() - 86400)) delete sent[key];
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



















