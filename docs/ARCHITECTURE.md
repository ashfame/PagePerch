# Architecture

## Runtime Topology

PagePerch is a static Manifest V3 extension with three entry surfaces: a module service worker, a React side panel, and a React options page. Vite produces deterministic files for all entries, all runtime code and styles stay inside the extension package, and the manifest grants only the permissions and BYOS host access required by the plan.

The side panel observes active-tab and navigation state through extension APIs, derives a canonical page identity, loads cached local data immediately, and delegates edits to application services. One app-lifetime ownership coordinator sits outside the React tree, registers the current draft with the navigation flush boundary, interrupts stale startup, and preserves failed cleanup across StrictMode or same-realm remounts until an explicit retry succeeds. On exact-origin roots, one app-lifetime recent-note index queries the shared note service, excludes the root and tombstones, coalesces relevant `chrome.storage.local` change bursts, and retains immutable prior entries through retryable refresh failures; canonical entries open through a credential-free HTTP(S)-only tabs adapter. The service worker configures toolbar behavior, resumes a pending identity migration once per worker boot, observes startup and alarms, and owns background synchronization opportunities. The options page loads versioned settings, patches editor mode atomically against the latest record, executes custom identity rules through the migration service, and controls BYOS connection state.

## Layer Boundaries

1. Presentation: side-panel and options React components, Gutenberg adapter, accessibility, automatic color scheme, status text, and user actions.
2. Application: `PageIdentityService`, `NoteService`, identity migration coordinator, OAuth coordinator, and `SyncEngine`.
3. Domain: versioned note/settings records, identity and exclusion types, sync comparisons, queue entries, and validation.
4. Persistence: storage-neutral repository interfaces with Chrome local/session implementations.
5. Transport: injected `RemoteReplicaRepository`, BYOS credential provider, and reusable path-style SigV4 `S3ReplicaRepository`.

The BYOS boundary is extension-side client composition only. A public-client coordinator uses `chrome.identity` plus the established BYOS HTTP endpoints, persists pending PKCE state in session storage, patches the early-expiring OAuth connection into local settings, and delegates one-time S3 credential issuance to a cancellation-safe memory provider. Lifecycle generations make disconnect final across late authorization and credential completion. The options surface reads only connection metadata, derives live expiry, refreshes repository state after every action, suppresses mutations when status cannot be trusted, and never obtains or displays protocol credentials. The reusable S3 replica creates and destroys one AWS SDK v3 path-style client around each list/get/put operation, obtains the bucket only with that operation’s temporary credentials, validates every remote v1 record before returning it, and has no physical delete operation.

## Data Flow

An active supported URL is canonicalized by removing the fragment, retaining the normalized exact origin and pathname, filtering global and exact-origin exclusions case-insensitively, and sorting remaining query keys and values deterministically. SHA-256/base64url of the canonical URL becomes `pageKey`; the unhashed canonical URL remains in each record.

An edit is debounced for 750 ms. `NoteService` normalizes and hashes serialized Gutenberg HTML, ignores initialization and unchanged saves, writes the local record first, and queues the latest page revision when BYOS is connected. Clearing existing content writes an indefinite tombstone; clearing an untouched editor writes nothing.

An exact-origin root renders its editable root note and a sibling recent-note list sourced through `NoteService.listRecentByOrigin`. The list preserves repository recency order, omits its root key and deleted records defensively, refreshes after only relevant local note/index changes, suppresses late loads after root changes, and never transfers editor ownership. Opening an entry requires the exact stored canonical URL and creates one active Chrome tab.

Identity-rule changes first pass through a pure injected planner. It validates one exact-origin settings transition, accepts stored records only when they match the current or requested identity, produces normalized immutable destination/tombstone records with fixed mutation versions, and exposes canonical fingerprints plus a strict parser. The durable executor rederives the plan to prove provenance, compares the complete current origin inventory and settings fingerprint, writes destinations before tombstones and settings, repairs the affected index, and removes the journal only after verifying completion. Every phase uses the same storage lock as ordinary repositories; note/settings mutations reject while any journal is present.

`SyncEngine` compares local and remote records by `savedAt`, then lexicographic `revisionId` when timestamps are equal. Same-version divergent records become explicit integrity conflicts. It validates and reconciles the sorted local/remote/queue union, writes local winners remotely, applies remote winners through a complete-record atomic local CAS, removes queue-only orphans with revision CAS, continues independent pages after partial failures, and keeps temporary S3 secrets only in service-worker memory. The versioned queue stores only page key, current revision ID, bounded attempt count, and next-attempt timestamp; repeated intent coalesces and retry timestamps use injected exponential backoff rather than active polling.

## Storage Namespaces

- Local notes: versioned `chrome.storage.local` records and indexes under a PagePerch-owned prefix.
- Settings: one versioned settings envelope covering editor mode, exact-origin exclusions, and non-secret BYOS connection metadata.
- Sync queue: durable page-key entries pointing to the current local revision rather than embedding stale record snapshots.
- OAuth PKCE: short-lived verifier and state in `chrome.storage.session`.
- Remote notes: `pageperch/v1/notes/{pageKey}.json` in the BYOS-issued bucket alias.

## Compatibility and Failure Model

Chrome 114 is the minimum runtime. Unsupported tab schemes never reach repositories. Local writes define save success; remote failures are reported as pending synchronization and retried. Service-worker suspension is expected, so durable queue and OAuth session state cannot rely on module globals, while one-time S3 secrets intentionally do rely on module memory and are reacquired after suspension. A migration that begins after sync preparation may temporarily interleave a pre-migration upload between locked phases; a later full reconciliation converges the remote replica after the migration completes.
