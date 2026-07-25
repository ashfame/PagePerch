# Migration Strategy

## Schema Migrations

Read every storage envelope through a version-discriminated parser. Migrations are ordered, idempotent functions that create the latest representation only after validating the source. Persist a migrated envelope atomically through `chrome.storage.local.set`; never delete unknown or invalid data automatically.

## Identity Rule Addition

When a custom exclusion is added for an exact origin, list all local records for that origin including tombstones, recalculate each canonical identity using the new rules, and group records by destination page key. A single live record moves to the new key if needed. Multiple live records become one Gutenberg document containing each source note below a heading containing its former source URL, ordered oldest `savedAt` first with revision ID as deterministic tie-break. Write the destination before tombstoning every superseded key and enqueue all changed keys for remote replication.

The migration records enough representative URL and operation metadata to recognize a repeated attempt. Running the same addition again must not nest merge documents, duplicate sections, advance unchanged timestamps, or replace a newer destination.

## Identity Rule Removal

When a custom exclusion is removed, recalculate the combined record from its stored representative URL and move it to that identity while tombstoning the previous key. Do not attempt to parse or split earlier merge documents because that could lose subsequent user edits.

During either transition, a stored record is legitimate when its canonical identity matches the current rules or the requested rules. This explicitly admits old-key tombstones produced by an earlier addition, an existing requested-identity destination tombstone, and resumable requested-identity collisions while rejecting records that match neither side. Output content is normalized with the same Gutenberg invariant used by ordinary saves before its hash is generated.

## Failure Recovery

Treat each migration as resumable steps with a durable operation ID and phase. Destination writes precede source tombstones, and repeated runs compare revisions before applying work. BYOS synchronization transports the resulting normal records and tombstones; it does not independently reinterpret rule changes.

Persist only plans that pass the versioned runtime parser. Before every phase, recompute the exported canonical settings and note fingerprints and compare the complete exact-origin inventory to the plan; a parser-valid journal is structurally and cryptographically self-consistent but is not proof of semantic provenance. If current state differs, do not overwrite it: resume only a matching persisted plan or discard it through an explicit recovery/replan path that rederives destinations with the production identity service.
