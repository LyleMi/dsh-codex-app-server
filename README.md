# dsh-codex-app-server

[简体中文](README.zh-CN.md)

Experimental DeepSeek Harness bundle that runs the official Codex CLI as the DSH `AgentFactory` through `codex app-server --stdio`.

This package does not read Codex credentials, exchange ChatGPT subscriptions for API keys, or call private ChatGPT endpoints. Authentication, model access, quotas, tools, MCP, and sandbox execution remain owned by the user-installed Codex CLI.

> Status: `0.1.0-beta.0`. Use a dedicated DSH profile and review the limitations below before relying on it for important work. This project is not endorsed by DeepSeek or OpenAI.

## Compatibility

| Component                 | Verified baseline                | Policy                                                          |
| ------------------------- | -------------------------------- | --------------------------------------------------------------- |
| Node.js                   | 22.22.3                          | `>=22.19.0`                                                     |
| DeepSeek Harness packages | `0.1.0-rc.6`                     | peer range `^0.1.0-rc.6`                                        |
| Cordis                    | `4.0.1`                          | peer range `^4.0.1`                                             |
| Codex CLI                 | `0.147.0`                        | handshake and protocol fixtures are tested against this version |
| Reforge                   | `0.2.0`                          | CI verifies the pinned source revision reports this version     |
| Platforms                 | Ubuntu, Windows protocol/argv CI | real local smoke verified on Ubuntu                             |

App Server is still evolving. Unknown server requests fail closed. A Codex upgrade can therefore stop a turn instead of silently accepting changed semantics.

## Prerequisites and install

Install and sign in to the official Codex CLI first. Confirm that `codex` (`codex.cmd` on Windows) works in the same host execution world as DSH. The plugin never opens or copies `~/.codex/auth.json`.

The DSH CLI package is `@deepseek-ai/dsh`; the unscoped npm package named `dsh` is unrelated. To install the plugin and launch the web profile directly from the registry without cloning or building this repository, use either of the following options.

One-off `npx`:

```sh
npx --yes --package=@deepseek-ai/dsh@0.1.0-rc.6 -- dsh plugin --profile web add dsh-codex-app-server
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web
```

Global npm installation:

```sh
npm install --global @deepseek-ai/dsh@0.1.0-rc.6
dsh plugin --profile web add dsh-codex-app-server
dsh web
```

The profile is persisted under the normal DSH home directory, so later launches do not reinstall the plugin. To inspect the composed configuration, replace `web` in the launch command with `--profile web --dump-config`.

Local development installation:

```sh
pnpm install
pnpm build
npx --yes --package=@deepseek-ai/dsh@0.1.0-rc.6 -- dsh plugin --profile web add link:/absolute/path/to/dsh-codex-app-server
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 --profile web --dump-config
```

The resulting configuration must show `agent-loop` disabled and one enabled `dsh-codex-app-server` row. The patch preserves the profile's session persistence, UI, ACP/JSON-RPC, filesystem, subprocess, permission, and sandbox providers.

## Configuration

Configure the inserted `dsh-codex-app-server` row through the normal Cordis profile overlay.

| Field                       | Default                            | Meaning                                                              |
| --------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `command`                   | `codex` / `codex.cmd`              | Official Codex executable; Windows uses the npm `.cmd` shim          |
| `args`                      | `[]`                               | Only `--strict-config`, `--enable=…`, and `--disable=…` are accepted |
| `model`                     | Codex default                      | Optional model override                                              |
| `reasoningEffort`           | Codex default                      | `minimal`, `low`, `medium`, `high`, or `xhigh`                       |
| `sandboxMode`               | `workspace-write`                  | `read-only`, `workspace-write`, or `danger-full-access`              |
| `approvalPolicy`            | `on-request`                       | `untrusted`, `on-request`, or `never`                                |
| `networkAccess`             | `false`                            | Per-turn sandbox network access                                      |
| `startupTimeoutMs`          | `15000`                            | Initialize handshake timeout                                         |
| `requestIdleTimeoutMs`      | `120000`                           | JSON-RPC request timeout                                             |
| `turnIdleTimeoutMs`         | `120000`                           | Idle turn deadline before interrupt and process recovery             |
| `interruptGraceMs`          | `3000`                             | Grace after interrupt before process recovery                        |
| `disposeGraceMs`            | `5000`                             | Grace before forced process-tree termination                         |
| `stderrMaxBytes`            | `65536`                            | Bounded, redacted diagnostic buffer                                  |
| `protocolMaxBytes`          | `8388608`                          | Maximum JSONL frame size                                             |
| `unknownNotificationPolicy` | `ignore`                           | `ignore` or fail the active turn with `fail-turn`                    |
| `bindingRoot`               | `~/.dsh/codex-app-server-bindings` | Plugin-owned durable thread mapping directory                        |

