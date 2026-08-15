# Security model

## Trust boundaries

The DSH host and installed plugin code are trusted same-process components. User/model content, Codex stdout/stderr, App Server server requests, dynamic-tool arguments, and persisted sidecar files are untrusted at their boundaries. The official Codex CLI owns authentication, remote requests, Codex-native tools, MCP configuration, and Codex sandbox enforcement. The DSH tool runtime owns `dsh.*` validation, policy, approval, execution, and cancellation.

The plugin does not read, copy, log, export, or modify Codex authentication files. It does not implement OAuth or token refresh, accept backend URLs or Authorization headers, call private ChatGPT endpoints, or expose App Server on a network socket.

## Controls

- Process launch uses a fixed executable/argv tuple. Prompt text is written only to JSONL stdin. POSIX uses a detached process group; Windows uses a fixed `cmd.exe` tuple only for `.cmd` launchers and `taskkill /t` for tree disposal.
- Only a small environment allowlist is inherited. Sensitive values are never enumerated or logged.
- Cwd must be absolute and resumed threads must return the expected cwd. Durable records keep only a one-way cwd fingerprint.
- Stderr and surfaced App Server diagnostics are secret-pattern-redacted and byte-bounded. Incoming and outgoing JSONL frames are byte-bounded and runtime-validated.
- Request, initialize, active-turn idle, interrupt, and dispose paths have timeouts. A turn that ignores interruption forces process-tree disposal and exact-thread reconnection. Spawn errors and premature exits settle pending work.
- Every notification/request is correlated to the sole active thread and turn. Cross-thread traffic is ignored; unknown requests fail closed.
- Correlated Codex execution items are persisted in the DSH Session, including tool arguments, command output, file diffs, MCP results, and reviewed intermediate updates. Session storage must therefore be protected to the same degree as the native Codex rollout.
- Sandbox policy is explicit on every turn. Network defaults off. Missing approval/question capabilities decline instead of granting.
- DSH prompt text is sent only as `developerInstructions`; the bridge never replaces Codex base instructions. Dynamic tools use a fixed `dsh` namespace and retain the App Server `callId` unchanged. Invalid namespaces, names, routes, or response content fail closed.
- Bindings are versioned, validated, and atomically replaced. A missing or unverifiable binding prevents resume. The only replacement-on-resume path requires both App Server's exact missing-rollout error and a strictly blank persisted DSH session; lineage, input, turn, or unknown events fail closed.

## Approval behavior

Command and file approvals use the public DSH approval service and accept only its `allowed-once` result. Permission grants echo only the requested profile and only for the current turn after the same one-shot approval. Cancellation becomes cancel/decline. User questions use the public question service; absence, cancellation, or provider failure returns no answers. MCP elicitation is always declined in this release.

DSH dynamic tools do not receive a second Codex approval grant. They run through the DSH tool runtime, whose pre-execute guards and approval service are the sole authority for that path. The active DSH turn abort signal is passed into execution; started cooperative work is drained by the DSH runtime, while Codex interruption and process recovery remain independently bounded. Codex built-in approvals never authorize a DSH tool, and a DSH approval never authorizes a Codex built-in tool.

The approval service owns its standard durable approval audit events. The rc.6 question service does not expose an equivalent durable question audit pair. Secret or explicitly nonblocking questions are declined without invoking a provider; legacy auto-resolution deadlines are propagated as cancellation. No unattended path returns an approval grant.

## Residual risks

- `danger-full-access` intentionally removes Codex filesystem isolation and should be reserved for already trusted workspaces.
- A malicious or compromised Codex executable runs with the inherited host identity. Configure `command` only to a trusted official installation.
- Frame limits bound one JSONL record, not total legitimate output over a long turn. Request deadlines, the active-turn idle watchdog, and cancellation are the operational bounds.
- A long valid turn may produce many individually bounded trajectory events. The frame limit and watchdog bound transport behavior, while operators remain responsible for sizing and protecting Session persistence.
- Host-local process ownership may be inconsistent with a profile whose other subprocess capabilities execute remotely. Do not use this bundle unless the chosen host boundary is intentional.
- App Server dynamic tools are experimental. A Cordis package mounted during an active native turn is not visible to that turn; the next turn refreshes the snapshot by exact resume.

## OpenAI account and data terms

The bridge uses only the user-installed official Codex CLI and public App Server protocol. It does not extract or relay credentials, substitute an API key for a ChatGPT subscription, share an account, bypass usage limits, or call private ChatGPT endpoints. DSH persona text, tool schemas, tool arguments, tool results, and session inputs sent through Codex are data shared with the user's Codex/OpenAI service and are governed by the terms, privacy policy, workspace controls, and data controls applicable to that signed-in account. Operators must not register DSH tools or prompts that disclose data they are not authorized to send to Codex.

Protocol and account-policy references: [Codex App Server](https://developers.openai.com/codex/app-server) and [Codex usage and data controls](https://help.openai.com/en/articles/11369540-codex-and-chatgpt-plan-usage-limits).

## Release review checklist

Before each compatible-version update, review command construction, environment inheritance, cwd verification, cross-session routing, approval defaults, secret redaction, frame/output bounds, process-tree termination, cancellation races, sidecar validation, official generated protocol changes, dependency audit, Reforge results, and tarball contents.
