# PagePerch

![PagePerch logo](page_perch_logo.png)

PagePerch is a private, offline-first Chrome side-panel extension for keeping one Gutenberg note per web page. Notes save to the local Chrome profile first and remain usable without a network connection. An optional connection to the established [BYOS service](https://byos.ashfame.com) adds automatic S3-backed synchronization without replacing local storage.

## What it does

- Opens from the Chrome toolbar and follows the active HTTP or HTTPS tab.
- Gives every canonical page its own autosaving block-editor document.
- Converts pasted semantic HTML into supported Gutenberg blocks while retaining safe headings, lists, quotes, code, emphasis, and links.
- Can show an opt-in recent-note index on an exact-origin root page such as `https://example.com/`.
- Offers text-focused blocks or a paragraphs-only editor mode.
- Shows the installed extension version on the settings page.
- Follows the browser or operating-system light/dark preference automatically.
- Ignores common tracking parameters when deciding whether two URLs identify the same page.
- Lets users add exact query-parameter exclusions for one exact origin.
- Optionally reconciles notes through BYOS while keeping the local copy authoritative and immediately available.

PagePerch does not inject content scripts, read page content, provide AI features, upload attachments, or run its own backend.

## Requirements

- Google Chrome 114 or newer.
- Node.js 24.18.0.
- npm 11.16.0.
- Linux, macOS, or Windows tooling capable of running the npm scripts. The Playwright extension suite currently targets bundled Chromium on Linux/Xvfb.

The exact Node and npm versions are recorded in `.nvmrc`, `package.json`, and `package-lock.json`.

## Install for development

```sh
nvm install
nvm use
npm ci
npx playwright install chromium
```

Build and validate the unpacked extension:

```sh
npm run build
npm run check
```

`npm run check` runs Prettier verification, ESLint, strict TypeScript checking, the complete Vitest suite with coverage, a deterministic production build, Manifest V3 package and editor CSP audits, and the real-Chromium unpacked-extension tests.

## Load the unpacked extension

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose this repository's generated `dist/` directory.
5. Pin PagePerch to the toolbar if desired.
6. Click the PagePerch toolbar action while an HTTP or HTTPS tab is active.

Use **Reload** on `chrome://extensions` after rebuilding. Keep the absolute `dist/` path unchanged while developing because Chrome derives an unpacked extension ID from its location; changing the path can change the ID, create a fresh extension-local data area, and invalidate an OAuth redirect registration.

The extension works as local-only storage when built without BYOS configuration. Follow the next section before loading the build if live BYOS synchronization is required.

## Configure BYOS

PagePerch integrates with the existing service at `https://byos.ashfame.com`; this repository contains only the extension client.

### Register the public OAuth client

1. Open BYOS **Settings > Connected apps** and create an OAuth app for PagePerch.
2. Configure it as a public client with no client secret.
3. Allow exactly the scopes `storage:app storage:s3`.
4. Build and load PagePerch once so Chrome assigns the final extension ID.
5. Register `https://<extension-id>.chromiumapp.org/` as the exact redirect URI. This is the value returned by `chrome.identity.getRedirectURL()` when PagePerch requests the default callback path.
6. Have a BYOS operator approve the app; authorization is unavailable until its status is `approved`.
7. Copy the displayed public client ID.

For a published build, register the callback for the stable published extension ID. For an unpacked build, keep loading the same absolute `dist/` path so its ID and callback remain stable.

### Build with the public client ID

```sh
VITE_BYOS_CLIENT_ID=client_xxx npm run build
```

The client ID is public build configuration, not a secret. PagePerch never uses or expects a client secret.

Reload the extension from `chrome://extensions`, open PagePerch settings, and select **Connect BYOS**. The authorization-code flow uses PKCE and requests only `storage:app storage:s3`. BYOS issues the bucket alias and temporary S3 credentials; PagePerch never invents or hard-codes a bucket name.

The extension uses these fixed transport settings:

```text
OAuth/API/S3 endpoint: https://byos.ashfame.com
S3 signing region:     us-east-1
S3 signing service:    s3
Addressing:             path style
Remote object prefix:  pageperch/v1/notes/
```

See [byos_integrations.md](byos_integrations.md) for the protocol-level integration contract.

## Use PagePerch

Open a normal HTTP or HTTPS page and click the toolbar action. PagePerch loads that page's cached local note immediately, then saves an actual change 750 milliseconds after editing stops. Navigating or changing tabs flushes a pending local save before the editor switches to the next page.

The save state can report:

- **Saving** while a local write is in progress.
- **Saved locally** when the durable local write succeeded.
- **Waiting to sync** when the exact saved revision remains in the durable outbound queue.
- **Synced to BYOS** after the queued revision has been reconciled.

There is no **Sync now** or remote **Retry** control. Every durable queue entry contains a page key and exact revision and is the sole flag that the page still needs synchronization. The background worker retries automatically after local saves, connection, extension startup, panel opening, identity changes, periodic alarms, and bounded retry alarms. If the BYOS token expires, local editing remains available and settings offers reconnection.

Open PagePerch settings from the side panel or Chrome's extension menu to choose:

- **Text-focused blocks** for paragraphs, headings, lists, quotes, code, preformatted text, separators, inline formatting, and links.
- **Paragraphs only** for paragraph blocks, inline formatting, links, undo, and redo.
- **Show recent notes on root pages** to display other saved notes from the same exact origin; this is off by default.

The settings header shows the exact installed extension version reported by Chrome.

Media, embeds, reusable blocks, remote WordPress APIs, code editing, fullscreen, preview, and unrelated Gutenberg panels are disabled.

When **Show recent notes on root pages** is enabled, an exact-origin root page shows its editable note followed by the most recently saved non-root notes for that exact origin. Selecting an entry opens its canonical HTTP or HTTPS URL in a new tab. When the setting is off, PagePerch does not connect to or query the recent-note index.

## Why a service worker exists

Manifest V3 side panels are user-interface documents that Chrome can close and recreate. They are not a reliable home for scheduled work, tab-wide coordination, OAuth callbacks, or retries. PagePerch therefore uses Chrome's extension service worker as a local background coordinator.

Each page still saves directly to `chrome.storage.local`; a local write is the definition of save success. That same local mutation places the page's exact revision in the durable sync queue. The worker owns the automatic synchronization lifecycle, OAuth/S3 credential use, serialization of competing triggers, and Chrome alarms. Chrome may suspend the worker at any time, so durable notes, OAuth state, and queue intent live in Chrome storage and work resumes safely on the next trigger. Temporary S3 secrets deliberately remain only in worker memory and are requested again after suspension.

The worker is not a server and does not implement BYOS. BYOS remains the established external authorization and S3 service at `byos.ashfame.com`.

## Page identity

Page identity uses the normalized HTTP or HTTPS origin, path, and meaningful query parameters. Schemes, subdomains, non-default ports, trailing slashes, and meaningful query values stay distinct. Fragments are ignored, query keys and values are sorted deterministically, and default ports are normalized by the URL parser.

Built-in exclusions cover `utm_*` and common advertising or analytics parameters such as `gclid`, `fbclid`, `msclkid`, `_ga`, and `_gl`. Settings calls these **Page identity exclusions**: query parameters that do not make a page unique.

Custom exclusions are case-insensitive exact parameter names scoped to one exact origin. Adding an exclusion can make previously separate pages resolve to one identity. When that happens, PagePerch pragmatically stacks all affected notes from oldest to newest, adds a `Source: <original URL>` heading before each note, saves the combined document, and leaves tombstones at the old keys so another device cannot restore stale copies. Removing a rule moves the combined document under its representative URL; it does not try to split the stacked note again.

## Storage and synchronization

Local storage is always enabled and cannot be replaced by BYOS. PagePerch stores versioned note records, settings, the OAuth access token, and revision-only sync queue entries in `chrome.storage.local`. It stores an in-progress PKCE verifier and state in `chrome.storage.session`. Chrome extension storage is private to the extension but is not an encrypted vault; anyone controlling the device or browser profile may be able to access it.

Every remote note or tombstone is one versioned JSON object at `pageperch/v1/notes/{pageKey}.json` in the app-scoped bucket alias issued by BYOS. Reconciliation chooses the record with the newest `savedAt`; a lexicographic revision ID tie-breaker makes exact-timestamp conflicts deterministic. Tombstones are retained indefinitely in the first storage version because no central server can prove that every client has observed a deletion.

The OAuth access token and adjusted expiry are persisted locally so a suspended worker can resume. The issued S3 access key, secret, bucket alias, and expiry are kept only in memory and refreshed as needed. Disconnect clears local OAuth metadata, pending PKCE state, and in-memory S3 credentials while retaining local notes and leaving remote objects untouched. Reconnecting performs a full reconciliation.

## Permissions

PagePerch requests only the following extension capabilities:

| Permission | Reason |
| --- | --- |
| `sidePanel` | Present the note editor beside the active page. |
| `storage` | Persist notes, settings, OAuth state, and durable sync intent in extension storage. |
| `unlimitedStorage` | Avoid the small default extension quota for user-authored Gutenberg documents. |
| `tabs` | Observe the active tab's URL/title and open a selected recent-note URL. PagePerch does not read page DOM content. |
| `identity` | Complete the public OAuth PKCE redirect through `chrome.identity.launchWebAuthFlow`. |
| `alarms` | Resume periodic and bounded automatic synchronization after worker suspension. |
| `https://byos.ashfame.com/*` | Reach the one approved OAuth, credential, and S3 endpoint when BYOS is connected. |

The package has no content scripts, broad web host permission, remote executable code, CDN asset, or page-content access.

## Privacy and security

- Notes, URLs, and titles remain in the local Chrome profile unless BYOS is explicitly connected.
- PagePerch has no analytics, advertising, telemetry, or PagePerch-operated backend.
- A connected build sends OAuth and temporary-credential requests to BYOS and sends note record JSON only through signed, encrypted-in-transit S3 requests to the issued app-scoped bucket.
- PagePerch requests no OpenID, profile, email, or offline-access scope.
- OAuth callback state is checked exactly and PKCE protects the authorization-code exchange.
- S3 secrets, access keys, and bucket aliases are never persisted.
- Production assets are bundled locally under the default Manifest V3 content security policy.
- Unsupported and malformed URLs never reach note storage, and remote records are schema-validated before reconciliation.

See [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for implementation-level boundaries.

## Testing

Run the complete release-equivalent gate:

```sh
npm run check
```

Useful focused commands:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run audit:csp
npm run test:e2e
npm run release:package
```

Set `PAGEPERCH_HEADFUL=1` when running `npm run test:e2e` to display Chromium. The Playwright suite exercises the packaged worker and options page with its runtime version, rendered narrow and wide writing-column insets, short-note viewport fill with visible status, three distinct blank-canvas click-to-focus-before-type positions with persistence/reload, paragraph/heading/list editing and undo, content-driven growth without a nested scrollbar, absence of the two corrected WordPress deprecations, genuine trusted HTML copy/paste with partial-selection and nested-list coverage, safe persistence across panel reload and browser restart, and the default-off then opted-in root recent-note index. It intentionally avoids assertions tied to CSS selector text or exact presentation properties. The native toolbar-to-side-panel host click and visual theme/focus/contrast acceptance remain manual checks because Playwright cannot operate Chrome's browser toolbar and those checks require human visual judgment.

Automated tests never use live BYOS credentials. OAuth, temporary credentials, SigV4/path-style S3 transport, reconciliation, failures, expiry, and retries use controlled mocks; live consent and remote storage remain manual acceptance checks.

## Manual test checklist

Before a release candidate:

- Load `dist/` in Chrome 114 or newer and verify the toolbar action opens the native side panel.
- Edit notes on two HTTP/HTTPS pages, wait for **Saved locally**, reload the panel, restart Chrome, and confirm both notes remain.
- Navigate and switch active tabs while editing and confirm the pending note is saved before PagePerch changes documents.
- Enable **Show recent notes on root pages**, clear a saved note, and confirm it disappears from the root recent-note index.
- With **Show recent notes on root pages** enabled, verify the exact-origin root index excludes another scheme, subdomain, port, and origin and opens the chosen canonical page in one new tab.
- Add an exact-origin exclusion that collapses multiple noted URLs and confirm the resulting document stacks each note oldest-to-newest under its `Source: <original URL>` heading.
- Remove the exclusion and confirm the combined document moves without content loss.
- Verify both editor modes, keyboard navigation, visible focus, a narrow side panel, reduced motion, and live operating-system light/dark changes.
- Paste formatted text containing headings, lists, a quote, code, emphasis, and an HTTPS link from another application; confirm the matching Gutenberg blocks and safe formatting survive save, panel reload, and browser restart.
- Load a build with an approved BYOS client, connect through consent, save a note, and confirm **Waiting to sync** changes to **Synced to BYOS** automatically.
- Use a second Chrome profile connected to the same BYOS authorization to confirm newer notes and tombstones converge in both directions.
- Disconnect or expire the OAuth token while offline, edit several pages, restart Chrome, and confirm the pending count and local notes survive; reconnect and confirm the queue drains automatically.
- Disconnect BYOS and confirm local notes remain while no remote object is deleted.

## Release checks

Start from a clean commit and the pinned toolchain:

```sh
npm ci
npx playwright install chromium
npm run check
npm run release:package
```

`npm run release:package` rebuilds and audits `dist/`, captures one immutable audited snapshot, and creates `.release/pageperch-<version>.zip` plus `.release/pageperch-<version>.zip.sha256`. Archive paths and metadata are deterministic, repeated packaging of identical sources produces identical bytes, and the archive contains the extension files at its root. The command rejects concurrent runs, source/output aliases, symlinks, unsafe paths, source maps, credential-like material, manifest/package version drift, and unaudited mutations. Publication is rollback-safe; if automatic recovery cannot complete, the error reports a retained recovery directory and lock instead of deleting the only prior good artifact.

For version `0.1.5`, verify and inspect the artifact on a system with `sha256sum` and `unzip`:

```sh
cd .release
sha256sum -c pageperch-0.1.5.zip.sha256
unzip -t pageperch-0.1.5.zip
```

Inspect the generated `dist/` directory, verify the intended public `VITE_BYOS_CLIENT_ID` configuration, and load that exact build for the manual checklist. To test the ZIP instead, extract it into a stable directory and select that directory with Chrome's **Load unpacked** control. Never package `.env` files, browser profiles, test artifacts, coverage, source maps, private keys, OAuth tokens, or S3 credentials.

See [docs/DEPLOYMENT_STRATEGY.md](docs/DEPLOYMENT_STRATEGY.md), [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md), and [docs/COMPLIANCE_MATRIX.md](docs/COMPLIANCE_MATRIX.md) for the maintained release evidence.

## Troubleshooting

### BYOS says it is unavailable in this build

Rebuild with `VITE_BYOS_CLIENT_ID=client_xxx npm run build`, then reload the extension from `chrome://extensions`. The value is embedded at build time.

### OAuth reports an invalid client or redirect

Confirm the BYOS connected app is approved, configured as a public client, allows only the required storage scopes, and contains the exact `https://<current-extension-id>.chromiumapp.org/` redirect. If the unpacked `dist/` path changed, Chrome may have assigned a different extension ID.

### PagePerch says reconnect is required

The OAuth access token expired or is unusable. Local notes and queued revisions remain safe; open settings and select **Reconnect BYOS**. Automatic reconciliation resumes after authorization.

### A page keeps waiting to sync

Open settings and check the connection state, token expiry, aggregate pending count, and latest error. There is no manual remote retry button because the durable queue retains the exact revision and the worker retries on later alarms, panel opens, startup, reconnection, and successful saves.

### A note cannot save locally

Use the local save retry shown beside the note, verify the Chrome profile has writable storage, and inspect the extension service-worker console from `chrome://extensions`. Do not disconnect or clear extension data as a first troubleshooting step.

### The toolbar does not open the side panel

Confirm Chrome is version 114 or newer, reload PagePerch on `chrome://extensions`, and click the PagePerch action while a normal HTTP or HTTPS tab is active. Chrome internal pages, extension pages, files, and other schemes show an unsupported-page state.

## Known limitations

- Chrome 114+ is the only supported runtime; cross-browser packaging and Chrome Web Store publication are not part of this release.
- Notes are Gutenberg HTML only; attachments, screenshots, page-content capture, content scripts, collaboration, and AI features are deferred.
- BYOS is the only remote provider exposed in settings.
- Tombstones have no garbage-collection policy in storage version 1.
- Live BYOS authorization/S3 behavior and the native toolbar host require manual verification.
- The isolated block editor is an experimental pinned dependency with a large initial side-panel bundle and known transitive advisories that currently have no compatible automated upgrade.
- The editor dependency currently emits Sass deprecation warnings during builds; the audited production output remains valid.

## Project documentation

- [Implementation plan](plan.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security model](docs/SECURITY_MODEL.md)
- [Test strategy](docs/TEST_STRATEGY.md)
- [Deployment strategy](docs/DEPLOYMENT_STRATEGY.md)
- [Compliance matrix](docs/COMPLIANCE_MATRIX.md)
- [Roadmap](docs/ROADMAP.md)
