# Decisions

## 2026-07-25 — Use an Orphan Worktree Branch

- Decision: Build on orphan branch `feat/chrome-notes` in `/home/ashfame/git-worktrees/pageperch-chrome-notes`.
- Context: The primary checkout intentionally contains only the original plan plus untracked supplied inputs and must remain unchanged.
- Options considered: Build on `master`; create a branch from `master`; create the plan-requested orphan branch.
- Consequences: The feature branch is self-contained and has no ancestry with the placeholder primary commit; integration will require an explicit repository-history decision later.
- Follow-up tasks: Keep the source plan itself on the orphan branch and document the eventual merge strategy before integration.

## 2026-07-25 — Keep Local Storage Authoritative

- Decision: A note operation succeeds when its `chrome.storage.local` write completes; BYOS is an optional replica and never replaces the local source of truth.
- Context: The extension must work fully offline and remote failures must not block writing.
- Options considered: Remote-first writes; dual-write transactions; local-first persistence with durable reconciliation.
- Consequences: UI can display cached data immediately and remote failures become explicit pending sync states; conflict handling must be deterministic.
- Follow-up tasks: Test remote failure, restart recovery, and reconnect reconciliation.

## 2026-07-25 — Use Timestamp Then Revision ID for Conflicts

- Decision: Choose the record with the lexicographically latest `savedAt`, then the lexicographically greatest `revisionId` when timestamps are exactly equal.
- Context: The plan requires latest-save-wins and deterministic convergence across devices.
- Options considered: Vector clocks; per-device counters; timestamps alone; timestamp plus revision tie-break.
- Consequences: The v1 model is simple and convergent but trusts client clocks; explanatory UI for clock skew is deferred.
- Follow-up tasks: Inject clocks and revision factories into tests and cover exact timestamp conflicts.

## 2026-07-25 — Retain Tombstones Indefinitely in V1

- Decision: Logical deletions remain in local and remote stores without automatic garbage collection.
- Context: No server tracks whether every client has observed a deletion.
- Options considered: Immediate deletion; age-based cleanup; server acknowledgements; indefinite retention.
- Consequences: Stale devices cannot resurrect deleted notes, while storage grows with deleted identities.
- Follow-up tasks: Preserve tombstones in listings used for synchronization but hide them from user-visible indexes.

## 2026-07-25 — Defer Public Distribution Until License Decision (Superseded for Current Scope)

- Decision: Do not add a project license or publish a binary while `@automattic/isolated-block-editor` imposes GPL-2.0-or-later compatibility requirements that the project has not adopted.
- Context: The editor dependency is required by the plan and the project license is undecided.
- Options considered: Adopt a compatible license now; replace the editor; keep distribution private and defer.
- Consequences: This was the original plan interpretation. The user later directed PagePerch implementation, documentation, readiness, and manual testing to ignore licensing, so it is not a current backlog item or release gate.
- Follow-up tasks: None in the current scope.

## 2026-07-25 — Preserve the Pinned Editor with Audited MV3 Compatibility

- Decision: Keep `@automattic/isolated-block-editor@2.30.0`; pin and deduplicate its compatible WordPress 24-series commands, data, dataviews, patterns, and preferences packages; override `@wordpress/core-data@7.24.0` to its matching `@wordpress/sync@1.24.0`; and apply a Vite transform only to Lodash’s exact `Function('return this')()` global fallback, replacing it with Chrome 114’s `globalThis`.
- Context: Genuine production probes exposed incompatible caret-resolved WordPress sync and data-registry generations, duplicate store registration, and MV3-forbidden dynamic-function fallbacks. Media-worker code from newer mismatched WordPress generations also violated the extension CSP.
- Options considered: Skip editor bundling until later; downgrade the mandated editor; allow unsafe evaluation; align the pinned dependency generation and narrowly transform the equivalent global-object fallback.
- Consequences: The standalone editor probe and production application share one typechecked singleton list, the same compatibility transform, and the strict package audit. `@wordpress/rich-text@7.24.0` is a direct aligned dependency because the real parser exposes content attributes as `RichTextData`; PagePerch accepts only genuine instances or strings and sanitizes the resulting HTML before hydration. Packaged supported-page smoke must reach a real editable surface and preserve an actual edit through panel and browser restart without fatal or duplicate-store errors. Dependency refreshes fail the normal gate if forbidden constructs, split registries, incompatible exports, or persisted hydration regressions return.
- Follow-up tasks: Retain the real bundle and browser smokes and reassess every pin, deduplication entry, transform, and override whenever the editor version changes.

