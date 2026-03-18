# 🤖 Minecraft Java Advanced Bot (Pro Edition)

A high-performance Node.js bot built with **Mineflayer**. More than just a keep-alive bot, this is a fully autonomous survival companion capable of defending you, gathering resources, and following instructions.

---

## ✨ Features (v2.0)

| Category | Feature | Description |
|---|---|---|
| 🛡️ **Defensive** | **Resbak Mode** | Automatically counter-attacks anyone who hurts the bot or its "Master". |
| 🪓 **Survival** | **Auto-Gather** | Intelligently mines logs and stone to upgrade its gear. |
| 🛠️ **Utility** | **Auto-Craft** | Crafts its own planks, sticks, pickaxes, swords, and furnaces. |
| 👕 **Combat** | **Auto-Equip** | Dynamically equips the best armor and swords in its inventory. |
| 🍖 **Health** | **Auto-Eat** | Manages hunger automatically using food from its inventory. |
| 🏃 **Movement** | **Pathfinding** | Uses A* pathfinding to follow players or navigate complex terrain. |
| 🤸 **Anti-AFK** | **Dynamic AI** | Randomly jumps, sneaks, explores, and interacts to stay active. |
| 🏓 **Uptime** | **Self-Pinger** | Integrated health-check system to stay alive 24/7 on services like Render. |

---

## 🎮 Bot Modes

The bot operates in three distinct states:

1.  **AUTONOMOUS (Default)**: The bot explores its surroundings, gathers wood and stone, and crafts basic tools to survive.
2.  **FOLLOW**: The bot focuses entirely on following a specific player.
3.  **COMPANION**: The ultimate bodyguard mode. The bot follows its "Master" and will attack any player or mob that dares to strike the Master or the bot.

---

## 🗣️ Chat Commands

Interact with the bot directly in-game!

| Command | Action |
|---|---|
| `!follow` | Bot starts following you everywhere. |
| `!companion` | Sets you as "Master". Bot protects you and follows you. |
| `!stop` | Returns to **Autonomous** mode (starts gathering resources). |
| `!inventory` | Lists all items current held by the bot. |

---

## 🚀 Quick Start

### 1. Requirements
*   Node.js v18 or later
*   A Minecraft Java Server (Cracked or Premium)

### 2. Setup
```bash
# Clone the repository
git clone <your-repo-url>
cd minecraft-bot

# Install dependencies
npm install

# Create environment file
cp .env.example .env
```

### 3. Configuration
Edit your `.env` file with your server details:
```ini
MC_HOST="your.server.ip"
MC_PORT=25565
MC_USERNAME="GuardBot"
MC_VERSION="1.20.1"
MC_AUTH="offline" # Use 'microsoft' for premium accounts
```

### 4. Run it
```bash
npm start
```

---

## 🌐 Deployment (Render.com)

1.  Push this code to your **GitHub repository**.
2.  Go to [Render.com](https://render.com) and create a new **Web Service**.
3.  Connect your repository.
4.  Settings:
    *   **Build Command**: `npm install`
    *   **Start Command**: `npm start`
    *   **Environment Variables**: Copy all variables from your `.env` to Render's Environment section.
5.  **Important**: Set `RENDER_URL` to your app's URL (e.g., `https://my-bot.onrender.com`) to activate the 24/7 self-pinger.

---

## 📡 API Status Endpoints

*   `GET /`: Returns real-time bot connection status and stats.
*   `GET /health`: Used by the self-pinger to keep the instance active.

---

## 🛡️ License
Distributed under the **MIT License**. See `LICENSE` for more information.
