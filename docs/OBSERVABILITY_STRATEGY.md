# Observability Strategy

User-visible status is the primary observability surface: `Saving`, `Saved locally`, `Synced to BYOS`, `Waiting to sync`, token-expired/reconnect-required, and actionable errors. Status derives from durable local and queue state plus the current sync attempt, not optimistic transport assumptions.

Internal diagnostics use stable event names and redacted structured fields such as operation, page-key prefix, record count, queue size, attempt, duration, and safe error category. Never log note bodies, complete canonical URLs, OAuth codes/tokens, S3 credentials, signed headers, or raw provider responses.

The options page reports last successful sync time, pending-change count, connection state, token-expiry state, and the most recent safe error. The production package has no external telemetry or analytics in v1.

Tests assert status transitions and redaction. Manual release validation may inspect the extension service-worker console locally, but no diagnostics are uploaded automatically.
