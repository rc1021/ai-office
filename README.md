# AI Office

A multi-agent virtual office powered by Claude Code. "Hire" AI agents with specialized roles that collaborate via Discord to accomplish complex tasks under human supervision.

**77 role templates** across 22 industries. **34 MCP tools**. **77 automated tests**. End-to-end verified.

## Quick Start

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/rc1021/ai-office/main/setup.sh)
```

The setup script will:
1. Download AI Office (tarball, no git required)
2. Check prerequisites (Node.js, npm, curl, Claude Code, ngrok)
3. Install dependencies and build all packages (`core` → `discord-bot` → others)
4. Run the configuration wizard (office name, Discord bot, ngrok mode, starter pack)
5. Stop old processes (if any — prevents duplicate daemons)
6. Start the **Discord Listener daemon** in the background

After setup, the bot is online in Discord. Send a message in `#general` — the Leader responds automatically. No need to open Claude Code.

### Updating

```bash
./update.sh
```

Downloads latest source, rebuilds, and **restarts the listener**. Your configuration is preserved (`config/office.yaml`, `discord-bot/.env`, `pixel-office/.env`, `.mcp.json`).

### Uninstalling

```bash
./uninstall.sh
```

Stops all processes (listener + Pixel Office), removes state/build/node_modules. Your `.env` config files are preserved for easy reinstall.

## Prerequisites