## 2026-07-25 — Accept Documented Pinned-Editor Dependency Risk for Private Development

- Decision: Continue implementation with the locked editor graph while treating 60 moderate production advisories and the stale React peer range as dependency risks; do not apply npm’s incompatible forced downgrade.
- Context: The advisories propagate from three underlying Babel runtime RegExp-complexity, Showdown link-parsing ReDoS, and UUID buffer-handling issues. No non-breaking root remediation is available for the mandated editor version, and the audited bundle contains no remote code or forbidden evaluation.
- Options considered: Abandon the required editor; force npm’s proposed downgrade; ignore the findings; lock, audit, document, and reassess before distribution.
- Consequences: Product work can continue with deterministic audited artifacts, but release readiness cannot claim a clean dependency audit.
- Follow-up tasks: PP-010 confirmed that the registry still offers only breaking editor-generation and ESLint-major remediations; retain the sanitizer/adversarial editor coverage and reassess the pinned graph when a compatible isolated-editor generation is available.

## 2026-07-25 — Serialize Chrome Storage Index Mutations Across Extension Contexts

- Decision: Coordinate note/settings repository operations through a shared per-storage promise queue and, when available, one same-origin Chrome Web Lock across extension documents and the service worker.
- Context: Note records and exact-origin index envelopes require read/modify/write updates, while multiple PagePerch contexts can write concurrently and `chrome.storage.local` has no transaction primitive.
- Options considered: Accept last-write-wins index races; keep only a per-instance queue; store one monolithic note envelope; use the Web Locks API with a realm-local fallback.
- Consequences: Chrome 114 target contexts serialize repository operations without a monolithic large-value rewrite. Environments lacking Web Locks retain safe same-realm serialization but cannot promise cross-context index safety.
- Follow-up tasks: Keep real extension smoke coverage for Web Locks availability and reassess if another supported runtime lacks the API.

## 2026-07-25 — Surface Owned Storage Corruption Instead of Treating It as Absence

- Decision: Return absence only for genuinely missing note/index values or harmless dangling memberships; raise typed recovery errors for owned malformed, future-version, key-mismatched, or wrong-origin values and never rewrite them automatically.
- Context: Silently filtering owned invalid values could make corruption or a downgrade appear to have deleted notes and could give migrations an incomplete record set.
- Options considered: Filter invalid values; delete/rebuild them automatically; fall back to a full scan; preserve bytes and require explicit recovery.
- Consequences: UI and migration callers can distinguish empty state from recoverable storage trouble. Physical delete retry repairs only fully valid dangling memberships and leaves unknown data untouched.
- Follow-up tasks: Map repository recovery errors to actionable UI in PP-004 and document recovery/export guidance in PP-009.

## 2026-07-25 — Keep Draft Ownership Outside the React Tree

- Decision: Create one explicit side-panel-lifetime draft ownership coordinator in the production entry and inject it into React; require stop before unregister before replacement, interrupt stale startup on a newer request, and retain failed cleanup plus its flush handler until an explicit retry succeeds.
- Context: React StrictMode probes, same-realm remounts, navigation during cached-note startup, and rejected teardown can outlive a component instance. Hook-local ownership could deadlock a newer page or orphan the only pending-save handler.
- Options considered: Keep ownership entirely in a component hook; use implicit module globals; allow replacement before cleanup; inject one explicit app-lifetime coordinator.
- Consequences: React connections only publish desired sessions and views. Runtime failures remain retryable on the same page but follow navigation or disconnect automatically, while stop/unregister failures block transfer without losing flushability. Late startup outcomes are observed and cannot resurrect stale ownership.
- Follow-up tasks: Keep adversarial deferred-start, failure-transition, StrictMode, and cross-remount tests whenever draft or navigation lifetimes change.

