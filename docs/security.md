# Security model

## Trust boundaries

The DSH host and installed plugin code are trusted same-process components. User/model content, Codex stdout/stderr, App Server server requests, and persisted sidecar files are untrusted at their boundaries. The official Codex CLI owns authentication, remote requests, tools, MCP configuration, and sandbox enforcement.

The plugin does not read, copy, log, export, or modify Codex authentication files. It does not implement OAuth or token refresh, accept backend URLs or Authorization headers, call private ChatGPT endpoints, or expose App Server on a network socket.

## Controls

- Process launch uses a fixed executable/argv tuple. Prompt text is written only to JSONL stdin. POSIX uses a detached process group; Windows uses a fixed `cmd.exe` tuple only for `.cmd` launchers and `taskkill /t` for tree disposal.
- Only a small environment allowlist is inherited. Sensitive values are never enumerated or logged.
- Cwd must be absolute and resumed threads must return the expected cwd. Durable records keep only a one-way cwd fingerprint.
- Stderr is secret-pattern-redacted and byte-bounded. JSONL frames are byte-bounded and runtime-validated.
- Request, initialize, interrupt, and dispose paths have timeouts. Spawn errors and premature exits settle pending work.
- Every notification/request is correlated to the sole active thread and turn. Cross-thread traffic is ignored; unknown requests fail closed.
- Sandbox policy is explicit on every turn. Network defaults off. Missing approval/question capabilities decline instead of granting.
- Bindings are versioned, validated, and atomically replaced. A missing or unverifiable binding prevents resume.

## Approval behavior

Command and file approvals use the public DSH approval service and accept only its `allowed-once` result. Permission grants echo only the requested profile and only for the current turn after the same one-shot approval. Cancellation becomes cancel/decline. User questions use the public question service; absence, cancellation, or provider failure returns no answers. MCP elicitation is always declined in this release.

The DSH services own their standard durable approval/question audit events. No unattended path returns an approval grant.

## Residual risks

- `danger-full-access` intentionally removes Codex filesystem isolation and should be reserved for already trusted workspaces.
- A malicious or compromised Codex executable runs with the inherited host identity. Configure `command` only to a trusted official installation.
- Frame limits bound one JSONL record, not total legitimate output over a long turn. Request timeouts and cancellation are the operational bounds.
- DSH rc.6 cannot publicly register plugin Session event types, so native command/file details are not yet independently auditable from the DSH log. See the design limitation.
- Host-local process ownership may be inconsistent with a profile whose other subprocess capabilities execute remotely. Do not use this bundle unless the chosen host boundary is intentional.

## Release review checklist

Before each compatible-version update, review command construction, environment inheritance, cwd verification, cross-session routing, approval defaults, secret redaction, frame/output bounds, process-tree termination, cancellation races, sidecar validation, official generated protocol changes, dependency audit, Reforge results, and tarball contents.
