import '../styles/base.css';

export function SidePanelApp() {
  const openSettings = () => {
    void chrome.runtime.openOptionsPage();
  };

  return (
    <main className="app-shell">
      <header className="brand-header">
        <img src="/brand/page-perch-logo.png" alt="" width="48" height="48" />
        <div>
          <h1>PagePerch</h1>
          <p>Notes that stay beside the page.</p>
        </div>
      </header>

      <section className="surface" aria-labelledby="page-note-heading">
        <h2 id="page-note-heading">Notes for this page</h2>
        <p>
          Your private, page-specific workspace is being prepared. Local notes
          remain available even when you are offline.
        </p>
        <p className="status" role="status">
          Local foundation ready
        </p>
      </section>

      <section className="surface" aria-labelledby="settings-heading">
        <h2 id="settings-heading">Preferences</h2>
        <p>
          Editor, page identity, and optional BYOS controls live on the
          PagePerch settings page.
        </p>
        <button type="button" onClick={openSettings}>
          Open settings
        </button>
      </section>
    </main>
  );
}