## 2026-07-25 — Separate Identity Migration Planning from Durable Execution

- Decision: Represent one exact-origin exclusion addition/removal as a deeply immutable versioned plan with fixed destination/tombstone records, canonical settings/note fingerprints, and a strict dependency-free persisted-plan parser; execute that plan later through CAS-checked resumable phases.
- Context: Adding a rule can merge multiple notes while removal must move the indivisible combined note through its stored representative URL. Chrome local storage offers asynchronous bulk operations but no documented transactional guarantee across the required destination, tombstone, index, settings, and journal phases.
- Options considered: Mutate notes directly from the options UI; rely on one optimistic bulk write; recompute merge content after each failure; persist a deterministic plan and resume it only while the complete expected inventory still matches.
- Consequences: The merge document, mutation versions, and source tombstones are fixed before persistence, so retry cannot nest headings or duplicate content. Records matching either legitimate side of the transition are accepted, enabling old-key tombstones and requested-identity collisions. Parser success proves structural and cryptographic self-consistency but not semantic provenance, so the executor rederives the plan, verifies the full current-state inventory, advances destination/tombstone/settings phases behind the shared storage lock, and leaves drifted data untouched. The service worker resumes once per boot and ordinary mutations reject while any journal is present.
- Follow-up tasks: Integrate validated options controls, preserve the mutation gate when settings/BYOS flows are added, and retain interruption coverage for every journal phase.

## 2026-07-25 — Keep BYOS Protocol Credentials Memory-Only and Cancellation-Safe

- Decision: Treat `byos.ashfame.com` as the established service and implement only an extension-side public OAuth client; persist the early-expiring OAuth token but hold the issued S3 access key, secret, bucket alias, credential ID, and expiry only in a generation-scoped memory provider.
- Context: The service returns the S3 secret once, worker or page suspension discards memory, and Disconnect must remain final even when interactive authorization, PKCE hashing, token exchange, or credential issuance completes late.
- Options considered: Persist S3 credentials; reuse one module promise without invalidation; cancel by waiting for every remote operation; persist only the OAuth token and reacquire credentials with lifecycle generations.
- Consequences: A fresh service-worker realm reissues protocol credentials from a usable token. Disconnect does not wait for browser consent, invalidates in-flight work, clears any late PKCE state, rejects late secrets before returning them, and never touches local notes or remote objects.
- Follow-up tasks: Reuse the provider from PP-007 synchronization, keep token expiry/reconnect visible in options, and preserve cancellation tests around every new remote trigger.

## 2026-07-25 — Bound Remote Replica Reads Without Shrinking the Established Large-Note Contract

- Decision: Reject individual remote v1 note objects above 16 MiB and replica listings above 10,000 exact note keys before reconciliation, while retaining tested round-trip support above the established 8 MiB local repository fixture.
- Context: Browser S3 bodies can stream or materialize through several SDK adapters, and malformed or unexpectedly large private-bucket content must not exhaust an MV3 worker. The existing product already accepts multi-megabyte Gutenberg notes.
- Options considered: Trust response metadata; read without limits; impose a small generic API limit; use conservative bounds above the current accepted large-note contract.
- Consequences: Ordinary and established large notes remain syncable, oversized or implausibly large replicas fail atomically with redacted recovery errors, and a local note above the remote bound remains safely offline pending explicit product handling rather than being truncated.
- Follow-up tasks: Surface the remote limit in PP-007 status and PP-009 documentation, measure realistic large-replica behavior in PP-010, and revise the bound only with memory/performance evidence.

## 2026-07-25 — Persist Minimal Sync Intent and Hydrate Through Exact-Record CAS

