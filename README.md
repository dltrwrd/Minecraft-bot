# 🤖 Minecraft Java Keep-Alive Bot

A Node.js bot built with **mineflayer** that keeps your Minecraft Java server alive by staying connected 24/7. Deployable on **Render** with a built-in self-pinger so the instance never spins down.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🔌 **Auto-reconnect** | Reconnects on kick, crash, or timeout with exponential backoff |
| 🤸 **Anti-AFK** | Randomly jumps, walks, sneaks, and looks around every 30s |
| 💀 **Auto-respawn** | Automatically respawns 1.5s after death |
| 📋 **Chat logger** | Logs all chat to console + `chat.log` file |
| 🏓 **Self-pinger** | Pings its own `/health` endpoint to prevent Render spin-down |
| 🌐 **Status endpoint** | `GET /` returns bot connection status as JSON |

---

## 🚀 Deploy to Render (Free Tier)

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### Step 2 — Create Render Web Service
1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub repo
3. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free

### Step 3 — Set Environment Variables
In your Render dashboard → **Environment**, add these:

| Variable | Value |
|---|---|
| `MC_HOST` | Your Minecraft server IP or domain |
| `MC_PORT` | `25565` (or your custom port) |
| `MC_USERNAME` | `KeepAliveBot` (any name you want) |
| `MC_VERSION` | `1.20.1` (match your server version) |
| `MC_AUTH` | `offline` for cracked / `microsoft` for premium |
| `RENDER_URL` | `https://your-app-name.onrender.com` |
| `PING_INTERVAL_MS` | `300000` (5 minutes) |

> ⚠️ **Important:** Set `RENDER_URL` to your actual Render app URL after first deploy, then redeploy. This activates the self-pinger.

---

## 💻 Run Locally

```bash
# 1. Clone / download the project
# 2. Install dependencies
npm install

# 3. Set environment variables
cp .env.example .env
# Edit .env with your values

# 4. Run
npm start
```

---

## 📡 API Endpoints

### `GET /`
Returns current bot status:
```json
{
  "status": "running",
  "bot": {
    "connected": true,
    "username": "KeepAliveBot",
    "server": "your-server:25565",
    "uptime_seconds": 3600,
    "reconnect_attempts": 0
  },
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

### `GET /health`
Returns `200 OK` — used by the self-pinger.

---

## ⚙️ Configuration

All config is done via environment variables (see `.env.example`).

| Variable | Default | Description |
|---|---|---|
| `MC_HOST` | `your-server-ip` | Minecraft server host |
| `MC_PORT` | `25565` | Minecraft server port |
| `MC_USERNAME` | `KeepAliveBot` | Bot's username |
| `MC_VERSION` | `1.20.1` | Server version |
| `MC_AUTH` | `offline` | `offline` or `microsoft` |
| `RENDER_URL` | *(empty)* | Your Render app URL |
| `PING_INTERVAL_MS` | `300000` | Self-ping interval (ms) |
| `RECONNECT_DELAY_MS` | `5000` | Base reconnect delay (ms) |
| `AFK_INTERVAL_MS` | `30000` | Anti-AFK interval (ms) |
| `PORT` | `3000` | HTTP server port |

---

## 📋 Chat Log

All chat messages are saved to `chat.log` in the project root:
```
[2025-01-01T00:00:00.000Z] <Player123> hello
[2025-01-01T00:00:01.000Z] [SERVER] Player123 joined the game
```

---

## 🔧 Troubleshooting

**Bot keeps getting kicked immediately?**
- Check if your server has anti-bot plugins (e.g. AuthMe, BotSentry)
- Try changing `MC_USERNAME` to something less obvious
- Make sure `MC_VERSION` matches your server version exactly

**`microsoft` auth not working?**
- Microsoft auth requires running locally first to complete the OAuth flow
- For Render deployment, use `offline` auth (cracked servers only)

**Self-pinger not working?**
- Make sure `RENDER_URL` is set correctly (no trailing slash)
- It should be your full Render URL: `https://your-app.onrender.com`
