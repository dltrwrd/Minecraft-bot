require('dotenv').config();
const mineflayer = require('mineflayer');
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalFollow } = goals;
const pvp = require('mineflayer-pvp');
const autoeat = require('mineflayer-auto-eat');
const { plugin: collectBlock } = require('mineflayer-collectblock');

// ─────────────────────────────────────────
//  CONFIG  (override via environment vars)
// ─────────────────────────────────────────
const CONFIG = {
  MC_HOST: process.env.MC_HOST || 'your-server-ip',
  MC_PORT: parseInt(process.env.MC_PORT) || 25565,
  MC_USERNAME: process.env.MC_USERNAME || 'KeepAliveBot',
  MC_VERSION: process.env.MC_VERSION || '1.20.1',
  MC_AUTH: process.env.MC_AUTH || 'offline',
  RENDER_URL: process.env.RENDER_URL || '',
  PING_INTERVAL_MS: parseInt(process.env.PING_INTERVAL_MS) || 60 * 1000,
  PORT: parseInt(process.env.PORT) || 3000,
  RECONNECT_DELAY_MS: parseInt(process.env.RECONNECT_DELAY_MS) || 5000,
  AFK_INTERVAL_MS: parseInt(process.env.AFK_INTERVAL_MS) || 30000,
};