User prompts never enter process argv. The default sandbox has no network access. Missing DSH approval or question providers produce a conservative decline/empty answer. Secret and explicitly nonblocking Codex questions also return no answer because DSH rc.6 has no matching safe interaction seam.

## Lifecycle and persistence

Each live DSH Agent owns one Codex process and one non-ephemeral Codex thread. Creation is unpublished until setup, connection, and durable binding complete. Rollback reverses registry/session/process ownership. Resume requires DSH session persistence plus an exact plugin-owned `{session, thread, cwd fingerprint}` binding; a missing or mismatched binding fails instead of opening a context-free thread.

An active turn must continue producing correlated App Server activity. When it remains idle past `turnIdleTimeoutMs`, the driver requests an interrupt; if completion still does not arrive within `interruptGraceMs`, it closes the transport, terminates the process tree, and reconnects by resuming the exact durable thread on the next turn. Explicit interrupts use the same bounded recovery path. App Server warnings, deprecations, configuration warnings, model reroutes, and terminal turn errors are surfaced through the plugin logger with bounded secret redaction.

A DSH fork always starts a new Codex thread. Its first turn receives at most 64 KiB of text/reasoning projected from the fork seed. Later turns rely on the new native thread and do not repeat the seed.

## Development and smoke tests

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Reforge 0.2.0 and coverage are required gates. `pnpm check` also verifies formatting, lint, types, tests, source maps, build output, and package contents. Run `pnpm protocol:check` whenever the installed Codex baseline changes; it compares the complete generated App Server TypeScript contract and request/notification method sets against the reviewed `0.147.0` snapshot.

The real smoke is opt-in and does not inspect credential files:

```sh
RUN_REAL_CODEX=1 pnpm test:e2e
```

It uses `approvalPolicy: never`, a read-only/no-network sandbox, a temporary workspace, two context-preserving turns, and an interrupt. It self-skips when Codex is unavailable or the account is not usable.

## Update, uninstall, and rollback

Update the installed plugin with the DSH plugin command for your profile, then inspect `dsh --profile web --dump-config` and run a harmless session. Before changing Codex CLI versions, retain the old binary until the smoke test passes.

Uninstall this bundle with the DSH plugin removal command for the same profile. Removing its patch layer restores the base bundle's original `agent-loop` row; verify the dump before deleting plugin-owned bindings. Binding files contain thread IDs and cwd hashes, not credentials, and can be retained for rollback.

## Known limitations

- DSH `0.1.0-rc.6` does not expose public downstream Session event registration. Codex command/file item detail therefore cannot yet be stored as honest plugin-owned DSH events or projected as native DSH tool calls. It remains in the native Codex thread; user input, reasoning, commentary/final text, usage, and approval audit use public standard DSH events. The public question service does not currently append an equivalent durable question audit pair.
- User image blocks are supported when a DSH attachment store is installed: verified bytes are read by reference and sent as bounded data URLs. Text, reasoning, and images are accepted as input; tool-call and tool-result blocks are rejected instead of being mistranslated.
- Codex tools are not DSH tools. This release deliberately does not pretend otherwise or inject DSH tool schemas into prompts.
- MCP elicitation is declined because there is no complete DSH mapping yet.
- One Agent permits only one active Codex turn. Native steering is serialized onto that turn.
- Host versus remote-sandbox process placement must match where the user's Codex installation and login exist; this package currently owns a local host process.
- Real Codex smoke coverage has been performed on Ubuntu. Windows has CI coverage for argv, protocol, lifecycle, and package behavior, but still needs a credential-isolated real smoke before a stable release.

See [design](docs/design.md), [security model](docs/security.md), [contributing](CONTRIBUTING.md), and [security reporting](SECURITY.md).

## License

Apache-2.0. Users remain responsible for complying with the terms that apply to their Codex/OpenAI and DeepSeek Harness use.