- **Node.js** >= 22
- **curl** (for downloading)
- **Claude Code** (Max subscription recommended for parallel workers)
- **Discord Bot** — [create one here](https://discord.com/developers/applications)
  - Enable **MESSAGE CONTENT** intent
  - Invite the bot to your server with admin permissions
- **ngrok** (optional) — for remote Pixel Office access. [Install](https://ngrok.com/download)

## Architecture

```
User ──→ Discord #general
              ↓
         Listener Daemon (always online)
              ↓
         claude -p (per message)
              ↓
         Leader (Opus) ──→ Workers (Sonnet) via Agent tool
              ↓                    ↓
         @ai-office/core ←────────┘
         (ChatAdapter → Discord / Slack / ...)
              ↓
         Coordination MCP (SQLite)
              ↓
         Pixel Office UI (ngrok)
```

| Module | Purpose | Tools |
|--------|---------|-------|
| `core/` | **Platform-agnostic core** — claude runner, event bridge, heartbeat, config, auth | — |
| `discord-bot/` | Discord adapter + MCP Server + **Listener Daemon** | 16 tools |
| `coordination/` | Shared state, tasks, events, audit | 18 tools |
| `orchestrator/` | Agent lifecycle CLI | 6 commands |
| `pixel-office/` | Real-time visualization (Phaser.js + ngrok) | — |
| `setup/` | Configuration wizard (i18n) | — |
| `roles/` | 77 role templates (YAML) | — |

### Platform Separation

The `core/` package contains all platform-agnostic logic (ChatAdapter interface, event bridge, heartbeat, claude runner, output gate, throttle). `discord-bot/` implements `DiscordChatAdapter` for Discord. A future `slack-bot/` can implement `SlackChatAdapter` and reuse the same core.

## Starter Packs

| Pack | Roles | Use Case |
|------|-------|----------|
| Solo Creator | Leader only | Exploring AI Office |
| Dev Team | PM + Software Engineer | Building software |
| Startup MVP | PM + Engineer + Research Analyst | Rapid prototyping |
| Research Lab | Research Analyst | Deep research |
| Full Dev Team | PM + Engineer + QA + DevOps + Designer | Complete dev team |
| Marketing Team | Marketing Manager + Content + Community | Marketing ops |
| Finance Office | Accountant + Financial Analyst | Bookkeeping & forecasting |
| E-Commerce Shop | Product Manager + Marketing + Content + CS | E-commerce ops |
| Legal Firm | Legal Advisor + Admin Assistant | Legal operations |

## Role Templates

77 roles across 4 categories:

- **1 Default** — Leader (always present)
- **20 General** — PM, Engineer, Analyst, Designer, QA, DevOps, etc.
- **51 Industry** — Tech, Finance, E-Commerce, Healthcare, Legal, Education, Media, Gaming, Crypto, Government, and more
- **5 Emerging** — AI Prompt Engineer, ESG Analyst, Crisis PR, Accessibility Consultant, Personal Brand

See [docs/role-catalog.md](docs/role-catalog.md) for the complete catalog.

## Worker Delegation

Leader can spawn workers via the **Agent tool** directly from Discord:

```
User: "研究蝦皮 API 的聊天功能"
  → Leader spawns research-analyst (Sonnet) via Agent tool
  → Worker executes, reports back via coordination MCP
  → Leader reviews output, posts results to #general
```

- Workers use **Sonnet 4.6** (cost-efficient), Leader uses **Opus 4.6**
- Parallel spawning supported (e.g., 3 workers for brainstorming)
- Context preserved across messages via `task_checkpoint` / `task_resume`

## Event Bridge + Heartbeat

The listener daemon runs background subsystems:

- **Event Bridge** (`core/`) — Polls coordination DB every 3s, routes events to chat channels via ChatAdapter:
  - `task.created/completed/failed` → `#task-board`
  - `anomaly.reported` → `#alerts`
  - `agent.online/offline` → `#bot-status` + `#config`
  - `audit_log` entries → `#audit-log`
- **Heartbeat** (`core/`) — Periodic health monitoring via ChatAdapter:
  - Every 1 min: check Pixel Office + DB health, auto-restart if needed, cleanup stale tasks
  - Every 30 min: system status embed to `#bot-status`
  - Daily at 08:30 (user timezone): generate daily brief to `#daily-brief`

## Discord Listener Daemon

The listener is the core runtime — a standalone process that keeps the bot online:

```
User sends message in #general
  → Listener queues it (one at a time), adds ⏳ reaction
  → Spawns claude -p with the message
  → Leader processes, delegates to workers if needed
  → Leader responds via MCP send_message, ⏳ → ✅
  → Next queued message starts processing
```

Management commands (printed after setup):
- **View logs**: `tail -f discord-bot/listener.log`
- **Stop**: `kill <PID>` (PID shown in setup output)
- **Restart**: `node discord-bot/dist/listener.js`

## Pixel Office UI

Pixel Office starts automatically with the listener. Or run manually:

```bash
cd pixel-office && npx tsx server/index.ts
```

Open via ngrok public URL (shown in Discord `#bot-status`), or `http://localhost:3847` locally.

Features:
- **Agent sprites** with spawn portal VFX, idle bobbing, busy typing indicator
- **Heartbeat health ring** — color-coded pulse around each agent (green/yellow/orange/red by freshness)
- **Task progress ring** — arc showing step completion % on busy agents
- **Task assignment lines** — dashed lines from Leader to workers for active tasks
- **Agent panel** — click any agent to see details, active tasks, stats (or press `Escape` to close)
- **Task Board** — toggle with `T` key, shows in-progress/pending/completed tasks with progress bars
- **Message Feed** — toggle with `M` key, streams events with Discord channel badges per event
- **Brainstorm Panel** — toggle with `B` key, shows brainstorming sessions grouped by round
- **Speech bubbles** — agents show status change messages ("Working...", "Done!", "Online")

## Remote Access

Four modes available during setup:

| Mode | Description |
|------|-------------|
| **Internal ngrok** | AI Office auto-starts ngrok tunnel with Basic Auth |
| **External ngrok** | You manage ngrok yourself; AI Office auto-detects the tunnel URL |
| **Custom URL** | Your own domain / Cloudflare Tunnel / reverse proxy |
| **Disabled** | Localhost only (`http://localhost:3847`) |

Leader auto-publishes the public URL to Discord `#bot-status` on startup.

## Brainstorming Mode

The Leader can spawn multiple workers to analyze a topic from different perspectives simultaneously:

1. User asks for brainstorming → Leader creates a shared trace
2. Leader spawns 2-4 workers, each with a different perspective (e.g., growth, risk, technical, UX)
3. Workers publish analyses via coordination events, can read and respond to each other
4. Leader synthesizes all perspectives and presents a structured summary

See the Brainstorming Protocol in [agents/leader/CLAUDE.md](agents/leader/CLAUDE.md).

## Hooks

Claude Code hooks automate responses to agent events:

| Hook | Trigger | Action |
|------|---------|--------|
| `on-task-update.sh` | Task completed/failed | Log to `.ai-office/logs/hooks.log` |
| `on-status-change.sh` | Agent online/offline/busy | Log to `.ai-office/logs/hooks.log` |

Hooks are configured in `.claude/settings.json` and can be extended with custom scripts (e.g., Discord webhook notifications, Slack alerts).

## Security

- **OutputGate** — 4-layer check: denied scopes → write scopes → clearance → data classification
- **Identity Tokens** — HMAC-SHA256 signed, session-scoped, auto-expiry
- **Token Middleware** — Coordination MCP enforces agent identity on every tool call
- **Audit Trail** — Hash-chained, tamper-evident log of all actions
- **RBAC** — 4 clearance levels (PUBLIC → RESTRICTED), fine-grained scope patterns

See [docs/security-model.md](docs/security-model.md) for details.

## Testing

```bash
cd coordination && npm test    # 45 tests
cd discord-bot && npm test     # 26 tests
cd orchestrator && npm test    # 6 tests
```

## Docker

```bash
docker compose up pixel-office    # Pixel Office UI
docker compose run setup          # Configuration wizard
```

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](docs/getting-started.md) | Installation, setup, first run |
| [Architecture](docs/architecture.md) | System design, data flow, agent lifecycle |
| [Role Template Schema](docs/role-template-schema.md) | Role YAML structure, behavior system, security model |
| [Role Catalog](docs/role-catalog.md) | All 77 role templates |
| [Security Model](docs/security-model.md) | Authentication, authorization, audit |
| [API Reference](docs/api-reference.md) | 34 MCP tools + CLI commands |

## Configuration

| File | Purpose |
|------|---------|
| `config/office.yaml` | Office name, language, agent limits |
| `config/channels.yaml` | Discord channel layout + throttle rules |
| `config/starter-packs.yaml` | Pre-configured role combinations |
| `config/active-roles.yaml` | Currently active roles (written by wizard) |
| `.mcp.json` | MCP server config for Claude Code |

## License

[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) — free for personal and non-commercial use. Commercial use requires separate licensing.
