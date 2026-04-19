# AI Office

A multi-agent virtual office powered by Claude Code. "Hire" AI agents with specialized roles that collaborate via Discord to accomplish complex tasks under human supervision.

**77 role templates** across 22 industries. **37 MCP tools**. **73 automated tests**. End-to-end verified.

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

The `office` CLI is now available for all management tasks:

```bash
office help
```

> **Note:** `./bin/office` must be in your PATH, or call it as `./bin/office <command>` from the project root.

### CLI Commands

| Command | Description |
|---------|-------------|
| `office setup` | Initialize environment (installs deps, runs wizard, starts listener) |
| `office start` | Start the Discord Listener daemon |
| `office stop` | Stop all running processes |
| `office restart` | Stop + start |
| `office update` | Download latest version and rebuild |
| `office status` | Show current status of each component |
| `office logs` | Tail Discord Listener logs (`-f`) |
| `office wizard` | Re-run the configuration wizard |
| `office install-service` | Install auto-start service (launchd / systemd) |
| `office uninstall-service` | Remove auto-start service |
| `office help` | Show help |

### Updating

```bash
office update
```

Downloads latest source, rebuilds, and **restarts the listener**. Your configuration is preserved (`config/office.yaml`, `discord-bot/.env`, `pixel-office/.env`, `.mcp.json`).

### Uninstalling

To stop all processes:

```bash
office stop
```

This stops the listener and Pixel Office daemons. To also remove state/build/node_modules, delete those directories manually. Your `.env` config files are preserved for easy reinstall.

## Prerequisites

