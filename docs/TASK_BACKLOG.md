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

- Status: acceptance rejected after manual verification
- Priority: P0
- Dependencies: PP-012
- Spec or plan references: User-requested `v0.1.2` refinement; Plan: Side Panel; WordPress block serialization default parser and Gutenberg raw/paste handling
- Acceptance criteria: Gutenberg root block padding is exactly 16 pixels at narrow and wide panel widths; writing-flow block padding is zero; supported headings, paragraphs, lists, quotes, code/preformatted text, separators, links, and safe inline formatting have coherent light/dark editor styles; pasted semantic HTML is converted by Gutenberg into allowed blocks while preserving safe structure and inline formatting; a short editor fills the available panel height without hiding the note-status paragraph; long content still grows the document with no inner vertical scroller; package, lockfile, manifest, artifact, and annotated `v0.1.2` minor-update tag agree.
- Suggested files: `src/side-panel/PageNoteEditor.tsx`, `src/side-panel/PageNoteEditor.css`, `src/styles/base.css`, focused component/browser tests, version metadata
- Test expectations: Focused paste/parser, style-contract, short-height/status, long-growth/no-inner-scroller, complete `npm run check`, deterministic `npm run release:package`, strict archive verification, and green branch/tag CI
- Notes: The `v0.1.2` artifact and automated gates completed, but the user rejected manual acceptance. The capability object empties both Gutenberg editor style collections, the parser is only transitive and is not imported directly, the paste tests invoke the utility and inject its result instead of exercising browser paste, and the packaged height assertion accepts a 10rem editor with only 24 pixels below the final block. PP-014 replaces these false-positive contracts.

## PP-014 — Correct Gutenberg Styles, Rich Paste, and Viewport Fill

- Status: completed
- Priority: P0
- Dependencies: PP-013 rejection
- Spec or plan references: User manual feedback after `v0.1.2`; Plan: Side Panel; WordPress block serialization default parser, block editor styles, and block paste-handler documentation
- Acceptance criteria: `@wordpress/block-serialization-default-parser` is an exact direct dependency and is meaningfully imported for serialized Gutenberg document detection or parsing; the editor receives a non-empty Gutenberg `styles` collection containing coherent light/dark content styles for every supported rendered text element and block; a trusted Chromium copy/paste carrying `text/html` creates the expected heading, paragraphs, list, quote, code, emphasis, and safe link blocks and persists them through panel reload; unsafe active content and URL schemes remain excluded from persistence; at a 720-pixel viewport a short editor occupies all space between the header and passive status with only the intended gaps, while long notes still grow without an inner scroller.
- Suggested files: `package.json`, `package-lock.json`, `src/side-panel/PageNoteEditor.tsx`, a dedicated editor-style module or stylesheet, `src/side-panel/PageNoteEditor.css`, `src/styles/base.css`, focused component tests, and `e2e/extension.smoke.spec.ts`
- Test expectations: Direct dependency/import test, capability style-content assertions, genuine trusted Chromium rich-copy/paste and reload assertions, strict bounding-box viewport-fill assertion, long-growth regression, complete `npm run check`, deterministic release packaging, and green branch/tag CI
- Notes: Independently approved after one adversarial corrective review. Exact direct dependencies now expose the pinned block editor and serialized-document parser; the parser detects actual comment-delimited Gutenberg documents while `pasteHandler` converts ordinary clipboard HTML. The isolated editor receives a complete theme style asset despite its hard-coded empty visual-editor styles. The structured-paste bridge preserves block order, partial-selection semantics, nested-list validity, native undo/redo, safe persistence, and reload without swallowing unsupported paste paths. Genuine Chromium copy/paste reports trusted events and `text/html`; strict 280×720 geometry proves the short editor fills the panel while long content remains document-growing. The complete gate passes with 963 tests at 91.38% statement and 87.76% branch coverage, production build/audits, six passing Chromium flows, and one intentional native-toolbar skip.

## PP-015 — Cut the 0.1.3 Corrective Minor Update

