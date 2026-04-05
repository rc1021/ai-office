# AI Office

A multi-agent virtual office powered by Claude Code. "Hire" AI agents with specialized roles that collaborate via Discord to accomplish complex tasks under human supervision.

**71 role templates** across 22 industries. **34 MCP tools**. **77 automated tests**. End-to-end verified.

## Quick Start

```bash
git clone https://github.com/rc1021/ai-office.git
cd ai-office
./setup.sh
```

That's it. The setup script will:
1. Check prerequisites (Node.js, npm, ngrok)
2. Install all dependencies
3. Build TypeScript
4. Run the configuration wizard (office name, Discord bot, ngrok, starter pack)
5. Start Pixel Office in the background
6. Launch the Leader agent — who greets you in Discord `#general`

The Leader introduces the team, explains what the office can do, and suggests your first task — all in Discord.

## Prerequisites

- **Node.js** >= 22
- **Claude Code** (Max subscription recommended for parallel workers)
- **Discord Bot** — [create one here](https://discord.com/developers/applications)
  - Enable **MESSAGE CONTENT** intent
  - Invite the bot to your server with admin permissions
- **ngrok** (optional) — for remote Pixel Office access. [Install](https://ngrok.com/download)

## Architecture

```
User ──→ Discord ──→ Leader (Opus)
                        │
                ┌───────┼───────┐
                ▼       ▼       ▼
            Worker   Worker   Worker  (Sonnet)
                ▲       ▲       ▲
                └───────┼───────┘
                        │
              Coordination MCP (SQLite)
                        │
                   Pixel Office UI
```

| Module | Purpose | Tools |
|--------|---------|-------|
| `discord-bot/` | Discord Bot + MCP Server | 16 tools |
| `coordination/` | Shared state, tasks, events, audit | 18 tools |
| `orchestrator/` | Agent lifecycle CLI | 6 commands |
| `pixel-office/` | Real-time visualization (Phaser.js) | — |
| `setup/` | Configuration wizard | — |
| `roles/` | 71 role templates (YAML) | — |

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

71 roles across 4 categories:

- **1 Default** — Leader (always present)
- **20 General** — PM, Engineer, Analyst, Designer, QA, DevOps, etc.
- **45 Industry** — Tech, Finance, E-Commerce, Healthcare, Legal, Education, Media, Gaming, Crypto, Government, and more
- **5 Emerging** — AI Prompt Engineer, ESG Analyst, Crisis PR, Accessibility Consultant, Personal Brand

See [docs/role-catalog.md](docs/role-catalog.md) for the complete catalog.

## Pixel Office UI

Pixel Office starts automatically after setup. Or run manually:

```bash
cd pixel-office && npm run dev
```

Open `http://localhost:3848` locally, or use the ngrok public URL (shown in Discord `#bot-status`).

Features:
- **Agent sprites** with spawn/despawn animations, idle bobbing, busy typing indicator
- **Task assignment lines** — dashed lines from Leader to workers for active tasks
- **Agent panel** — click any agent to see details, active tasks, stats (or press `Escape` to close)
- **Task Board** — toggle with `T` key, shows in-progress/pending/completed tasks with progress bars
- **Message Feed** — toggle with `M` key, streams all agent-to-agent events with agent/type filters
- **Speech bubbles** — agents show status change messages ("Working...", "Done!", "Online")

## Remote Access (ngrok)

Enable during setup to access Pixel Office from anywhere:

- **ngrok tunnel** with Basic Auth — browser prompts for username/password
- Leader auto-publishes the public URL to Discord `#bot-status` on startup
- Configure ngrok auth token at [dashboard.ngrok.com](https://dashboard.ngrok.com/get-started/your-authtoken)

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
| [Security Model](docs/security-model.md) | Authentication, authorization, audit |
| [API Reference](docs/api-reference.md) | 34 MCP tools + CLI commands |
| [Role Catalog](docs/role-catalog.md) | All 71 role templates |

## Configuration

| File | Purpose |
|------|---------|
| `config/office.yaml` | Office name, language, agent limits |
| `config/channels.yaml` | Discord channel layout + throttle rules |
| `config/starter-packs.yaml` | Pre-configured role combinations |
| `config/active-roles.yaml` | Currently active roles (written by wizard) |
| `.mcp.json` | MCP server config for Claude Code |

## License

MIT
