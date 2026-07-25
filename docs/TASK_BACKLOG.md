# Task Backlog

## PP-000 — Bootstrap Durable Project State

- Status: completed
- Priority: P0
- Dependencies: source-input commit
- Spec or plan references: Documentation and Atomic Delivery; master-orchestrator bootstrap workflow
- Acceptance criteria: Project conventions, architecture, roadmap, backlog, compliance, test, security, portability, migration, API, performance, observability, and deployment state are useful and committed; toolchain assumptions are validated.
- Suggested files: `AGENTS.md`, `docs/*.md`
- Test expectations: `git diff --check`; direct review against `plan.md` and `byos_integrations.md`
- Notes: Main-orchestrator-owned task completed before application implementation.

## PP-001 — Scaffold Deterministic MV3 Extension

- Status: completed
- Priority: P0
- Dependencies: PP-000
- Spec or plan references: Architecture and Tooling; plan Commit 2
- Acceptance criteria: Node/npm/Vite/React/strict-TypeScript project builds deterministic side panel, options, and module service-worker entries; manifest permissions and host access are exact; action opens global side panel; supplied logo yields padded 16/32/48/128 icons; baseline accessible automatic-theme surfaces exist; format, lint, typecheck, unit, build, CSP audit, and CI gates pass.
- Suggested files: package/tool configs, `src/`, `scripts/`, `public/manifest.json`, `.github/workflows/ci.yml`
- Test expectations: Unit smoke tests, manifest assertions, production build, CSP/package audit
- Notes: Accepted after independent corrective review and clean main-thread verification. The actual editor and CSS production probe is included in `npm run check`; one native toolbar-host browser case remains an explicit capability skip.

## PP-002 — Implement Canonical Page Identity

- Status: completed
- Priority: P0
- Dependencies: PP-001
- Spec or plan references: Canonical page identity; internal `PageIdentityService`
- Acceptance criteria: Supported schemes, exact-origin semantics, fragment removal, trailing slash preservation, deterministic duplicate query sorting, global and custom exclusions, root detection, SHA-256/base64url keys, and unsupported URLs match the plan.
- Suggested files: `src/domain/`, `src/services/page-identity*`
- Test expectations: Exhaustive table-driven canonicalization and hashing unit tests
- Notes: Accepted after independent review and 84 focused cases; the requested product-rationale comment is present beside canonicalization.

## PP-003A — Implement Versioned Local Repositories

- Status: completed
- Priority: P0
- Dependencies: PP-002
- Spec or plan references: Internal interfaces; Data model; local storage acceptance
- Acceptance criteria: Versioned note/settings domain envelopes, storage-neutral repository interfaces, Chrome local adapters, exact-origin indexing, physical repository CRUD, schema validation/migration, malformed-data preservation, concurrent mutation safety, and large records work under mocked Chrome storage.
- Suggested files: `src/domain/`, `src/repositories/`, `test/`
- Test expectations: Repository tests for defaults/upgrades, CRUD, origin movement/indexing, tombstone retention, malformed data, concurrent updates, isolation from unrelated keys, and large content
- Notes: Accepted after three review cycles and 106 focused cases. Repository `delete` is physical infrastructure only; user clears are logical tombstones owned by PP-003B.

## PP-003B — Implement Local-First Note Service

- Status: completed
- Priority: P0
- Dependencies: PP-003A
- Spec or plan references: Internal interfaces; Data model; Side panel autosave/delete/index semantics
- Acceptance criteria: `NoteService` validates inputs, normalizes and hashes Gutenberg HTML, writes locally before reporting success, skips unchanged content/metadata, generates timestamps/revisions only for actual changes, writes logical tombstones for existing clears, creates no record for untouched clears, and returns recent non-deleted exact-origin indexes.
- Suggested files: `src/services/note*`, domain types, tests
- Test expectations: Deterministic service tests for create/update/unchanged/metadata/title/clear/tombstone/index behavior, injected clock/revision factory, storage failures, and large content
- Notes: Accepted after corrective review and 57 focused service cases. Mutation clocks and revision IDs are injectable; local writes are awaited; same-page mutations are serialized; normalized empty content creates no untouched record, tombstones an existing live record, and leaves an existing tombstone unchanged. Remote synchronization remains PP-007.

