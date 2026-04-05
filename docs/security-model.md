# AI Office — Security Model

## 1. Overview

AI Office applies defense-in-depth across five distinct enforcement layers. Each layer independently blocks unauthorized actions, so a compromise of one layer does not grant full system access.

```
Layer 1 — Identity Tokens     (orchestrator/src/identity.ts)
  Agents cannot impersonate each other; tokens are session-scoped and revocable.

Layer 2 — Coordination Auth   (coordination/src/auth.ts)
  Every coordination MCP tool call verifies the caller matches their token.

Layer 3 — Agent Registry      (discord-bot/src/agent-registry.ts)
  Role templates define the security profile; unknown agents are denied by default.

Layer 4 — OutputGate          (discord-bot/src/output-gate.ts)
  4-check pipeline before any Discord write: denied scopes → write scopes →
  channel clearance → data classification.

Layer 5 — Audit Trail         (coordination/src/database.ts)
  Every significant action is written to a hash-chained log that cannot be
  silently altered.
```

**Design principles**:
- Deny by default — unknown agent IDs receive zero Discord write permissions.
- Least privilege — scopes are declared per role template; not inherited globally.
- Structured communication only — agents exchange JSON schemas, never free-text, to prevent prompt injection chains.
- Human in the loop — any action rated YELLOW or RED risk must pass through Discord approval before execution.

---

## 2. Identity & Authentication

### Session Key

On each orchestrator `init`, a fresh 256-bit random session key is generated and written to `~/.ai-office/state/session-key`. Generating a new key immediately invalidates all tokens from the previous session — there is no need to track or expire individual old tokens.

```
generateSessionKey()
  ├─ randomBytes(32) → sessionKey (stored as hex in state/session-key)
  ├─ randomBytes(8).toString("hex") → sessionId
  └─ Clears revoked-tokens.json (old tokens are dead anyway)
```

The session ID is derived deterministically from the key for any caller that loads rather than generates:

```
sessionId = HMAC-SHA256(sessionKey, "session-id").hex().substring(0, 16)
```

### Token Structure

Identity tokens use a JWT-compatible three-part format with HMAC-SHA256 signing:

```
header.payload.signature
  │       │         │
  │       │         └─ HMAC-SHA256(sessionKey, "header.payload").hex()
  │       └─ base64url({ agent_id, role_id, department, clearance_level,
  │                       scopes[], denied_scopes[], iat, exp, session_id })
  └─ base64url({ alg: "HS256", typ: "AIT" })
```

The type `AIT` (Agent Identity Token) distinguishes these from generic JWTs.

**Payload fields of security relevance**:

| Field | Type | Purpose |
|---|---|---|
| `agent_id` | string | Runtime identity (`software-engineer-1`) |
| `role_id` | string | Maps to role template YAML |
| `clearance_level` | 0–3 | Maximum data sensitivity this agent may access |
| `scopes` | string[] | Allowed resource patterns (e.g. `write:discord:dept-engineering`) |
| `denied_scopes` | string[] | Explicitly blocked patterns; checked before grants |
| `exp` | Unix timestamp | Token expiry (default TTL from `office.yaml`, typically 3600 s) |
| `session_id` | string | Must match current session; cross-session tokens are rejected |

### Token Issuance

`issueToken(roleId, instance)` in `orchestrator/src/identity.ts`:

1. Loads role template YAML for `roleId` — token payload is sourced directly from the template, not from caller input, preventing privilege escalation.
2. Builds payload with `iat = now`, `exp = now + token_ttl`.
3. Signs `header.payload` with the current session key.
4. Writes the resulting token to the worker's `.mcp.json` as `AI_OFFICE_AGENT_TOKEN` env var.

### Token Validation

`validateToken(token)` checks in order:

1. Three-part structure
2. HMAC signature matches (constant-time string comparison via hex)
3. `exp` not in the past
4. `session_id` matches current session
5. `agent_id` not in `revoked-tokens.json`

Any single failure returns `null` and logs a warning.

### Token Revocation

`revokeToken(agentId)` appends the agent ID to `~/.ai-office/state/revoked-tokens.json`. This list is checked on every `validateToken` call. When `stop-worker` is called, revocation happens before workspace deletion, ensuring the token cannot be reused even if an attacker copies it out of the workspace.

---

## 3. OutputGate

`checkOutputGate(agentId, channelName, content)` in `discord-bot/src/output-gate.ts` is the gatekeeper for every Discord write operation. It returns `{ allowed: boolean, reason?: string, classification?: string }` and is called before `sendMessage`, `sendEmbed`, `createThread`, and `createApproval`.

The four checks run in strict order. A failure at any layer short-circuits and returns denied.

### Check 1 — Denied Scopes