- **Node.js** >= 22
- **curl** (for downloading)
- **Claude Code** (Max subscription recommended for parallel workers)
- **Discord Bot** — [create one here](https://discord.com/developers/applications)
  - Enable **MESSAGE CONTENT** intent
  - Invite the bot to your server with admin permissions
- **Build tools** (for local Whisper STT compilation)
  - macOS: `xcode-select --install`
  - Ubuntu/Debian: `sudo apt-get install -y build-essential`
- **ffmpeg** (for Discord voice message transcription)
  - macOS: `brew install ffmpeg`
  - Ubuntu/Debian: `sudo apt-get install -y ffmpeg`
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
| `core/` | **Platform-agnostic core** — claude runner, heartbeat, config, auth | — |
| `discord-bot/` | Discord adapter + MCP Server + **Listener Daemon** | 20 tools |
| `coordination/` | Shared state, tasks, jobs, events, audit | 23 tools |
| `orchestrator/` | Agent lifecycle CLI | 6 commands |
| `pixel-office/` | Real-time visualization (Phaser.js + ngrok) | — |
| `setup/` | Configuration wizard (i18n) | — |
| `roles/` | 77 role templates (YAML) | — |

### Platform Separation

The `core/` package contains all platform-agnostic logic (ChatAdapter interface, heartbeat, claude runner, output gate, throttle). `discord-bot/` implements `DiscordChatAdapter` for Discord. A future `slack-bot/` can implement `SlackChatAdapter` and reuse the same core.

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

## Heartbeat

The listener daemon runs a background heartbeat subsystem (`core/`):

- Every 1 min: check Pixel Office + DB health, auto-restart if needed, cleanup stale tasks, auto-audit completed tasks, fire due scheduled jobs
- Health alerts (anomalies, errors) → `#alerts`
- Daily at 08:00 (configurable in `office.yaml`) → `#daily-brief`

System events (task state changes, agent status, audit logs) are stored in the coordination DB and visible in the Pixel Office UI — they are not pushed to Discord channels.

## Job Scheduling

Recurring tasks can be scheduled to fire automatically without any user interaction. The heartbeat checks for due jobs every minute and delivers a `job.fired` event to the Leader's inbox.

Three schedule types:

```
interval  — every N minutes  (e.g. health poll every 30 min)
daily     — once per day at a fixed UTC hour  (e.g. daily standup at 09:00 Taipei → hour:1)
weekly    — once per week on a weekday + UTC hour  (weekday: 1 = Monday)
```

**Create a job by telling the Leader in Discord:**

```
「每天早上九點幫我產生今日工作摘要」
→ Leader calls job_create:
    schedule_type: daily
    schedule_config: { hour: 1, minute: 0 }   ← UTC (09:00 Taipei = 01:00 UTC)
    task_template: { title: "Daily standup", assigned_to: "pm-1" }
```

Once created, the job fires at the scheduled time — no further input needed. The Leader routes each `job.fired` event to the assigned worker (or handles it directly).

**Manage jobs via Discord:**

```
「查看所有排程工作」       → job_list
「暫停每日簡報工作」       → job_update (enabled: false)
「改成每 30 分鐘檢查一次」 → job_update (schedule_config: {minutes: 30})
「刪除健康檢查工作」       → job_delete
```

All job operations are recorded in the audit trail.

**Default jobs** (seeded from `config/jobs.yaml` on every startup, idempotent):

```
Memo channel daily indexing — daily at 22:00 UTC
  Reads new messages from #memo since last cursor, classifies by topic,
  creates/updates Forum posts in #notes-index with AI insights.
```

## Memo Auto-Indexing

`#memo` is a free-form text channel for quick notes. The daily indexing job automatically organizes it into a structured **Forum channel** (`#notes-index`):

```
User writes anything in #memo
  → Daily job fires at 22:00 UTC
  → Leader reads new messages since last cursor
  → Classifies each message by topic
  → Creates/updates Forum posts in #notes-index with AI insights
  → Adds ✅ reaction to #memo messages when user confirms completion
```

**Forum post tags:** 設計 / 待辦 / 想法 / bug / 待問 / 已完成

**Completion workflow:**
```
Tell Leader "XXX is done"  →  Leader tags Forum post + adds ✅ to #memo message
Press "Mark as Answered" in #notes-index Forum post  (do it yourself)
```

**Sunday aging review:** #memo messages older than 60 days with no reaction trigger a summary in `#general` with AI suggestions based on recent git log and completed tasks.

## Role Behavior System

Each role has a behavior type (`pioneering` / `steady` / `execution` / `coordination`) and specific rules injected into the worker's CLAUDE.md at spawn time. 4 rules are **never overridable** (security-critical).

**Internal Auditor**: When `audit.auto_review: true` in `office.yaml` and the `internal-auditor` role is hired, the heartbeat auto-reviews completed tasks — checking numerical correctness, source citations, completeness, and security. Results stored as `audit_status` (passed/failed/skipped).

See [docs/role-template-schema.md](docs/role-template-schema.md) for the full behavior system.

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

Management commands:
- **View logs**: `office logs`
- **Stop**: `office stop`
- **Start / Restart**: `office start` / `office restart`

## Voice Input

AI Office supports two voice input modes, both transcribed locally via **whisper.cpp** (no cloud API):

**Voice Messages** (Discord mic icon → send as file)
```
User records voice message in Discord
  → Listener downloads OGG → converts to WAV via ffmpeg
  → Whisper transcribes → enters Leader pipeline
```

**Voice Channel** (real-time)
```
User joins a voice channel
  → Bot auto-joins the same channel
  → Listens per-user (1.5s silence trigger)
  → Opus → PCM → WAV → Whisper transcribes
  → Transcribed text enters Leader pipeline
  → Bot leaves when channel is empty
```

- **Model**: `medium` (~1.5 GB, high accuracy, auto-downloaded on `npm install`)
- **Language**: read from `config/office.yaml` → `office.language` (e.g. `zh-TW` → `zh`, `en` → `en`)
- Transcription takes ~10–20 seconds with the medium model

## Pixel Office UI

Pixel Office starts automatically with the listener. Or run manually:

```bash
cd pixel-office && npx tsx server/index.ts
```

Open via ngrok public URL (shown in Discord `#general` on startup), or `http://localhost:3847` locally.

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

Leader auto-publishes the public URL to Discord `#general` on startup.

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
cd coordination && npm test    # 46 tests
cd discord-bot && npm test     # 21 tests
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
| `config/jobs.yaml` | Default recurring jobs (seeded on startup) |
| `config/starter-packs.yaml` | Pre-configured role combinations |
| `config/active-roles.yaml` | Currently active roles (written by wizard) |
| `.mcp.json` | MCP server config for Claude Code |

## Contributing

We welcome contributions! AI Office is open to forks and pull requests.

- All PRs must target the `develop` branch — not `main`
- Read [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide
- Report security issues privately via [GitHub Security Advisories](https://github.com/rc1021/ai-office/security/advisories/new) — see [SECURITY.md](.github/SECURITY.md)

Quick start for contributors:

```bash
git clone https://github.com/<your-username>/ai-office.git
git remote add upstream https://github.com/rc1021/ai-office.git
git checkout -b feat/my-feature upstream/develop
```

## License

[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) — free for personal and non-commercial use. Commercial use requires separate licensing.