- Status: completed
- Priority: P0
- Dependencies: PP-014
- Spec or plan references: User-requested `v0.1.2` correction and standing minor-update tag convention
- Acceptance criteria: Package, lockfile, and Chrome manifest versions agree at `0.1.3`; README release commands name the exact artifact; the complete release gate passes; one deterministic `pageperch-0.1.3.zip` plus matching strict checksum is produced; the source commit is annotated with `v0.1.3` using the standing minor-update message and both commit and tag are pushed without modifying `v0.1.2`.
- Suggested files: version metadata, README, release evidence, orchestration state
- Test expectations: Complete `npm run check`, repeated deterministic `npm run release:package`, exact archive/checksum cardinality and names, strict checksum verification, ZIP integrity, embedded manifest/package version inspection, clean source/tag verification, and green branch/tag CI
- Notes: Package, both lockfile version fields, source manifest, and archived manifest agree at `0.1.3`. The complete 963-test/build/audit/browser gate passes with six Chromium flows and one intentional native-toolbar skip. Two packaging runs produced the identical 5,062,768-byte archive with SHA-256 `589ec6ca690ac3cfd87515df9bec29933015dfc78ffc2175e23f6ae2650f898c`; strict checksum verification, ZIP integrity, exact two-file artifact cardinality, and embedded-manifest inspection pass. The release source is committed, annotated as `PagePerch 0.1.3 — Minor update`, and pushed without rewriting `v0.1.2`.

## PP-016 — Restore Click-to-Type Editing and Remove Gutenberg Deprecations

- Status: completed
- Priority: P0
- Dependencies: PP-015 manual rejection
- Spec or plan references: User manual feedback after `v0.1.3`; Plan: Side Panel and Settings; WordPress 6.5 `useSettings` and `RecursionProvider` APIs
- Acceptance criteria: A dedicated packaged-browser test clicks the visibly empty editor canvas, types ordinary text, observes it immediately, proves local persistence and reload, and fails against the rejected implementation before the fix; production emits neither the `wp.blockEditor.useSetting` nor `wp.blockEditor.__experimentalRecursionProvider` deprecation; keyboard focus, rich paste, undo/redo, long growth, and full-height behavior remain intact; the settings page visibly shows the exact installed Chrome manifest version.
- Suggested files: `e2e/extension.smoke.spec.ts`, `src/side-panel/PageNoteEditor.tsx`, `src/build/mv3Compatibility.ts`, focused build/editor tests, `src/options/App.tsx`, `src/options/main.tsx`, options tests and styles
- Test expectations: Demonstrated pre-fix click-to-type failure, exact compatibility-transform tests with drift rejection, dedicated trusted packaged-browser type/persist/reload and deprecation-console assertions, options component and packaged-version assertions, complete `npm run check`, and green branch/tag CI
- Notes: Independently approved with no blockers. Before the production fix, the dedicated packaged test failed its first upper-right canvas click because the editable did not become `document.activeElement`; after the fix, upper-right, middle-left, and lower-right canvas clicks each focus before distinct typing, and the combined note persists and reloads. The exact build-module compatibility transform changes `useSetting` to tuple-returning `useSettings` and the experimental recursion alias to stable `RecursionProvider`, rejects missing or duplicate pinned patterns, composes with the existing Lodash rewrite, leaves `node_modules` untouched, and produces neither exact warning in packaged Chromium. Settings displays the runtime manifest version. The complete gate passes with 971 tests at 91.42% statement and 87.75% branch coverage, seven passing Chromium flows, and one intentional toolbar skip.

## PP-017 — Cut the 0.1.4 Corrective Minor Update

- Status: completed
- Priority: P0
- Dependencies: PP-016
- Spec or plan references: User manual feedback after `v0.1.3`; standing minor-update tag convention
- Acceptance criteria: Package, lockfile, source manifest, archived manifest, settings display, and README commands agree at `0.1.4`; the complete release gate passes; one deterministic `pageperch-0.1.4.zip` plus matching strict checksum is produced twice identically; the source commit is annotated with `v0.1.4` using the standing minor-update message and both commit and tag are pushed without rewriting `v0.1.3`.
- Suggested files: version metadata, README, release evidence, orchestration state
- Test expectations: Complete `npm run check`, repeated deterministic `npm run release:package`, exact archive/checksum cardinality and names, strict checksum verification, ZIP integrity, embedded manifest/source/settings version inspection, clean source/tag verification, and green implementation/branch/tag CI
- Notes: The independently accepted PP-016 implementation was committed and its complete CI gate passed before release metadata changed. Package, both lockfile version fields, source manifest, archived manifest, runtime settings display, and README agree at `0.1.4`. The complete 971-test/build/audit/browser gate passes with seven Chromium flows and one intentional toolbar skip. Two packaging runs produced the identical 5,064,434-byte archive with SHA-256 `bfbba61cc137d1be2599e3d86c20bef4b6d37a1550e705e3889f0ebf7c53223c`; strict checksum verification, ZIP integrity, exact two-file artifact cardinality, and embedded-manifest inspection pass. The release source is committed, annotated as `PagePerch 0.1.4 — Minor update`, and pushed without rewriting `v0.1.3`.

