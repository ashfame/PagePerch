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

## 2026-07-25 — Defer Public Distribution Until License Decision

- Decision: Do not add a project license or publish a binary while `@automattic/isolated-block-editor` imposes GPL-2.0-or-later compatibility requirements that the project has not adopted.
- Context: The editor dependency is required by the plan and the project license is undecided.
- Options considered: Adopt a compatible license now; replace the editor; keep distribution private and defer.
- Consequences: Development and private testing may proceed, but release documentation must state the distribution blocker.
- Follow-up tasks: Complete a formal dependency/license review before Chrome Web Store submission.

## 2026-07-25 — Preserve the Pinned Editor with Audited MV3 Compatibility

- Decision: Keep `@automattic/isolated-block-editor@2.30.0`; pin and deduplicate its compatible WordPress 24-series commands, data, dataviews, patterns, and preferences packages; override `@wordpress/core-data@7.24.0` to its matching `@wordpress/sync@1.24.0`; and apply a Vite transform only to Lodash’s exact `Function('return this')()` global fallback, replacing it with Chrome 114’s `globalThis`.
- Context: Genuine production probes exposed incompatible caret-resolved WordPress sync and data-registry generations, duplicate store registration, and MV3-forbidden dynamic-function fallbacks. Media-worker code from newer mismatched WordPress generations also violated the extension CSP.
- Options considered: Skip editor bundling until later; downgrade the mandated editor; allow unsafe evaluation; align the pinned dependency generation and narrowly transform the equivalent global-object fallback.
- Consequences: The standalone editor probe and production application share one typechecked singleton list, the same compatibility transform, and the strict package audit. The packaged supported-page smoke must reach a real editable surface without fatal or duplicate-store errors. Dependency refreshes fail the normal gate if forbidden constructs, split registries, or incompatible exports return.
- Follow-up tasks: Retain the real bundle and browser smokes and reassess every pin, deduplication entry, transform, and override whenever the editor version changes.

## 2026-07-25 — Accept Documented Pinned-Editor Dependency Risk for Private Development

- Decision: Continue private implementation with the locked editor graph while treating 60 moderate production advisories, the stale React peer range, and the unresolved GPL compatibility decision as release risks; do not apply npm’s incompatible forced downgrade.
- Context: The advisories propagate from three underlying Babel runtime RegExp-complexity, Showdown link-parsing ReDoS, and UUID buffer-handling issues. No non-breaking root remediation is available for the mandated editor version, and the audited bundle contains no remote code or forbidden evaluation.
- Options considered: Abandon the required editor; force npm’s proposed downgrade; ignore the findings; lock, audit, document, and reassess before distribution.
- Consequences: Local/private product work can continue with deterministic artifacts, but release readiness cannot claim a clean dependency audit and public distribution remains blocked.
- Follow-up tasks: Reassess available editor/package updates during PP-010, test user-controlled content paths affected by Showdown, and document the final dependency review in release materials.

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
- Consequences: The merge document, mutation versions, and source tombstones are fixed before persistence, so retry cannot nest headings or duplicate content. Records matching either legitimate side of the transition are accepted, enabling old-key tombstones and requested-identity collisions. Parser success proves structural and cryptographic self-consistency but not semantic provenance, so the executor must verify exact current-state fingerprints and never overwrite drifted notes.
- Follow-up tasks: Implement the durable journal/executor, block or resume conflicting mutations, test every phase interruption and CAS mismatch, then integrate the validated options controls.
