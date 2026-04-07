# API Reference

This document covers the three API surfaces exposed by AI Office:

1. **Coordination MCP Server** (`ai-office-coordination`) — 19 tools for task management, event bus, observability, and validation. Used by all agents.
2. **Discord MCP Server** (`ai-office-discord`) — 16 tools for channel management, messaging, threads, approvals, and admin. Used by agents to interact with Discord.
3. **Orchestrator CLI** — 6 commands for managing worker lifecycle and session state. Called by the Leader agent via shell.

All tools require agents to identify themselves via `agent_id`. The Coordination server additionally enforces JWT-based identity tokens; tools that access sensitive data require a minimum clearance level.

---

## Coordination MCP Server

**Server name:** `ai-office-coordination`  
**Transport:** stdio (spawned by Claude Code via `.mcp.json`)  
**Database:** SQLite WAL at `$AI_OFFICE_WORKSPACE/state/coordination.db`

### Task Management

#### `task_create`

Create a new task and optionally assign it to an agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | yes | Task title |
| `description` | string | no | Full task description |
| `created_by` | string | yes | Agent ID of the creator |
| `assigned_to` | string | no | Agent ID to assign to |
| `priority` | `low` \| `normal` \| `high` \| `urgent` | no | Task priority |
| `risk_level` | `GREEN` \| `YELLOW` \| `RED` | no | Risk classification |
| `trace_id` | string | no | Trace ID for distributed tracing |
| `steps` | `Array<{ description: string }>` | no | Ordered list of task steps |
| `input_artifacts` | string[] | no | Artifact IDs required as inputs |

**Returns:** JSON object with `task_id`, `status`, `created_at`, and the full task record.

**Notes:** Enforces caller identity — `created_by` must match the authenticated agent token.

---

#### `task_update`

Update a task's status, assignment, or context summary.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | yes | ID of the task to update |
| `agent_id` | string | yes | Agent making the update |
| `status` | `pending` \| `assigned` \| `in_progress` \| `checkpoint` \| `completed` \| `failed` \| `cancelled` | no | New status |
| `assigned_to` | string | no | Reassign to a different agent |
| `context_summary` | string | no | Updated context for resume operations |
| `output_artifact` | string | no | Artifact ID produced by this task |

**Returns:** Updated task record.

---

#### `task_checkpoint`

Save progress at a step boundary so the task can be resumed after a crash or context reset.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | yes | Task being checkpointed |
| `agent_id` | string | yes | Agent recording the checkpoint |
| `step_index` | number | yes | Index of the completed step (0-based) |
| `output_artifact` | string | no | Artifact ID produced by this step |
| `checksum` | string | no | SHA256 checksum for skip-on-match logic |
| `context_summary` | string | no | Context summary for rebuilding on resume |

**Returns:** Checkpoint record with `checkpoint_id` and `saved_at`.

---

#### `task_resume`

Resume an interrupted task. Rebuilds context from the latest checkpoint and returns everything needed to continue.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Resuming agent |
| `task_id` | string | no | Specific task to resume. If omitted, finds the latest interrupted task assigned to this agent. |

**Returns:** Object containing the task record, last completed `step_index`, `context_summary`, and any `output_artifact` from the last checkpoint.

---

#### `task_list`

List tasks with optional filters.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | no | Filter by status (e.g., `in_progress`) |
| `assigned_to` | string | no | Filter by assignee agent ID |
| `limit` | number | no | Maximum number of tasks to return |

**Returns:** Array of task records, sorted by `created_at` descending.

---

### Event Bus & Inbox

#### `publish_artifact`

Publish a shared artifact and notify all agents via their inboxes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | yes | Task that produced the artifact |
| `agent_id` | string | yes | Publishing agent |
| `name` | string | yes | Human-readable artifact name |
| `path` | string | yes | File path to the artifact |
| `checksum` | string | yes | SHA256 checksum of the artifact content |
| `trace_id` | string | yes | Trace ID for correlation |
| `version` | number | no | Version number (auto-increments if omitted) |

**Returns:** Object with `artifact_id`, `version`, and `notified_agents` count.

---

#### `check_inbox`