## PP-004 — Add Per-Page Editor and Origin Index

- Status: completed
- Priority: P0
- Dependencies: PP-003B
- Spec or plan references: Side panel; editor modes; theme and accessibility requirements
- Acceptance criteria: Active-tab changes remount documents after flushing; cached notes load; Gutenberg is locally bundled with remote APIs and disallowed capabilities disabled; autosave uses 750 ms debounce and explicit states; clearing behavior is correct; roots display a recent exact-origin index; themes, focus, reduced motion, narrow layouts, and link behavior meet the plan.
- Suggested files: `src/side-panel/`, editor adapter, navigation bridge, component tests
- Test expectations: React Testing Library coverage of unsupported/loading/error/editor/index/autosave/theme/mode flows
- Notes: PP-004 is accepted after independent review. A UI-neutral active-page session controller owns current-window routing and flush ordering; narrow Chrome/settings adapters and a StrictMode-safe accessible React shell compose loading, unsupported, error, and keyed supported states; the restricted Gutenberg adapter enforces exact block modes, recursively normalizes stored content to safe local text blocks, captures first edits, blocks unhandled WordPress API network access, remounts on mode changes, and supplies accessible light/dark/narrow/reduced-motion styling; the draft controller concurrently loads cached notes/settings, ignores initialization duplicates, debounces actual changes for 750 ms, serializes local mutations, exposes explicit retryable states, drains accepted drafts before ownership transfer, and coordinates generation-safe navigation flushes; and one injected app-lifetime ownership coordinator atomically registers the real pending-save boundary, interrupts stale startup, preserves failed cleanup for explicit retry, and survives StrictMode or same-realm remounts. The production entry composes the real Chrome repositories, note service, cached draft, editor, and actionable loading/save/error states. The pinned Gutenberg dependency generation is aligned and a packaged 280-pixel supported-page smoke reaches a real editable surface without store-registration errors. Exact-origin roots now also own a revision-coalesced recent-note index that excludes the root/tombstones, survives refresh failures with retained entries, follows relevant local-storage changes, and opens only canonical credential-free HTTP(S) URLs in active new tabs.

## PP-005 — Add Identity Settings and Migrations

- Status: completed
- Priority: P0
- Dependencies: PP-003B, PP-004
- Spec or plan references: Settings page; canonical identity migration requirements
- Acceptance criteria: Exact-origin/name validation and duplicate prevention work; adding exclusions recalculates identities, merges collisions in deterministic Gutenberg documents, and tombstones former keys; removal moves combined notes without attempted splitting; repeated migration is idempotent.
- Suggested files: `src/options/`, `src/services/identity-migration*`, repositories, tests
- Test expectations: Settings component tests and migration unit/integration tests
- Notes: Accepted after independent corrective review. The pure planner handles exactly one normalized exact-origin addition/removal, stacks collision content below escaped original-URL headings in deterministic oldest-first order, preserves a representative URL for later removal, and emits immutable destination/tombstone records. The durable executor verifies provenance and the complete exact-origin inventory, applies destination then tombstone then settings phases behind one shared storage lock, resumes every journal phase on worker startup, and blocks conflicting writes until finalization. The accessible options page exposes editor mode, read-only built-ins, validated custom add/remove controls through the executor, and honest local/BYOS status; editor mode is patched atomically against the latest stored record so stale UI cannot restore old exclusions or credentials.

## PP-006 — Implement BYOS OAuth and Credential Lifecycle