- Decision: Store one versioned queue entry per page with only page key, current revision ID, attempt count, and next-attempt timestamp; complete/fail entries through revision CAS; and apply a remote winner locally only when the complete current record still equals the engine snapshot.
- Context: Local saves define product success and must remain durable through suspension and remote failure, while an upload or download already in flight must not clear or overwrite a newer user save. Revision IDs alone are not an atomic equality guarantee because the repository accepts any valid externally supplied record.
- Options considered: Persist full record snapshots in the queue; rely on last writer wins; compare only revision IDs; use minimal intent plus queue revision CAS and local complete-record CAS under the shared storage lock.
- Consequences: Repeated saves coalesce without duplicating note content, stale completion cannot remove newer intent, a remote hydration cannot overwrite even a same-revision divergent concurrent save, queue-only orphans can be removed safely, and worker restart reconstructs bounded retry state. A failed queue write does not invalidate an already durable local save; later full reconciliation repairs missing intent.
- Follow-up tasks: Retain passive-status and post-save evidence race tests whenever note or queue persistence changes.

## 2026-07-25 — Use Automatic Sync with the Durable Queue as the Per-Page Flag

- Decision: Keep one queue entry containing page key and current revision as the only per-page unsynced marker; trigger reconciliation automatically after durable local mutation, connection, identity migration, panel opening, worker boot/install/startup, periodic alarm, and one-shot retry alarm; expose no manual Sync now or remote Retry control.
- Context: The user wants page visits and ordinary extension lifecycle events to recover pending work without making synchronization a manual workflow. A second boolean inside the note record would duplicate queue state and could drift from the revision it describes.
- Options considered: Add an `isSynced` boolean to every note; expose manual synchronization controls; keep revision-specific durable queue intent and automatic background reconciliation.
- Consequences: Local save success remains independent of BYOS, an expired connected token still leaves the exact revision pending, deliberate local-only/disconnected editing creates no unnecessary queue, and reconnection performs a full reconciliation. The MV3 service worker owns temporary credentials, alarms, serialization, connection generations, and redacted outcomes while Chrome may suspend it at any time. Disconnect invalidates worker credentials before clearing local connection state, and whole-run failures advance due revisions through bounded CAS backoff.
- Follow-up tasks: Add packaged lifecycle coverage and manual BYOS verification with an approved client.

## 2026-07-25 — Keep the Writing Surface Control-Free and the Root Index Opt-In

- Decision: Present one content-growing Gutenberg document without visible editor headings, borders, toolbars, inserters, or undo/redo buttons; hydrate a blank note as one local paragraph and retain keyboard-native editing/history; expose Settings in the brand row; and keep the exact-origin recent-note index disabled by default with no index connection until explicitly enabled.
- Context: The side panel is primarily a writing surface. Repeated page metadata, preference copy, card chrome, and Gutenberg controls consumed narrow-panel space, while an always-running root index added work and content the user did not always want.
- Options considered: Keep the prior multi-card panel; hide controls only with CSS while leaving blank notes appender-dependent; make the index visually hidden but still connected; use a persisted opt-in and a genuinely editable control-free document.
- Consequences: The panel has reduced spacing and a subtle theme-aware diagonal gutter around the borderless editor. Blank hydration and repeated initialization callbacks do not create a stored note, the first distinct serialization saves once, identical callbacks are ignored, keyboard undo/redo remains available, and long content expands the document instead of creating an inner PagePerch scroller. The root index performs no query/subscription work while disabled or when settings cannot be read.
- Follow-up tasks: Keep packaged keyboard/history/growth and default-off/opt-in index coverage whenever the pinned Gutenberg package or panel layout changes.

## 2026-07-25 — Classify Version Tags as Minor Updates

- Decision: Annotate every PagePerch version tag as `PagePerch <version> — Minor update` unless the user explicitly changes the standing release convention.
- Context: The user requested that PagePerch releases always be tagged as minor updates, beginning with `v0.1.1`.
- Options considered: Use only the semantic version as the annotation; infer a label from each semantic-version component; keep the requested human-facing classification as a stable tag convention.
- Consequences: Git tags retain exact `v<version>` identifiers while their annotations consistently communicate “Minor update”; package and Chrome manifest versions continue to use valid numeric version strings.
- Follow-up tasks: Apply the convention when cutting every future version tag and update this decision if the requested release classification changes.

## 2026-07-26 — Sanitize Gutenberg Mutations at the Persistence Boundary