Read unread messages from an agent's inbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent whose inbox to read |
| `mark_read` | boolean | no | Mark returned messages as read. Default: `true`. |
| `limit` | number | no | Maximum messages to return. Default: `20`. |

**Returns:** Array of inbox messages, each with `message_id`, `type`, `source_agent`, `payload`, and `received_at`.

---

#### `publish_event`

Publish a generic event to the event bus, optionally targeting specific agents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | yes | Event type identifier (e.g., `task.assigned`, `artifact.ready`) |
| `source_agent` | string | yes | Originating agent ID |
| `target_agents` | string | no | Comma-separated agent IDs, or `*` for broadcast |
| `payload` | object | yes | Arbitrary event data |
| `trace_id` | string | yes | Trace ID for correlation |

**Returns:** Object with `event_id` and `delivered_to` count.

---

### Observability

#### `report_status`

Report agent status or send a heartbeat. Should be called periodically by all active agents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Reporting agent |
| `role_id` | string | yes | Role identifier (e.g., `software-engineer`) |
| `department` | string | no | Department the agent belongs to (e.g., `engineering`) |
| `status` | `online` \| `busy` \| `idle` \| `offline` | yes | Current status |
| `current_task_id` | string | no | ID of the task currently being worked on |
| `clearance_level` | number | no | Agent's clearance level (1–5) |

**Returns:** Updated agent registry entry with `last_seen` timestamp.

---

#### `list_agents`

List registered agents with optional filters.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | no | Filter by status (`online`, `busy`, `idle`, `offline`) |
| `department` | string | no | Filter by department |

**Returns:** Array of agent registry records with `agent_id`, `role_id`, `department`, `status`, `last_seen`, and `current_task_id`.

---

#### `start_trace`

Start a distributed trace span. Returns a `span_id` that must be passed to `end_trace`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent starting the span |
| `operation` | string | yes | Name of the operation being traced |
| `trace_id` | string | no | Join an existing trace, or auto-generate a new one |
| `parent_span_id` | string | no | Parent span ID for nested traces |
| `metadata` | object | no | Additional context for the span |

**Returns:** Object with `trace_id`, `span_id`, and `started_at`.

---

#### `end_trace`

End a trace span and record its outcome.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `span_id` | string | yes | Span to close |
| `status` | `completed` \| `error` | yes | Outcome of the span |
| `metadata` | object | no | Final context (e.g., output size, error message) |

**Returns:** Completed span record with `duration_ms`.

---

#### `get_trace`

Retrieve all spans belonging to a trace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `trace_id` | string | yes | Trace to retrieve |

**Returns:** Array of span records in chronological order, each with `span_id`, `operation`, `agent_id`, `status`, `started_at`, `ended_at`, and `duration_ms`.

---

#### `read_audit_log`

Read hash-chained audit log entries. Requires clearance level 3 (RESTRICTED) or higher.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `trace_id` | string | no | Filter by trace ID |
| `agent_id` | string | no | Filter by agent |
| `limit` | number | no | Maximum entries to return |

**Returns:** Array of audit entries, each with `entry_id`, `hash`, `prev_hash`, `agent_id`, `action`, `payload`, and `created_at`.

**Auth:** Requires clearance level >= 3.

---

#### `verify_audit_chain`

Verify the integrity of the hash-chained audit log by recomputing and comparing hashes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | no | Number of recent entries to verify |

**Returns:** Object with `valid` (boolean), `entries_checked` count, and `first_broken_entry_id` if the chain is broken.

**Auth:** Requires clearance level >= 3.

---

### Validation

#### `validate_numeric`

Validate a numeric value with optional range check, cross-check formula, and baseline tolerance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Validating agent |
| `trace_id` | string | yes | Trace ID for audit |
| `value` | number | yes | The value to validate |
| `field_name` | string | yes | Human-readable field name for error messages |
| `expected_range` | `{ min: number, max: number }` | no | Acceptable range bounds |
| `cross_check_formula` | string | no | Formula to recompute the value (e.g., `revenue - expenses`) |
| `cross_check_values` | `Record<string, number>` | no | Variable bindings for the formula |
| `tolerance_pct` | number | no | Allowed percentage deviation from baseline |
| `baseline` | number | no | Historical baseline value for tolerance check |