// ─────────────────────────────────────────
//  LOGGER
// ─────────────────────────────────────────
const RESET = '\x1b[0m';
const COLORS = {
  info: '\x1b[36m',
  success: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  chat: '\x1b[35m',
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
let watchdogTimer = null;
let botMode = 'AUTONOMOUS';
let companionOwner = null;
let isBusy = false;

// ─────────────────────────────────────────
//  ANTI-AFK BEHAVIORS
// ─────────────────────────────────────────
const PLAYER_ACTIONS = [
  // Jump
  b => {
    if (!b.pathfinder.isMoving() && !b.pvp?.target) {
      b.setControlState('jump', true);
      setTimeout(() => { if (b) b.setControlState('jump', false); }, 500);
    }
  },
  // Swing arm
  b => {
    if (!b.pvp?.target) b.swingArm('right');
  },
  // Look at entity
  b => {
    if (b.pvp?.target) return;
    const filter = e => (e.type === 'player' || e.type === 'mob') && e.id !== b.entity.id && e.position.distanceTo(b.entity.position) < 16;
    const target = b.nearestEntity(filter);
    if (target) b.lookAt(target.position.offset(0, target.height, 0));
  },
  // Sneak
  b => {
    if (!b.pvp?.target) {
      b.setControlState('sneak', true);
      setTimeout(() => { if (b) b.setControlState('sneak', false); }, 200);
    }
  },
  // Follow/Companion logic: Disable Wander if not Autonomous
  b => {
    if (botMode !== 'AUTONOMOUS' || b.pathfinder.isMoving() || b.pvp?.target) return;
    const { x, y, z } = b.entity.position;
    const randomPos = {
      x: x + Math.floor(Math.random() * 10 - 5),
      y: y,
      z: z + Math.floor(Math.random() * 10 - 5),
    };
    const movements = new Movements(b);
    movements.canOpenDoors = true;
    movements.allowParkour = true;
    movements.allowSprinting = true;
    b.pathfinder.setMovements(movements);
    b.pathfinder.setGoal(new GoalNear(randomPos.x, randomPos.y, randomPos.z, 1));
  },
  // 🏃 Maintain Follow/Companion (Persistence)
  b => {
    if (botMode === 'AUTONOMOUS' || b.pvp?.target || b.pathfinder.isMoving()) return;
    
    // Find the master entity manually to avoid stale references
    const masterNick = companionOwner || Object.keys(b.players).find(k => k !== b.username); // Fallback to last chat user or someone else
    const player = b.players[masterNick]?.entity;
    
    if (player) {
      const dist = b.entity.position.distanceTo(player.position);
      if (dist > 3) {
        log('info', `👣 Master ${masterNick} is moving away... Following!`);
        const movements = new Movements(b);
        movements.canOpenDoors = true;
        movements.allowParkour = true;
        movements.allowSprinting = true;
        b.pathfinder.setMovements(movements);
        b.pathfinder.setGoal(new GoalFollow(player, 2));
      }
    }
  },
  // Gathering
  async b => {
    if (botMode !== 'AUTONOMOUS' || isBusy || b.pvp?.target) return;
    const items = b.inventory.items();
    const logs = items.filter(i => i.name.endsWith('_log')).length;
    const cobble = items.filter(i => i.name === 'cobblestone').length;
    const hasPickaxe = items.some(i => i.name.endsWith('_pickaxe'));

    if (logs < 4) {
      const logBlock = b.findBlock({ matching: blk => blk.name.endsWith('_log'), maxDistance: 32 });
      if (logBlock) {
        isBusy = true;
        log('info', `🪓 Mining ${logBlock.name}...`);
        try { await b.collectBlock.collect(logBlock); } catch (e) {}
        isBusy = false;
        return;
      }
    }
    if (hasPickaxe && cobble < 16) {
      const stoneBlock = b.findBlock({ matching: blk => blk.name === 'stone' || blk.name === 'cobblestone', maxDistance: 32 });
      if (stoneBlock) {
        isBusy = true;
        log('info', '⛏️ Mining stone for upgrades...');
        try { await b.collectBlock.collect(stoneBlock); } catch (e) {}
        isBusy = false;
        return;
      }
    }
  },
  // Crafting & Equip
  async b => {
    if (isBusy || b.pvp?.target) return;
    const items = b.inventory.items();
    const hasItem = name => items.some(i => i.name.includes(name));

    const autoCraft = async (targetName, count = 1) => {
      if (hasItem(targetName)) return false;
      const itemData = b.registry.itemsByName[targetName];
      if (!itemData) return false;
      const recipes = b.recipesFor(itemData.id, null, count, null);
      if (recipes.length > 0) {
        log('success', `🛠️ Crafting ${targetName}...`);
        try { await b.craft(recipes[0], count, null); return true; } catch (e) {}
      }
      return false;
    };

    await autoCraft('oak_planks', 4);
    if (await autoCraft('crafting_table')) return;
    if (await autoCraft('stick', 4)) return;
    if (!hasItem('pickaxe')) {
       if (await autoCraft('stone_pickaxe')) return;
       if (await autoCraft('wooden_pickaxe')) return;
    }
    if (!hasItem('sword')) {
       if (await autoCraft('stone_sword')) return;
       if (await autoCraft('wooden_sword')) return;
    }
    if (items.filter(i => i.name === 'cobblestone').length >= 8) if (await autoCraft('furnace')) return;

    // Equip armor
    const armorSlots = ['head', 'torso', 'legs', 'feet'];
    for (const slot of armorSlots) {
      const bestArmor = items.filter(i => i.name.includes('helmet') || i.name.includes('chestplate') || i.name.includes('leggings') || i.name.includes('boots'))
                            .sort((a, b) => (b.value || 0) - (a.value || 0))[0];
      if (bestArmor) b.equip(bestArmor, slot).catch(() => {});
    }
    const sword = items.filter(i => i.name.includes('sword')).sort((a,b) => (b.value || 0) - (a.value || 0))[0];
    if (sword) b.equip(sword, 'hand').catch(() => {});
  }
];

function triggerRandomBehavior() {
  if (!bot || !isConnected || isBusy) return;
  const action = PLAYER_ACTIONS[Math.floor(Math.random() * PLAYER_ACTIONS.length)];
  try { action(bot); } catch (e) {}
}

function startAntiAFK() {
  stopAntiAFK();
  function loop() {
    triggerRandomBehavior();
    afkTimer = setTimeout(loop, CONFIG.AFK_INTERVAL_MS + Math.floor(Math.random() * 500));
  }
  loop();
}

function stopAntiAFK() {
  if (afkTimer) { clearTimeout(afkTimer); afkTimer = null; }
}

// ─────────────────────────────────────────
//  CREATE BOT
// ─────────────────────────────────────────
function createBot() {
  if (bot) {
    log('info', 'Cleaning up old bot instance...');
    bot.removeAllListeners();
    try { bot.quit(); } catch (e) {}
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

    const plugins = [
      { name: 'Pathfinder', fn: pathfinder },
      { name: 'PvP', fn: pvp.plugin },
      { name: 'Auto-Eat', fn: autoeat.loader || autoeat },
      { name: 'CollectBlock', fn: collectBlock },
    ];

    plugins.forEach(p => {
      if (typeof p.fn === 'function') bot.loadPlugin(p.fn);
      else log('error', `Failed to load ${p.name}`);
    });

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

  bot.once('spawn', () => {
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
    isConnected = true;
    botStartTime = Date.now();
    reconnectCount = 0;
    log('success', `✅ Bot spawned! Connected as ${bot.username}`);

    if (bot.autoeat) {
      bot.autoeat.options = {
        priority: 'foodPoints',
        startAt: 14,
        bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato'],
      };
    }
    // Delay behavior start to avoid anti-bot kicks immediately after spawn
    setTimeout(() => {
      if (isConnected) {
        log('info', '🕒 Grace period ended. Starting autonomous behaviors...');
        startAntiAFK();
      }
    }, 10000); // 10 second wait
  });

  bot.on('entityHurt', (entity) => {
    const isMaster = (entity.type === 'player' && entity.username === companionOwner && botMode === 'COMPANION');
    const player = bot.players[companionOwner]?.entity;
    
    // ASSIST ATTACK
    if (botMode === 'COMPANION' && player && entity !== bot.entity && entity !== player) {
       const distToMaster = player.position.distanceTo(entity.position);
       if (distToMaster < 5) {
          const dx = entity.position.x - player.position.x;
          const dz = entity.position.z - player.position.z;
          const angle = Math.atan2(-dx, -dz);
          let diff = Math.abs(angle - player.yaw) % (Math.PI * 2);
          if (diff > Math.PI) diff = Math.PI * 2 - diff;
          if (diff < 0.6 && !bot.pvp?.target) {
             bot.chat(`Sure Master, I'll help you with ${entity.username || entity.name}!`);
             bot.pvp.attack(entity);
             return;
          }
       }
    }

    // SELF DEFENSE / PROTECTION
    if (entity !== bot.entity && !isMaster) return;

    const suspects = [];
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (e.id === bot.entity.id || (e.type === 'player' && e.username === companionOwner)) continue;
      
      const isCombatant = (e.type === 'mob' || e.type === 'hostile' || e.type === 'passive' || e.type === 'player');
      if (!isCombatant) continue;

      const dist = e.position.distanceTo(bot.entity.position);
      if (dist > 30) continue; 

      const dx = bot.entity.position.x - e.position.x;
      const dz = bot.entity.position.z - e.position.z;
      const angleTowardBot = Math.atan2(-dx, -dz);
      let diff = Math.abs(angleTowardBot - e.yaw) % (Math.PI * 2);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;

      if (e.type !== 'player' || (dist < 4 && diff < 0.3)) {
        suspects.push({ entity: e, dist: dist, type: e.type });
      }
    }

    if (suspects.length > 0 && !bot.pvp.target) {
      const targets = suspects.sort((a,b) => {
        if (a.type !== 'player' && b.type === 'player') return -1;
        if (a.type === 'player' && b.type !== 'player') return 1;
        return a.dist - b.dist;
      });
      const target = targets[0].entity;
      const victimStr = entity === bot.entity ? 'me' : 'my master';
      log('warn', `⚔️ RETALIATION MODE: Protecting ${victimStr}! Target: ${target.username || target.name}.`);
      bot.chat(`Retaliation mode! Do not touch ${victimStr}!`);
      bot.pvp.attack(target);
    }
  });

  bot.on('death', () => { if (bot.pvp?.target) bot.pvp.stop(); });
  bot.on('stoppedAttacking', () => { log('info', '🏳️ Target gone or defeated. Combat stopped.'); });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;

    if (message === '!follow') {
      botMode = 'FOLLOW';
      const player = bot.players[username]?.entity;
      if (!player) return bot.chat("I can't see you!");
      bot.chat(`Okay, I'm following you ${username}!`);
      const movements = new Movements(bot);
      movements.canOpenDoors = true;
      movements.allowParkour = true;
      movements.allowSprinting = true;
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.setGoal(new GoalFollow(player, 2));
    } else if (message === '!companion') {
      botMode = 'COMPANION';
      companionOwner = username;
      const player = bot.players[username]?.entity;
      if (!player) return bot.chat("I can't see you! Come closer to me.");
      bot.chat(`I'm ready, Master ${username}! I'm your bodyguard now. I'll follow you and retaliate if someone messes with you!`);
      const movements = new Movements(bot);
      movements.canOpenDoors = true;
      movements.allowParkour = true;
      movements.allowSprinting = true;
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.setGoal(new GoalFollow(player, 2));
    } else if (message === '!stop') {
      botMode = 'AUTONOMOUS';
      companionOwner = null;
      isBusy = false;
      if (bot.pvp) bot.pvp.stop();
      bot.pathfinder.setGoal(null);
      bot.chat("Got it, I'll stop now. Returning to Autonomous mode!");
      log('info', '🛑 Bot task stopped manually. Returning to AUTONOMOUS behavior.');
    } else if (message === '!inventory') {
      const items = bot.inventory.items().map(i => `${i.count}x ${i.name}`).join(', ');
      bot.chat(items ? `My inventory: ${items}` : "I don't have any items.");
    }
  });
  
  bot.on('playerLeft', (player) => {
    if (player.username === companionOwner) {
      log('info', `Master ${companionOwner} left the server. Returning to AUTONOMOUS mode.`);
      botMode = 'AUTONOMOUS';
      companionOwner = null;
      isBusy = false;
      bot.pathfinder.setGoal(null);
    }
  });

  bot.on('death', () => {
    setTimeout(() => { try { bot.respawn(); } catch (e) {} }, 1500);
  });

  bot.on('kicked', reason => {
    isConnected = false;
    stopAntiAFK();
    log('warn', `⚠️ Bot was kicked: ${reason}`);
    scheduleReconnect();
  });

  bot.on('error', err => { log('error', `Bot error: ${err.message}`); });
  bot.on('end', reason => {
    isConnected = false;
    stopAntiAFK();
    log('warn', `🔌 Connection ended: ${reason}`);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectCount++;
  const delay = Math.min(CONFIG.RECONNECT_DELAY_MS * reconnectCount, 60000);
  log('info', `🔄 Reconnecting in ${delay / 1000}s... (attempt #${reconnectCount})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, delay);
}

const app = express();
app.get('/', (req, res) => {
  res.json({ status: 'running', bot: { connected: isConnected, username: CONFIG.MC_USERNAME } });
});
app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(CONFIG.PORT, () => {
  log('success', `🌐 HTTP server listening on port ${CONFIG.PORT}`);
  startSelfPinger();
  createBot();
});

function startSelfPinger() {
  if (!CONFIG.RENDER_URL) return;
  setInterval(async () => {
    try {
      const res = await fetch(`${CONFIG.RENDER_URL}/health`, { timeout: 10000 });
      log('info', `The server is up (${res.status})`);
    } catch (err) {}
  }, CONFIG.PING_INTERVAL_MS);
}

process.on('SIGINT', () => {
  log('info', 'Shutting down...');
  stopAntiAFK();
  if (bot) bot.quit();
  process.exit(0);
});

process.on('uncaughtException', err => { log('error', `Uncaught exception: ${err.message}`); });
process.on('unhandledRejection', reason => { log('error', `Unhandled rejection: ${reason}`); });
