require('dotenv').config();
const mineflayer = require('mineflayer');
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const Vec3 = require('vec3').Vec3 || require('vec3');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalFollow } = goals;
const pvp = require('mineflayer-pvp');
const autoeat = require('mineflayer-auto-eat').loader;
const { plugin: collectBlock } = require('mineflayer-collectblock');

// ─────────────────────────────────────────
//  CONFIG  (override via environment vars)
// ─────────────────────────────────────────
let CONFIG = {
  MC_HOST: process.env.MC_HOST || '',
  MC_PORT: parseInt(process.env.MC_PORT) || 25565,
  MC_USERNAME: process.env.MC_USERNAME || 'EdgeRunner',
  MC_VERSION: process.env.MC_VERSION || '1.20.1',
  MC_AUTH: process.env.MC_AUTH || 'offline',
  RENDER_URL: process.env.RENDER_URL || '',
  PING_INTERVAL_MS: parseInt(process.env.PING_INTERVAL_MS) || 60 * 1000,
  PORT: parseInt(process.env.PORT) || 3000,
  RECONNECT_DELAY_MS: parseInt(process.env.RECONNECT_DELAY_MS) || 5000,
  AFK_INTERVAL_MS: parseInt(process.env.AFK_INTERVAL_MS) || 30000,
  MC_OWNER: process.env.MC_OWNER || '',
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
  const fullMsg = `${ts}  ${tag}  ${msg}`;

  // 📝 Web Dashboard gets ALL logs
  recentLogs.push({ type, msg, time: ts });
  if (recentLogs.length > 50) recentLogs.shift();

  // 🖥️ Terminal only gets ESSENTIAL logs (Spawn, Connect, Ping, Success, Error)
  const isEssential =
    type === 'success' ||
    type === 'error' ||
    msg.includes('Spawned') ||
    msg.includes('Connected') ||
    msg.includes('server is up') ||
    msg.includes('listening');

  if (isEssential) {
    console.log(`${COLORS[type] || ''}${fullMsg}${RESET}`);
  }
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
let recentLogs = [];
let isAttacked = false;
let attackTimeout = null;
let isBusy = false;
let activeLoopId = 0;
let botModules = {
  eat: true,
  craft: true,
  mine: true,
  hunt: true,
  pvp: true,
};

// ─────────────────────────────────────────
//  ANTI-AFK BEHAVIORS
// ─────────────────────────────────────────
const PLAYER_ACTIONS = [
  // eatAction: Manual Fallback Eat (High Priority)
  Object.assign(
    async b => {
      if (!botModules.eat || b.food >= 19 || isBusy) return false;
      const items = b.inventory.items();
      const foodItems = items.filter(i =>
        [
          'beef',
          'porkchop',
          'mutton',
          'chicken',
          'rabbit',
          'cod',
          'salmon',
          'apple',
          'bread',
          'carrot',
          'potato',
          'melon_slice',
          'sweet_berries',
          'glow_berries',
          'cookie',
          'pumpkin_pie',
          'steak',
          'cooked_porkchop',
          'cooked_mutton',
          'cooked_chicken',
          'cooked_rabbit',
          'cooked_cod',
          'cooked_salmon',
          'baked_potato',
          'golden_apple',
          'golden_carrot',
        ].includes(i.name)
      );
      if (foodItems.length > 0) {
        const bestFood = foodItems.sort((a, b) => (b.foodPoints || 0) - (a.foodPoints || 0))[0];
        isBusy = true;
        log('info', `🥪 Manual Eat: Consuming ${bestFood.name} (Hunger: ${b.food}/20)...`);
        try {
          await b.equip(bestFood, 'hand');
          await b.consume();
          return true;
        } catch (e) {
          log('error', `Manual Eat failed: ${e.message}`);
        } finally {
          isBusy = false;
        }
      }
      return false;
    },
    { taskName: 'eatAction' }
  ),
  // idleAction: Jump
  Object.assign(
    b => {
      if (!b.pathfinder.isMoving() && !b.pvp?.target) {
        b.setControlState('jump', true);
        setTimeout(() => {
          if (b) b.setControlState('jump', false);
        }, 500);
      }
    },
    { taskName: 'idleAction' }
  ),

  // idleAction: Swing arm
  Object.assign(
    b => {
      if (!b.pvp?.target) b.swingArm('right');
    },
    { taskName: 'idleAction' }
  ),

  // idleAction: Look at entity
  Object.assign(
    b => {
      if (b.pvp?.target) return;
      const filter = e =>
        (e.type === 'player' || e.type === 'mob') &&
        e.id !== b.entity.id &&
        e.position.distanceTo(b.entity.position) < 16;
      const target = b.nearestEntity(filter);
      if (target) b.lookAt(target.position.offset(0, target.height, 0));
    },
    { taskName: 'idleAction' }
  ),

  // idleAction: Sneak
  Object.assign(
    b => {
      if (!b.pvp?.target) {
        b.setControlState('sneak', true);
        setTimeout(() => {
          if (b) b.setControlState('sneak', false);
        }, 200);
      }
    },
    { taskName: 'idleAction' }
  ),

  // wanderAction: Wander
  Object.assign(
    b => {
      if (botMode !== 'AUTONOMOUS' || b.pathfinder.isMoving() || b.pvp?.target) return false;
      const { x, y, z } = b.entity.position;
      const randomPos = {
        x: x + Math.floor(Math.random() * 20 - 10),
        y: y,
        z: z + Math.floor(Math.random() * 20 - 10),
      };
      const movements = new Movements(b);
      movements.canOpenDoors = true;
      movements.allowParkour = true;
      movements.allowSprinting = true;
      b.pathfinder.setMovements(movements);
      b.pathfinder.setGoal(new GoalNear(randomPos.x, randomPos.y, randomPos.z, 2));
      return true;
    },
    { taskName: 'wanderAction' }
  ),

  // gatheringAction: Mining & Hunting
  Object.assign(
    async b => {
      if (botMode !== 'AUTONOMOUS' || isBusy || b.pvp?.target) return false;
      const items = b.inventory.items();
      const findCount = name =>
        items.filter(i => i.name.includes(name)).reduce((sum, i) => sum + i.count, 0);

      const logs = findCount('_log');
      const cobble = findCount('cobblestone');
      const hasPickaxe = items.some(i => i.name.includes('pickaxe'));
      const hasStonePickaxe = items.some(i => i.name.includes('stone_pickaxe'));

      // WOOD / LOGS
      if (botModules.mine && logs < 16) {
        const logBlock = b.findBlock({
          matching: blk => blk.name.endsWith('_log'),
          maxDistance: 32,
        });
        if (logBlock) {
          isBusy = true;
          log('info', `🪓 Mining ${logBlock.name}...`);
          try {
            await b.collectBlock.collect(logBlock);
          } catch (e) {
          } finally {
            isBusy = false;
          }
          return true;
        }
      }

      // STONE & IRON
      if (botModules.mine && hasPickaxe && cobble < 64) {
        const stoneBlock = b.findBlock({
          matching: blk =>
            blk.name === 'stone' ||
            blk.name === 'cobblestone' ||
            (hasStonePickaxe && blk.name.includes('iron_ore')),
          maxDistance: 32,
        });
        if (stoneBlock) {
          isBusy = true;
          log('info', `⛏️ Mining ${stoneBlock.name} for resources...`);
          try {
            await b.collectBlock.collect(stoneBlock);
          } catch (e) {
          } finally {
            isBusy = false;
          }
          return true;
        }
      }

      // HUNTING (For leather & food)
      const armorItems = items.filter(
        i =>
          i.name.includes('helmet') ||
          i.name.includes('chestplate') ||
          i.name.includes('leggings') ||
          i.name.includes('boots')
      );
      const foodItems = items.filter(i =>
        ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon'].some(f =>
          i.name.includes(f)
        )
      );

      // Hunt if we need armor OR if we're low on food
      if (botModules.hunt && (armorItems.length < 4 || foodItems.length < 5 || b.food < 15)) {
        const target = b.nearestEntity(
          e =>
            e.type === 'mob' &&
            ['cow', 'sheep', 'pig', 'chicken'].includes(e.name) &&
            e.position.distanceTo(b.entity.position) < 24
        );
        if (target) {
          log('info', `🥩 Hunting ${target.name} for food/leather...`);
          b.lookAt(target.position.offset(0, target.height, 0));

          // Equip sword for hunting
          const sword = items.find(i => i.name.includes('sword'));
          if (sword) b.equip(sword, 'hand').catch(() => {});

          b.pvp.attack(target);
          return true;
        }
      }
      return false;
    },
    { taskName: 'gatheringAction' }
  ),

  // craftingAction: Crafting & Equip
  Object.assign(
    async b => {
      if (botMode !== 'AUTONOMOUS' || isBusy || b.pvp?.target) return false;
      const items = b.inventory.items();
      const findCount = name =>
        items.filter(i => i.name.includes(name)).reduce((sum, i) => sum + i.count, 0);

      const autoCraft = async (targetName, reqCount = 1) => {
        const currentCount = findCount(targetName);
        if (currentCount >= reqCount) return false;

        const itemData = b.registry.itemsByName[targetName];
        if (!itemData) return false;

        // 🔍 Find nearby crafting table (Search widely to avoid 'messes' of tables)
        let tableBlock = b.findBlock({
          matching: blk => blk.name === 'crafting_table',
          maxDistance: 32,
        });

        // 🛠️ Determine if this recipe REQUIRES a 3x3 table
        const recipes2x2 = b.recipesFor(itemData.id, null, 1, null);
        const needsTable = recipes2x2.length === 0;

        if (needsTable && !tableBlock) {
          if (findCount('crafting_table') > 0) {
            log('info', '🏗️ Placing crafting table for tools/armor...');
            const ground = b.findBlock({
              matching: blk =>
                blk.name !== 'air' &&
                blk.name !== 'water' &&
                blk.name !== 'lava' &&
                blk.boundingBox === 'block',
              maxDistance: 4,
            });
            if (ground && b.entity && b.entity.position) {
              isBusy = true;
              try {
                const tableItem = b.inventory.items().find(i => i.name === 'crafting_table');
                if (tableItem) {
                  // 🥾 Move slightly away to avoid standing on the spot
                  const p = ground.position.offset(0.5, 1, 0.5);
                  if (b.entity.position.distanceTo(p) < 1.5) {
                    const movePos = p.offset(
                      Math.random() > 0.5 ? 2 : -2,
                      0,
                      Math.random() > 0.5 ? 2 : -2
                    );
                    b.pathfinder.setMovements(new Movements(b));
                    await b.pathfinder.goto(new GoalNear(movePos.x, movePos.y, movePos.z, 0.5));
                  }

                  await b.equip(tableItem, 'hand');
                  await b.lookAt(ground.position.offset(0.5, 1, 0.5));
                  log('info', `🏗️ Placing table on ${ground.name} at ${ground.position}...`);
                  await b.placeBlock(ground, new Vec3(0, 1, 0));
                  // Wait a moment for server to sync
                  await new Promise(r => setTimeout(r, 500));
                  tableBlock = b.findBlock({
                    matching: blk => blk.name === 'crafting_table',
                    maxDistance: 4,
                  });
                }
              } catch (e) {
                log('error', `Placement failed: ${e.message}`);
                // Add a cooldown if placement fails
                await new Promise(r => setTimeout(r, 2000));
              } finally {
                isBusy = false;
              }
            }
          } else {
            return false;
          }
        }

        const recipes = b.recipesFor(itemData.id, tableBlock, 1, null);
        if (recipes.length > 0) {
          // 🚶 Walk to the table if it's too far away
          if (tableBlock && b.entity.position.distanceTo(tableBlock.position) > 3) {
            log('info', `🚶 Walking to crafting table at ${tableBlock.position}...`);
            b.pathfinder.setMovements(new Movements(b));
            try {
              await b.pathfinder.goto(
                new GoalNear(tableBlock.position.x, tableBlock.position.y, tableBlock.position.z, 2)
              );
            } catch (e) {}
          }

          log('success', `🛠️ Crafting ${targetName}...`);
          try {
            await b.craft(recipes[0], 1, tableBlock);
            // 🧹 Only pick up if we placed it OR if we're done here
            return true;
          } catch (e) {
            log('error', `Crafting error: ${e.message}`);
          }
        }
        return false;
      };

      // 🪵 DYNAMIC WOOD PROCESSING (Any log to its planks)
      const logItem = items.find(i => i.name.endsWith('_log'));
      if (logItem) {
        const plankName = logItem.name.replace('_log', '_planks');
        if (findCount('_planks') < 24) if (await autoCraft(plankName, 24)) return true;
      }

      if (await autoCraft('crafting_table', 1)) return true;
      if (await autoCraft('stick', 16)) return true;
      const hasPickaxe = items.some(i => i.name.includes('pickaxe'));
      const hasSword = items.some(i => i.name.includes('sword'));
      if (!hasPickaxe) {
        if (await autoCraft('stone_pickaxe', 1)) return true;
        if (await autoCraft('wooden_pickaxe', 1)) return true;
      }
      if (!hasSword) {
        if (await autoCraft('stone_sword', 1)) return true;
        if (await autoCraft('wooden_sword', 1)) return true;
      }
      if (findCount('cobblestone') >= 8 && findCount('furnace') === 0)
        if (await autoCraft('furnace', 1)) return true;

      // 🛡️ SHIELD (1 Iron Ingot + 6 Planks)
      if (findCount('iron_ingot') >= 1 && findCount('_planks') >= 6 && findCount('shield') === 0) {
        if (await autoCraft('shield', 1)) return true;
      }

      // 🔬 SMELTING LOGIC (Simplified)
      if (findCount('iron_ore') > 0 && findCount('iron_ingot') < 24) {
        const furnace = b.findBlock({ matching: blk => blk.name === 'furnace', maxDistance: 4 });
        if (furnace) {
          log('info', '🔥 Using furnace to smelt iron...');
          try {
            const f = await b.openFurnace(furnace);
            const ore = items.find(i => i.name.includes('iron_ore'));
            const fuel = items.find(
              i => i.name.includes('planks') || i.name.includes('log') || i.name.includes('stick')
            );
            if (ore && fuel) {
              await f.putInput(ore.type, null, 1);
              await f.putFuel(fuel.type, null, 1);
              setTimeout(() => f.close(), 5000);
              return true;
            }
          } catch (e) {}
        } else if (findCount('furnace') > 0) {
          // Place furnace
          const ground = b.findBlock({
            matching: blk =>
              blk.name !== 'air' && blk.name !== 'water' && blk.boundingBox === 'block',
            maxDistance: 4,
          });
          const furnaceItem = items.find(i => i.name === 'furnace');
          if (ground && furnaceItem && b.entity && b.entity.position) {
            try {
              isBusy = true;
              await b.equip(furnaceItem, 'hand');
              const faceVector = b.entity.position.clone();
              faceVector.x = 0;
              faceVector.y = 1;
              faceVector.z = 0;
              log('info', `🔥 Placing furnace on ${ground.name} at ${ground.position}...`);
              await b.placeBlock(ground, faceVector);
            } catch (e) {
              log('error', `Furnace placement failed: ${e.message}`);
            }
            isBusy = false;
            return true;
          }
        }
      }

      const armorSets = [
        ['iron_chestplate', 'iron_leggings', 'iron_helmet', 'iron_boots'],
        ['leather_chestplate', 'leather_leggings', 'leather_helmet', 'leather_boots'],
      ];
      for (const set of armorSets) {
        for (const piece of set) {
          if (findCount(piece) === 0) if (await autoCraft(piece, 1)) return true;
        }
      }

      return false;
    },
    { taskName: 'craftingAction' }
  ),
];

