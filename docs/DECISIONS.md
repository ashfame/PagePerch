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