```typescript
if (isDenied(agent.denied_scopes, normalizedChannel)) → DENY
```

Denied scopes are checked first and cannot be overridden by any grant. A scope in `denied_scopes` is an absolute prohibition.

Scope pattern matching supports three forms:
- `write:discord:*` — wildcard (matches all channels)
- `write:discord:dept-*` — glob prefix (matches all `dept-` channels)
- `write:discord:{channel}` — exact channel name

### Check 2 — Write Scopes

```typescript
if (!hasWriteScope(agent.scopes, normalizedChannel)) → DENY
  exception: agent belongs to the channel's department (implicit grant)
```

Agents writing to `dept-engineering` owned by the `engineering` department receive an implicit write grant even without an explicit `write:discord:dept-engineering` scope. All other channels require explicit scope.

Unknown agent IDs fall through to a minimal profile with `denied_scopes: ["write:discord:*"]`, blocking all Discord writes by default.

### Check 3 — Channel Clearance

```typescript
const requiredClearance = CHANNEL_CLEARANCE[normalizedChannel]
if (agent.clearance_level < requiredClearance) → DENY

if (isConfidentialChannel(channelName) && agent.clearance_level < 2) → DENY
```

Fixed channel clearance requirements:

| Channel | Required clearance |
|---|---|
| `audit-log` | 3 (RESTRICTED — system only) |
| `*-confidential` | 2 (CONFIDENTIAL) |

### Check 4 — Data Classification

```typescript
for pattern in CLASSIFICATION_PATTERNS:
  if pattern.test(content) && agent.clearance_level < pattern.clearance → DENY
```

Classification is detected by scanning message content for marker strings:

| Marker | Classification | Minimum clearance to post |
|---|---|---|
| `[RESTRICTED]` | RESTRICTED | 3 |
| `[CONFIDENTIAL]` | CONFIDENTIAL | 2 |
| `[INTERNAL]` | INTERNAL | 1 |

Unmarked content has no classification restriction and can be posted by any agent with the appropriate scope and channel clearance.

---

## 4. Token Validation Middleware

`coordination/src/auth.ts` implements two enforcement functions that are called inline within each MCP tool handler.

### `enforceIdentity(callerAgentId)`

Called on every tool that mutates state (task_create, task_update, task_checkpoint, task_resume, publish_artifact, check_inbox, report_status). It compares the `agent_id` parameter supplied in the tool call against the `agent_id` from the authenticated token:

```typescript
if (callerAgentId !== authenticatedIdentity.agent_id) {
  throw new Error(`Identity mismatch: authenticated as "X" but tool called with agent_id "Y"`)
}
```

This prevents one agent from making calls on behalf of another by simply supplying a different `agent_id` string.

### `enforceClearance(requiredLevel)`

Called on audit-log tools (`read_audit_log`, `verify_audit_chain`) which require clearance level 3:

```typescript
if (authenticatedIdentity.clearance_level < requiredLevel) {
  throw new Error(`Clearance denied: ${agent_id} has clearance N, requires M`)
}
```

### Unrestricted Mode

When `AI_OFFICE_AGENT_TOKEN` is absent or invalid (Leader sessions, development), `authEnabled = false` and both enforcement functions return immediately without checking. This is intentional: the Leader runs in the user's Claude Code session under the user's own authority, not under an agent identity.

---

## 5. Audit Trail

The audit log is a hash-chained ledger stored in the `audit_log` table of `coordination.db`.

### Schema

```sql
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT    NOT NULL DEFAULT (datetime('now')),
  agent_id   TEXT    NOT NULL,
  trace_id   TEXT    NOT NULL DEFAULT '',
  action     TEXT    NOT NULL,
  detail     TEXT    NOT NULL DEFAULT '',
  prev_hash  TEXT    NOT NULL DEFAULT '',   -- hash of the preceding row
  hash       TEXT    NOT NULL               -- SHA-256 of (prev_hash + record)
);
```

### Append Logic (`appendAudit`)

```
record = JSON({ agentId, traceId, action, detail, prevHash, timestamp })
hash   = SHA-256( prevHash + record )

INSERT INTO audit_log (agent_id, trace_id, action, detail, prev_hash, hash)
```

The chain begins at the `genesis` sentinel. `initAuditChain` reads the most recent hash from the DB on server startup to resume a live chain. In-memory `lastAuditHash` is updated after every insert, so hash chaining remains consistent within a session even without database round-trips.

### Tamper Detection (`verify_audit_chain`)

The `verify_audit_chain` MCP tool (clearance 3 required) reads all rows in `id` order and recomputes each hash:

```
for each row N:
  expected = SHA-256(row[N-1].hash + JSON(row[N fields]))
  if expected != row[N].hash → chain broken at row N
```