- Decision: Let the pinned Gutenberg paste/raw pipeline convert trusted clipboard HTML into live blocks, then rebuild every changed block array through PagePerch's existing safe text schema before serializing the document for local persistence or synchronization.
- Context: Gutenberg correctly preserves useful semantic paste structure, but its allowed live block output can also retain arbitrary classes, inline styles, event attributes, embedded content, and unsafe link schemes that PagePerch must not store or upload.
- Options considered: Store Gutenberg's raw mutation output; replace native paste with a custom clipboard handler; strip all formatting; preserve the native editor experience while projecting every mutation into the existing safe persistence schema.
- Consequences: Safe headings, lists, quotes, code, emphasis, and links survive as Gutenberg blocks, while arbitrary CSS, active content, unsafe URLs, and unsupported blocks cannot cross the persistence boundary. The live editor state remains Gutenberg-owned, so removed unsafe presentation may remain visible until the next hydration even though it is never saved or synced; sanitization is bounded by the existing 2,000-block document limit and runs for every genuine edit.
- Follow-up tasks: Manually verify trusted cross-application rich paste in the target Chrome side panel and keep genuine pinned-library adversarial tests whenever the editor dependency or supported block schema changes.

## 2026-07-26 — Inject Writing Styles and Preserve Structured Paste Through Pinned Gutenberg APIs

- Decision: Pin `@wordpress/block-editor` and `@wordpress/block-serialization-default-parser` as exact direct dependencies, inject a complete theme style asset into the pinned isolated editor, use the default parser only to recognize serialized comment-delimited block documents, and use `@wordpress/blocks` paste handling for ordinary clipboard HTML through a structured-only, root-aware bridge.
- Context: The published `v0.1.2` falsely treated outer CSS, transitive installation, direct utility tests, and a permissive minimum-height assertion as evidence that Gutenberg itself received styles, browser paste created blocks, and the short editor filled the panel.
- Options considered: Depend on transitive packages and outer selectors; replace all native paste; upgrade the editor graph immediately; bind the required behavior to exact compatible packages with explicit injection and a narrow structured-paste bridge.
- Consequences: Supported elements receive coherent light/dark styles inside the editor; serialized Gutenberg documents and ordinary HTML use their documented distinct paths; simple inline paste remains native; structured paste is sanitized and adapted only when insertion is valid, including partial selections and nested list roots; and exact dependency pins plus component and trusted-browser tests bound reliance on unstable selection and style APIs.
- Follow-up tasks: Re-run the complete adapter and packaged-browser gate before changing any pinned WordPress package, and retain native cross-application paste plus toolbar-host checks in manual release acceptance.

## 2026-07-26 — Fail Closed Around the Pinned Isolated Editor's Deprecated Visual-Editor Copy

- Decision: Keep the latest isolated editor pinned at `2.30.0` and extend the existing build compatibility layer to rewrite only its exact build-module visual-editor path from `useSetting('layout')` to tuple-returning `useSettings('layout')` and from `__experimentalRecursionProvider` to stable `RecursionProvider`, requiring exactly one occurrence of each expected source pattern.
- Context: Manual testing exposed both WordPress 6.5 deprecations. The upstream package's current latest release copies an older visual editor even though the aligned pinned block-editor package exposes the stable replacements.
- Options considered: Ignore or filter the warnings; edit `node_modules`; patch every matching bundle token globally; upgrade to an unavailable upstream release; apply an exact dependency compatibility transform that fails on drift.
- Consequences: Production no longer calls the deprecated APIs, console output remains honest, existing local dependency files remain untouched, and an upstream source change stops the build for explicit review instead of silently retaining or misapplying the patch. Component, transform, and packaged-browser tests bind the interaction and warning-free behavior.
- Follow-up tasks: Remove the compatibility rewrite when a reviewed isolated-editor release uses both stable APIs, and retain the multi-spot click-to-type test as the primary editor usability contract.

## 2026-07-26 — Preserve Unsupported Clipboard Text Before Gutenberg Can Drop It

