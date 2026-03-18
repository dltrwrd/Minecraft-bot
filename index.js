require('dotenv').config();
const mineflayer = require('mineflayer');
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const GoalNear = goals.GoalNear;
const pvp = require('mineflayer-pvp');
const autoeat = require('mineflayer-auto-eat');

// ─────────────────────────────────────────
//  CONFIG  (override via environment vars)
// ─────────────────────────────────────────
const CONFIG = {
  // Minecraft server
  MC_HOST: process.env.MC_HOST || 'your-server-ip',
  MC_PORT: parseInt(process.env.MC_PORT) || 25565,
  MC_USERNAME: process.env.MC_USERNAME || 'KeepAliveBot',
  MC_VERSION: process.env.MC_VERSION || '1.20.1', // change to match your server

  // Auth: "offline" for cracked / "microsoft" for premium
  MC_AUTH: process.env.MC_AUTH || 'offline',

  // Render self-ping
  RENDER_URL: process.env.RENDER_URL || '', // e.g. https://your-app.onrender.com
  PING_INTERVAL_MS: parseInt(process.env.PING_INTERVAL_MS) || 60 * 1000, // every 1 min

  // Express port
  PORT: parseInt(process.env.PORT) || 3000,

  // Reconnect delay (ms)
  RECONNECT_DELAY_MS: parseInt(process.env.RECONNECT_DELAY_MS) || 5000,

  // Behavior interval (ms)
  AFK_INTERVAL_MS: parseInt(process.env.AFK_INTERVAL_MS) || 1000,
};

// ─────────────────────────────────────────
//  LOGGER
// ─────────────────────────────────────────
const RESET = '\x1b[0m';
const COLORS = {
  info: '\x1b[36m', // cyan
  success: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  chat: '\x1b[35m', // magenta
  afk: '\x1b[34m', // blue
};

