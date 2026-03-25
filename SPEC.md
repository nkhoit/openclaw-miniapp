# OpenClaw Dashboard — Telegram Mini App

## Overview

A lightweight Telegram Mini App that gives you a visual dashboard for your [OpenClaw](https://github.com/openclaw/openclaw) agent. Tap the menu button in your bot's chat to see system status, agent health, recent activity, and workspace context at a glance.

Zero dependencies. No build step. One file for the frontend, one for the server.

## Architecture

```
┌──────────────┐     HTTPS      ┌──────────────────────┐                  ┌──────────────┐
│  Telegram    │ ──────────────→│  Reverse proxy       │ ───────────────→ │  Your host   │
│  Mini App    │                │  (Tailscale Funnel,  │                   │  Node server │
│  (in-app     │  initData      │   Cloudflare Tunnel, │                   │  port 3001   │
│   browser)   │  signed by TG  │   or nginx + cert)   │                   └──────┬───────┘
└──────────────┘                └──────────────────────┘                          │
                                                                                  ├── openclaw status
                                                                                  ├── workspace files
                                                                                  ├── system stats (os)
                                                                                  └── session data
```

## Requirements

- Node.js 18+
- OpenClaw installed and running
- HTTPS endpoint reachable from the internet (Telegram requires HTTPS for Mini Apps)
- A Telegram bot token (@BotFather)

## Tech Stack

| Layer      | Choice              | Rationale                                      |
|------------|---------------------|-------------------------------------------------|
| Frontend   | Single `index.html` | No build step, inline CSS/JS, fast mobile load  |
| Backend    | Node.js, zero deps  | `http` module + `child_process`, nothing to install |
| Auth       | Telegram initData HMAC | Cryptographic proof of origin, no passwords  |
| Hosting    | Your machine        | Data lives locally, no cloud needed             |

## Security

Three layers, defense in depth:

1. **Telegram `initData` HMAC-SHA256** — every request includes a signed payload from Telegram. Server validates using your bot token. Invalid signature → 401
2. **User ID allowlist** — extracted from validated initData; only configured Telegram user IDs are accepted. Others → 403
3. **Read-only API** — no write endpoints, no mutations

### initData Validation

```
1. Mini App sends header: X-Telegram-Init-Data: <raw initData string>
2. Server parses key-value pairs from initData
3. Builds data_check_string (alphabetically sorted pairs, excluding "hash")
4. Computes HMAC-SHA256(secret_key, data_check_string)
   where secret_key = HMAC-SHA256("WebAppData", bot_token)
5. Compares computed hash with provided hash
6. Checks auth_date is within 5 minutes (replay protection)
7. Checks user.id is in ALLOWED_USER_IDS
```

## Dashboard Widgets

### 🤖 Agent Status
- Online/offline indicator (gateway health)
- Current model
- OpenClaw version
- Gateway uptime
- Active session count

**Data source**: `openclaw status --json`

### 🖥 System
- CPU usage (%)
- Memory used / total
- Disk used / total
- OS + hostname

**Data source**: Node.js `os` module + `df -h`

### 📝 Current Context
- Contents of `NOW.md` (the agent's active context file)
- Rendered as lightweight markdown (bold, bullets, headers)

**Data source**: `<WORKSPACE>/NOW.md`

### 💬 Recent Activity
- Last 10 messages (timestamp + preview, truncated to ~80 chars)
- Shows both user and assistant messages
- Most recent first

**Data source**: `openclaw sessions --active 1440 --json` or direct session file read

### 📊 Usage (optional)
- Token usage for current session
- Model distribution
- Cost estimate if available

**Data source**: Session metadata

## API Endpoints

All endpoints require valid Telegram `initData` in `X-Telegram-Init-Data` header.

```
GET  /api/status    → { gateway: {...}, system: {...} }
GET  /api/context   → { now_md: "..." }
GET  /api/activity  → { messages: [{timestamp, role, preview}...] }
GET  /api/usage     → { tokens: {...}, sessions: {...} }
GET  /api/dashboard → all of the above in one call (for initial load)
```

## Frontend Design

### Layout
- **Header**: Agent name + status dot (green/red) + user avatar
- **Cards**: Stacked vertically (Mini Apps are always portrait)
  - Agent Status (compact, always visible)
  - System (CPU/RAM/Disk progress bars)
  - Current Context (scrollable card)
  - Recent Activity (scrollable list)
- **Theme**: Inherits Telegram's dark/light mode automatically via `window.Telegram.WebApp.themeParams`

### Styling
- Uses Telegram's CSS variables (`var(--tg-theme-bg-color)`, `var(--tg-theme-text-color)`, etc.)
- System font stack — no web fonts
- Subtle card borders with `var(--tg-theme-hint-color)`
- No animations — instant render, fast on mobile

### Refresh
- Auto-refresh every 30 seconds (silent)
- Visual staleness indicator if data is >60s old

## File Structure

```
openclaw-telegram-dashboard/
├── server.js              # Node HTTP server (~150 lines)
├── public/
│   └── index.html         # Single-file frontend (HTML + CSS + JS)
├── lib/
│   └── telegram-auth.js   # initData HMAC validation
├── .env.example           # Template for environment variables
└── README.md              # Setup guide
```

## Setup

### 1. Clone and configure

```bash
git clone https://github.com/youruser/openclaw-telegram-dashboard.git
cd openclaw-telegram-dashboard
cp .env.example .env
# Edit .env with your values
```

### 2. Environment variables

```env
BOT_TOKEN=123456:ABC-DEF          # Your Telegram bot token (from @BotFather)
WORKSPACE=/path/to/workspace      # OpenClaw workspace path (e.g., ~/.openclaw/workspace-main)
ALLOWED_USER_IDS=123456789        # Comma-separated Telegram user IDs
PORT=3001                         # Local server port (default: 3001)
```

### 3. Start the server

```bash
node server.js
```

Or run as a systemd service / launchd agent for persistence.

### 4. Expose via HTTPS

Telegram Mini Apps require HTTPS. Choose one:

**Tailscale Funnel** (simplest if you use Tailscale):
```bash
tailscale funnel /dashboard/ 3001
# URL: https://your-machine.your-tailnet.ts.net/dashboard/
```

**Cloudflare Tunnel** (if you want a custom domain):
```bash
cloudflared tunnel route dns your-tunnel dashboard.yourdomain.com
# URL: https://dashboard.yourdomain.com
```

**nginx + Let's Encrypt** (if you have a public IP):
```nginx
location /dashboard/ {
    proxy_pass http://127.0.0.1:3001/;
}
```

### 5. Register with BotFather

1. Open @BotFather in Telegram
2. `/setmenubutton`
3. Select your bot
4. Set the URL to your HTTPS endpoint
5. Open the bot chat → tap the menu button → dashboard opens

## Customization

### Adding widgets

The dashboard is a single HTML file. Add a new card by:
1. Adding an API endpoint in `server.js` that returns your data
2. Adding a `<div class="card">` section in `index.html`
3. Adding a fetch call in the `<script>` block

### Widget ideas
- **Home Assistant** — device states, quick toggles
- **CI/CD status** — latest build result from GitHub Actions
- **Calendar** — today's events
- **Task list** — parse a TASKS.md or TODO file from your workspace
- **Camera feeds** — snapshots from Frigate or other NVR

## Non-Goals

- No persistent database — all data is live reads from the host
- No multi-user auth system — Telegram initData handles identity
- No React, no build step, no npm dependencies
- No write operations in v1
- No WebSocket — polling is fine for a dashboard