- Decision: Split trusted clipboard HTML into ordered source fragments, remove active and concealed subtrees from a detached clone, let the pinned WordPress paste handler convert each fragment, and replace only an incomplete conversion with safe paragraph blocks derived from DOM-order text nodes and image alternative text using ordered occurrence accounting.
- Context: Gutenberg can discard an unsupported table before PagePerch's post-block persistence sanitizer sees it, so replacing unsupported parsed blocks alone cannot prevent data loss. A generic warning placeholder is also destructive, while comparing only unique text values can collapse repeated user content or reorder mixed parent/child text.
- Options considered: Keep the warning placeholder; trust the WordPress conversion; flatten the entire paste to plain text; append all source text after rich blocks; reconcile each detached source fragment against its safe converted blocks and fall back only when incomplete.
- Consequences: Supported headings, paragraphs, lists, quotes, code, inline formatting, selections, and history retain Gutenberg behavior. Unsupported structures retain available visible text in source order without storing raw HTML, arbitrary style, active elements, unsafe URLs, hidden/inert/ARIA-hidden/inline-concealed subtrees, or malformed unsafe tails. Exact repeated occurrences are preserved, and the existing depth and 2,000-block limits remain authoritative.
- Follow-up tasks: Keep the exact loss/concealment repros and trusted packaged-browser occurrence/order assertions whenever the WordPress paste pipeline or supported block schema changes.

## 2026-07-26 — Test Editor Outcomes Instead of CSS Implementation

- Decision: Treat focus/edit/undo, semantic content, persistence/reload, rendered writing-column geometry, viewport fill, document growth, and actual overflow as automated editor contracts; do not bind tests to stylesheet source text, internal class names, injected style-object identity, or exact computed presentation values.
- Context: CSS-source and exact presentation assertions were brittle, duplicated implementation details, and previously passed while basic editor interaction was broken. The user explicitly prioritized behavioral evidence over appearance coupling.
- Options considered: Retain exact selector/token/property checks; replace them with screenshot baselines; remove all layout coverage; verify functional outcomes and rendered geometry while keeping visual acceptance manual.
- Consequences: Refactors can change selectors and styling implementation without meaningless test churn, while regressions that affect usable spacing, focus, editing, undo, semantic paste, persistence, viewport fill, or scrolling still fail. Artifact CSS parsing remains appropriate for CSP, remote-resource, source-map, and package-safety enforcement. Theme, contrast, visible-focus treatment, and other subjective appearance remain explicit manual checks.
- Follow-up tasks: Keep new editor tests behavior-oriented and reject future assertions whose only evidence is an exact CSS declaration, internal class, or presentation value.

## 2026-07-28 — Extend the Opt-In Recent-Note Index Through URL Path Hierarchy

- Decision: Keep one default-off recent-note preference and exact-origin subscription, but show the section on every supported page; an origin root lists every other valid note on that origin, while a non-root page lists only records on true descendant path boundaries. Keep filtering ephemeral and local to already loaded entries, clear a nonempty filter on the first Escape, close the empty field on the next Escape, and reserve at least 400 pixels for the editor before the recent-note section grows the document.
- Context: Root-only discovery hid useful child notes from natural parent pages, long indexes could shrink the writing surface, and users needed a quick keyboard-friendly way to narrow visible entries without adding storage or sync operations.
- Options considered: Query and show the full origin list on every page; add repository-level path indexes and persisted filter state; derive descendants from the existing validated exact-origin list and keep filtering in presentation state.
- Consequences: A page such as `/WordPress/wordpress-playground/pull/4095` includes notes under `/WordPress/wordpress-playground/pull/4095/changes` but excludes `/pull/40950`, same-path query variants, the current record, tombstones, malformed records, and cross-origin records. Recency order remains service-owned, typing does not query storage or BYOS, navigation resets the filter, and long lists grow the panel rather than collapsing the editor below 400 pixels. Internal stored setting and index type names remain root-oriented for compatibility even though their behavior is broader.
- Follow-up tasks: Manually accept the uncommitted ZIP, complete approved live BYOS verification, and only then apply the next version and publish the standing minor-update tag; consider a descendant-aware repository index only if real per-origin collections make full-origin loading costly.

## 2026-07-29 — Keep Active Filter Geometry Stable and Count Visible Results