function log(type, msg) {
  const ts = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
  const tag = `[${type.toUpperCase()}]`.padEnd(10);
  console.log(`${COLORS[type] || ''}${ts}  ${tag}  ${msg}${RESET}`);
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
let watchdogTimer = null; // Renamed to watchdogTimer and moved to outer scope

// ─────────────────────────────────────────
//  ANTI-AFK
// ─────────────────────────────────────────
// Actions for mimicking a real player
const PLAYER_ACTIONS = [
  // Jump
  b => {
    if (!b.pathfinder.isMoving() && !b.pvp?.target) {
      b.setControlState('jump', true);
      setTimeout(() => { if (b) b.setControlState('jump', false); }, 500);
    }
  },
  // Swing arm (like mining/punching)
  b => {
    if (!b.pvp?.target) b.swingArm('right');
  },
  // Look at nearest player
  b => {
    if (b.pvp?.target) return;
    const filter = (e) => (e.type === 'player' || e.type === 'mob') && e.id !== b.entity.id && e.position.distanceTo(b.entity.position) < 16;
    const target = b.nearestEntity(filter);
    if (target) {
      b.lookAt(target.position.offset(0, target.height, 0));
    }
  },
  // Toggle Sneak (fast)
  b => {
    if (!b.pvp?.target) {
      b.setControlState('sneak', true);
      setTimeout(() => { if (b) b.setControlState('sneak', false); }, 200);
    }
  },
  // Wander to a random location nearby
  b => {
    if (b.pathfinder.isMoving() || b.pvp?.target) return;
    const { x, y, z } = b.entity.position;
    const randomPos = {
      x: x + Math.floor(Math.random() * 10 - 5),
      y: y,
      z: z + Math.floor(Math.random() * 10 - 5)
    };
    const movements = new Movements(b);
    b.pathfinder.setMovements(movements);
    b.pathfinder.setGoal(new GoalNear(randomPos.x, randomPos.y, randomPos.z, 1));
  },
  // Pick up items (Looting)
  b => {
    if (b.pathfinder.isMoving() || b.pvp?.target) return;
    const filter = (e) => e.type === 'item' && e.position.distanceTo(b.entity.position) < 8;
    const item = b.nearestEntity(filter);
    if (item) {
      const movements = new Movements(b);
      b.pathfinder.setMovements(movements);
      b.pathfinder.setGoal(new GoalNear(item.position.x, item.position.y, item.position.z, 0.5));
    }
  },
];

function triggerRandomBehavior() {
  if (!bot || !isConnected) return;
  const action = PLAYER_ACTIONS[Math.floor(Math.random() * PLAYER_ACTIONS.length)];
  try {
    action(bot);
  } catch (e) {
    /* ignore mid-reconnect errors */
  }
}

function startAntiAFK() {
  stopAntiAFK();

  function loop() {
    triggerRandomBehavior();
    // Add 0-500ms randomness so it's not a perfect mechanical heartbeat
    const nextTick = CONFIG.AFK_INTERVAL_MS + Math.floor(Math.random() * 500);
    afkTimer = setTimeout(loop, nextTick);
  }

  loop();
}

function stopAntiAFK() {
  if (afkTimer) {
    clearTimeout(afkTimer);
    afkTimer = null;
  }
}

// ─────────────────────────────────────────
//  CREATE BOT
// ─────────────────────────────────────────
function createBot() {
  // Clean up old instance if it exists
  if (bot) {
    log('info', 'Cleaning up old bot instance...');
    bot.removeAllListeners();
    try {
      bot.quit();
    } catch (e) {}
    bot = null;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  log('info', `Connecting to ${CONFIG.MC_HOST}:${CONFIG.MC_PORT} as ${CONFIG.MC_USERNAME}...`);

  try {
    bot = mineflayer.createBot({
      host: CONFIG.MC_HOST,
      port: CONFIG.MC_PORT,
      username: CONFIG.MC_USERNAME,
      version: CONFIG.MC_VERSION,
      auth: CONFIG.MC_AUTH,
      hideErrors: false,
    });

    // Proper way to load plugins with safety
    const plugins = [
      { name: 'Pathfinder', fn: pathfinder },
      { name: 'PvP', fn: pvp.plugin },
      { name: 'Auto-Eat', fn: autoeat.loader || autoeat }
    ];

    plugins.forEach(p => {
      if (typeof p.fn === 'function') {
        bot.loadPlugin(p.fn);
      } else {
        log('error', `Failed to load ${p.name}: plugin is not a function (type: ${typeof p.fn})`);
      }
    });

    // Watchdog: If nothing happens for 45s, force a reconnect
    watchdogTimer = setTimeout(() => {
      if (!isConnected) {
        log('warn', '🕒 Connection attempt timed out — forcing reconnect...');
        scheduleReconnect();
      }
    }, 45000);
  } catch (err) {
    log('error', `Failed to create bot: ${err.message}`);
    scheduleReconnect();
    return;
  }

  // ── SPAWN ──
  bot.once('spawn', () => {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    isConnected = true;
    botStartTime = Date.now();
    reconnectCount = 0;
    log('success', `✅ Bot spawned! Connected to ${CONFIG.MC_HOST}:${CONFIG.MC_PORT}`);

    // Auto-eat config
    if (bot.autoeat) {
      bot.autoeat.options = {
        priority: 'foodPoints',
        startAt: 14,
        bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato']
      };
    }

    startAntiAFK();
  });

  // ── SMART REVENGE (Combat) ──
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;

    const entities = bot.entities;
    const suspects = [];

    for (const id in entities) {
      const e = entities[id];
      if (e.id === bot.entity.id) continue;
      
      // Catch all types of mobs/entities that aren't players
      const isMob = (e.type === 'mob' || e.type === 'hostile' || e.type === 'passive');
      const isPlayer = (e.type === 'player');

      if (!isMob && !isPlayer) continue;

      const dist = e.position.distanceTo(bot.entity.position);
      if (dist > 30) continue; // Broad search for archers/mobs

      // Calculate angle/look-at
      const dx = bot.entity.position.x - e.position.x;
      const dz = bot.entity.position.z - e.position.z;
      const angleTowardBot = Math.atan2(-dx, -dz);
      let diff = Math.abs(angleTowardBot - e.yaw) % (Math.PI * 2);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;

      // DETECTION RULES:
      if (isMob) {
        // Any mob within 30 blocks is a suspect (safe over-detection)
        suspects.push({ entity: e, dist: dist, type: 'mob' });
      } else if (isPlayer && dist < 3 && diff < 0.2) {
        // Players must be NEAR and STARING directly (0.2 rad = ~11 deg)
        suspects.push({ entity: e, dist: dist, type: 'player' });
      }
    }

    if (suspects.length > 0 && !bot.pvp.target) {
      // PRIORITY: MOBS > PLAYERS
      const mobs = suspects.filter(s => s.type === 'mob').sort((a,b) => a.dist - b.dist);
      const players = suspects.filter(s => s.type === 'player').sort((a,b) => a.dist - b.dist);

      let target = null;
      if (mobs.length > 0) {
        target = mobs[0].entity; // If a mob is anywhere nearby, it's the perp
      } else if (players.length > 0) {
        target = players[0].entity; // Only if NO mobs are within 30 blocks
      }

      if (target) {
        const name = target.username || target.name || 'Unknown';
        log('warn', `⚔️ RESBAK MODE: Detected ${name} (${target.type}) as the attacker. Babanatan na!`);
        bot.pvp.attack(target);
      }
    }
  });

  bot.on('death', () => {
    if (bot.pvp?.target) bot.pvp.stop();
  });

  bot.on('stoppedAttacking', () => {
    log('info', '🏳️ Target gone or defeated. Combat stopped.');
  });

  // Skip chat/message listeners (no chat logs needed)

  // ── AUTO RESPAWN ──
  bot.on('death', () => {
    // log("warn", "💀 Bot died — respawning...");
    setTimeout(() => {
      try {
        bot.respawn();
        // log("success", "✅ Respawned successfully");
      } catch (e) {
        log('error', `Respawn failed: ${e.message}`);
      }
    }, 1500);
  });

  // ── HEALTH LOG ──
  bot.on('health', () => {
    if (bot.health <= 4) {
      // log("warn", `❤️  Low health! HP: ${bot.health.toFixed(1)} | Food: ${bot.food}`);
    }
  });

  // ── KICKED ──
  bot.on('kicked', reason => {
    isConnected = false;
    stopAntiAFK();
    let reasonText = reason;
    try {
      reasonText = JSON.parse(reason)?.text || reason;
    } catch (_) {}
    log('warn', `⚠️  Bot was kicked: ${reasonText}`);
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    scheduleReconnect();
  });

  // ── ERROR ──
  bot.on('error', err => {
    log('error', `Bot error: ${err.message}`);
    // don't reconnect here — 'end' will fire after error
  });

  // ── END / DISCONNECT ──
  bot.on('end', reason => {
    isConnected = false;
    stopAntiAFK();
    log('warn', `🔌 Connection ended: ${reason || 'unknown reason'}`);
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
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
  log('info', `🔄 Reconnecting in ${delay / 1000}s... (attempt #${reconnectCount})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, delay);
}

// ─────────────────────────────────────────
//  EXPRESS  +  SELF-PINGER
// ─────────────────────────────────────────
const app = express();

app.get('/', (req, res) => {
  const uptime = botStartTime ? Math.floor((Date.now() - botStartTime) / 1000) : 0;

  res.json({
    status: 'running',
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

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(CONFIG.PORT, () => {
  log('success', `🌐 HTTP server listening on port ${CONFIG.PORT}`);
  startSelfPinger();
  createBot();
});

// ─────────────────────────────────────────
//  SELF-PINGER  (prevents Render spin-down)
// ─────────────────────────────────────────
function startSelfPinger() {
  if (!CONFIG.RENDER_URL) {
    log('warn', 'RENDER_URL not set — self-pinger disabled. Set it in your env vars!');
    return;
  }

  const pingUrl = `${CONFIG.RENDER_URL}/health`;
  log(
    'info',
    `🏓 Self-pinger started → ${pingUrl} every ${CONFIG.PING_INTERVAL_MS / 1000 / 60} min`
  );

  setInterval(async () => {
    try {
      const res = await fetch(pingUrl, { timeout: 10000 });
      log('info', `The server is up (${res.status})`);
    } catch (err) {
      log('error', `The server is down: ${err.message}`);
    }
  }, CONFIG.PING_INTERVAL_MS);
}

// ─────────────────────────────────────────
//  GRACEFUL SHUTDOWN
// ─────────────────────────────────────────
process.on('SIGINT', () => {
  log('info', 'Shutting down...');
  stopAntiAFK();
  if (bot) bot.quit('Shutting down');
  process.exit(0);
});

process.on('uncaughtException', err => {
  log('error', `Uncaught exception: ${err.message}`);
  // keep process alive, bot will auto-reconnect
});

process.on('unhandledRejection', reason => {
  log('error', `Unhandled rejection: ${reason}`);
});
