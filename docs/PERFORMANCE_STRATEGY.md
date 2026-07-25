# Performance Strategy

The side panel paints a lightweight loading shell immediately, reads the current page and cached note locally, and never waits for BYOS before enabling editing. The Gutenberg editor remounts only when the page key changes.

Autosave debounces changes for 750 ms, hashes normalized content, skips unchanged metadata/content, and coalesces remote work by page key. Storage indexes avoid scanning unrelated origins for the root-page list, while a revision gate coalesces local change-event bursts and suppresses intermediate or stale list results. Migration and full synchronization may use bounded batches with event-loop yielding.

Remote listing and reconciliation run in the background on explicit opportunities rather than polling continuously. Retry uses bounded exponential backoff and alarms so worker suspension does not create tight loops. Temporary credentials are reused only until their early-adjusted expiry.

Production hardening will measure emitted package size, editor-load latency, local note-load latency, large-document save time, full-origin index time, and large-replica reconciliation. Initial performance budgets are a production JavaScript package under 5 MiB compressed, cached note shell feedback under 100 ms on a typical desktop profile, and no long task over 200 ms outside initial editor loading; measured exceptions must be recorded before release. After identity recovery composition, the deterministic package contains 4,141,470 raw JavaScript bytes and 1,061,472 gzip-compressed JavaScript bytes, including a 3,949,184-byte side-panel entry and 12,032-byte service worker, so the compressed package remains within budget while the initial editor chunk remains an explicit loading-performance target.
