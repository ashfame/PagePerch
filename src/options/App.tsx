import '../styles/base.css';

const settingsSections = [
  {
    heading: 'Editor',
    copy: 'PagePerch will offer focused Gutenberg writing modes with media, embeds, remote APIs, and unrelated publishing controls disabled.',
  },
  {
    heading: 'Page identity',
    copy: 'Page identity exclusions will let you decide which exact-origin query parameters do not make a page unique.',
  },
  {
    heading: 'Storage & sync',
    copy: 'Local storage is always available. Optional Local + BYOS synchronization will be configured here without changing local ownership.',
  },
] as const;

export function OptionsApp() {
  return (
    <main className="app-shell">
      <header className="brand-header">
        <img src="/brand/page-perch-logo.png" alt="" width="48" height="48" />
        <div>
          <h1>PagePerch settings</h1>
          <p>Private notes, configured with clear boundaries.</p>
        </div>
      </header>

      <div className="settings-grid" aria-label="Settings overview">
        {settingsSections.map(({ heading, copy }) => (
          <section
            className="surface"
            key={heading}
            aria-labelledby={`${heading.toLowerCase().replaceAll(' ', '-')}-heading`}
          >
            <h2 id={`${heading.toLowerCase().replaceAll(' ', '-')}-heading`}>
              {heading}
            </h2>
            <p>{copy}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
