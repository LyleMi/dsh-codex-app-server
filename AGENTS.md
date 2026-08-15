# Repository Guidelines

## Project Structure & Module Organization

Production TypeScript lives in `src/`. Top-level modules cover agent lifecycle, configuration, process management, and DSH bindings; JSONL transport and App Server handling are under `src/wire/`, while session projection is under `src/projection/`. Tests are flat `tests/*.spec.ts` files, with the opt-in real Codex smoke test at `tests/real-codex.e2e.ts`. Protocol recordings belong in `tests/fixtures/app-server/` and must be scrubbed of credentials, account data, tokens, and home paths. Design and security rationale live in `docs/`; maintenance scripts live in `scripts/`. Generated `lib/` and `coverage/` output must not be committed.

## Build, Test, and Development Commands

Use Node.js 22.19+ and pnpm 10.15.0.

- `corepack enable && pnpm install --frozen-lockfile` installs the locked toolchain.
- `pnpm build` compiles `src/` into `lib/`.
- `pnpm test` runs the Vitest suite once; `pnpm test:coverage` enforces coverage.
- `pnpm typecheck`, `pnpm lint`, and `pnpm format:check` run focused static checks.
- `pnpm protocol:check` verifies the installed Codex App Server contract against the reviewed fixture.
- `pnpm check` runs the complete merge/release gate, including Reforge and package validation.
- `RUN_REAL_CODEX=1 pnpm test:e2e` runs the credential-isolated real CLI smoke test when Codex is available.

## Coding Style & Naming Conventions

Follow Prettier output: two-space indentation, single quotes, and no semicolons. Keep TypeScript strict and use `import type` for type-only imports. Name files with lowercase descriptive nouns (for example, `wire/transport.ts`); use PascalCase for types/classes and camelCase for functions and variables. Preserve explicit ownership, bounded resources, and fail-closed protocol behavior.

## Testing Guidelines

Use Vitest and name unit/integration tests `tests/<area>.spec.ts`. Add regression coverage beside the affected boundary. V8 thresholds are 80% for lines, functions, and statements, and 70% for branches. Protocol changes require `pnpm protocol:check`, sanitized fixtures, compatibility documentation, and the real smoke test when credentials are safely available.

## Commit & Pull Request Guidelines

Use Conventional Commits: `<type>(<scope>): <subject>`, for example `fix(wire): reject oversized JSONL frames`. Use lowercase types such as `feat`, `fix`, `refactor`, `test`, `docs`, `build`, and `chore`; choose a short repository area for the optional scope. Write the subject in imperative mood, without a trailing period, and mark breaking changes with `!` plus a `BREAKING CHANGE:` footer. Keep scaffolding, behavior, tests, and release changes separate when useful for rollback. This is a personal project: commit and push directly to `master` when publishing changes; do not create pull requests unless explicitly requested. In handoffs, note checks run and any platform or credential limitations. Report vulnerabilities through `SECURITY.md`, never a public issue.