## PP-018 — Preserve Editor Alignment, Focus, and Unsupported Paste Text

- Status: completed
- Priority: P0
- Dependencies: PP-017 manual feedback
- Spec or plan references: User manual feedback after `v0.1.4`; Plan: Side Panel; safe Gutenberg persistence projection
- Acceptance criteria: Supported root and nested writing blocks use ordinary left-aligned document flow without inherited auto margins; selecting or editing a block or list item shows no blue block border, outline, or selection shadow while controls outside the canvas retain accessible keyboard focus; unsupported pasted structures preserve their visible textual content in source order as safe supported Gutenberg blocks rather than substituting or persisting a removal placeholder; active content, event handlers, unsafe URL schemes, arbitrary unsupported HTML, and duplicated nested text do not cross persistence; trusted packaged-browser paste, persistence, and reload prove the non-lossy fallback.
- Suggested files: `src/side-panel/PageNoteEditor.tsx`, `src/side-panel/PageNoteEditorStyles.ts`, `src/side-panel/PageNoteEditor.css`, `src/side-panel/PageNoteEditor.test.tsx`, `e2e/extension.smoke.spec.ts`
- Test expectations: Focused sanitizer cases; trusted Chromium unsupported-structure paste with all visible text retained through storage and reload; rendered writing-column geometry; real paragraph/heading/list-item focus-edit-undo behavior; complete `npm run check`
- Notes: Accepted after one rejected review and one bounded corrective pass. Clipboard fragments are sanitized before Gutenberg conversion; complete supported conversions retain rich blocks, while incomplete unsupported fragments become safe paragraphs through DOM-order text/image-alt traversal with exact occurrence accounting. Repeated text, mixed parent/child order, tables, figures, concealed subtrees, malformed unsafe stored markup, arbitrary attributes/CSS/URLs, limits, persistence, and reload have direct coverage. Canvas-scoped CSS restores ordinary left flow and removes distracting selection chrome, while automated tests protect observable editing, semantic paste, persistence, and rendered layout rather than exact presentation properties. The then-current main gate passed 977 tests at 91.45% statement and 87.39% branch coverage, seven Chromium passes, and one documented native-toolbar skip.

## PP-019 — Cut the 0.1.5 Corrective Minor Update

- Status: completed
- Priority: P0
- Dependencies: PP-018
- Spec or plan references: User-requested editor correction and standing minor-update tag convention
- Acceptance criteria: Package, lockfile, source manifest, archived manifest, settings display, and README commands agree at `0.1.5`; the complete release gate passes; one deterministic `pageperch-0.1.5.zip` plus matching strict checksum is produced twice identically; the accepted source commit is annotated with `v0.1.5` using the standing minor-update message and both commit and tag are pushed without rewriting prior releases.
- Suggested files: version metadata, README, release evidence, orchestration state
- Test expectations: Complete `npm run check`, repeated deterministic `npm run release:package`, strict checksum/ZIP/cardinality/version verification, clean source/tag verification, and green implementation/branch/tag CI
- Notes: The independently accepted PP-018 implementation was committed and its complete CI gate passed before release metadata changed. Package, both lockfile version fields, source manifest, archived manifest, runtime settings display, and README agree at `0.1.5`. The complete 977-test/build/audit/browser gate passes with seven Chromium flows and one intentional native-toolbar skip. Two packaging runs produced the identical 5,068,617-byte archive with SHA-256 `40c6bcde8b9805a8ad6a1e629750a01eaf5d38b37af68c25e5dd58f15bc66468`; strict checksum verification, ZIP integrity, exact two-file artifact cardinality, and embedded-manifest inspection pass. The release source is committed, annotated as `PagePerch 0.1.5 — Minor update`, and pushed without rewriting prior releases.

## PP-020 — Restore the Editor Top Gutter and Behavioral Test Boundaries

