# Migration Strategy

## Schema Migrations

Read every storage envelope through a version-discriminated parser. Migrations are ordered, idempotent functions that create the latest representation only after validating the source. Persist a migrated envelope atomically through `chrome.storage.local.set`; never delete unknown or invalid data automatically.

## Identity Rule Addition

When a custom exclusion is added for an exact origin, list all local records for that origin including tombstones, recalculate each canonical identity using the new rules, and group records by destination page key. A single live record moves to the new key if needed. Multiple live records become one Gutenberg document containing each source note below a heading containing its former source URL, ordered oldest `savedAt` first with revision ID as deterministic tie-break. Write the destination before tombstoning every superseded key and enqueue all changed keys for remote replication.

The migration records enough representative URL and operation metadata to recognize a repeated attempt. Running the same addition again must not nest merge documents, duplicate sections, advance unchanged timestamps, or replace a newer destination.

## Identity Rule Removal

When a custom exclusion is removed, recalculate the combined record from its stored representative URL and move it to that identity while tombstoning the previous key. Do not attempt to parse or split earlier merge documents because that could lose subsequent user edits.

## Failure Recovery

Treat each migration as resumable steps with a durable operation ID and phase. Destination writes precede source tombstones, and repeated runs compare revisions before applying work. BYOS synchronization transports the resulting normal records and tombstones; it does not independently reinterpret rule changes.
