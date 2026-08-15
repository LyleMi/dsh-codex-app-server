# Contributing

## Development

Use Node.js 22.19 or newer and pnpm 10.15.0. Install from the committed lock file:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` is the local merge/release gate: Prettier, ESLint, Reforge 0.2.0, TypeScript, Vitest, build, and package dry-run must all pass. Reforge warnings are failures; refactor the flagged structure or add meaningful boundary coverage rather than suppressing findings.

Keep changes as focused commits on `master` for this repository's current workflow. Do not include credentials, local bindings, Codex recordings with home paths/account data, generated tarballs, or `lib/` output in commits.

## Protocol changes

When changing the App Server boundary:

1. Record the exact `codex --version` used.
2. Generate the official App Server TypeScript or JSON schema into a temporary directory and compare only the methods this package consumes.
   `pnpm protocol:check` performs the reviewed method-set comparison for the installed baseline and must pass before any snapshot update.
3. Update portable fixtures with tokens, account identifiers, thread identifiers, and home paths removed.
4. Preserve fail-closed behavior for unknown server requests.
5. Run `RUN_REAL_CODEX=1 pnpm test:e2e` with a credential-isolated local account when available.
6. Update the README compatibility table and design notes.

Never solve a DSH public API gap by importing `@deepseek-ai/*/src/*`, mutating a private allowlist, or copying Codex auth state. Document the seam and propose the smallest general upstream API instead.

## Commits and review

Use imperative commit subjects and separate scaffolding, behavior, tests, and release material when that makes rollback clearer. Include the checks run and any platform/credential smoke limitations in the handoff. Security reports must follow [SECURITY.md](SECURITY.md), not a public issue.
