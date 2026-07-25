# PagePerch Chrome Extension Implementation Plan

  ## Summary

  Build a TypeScript/React Manifest V3 Chrome extension that opens PagePerch through the toolbar action using chrome.sidePanel, available on Chrome 114+. The side panel will provide an autosaving Gutenberg-based note for each canonical
  page, plus a domain index on root pages. The UI will automatically follow prefers-color-scheme for light and dark modes. Chrome Side Panel documentation (https://developer.chrome.com/docs/extensions/reference/api/sidePanel)

  Local storage will always be the offline source of truth. Users may optionally connect BYOS, producing “Local + BYOS” synchronization.

  Implementation will begin in an orphan feature worktree under ~/git-worktrees/pageperch-chrome-notes, leaving the empty primary checkout unchanged.

  ## Architecture and Tooling

  - Use Node.js 24.18.0, the current latest LTS, in .nvmrc, npm with a committed lockfile, strict TypeScript, React 18, and Vite with deterministic multi-entry output for the side panel, options page, and module service worker. Node.js
    releases (https://nodejs.org/en/about/previous-releases)

  - Build a static Manifest V3 package with sidePanel, storage, unlimitedStorage, tabs, identity, and alarms permissions plus host access only to https://byos.ashfame.com/*.
  - Configure the toolbar action to open the global side panel and have the panel react to active-tab changes, conventional navigation, and SPA URL updates reported through tabs.onUpdated.
  - Bundle all JavaScript and CSS locally under the default MV3 extension CSP; no CDN scripts, remote executable code, content scripts, or access to page contents are needed in this version.
  - Use @automattic/isolated-block-editor 2.30.0, the actual scoped package, with its Gutenberg CSS and allowApi: false. Add an early production-build CSP smoke test because the dependency is experimental and tied to specific Gutenberg
    versions. Isolated Block Editor repository (https://github.com/Automattic/isolated-block-editor)

  - Generate padded square 16, 32, 48, and 128-pixel icons from page_perch_logo.png and use the supplied logo in the side panel, options page, manifest, and README.
  - Add ESLint, Prettier, TypeScript checking, Vitest, React Testing Library, and Playwright. GitHub Actions will run install, format check, lint, typecheck, unit/component tests, production build, CSP audit, and extension smoke tests.
  - Keep generated Markdown—including plan.md, README.md, and workflow documentation—unwrapped, with each paragraph and list item on one source line.

  ## Page Identity and User Experience

  ### Canonical page identity

  - Support only http: and https: pages; show a clear unsupported-page state for Chrome internals, extension pages, local files, blank tabs, and other schemes.
  - Define identity from the exact normalized origin, pathname, and meaningful query parameters. HTTP and HTTPS, subdomains, and non-default ports remain distinct.
  - Ignore URL fragments, remove default ports through the platform URL parser, preserve meaningful trailing slashes, preserve duplicate query values, and sort remaining query keys and values deterministically.
  - Hash the canonical URL with SHA-256/base64url to obtain a stable storage key while retaining the canonical URL in the record for display, navigation, and future migrations.
  - Treat a page as an origin root only when the canonical pathname is / and no meaningful query parameters remain. A root URL containing only ignored parameters still counts as the root.
  - Name the feature “Page identity exclusions,” described as “Query parameters that do not make a page unique.”
  - Ship a read-only global exclusion set covering the utm_* prefix and known click/marketing identifiers including gclid, dclid, gbraid, wbraid, fbclid, msclkid, twclid, ttclid, li_fat_id, mc_cid, mc_eid, _ga, and _gl.
  - Let users add and remove case-insensitive exact parameter names for an exact origin. Rules do not cross schemes, ports, hostnames, or subdomains.
  - Recalculate affected local and BYOS identities when a custom exclusion changes. If adding a rule collapses multiple notes, create one Gutenberg document containing every note under a heading containing its former source URL, ordered
    from oldest to newest, and write tombstones for the old keys. Removing a rule moves the combined note to its stored representative URL under the new identity but does not attempt to split previously merged content.

  - Keep short comments next to canonicalization, migration, timestamp conflict resolution, and tombstone logic explaining the product decisions requested here.

  ### Side panel

  - Query the active tab when the panel loads and whenever navigation or tab activation occurs. Flush any pending local save before switching documents and remount the editor by page key to prevent Gutenberg state leakage.
  - Provide one note document per canonical page, serialized as Gutenberg HTML.
  - Autosave 750 ms after the last content change. Skip initialization callbacks and any save whose normalized content hash and relevant metadata have not changed.
  - Complete the local write first and display explicit states: “Saving,” “Saved locally,” “Synced to BYOS,” “Waiting to sync,” and actionable error text.
  - Clearing an existing note performs a logical delete, removes it from visible indexes, and synchronizes a tombstone so stale devices cannot resurrect it. Clearing an untouched editor creates no record.
  - On origin-root pages, show the editable root note plus an index of every non-deleted noted page for that exact origin, sorted by most recently saved. Each entry shows title, path/query, and save time and opens the canonical page in a
    new tab.

  - Capture the active tab title when a note is saved; use the canonical path as the fallback title.
  - Offer two global editor modes in settings:
      - “Text-focused blocks”: paragraph, heading, list, quote, code, preformatted, and separator blocks plus inline formatting and links.
      - “Paragraphs only”: paragraph blocks and inline formatting while retaining undo/redo.

  - Disable media, embeds, reusable blocks, remote WordPress APIs, code editing, fullscreen, preview, and irrelevant Gutenberg panels in both modes.
  - Follow the operating-system/browser theme exclusively through prefers-color-scheme, including PagePerch chrome, form controls, status messages, focus states, and Gutenberg CSS variables. No manual theme toggle is required.
  - Meet keyboard accessibility expectations, preserve visible focus, label all settings controls, respect reduced motion, and maintain usable layouts at narrow side-panel widths.

  ### Settings page

  - Provide an editor-mode selector, a read-only list of built-in page identity exclusions, and an exact-origin rule editor with validation and duplicate prevention.
  - Provide storage status as either “Local only” or “Local + BYOS”; local storage cannot be disabled.
  - Provide BYOS Connect and Disconnect controls with automatic synchronization, account-independent status, last successful sync time, per-page and aggregate pending-change state, token-expiry state, and actionable errors. Do not expose manual Sync now or remote Retry controls.
  - Disable BYOS connection with an explanatory message when the build lacks the non-secret VITE_BYOS_CLIENT_ID.
  - Disconnect by removing the OAuth token, PKCE state, pending in-memory S3 credentials, and connection metadata. Retain all local notes and leave remote BYOS objects untouched; reconnection performs a full reconciliation.

  ## Storage, Synchronization, and Interfaces

  ### Internal interfaces

  - Define PageIdentityService for canonicalization, ignored-parameter matching, hashing, root detection, and migrations.
  - Define a storage-neutral NoteRepository with get, put, delete, listByOrigin, and listAll operations over versioned records.
  - Implement ChromeLocalNoteRepository over chrome.storage.local, not page window.localStorage, so the extension has durable offline data and service-worker access.
  - Define RemoteReplicaRepository and implement S3ReplicaRepository with injected endpoint, region, bucket, and temporary-credential provider so the S3 layer remains reusable even though only BYOS configures it initially.
  - Define NoteService to own validation, content hashing, local-first writes, logical deletion, and index queries.
  - Define SyncEngine to reconcile local and remote records, manage the durable outbound queue, refresh credentials, and report status without leaking transport concerns into UI components.
  - Define a versioned SettingsRepository for editor mode, exact-origin identity exclusions, BYOS connection metadata, and schema migrations.

  ### Data model

  - Store NoteRecordV1 with schemaVersion, pageKey, canonicalUrl, representativeUrl, origin, title, Gutenberg contentHtml, contentHash, savedAt, revisionId, and optional deletedAt.
  - Use UTC ISO timestamps generated when an actual save or logical delete occurs. Unchanged content does not advance savedAt or create a new revision.
  - Resolve local/remote reconciliation by the latest savedAt, as requested. If two differing records have exactly equal timestamps, compare revisionId lexicographically so every device selects the same winner.
  - Retain tombstones indefinitely in v1 because there is no server-side knowledge that every client has observed a deletion.
  - Version all local keys and remote object formats so later AI/page-content features can migrate safely.

  ### BYOS integration

  - Follow the supplied byos_integrations.md: authorization-code OAuth with PKCE, scopes storage:app storage:s3, no client secret, and path-style S3 access.
  - Obtain the build-time public client ID from VITE_BYOS_CLIENT_ID; production registration must allow the stable chrome.identity.getRedirectURL() callback for the published extension ID.
  - Run authorization through chrome.identity.launchWebAuthFlow; keep verifier and state in chrome.storage.session so service-worker suspension does not break the callback.
  - Validate state before token exchange. Store the OAuth access token and early-adjusted expiry in extension-local storage, but hold the issued S3 access key, secret, bucket alias, and expiry only in memory.
  - Request fresh S3 credentials whenever an operation begins without usable in-memory credentials. If the OAuth token has expired, retain pending writes and require reconnection.
  - Use AWS SDK v3 S3 primitives with endpoint https://byos.ashfame.com, region us-east-1, Signature V4, forcePathStyle: true, and the bucket alias returned by BYOS.
  - Store one deterministic JSON object per record at pageperch/v1/notes/{pageKey}.json; logical deletions overwrite the same object with a tombstone instead of issuing S3 DELETE.
  - On initial connection, panel opening, extension startup, periodic alarm, and successful local save, list/reconcile remote records and apply newest-savedAt wins in both directions. Populate the local cache from newer BYOS
    records and upload newer local records.

  - A save succeeds for the user once local persistence completes. BYOS failures place the page key in a deduplicated durable queue and retry on the next sync opportunity with bounded exponential backoff.
  - Coalesce repeated pending writes by page key so only the latest local revision is uploaded, making repeated saves and retries idempotent.
  - Display cached local data immediately while remote reconciliation happens in the background.

  ## Test and Acceptance Plan

  - Unit-test canonicalization across schemes, default/non-default ports, fragments, trailing slashes, query ordering, duplicate values, encoded values, global exclusions, case-insensitive custom exclusions, exact-origin scoping, and root
    detection.

  - Test identity-rule migrations, including multiple-note Gutenberg merges, deterministic ordering, old-key tombstones, repeated idempotent migration, and rule removal without content loss.
  - Test repositories against a mocked Chrome storage API, including schema upgrades, indexing, unchanged-content skips, logical deletion, and large records.
  - Test synchronization for local-newer, remote-newer, equal records, exact-timestamp conflicts, tombstones, duplicate retries, expired credentials, partial S3 failures, restart recovery, disconnect/reconnect, and missing BYOS build
    configuration.

  - Test OAuth PKCE generation, state validation, token errors, expiry skew, one-time S3 secret handling, and SigV4/path-style S3 request configuration with network mocks.
  - Component-test unsupported pages, root note plus index, link behavior, editor-mode changes, autosave transitions, empty-note deletion, loading/error states, settings validation, and BYOS status controls.
  - Mock matchMedia to verify automatic light/dark styling and live system-theme changes; include contrast, focus, reduced-motion, and narrow-panel checks.
  - Use Playwright with an unpacked production build under Chromium/Xvfb to smoke-test the options page, service worker, toolbar-to-side-panel behavior, tab navigation, local persistence across reloads, and root-page indexing.
  - Audit the production package for remote scripts, forbidden CSP constructs such as eval/new Function, missing manifest resources, source-map leakage, and accidental credentials.
  - Accept the feature when two URLs differing only by excluded parameters share one note, meaningful query values remain separate, root pages list all noted pages for their exact origin, notes survive browser restart offline, dark/light
    mode follows the system, BYOS reconciliation obeys latest-save-wins, and every CI gate passes.

  ## Documentation and Atomic Delivery

  - Commit 1: docs: add implementation plan and source assets — add plan.md, the supplied BYOS specification and logo, and record the agreed scope and decisions.
  - Commit 2: chore: scaffold manifest v3 extension — add Node/Vite/React/TypeScript setup, .nvmrc, manifest, generated icons, baseline side panel/options pages, quality scripts, and GitHub Actions.
  - Commit 3: feat: add page identity and local note storage — add canonicalization, global/custom exclusions, versioned schemas, local repository, note service, and their tests.
  - Commit 4: feat: add per-page block editor and origin index — add both editor modes, autosave, navigation handling, root note/index behavior, status UI, automatic themes, and component tests.
  - Commit 5: feat: add identity settings and note migrations — add exact-origin settings, collision merging, tombstone migrations, validation, and migration tests.
  - Commit 6: feat: add byos authentication and synchronization — add PKCE OAuth, temporary S3 credentials, remote repository, reconciliation, retry queue, settings controls, and transport tests.
  - Commit 7: test: add extension integration coverage — add unpacked-extension Playwright flows, CSP/package audits, and failure-path coverage.
  - Commit 8: docs: document pageperch setup and privacy — add README.md covering installation, unpacked development, BYOS registration/build configuration, storage semantics, page identity, permissions, privacy, known limitations, and release checks.

  - Before every commit, run all checks available at that stage; from the scaffold commit onward this means formatting check, lint, typecheck, tests, and production build. Inspect the staged diff to keep each commit focused and never commit
    secrets or generated caches.

  ## Assumptions and Deferred Work

  - “Local storage” means chrome.storage.local with unlimitedStorage, not DOM localStorage.
  - Root indexes and custom exclusions are scoped to exact origins because page identity also uses exact origins.
  - Notes contain Gutenberg HTML only; attachments, screenshots, page-content ingestion, AI-agent bridges, collaboration, and content scripts are future work.
  - GitHub authentication, private Git repositories, isomorphic-git, multiple selectable repositories, and “ALL” storage are removed from this implementation.
  - BYOS is the only remote provider exposed in settings, while its S3 repository remains transport-configurable for future providers.
  - The BYOS client ID is public build configuration and will not be treated as a secret; CI builds without it and verifies the disabled-state UX.
