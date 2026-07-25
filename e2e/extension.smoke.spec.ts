import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type Worker,
} from '@playwright/test';

const distributionDirectory = resolve(import.meta.dirname, '../dist');

interface ExtensionSession {
  context: BrowserContext;
  extensionId: string;
  page: Page;
  serviceWorker: Worker;
  userDataDirectory: string;
}

interface CapturedRuntimeErrors {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
}

interface StoredNote {
  readonly schemaVersion: 1;
  readonly pageKey: string;
  readonly canonicalUrl: string;
  readonly representativeUrl: string;
  readonly origin: string;
  readonly title: string;
  readonly contentHtml: string;
  readonly contentHash: string;
  readonly savedAt: string;
  readonly revisionId: string;
}

interface FixtureServer {
  close(): Promise<void>;
  readonly origin: string;
}

function normalizeError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error
    ? error
    : new Error(fallbackMessage, { cause: error });
}

async function launchExtension(
  existingUserDataDirectory?: string,
): Promise<ExtensionSession> {
  const createdUserDataDirectory = existingUserDataDirectory === undefined;
  const userDataDirectory =
    existingUserDataDirectory ??
    (await mkdtemp(resolve(tmpdir(), 'pageperch-playwright-')));
  let context: BrowserContext | undefined;

  try {
    context = await chromium.launchPersistentContext(userDataDirectory, {
      args: [
        `--disable-extensions-except=${distributionDirectory}`,
        `--load-extension=${distributionDirectory}`,
      ],
      channel: 'chromium',
      headless: process.env.PAGEPERCH_HEADFUL !== '1',
    });
    let [serviceWorker] = context.serviceWorkers();
    serviceWorker ??= await context.waitForEvent('serviceworker');
    const extensionId = new URL(serviceWorker.url()).host;
    const page = await context.newPage();

    return { context, extensionId, page, serviceWorker, userDataDirectory };
  } catch (error) {
    try {
      await context?.close();
    } catch {
      // Preserve the initialization failure after best-effort rollback.
    }

    if (createdUserDataDirectory) {
      try {
        await rm(userDataDirectory, { force: true, recursive: true });
      } catch {
        // Preserve the initialization failure after best-effort rollback.
      }
    }

    throw normalizeError(error, 'PagePerch could not initialize Chromium.');
  }
}

async function restartExtension(
  session: ExtensionSession,
): Promise<ExtensionSession> {
  await session.context.close();

  return launchExtension(session.userDataDirectory);
}

async function closeExtension(session: ExtensionSession): Promise<void> {
  let closeError: Error | undefined;
  let removalError: Error | undefined;

  try {
    await session.context.close();
  } catch (error) {
    closeError = normalizeError(
      error,
      'PagePerch could not close its browser context.',
    );
  } finally {
    try {
      await rm(session.userDataDirectory, { force: true, recursive: true });
    } catch (error) {
      removalError = normalizeError(
        error,
        'PagePerch could not remove its temporary browser profile.',
      );
    }
  }

  if (closeError !== undefined && removalError !== undefined) {
    throw new AggregateError(
      [closeError, removalError],
      'PagePerch could not close its browser context or remove its temporary profile.',
    );
  }

  if (closeError !== undefined) {
    throw closeError;
  }

  if (removalError !== undefined) {
    throw removalError;
  }
}

async function closeExtensionAndFixtureServer(
  session: ExtensionSession | undefined,
  fixtureServer: FixtureServer,
): Promise<void> {
  let extensionCleanupError: Error | undefined;
  let serverCleanupError: Error | undefined;

  if (session !== undefined) {
    try {
      await closeExtension(session);
    } catch (error) {
      extensionCleanupError = normalizeError(
        error,
        'PagePerch could not release its browser resources.',
      );
    }
  }

  try {
    await fixtureServer.close();
  } catch (error) {
    serverCleanupError = normalizeError(
      error,
      'PagePerch could not close its HTTP fixture server.',
    );
  }

  if (extensionCleanupError !== undefined && serverCleanupError !== undefined) {
    throw new AggregateError(
      [extensionCleanupError, serverCleanupError],
      'PagePerch could not release its browser and HTTP fixture resources.',
    );
  }

  if (extensionCleanupError !== undefined) {
    throw extensionCleanupError;
  }

  if (serverCleanupError !== undefined) {
    throw serverCleanupError;
  }
}

