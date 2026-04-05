# AI Office

A multi-agent virtual office powered by Claude Code. "Hire" AI agents with specialized roles that collaborate via Discord to accomplish complex tasks under human supervision.

## Prerequisites

- **Node.js** >= 22
- **Claude Code** (Max subscription recommended)
- **Discord Bot** — [create one here](https://discord.com/developers/applications)
  - Enable **MESSAGE CONTENT** intent
  - Invite the bot to your server with admin permissions

## Quick Start

```bash
git clone https://github.com/your-org/ai-office.git
cd ai-office
./setup.sh
```

The setup script will:
1. Check prerequisites
2. Install dependencies for all sub-projects
3. Build all TypeScript
4. Run the interactive configuration wizard

After setup, open Claude Code:

```bash
claude
```

The Leader agent will initialize and greet you in Discord `#general`.

## Starter Packs

| Pack | Roles | Use Case |
|------|-------|----------|
| Solo Creator | Leader only | Exploring AI Office |
| Dev Team | PM + Software Engineer | Building software |
| Startup MVP | PM + Engineer + Research Analyst | Rapid prototyping |
| Research Lab | Research Analyst | Deep research & analysis |

## Architecture

```
ai-office/
  discord-bot/      # Discord Bot + MCP Server (16 tools)
  coordination/     # Coordination MCP Server (18 tools)
  orchestrator/     # Agent lifecycle CLI (spawn/stop workers)
  pixel-office/     # Real-time visualization (Phaser.js)
  setup/            # Configuration wizard
  config/           # Office + channel + starter pack config
  roles/            # Role templates (YAML)
  agents/           # Leader + Worker CLAUDE.md templates
```

- **Leader** (Opus) receives user requests, delegates to workers
- **Workers** (Sonnet) execute specialized tasks
- **Discord** is the human-facing UI layer
- **Coordination MCP** handles agent-to-agent state
- **Pixel Office** visualizes the office in real-time

## Pixel Office UI

Start the visualization dashboard:

```bash
cd pixel-office && npm run dev
```

Open `http://localhost:3848` to see your agents in a pixel art office.

## Docker

Build and run the Pixel Office UI:

```bash
docker compose up pixel-office
```

Run the setup wizard in Docker:

```bash
docker compose run setup
```

## Configuration

| File | Purpose |
|------|---------|
| `config/office.yaml` | Office name, language, agent limits |
| `config/channels.yaml` | Discord channel layout + throttle rules |
| `config/starter-packs.yaml` | Pre-configured role combinations |
| `config/active-roles.yaml` | Currently active roles (written by wizard) |
| `.mcp.json` | MCP server config for Claude Code |
| `discord-bot/.env` | Discord bot credentials |

## Security

- **OutputGate**: Scope + clearance + data classification checks on every Discord message
- **Identity Tokens**: HMAC-SHA256 signed tokens for agent authentication
- **Audit Trail**: Hash-chained, tamper-evident log of all agent actions
- **Role Scopes**: Fine-grained permission model per role template

## License

MIT
