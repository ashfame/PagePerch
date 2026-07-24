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

- Decision: Keep `@automattic/isolated-block-editor@2.30.0`, override `@wordpress/core-data@7.24.0` to its matching `@wordpress/sync@1.24.0`, and apply a Vite transform only to Lodash’s exact `Function('return this')()` global fallback, replacing it with Chrome 114’s `globalThis`.
- Context: A genuine production probe exposed an incompatible caret-resolved WordPress sync generation and MV3-forbidden dynamic-function fallbacks. Media-worker code from newer mismatched WordPress generations also violated the extension CSP.
- Options considered: Skip editor bundling until later; downgrade the mandated editor; allow unsafe evaluation; align the pinned dependency generation and narrowly transform the equivalent global-object fallback.
- Consequences: Both the standalone editor probe and future production application use the same compatibility transform and strict package audit. Dependency refreshes fail the normal gate if forbidden constructs or incompatible exports return.
- Follow-up tasks: Exercise the actual restricted editor in PP-004, retain the real bundle smoke, and reassess the transform and override whenever the editor pin changes.

## 2026-07-25 — Accept Documented Pinned-Editor Dependency Risk for Private Development

- Decision: Continue private implementation with the locked editor graph while treating 58 moderate production advisories, the stale React peer range, and the unresolved GPL compatibility decision as release risks; do not apply npm’s incompatible forced downgrade.
- Context: The advisories propagate from three underlying Babel runtime RegExp-complexity, Showdown link-parsing ReDoS, and UUID buffer-handling issues. No non-breaking root remediation is available for the mandated editor version, and the audited bundle contains no remote code or forbidden evaluation.
- Options considered: Abandon the required editor; force npm’s proposed downgrade; ignore the findings; lock, audit, document, and reassess before distribution.
- Consequences: Local/private product work can continue with deterministic artifacts, but release readiness cannot claim a clean dependency audit and public distribution remains blocked.
- Follow-up tasks: Reassess available editor/package updates during PP-010, test user-controlled content paths affected by Showdown, and document the final dependency review in release materials.