function captureRuntimeErrors(
  context: BrowserContext,
  errors: CapturedRuntimeErrors,
): void {
  const observedPages = new WeakSet<Page>();
  const observePage = (page: Page): void => {
    if (observedPages.has(page)) {
      return;
    }

    observedPages.add(page);
    page.on('pageerror', (error) => {
      errors.pageErrors.push(error.message);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.consoleErrors.push(message.text());
      }
    });
  };

  context.pages().forEach(observePage);
  context.on('page', observePage);
}

async function routeFixture(
  context: BrowserContext,
  url: string,
  title: string,
): Promise<void> {
  await context.route(url, async (route) => {
    await route.fulfill({
      body: `<!doctype html><html><head><title>${title}</title></head><body><main>${title}</main></body></html>`,
      contentType: 'text/html',
      status: 200,
    });
  });
}

async function startFixtureServer(
  titlesByRequestPath: Readonly<Record<string, string>>,
): Promise<FixtureServer> {
  const server = createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    const title = titlesByRequestPath[request.url ?? ''];

    if (title === undefined) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not found');
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html><head><title>${title}</title></head><body><main>${title}</main></body></html>`,
    );
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolveClose) => {
      server.close(() => {
        resolveClose();
      });
    });
    throw new Error('The fixture server did not expose a TCP address.');
  }

  return {
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error === undefined) {
            resolveClose();
          } else {
            rejectClose(error);
          }
        });
      }),
    origin: `http://127.0.0.1:${String(address.port)}`,
  };
}