async function triggerRandomBehavior() {
  if (!bot || !isConnected || isBusy) return;

  // 🛡️ TOP PRIORITY: GEAR CHECK (Runs every tick! Done before anything else)
  // Ensure we are wearing the best gear and holding weapons
  const items = bot.inventory.items();
  const armorSlotsMap = {
    helmet: 'head',
    chestplate: 'torso',
    leggings: 'legs',
    boots: 'feet',
    shield: 'off-hand',
  };
  for (const [key, slot] of Object.entries(armorSlotsMap)) {
    const best = items
      .filter(i => i.name.includes(key))
      .sort((a, b) => (b.value || 0) - (a.value || 0))[0];
    if (
      best &&
      (!bot.inventory.slots[
        slot === 'head' ? 5 : slot === 'torso' ? 6 : slot === 'legs' ? 7 : slot === 'feet' ? 8 : 45
      ] ||
        bot.inventory.slots[
          slot === 'head'
            ? 5
            : slot === 'torso'
              ? 6
              : slot === 'legs'
                ? 7
                : slot === 'feet'
                  ? 8
                  : 45
        ].name !== best.name)
    ) {
      bot.equip(best, slot).catch(() => {});
    }
  }
  const bestSword = items
    .filter(i => i.name.includes('sword'))
    .sort((a, b) => (b.value || 0) - (a.value || 0))[0];
  if (bestSword && (!bot.heldItem || bot.heldItem.name !== bestSword.name) && !isBusy) {
    bot.equip(bestSword, 'hand').catch(() => {});
  }

  // 1️⃣ PRIORITY: EATING (Manual Check)
  if (botModules.eat && bot.food < 19) {
    const eatAction = PLAYER_ACTIONS.find(p => p.taskName === 'eatAction');
    if (eatAction) {
      const result = await eatAction(bot);
      if (result === true) return;
    }
  }

  // 2️⃣ PRIORITY: KILL MODE
  if (botMode === 'KILL' && companionOwner) {
    const target = bot.players[companionOwner]?.entity;
    if (target) {
      const dist = bot.entity.position.distanceTo(target.position);
      if (dist > 3) {
        if (!bot.pathfinder.isMoving()) {
          log(
            'info',
            `🎯 HUNTING: ${companionOwner} detected at ${Math.round(dist)}m. Closing in!`
          );
          bot.pathfinder.setGoal(new GoalFollow(target, 2), true);
        }
      } else if (!bot.pvp?.target) {
        log('warn', `⚔️ KILL PROTOCOL: Engaging ${companionOwner}!`);
        // Equip sword for combat
        const sword = items.find(i => i.name.includes('sword'));
        if (sword) bot.equip(sword, 'hand').catch(() => {});
        bot.pvp.attack(target);
      }
      return;
    } else {
      if (!bot.pathfinder.isMoving()) {
        log('warn', `🔍 TARGET LOST: Searching for ${companionOwner}'s last known signal...`);
        // Randomly look around to simulate searching
        bot.lookAt(bot.entity.position.offset(Math.random() * 10 - 5, 2, Math.random() * 10 - 5));
      }
    }
  }

  // 3️⃣ PRIORITY: FOLLOW/COMPANION
  if (botMode !== 'AUTONOMOUS' && !bot.pvp?.target && !bot.pathfinder.isMoving()) {
    const masterNick = companionOwner || Object.keys(bot.players).find(k => k !== bot.username);
    const player = bot.players[masterNick]?.entity;

    if (player) {
      const dist = bot.entity.position.distanceTo(player.position);
      if (dist > 3) {
        log('info', `👣 Master ${masterNick} is far (${Math.round(dist)}m). Resuming follow!`);
        const movements = new Movements(bot);
        movements.canOpenDoors = true;
        movements.allowParkour = true;
        movements.allowSprinting = true;
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(new GoalFollow(player, 2));
        return;
      }
    } else if (companionOwner) {
      log('warn', `🔍 Master ${companionOwner} lost! Looking for them...`);
      bot.lookAt(bot.entity.position.offset(Math.random() * 10 - 5, 2, Math.random() * 10 - 5));
    }
  }

  // 2️⃣ PRIORITY: COMBAT TARGET
  if (bot.pvp?.target) return;

  // 3️⃣ PRIORITY: PROACTIVE DEFENSE (Attack hostiles within 4m)
  if (botModules.pvp && !bot.pvp?.target) {
    const hostile = bot.nearestEntity(
      e =>
        [
          'zombie',
          'skeleton',
          'creeper',
          'spider',
          'enderman',
          'witch',
          'slime',
          'phantom',
          'drowned',
          'husk',
          'stray',
          'hoglin',
          'piglin',
          'zoglin',
        ].includes(e.name) && e.position.distanceTo(bot.entity.position) < 4
    );
    if (hostile) {
      log('warn', `⚔️ PROACTIVE DEFENSE: Detected ${hostile.name} nearby. Engaging!`);
      isBusy = false; // Override busy state for combat
      const items = bot.inventory.items();
      const sword = items.find(i => i.name.includes('sword'));
      if (sword) bot.equip(sword, 'hand').catch(() => {});
      bot.pvp.attack(hostile);
      return;
    }
  }

  // 4️⃣ PRIORITY: CRAFTING
  if (botMode === 'AUTONOMOUS' && botModules.craft) {
    const craftAction = PLAYER_ACTIONS.find(p => p.taskName === 'craftingAction');
    if (craftAction) {
      const result = await craftAction(bot);
      if (result === true) return;
    }
  }

  // 5️⃣ PRIORITY: GATHERING (MINE & HUNT)
  if (botMode === 'AUTONOMOUS' && (botModules.mine || botModules.hunt)) {
    const gatherAction = PLAYER_ACTIONS.find(p => p.taskName === 'gatheringAction');
    if (gatherAction) {
      const result = await gatherAction(bot);
      if (result === true) return;
    }
  }

  // 5️⃣ PRIORITY: WANDER/IDLE
  if (botMode === 'AUTONOMOUS' && !bot.pathfinder.isMoving() && Math.random() < 0.3) {
    const wanderAction = PLAYER_ACTIONS.find(p => p.taskName === 'wanderAction');
    if (wanderAction) wanderAction(bot);
  }

  // 6️⃣ FALLBACK: RANDOM IDLE
  const idleActions = PLAYER_ACTIONS.filter(p => p.taskName === 'idleAction');
  const action = idleActions[Math.floor(Math.random() * idleActions.length)];
  if (action) action(bot);
}