Any gap, deletion, or modification of a row breaks all subsequent hashes, making tampering detectable without a separate signature key.

### Access Control

- `read_audit_log` — requires clearance 3; filtered by `trace_id`, `agent_id`, or row limit.
- `verify_audit_chain` — requires clearance 3; only the Leader (unrestricted mode) or a clearance-3 agent can verify.

---

## 6. Role-Based Access Control

### Clearance Levels

| Level | Label | Meaning |
|---|---|---|
| 0 | PUBLIC | No access to sensitive channels or data |
| 1 | INTERNAL | Internal operational data; standard worker default |
| 2 | CONFIDENTIAL | Department confidential channels; senior roles |
| 3 | RESTRICTED | Full access; Leader and system agents only |

Clearance is set in the role template YAML and embedded in the identity token at issuance time. It cannot be changed by the agent at runtime.

### Scope Patterns

Scopes follow the format `{action}:{resource_type}:{target}`:

```
write:discord:general          → write to #general only
write:discord:dept-*           → write to any dept- channel
write:discord:*                → write to all channels (Leader/system only)
read:discord:*                 → read from all channels
```

Scopes are additive (all grants combine), but denied scopes override all grants. The `denied_scopes` field in a role template acts as a permanent blocklist enforced at the OutputGate before any positive scope is evaluated.

### Unknown Agent Default

Any `agent_id` that does not match a known role template returns a minimal profile:

```typescript
{
  clearance_level: 0,
  scopes: [],
  denied_scopes: ["write:discord:*"],
}
```

This ensures a fabricated or mistyped agent ID has no write access rather than inheriting a permissive default.

---

## 7. Threat Mitigations

### Prompt Injection (Challenge #26)

**Risk**: A malicious user embeds instructions in a Discord message that cause the Leader to execute unintended actions or forward raw instructions to workers.

**Mitigation**:
- The Leader is instructed in `agents/leader/CLAUDE.md` to never forward raw user messages to workers. All task handoffs use the structured JSON schema (`task_handoff_json`), which contains parsed fields (`objective`, `constraints`, `expected_output`) rather than user text.
- Workers are instructed to treat `objective` and `constraints` as data, not as executable instructions. Anomalies are reported via `report_anomaly`.
- The structured schema creates a firewall: user-controlled text cannot traverse the Leader→Worker boundary as an instruction.

### Agent Impersonation (Challenge #29)

**Risk**: A rogue process claims to be a legitimate agent and calls coordination tools with a different agent's `agent_id`.

**Mitigation**:
- Every coordination tool that mutates state calls `enforceIdentity(callerAgentId)`, which compares the parameter against the token-authenticated identity. A mismatch throws and the call fails.
- Identity tokens are signed with HMAC-SHA256 using a session key that only the orchestrator process reads from disk. A rogue process cannot forge a valid token without the session key.
- Token revocation is checked on every `validateToken` call, so a stopped worker's token cannot be reused even if captured.

### Data Exfiltration (Challenge #27)

**Risk**: A worker agent leaks RESTRICTED or CONFIDENTIAL data to a public Discord channel.

**Mitigation**:
- OutputGate Check 4 scans message content for `[RESTRICTED]`, `[CONFIDENTIAL]`, and `[INTERNAL]` markers and blocks posting if the agent's clearance is insufficient.
- OutputGate Check 3 prevents low-clearance agents from writing to `audit-log` (clearance 3) and `*-confidential` channels (clearance 2) regardless of content.
- OutputGate Check 1 allows role templates to declare hard `denied_scopes`, permanently blocking a role from writing to sensitive channels even if given a broad scope grant.
- Workers' scopes are declared in role templates; they cannot self-grant wider scopes. Scope escalation requires editing the role template YAML, which is outside the agent's write boundary.

### Cross-Session Token Replay

**Risk**: An attacker saves a valid token from a previous session and replays it after the orchestrator restarts.

**Mitigation**:
- Every `orchestrator init` generates a new session key and clears the revocation list. The new session ID is different from any prior session.
- `validateToken` checks `payload.session_id !== getSessionId()` and rejects cross-session tokens before expiry is even evaluated.

### Audit Log Tampering

**Risk**: An attacker or compromised process deletes or alters audit records to hide actions.

**Mitigation**:
- Hash chaining means any deletion or modification of a row invalidates all subsequent hashes. `verify_audit_chain` detects this in O(N) time.
- Appending false entries would require recomputing the entire chain from the insertion point forward, which requires the `sha256` of all prior records — detectable if a trusted snapshot of the chain head exists externally.
- Write access to `read_audit_log` and `verify_audit_chain` is restricted to clearance level 3. Workers at lower clearance cannot read the audit log at all.
