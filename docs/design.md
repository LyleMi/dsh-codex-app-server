# Design

## Boundary and ownership

The package is a Cordis service and DSH `AgentFactory`. It also registers a catalog-only LLM adapter so DSH can display the signed-in Codex account's models; the adapter never carries conversation traffic. The bundle layer disables the base `agent-loop` entry and inserts this provider while retaining the rest of the selected profile.

```text
DSH Web / ACP / JSON-RPC / headless
                |
     Codex model catalog + selector
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

The sidecar store uses a SHA-256 filename derived from the DSH session ID. Each versioned JSON record contains the exact session ID, Codex thread ID, cwd fingerprint, observed CLI version, and `ephemeral: false`. Writes use a same-directory temporary file followed by atomic rename. Resume rejects missing records, cwd changes, malformed data, and ephemeral bindings. One narrow lifecycle exception handles threads created before their first turn: if App Server explicitly reports that the bound thread has no rollout and the persisted DSH session has no lineage, input, or turn events, the factory starts a fresh thread and atomically replaces the binding. Sessions with content never take this path, and a failed publish restores the prior binding.

Forks do not resume the parent's thread. A fresh thread receives a one-time, 64 KiB-bounded transcript made only from standard seeded text/reasoning messages. Unsupported blocks are omitted rather than mistranslated. The seed is cleared before the first native request so an ambiguous transport failure cannot duplicate it.

## Agent and Session semantics

The DSH Inbox remains the durable input queue. `followup` targets the next turn, `inject` targets the next step without waking, and native `steer` claims/logs input before sending it to the correlated active turn. Steering and interrupt requests that arrive before the turn ID wait for the `turn/start` boundary. Cancellation cannot mix later waking input into the aborted turn.

Every normal turn records standard boundaries, claimed user messages, live assistant chunks, completed assistant messages with Codex provenance and usage, and the final turn reason. Text and reasoning deltas are appended as notifications arrive rather than reconstructed after `turn/completed`. Context-window exhaustion maps to `max-tokens`; interruption maps to an aborted turn. Commentary and final agent messages remain ordered text blocks. Reasoning is a standard reasoning block. Durable image references are resolved through the attachment service and translated to App Server data-URL image inputs; unsupported content blocks fail explicitly.

The selector catalog is discovered through the official paginated `model/list` method and cached for the plugin lifetime. Hidden models are omitted; model descriptions, input modalities, supported reasoning efforts, and the provider default effort are projected into DSH metadata. DSH's agent-scoped selection hooks snapshot the chosen model before each request, and that exact snapshot is forwarded to native thread and turn calls.

Before connection and each native turn, the driver assembles the agent-scoped DSH system prompt, runtime-context snapshot, and tool schemas. It passes prompt sections through App Server `developerInstructions`, preserves the runtime context as a durable DSH user message, and exposes tools as one `dsh` dynamic-tool namespace. A changed prompt/tool fingerprint disposes the idle process and exactly resumes the same thread with the new snapshot before work continues.

Codex owns built-in tool dispatch. DSH owns calls in the `dsh` namespace: `item/tool/call` is correlated to the sole active thread/turn and dispatched through `ctx.tools.execute` with the unchanged Codex `callId`, current agent, arguments, and abort signal. The returned DSH content becomes the App Server response and then the completed Codex dynamic-tool item, so the Codex rollout and DSH projection retain the model-visible result. Tool names that violate the App Server dynamic-tool identifier grammar fail snapshot assembly instead of being renamed ambiguously.

The projection records every Codex non-message item with the standard DSH trajectory sequence: an assistant `tool-call` block, `tool/call`, then `tool/result`. Tool names are namespaced as `codex.<item-type>`; the started item is retained as raw arguments, while the completed item and all reviewed intermediate updates are retained in result metadata. This remains the transport-level audit even when the dynamic call was executed by DSH.

Codex owns its rollout, built-in tools, MCP/apps, native collaboration/delegation, Codex skill loading, and native compaction. DSH owns its scoped prompt, `dsh.*` tools, skill/subagent/workflow implementations, Cordis dynamic packages, and the DSH tool policy pipeline. The bundle disables the DSH surface-only compact command and registers a Codex-backed `/compact` that waits for `thread/compact/start` lifecycle completion. Cordis changes made during a native turn are applied on the next native turn because App Server has no in-turn dynamic-tool replacement method.

`turn/plan/updated` is also projected into the standard last-write-wins `todo/write` state. Plan explanations and turn diffs are retained as replayable Codex-provenance reasoning messages. Low-level duplicated provider frames are not copied into the Session; the canonical App Server item lifecycle remains the trajectory authority.

## Protocol boundary

The client enables the experimental App Server API and supports initialize/initialized, thread start/resume/compact, turn start/steer/interrupt, correlated completion, dynamic tool calls, item lifecycle/deltas, token usage, approval, permission, user question, and conservative MCP elicitation responses. Correlated lifecycle, item, delta, usage, plan, diff, and diagnostic traffic refreshes the active-turn watchdog. An idle turn is interrupted and, after a bounded grace period, its process is disposed; the runtime then reconnects by exactly resuming the existing thread.

Runtime validation is intentionally minimal and extension-tolerant: required routing and lifecycle fields are checked while unknown item fields survive. Current Codex may omit the JSON-RPC `jsonrpc` field, so absence is accepted; an explicitly incompatible version is rejected. Frames are byte-bounded. Unknown server requests fail and reject the active turn. Unknown notifications are either surfaced to the callback and ignored or fail the turn according to configuration.

Fixtures lock the verified Codex `0.147.0` behavior, including early notifications and cross-thread isolation. `pnpm protocol:check` invokes the installed CLI's official TypeScript generator and compares both the complete generated contract and request/notification method-set hashes with the reviewed baseline. A version upgrade must review the generated diff, update the snapshot, and run the real smoke before updating the compatibility table.
