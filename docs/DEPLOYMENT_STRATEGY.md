# Deployment Strategy

`npm ci` followed by `npm run check` produces and audits a static `dist/` directory suitable for Chrome’s unpacked-extension loader. The build contains no secrets; `VITE_BYOS_CLIENT_ID` is optional public configuration and absent builds must present a disabled connection state. Complete developer, unpacked-load, connected-app registration, manual acceptance, troubleshooting, and permission instructions live in `README.md`.

CI runs on the pinned Node.js 24.18.0 toolchain, verifies formatting/lint/types/tests/build/audit/browser smoke from the committed lockfile, and retains only safe failure artifacts. Release packaging starts from a clean commit and runs `npm run release:package`, which rebuilds and audits `dist/`, captures one immutable snapshot, and writes a deterministic root-layout ZIP plus SHA-256 sidecar under ignored `.release/`.

The release packager uses an exclusive physical-output lock, real-path source/output separation, fixed ZIP timestamps and modes, sorted UTF-8 paths, CRC-32 entries, Chrome-compatible version-derived names, classic-ZIP/Node allocation preflight, and exact manifest/package version binding. It rejects links, non-files, traversal, generated/profile/environment/key/source-map paths, audit violations, and snapshot drift. Archive/checksum publication is paired and rollback-safe; incomplete rollback or cleanup retains the recovery directory, prior artifacts, and lock and reports their exact physical paths instead of deleting the only recoverable copy.

Create annotated release tags as `v<version>` with the annotation `PagePerch <version> — Minor update`. “Minor update” is the standing release classification for every future PagePerch version unless the user explicitly changes the convention.

Development builds may use a transient extension ID. Production OAuth requires an approved public BYOS app registration whose redirect allowlist contains the exact `https://<extension-id>.chromiumapp.org/` value returned by `chrome.identity.getRedirectURL()` for the final published extension ID, with no client secret and only `storage:app storage:s3`.

Chrome Web Store publication is outside the current implementation and manual-testing scope.
