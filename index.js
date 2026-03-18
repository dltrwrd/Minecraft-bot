require("dotenv").config();
const mineflayer = require("mineflayer");
const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────
//  CONFIG  (override via environment vars)
// ─────────────────────────────────────────
const CONFIG = {
  // Minecraft server
  MC_HOST: process.env.MC_HOST || "your-server-ip",
  MC_PORT: parseInt(process.env.MC_PORT) || 25565,
  MC_USERNAME: process.env.MC_USERNAME || "KeepAliveBot",
  MC_VERSION: process.env.MC_VERSION || "1.20.1", // change to match your server

  // Auth: "offline" for cracked / "microsoft" for premium
  MC_AUTH: process.env.MC_AUTH || "offline",

  // Render self-ping
  RENDER_URL: process.env.RENDER_URL || "", // e.g. https://your-app.onrender.com
  PING_INTERVAL_MS: parseInt(process.env.PING_INTERVAL_MS) || 5 * 60 * 1000, // every 5 mins

  // Express port
  PORT: parseInt(process.env.PORT) || 3000,

  // Reconnect delay (ms)
  RECONNECT_DELAY_MS: parseInt(process.env.RECONNECT_DELAY_MS) || 5000,

  // Anti-AFK interval (ms)
  AFK_INTERVAL_MS: parseInt(process.env.AFK_INTERVAL_MS) || 30 * 1000, // every 30s

  // Chat log file
  CHAT_LOG_FILE: process.env.CHAT_LOG_FILE || "chat.log",
};

// ─────────────────────────────────────────
//  LOGGER
// ─────────────────────────────────────────
const RESET = "\x1b[0m";
const COLORS = {
  info:    "\x1b[36m", // cyan
  success: "\x1b[32m", // green
  warn:    "\x1b[33m", // yellow
  error:   "\x1b[31m", // red
  chat:    "\x1b[35m", // magenta
  afk:     "\x1b[34m", // blue
};

function log(type, msg) {
  const ts = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" });
  const tag = `[${type.toUpperCase()}]`.padEnd(10);
  console.log(`${COLORS[type] || ""}${ts}  ${tag}  ${msg}${RESET}`);
}