async function activateTabForUrl(
  serviceWorker: Worker,
  url: string,
): Promise<number> {
  const tabId = await serviceWorker.evaluate(async (expectedUrl) => {
    const tab = (await chrome.tabs.query({})).find(
      (candidate) => candidate.url === expectedUrl,
    );

    if (tab?.id === undefined) {
      throw new Error(`The fixture tab for ${expectedUrl} is missing.`);
    }

    await chrome.tabs.update(tab.id, { active: true });
    return tab.id;
  }, url);

  return tabId;
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function storedNote(
  canonicalUrl: string,
  title: string,
  visibleText: string,
): StoredNote {
  const contentHtml = `<!-- wp:paragraph -->\n<p>${visibleText}</p>\n<!-- /wp:paragraph -->`;

  return {
    schemaVersion: 1,
    pageKey: sha256Base64Url(canonicalUrl),
    canonicalUrl,
    representativeUrl: canonicalUrl,
    origin: new URL(canonicalUrl).origin,
    title,
    contentHtml,
    contentHash: sha256Base64Url(contentHtml),
    savedAt: '2026-07-25T08:00:00.000Z',
    revisionId: `e2e-${sha256Base64Url(canonicalUrl).slice(0, 16)}`,
  };
}

async function seedStoredNotes(
  serviceWorker: Worker,
  notes: readonly StoredNote[],
): Promise<void> {
  const storageValues: Record<string, unknown> = {};
  const pageKeysByOrigin = new Map<string, string[]>();

  for (const note of notes) {
    storageValues[`pageperch:v1:notes:${note.pageKey}`] = note;
    const pageKeys = pageKeysByOrigin.get(note.origin) ?? [];
    pageKeys.push(note.pageKey);
    pageKeysByOrigin.set(note.origin, pageKeys);
  }

  for (const [origin, pageKeys] of pageKeysByOrigin) {
    storageValues[
      `pageperch:v1:note-origin-indexes:${encodeURIComponent(origin)}`
    ] = {
      schemaVersion: 1,
      origin,
      pageKeys: [...pageKeys].sort(),
    };
  }

  await serviceWorker.evaluate(
    async (values) => chrome.storage.local.set(values),
    storageValues,
  );
}

async function persistRecentNotesPreference(
  serviceWorker: Worker,
  showRecentNotesOnOrigin: boolean,
): Promise<void> {
  await serviceWorker.evaluate(
    async (enabled) =>
      chrome.storage.local.set({
        'pageperch:v1:settings': {
          schemaVersion: 1,
          editorMode: 'text-focused-blocks',
          showRecentNotesOnOrigin: enabled,
          pageIdentityExclusions: [],
        },
      }),
    showRecentNotesOnOrigin,
  );
}

async function readStoredNote(
  serviceWorker: Worker,
  note: StoredNote,
): Promise<unknown> {
  const storageKey = `pageperch:v1:notes:${note.pageKey}`;

  return serviceWorker.evaluate(async (key) => {
    const stored = await chrome.storage.local.get(key);
    return stored[key];
  }, storageKey);
}

async function expectSimplifiedEditorReady(
  panelPage: Page,
  pageUrl: string,
  pageTitle: string,
): Promise<Locator> {
  const shell = panelPage.getByTestId('page-document-shell');
  await expect(shell).toHaveAttribute(
    'data-page-key',
    sha256Base64Url(pageUrl),
  );
  const editor = panelPage.getByRole('region', {
    name: 'Page note editor',
  });
  await expect(editor).toHaveAttribute('aria-busy', 'false', {
    timeout: 15_000,
  });
  const editable = editor.locator('[contenteditable="true"]').first();
  await expect(editable).toBeVisible();

  await expect(panelPage.getByText('Page note', { exact: true })).toHaveCount(
    0,
  );
  await expect(panelPage.getByText(pageTitle, { exact: true })).toHaveCount(0);
  await expect(
    panelPage.getByText(
      `${new URL(pageUrl).pathname}${new URL(pageUrl).search}`,
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(
    panelPage.getByText(
      'Write a private note using the available local text blocks.',
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(
    panelPage.getByText('Loading cached note', { exact: true }),
  ).toHaveCount(0);
  await expect(
    panelPage.getByText('Loading note editor', { exact: true }),
  ).toHaveCount(0);
  await expect(
    editor.locator('button:visible, [role="button"]:visible'),
  ).toHaveCount(0);
  await expect(
    editor.locator(
      '.interface-interface-skeleton__header:visible, .edit-post-header:visible, .editor-header:visible, [role="toolbar"]:visible',
    ),
  ).toHaveCount(0);

  return editable;
}

async function expectStoredNoteVisible(
  panelPage: Page,
  pageUrl: string,
  pageTitle: string,
  visibleText: string,
): Promise<void> {
  await expectSimplifiedEditorReady(panelPage, pageUrl, pageTitle);
  await expect(panelPage.getByText(visibleText, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    panelPage.getByText('This note could not be opened safely'),
  ).toHaveCount(0);
}

async function focusWithKeyboard(
  page: Page,
  target: Locator,
  maximumTabs = 12,
): Promise<void> {
  if (await target.evaluate((element) => element === document.activeElement)) {
    return;
  }

  for (let index = 0; index < maximumTabs; index += 1) {
    await page.keyboard.press('Tab');

    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      return;
    }
  }

  throw new Error(
    `Keyboard focus did not reach the target within ${String(maximumTabs)} Tab presses.`,
  );
}

test('loads the unpacked module worker and both branded React surfaces', async () => {
  const session = await launchExtension();

  try {
    expect(new URL(session.serviceWorker.url()).pathname).toBe(
      '/service-worker.js',
    );
    await expect
      .poll(() =>
        session.serviceWorker.evaluate(() =>
          chrome.sidePanel.getPanelBehavior(),
        ),
      )
      .toEqual({ openPanelOnActionClick: true });

    await session.page.goto(
      `chrome-extension://${session.extensionId}/options.html`,
    );
    await expect(
      session.page.getByRole('heading', {
        level: 1,
        name: 'PagePerch settings',
      }),
    ).toBeVisible();
    await expect(
      session.page.getByText(
        'BYOS connection is unavailable because this build has no public client ID.',
      ),
    ).toBeVisible();
    await expect(
      session.page.getByRole('button', { name: 'Connect BYOS' }),
    ).toBeDisabled();

    await session.page.setViewportSize({ width: 280, height: 720 });
    await session.page.emulateMedia({
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    await session.page.goto(
      `chrome-extension://${session.extensionId}/side-panel.html`,
    );
    await expect(
      session.page.getByRole('heading', { level: 1, name: 'PagePerch' }),
    ).toBeVisible();
    await expect(
      session.page.getByRole('heading', {
        level: 2,
        name: "Notes aren't available here",
      }),
    ).toBeVisible();
    await expect(session.page.getByRole('status')).toContainText(
      'chrome-extension: page type is not supported',
    );

    await expect(
      session.page.getByRole('heading', { name: 'Preferences' }),
    ).toHaveCount(0);
    const button = session.page.getByRole('button', { name: 'Settings' });
    await focusWithKeyboard(session.page, button);
    await expect(button).toBeFocused();

    const visualState = await button.evaluate((element) => {
      const styles = getComputedStyle(element);
      const buttonBounds = element.getBoundingClientRect();
      const headerBounds = element
        .closest('.brand-header')
        ?.getBoundingClientRect();
      return {
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        buttonBackgroundColor: styles.backgroundColor,
        buttonBorderWidth: styles.borderTopWidth,
        fitsViewport: document.documentElement.scrollWidth <= window.innerWidth,
        outlineStyle: styles.outlineStyle,
        outlineWidth: styles.outlineWidth,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        rightGap:
          headerBounds === undefined
            ? Number.POSITIVE_INFINITY
            : headerBounds.right - buttonBounds.right,
        textDecorationLine: styles.textDecorationLine,
        transitionDurations: styles.transitionDuration
          .split(',')
          .map((duration) => Number.parseFloat(duration)),
      };
    });

    expect(visualState).toMatchObject({
      backgroundColor: 'rgb(16, 23, 18)',
      buttonBackgroundColor: 'rgba(0, 0, 0, 0)',
      buttonBorderWidth: '0px',
      fitsViewport: true,
      outlineStyle: 'solid',
      outlineWidth: '3px',
      reducedMotion: true,
      textDecorationLine: 'underline',
    });
    expect(visualState.rightGap).toBeLessThanOrEqual(1);
    expect(Math.max(...visualState.transitionDurations)).toBeLessThanOrEqual(
      0.001,
    );
  } finally {
    await closeExtension(session);
  }
});

test('opens the packaged editor for a supported HTTP tab without fatal runtime errors', async () => {
  const session = await launchExtension();
  const fixtureUrl = 'https://pageperch.test/editor-fixture';
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  try {
    await session.page.route(fixtureUrl, async (route) => {
      await route.fulfill({
        body: '<!doctype html><html><head><title>PagePerch editor fixture</title></head><body><main>Fixture page</main></body></html>',
        contentType: 'text/html',
        status: 200,
      });
    });
    await session.page.goto(fixtureUrl);
    const fixtureTabId = await session.serviceWorker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find(
        (candidate) => candidate.url === url,
      );

      return tab?.id;
    }, fixtureUrl);

    expect(fixtureTabId).toBeDefined();
    const panelPage = await session.context.newPage();
    await panelPage.setViewportSize({ width: 280, height: 720 });
    panelPage.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });
    panelPage.on('console', (message) => {
      const text = message.text();

      if (
        message.type() === 'error' ||
        /core\/patterns|already registered|invalid store/i.test(text)
      ) {
        consoleErrors.push(`${message.type()}: ${text}`);
      }
    });
    await panelPage.goto(
      `chrome-extension://${session.extensionId}/side-panel.html`,
    );
    await session.serviceWorker.evaluate(async (tabId) => {
      if (tabId === undefined) {
        throw new Error('The supported fixture tab is missing.');
      }

      await chrome.tabs.update(tabId, { active: true });
    }, fixtureTabId);

    await expectSimplifiedEditorReady(
      panelPage,
      fixtureUrl,
      'PagePerch editor fixture',
    );
    const editor = panelPage.getByRole('region', {
      name: 'Page note editor',
    });
    const root = editor.locator(
      '.block-editor-block-list__layout.is-root-container',
    );
    await expect(root).toBeVisible();
    expect(
      await root.evaluate((rootElement) => {
        const rootStyles = getComputedStyle(rootElement);
        const writingFlow = rootElement.closest('.block-editor-writing-flow');
        const writingFlowStyles =
          writingFlow === null ? undefined : getComputedStyle(writingFlow);

        return {
          paddingBottom: writingFlowStyles?.paddingBottom,
          paddingLeft: rootStyles.paddingLeft,
          paddingRight: rootStyles.paddingRight,
          paddingTop: writingFlowStyles?.paddingTop,
        };
      }),
    ).toEqual({
      paddingBottom: '0px',
      paddingLeft: '16px',
      paddingRight: '16px',
      paddingTop: '0px',
    });
    await panelPage.setViewportSize({ width: 640, height: 720 });
    expect(
      await root.evaluate((rootElement) => {
        const styles = getComputedStyle(rootElement);
        return [styles.paddingLeft, styles.paddingRight];
      }),
    ).toEqual(['16px', '16px']);
    await panelPage.setViewportSize({ width: 280, height: 720 });

    const noteStatus = panelPage.locator('.note-status');
    await expect(noteStatus).toBeVisible();
    const shortNoteLayout = await root.evaluate((rootElement) => {
      const editorRegion = rootElement.closest('.page-note-editor');
      const noteArea = rootElement.closest('.note-editor-area');
      const status = noteArea?.querySelector('.note-status');
      const lastBlock = [...rootElement.children]
        .filter((element) => element.matches('.wp-block'))
        .at(-1);

      if (
        editorRegion === null ||
        status === null ||
        status === undefined ||
        lastBlock === undefined
      ) {
        throw new Error('The short-note layout is incomplete.');
      }

      const editorBounds = editorRegion.getBoundingClientRect();
      const lastBlockBounds = lastBlock.getBoundingClientRect();
      const statusBounds = status.getBoundingClientRect();

      return {
        canvasBelowLastBlock: editorBounds.bottom - lastBlockBounds.bottom,
        statusBottom: statusBounds.bottom,
        viewportHeight: window.innerHeight,
      };
    });
    expect(shortNoteLayout.canvasBelowLastBlock).toBeGreaterThan(24);
    expect(shortNoteLayout.statusBottom).toBeLessThanOrEqual(
      shortNoteLayout.viewportHeight + 1,
    );
    await expect(
      panelPage.getByText('This note could not be opened safely'),
    ).toHaveCount(0);

    await expect
      .poll(() => ({ consoleErrors, pageErrors }))
      .toEqual({ consoleErrors: [], pageErrors: [] });
  } finally {
    await closeExtension(session);
  }
});

test('tracks supported-tab navigation and preserves a local note through panel and browser restarts', async () => {
  test.setTimeout(60_000);
  let session = await launchExtension();
  const firstUrl = 'https://pageperch.test/navigation-first';
  const secondUrl = 'https://pageperch.test/navigation-second';
  const persistedText = 'Persisted through a real Chromium restart';
  const note = storedNote(secondUrl, 'Navigation destination', persistedText);
  const errors: CapturedRuntimeErrors = {
    consoleErrors: [],
    pageErrors: [],
  };

  try {
    captureRuntimeErrors(session.context, errors);
    await routeFixture(session.context, firstUrl, 'Navigation first fixture');
    await routeFixture(session.context, secondUrl, 'Navigation second fixture');
    await session.page.goto(firstUrl);

    let panelPage = await session.context.newPage();
    await panelPage.goto(
      `chrome-extension://${session.extensionId}/side-panel.html`,
    );
    await activateTabForUrl(session.serviceWorker, firstUrl);
    await expectSimplifiedEditorReady(
      panelPage,
      firstUrl,
      'Navigation first fixture',
    );

    await session.page.goto(secondUrl);
    const editable = await expectSimplifiedEditorReady(
      panelPage,
      secondUrl,
      'Navigation second fixture',
    );
    expect(await readStoredNote(session.serviceWorker, note)).toBeUndefined();
    await focusWithKeyboard(panelPage, editable, 24);
    await expect(editable).toBeFocused();
    await panelPage.keyboard.type(persistedText);
    await expect(editable).toContainText(persistedText);

    await expect
      .poll(async () => {
        const stored = (await readStoredNote(session.serviceWorker, note)) as
          Partial<StoredNote> | undefined;
        return stored?.contentHtml;
      })
      .toContain(persistedText);

    await panelPage.keyboard.press('Control+z');
    await expect(editable).not.toContainText(persistedText);
    await panelPage.keyboard.press('Control+Shift+z');
    await expect(editable).toContainText(persistedText);

    const documentHeightBeforeGrowth = await panelPage.evaluate(
      () => document.documentElement.scrollHeight,
    );
    const lastExpansionLine = 'Expansion line 24 keeps the document growing';
    for (let index = 1; index <= 24; index += 1) {
      await panelPage.keyboard.press('End');
      await panelPage.keyboard.press('Enter');
      await panelPage.keyboard.type(
        index === 24
          ? lastExpansionLine
          : `Expansion line ${String(index)} adds local note content`,
      );
    }
    await expect(
      panelPage.getByText(lastExpansionLine, { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        panelPage.evaluate(() => document.documentElement.scrollHeight),
      )
      .toBeGreaterThan(documentHeightBeforeGrowth);
    const overflowState = await panelPage
      .getByRole('region', { name: 'Page note editor' })
      .evaluate((editor) => {
        const innerVerticalScrollers = [editor, ...editor.querySelectorAll('*')]
          .filter((element) => {
            const htmlElement = element as HTMLElement;
            const overflowY = getComputedStyle(htmlElement).overflowY;

            return (
              (overflowY === 'auto' || overflowY === 'scroll') &&
              htmlElement.scrollHeight > htmlElement.clientHeight + 1
            );
          })
          .map((element) => (element as HTMLElement).className);

        return {
          documentHeight: document.documentElement.scrollHeight,
          innerVerticalScrollers,
          viewportHeight: window.innerHeight,
        };
      });
    expect(overflowState.documentHeight).toBeGreaterThan(
      overflowState.viewportHeight,
    );
    expect(overflowState.innerVerticalScrollers).toEqual([]);
    await expect
      .poll(async () => {
        const stored = (await readStoredNote(session.serviceWorker, note)) as
          Partial<StoredNote> | undefined;
        return stored?.contentHtml;
      })
      .toContain(lastExpansionLine);

    await panelPage.reload();
    await expectStoredNoteVisible(
      panelPage,
      secondUrl,
      'Navigation second fixture',
      persistedText,
    );
    await expect(
      panelPage.getByText(lastExpansionLine, { exact: true }),
    ).toBeVisible();

    const firstExtensionId = session.extensionId;
    session = await restartExtension(session);
    expect(session.extensionId).toBe(firstExtensionId);
    captureRuntimeErrors(session.context, errors);
    await routeFixture(session.context, secondUrl, 'Navigation second fixture');
    await session.page.goto(secondUrl);
    panelPage = await session.context.newPage();
    await panelPage.goto(
      `chrome-extension://${session.extensionId}/side-panel.html`,
    );
    await activateTabForUrl(session.serviceWorker, secondUrl);

    await expectStoredNoteVisible(
      panelPage,
      secondUrl,
      'Navigation second fixture',
      persistedText,
    );
    await expect(
      panelPage.getByText(lastExpansionLine, { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => errors)
      .toEqual({ consoleErrors: [], pageErrors: [] });
  } finally {
    await closeExtension(session);
  }
});

test('refreshes the exact-origin root index from storage and opens only its canonical note tab', async () => {
  const fixtureServer = await startFixtureServer({
    '/': 'PagePerch origin root',
    '/article?view=notes': 'Saved canonical article',
    '/subscription': 'Subscription article',
  });
  const rootUrl = `${fixtureServer.origin}/`;
  const canonicalNoteUrl = `${fixtureServer.origin}/article?view=notes`;
  const subscriptionNoteUrl = `${fixtureServer.origin}/subscription`;
  const unrelatedUrl = 'https://unrelated.test/article';
  const canonicalNote = storedNote(
    canonicalNoteUrl,
    'Saved canonical article',
    'Exact-origin note',
  );
  const unrelatedNote = storedNote(
    unrelatedUrl,
    'Unrelated article',
    'Different origin note',
  );
  const subscriptionNote = storedNote(
    subscriptionNoteUrl,
    'Subscription article',
    'Storage subscription note',
  );
  const errors: CapturedRuntimeErrors = {
    consoleErrors: [],
    pageErrors: [],
  };
  let session: ExtensionSession | undefined;

  try {
    const launchedSession = await launchExtension();
    session = launchedSession;
    captureRuntimeErrors(launchedSession.context, errors);
    await launchedSession.page.goto(rootUrl);
    await seedStoredNotes(launchedSession.serviceWorker, [
      canonicalNote,
      unrelatedNote,
    ]);
    const panelPage = await launchedSession.context.newPage();
    await panelPage.goto(
      `chrome-extension://${launchedSession.extensionId}/side-panel.html`,
    );
    await activateTabForUrl(launchedSession.serviceWorker, rootUrl);
    await expectSimplifiedEditorReady(
      panelPage,
      rootUrl,
      'PagePerch origin root',
    );

    await expect(
      panelPage.getByRole('heading', {
        level: 2,
        name: 'Recent notes on this origin',
      }),
    ).toHaveCount(0);
    await expect(
      panelPage.getByText(canonicalNote.title, { exact: true }),
    ).toHaveCount(0);

    await persistRecentNotesPreference(launchedSession.serviceWorker, true);
    await panelPage.reload();
    await expect(
      panelPage.getByRole('heading', {
        level: 2,
        name: 'Recent notes on this origin',
      }),
    ).toBeVisible();
    await expect(
      panelPage.getByRole('heading', {
        level: 3,
        name: canonicalNote.title,
      }),
    ).toBeVisible();
    await expect(
      panelPage.locator('.recent-notes-list > .recent-note-item'),
    ).toHaveCount(1);
    await expect(panelPage.getByText(unrelatedNote.title)).toHaveCount(0);

    await seedStoredNotes(launchedSession.serviceWorker, [
      canonicalNote,
      subscriptionNote,
      unrelatedNote,
    ]);
    await expect(
      panelPage.getByRole('heading', {
        level: 3,
        name: subscriptionNote.title,
      }),
    ).toBeVisible();
    await expect(
      panelPage.locator('.recent-notes-list > .recent-note-item'),
    ).toHaveCount(2);
    await expect(panelPage.getByText(unrelatedNote.title)).toHaveCount(0);

    const knownTabIds = await launchedSession.serviceWorker.evaluate(async () =>
      (await chrome.tabs.query({})).flatMap((tab) =>
        tab.id === undefined ? [] : [tab.id],
      ),
    );
    const openedPagePromise = launchedSession.context.waitForEvent('page');
    await panelPage
      .getByRole('button', {
        name: `Open ${canonicalNote.title} in new tab`,
      })
      .click();
    const openedPage = await openedPagePromise;
    await openedPage.waitForURL(canonicalNoteUrl);

    await expect
      .poll(() =>
        launchedSession.serviceWorker.evaluate(
          async (existingTabIds) =>
            (await chrome.tabs.query({}))
              .filter(
                (tab) =>
                  tab.id !== undefined && !existingTabIds.includes(tab.id),
              )
              .map((tab) => ({
                active: tab.active,
                url: tab.url,
              })),
          knownTabIds,
        ),
      )
      .toEqual([{ active: true, url: canonicalNoteUrl }]);

    const [activeTab] = await launchedSession.serviceWorker.evaluate(async () =>
      (await chrome.tabs.query({ active: true, currentWindow: true })).map(
        (tab) => ({ id: tab.id, url: tab.url }),
      ),
    );
    expect(activeTab?.url).toBe(canonicalNoteUrl);
    const openedUrl = new URL(activeTab?.url ?? '');
    expect(['http:', 'https:']).toContain(openedUrl.protocol);
    expect(openedUrl.username).toBe('');
    expect(openedUrl.password).toBe('');
    await expect
      .poll(() => errors)
      .toEqual({ consoleErrors: [], pageErrors: [] });
  } finally {
    await closeExtensionAndFixtureServer(session, fixtureServer);
  }
});

test('documents the unavailable toolbar-to-side-panel automation boundary', () => {
  test.skip(
    true,
    'Playwright cannot deterministically click a Chromium extension toolbar action or inspect its side-panel host; the real worker getPanelBehavior result and packaged global default_path are verified separately.',
  );
});