**Returns:** Object with `valid` (boolean), list of `failures` (each with `check` name and `detail`), and `computed_value` if a formula was evaluated.

---

#### `cross_verify`

Compare two agents' independent calculations of the same value to detect discrepancies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | yes | Task context |
| `trace_id` | string | yes | Trace ID |
| `field_name` | string | yes | Field being compared |
| `agent_a` | string | yes | First agent ID |
| `value_a` | number | yes | First agent's computed value |
| `agent_b` | string | yes | Second agent ID |
| `value_b` | number | yes | Second agent's computed value |
| `tolerance_pct` | number | no | Allowed percentage difference. Default: `0.01` (0.01%). |

**Returns:** Object with `match` (boolean), `difference`, `difference_pct`, and `tolerance_pct`.

---

#### `report_anomaly`

Report an anomaly to the Leader for review. Posts to the Leader's inbox and audit log.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Reporting agent |
| `trace_id` | string | yes | Trace ID |
| `task_id` | string | no | Related task, if applicable |
| `severity` | `warning` \| `error` \| `critical` | yes | Severity level |
| `description` | string | yes | Human-readable description of the anomaly |
| `data` | object | no | Supporting data (values, diffs, context) |

**Returns:** Object with `anomaly_id` and `delivered_to` (the Leader's inbox).

---

#### `pipeline_gate`

Validate a set of named conditions before proceeding to the next pipeline step. All checks must pass for the gate to open.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent running the gate |
| `trace_id` | string | yes | Trace ID |
| `task_id` | string | yes | Task being gated |
| `step_index` | number | yes | Current step index |
| `checks` | `Array<{ name: string, condition: boolean, detail?: string }>` | yes | List of named boolean checks |

**Returns:** Object with `passed` (boolean), `step_index`, and a `results` array listing each check's `name`, `passed` state, and optional `detail`.

---

## Discord MCP Server

**Server name:** `ai-office-discord-bot`  
**Transport:** stdio (spawned by Claude Code via `.mcp.json`)

All write operations pass through two layers before reaching Discord:

- **OutputGate** — verifies the agent's scopes and clearance level permit writing to the target channel.
- **Throttle Manager** — enforces per-channel message rate limits; messages may be buffered, edited, or rejected depending on channel throttle policy.

### Channel Management

#### `create_category`

Create a Discord category channel.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Calling agent ID |
| `name` | string | yes | Category name (max 100 characters) |

**Returns:** Confirmation string with category name and Discord channel ID.

---

#### `create_channel`

Create a text channel under a specific category.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Calling agent ID |
| `category_name` | string | yes | Name of the parent category |
| `channel_name` | string | yes | Channel name — use lowercase and hyphens (max 100 characters) |
| `topic` | string | no | Optional channel topic shown in Discord |

**Returns:** Confirmation string with channel name, category, and Discord channel ID.

---

#### `list_channels`

List all channels and categories in the Discord server. No parameters required.

**Returns:** Formatted text listing categories and their child channels with IDs and topics.

---

#### `delete_channel`

Delete a channel or category by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Calling agent ID |
| `channel_name` | string | yes | Name of the channel or category to delete |

**Returns:** Confirmation string with the deleted channel name.

---

### Messaging

#### `send_message`

Send a plain text message to a Discord channel. Subject to OutputGate and throttle checks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Sending agent ID |
| `channel_name` | string | yes | Target channel name (without `#`) |
| `content` | string | yes | Message text (max 2000 characters) |

**Returns:** `Message sent to #<channel> (message ID: <id>)`, or `BUFFERED: <reason>` if the throttle held the message.

**Notes:** Messages containing `@` are treated as mentions (higher throttle priority). Messages matching `ERROR` bypass some throttle rules.

---

#### `send_embed`

Send a rich embed message to a Discord channel. Subject to OutputGate and throttle checks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Sending agent ID |
| `channel_name` | string | yes | Target channel name |
| `embed.title` | string | yes | Embed title (max 256 characters) |
| `embed.description` | string | yes | Embed body (max 4096 characters) |
| `embed.color` | number | no | Embed color as decimal integer (e.g., `5765365` for Discord blurple) |
| `embed.fields` | `Array<{ name: string, value: string }>` | no | Up to 25 inline fields |
| `embed.footer` | string | no | Footer text (max 2048 characters) |

**Returns:** Message ID string, or `BUFFERED: <reason>`.

**Notes:** On channels with `embed-edit` throttle mode, subsequent embeds update the existing message instead of posting a new one.

---

#### `read_messages`

Read recent messages from a channel.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel_name` | string | yes | Channel to read from |
| `limit` | number | no | Number of messages to fetch (1–100, default 10) |

**Returns:** Formatted text listing each message as `[timestamp] BOT/USER <author>: <content>`.

---

#### `read_new_messages`

Read only messages posted since the last time this channel was checked. Useful for polling in an event loop.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel_name` | string | yes | Channel to poll |

**Returns:** Formatted text of new messages, same format as `read_messages`. Returns a "no new messages" notice if nothing has arrived.

---

### Threads

#### `create_thread`

Create a thread branching from an existing message in a channel.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Creating agent ID |
| `channel_name` | string | yes | Channel containing the source message |
| `message_id` | string | yes | Discord message ID to thread from |
| `thread_name` | string | yes | Thread display name (max 100 characters) |

**Returns:** Confirmation string with thread name and thread ID.

**Notes:** OutputGate is checked against the parent channel before the thread is created.

---

#### `send_thread_message`

Send a message inside an existing thread.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Sending agent ID |
| `thread_id` | string | yes | Discord thread channel ID |
| `content` | string | yes | Message content (max 2000 characters) |

**Returns:** Confirmation string with thread ID and message ID.

**Notes:** Thread messages bypass the throttle manager but are still subject to OutputGate scope checks.

---

### Approvals

#### `create_approval`

Post an approval request with Approve / Reject / Preview buttons to a Discord channel. The Leader should poll `check_approval` until the human responds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Requesting agent ID |
| `channel_name` | string | yes | Channel to post the approval request in |
| `action` | string | yes | Short description of what is being approved |
| `description` | string | yes | Detailed explanation of the action and its impact |
| `risk_level` | `GREEN` \| `YELLOW` \| `RED` | yes | Risk classification; shown visually on the approval card |

**Returns:** Text block containing `approval_id`, `status` (`pending`), channel, and risk level. Use the `approval_id` to poll with `check_approval`.

**Notes:** OutputGate is enforced before posting. `GREEN` risk actions may be auto-approved depending on `office.yaml` settings.

---

#### `check_approval`

Check the current status of an approval request.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `approval_id` | string | yes | ID returned by `create_approval` |

**Returns:** Text block with all approval fields: `approval_id`, `status` (`pending` \| `approved` \| `rejected`), `action`, `description`, `risk_level`, `channel`, `created_at`, and — if resolved — `resolved_at` and `resolved_by`.

---

### Setup & Admin

#### `setup_server`

Initialize the AI Office Discord server with the standard set of categories and channels. Safe to call multiple times — it skips channels that already exist.

No parameters required.

**Returns:** Summary listing channels `Created`, `Already existed`, and any `Errors`.

---

#### `register_agent`

Register an agent when it first comes online. Resolves the agent's role profile from `config/active-roles.yaml` and creates department channels if they do not already exist.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent ID in the format `<role-id>-<instance>` (e.g., `software-engineer-1`) |

**Returns:** Agent profile summary including role, department, clearance level, granted and denied scope counts, and any department channels that were created.

---

#### `flush_throttle`

Force-flush the throttle buffer for a channel, sending all buffered messages immediately. Only callable by agents with role `leader` or `system`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Calling agent (must be `leader` or `system` role) |
| `channel_name` | string | yes | Channel whose buffer to flush |

**Returns:** Confirmation with the Discord message ID of the flushed content, or a notice that no buffered messages existed.

---

#### `get_output_gate_status`

Diagnostic tool. Check what permissions an agent currently has for a specific channel without sending any message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent to inspect |
| `channel_name` | string | yes | Channel to check |

**Returns:** Text block showing `allowed` (boolean), optional denial reason, and the agent's full profile (role, department, clearance, write scopes, and denied scopes).

---

## Orchestrator CLI

**Binary:** `node orchestrator/dist/index.js <command> [flags]`  
**All output is JSON** printed to stdout (pretty-printed with 2-space indentation).  
**Errors** print to stderr and exit with code 1.

---

### `init`

Initialize a new session. Generates a session key, cleans up stale worker records, loads office config, and syncs active roles to the coordination database.

```sh
node orchestrator/dist/index.js init
```

**Output:**

```json
{
  "session_id": "sk_...",
  "office_name": "My AI Office",
  "language": "en",
  "max_workers": 3,
  "stale_workers_cleaned": 0,
  "agents_synced": 2
}
```

| Field | Description |
|-------|-------------|
| `session_id` | Newly generated session key |
| `office_name` | From `config/office.yaml` |
| `language` | Primary language code |
| `max_workers` | `agents.workers.max_concurrent` from config |
| `stale_workers_cleaned` | Number of stale worker records removed |
| `agents_synced` | Number of active roles written to the DB |

---

### `prepare-worker`

Prepare a workspace directory for a new worker agent. Generates the worker's identity token and assembles its `CLAUDE.md` from the base template and role template.

```sh
node orchestrator/dist/index.js prepare-worker --role <role-id>
```

**Flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--role` | yes | Role ID to instantiate (e.g., `software-engineer`, `pm`) |

**Output:**

```json
{
  "agent_id": "software-engineer-1",
  "role_id": "software-engineer",
  "instance": 1,
  "workspace_dir": "/path/to/.ai-office/workers/software-engineer-1",
  "identity_token": "eyJ...",
  "claude_md_path": "/path/to/.ai-office/workers/software-engineer-1/CLAUDE.md"
}
```

| Field | Description |
|-------|-------------|
| `agent_id` | Assigned agent ID (`<role-id>-<instance>`) |
| `role_id` | The role that was instantiated |
| `instance` | Instance number (increments per role) |
| `workspace_dir` | Directory where the worker will run |
| `identity_token` | JWT to pass as `AGENT_TOKEN` env var when spawning the worker |
| `claude_md_path` | Absolute path to the assembled CLAUDE.md for this worker |

---

### `stop-worker`

Stop a worker and clean up its registry entry.

```sh
node orchestrator/dist/index.js stop-worker --agent-id <agent-id>
```

**Flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--agent-id` | yes | Agent ID of the worker to stop (e.g., `software-engineer-1`) |

**Output:**

```json
{
  "agent_id": "software-engineer-1",
  "status": "stopped"
}
```

---

### `list-workers`

List all worker records with current statuses and spawn capacity.

```sh
node orchestrator/dist/index.js list-workers [--status <status>]
```

**Flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--status` | no | Filter by status: `spawning`, `online`, `busy`, or `stopped` |

**Output:**

```json
{
  "workers": [
    {
      "agent_id": "software-engineer-1",
      "role_id": "software-engineer",
      "status": "online",
      "started_at": "2026-04-05T10:00:00.000Z"
    }
  ],
  "capacity": {
    "active": 1,
    "max": 3,
    "can_spawn": true
  }
}
```

| Field | Description |
|-------|-------------|
| `workers` | Array of worker records matching the filter |
| `capacity.active` | Number of currently active (non-stopped) workers |
| `capacity.max` | `max_concurrent` from config |
| `capacity.can_spawn` | Whether a new worker can be spawned without exceeding the limit |

---

### `validate-token`

Validate an identity token and return its decoded claims. Exits with code 1 if the token is invalid or expired.

```sh
node orchestrator/dist/index.js validate-token --token <token>
```

**Flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--token` | yes | JWT identity token to validate |

**Output (valid):**

```json
{
  "valid": true,
  "identity": {
    "agent_id": "software-engineer-1",
    "role_id": "software-engineer",
    "session_id": "sk_...",
    "issued_at": "2026-04-05T10:00:00.000Z",
    "expires_at": "2026-04-05T18:00:00.000Z"
  }
}
```

**Output (invalid):**

```json
{
  "valid": false
}
```

Exit code 1 is returned when `valid` is false.

---

### `office-config`

Print the current office configuration from `config/office.yaml` as JSON.

```sh
node orchestrator/dist/index.js office-config
```

**Output:** The full parsed `office.yaml` object, including all sections (`office`, `agents`, `execution`, `startup`, `working_hours`, `logging`, `paths`).
