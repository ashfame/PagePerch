# Roadmap

## M0 — Foundation

Status: completed.

Deliver the committed source inputs, durable orchestration state, reproducible Node/npm project, deterministic MV3 build, generated icons, baseline side-panel/options/service-worker surfaces, CI, and initial CSP/package auditing.

## M1 — Offline Notes

Status: completed.

Deliver canonical page identity, built-in and custom exclusion matching, versioned Chrome local repositories, local-first note service, per-page Gutenberg editor, autosave state, unsupported-page handling, exact-origin root index, navigation handling, editor modes, automatic theme behavior, and accessibility coverage.

## M2 — Identity Migration

Status: completed.

Deliver validated exact-origin settings, collision-aware Gutenberg merge documents, deterministic oldest-to-newest ordering, old-key tombstones, idempotent repeated migration, representative-URL moves on exclusion removal, and migration-focused tests.

## M3 — BYOS Synchronization

Status: completed.

Deliver public-client OAuth PKCE, state validation, early token expiry, one-time in-memory S3 credentials, injected AWS SDK path-style replica transport, deterministic reconciliation, tombstone propagation, durable coalescing retries, automatic alarm/startup/panel/save/connection triggers, disconnect semantics, passive status, and network-mocked tests.

## M4 — Release Confidence

Status: completed; packaged browser coverage, production audits, complete operator/user documentation, deterministic release artifact/checksum, and manual acceptance handoff are delivered.

Deliver unpacked-extension Playwright flows, production CSP/package audits, full failure-path coverage, CI parity, polished setup/privacy/permissions documentation, and a repeatable release checklist.

## M5 — Post-Release UX Refinement

Status: completed.

Simplify the side-panel header and writing surface, make the root recent-note index explicitly opt-in, reduce panel spacing, and distinguish the editor with a restrained theme-aware diagonal background while preserving failure recovery and automatic local/BYOS behavior.

## M6 — 0.1.1 Minor Update

Status: completed.

Bind the accepted PP-011 product state to version `0.1.1`, classify its annotated release tag as a minor update under the standing release-label convention, and produce a fully audited deterministic ZIP and checksum for manual installation.

## M7 — 0.1.2 Editor Canvas and Rich Paste

Status: acceptance rejected after manual testing.

Reduce the Gutenberg writing gutter, remove vertical writing-flow padding, give every supported text element coherent theme-aware editor styling, preserve safe semantic formatting when clipboard HTML becomes Gutenberg blocks, and let a short note fill the panel while keeping its passive status visible.

## M8 — Correct the Editor Integration

Status: completed.

Replace the rejected superficial style and height assertions with real Gutenberg editor-style injection, a direct and used block-serialization parser dependency, trusted browser rich-paste coverage, and a strict short-note viewport-fill contract.

## M9 — 0.1.3 Corrective Minor Update

Status: completed.

Bind the accepted editor correction to version `0.1.3`, run the complete release gate, produce a deterministic audited ZIP and checksum, and publish the standing annotated minor-update tag without rewriting the rejected `v0.1.2` release.

## M10 — Correct Manual Editor Interaction

Status: completed.

Replace the inadequate keyboard-focused typing evidence with a dedicated packaged-browser click-to-type persistence contract, remove the pinned isolated editor's two WordPress 6.5 deprecation paths through a bounded build compatibility correction, and display the authoritative installed extension version on the settings page.

## M11 — 0.1.4 Corrective Minor Update

Status: completed.

Bind the independently accepted interaction correction to version `0.1.4`, run the complete release and deterministic packaging gates, and publish the standing annotated minor-update tag without rewriting the rejected `v0.1.3` release.

## M12 — Preserve Editor Flow and Pasted Text

Status: completed.

Restore ordinary left-aligned block flow, retain the visible text of unsupported pasted structures through a safe Gutenberg-text fallback instead of a destructive placeholder, and remove distracting selected-block chrome without weakening focus treatment outside the writing canvas.

## M13 — 0.1.5 Corrective Minor Update

Status: completed.

Bind the accepted editor-flow and non-lossy-paste correction to version `0.1.5`, run the complete release and deterministic packaging gates, and publish the standing annotated minor-update tag without rewriting prior releases.

## M14 — Restore the Top Gutter and Behavioral Test Boundaries

Status: completed.

Add a 16-pixel top inset to the Gutenberg writing root and replace CSS-source, internal-class, and exact presentation-property assertions with rendered geometry, focus/edit/undo, semantic paste, persistence, viewport-fill, growth, and overflow behavior.

## M15 — 0.1.6 Minor Update

Status: completed.

Bind the accepted top-gutter and behavior-first test correction to version `0.1.6`, run the complete release and deterministic packaging gates, and publish the standing annotated minor-update tag without rewriting prior releases.

## M16 — Hierarchical Recent Notes

Status: completed and manually accepted.

Expand the default-off recent-note index to every supported page, retain the exact-origin aggregate at the root, list only true descendant paths under non-root pages, add focused in-memory filtering with two-stage Escape behavior, and preserve at least 400 pixels of editor height before the recent-note section grows the document. The user accepted the deterministic manual-test candidate on 2026-07-29.

## M17 — 0.1.7 Minor Update

Status: completed.

Bind the accepted hierarchical recent-note implementation to version `0.1.7`, run the complete release and deterministic packaging gates, and publish the standing annotated minor-update tag without rewriting prior releases.

## M18 — Stabilize Filter Layout and Show Result Count

Status: completed and manually accepted.

Keep the recent-note section from shrinking while active filtering reduces its visible entries, so the focused filter input remains visually stable, and suffix the context-specific heading with the number of currently visible notes. The user accepted the deterministic manual-test candidate on 2026-07-29.

## M19 — 0.1.8 Minor Update

Status: completed.

Bind the accepted filter-layout and visible-count implementation to version `0.1.8`, run the complete release and deterministic packaging gates, and publish the standing annotated minor-update tag without rewriting prior releases.
