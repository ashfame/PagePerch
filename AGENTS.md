# PagePerch Agent Instructions

## Scope

- Implement the Chrome 114+ Manifest V3 side-panel extension described by `plan.md` and `byos_integrations.md`.
- Treat `docs/ORCHESTRATOR_STATE.md`, `docs/TASK_BACKLOG.md`, `docs/ROADMAP.md`, and `docs/COMPLIANCE_MATRIX.md` as the durable implementation state.
- This repository is explicitly exempt from the dedicated-worktree rules in `~/.codex/AGENTS.md`: work directly in the primary checkout at `/home/ashfame/git/pageperch`, commit directly to the primary `trunk` branch, and do not create a task branch or dedicated worktree unless the user explicitly requests one.

## Release Approval Workflow

- For every product change, assign the prospective next `0.1.x` version, run the complete gate, and commit the exact candidate locally on `trunk` before packaging it.
- Build the manual-test ZIP from that exact committed state and give the user its local download link and SHA-256 checksum; do not create a tag or push the commit, branch, or tag before the user explicitly approves the candidate.
- If the user requests changes, make another local commit and regenerate the candidate ZIP; only after explicit approval create the annotated `v0.1.x` minor-update tag on the exact approved commit and atomically push `trunk` and the tag.

## Repository Conventions

- Use Node.js 24.18.0 from `.nvmrc`, npm, strict TypeScript, React 18, and Vite.
- Keep source under `src/`, production-package helpers under `scripts/`, browser tests under `e2e/`, and test helpers next to the relevant source or under `test/`.
- Use `chrome.storage.local` for durable extension data and `chrome.storage.session` only for transient OAuth PKCE state.
- Keep every Markdown paragraph and list item on one source line; do not hard-wrap prose.
- Do not add a project license until the GPL compatibility decision recorded in the plan is resolved.
- Never commit credentials, OAuth tokens, generated build output, coverage output, Playwright artifacts, dependency caches, or environment files.

## Commands

- Load the pinned toolchain with `source /home/ashfame/.nvm/nvm.sh && nvm use`.
- Install reproducibly with `npm ci`.
- Run the complete local gate with `npm run check`.
- Run individual gates with `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run audit:csp`, and `npm run test:e2e`.

## Architecture Boundaries

- UI code may call application services but must not access S3 transport details.
- `PageIdentityService` owns canonicalization, exclusions, hashing, root detection, and identity migrations.
- `NoteRepository` and `SettingsRepository` are storage-neutral interfaces; Chrome adapters own extension-storage serialization.
- `NoteService` owns validation, content hashing, local-first persistence, logical deletion, and origin indexes.
- `SyncEngine` owns reconciliation, durable queueing, credential refresh, and sync status.
- `S3ReplicaRepository` receives endpoint, region, bucket, and temporary credentials through injection and must not read UI state directly.
- Keep short product-rationale comments beside canonicalization, migration, timestamp conflict, and tombstone logic.

## Worker Boundaries

- A worker receives one bounded assignment and may edit only the explicitly allowed files.
- Workers do not choose the next task, broaden scope, update orchestration state unless assigned, commit, push, or mutate GitHub state.
- Reviewers inspect only the assigned diff, tests, architecture fit, and risks; they do not implement fixes unless explicitly reassigned.
- The primary orchestrator alone updates durable state, accepts work, commits, and pushes.

## Quality

- Add focused tests for every new public behavior and every fixed defect.
- Keep local persistence authoritative and surface remote failures without turning successful local saves into user-visible save failures.
- Preserve deterministic output, stable record formats, idempotent retries, and reproducible builds.
- Run the narrowest relevant checks during implementation and the complete available gate before each accepted implementation commit.
- Record any unavailable or failing check with its exact cause in `docs/ORCHESTRATOR_STATE.md`.
