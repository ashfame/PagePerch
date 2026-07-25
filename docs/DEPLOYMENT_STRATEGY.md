# Deployment Strategy

`npm ci` followed by `npm run check` produces and audits a static `dist/` directory suitable for Chrome’s unpacked-extension loader. The build contains no secrets; `VITE_BYOS_CLIENT_ID` is optional public configuration and absent builds must present a disabled connection state.

CI runs on the pinned Node.js 24.18.0 toolchain, verifies formatting/lint/types/tests/build/audit/browser smoke from the committed lockfile, and retains only safe failure artifacts. Release packaging starts from a clean commit, rebuilds from `npm ci`, audits `dist/`, creates a deterministic archive where feasible, and records SHA-256 checksums.

Development builds may use a transient extension ID. Production OAuth requires an approved BYOS app registration whose redirect allowlist contains the stable `chrome.identity.getRedirectURL()` value for the final published extension ID.

Chrome Web Store publication is outside the current implementation and manual-testing scope.