- Decision: When the recent-note filter opens with a trustworthy ready list, measure the complete rendered section with its input and unfiltered entries before paint, retain the greatest observed height as a minimum while that filter remains open, and remove the reservation on close or keyed navigation. Suffix ready headings with the number of currently visible entries; loading and initial error headings remain uncounted.
- Context: Removing nonmatching list entries reduced document height and caused the focused filter input to shift in the viewport, disrupting the user's visual position. A visible count is useful only when it describes the list currently shown.
- Options considered: Give every section a fixed arbitrary minimum; preserve hidden list rows and gaps; add a nested scroll container; measure and retain the actual open unfiltered section height locally; show total loaded count or visible result count.
- Consequences: Filtering from many entries to one or zero does not shrink the section or move the focused input, but the section can still grow when needed and returns to natural layout when filtering closes or the page changes. Counts track the displayed results, including `(0)` for no matches, without storage, sync, or BYOS work. Real Chromium tests bind the rendered outcome instead of the DOM style mechanism.
- Follow-up tasks: Manually verify the uncommitted candidate at realistic side-panel widths before committing or assigning another release version.

## 2026-07-29 — Work on Trunk and Gate Every Push on Manual Candidate Approval

- Decision: Exempt PagePerch from the global dedicated-worktree convention, work directly in the primary checkout on `trunk`, and keep every prospective `0.1.x` product release local through versioning, the complete gate, an exact candidate commit, and a downloadable ZIP with checksum. Only explicit user approval permits an annotated minor-update tag on that exact commit and an atomic push of `trunk` plus the tag.
- Context: PagePerch's complete history lived on its sole GitHub branch while the repository's primary checkout remained on an obsolete initialization commit. The user wants the existing linear history to be the primary `trunk` history and wants hands-on extension testing to precede every future remote publication.
- Options considered: Keep the feature-named default branch and dedicated worktree; merge or rewrite the history into a new primary branch; natively rename the existing GitHub branch and relocate its unchanged local branch into the primary checkout; push candidate commits before manual testing; keep commits local until the exact ZIP is accepted.
- Consequences: Commit ancestry and existing tags remain unchanged, GitHub has one default `trunk` branch, and future work no longer requires task worktrees or topic branches. A rejected candidate accumulates another local commit and replacement ZIP but no remote mutation; an accepted candidate's tested commit is exactly the commit tagged and pushed.
- Follow-up tasks: Keep `AGENTS.md` authoritative for this repository-specific exception and do not push future product changes before the user explicitly accepts the committed candidate ZIP.

## 2026-07-29 — Replace Full Gutenberg Registries with Exact PagePerch Registries

- Decision: Alias only the exact `@wordpress/block-library` and `@wordpress/format-library` package entries used by the pinned isolated editor to local registrars that statically import eight supported block modules and nine safe format modules, while leaving every package subpath untouched and failing the production build if upstream imports or the emitted module graph drift.
- Context: The isolated editor registered 102 core blocks plus the complete format library even though PagePerch exposes eight text-focused blocks and sanitizes a narrower inline markup set. The editor allowlist hid unused choices but did not keep their code out of the bundle.
- Options considered: Keep the runtime allowlist only; alias the full packages with unguarded shims; patch `node_modules`; replace the isolated editor immediately; add exact aliases, typed static subpath imports, pinned-source guards, and an emitted-graph audit.
- Consequences: The side-panel JavaScript entry is 18.4% smaller while all seven packaged editor scenarios retain typing, focus, undo/redo, rich and unsupported paste, sanitization, persistence, reload, navigation, and recent-note behavior. `core/unknown` intentionally materializes safe non-toolbar semantic tags such as `b`, `i`, `del`, and `mark`; PagePerch's existing projection remains authoritative for persisted tags, attributes, and URLs. Mounted JavaScript heap is effectively unchanged, so the next optimization must avoid eager editor evaluation rather than claiming this static reduction solves runtime RAM alone.
- Follow-up tasks: Lazy-load the editor in PP-028, then reduce its CSS surface in PP-029. Do not use this decision to change the editor shell, BYOS, synchronization, authentication, AWS/S3, or service-worker behavior.