- Status: completed
- Priority: P0
- Dependencies: PP-019 manual feedback
- Spec or plan references: User feedback after `v0.1.5`; Plan: Side Panel and Test and Acceptance Plan
- Acceptance criteria: The rendered first Gutenberg block begins 16 pixels below the root canvas at narrow and wide widths; CSS-source, exact style-object, internal-class, and exact computed-presentation assertions are removed; browser coverage verifies rendered insets, focus/edit/undo, semantic paste, persistence/reload, viewport fill, document growth, and absence of nested overflow; artifact security audits remain intact.
- Suggested files: `src/side-panel/PageNoteEditor.css`, `src/side-panel/PageNoteEditor.test.tsx`, `e2e/extension.smoke.spec.ts`, obsolete style-source tests, maintained test documentation
- Test expectations: Focused editor component tests; rendered narrow/wide geometry; paragraph/heading/list-item focus-edit-undo; complete `npm run check`; review search for appearance-coupled assertions
- Notes: Accepted after independent review requested removal of three remaining implementation-only assertions and one bounded corrective pass closed them. The static CSS/theme baseline and selector/token tests are removed. The only remaining `getComputedStyle` use identifies a real nested vertical scroll container after long-document growth rather than asserting appearance. The complete gate passes with 973 tests at 91.45% statement and 87.39% branch coverage, production build/audits, seven Chromium passes, and one documented native-toolbar skip.

## PP-021 — Cut the 0.1.6 Minor Update

- Status: completed
- Priority: P0
- Dependencies: PP-020
- Spec or plan references: Standing minor-update tag convention
- Acceptance criteria: Package, lockfile, source manifest, archived manifest, settings display, and README commands agree at `0.1.6`; the complete release gate passes; one deterministic `pageperch-0.1.6.zip` plus matching strict checksum is produced twice identically; the accepted source commit is annotated with `v0.1.6` using the standing minor-update message and both commit and tag are pushed without rewriting prior releases.
- Suggested files: version metadata, README, release evidence, orchestration state
- Test expectations: Complete `npm run check`, repeated deterministic `npm run release:package`, strict checksum/ZIP/cardinality/version verification, clean source/tag verification, and green implementation/branch/tag CI
- Notes: The accepted PP-020 implementation was committed as `d7994f7` and CI run `30201357317` passed before release metadata changed. Package, both lockfile version fields, source manifest, archived manifest, runtime settings display, and README agree at `0.1.6`. The complete 973-test/build/audit/browser gate passes with seven Chromium flows and one intentional native-toolbar skip. Two packaging runs produced the identical 5,068,671-byte archive with SHA-256 `89abdfb21a6b21d45c3fa6dfd325bae36cd1d7a237c32c3ff10d831ad70eb67a`; strict checksum verification, ZIP integrity, exact two-file artifact cardinality, and embedded-manifest inspection pass. The release source is committed, annotated as `PagePerch 0.1.6 — Minor update`, and pushed without rewriting prior releases.

## PP-022 — Add Hierarchical Recent Notes and Filtering

- Status: completed
- Priority: P0
- Dependencies: PP-021 and commit `efa650d`
- Spec or plan references: User feedback after `v0.1.6`; Plan: Side Panel; default-off recent-note refinement
- Acceptance criteria: The existing opt-in recent-note preference remains off by default and performs no index work while disabled; enabled root pages list all other valid notes on the exact origin; enabled non-root pages list only true descendant path notes and exclude the current page, same-path query variants, similarly prefixed siblings, tombstones, malformed records, and cross-origin records; the section title reflects root versus page context; a right-aligned Filter control focuses a labeled input, filters loaded title or canonical path/query entries without requerying storage, clears active filtering on the first Escape, closes an empty field and restores trigger focus on the next Escape, and resets on navigation; the actual editor remains at least 400 pixels high before the recent-note section grows the page; BYOS behavior and stored settings shape remain unchanged.
- Suggested files: `src/side-panel/rootRecentNotes.ts`, `src/side-panel/App.tsx`, editor/panel styles, options copy, focused tests, packaged Chromium coverage, README, and durable project state
- Test expectations: Descendant boundary/root/invalid-record unit coverage; filter focus/matching/no-match/Escape/navigation component behavior; rendered 400-pixel editor minimum and hierarchical/filter/canonical-open Chromium behavior; complete `npm run check`; audited manual-test ZIP
- Notes: One bounded worker implemented the candidate without committing, pushing, versioning, tagging, packaging, or changing BYOS. One independent reviewer approved it with no blockers. The complete gate passes with 42 files and 975 Vitest cases plus seven of seven runnable Chromium scenarios with no skips. Two deterministic packaging runs produced the identical 5,071,184-byte `.release/pageperch-0.1.6.zip` candidate with SHA-256 `e2d7ffb3eeb7b5c948168a91c405ea5e860cfe089369734a95f3000b0f0c792a`, a matching strict sidecar, valid ZIP structure, and embedded manifest version `0.1.6`. The user manually accepted the candidate on 2026-07-29 and authorized commit, push, and the next annotated minor-update tag; approved live BYOS verification remains a manual boundary.