// ─────────────────────────────────────────
//  CHAT LOGGER (to file)
// ─────────────────────────────────────────
function logChat(username, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] <${username}> ${message}\n`;

  log("chat", `<${username}> ${message}`);

  fs.appendFile(path.join(__dirname, CONFIG.CHAT_LOG_FILE), line, (err) => {
    if (err) log("error", `Failed to write chat log: ${err.message}`);
  });
}

// ─────────────────────────────────────────
//  BOT STATE
// ─────────────────────────────────────────
let bot = null;
let afkTimer = null;
let reconnectTimer = null;
let isConnected = false;
let reconnectCount = 0;
let botStartTime = null;

// ─────────────────────────────────────────
//  ANTI-AFK
// ─────────────────────────────────────────
const AFK_ACTIONS = [
  // Jump
  (b) => {
    b.setControlState("jump", true);
    setTimeout(() => b.setControlState("jump", false), 500);
    log("afk", "Anti-AFK: jumped");
  },
  // Spin left
  (b) => {
    b.look(b.entity.yaw + Math.PI / 4, b.entity.pitch, false);
    log("afk", "Anti-AFK: looked around");
  },
  // Spin right
  (b) => {
    b.look(b.entity.yaw - Math.PI / 4, b.entity.pitch, false);
    log("afk", "Anti-AFK: looked around");
  },
  // Sneak toggle
  (b) => {
    b.setControlState("sneak", true);
    setTimeout(() => b.setControlState("sneak", false), 600);
    log("afk", "Anti-AFK: sneaked");
  },
  // Random small walk
  (b) => {
    const dirs = ["forward", "back", "left", "right"];
    const dir = dirs[Math.floor(Math.random() * dirs.length)];
    b.setControlState(dir, true);
    setTimeout(() => b.setControlState(dir, false), 400 + Math.random() * 300);
    log("afk", `Anti-AFK: moved (${dir})`);
  },
];

function startAntiAFK() {
  stopAntiAFK();
  afkTimer = setInterval(() => {
    if (!bot || !isConnected) return;
    const action = AFK_ACTIONS[Math.floor(Math.random() * AFK_ACTIONS.length)];
    try { action(bot); } catch (e) { /* ignore mid-disconnect errors */ }
  }, CONFIG.AFK_INTERVAL_MS);
  log("afk", `Anti-AFK started (every ${CONFIG.AFK_INTERVAL_MS / 1000}s)`);
}

function stopAntiAFK() {
  if (afkTimer) {
    clearInterval(afkTimer);
    afkTimer = null;
  }
}

// ─────────────────────────────────────────
//  CREATE BOT
// ─────────────────────────────────────────
function createBot() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  log("info", `Connecting to ${CONFIG.MC_HOST}:${CONFIG.MC_PORT} as ${CONFIG.MC_USERNAME}...`);

  try {
    bot = mineflayer.createBot({
      host: CONFIG.MC_HOST,
      port: CONFIG.MC_PORT,
      username: CONFIG.MC_USERNAME,
      version: CONFIG.MC_VERSION,
      auth: CONFIG.MC_AUTH,
      checkTimeoutInterval: 60000,
      hideErrors: false,
    });
  } catch (err) {
    log("error", `Failed to create bot: ${err.message}`);
    scheduleReconnect();
    return;
  }

  // ── SPAWN ──
  bot.once("spawn", () => {
    isConnected = true;
    botStartTime = Date.now();
    reconnectCount = 0;
    log("success", `✅ Bot spawned! Connected to ${CONFIG.MC_HOST}:${CONFIG.MC_PORT}`);
    startAntiAFK();
  });

  // ── CHAT LOGGER ──
  bot.on("chat", (username, message) => {
    if (username === bot.username) return; // skip own messages
    logChat(username, message);
  });

  bot.on("message", (jsonMsg) => {
    const text = jsonMsg.toString();
    if (text && text.trim()) {
      const ts = new Date().toISOString();
      const line = `[${ts}] [SERVER] ${text}\n`;
      fs.appendFile(path.join(__dirname, CONFIG.CHAT_LOG_FILE), line, () => {});
    }
  });

  // ── AUTO RESPAWN ──
  bot.on("death", () => {
    log("warn", "💀 Bot died — respawning...");
    setTimeout(() => {
      try {
        bot.respawn();
        log("success", "✅ Respawned successfully");
      } catch (e) {
        log("error", `Respawn failed: ${e.message}`);
      }
    }, 1500);
  });

  // ── HEALTH LOG ──
  bot.on("health", () => {
    if (bot.health <= 4) {
      log("warn", `❤️  Low health! HP: ${bot.health.toFixed(1)} | Food: ${bot.food}`);
    }
  });

  // ── KICKED ──
  bot.on("kicked", (reason) => {
    isConnected = false;
    stopAntiAFK();
    let reasonText = reason;
    try { reasonText = JSON.parse(reason)?.text || reason; } catch (_) {}
    log("warn", `⚠️  Bot was kicked: ${reasonText}`);
    scheduleReconnect();
  });

  // ── ERROR ──
  bot.on("error", (err) => {
    log("error", `Bot error: ${err.message}`);
    // don't reconnect here — 'end' will fire after error
  });

  // ── END / DISCONNECT ──
  bot.on("end", (reason) => {
    isConnected = false;
    stopAntiAFK();
    log("warn", `🔌 Connection ended: ${reason || "unknown reason"}`);
    scheduleReconnect();
  });
}

// ─────────────────────────────────────────
//  RECONNECT
// ─────────────────────────────────────────
function scheduleReconnect() {
  if (reconnectTimer) return; // already scheduled
  reconnectCount++;
  const delay = Math.min(CONFIG.RECONNECT_DELAY_MS * reconnectCount, 60000); // cap at 60s
  log("info", `🔄 Reconnecting in ${delay / 1000}s... (attempt #${reconnectCount})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, delay);
}

// ─────────────────────────────────────────
//  EXPRESS  +  SELF-PINGER
// ─────────────────────────────────────────
const app = express();

app.get("/", (req, res) => {
  const uptime = botStartTime
    ? Math.floor((Date.now() - botStartTime) / 1000)
    : 0;

  res.json({
    status: "running",
    bot: {
      connected: isConnected,
      username: CONFIG.MC_USERNAME,
      server: `${CONFIG.MC_HOST}:${CONFIG.MC_PORT}`,
      uptime_seconds: uptime,
      reconnect_attempts: reconnectCount,
    },
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.listen(CONFIG.PORT, () => {
  log("success", `🌐 HTTP server listening on port ${CONFIG.PORT}`);
  startSelfPinger();
  createBot();
});

// ─────────────────────────────────────────
//  SELF-PINGER  (prevents Render spin-down)
// ─────────────────────────────────────────
function startSelfPinger() {
  if (!CONFIG.RENDER_URL) {
    log("warn", "RENDER_URL not set — self-pinger disabled. Set it in your env vars!");
    return;
  }

  const pingUrl = `${CONFIG.RENDER_URL}/health`;
  log("info", `🏓 Self-pinger started → ${pingUrl} every ${CONFIG.PING_INTERVAL_MS / 1000 / 60} min`);

  setInterval(async () => {
    try {
      const res = await fetch(pingUrl, { timeout: 10000 });
      log("info", `🏓 Self-ping OK (${res.status})`);
    } catch (err) {
      log("error", `🏓 Self-ping FAILED: ${err.message}`);
    }
  }, CONFIG.PING_INTERVAL_MS);
}

// ─────────────────────────────────────────
//  GRACEFUL SHUTDOWN
// ─────────────────────────────────────────
process.on("SIGINT", () => {
  log("info", "Shutting down...");
  stopAntiAFK();
  if (bot) bot.quit("Shutting down");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  log("error", `Uncaught exception: ${err.message}`);
  // keep process alive, bot will auto-reconnect
});

process.on("unhandledRejection", (reason) => {
  log("error", `Unhandled rejection: ${reason}`);
});
