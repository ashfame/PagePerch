# Compliance Matrix

| ID | Source | Requirement | Implementation files | Tests | Status | Notes / risks |
| --- | --- | --- | --- | --- | --- | --- |
| PP-R001 | Plan: Architecture and Tooling | Chrome 114+ MV3 side panel, options page, and module worker build deterministically | — | — | not started | PP-001 |
| PP-R002 | Plan: Architecture and Tooling | Exact permissions, BYOS-only host access, local assets, and default CSP | — | — | not started | CSP audit begins in PP-001 |
| PP-R003 | Plan: Architecture and Tooling | React 18 Gutenberg editor package 2.30.0 with `allowApi: false` and restricted capabilities | — | — | not started | Experimental dependency risk |
| PP-R004 | Plan: Page Identity | Canonicalize supported URLs with exact-origin, query exclusions, root detection, and stable SHA-256/base64url keys | — | — | not started | PP-002 |
| PP-R005 | Plan: Page Identity | Built-in read-only exclusions plus case-insensitive custom exact-origin exclusions | — | — | not started | PP-002 and PP-005 |
| PP-R006 | Plan: Page Identity | Recalculate and collision-merge notes with source headings, deterministic order, tombstones, and idempotency | — | — | not started | PP-005 |
| PP-R007 | Plan: Side Panel | Per-page Gutenberg note follows tabs/navigation and flushes before keyed editor remount | — | — | not started | PP-004 |
| PP-R008 | Plan: Side Panel | 750 ms local-first autosave, unchanged skip, explicit status, logical clear behavior | — | — | not started | PP-003 and PP-004 |
| PP-R009 | Plan: Side Panel | Exact-origin root page shows editable note and recent non-deleted index | — | — | not started | PP-004 |
| PP-R010 | Plan: Side Panel | Editor modes restrict blocks and remote/irrelevant Gutenberg features | — | — | not started | PP-004 |
| PP-R011 | Plan: Side Panel | Automatic color scheme, accessible keyboard/focus/control behavior, reduced motion, and narrow layout | — | — | not started | PP-001 and PP-004 |
| PP-R012 | Plan: Settings | Editor mode, built-in/custom exclusions, storage status, BYOS controls and errors | — | — | not started | PP-005 through PP-007 |
| PP-R013 | Plan: Internal Interfaces | Storage-neutral identity, note, settings, remote replica, note service, and sync boundaries | `docs/ARCHITECTURE.md` | architecture review | scaffolded | Code begins PP-002 |
| PP-R014 | Plan: Data Model | Versioned `NoteRecordV1`, actual-change timestamps/revisions, deterministic conflicts, indefinite tombstones | — | — | not started | PP-003 and PP-007 |
| PP-R015 | BYOS spec | OAuth authorization code with PKCE, exact storage scopes, no secret, identity redirect, and state validation | — | — | not started | PP-006 |
| PP-R016 | BYOS spec | Persist token with early expiry but keep issued S3 key/secret/bucket only in memory | — | — | not started | PP-006 |
| PP-R017 | Plan and BYOS spec | AWS SDK v3 path-style SigV4 S3 with injected BYOS endpoint, region, alias, and deterministic object paths | — | — | not started | PP-007 |
| PP-R018 | Plan: BYOS | Reconcile every required trigger, newest-save wins, local cache hydration, durable coalescing retry/backoff | — | — | not started | PP-007 |
| PP-R019 | Plan: Settings | Missing-client disabled state and disconnect clears local auth material without deleting any notes or remote objects | — | — | not started | PP-006 |
| PP-R020 | Plan: Tests | Unit, repository, sync, OAuth, component, theme, Playwright, and package-audit coverage | `docs/TEST_STRATEGY.md` | — | scaffolded | PP-001 through PP-010 |
| PP-R021 | Plan: Documentation | README documents install, BYOS, storage, identity, permissions, privacy, limitations, license, and release checks | — | — | not started | PP-009 |
| PP-R022 | Plan: Licensing | No project license or public distribution until compatible license decision | `docs/DECISIONS.md`, `docs/SECURITY_MODEL.md` | release audit | scaffolded | Must remain visible |
