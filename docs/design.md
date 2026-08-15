# Design

## Boundary and ownership

The package is a Cordis service and DSH `AgentFactory`, not an LLM adapter. The bundle layer disables the base `agent-loop` entry and inserts this provider while retaining the rest of the selected profile.

```text
DSH Web / ACP / JSON-RPC / headless
                |
          AgentRegistry factory
                |
    CodexAgent + DSH Session log
                |
      CodexRuntime (one owner)
                |
  CodexProcess -- JSONL -- AppServerClient
                |
        official Codex CLI
```

One Agent owns one process and one non-ephemeral native thread. `CodexRuntime` is the sole process/client/thread owner. The factory retains every disposer so provider unload can stop admission, abort unpublished work, interrupt active turns, drain drivers, terminate process trees, and unregister state.

## Publication transaction

Create and resume use the same transaction:

1. Reserve the session identity and validate owner/factory liveness.
2. Prepare an unpublished DSH Session and Agent scope.
3. Await caller setup and invoke its synchronous setup commit.
4. Initialize Codex, then start or exactly resume a thread.
5. For a new thread, atomically persist the session/thread/cwd binding.
6. Recheck cancellation and publish Session, Agent, and `agent/session-start` in order.
7. On any failure, unwind process, scope, registry entries, and newly written binding in reverse order.

Concurrent create/resume of the same identity is rejected before a second process launches. Owner disposal and factory unload participate in the same abort signal. The handle holder and factory are the only structural teardown owners.

## Thread binding and fork policy

The sidecar store uses a SHA-256 filename derived from the DSH session ID. Each versioned JSON record contains the exact session ID, Codex thread ID, cwd fingerprint, observed CLI version, and `ephemeral: false`. Writes use a same-directory temporary file followed by atomic rename. Resume rejects missing records, cwd changes, malformed data, and ephemeral bindings; it never silently starts a replacement thread.

Forks do not resume the parent's thread. A fresh thread receives a one-time, 64 KiB-bounded transcript made only from standard seeded text/reasoning messages. Unsupported blocks are omitted rather than mistranslated. The seed is cleared before the first native request so an ambiguous transport failure cannot duplicate it.

## Agent and Session semantics

The DSH Inbox remains the durable input queue. `followup` targets the next turn, `inject` targets the next step without waking, and native `steer` claims/logs input before sending it to the correlated active turn. Steering and interrupt requests that arrive before the turn ID wait for the `turn/start` boundary. Cancellation cannot mix later waking input into the aborted turn.

Every normal turn records standard boundaries, claimed user messages, assistant chunks, the final assistant message with Codex provenance and usage, and the final turn reason. Context-window exhaustion maps to `max-tokens`; interruption maps to an aborted turn. Commentary and final agent messages remain ordered text blocks. Reasoning is a standard reasoning block. Durable image references are resolved through the attachment service and translated to App Server data-URL image inputs; unsupported content blocks fail explicitly.

Codex command/file items are not DSH tool calls: DSH did not execute them and cannot satisfy DSH call/result semantics. The desired representation is versioned plugin-owned Session events. DSH `0.1.0-rc.6` has no public downstream event-registration seam, so this beta deliberately omits those events rather than importing private modules or mutating runtime allowlists. This is the principal upstream compatibility seam required before a stable release.

## Protocol boundary

The client supports initialize/initialized, thread start/resume, turn start/steer/interrupt, correlated completion, item lifecycle/deltas, token usage, approval, permission, user question, and conservative MCP elicitation responses. Correlated lifecycle, item, delta, usage, plan, diff, and diagnostic traffic refreshes the active-turn watchdog. An idle turn is interrupted and, after a bounded grace period, its process is disposed; the runtime then reconnects by exactly resuming the existing thread.

Runtime validation is intentionally minimal and extension-tolerant: required routing and lifecycle fields are checked while unknown item fields survive. Current Codex may omit the JSON-RPC `jsonrpc` field, so absence is accepted; an explicitly incompatible version is rejected. Frames are byte-bounded. Unknown server requests fail and reject the active turn. Unknown notifications are either surfaced to the callback and ignored or fail the turn according to configuration.

Fixtures lock the verified Codex `0.147.0` behavior, including early notifications and cross-thread isolation. `pnpm protocol:check` invokes the installed CLI's official TypeScript generator and compares both the complete generated contract and request/notification method-set hashes with the reviewed baseline. A version upgrade must review the generated diff, update the snapshot, and run the real smoke before updating the compatibility table.