- Status: completed
- Priority: P0
- Dependencies: PP-001, PP-003A
- Spec or plan references: `byos_integrations.md`; BYOS integration; Settings page
- Acceptance criteria: PKCE values use secure randomness; session state survives worker suspension; callback state and errors are validated; public-client token exchange is exact; token expiry is skewed early; S3 credentials and secret exist only in memory; missing build config and reconnect-required states are actionable; disconnect clears only local connection material.
- Suggested files: `src/byos/`, settings repository, options controls, tests
- Test expectations: Deterministic crypto/network mocks covering success, state mismatch, callback/token errors, expiry, missing config, and disconnect
- Notes: PP-006A and PP-006B are independently approved. This is extension-side integration with the established BYOS service, not a server implementation. The client generates S256 PKCE with Web Crypto, persists only the pending verifier/state in `chrome.storage.session`, validates the exact callback and storage-only token response, stores the early-expiring OAuth token through an atomic settings patch, issues protocol credentials through the established BYOS endpoints, and keeps access key/secret/bucket only in a cancellation-safe memory cache. Disconnect resumes any legitimate pending identity migration, invalidates late OAuth/credential completion, clears transient/local connection material, and leaves notes and remote objects untouched. The accessible options UI exposes configuration availability, live token expiry, Connect/Reconnect/Disconnect, refresh recovery, and config-less cleanup without reading protocol credentials or claiming that sync exists before PP-007. Never request identity scopes or persist the S3 secret.

## PP-007 — Implement S3 Replica and Sync Engine

- Status: completed
- Priority: P0
- Dependencies: PP-003B, PP-006
- Spec or plan references: Internal interfaces; Data model reconciliation; BYOS integration
- Acceptance criteria: AWS SDK v3 uses injected endpoint/region/bucket/credentials, SigV4, and path style; records map to deterministic keys; reconcile chooses newest timestamp then revision ID; tombstones overwrite; queue coalesces by key and survives restart; retry backoff is bounded; all required sync triggers and status reporting work.
- Suggested files: `src/sync/`, `src/byos/s3*`, service worker, panel/options integration
- Test expectations: Network-mocked local/remote/retry/expiry/partial-failure/restart/reconnect cases
- Notes: PP-007A, PP-007B, PP-007C1, and PP-007C2 are independently approved. The storage-neutral remote replica contract and extension-side `S3ReplicaRepository` implement only list/get/put over operation-scoped temporary credentials from the existing BYOS client, use the issued bucket with AWS SDK v3 path-style configuration, map records exactly to `pageperch/v1/notes/{pageKey}.json`, paginate and validate untrusted remote data strictly, support established large-note fixtures, return immutable deterministic snapshots, redact failures, and write tombstones without any S3 delete operation. The versioned Chrome-local queue stores only page key, current revision, attempt count, and next-attempt time; coalesces and reconstructs work across restarts; protects newer saves with revision CAS; and is the sole per-page unsynced flag. The transport-neutral engine reconciles by `savedAt` then `revisionId`, treats same-version divergence as an integrity conflict, hydrates through atomic complete-record CAS, retries outbound failures with bounded backoff, cleans orphaned queue intent safely, continues independent pages after partial failures, and never leaks note or transport data through status. The production MV3 worker owns automatic save, connection, migration, startup, install, panel-open, periodic-alarm, and one-shot retry triggers; binds every run to one OAuth connection generation; invalidates its memory credentials before disconnect; advances due exact revisions after global failures; and records last-success metadata through connection CAS. The passive side panel observes only its exact queue entry plus safe connection metadata, the options page reports the live aggregate queue count, pending wins while disconnected or unavailable, and a post-save remote claim requires concrete queue-removal or newer-success evidence. No manual Sync now or remote Retry control exists, and local saves remain successful during every remote failure.

## PP-008 — Add Extension Integration and Package Audits

- Status: completed
- Priority: P1
- Dependencies: PP-004, PP-005, PP-007
- Spec or plan references: Test and Acceptance Plan; plan Commit 7
- Acceptance criteria: Playwright launches an unpacked production build and covers options, worker, toolbar/panel, navigation, persistence, and root index where Chromium supports them; package audit rejects remote scripts, unsafe evaluation, missing resources, source maps, and credentials; CI runs all stable gates under Xvfb.
- Suggested files: `e2e/`, `scripts/`, Playwright config, CI
- Test expectations: Passing production audit and browser smoke suite with documented environment prerequisites
- Notes: Independently approved after corrective review. The production package now has four stable Chromium flows covering worker/options/unsupported states, a genuine restricted editor, supported-tab navigation, real Gutenberg local save, panel reload, same-profile browser restart, exact-origin root storage refresh, unrelated-origin exclusion, and exactly one credential-free canonical new tab. Profiles and the local HTTP fixture are rollback-safe and aggregate cleanup failures. The native toolbar-to-side-panel host remains one explicit capability skip because Playwright cannot drive Chrome extension chrome; the worker's real `sidePanel` behavior and packaged `default_path` are tested separately. The integration flow exposed and closed a real WordPress `RichTextData` hydration defect with aligned dependency pinning plus benign, adversarial, and spoof-object coverage.

