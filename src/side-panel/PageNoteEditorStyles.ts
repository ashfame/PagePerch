export interface PageNoteEditorStyleAsset {
  readonly baseURL: string;
  readonly __unstableType: 'theme';
  readonly css: string;
}

export const PAGE_NOTE_EDITOR_WRITING_CSS = `
.editor-styles-wrapper {
  --pageperch-writing-text: #17241b;
  --pageperch-writing-muted: #536158;
  --pageperch-writing-link: #1d6438;
  --pageperch-writing-code-background: #edf2ee;
  --pageperch-writing-mark-background: #fff0a8;
  --pageperch-writing-quote-border: #8aa091;
  color: var(--pageperch-writing-text);
  background: #f8faf8;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 16px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.editor-styles-wrapper .block-editor-block-list__layout.is-root-container > .wp-block {
  margin-block: 0 1rem;
}

.editor-styles-wrapper .block-editor-block-list__layout.is-root-container > .wp-block:last-child {
  margin-bottom: 0;
}

.editor-styles-wrapper p {
  margin-block: 0;
  color: inherit;
  font: inherit;
  overflow-wrap: anywhere;
}

.editor-styles-wrapper h1,
.editor-styles-wrapper h2,
.editor-styles-wrapper h3,
.editor-styles-wrapper h4,
.editor-styles-wrapper h5,
.editor-styles-wrapper h6 {
  margin-block: 0;
  color: inherit;
  font-family: inherit;
  font-weight: 700;
  line-height: 1.22;
  letter-spacing: -0.015em;
  overflow-wrap: anywhere;
  text-wrap: balance;
}

.editor-styles-wrapper h1 {
  font-size: clamp(1.75rem, 9vw, 2.35rem);
}

.editor-styles-wrapper h2 {
  font-size: clamp(1.5rem, 8vw, 2rem);
}

.editor-styles-wrapper h3 {
  font-size: clamp(1.3rem, 7vw, 1.7rem);
}

.editor-styles-wrapper h4 {
  font-size: 1.2rem;
}

.editor-styles-wrapper h5 {
  font-size: 1.08rem;
}

.editor-styles-wrapper h6 {
  color: var(--pageperch-writing-muted);
  font-size: 1rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.editor-styles-wrapper ol,
.editor-styles-wrapper ul {
  margin-block: 0;
  padding-inline-start: 1.55rem;
  color: inherit;
}

.editor-styles-wrapper ol {
  list-style: decimal outside;
}

.editor-styles-wrapper ul {
  list-style: disc outside;
}

.editor-styles-wrapper ol ol,
.editor-styles-wrapper ul ol {
  list-style-type: lower-alpha;
}

.editor-styles-wrapper ol ul,
.editor-styles-wrapper ul ul {
  list-style-type: circle;
}

.editor-styles-wrapper li {
  margin-block: 0.25rem;
  padding-inline-start: 0.15rem;
  color: inherit;
  line-height: 1.55;
}

.editor-styles-wrapper blockquote {
  margin-block: 0;
  padding: 0.15rem 0 0.15rem 1rem;
  border-inline-start: 3px solid var(--pageperch-writing-quote-border);
  color: inherit;
  font-size: 1.03rem;
  font-style: italic;
}

.editor-styles-wrapper blockquote p {
  font-style: inherit;
}

.editor-styles-wrapper cite {
  display: block;
  margin-top: 0.55rem;
  color: var(--pageperch-writing-muted);
  font-size: 0.875rem;
  font-style: normal;
  line-height: 1.45;
}

.editor-styles-wrapper pre {
  max-width: 100%;
  margin-block: 0;
  padding: 0.85rem;
  border: 1px solid var(--pageperch-writing-quote-border);
  border-radius: 0.45rem;
  color: inherit;
  background: var(--pageperch-writing-code-background);
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 0.9rem;
  line-height: 1.55;
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.editor-styles-wrapper code,
.editor-styles-wrapper kbd {
  padding: 0.08em 0.3em;
  border-radius: 0.25rem;
  color: inherit;
  background: var(--pageperch-writing-code-background);
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
}

.editor-styles-wrapper pre code {
  padding: 0;
  border: 0;
  background: transparent;
  font-size: inherit;
}

.editor-styles-wrapper hr {
  width: 100%;
  margin-block: 1.1rem;
  border: 0;
  border-top: 2px solid var(--pageperch-writing-quote-border);
}

.editor-styles-wrapper a {
  color: var(--pageperch-writing-link);
  font-weight: 600;
  text-decoration: underline;
  text-decoration-thickness: 0.08em;
  text-underline-offset: 0.15em;
  overflow-wrap: anywhere;
}

.editor-styles-wrapper strong,
.editor-styles-wrapper b {
  font-weight: 750;
}

.editor-styles-wrapper em,
.editor-styles-wrapper i {
  font-style: italic;
}

.editor-styles-wrapper mark {
  padding-inline: 0.08em;
  color: inherit;
  background: var(--pageperch-writing-mark-background);
}

.editor-styles-wrapper s,
.editor-styles-wrapper del {
  text-decoration: line-through;
  text-decoration-thickness: 0.08em;
}

.editor-styles-wrapper sub,
.editor-styles-wrapper sup {
  position: relative;
  font-size: 0.75em;
  line-height: 0;
  vertical-align: baseline;
}

.editor-styles-wrapper sub {
  bottom: -0.25em;
}

.editor-styles-wrapper sup {
  top: -0.5em;
}

.editor-styles-wrapper br {
  line-height: inherit;
}

@media (prefers-color-scheme: dark) {
  .editor-styles-wrapper {
    --pageperch-writing-text: #eef5f0;
    --pageperch-writing-muted: #b4c1b8;
    --pageperch-writing-link: #73ce90;
    --pageperch-writing-code-background: #243128;
    --pageperch-writing-mark-background: #665b20;
    --pageperch-writing-quote-border: #637568;
    color: var(--pageperch-writing-text);
    background: #101712;
  }
}
`.trim();

export const PAGE_NOTE_EDITOR_STYLES: readonly PageNoteEditorStyleAsset[] =
  Object.freeze([
    Object.freeze({
      baseURL: '',
      __unstableType: 'theme' as const,
      css: PAGE_NOTE_EDITOR_WRITING_CSS,
    }),
  ]);
