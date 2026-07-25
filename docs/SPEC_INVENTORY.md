# Specification Inventory

## Governing Inputs

- `plan.md`: Product scope, architecture, UX, data model, synchronization, testing, documentation, and delivery requirements. This is the primary governing specification.
- `byos_integrations.md`: Production OAuth 2.0 authorization-code-with-PKCE and temporary S3 credential flow for `https://byos.ashfame.com`. This governs remote authentication and transport details.
- `page_perch_logo.png`: Supplied 332×310 RGBA source artwork for generated extension icons and product branding.
- User-provided global `AGENTS.md` instructions: Keep Markdown prose unwrapped; perform all changes in a task-specific worktree while keeping the primary checkout unchanged.

## External Platform References

- Chrome Side Panel API: `https://developer.chrome.com/docs/extensions/reference/api/sidePanel`; target Chrome 114+ and configure the toolbar action to open the global panel.
- Chrome Manifest V3 platform and CSP: package all executable code locally and reject remote code, unsafe evaluation, leaked source maps, and undeclared resources.
- Chrome Identity API: use `chrome.identity.getRedirectURL()` and `chrome.identity.launchWebAuthFlow()` for public-client OAuth.
- Node.js release schedule: `https://nodejs.org/en/about/previous-releases`; the plan pins Node.js 24.18.0 and local nvm metadata confirms it as the available latest Krypton LTS.
- Isolated Block Editor: `https://github.com/Automattic/isolated-block-editor`; use the scoped `@automattic/isolated-block-editor@2.30.0` package with `allowApi: false`, local Gutenberg CSS, and an early production CSP audit.
- WordPress block serialization default parser: `https://developer.wordpress.org/block-editor/reference-guides/packages/packages-block-serialization-default-parser/`; the pinned Gutenberg graph uses it for stored comment-delimited block documents, while `@wordpress/blocks` raw/paste handling converts incoming semantic HTML into blocks.

## Interpretation Rules

- When `plan.md` and `byos_integrations.md` overlap, the BYOS spec governs HTTP field names, endpoint paths, scope, and one-time credential handling while the plan governs PagePerch storage behavior and UI.
- No deferred feature may be inferred into v1: content scripts, page scraping, media attachments, AI features, collaboration, GitHub storage, selectable remote providers, and public-store publication are out of scope.
- Acceptance claims require a passing automated test or a documented manual verification; scaffolded behavior is not considered implemented.