## PP-009 — Complete Product and Release Documentation

- Status: completed
- Priority: P1
- Dependencies: PP-008
- Spec or plan references: Documentation and Atomic Delivery; Assumptions and Deferred Work
- Acceptance criteria: README covers setup, development, BYOS registration/configuration, storage, identity, permissions, privacy, limitations, testing, packaging, and release checks.
- Suggested files: `README.md`, strategy/state docs
- Test expectations: Markdown format check, link/path review, command verification
- Notes: `README.md` now covers local development, unpacked loading, exact approved public-client BYOS registration/build configuration, automatic queue-based synchronization, the local service-worker rationale, page identity and pragmatic collision stacking, storage/conflict semantics, permissions, privacy/security, tests, manual acceptance, release checks, troubleshooting, known limitations, and maintained-document links. Licensing is intentionally not a readiness blocker.

## PP-010 — Production-Readiness Audit and Hardening

- Status: completed
- Priority: P0
- Dependencies: PP-009
- Spec or plan references: Entire acceptance plan
- Acceptance criteria: Complete gate passes from clean install; dependency and package risks are reviewed; accessibility and error paths are audited; no hidden TODOs or secrets exist; compliance rows are tested or explicitly deferred; reproducible release artifact and checksum are generated without publishing.
- Suggested files: Any narrowly justified fixes plus state documentation
- Test expectations: `npm ci`, complete check, browser smoke, package inspection, clean-worktree verification
- Notes: Independently approved after adversarial corrective review. Clean `npm ci`, the complete 943-test/build/audit/browser gate, secret/TODO/source-map scans, dependency-risk review, accessibility/error-path review, and compliance review pass or have explicit manual boundaries. The dependency-free release packager captures and audits one immutable `dist/` snapshot, writes a deterministic 16-entry ZIP plus SHA-256 sidecar, rejects unsafe/aliased physical paths and concurrent runs, preflights ZIP limits, pairs archive/checksum publication, and retains exact recovery artifacts and locks on incomplete rollback. Two release runs produced SHA-256 `368041dfeb84ae21a4d98cabc568bf179682b008563f0d5f790f21018349321e`; external checksum, unzip, entry-order, manifest, and transient-file checks pass. Live approved-client BYOS and native toolbar-host verification remain manual.

## PP-011 — Simplify the Side-Panel Writing Experience

- Status: completed
- Priority: P0
- Dependencies: PP-010
- Spec or plan references: User-requested post-plan UI refinement
- Acceptance criteria: The side-panel brand row has one right-aligned Settings link and no preferences card; recent notes on a root origin are controlled by a persisted setting that defaults off and avoids index work while disabled; the normal page-note surface renders only a borderless, control-free editor with keyboard editing/undo/redo intact; the editor grows with content; and reduced outer spacing plus a subtle theme-aware diagonal grey background distinguish the panel from the editor.
- Suggested files: settings domain/repository, options UI, side-panel app/editor/styles, focused tests
- Test expectations: Settings default/validation/atomic-update cases; options and side-panel component cases; editor capability/style assertions; complete repository gate
- Notes: Independently approved after two corrective review cycles. The brand row now owns one right-aligned link-like Settings control; the preferences card and normal page/editor headings, URL context, loading copy, borders, toolbar, inserter, and button chrome are gone. Blank notes hydrate one real paragraph without initialization saves, repeated identical Gutenberg callbacks are de-duplicated, keyboard type/undo/redo works, and long notes grow the document without an inner editor scroller. The strict current settings shape adds a default-off atomic recent-root preference; disabled, failed-load, and StrictMode paths create no index connection or session. A subtle light/dark diagonal gutter and reduced padding retain separation. Essential local errors/retries and quiet passive save/sync status remain. The complete 956-test/build/audit/browser gate passes, including packaged keyboard editing/history/growth/reload/restart and default-off then opted-in exact-origin index behavior.