function startAntiAFK() {
  stopAntiAFK();
  const loopId = ++activeLoopId;
  async function loop() {
    if (loopId !== activeLoopId) {
      log('warn', '🛑 Stopping zombie behavior loop.');
      return;
    }
    await triggerRandomBehavior();
    // Use faster interval if in COMPANION/FOLLOW mode
    const interval =
      botMode === 'AUTONOMOUS' ? CONFIG.AFK_INTERVAL_MS : Math.min(CONFIG.AFK_INTERVAL_MS, 2000);
    if (loopId === activeLoopId) {
      afkTimer = setTimeout(loop, interval + Math.floor(Math.random() * 500));
    }
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
      checkTimeoutInterval: 60000, // Increase timeout check
      keepAlive: true,
      viewDistance: 'tiny', // Lower data usage to avoid overload
    });

    bot.setMaxListeners(100);
    bot.on('inject_allowed', () => {
      if (bot._client) bot._client.setMaxListeners(100);
    });
    bot.on('windowOpen', window => {
      window.setMaxListeners(100);
    });

    const plugins = [
      { name: 'Pathfinder', fn: pathfinder },
      { name: 'PvP', fn: pvp.plugin },
      { name: 'Auto-Eat', fn: autoeat },
      { name: 'CollectBlock', fn: collectBlock },
    ];

    plugins.forEach(p => {
      if (typeof p.fn === 'function') bot.loadPlugin(p.fn);
      else log('error', `Failed to load ${p.name}`);
    });

    // Tune PvP settings after plugin is loaded
    if (bot.pvp) {
      bot.pvp.moveSpeed = 1.3; // Much faster tracking
      bot.pvp.attackRange = 4.2; // Optimized reach
    }

    // 🤺 COMBAT FRENZY (Strafe & Criticals)
    let strafeDir = 1;
    let strafeTimer = 0;

    bot.on('physicsTick', () => {
      if (!bot.pvp || !bot.pvp.target) {
        bot.setControlState('sprint', false);
        bot.setControlState('left', false);
        bot.setControlState('right', false);
        bot.setControlState('jump', false);
        return;
      }

      // Always sprint for knockback
      bot.setControlState('sprint', true);

      // 🌪️ ZIG-ZAG STRAFE Logic
      strafeTimer++;
      if (strafeTimer > 10) {
        strafeDir *= -1;
        strafeTimer = 0;
      }
      bot.setControlState('left', strafeDir === 1);
      bot.setControlState('right', strafeDir === -1);

      // ⚡ CRITICAL HIT LOGIC (Jump before strike)
      const dist = bot.entity.position.distanceTo(bot.pvp.target.position);
      if (dist < 4 && bot.entity.onGround) {
        bot.setControlState('jump', true);
      } else {
        bot.setControlState('jump', false);
      }
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
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    isConnected = true;
    botStartTime = Date.now();
    reconnectCount = 0;
    log('success', `✅ Bot spawned! Connected as ${bot.username}`);

    if (bot.autoEat) {
      bot.autoEat.options = {
        priority: 'foodPoints',
        startAt: 19,
      };
      if (botModules.eat) bot.autoEat.enableAuto();
      else bot.autoEat.disableAuto();
    }
    // Delay behavior start briefly to avoid kicks
    setTimeout(() => {
      if (isConnected) {
        log('info', '🕒 Starting autonomous behaviors...');
        bot.setControlState('jump', true); // Simple move to show we are alive
        setTimeout(() => bot.setControlState('jump', false), 500);
        startAntiAFK();
      }
    }, 2000); // 2 second wait
  });

  bot.on('playerCollect', () => {
    if (!isConnected) return;
    // Trigger immediate gear check when items are picked up
    const items = bot.inventory.items();
    const armorSlotsMap = {
      helmet: 'head',
      chestplate: 'torso',
      leggings: 'legs',
      boots: 'feet',
      shield: 'off-hand',
    };
    for (const [key, slot] of Object.entries(armorSlotsMap)) {
      const best = items
        .filter(i => i.name.includes(key))
        .sort((a, b) => (b.value || 0) - (a.value || 0))[0];
      const slotId =
        slot === 'head' ? 5 : slot === 'torso' ? 6 : slot === 'legs' ? 7 : slot === 'feet' ? 8 : 45;
      if (
        best &&
        (!bot.inventory.slots[slotId] || bot.inventory.slots[slotId].name !== best.name)
      ) {
        bot.equip(best, slot).catch(() => {});
      }
    }
  });

  bot.on('entityHurt', entity => {
    if (entity === bot.entity) {
      isAttacked = true;
      if (attackTimeout) clearTimeout(attackTimeout);
      attackTimeout = setTimeout(() => (isAttacked = false), 5000);
    }

    const isMaster =
      entity.type === 'player' && entity.username === companionOwner && botMode === 'COMPANION';
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
          bot.pvp.attack(entity);
          return;
        }
      }
    }

    // SELF DEFENSE / PROTECTION
    if (!botModules.pvp) return;
    if (entity !== bot.entity && !isMaster) return;

    const suspects = [];
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (e.id === bot.entity.id || (e.type === 'player' && e.username === companionOwner))
        continue;

      const isCombatant =
        e.type === 'mob' || e.type === 'hostile' || e.type === 'passive' || e.type === 'player';
      if (!isCombatant) continue;

      const dist = e.position.distanceTo(bot.entity.position);
      if (dist > 32) continue; // Increased detection range

      const dx = bot.entity.position.x - e.position.x;
      const dz = bot.entity.position.z - e.position.z;
      const angleTowardBot = Math.atan2(-dx, -dz);
      let diff = Math.abs(angleTowardBot - e.yaw) % (Math.PI * 2);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;

      // Relaxed conditions: If it's a mob nearby, or a player within 8 blocks
      if (e.type !== 'player' || dist < 8) {
        suspects.push({ entity: e, dist: dist, type: e.type });
      }
    }

    if (suspects.length > 0 && !bot.pvp.target) {
      const targets = suspects.sort((a, b) => {
        if (a.type !== 'player' && b.type === 'player') return -1;
        if (a.type === 'player' && b.type !== 'player') return 1;
        return a.dist - b.dist;
      });
      const target = targets[0].entity;
      const victimStr = entity === bot.entity ? 'me' : 'my master';
      log(
        'warn',
        `⚔️ RETALIATION MODE: Protecting ${victimStr}! Target: ${target.username || target.name}.`
      );

      // Stop anything we were doing!
      isBusy = false;
      if (bot.pathfinder) bot.pathfinder.setGoal(null);
      if (bot.collectBlock) {
        try {
          bot.collectBlock.stop();
        } catch (e) {}
      }

      // Equip GLADIATOR GEAR immediately!
      const items = bot.inventory.items();
      const sword = items.find(i => i.name.includes('sword') || i.name.includes('axe'));
      const shield = items.find(i => i.name === 'shield');
      if (sword) bot.equip(sword, 'hand').catch(() => {});
      if (shield) bot.equip(shield, 'off-hand').catch(() => {});

      log('warn', `🤺 COMBAT FRENZY: Engaging target!`);
      bot.pvp.attack(target);
    }
  });

  bot.on('death', () => {
    if (bot.pvp?.target) bot.pvp.stop();
  });
  bot.on('stoppedAttacking', () => {
    log('info', '🏳️ Target gone or defeated. Combat stopped.');
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    // Note: In-game commands (!follow, etc.) have been moved to the Web Control Panel
    log('info', `[CHAT] ${username}: ${message}`);
  });

  bot.on('playerLeft', player => {
    if (player.username === companionOwner) {
      log('info', `Master ${companionOwner} left the server. Returning to AUTONOMOUS mode.`);
      botMode = 'AUTONOMOUS';
      companionOwner = null;
      isBusy = false;
      bot.pathfinder.setGoal(null);
    }
  });

  bot.on('death', () => {
    setTimeout(() => {
      try {
        bot.respawn();
      } catch (e) {}
    }, 1500);
  });

  bot.on('kicked', reason => {
    isConnected = false;
    stopAntiAFK();
    log('warn', `⚠️ Bot was kicked: ${reason}`);
    scheduleReconnect();
  });

  bot.on('error', err => {
    log('error', `Bot error: ${err.message}`);
  });
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
app.use(express.json());
app.use(express.static('public'));

