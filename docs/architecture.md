# AI Office — Architecture

> 視覺化架構圖：[`docs/architecture.km.svg`](./architecture.km.svg)（KityMinder 格式，可直接用 [KityMinder](https://github.com/fex-team/kityminder) 或 [百度腦圖](https://naotu.baidu.com/) 開啟）

## 1. System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                            Human User                                │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ Discord (#general, #approvals)
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Listener Daemon (discord-bot)                      │
│  Always-online process — receives messages, spawns claude -p          │
│                                                                      │
│  ┌─────────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ Message Queue   │  │ Discord      │  │ Approval Manager       │  │
│  │ (dedup + serial)│  │ ChatAdapter  │  │ (buttons + file state) │  │
│  └────────┬────────┘  └──────────────┘  └────────────────────────┘  │
│           │                                                          │
│  ┌────────▼────────────────────────────────────────────────────────┐ │
│  │ @ai-office/core                                                 │ │
│  │  ┌──────────────┐  ┌───────────────┐  ┌─────────────────────┐  │ │
│  │  │ Claude Runner│  │ Heartbeat     │  │ Output Gate          │  │ │
│  │  │ (spawn -p)   │  │ (health/audit)│  │ (4-layer ACL)        │  │ │
│  │  └──────────────┘  └───────────────┘  └─────────────────────┘  │ │
│  │  ┌──────────────┐  ┌───────────────┐  ┌─────────────────────┐  │ │
│  │  │ Config Loader│  │ Throttle Mgr  │  │ Agent Registry      │  │ │
│  │  │ (office.yaml)│  │ (rate limit)  │  │ (YAML → profile)    │  │ │
│  │  └──────────────┘  └───────────────┘  └─────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└──────────┬──────────────────────────────────────────────┬────────────┘
           │ claude -p (per message)                      │ Discord.js
           ▼                                              ▼
┌────────────────────┐                        ┌─────────────────────┐
│ Leader Agent       │                        │ Discord API / Guild │
│ (Opus 4.6)         │                        │ 4 channels:         │
│                    │                        │  #general            │
│ agents/leader/     │                        │  #approvals          │
│ CLAUDE.md          │                        │  #alerts             │
└────────┬───────────┘                        │  #daily-brief        │
         │ Agent tool (Sonnet 4.6)            └─────────────────────┘
         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Worker Agents (N concurrent)                       │
│  CLAUDE.md = worker-template + role persona + behavior rules         │
│  Workspace: .ai-office/departments/{dept}/workspace/{agent-id}/      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │ software-    │  │ pm-1         │  │ research-analyst-1         │  │
│  │ engineer-1   │  │              │  │                            │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬──────────────┘  │
└─────────┼─────────────────┼───────────────────────┼──────────────────┘
          └─────────────────┼───────────────────────┘
                            │ MCP stdio (ai-office-coordination)
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   Coordination MCP Server (19 tools)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │ Task Tools   │  │ Event Bus /  │  │ Observability Tools        │  │
│  │ (CRUD +      │  │ Inbox Tools  │  │ (traces, audit, status)    │  │
│  │ checkpoint)  │  │ (pub/sub)    │  │                             │  │
│  └──────────────┘  └──────────────┘  └───────────────────────────┘  │
│  ┌──────────────┐  ┌────────────────────────────────────────────┐   │
│  │ Validation   │  │ Auth Middleware                              │   │
│  │ (numeric /   │  │ (enforceIdentity / enforceClearance)        │   │
│  │ cross-verify)│  └────────────────────────────────────────────┘   │
│  └──────────────┘                                                    │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ SQLite WAL
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  .ai-office/state/coordination.db                                    │
│  tasks | agents | events | inbox | audit_log | artifacts | traces    │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                   Pixel Office (visualization)                        │
│  Express API (:3847) + SSE + Phaser.js client                        │
│  Queries coordination.db directly (pull) — no push from Core         │
│  Receives fire-and-forget broadcasts for animations                  │
└──────────────────────────────────────────────────────────────────────┘

Three-Layer Separation:
  Core (DB)  ──record──→  coordination.db  ←──query──  Pixel Office
  Leader     ──reply───→  Discord (4 ch)               (pull + broadcast)
  Heartbeat  ──alert───→  #alerts, #daily-brief
```

---

## 2. Module Descriptions

### core

**Purpose**: Platform-agnostic orchestration logic. Contains everything that does not depend on a specific chat platform (Discord/Slack/etc.). Published as `@ai-office/core`, referenced via `file:../core`.

**Key files**:
- `src/chat-adapter.ts` — `ChatAdapter` interface: sendMessage, sendEmbed, editEmbed, channelExists, createCategory, createChannel
- `src/claude-runner.ts` — Spawns `claude -p` with configurable projectDir, mcpConfigPath, and allowedTools
- `src/heartbeat.ts` — Health checks (1min), health alerts to #alerts, daily brief (configurable) to #daily-brief, stale task cleanup, Internal Auditor auto-trigger — all via ChatAdapter
- `src/config-loader.ts` — Reads `config/office.yaml`, returns timezone/language/statePath
- `src/output-gate.ts` — 4-layer security check before any message send
- `src/throttle-manager.ts` — Rate limiting: buffer, reject, embed-edit strategies per channel
- `src/agent-registry.ts` — Resolves `agent_id` → security profile by loading role YAML
- `src/types.ts` — Shared types (EmbedInput, RiskLevel, AgentProfile, etc.) + COLORS

### discord-bot

**Purpose**: Discord-specific adapter. Implements `ChatAdapter` for Discord, runs the MCP Server for Discord tools, and hosts the listener daemon that connects everything.

**Key files**:
- `src/listener.ts` — Thin-shell daemon: Discord Client + message queue + heartbeat via `DiscordChatAdapter`
- `src/discord-adapter.ts` — Implements `ChatAdapter` for Discord (delegates to message-manager/channel-manager)
- `src/mcp-server.ts` — 16 MCP tools exposed to agents (channels, messaging, approvals, setup)
- `src/message-manager.ts` — Discord.js message sending/reading
- `src/channel-manager.ts` — Discord.js channel creation/lookup
- `src/approval-manager.ts` — File-based approval state (JSON); Discord buttons via deferred interaction replies
- `src/setup-server.ts` — Idempotent setup of 4 channels (general, approvals, alerts, daily-brief)
- `src/department-manager.ts` — Tracks department membership on agent registration

### coordination

**Purpose**: Internal agent-to-agent coordination bus. Agents never talk to each other directly — all inter-agent communication, task state, and shared artifacts flow through this MCP Server backed by SQLite WAL.

**Key files**:
- `src/index.ts` — 18 MCP tools across 5 groups; token auth enforced per-tool
- `src/auth.ts` — Reads `AI_OFFICE_AGENT_TOKEN` env, enforces identity/clearance at tool call time
- `src/database.ts` — SQLite schema (7 tables), WAL mode, versioned migrations, hash-chained audit log
- `src/tools/task-tools.ts` — Task state machine: pending → assigned → in_progress → checkpoint → completed/failed
- `src/tools/event-tools.ts` — Publish/subscribe event bus; per-agent inbox with unread tracking
- `src/tools/observability-tools.ts` — Agent heartbeats, distributed trace spans, audit log read/verify
- `src/tools/validation-tools.ts` — Numeric range checks, cross-agent verification, anomaly reporting, pipeline gates

### orchestrator

**Purpose**: CLI tool run by the Leader to manage the worker agent lifecycle. Issues identity tokens, prepares worker workspaces, and cleans up after workers finish.

**Key files**:
- `src/index.ts` — CLI entry point: `init`, `prepare-worker`, `stop-worker`, `list-workers`, `validate-token`
- `src/identity.ts` — HMAC-SHA256 session key generation, JWT-style token issuance and validation, revocation list
- `src/lifecycle.ts` — Worker record tracking, workspace directory creation, stale worker cleanup
- `src/config-reader.ts` — Parses `config/office.yaml` and `config/active-roles.yaml`
- `src/sync-agents.ts` — Syncs active role config into coordination DB on `init`

### pixel-office

**Purpose**: Real-time visual dashboard of the office. Shows agents as pixel sprites on a floor plan with live status. Read-only relative to the coordination system.

**Key files**:
- `server/index.ts` — Express server (port 3847), seeds active roles from coordination DB, SSE stream endpoint
- `server/routes.ts` — REST API: agent status, task list, artifact list
- `server/sse.ts` — Server-Sent Events for real-time agent movement and status updates
- `client/` — Phaser.js game client (served statically in production, Vite dev server on port 3848)

### setup

**Purpose**: Interactive first-run wizard. Guides the user through Discord credentials, office name, language, and agent capacity. Writes `config/office.yaml` and configures `.mcp.json`.

**Key files**:
- `src/wizard.ts` — Inquirer.js prompts for all required configuration values
- `src/generator.ts` — Writes `office.yaml`, patches `.mcp.json` with env vars and MCP server entries

### roles

**Purpose**: Declarative role definitions. Each YAML file specifies a role's persona, capabilities, department, clearance, and scopes. Validated against a JSON Schema.

**Key files**:
- `schemas/role-template.schema.json` — Authoritative schema for all role templates
- `templates/_leader.yaml` — Built-in leader role (clearance 3, unrestricted scopes)
- `templates/*.yaml` — 71 planned worker roles (pm, software-engineer, research-analyst, …)

---

## 3. Data Flow

The following numbered steps trace a complete user request from Discord message to final response.

```
 1. User types a message in Discord #general
 2. Listener daemon receives the message via discord.js MessageCreate event
 3. Listener queues the message (one at a time), adds ⏳ reaction
 4. Listener spawns `claude -p` with structured prompt envelope
 5. Leader parses the request and calls orchestrator CLI:
      node orchestrator/dist/index.js prepare-worker --role software-engineer
 5. Orchestrator:
    a. Loads role template YAML
    b. Issues HMAC-signed identity token (TTL from office.yaml)
    c. Creates worker workspace at .ai-office/workers/{agent_id}/
    d. Writes worker CLAUDE.md (base template + injected role fields)
    e. Writes .mcp.json with AI_OFFICE_AGENT_TOKEN env var
    f. Returns agent_id, workspace_dir, identity_token to Leader
 6. Leader calls coordination task_create → task stored in SQLite
 7. Leader invokes Claude Code Agent tool with Sonnet 4.6 model,
    pointing at the worker workspace and structured task handoff JSON
 8. Worker agent starts; reads its CLAUDE.md (identity + role context)
 9. Worker calls report_status (status: "online") on coordination MCP
    → coordination auth.ts validates the agent_id matches the token
10. Worker calls task_resume to check for prior interrupted work
11. Worker calls check_inbox to read pending messages
12. Worker executes the task; calls task_checkpoint after each step
13. Worker calls validate_numeric or cross_verify for numerical outputs
14. If the task requires a risky external action:
    Leader calls create_approval → Discord #approvals button UI posted
    Leader polls check_approval until user clicks Approve/Reject
15. Worker calls task_update (status: "completed", output_artifact: "...")
16. Worker calls publish_artifact → artifact record saved; inbox events
    routed to relevant agents
17. Worker calls report_status (status: "idle") and returns structured JSON
18. Leader receives Agent tool output; reviews quality and confidence level
19. Leader calls OutputGate (implicitly via send_message or send_embed):
    a. Denied scopes check
    b. Write scope check
    c. Channel clearance check
    d. Data classification check (content scan for [RESTRICTED] etc.)
20. If gate passes → throttle manager applies rate limits
21. Message delivered to Discord channel; user sees the final response
22. Leader calls orchestrator stop-worker --agent-id {agent_id}
    → token revoked, workspace deleted
```

---

## 4. Agent Lifecycle

### Spawn

```
Leader detects task requires a worker
  │
  ├─ orchestrator prepare-worker --role {role-id}
  │    ├─ Validates role template exists
  │    ├─ Checks canSpawn() (active < max_concurrent from office.yaml)
  │    ├─ Assigns instance number (role-id-N, incrementing)
  │    ├─ Issues HMAC token with role scopes + TTL
  │    ├─ Creates .ai-office/workers/{agent_id}/ workspace
  │    ├─ Writes CLAUDE.md with {{ROLE_*}} placeholders substituted
  │    └─ Returns: agent_id, workspace_dir, identity_token
  │
  └─ Leader calls Agent tool (model: "sonnet", prompt: task handoff JSON)
       Claude Code spawns a Sonnet 4.6 sub-agent with workspace CWD
```

### Execute

```
Worker reads CLAUDE.md → understands identity + role + constraints
  │
  ├─ report_status (online) — registered in coordination DB
  ├─ task_resume — rebuilds context from prior checkpoints if any
  ├─ check_inbox — reads pending messages from event bus
  │
  └─ For each step in the task:
       ├─ Execute work within declared scope boundaries
       ├─ task_checkpoint (step_index, artifact, checksum)
       │    └─ If checksum matches prior checkpoint: skip step (idempotent)
       ├─ validate_numeric / pipeline_gate (optional)
       └─ report_anomaly if unexpected data detected
```

### Complete

```
Worker calls task_update (status: "completed", output_artifact: path)
  │
  ├─ publish_artifact → artifact saved; inbox events routed to leader
  ├─ report_status (idle)
  └─ Returns structured response JSON as Agent tool output

Leader reviews response:
  ├─ Parses confidence level (HIGH / MEDIUM / LOW)
  ├─ Cross-checks via task_get to confirm status = completed
  ├─ For LOW confidence or contradictions: escalates to user
  └─ For acceptable output: passes through OutputGate → Discord
```

### Cleanup

```
Leader calls orchestrator stop-worker --agent-id {agent_id}
  │
  ├─ revokeToken(agent_id) → agent_id added to revoked-tokens.json
  ├─ Worker record marked stopped in .ai-office/state/workers.json
  └─ Workspace directory deleted
```

**Crash Recovery**: If a worker dies mid-task, the task remains in `in_progress` or `checkpoint` state in the DB. On next spawn for the same role, `task_resume` returns the last checkpoint's `context_summary` and `step_index`, allowing the worker to continue from where it left off without re-executing completed steps (checksum-guarded skip).

---

## 5. Technology Stack

| Component | Technology | Version | Role |
|---|---|---|---|
| Leader model | Claude Opus 4.6 | via Max 20x | Task routing, QA, escalation |
| Worker model | Claude Sonnet 4.6 | via Max 20x | Task execution |
| Agent runtime | Claude Code | latest | MCP tool access, Agent tool |
| Core library | `@ai-office/core` | 1.0 | Platform-agnostic orchestration |
| Chat abstraction | ChatAdapter interface | — | Pluggable chat platform (Discord/Slack) |
| Discord client | discord.js | v14 | Bot and guild interaction |
| Discord MCP | `@modelcontextprotocol/sdk` | 1.x | stdio MCP server |
| Coordination MCP | `@modelcontextprotocol/sdk` | 1.x | stdio MCP server |
| Database | better-sqlite3 | latest | WAL-mode SQLite |
| Schema validation | zod | 3.x | MCP tool input validation |
| Role validation | JSON Schema (Ajv) | — | Role template validation |
| Role parsing | js-yaml | 4.x | YAML role templates |
| Token signing | Node.js crypto HMAC-SHA256 | built-in | Agent identity tokens |
| Audit hashing | Node.js crypto SHA-256 | built-in | Hash-chained audit log |
| Pixel Office server | Express | 4.x | REST API + SSE |
| Pixel Office client | Phaser.js | 3.x | 2D pixel sprite rendering |
| Setup wizard | Inquirer.js | latest | Interactive CLI prompts |
| Containerization | Docker + Compose | — | Production deployment |
