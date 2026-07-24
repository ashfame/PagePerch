# Storage Portability

PagePerch has no relational database in v1, but storage formats remain portable across Chrome local storage and S3 replicas. Domain records do not embed Chrome storage-area objects, AWS SDK types, or UI state.

Every note and settings envelope carries an explicit schema version. Repository adapters validate and migrate data at their boundary, preserve unknown future records rather than destructively rewriting them, and expose storage-neutral typed operations. Local keys and remote paths include their own namespace version.

`NoteRecordV1` stores the stable page key, canonical and representative URLs, exact origin, title, Gutenberg HTML, content hash, save timestamp, revision ID, and optional deletion timestamp. Tombstones retain the identity and comparison metadata required for cross-device convergence.

Remote export is one JSON object per record at `pageperch/v1/notes/{pageKey}.json`. A later provider can implement `RemoteReplicaRepository` without changing reconciliation, and a later format migration can list existing versioned objects and write a new namespace without mutating v1 data in place.

The production documentation must describe how to inspect/export local extension data and BYOS objects, but v1 does not promise automatic import from arbitrary files, cross-browser implementations, or tombstone garbage collection.
