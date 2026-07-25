# API Strategy

## Chrome APIs

Use typed wrappers around `chrome.sidePanel`, `chrome.tabs`, `chrome.storage`, `chrome.identity`, `chrome.alarms`, and extension lifecycle events so services remain testable. The manifest declares `sidePanel`, `storage`, `unlimitedStorage`, `tabs`, `identity`, and `alarms`, plus host access only for `https://byos.ashfame.com/*`.

The service worker calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`. The panel queries the active tab on mount, listens for activation and URL/title updates, and detaches listeners on unmount. Options open through standard extension APIs or the manifest options-page entry.

## BYOS HTTP API

Authorization uses `GET https://byos.ashfame.com/oauth2/auth` with response type `code`, exact redirect URI, storage-only scopes, state, and S256 challenge. Token exchange uses form-encoded `POST /oauth2/token`. Temporary credentials use bearer-authenticated JSON `POST /oauth2/protocol-credentials` with only `protocol`, `kind`, and `label`.

The extension-side client validates HTTP status, response schema, exact scope set, expiry, state, redirect path, duplicate callback fields, and callback errors. It maps low-level failures to stable internal error codes and safe actionable UI text without retaining response bodies, codes, verifiers, tokens, or credentials in diagnostics.

## S3 Replica API

Configure AWS SDK v3 for endpoint `https://byos.ashfame.com`, region `us-east-1`, Signature V4, `forcePathStyle: true`, and the issued alias as bucket. Implement list, get, and put only for v1 record replication; logical deletion is a put of a tombstone, never S3 DELETE.
