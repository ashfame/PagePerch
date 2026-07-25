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

Status: completed.

Reduce the Gutenberg writing gutter, remove vertical writing-flow padding, give every supported text element coherent theme-aware editor styling, preserve safe semantic formatting when clipboard HTML becomes Gutenberg blocks, and let a short note fill the panel while keeping its passive status visible.
