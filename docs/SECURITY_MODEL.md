# Security Model

## Protected Assets

PagePerch protects private note content, canonical URLs and titles, OAuth access tokens, PKCE verifier/state, one-time S3 access material, and the integrity of tombstones and synchronization decisions.

## Trust Boundaries

- Web pages are untrusted and PagePerch does not inject content scripts or read page DOM/content in v1; only tab URL and title metadata cross into the extension.
- Extension UI and service-worker code are packaged locally under the default MV3 CSP; no remote executable code is permitted.
- `chrome.storage.local` stores notes and the OAuth access token. It is extension-private but not an encrypted secret vault, so the privacy documentation must state that anyone controlling the browser profile or device may access data.
- `chrome.storage.session` stores PKCE verifier/state so worker suspension does not lose the flow; callback state is compared exactly before token exchange.
- BYOS receives OAuth requests and encrypted-in-transit S3 traffic. The app trusts issued bucket aliases and never constructs one from user identity.

## Credential Rules

- `VITE_BYOS_CLIENT_ID` is public build configuration, never a client secret.
- Request only `storage:app storage:s3`; never request OpenID identity scopes.
- Store the OAuth access token and an expiry adjusted at least 60 seconds early, but never persist the S3 secret, access key, or bucket alias.
- Clear token, PKCE state, in-memory credentials, and connection metadata on disconnect while retaining notes, tombstones, and remote objects.
- Treat connect and credential issuance as cancellable generations: disconnect returns without waiting for interactive authorization, and any late session/token/credential completion is cleared or rejected before it can restore connection state or return a secret.
- Create the S3 client only after acquiring usable temporary credentials, scope it to one repository operation, destroy it afterward, and accept the bucket only from that issued credential result.
- Redact token responses, authorization codes, signed headers, credentials, and note bodies from diagnostics and CI artifacts.

## Package Controls

The production audit rejects `eval`, `new Function`, remote executable references, source maps, undeclared manifest resources, environment/config leaks, and obvious credential markers. Dependencies and lockfile changes receive review, and public distribution remains blocked until the isolated editor’s GPL-2.0-or-later implications are resolved.

## Abuse and Failure Cases

Invalid or unsupported URLs do not reach storage. Settings validate exact HTTP(S) origins and parameter names. Record deserialization rejects malformed schema data without executing it. Remote JSON is treated as untrusted input with fatal UTF-8 decoding, exact schema/key checks, bounded body/count processing, and no diagnostic echo before reconciliation. Retry work is bounded, deduplicated, and alarm-driven to avoid loops or resource exhaustion. User-facing errors remain actionable without leaking sensitive response content.
