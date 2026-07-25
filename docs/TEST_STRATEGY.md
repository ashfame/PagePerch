# Test Strategy

## Test Pyramid

- Unit tests cover canonicalization, exclusion matching, hashing, root detection, identity-transition planning, collision merging, persisted-plan parsing, content normalization, record comparison, PKCE primitives, validators, schema migrations, queue coalescing, and retry scheduling with injected clocks and randomness.
- Repository and service tests run against a faithful in-memory mock of `chrome.storage.local` and `chrome.storage.session`, including change events, error paths, large Gutenberg documents, restart reconstruction, and migrations.
- React component tests use React Testing Library with explicit fake timers and `matchMedia`, Chrome API, and service mocks to verify user-visible state, keyboard behavior, focus, automatic theme changes, navigation, root-index loading/refresh/open failures, and BYOS controls.
- Transport tests mock `fetch` and AWS SDK request handling while asserting exact OAuth form fields, scope, path-style S3 configuration, deterministic keys, credential lifetime, and partial failure behavior without making production requests.
- Production-package tests parse the manifest and emitted HTML/JavaScript/CSS to reject undeclared resources, external executable URLs, unsafe evaluation, source maps, accidental credentials, unstable filenames, and missing files.
- Playwright launches the unpacked production extension under Chromium/Xvfb. Current coverage verifies options, service-worker startup, the unsupported panel state, and a real editable Gutenberg surface for a routed supported HTTPS tab at 280 pixels without fatal or duplicate-store errors; later slices add navigation, restart persistence, and the complete packaged storage-change-to-root-index-to-new-tab flow.

## Required Gates

`npm run check` will aggregate formatting, ESLint, strict TypeScript, Vitest coverage, production build, CSP/package audit, and stable browser smoke tests. CI starts from `npm ci` under Node.js 24.18.0 and uploads only non-sensitive failure artifacts.

## Coverage Priorities

Acceptance-critical branches require direct tests: unsupported schemes; global/custom exclusion scope; duplicate queries; identity collisions; addition-output-to-removal-input lifecycle; persisted migration corruption and CAS mismatch; unchanged saves; untouched-empty clears; tombstones; root-only exact-origin indexing and canonical opening; exact timestamp conflicts; expired OAuth; state mismatch; one-time secret disposal; local-newer and remote-newer reconciliation; failed upload coalescing; restart recovery; disconnect/reconnect; missing client configuration; and dark/light live changes.

## Determinism

Tests inject clock, revision ID generation, randomness, extension storage, credential provider, and transport. Browser tests use isolated persistent profiles and local fixtures, and must not depend on a live BYOS account.

## Manual Verification

Before a release candidate, load the exact audited `dist/` package into the target Chrome stable release and verify toolbar-to-panel behavior, common page navigation, narrow widths, keyboard-only editing/settings, system theme changes, browser restart, offline persistence, and BYOS connection with a dedicated approved test client. Record results in orchestration state; do not replace automated coverage with this checklist.