app.get('/api/status', (req, res) => {
  if (!bot || !isConnected) return res.json({ connected: false });
  const items = bot.inventory.items().map(i => ({ name: i.name, count: i.count }));
  res.json({
    connected: true,
    username: bot.username,
    hp: Math.round(bot.health),
    food: Math.round(bot.food),
    mode: botMode,
    pos: bot.entity?.position,
    inventory: items,
    owner: companionOwner,
    modules: botModules,
    environment: {
      biome: bot.blockAt(bot.entity.position)?.biome?.name || 'Unknown',
      dimension: bot.game?.dimension || 'overworld',
      time: bot.time?.timeOfDay || 0,
      isDay: bot.time?.timeOfDay < 13000,
    },
    entities: Object.values(bot.entities)
      .filter(
        e =>
          e.type === 'player' &&
          e.id !== bot.entity?.id &&
          e.position.distanceTo(bot.entity.position) < 32
      )
      .map(e => ({
        name: e.displayName || e.username || e.name,
        type: e.type,
        pos: {
          x: Math.round(e.position.x),
          y: Math.round(e.position.y),
          z: Math.round(e.position.z),
        },
        dist: Math.round(e.position.distanceTo(bot.entity.position)),
        isHostile: false,
      })),
    players: Object.keys(bot.players || {}),
    config: { host: CONFIG.MC_HOST, port: CONFIG.MC_PORT, username: CONFIG.MC_USERNAME },
  });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendUpdate = () => {
    if (!bot || !isConnected) {
      res.write(`data: ${JSON.stringify({ connected: false })}\n\n`);
      return;
    }
    const items = bot.inventory.items().map(i => ({ name: i.name, count: i.count }));
    const data = {
      connected: true,
      username: bot.username,
      hp: Math.round(bot.health),
      food: Math.round(bot.food),
      mode: botMode,
      isAttacked,
      pos: bot.entity?.position,
      inventory: items,
      environment: {
        biome: bot.blockAt(bot.entity.position)?.biome?.name || 'Unknown',
        dimension: bot.game?.dimension || 'overworld',
        time: bot.time?.timeOfDay || 0,
        isDay: bot.time?.timeOfDay < 13000,
      },
      entities: Object.values(bot.entities)
        .filter(
          e =>
            e.type === 'player' &&
            e.id !== bot.entity?.id &&
            e.position.distanceTo(bot.entity.position) < 32
        )
        .map(e => ({
          name: e.displayName || e.username || e.name,
          type: e.type,
          pos: {
            x: Math.round(e.position.x),
            y: Math.round(e.position.y),
            z: Math.round(e.position.z),
          },
          dist: Math.round(e.position.distanceTo(bot.entity.position)),
          isHostile: false,
        })),
      logs: recentLogs,
      modules: botModules,
      players: Object.keys(bot.players || {}),
      config: { host: CONFIG.MC_HOST, port: CONFIG.MC_PORT, username: CONFIG.MC_USERNAME },
    };
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const updateInterval = process.env.RENDER || process.env.PORT ? 2000 : 1000;
  const interval = setInterval(sendUpdate, updateInterval);
  req.on('close', () => clearInterval(interval));
});

app.post('/api/drop', (req, res) => {
  const { name } = req.body;
  if (!bot || !isConnected) return res.status(400).json({ error: 'Offline' });
  const item = bot.inventory.items().find(i => i.name === name);
  if (item) {
    bot.tossStack(item);
    log('info', `🗑️ Web Control: Dropped ${item.name} (${item.count})`);
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Item not found' });
});

app.post('/api/action', (req, res) => {
  const { action } = req.body;
  if (!bot || !isConnected) return res.status(400).json({ error: 'Offline' });

  if (action === 'eat') {
    if (bot.autoEat) {
      bot.autoEat.eat();
      log('info', '🍔 Web Control: Manual eat triggered.');
    } else {
      log('warn', '🍔 Web Control: Auto-eat plugin not ready.');
    }
  } else if (action === 'mine_cobble') {
    botMode = 'AUTONOMOUS'; // Auto logic will prioritize mining if table/pickaxe sorted
    log('info', '⛏️ Web Control: Prioritizing resource gathering.');
  } else if (action === 'reset') {
    botMode = 'IDLE';
    isBusy = false;
    isAttacked = false;
    if (bot.pathfinder) bot.pathfinder.setGoal(null);
    if (bot.collectBlock)
      try {
        bot.collectBlock.stop();
      } catch (e) {}
    if (bot.pvp) bot.pvp.stop();
    log('warn', '🛑 Web Control: Reset all bot behaviors and set mode to IDLE.');
  }
  res.json({ success: true });
});

app.post('/api/config', (req, res) => {
  const { host, port, username, owner, version, auth } = req.body;
  if (host) CONFIG.MC_HOST = host;
  if (port) CONFIG.MC_PORT = parseInt(port);
  if (username) CONFIG.MC_USERNAME = username;
  if (owner) CONFIG.MC_OWNER = owner;
  if (version) CONFIG.MC_VERSION = version;
  if (auth) CONFIG.MC_AUTH = auth;

  log('info', `🌐 Web Control: Configuration updated. Reconnecting...`);
  scheduleReconnect(100); // Immediate reconnect with new config
  res.json({ success: true, config: CONFIG });
});

app.post('/api/mode', (req, res) => {
  const { mode, owner } = req.body;
  if (['AUTONOMOUS', 'IDLE', 'COMPANION', 'FOLLOW', 'KILL'].includes(mode)) {
    botMode = mode;
    const targetOwner = owner || CONFIG.MC_OWNER;
    if (targetOwner) companionOwner = targetOwner;

    // Reset temporary states before logic starts for new mode
    isBusy = false;
    isAttacked = false;
    if (bot.pathfinder) bot.pathfinder.setGoal(null);
    if (bot.collectBlock)
      try {
        bot.collectBlock.stop();
      } catch (e) {}
    if (bot.pvp) bot.pvp.stop();

    if (bot.pathfinder) {
      if ((mode === 'FOLLOW' || mode === 'COMPANION') && targetOwner) {
        const player = bot.players[targetOwner]?.entity;
        if (player) {
          const movements = new Movements(bot);
          movements.canOpenDoors = true;
          bot.pathfinder.setMovements(movements);
          bot.pathfinder.setGoal(new GoalFollow(player, 2));
        }
      }
    }

    log('info', `🌐 Web Control: Mode changed to ${mode} (Owner: ${companionOwner || 'None'})`);
    return res.json({ success: true, mode });
  }
  res.status(400).json({ error: 'Invalid mode' });
});

app.post('/api/modules', (req, res) => {
  const { modules } = req.body;
  if (modules) {
    botModules = { ...botModules, ...modules };
    // Apply immediate changes to plugins if necessary
    if (bot && bot.autoEat) {
      if (botModules.eat) bot.autoEat.enableAuto();
      else bot.autoEat.disableAuto();
    }
    log('info', `🌐 Web Control: Survival Modules updated: ${JSON.stringify(botModules)}`);
    return res.json({ success: true, modules: botModules });
  }
  res.status(400).json({ error: 'Invalid module config' });
});

app.post('/api/chat', (req, res) => {
  const { message } = req.body;
  if (bot && isConnected && message) {
    bot.chat(message);
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'Bot not ready' });
});

app.post('/api/reconnect', (req, res) => {
  scheduleReconnect();
  res.json({ success: true });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(CONFIG.PORT, () => {
  log('success', `🌐 HTTP server listening on port ${CONFIG.PORT}`);
  startSelfPinger();
  if (CONFIG.MC_HOST) createBot();
  else log('warn', '📌 No MC_HOST set. Bot is waiting for configuration via web...');
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

process.on('uncaughtException', err => {
  log('error', `Uncaught exception: ${err.message}`);
});
process.on('unhandledRejection', reason => {
  log('error', `Unhandled rejection: ${reason}`);
});