## PP-012 — Cut the 0.1.1 Minor Update

- Status: completed
- Priority: P0
- Dependencies: PP-011
- Spec or plan references: User-requested 0.1.1 package and standing minor-update tag convention
- Acceptance criteria: Package, lockfile, and Chrome manifest versions agree at `0.1.1`; release documentation classifies this and future version tags as “Minor update”; the complete release gate passes; one deterministic `pageperch-0.1.1.zip` plus matching strict checksum is produced; the source commit is annotated with `v0.1.1` and both commit and tag are pushed.
- Suggested files: version metadata, deployment/release documentation, orchestration state
- Test expectations: Complete `npm run check`, `npm run release:package`, exact archive/checksum cardinality and names, strict checksum verification, ZIP integrity, manifest/package version inspection, clean source/tag verification
- Notes: The version-only worker change was independently approved with all four bindings at `0.1.1` and no lockfile dependency drift. The complete 956-test/build/audit/browser gate passes. Two packaging runs produced the same 5,034,218-byte archive with SHA-256 `ddf8222c2308c7c4794b18e3cf9b5448f13aed56bf094b57dffda31e808e71d0`; strict checksum, ZIP integrity, embedded manifest version, and exact two-file `0.1.1` cardinality checks pass. Main orchestrator owns the release commit, annotated tag, push, and final handoff.

## PP-013 — Refine the Editor Canvas and Rich Paste

- Status: completed
- Priority: P0
- Dependencies: PP-012
- Spec or plan references: User-requested `v0.1.2` refinement; Plan: Side Panel; WordPress block serialization default parser and Gutenberg raw/paste handling
- Acceptance criteria: Gutenberg root block padding is exactly 16 pixels at narrow and wide panel widths; writing-flow block padding is zero; supported headings, paragraphs, lists, quotes, code/preformatted text, separators, links, and safe inline formatting have coherent light/dark editor styles; pasted semantic HTML is converted by Gutenberg into allowed blocks while preserving safe structure and inline formatting; a short editor fills the available panel height without hiding the note-status paragraph; long content still grows the document with no inner vertical scroller; package, lockfile, manifest, artifact, and annotated `v0.1.2` minor-update tag agree.
- Suggested files: `src/side-panel/PageNoteEditor.tsx`, `src/side-panel/PageNoteEditor.css`, `src/styles/base.css`, focused component/browser tests, version metadata
- Test expectations: Focused paste/parser, style-contract, short-height/status, long-growth/no-inner-scroller, complete `npm run check`, deterministic `npm run release:package`, strict archive verification, and green branch/tag CI
- Notes: Independently approved after an adversarial corrective review. The editor now has exact 16-pixel narrow/wide root gutters, zero writing-flow padding, coherent theme-aware styles for supported semantic text, and a flex-height chain that fills a short viewport while preserving the passive status and still grows with long content. The pinned `@wordpress/blocks` stack uses `@wordpress/block-serialization-default-parser` for serialized Gutenberg documents and its paste/raw handlers for incoming HTML; PagePerch preserves safe headings, lists, quotes, code, emphasis, and HTTPS links but rebuilds every persistence projection through the existing safe schema so arbitrary CSS, event handlers, scripts, embedded content, unsafe URL schemes, and unsupported blocks are never stored or synced. The complete 959-test gate passes at 92.13% statement and 88.80% branch coverage with four packaged Chromium passes and one intentional native-toolbar skip. Two packaging runs produced the same 5,040,549-byte archive with SHA-256 `f0ea98eedcb16ef94bf516428aadcf145ff8ded3eae6d471ac77c6689b5e1e50`; strict checksum, ZIP integrity, embedded manifest version, and exact two-file `0.1.2` cardinality checks pass. Trusted rich clipboard input, the native toolbar host, and approved live BYOS remain explicit manual verification boundaries.