## PP-023 — Cut the 0.1.7 Minor Update

- Status: completed
- Priority: P0
- Dependencies: PP-022
- Spec or plan references: User acceptance on 2026-07-29 and standing minor-update tag convention
- Acceptance criteria: Package, lockfile, source manifest, runtime settings display, and README commands agree at `0.1.7`; the complete release gate passes; one deterministic `pageperch-0.1.7.zip` plus matching strict checksum is produced twice identically; the accepted source commit is annotated with `v0.1.7` using the standing minor-update message and both commit and tag are pushed without rewriting prior releases.
- Suggested files: Version metadata, README, release evidence, orchestration state
- Test expectations: Complete `npm run check`, repeated deterministic `npm run release:package`, strict checksum/ZIP/version verification, clean source/tag verification, and green branch/tag CI
- Notes: The accepted PP-022 implementation is committed and pushed as `b220a3e`. Package, both lockfile version fields, source manifest, runtime settings display, and README agree at `0.1.7`. The complete 975-case build/audit/browser gate passes with seven runnable Chromium scenarios and no skips. Two packaging runs produced the identical 5,071,184-byte archive with SHA-256 `6e74c6201b8390e7614c7e23b7786fd86a48151d1420a0b2f524a4540c9f2de6`; strict checksum verification, ZIP integrity, exact 16-entry archive content, and embedded manifest inspection pass. The main orchestrator owns the final release commit, push, and annotated `v0.1.7` tag.

## PP-024 — Stabilize Recent-Note Filtering and Show Visible Count

- Status: completed
- Priority: P0
- Dependencies: PP-023
- Spec or plan references: User follow-up after accepting PP-022
- Acceptance criteria: Opening and using the recent-note filter preserves at least the section height captured with the complete unfiltered list so result removal does not move the focused input in the viewport; closing or navigating releases the reservation; the context-specific heading suffix shows the number of currently visible notes, including zero for a no-match filter; loading and error states do not invent a count; accessibility and two-stage Escape remain intact.
- Suggested files: `src/side-panel/App.tsx`, panel styles if needed, component tests, packaged Chromium coverage, README, and durable project state
- Test expectations: Behavior-focused component coverage for full/filtered/zero counts and reset; real rendered-browser evidence that section height and input position remain stable while results shrink; focused and complete gates; uncommitted audited manual-test ZIP
- Notes: `v0.1.7` was committed, pushed, and tagged before PP-024 began. One bounded worker implemented ready-state visible counts and a rendered unfiltered section-height reservation without fixed guessed heights, nested scrolling, persistence, or BYOS changes. Component coverage proves uncounted loading/error headings plus full, filtered, zero, empty, and retained-error ready counts. Real Chromium proves section height and focused input viewport position remain unchanged when two results shrink to one and zero. One independent reviewer approved the four-file uncommitted diff with no blockers; the complete 975-case and seven-browser gate passes. Two deterministic packaging runs produced the identical 5,071,538-byte `.release/pageperch-0.1.7.zip` candidate with SHA-256 `c0b5ca6c9f15b7d6e675fdbff34c209227eba177e6a4fa90540f90c5edc31042`, a matching strict sidecar, valid ZIP structure, exactly 16 entries, and embedded manifest version `0.1.7`. The user manually accepted the candidate on 2026-07-29 and authorized the implementation commit and next minor tag.

## PP-025 — Cut the 0.1.8 Minor Update

- Status: in progress
- Priority: P0
- Dependencies: PP-024
- Spec or plan references: User acceptance on 2026-07-29 and standing minor-update tag convention
- Acceptance criteria: Package, lockfile, source manifest, runtime settings display, and README commands agree at `0.1.8`; the complete release gate passes; one deterministic `pageperch-0.1.8.zip` plus matching strict checksum is produced twice identically; the accepted source commit is followed by an atomic release commit annotated with `v0.1.8`; both commits and the tag are pushed without rewriting prior releases.
- Suggested files: Version metadata, README, release evidence, orchestration state
- Test expectations: Complete `npm run check`, repeated deterministic `npm run release:package`, strict checksum/ZIP/version verification, clean source/tag verification, and green branch/tag CI
- Notes: Pending the accepted PP-024 implementation commit and final release evidence.
