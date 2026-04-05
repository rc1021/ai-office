# AI Office - Project Root

## Overview
AI Office is a multi-agent virtual office system powered by Claude Code.
Users "hire" AI agents with specialized roles, who collaborate via Discord
to accomplish complex tasks under human supervision.

## Tech Stack
- **Orchestration**: Claude Code (Max 20x) — Opus 4.6 Leader + Sonnet 4.6 Workers
- **Communication**: Discord (discord.js v14) — Bot + MCP Server
- **Coordination**: Coordination MCP Server + SQLite WAL
- **Visualization**: Phaser.js pixel office (future)

## Project Structure
```
ai-office/
├── CLAUDE.md                 # This file — project-level instructions
├── config/                   # Office configuration
│   ├── office.yaml           # Core settings (name, language, defaults)
│   └── channels.yaml         # Discord channel layout + throttle rules
├── roles/
│   ├── schemas/              # JSON Schema for role templates
│   │   └── role-template.schema.json
│   └── templates/            # Role template YAML files
│       ├── _leader.yaml      # Leader (default, always present)
│       ├── pm.yaml           # Project Manager
│       ├── software-engineer.yaml
│       └── ...               # 71 total planned
├── agents/
│   ├── leader/               # Leader agent workspace
│   │   └── CLAUDE.md         # Leader instructions
│   └── worker-template/      # Template for spawning workers
│       └── CLAUDE.md         # Worker base instructions (role injected at runtime)
├── discord-bot/              # Discord Bot + MCP Server (Step 1 complete)
│   ├── src/
│   └── dist/
└── coordination/             # Coordination MCP Server (Step 2, planned)
```

## Development Rules

### Security First
- Every component must consider auth, audit, and injection prevention from line 1
- Agent identity and scopes are enforced at the MCP tool level
- All inter-agent communication uses structured schemas, never free-text
- Output gate checks (scopes + clearance + data classification) before any Discord message

### Agent Communication
- Agents communicate via Coordination MCP Server (structured messages)
- Discord is the human-facing UI layer, not the agent-to-agent bus
- All agent actions are logged to audit trail with trace_id

### Role System
- Leader is the only default role — all others are "hired" by the user
- Each role is a YAML template validated against role-template.schema.json
- Roles define: persona, capabilities, scopes, clearance_level, department, tools
- Worker CLAUDE.md = base template + role template injected at spawn time

### Naming Conventions
- Role template files: kebab-case (e.g., `software-engineer.yaml`)
- Department IDs: lowercase (e.g., `engineering`, `finance`)
- Channel names: lowercase + hyphens (e.g., `dept-engineering`)
- Agent IDs at runtime: `{role-id}-{instance}` (e.g., `software-engineer-1`)
