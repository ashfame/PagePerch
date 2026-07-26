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
const deprecatedUseSettingMessage =
  'wp.blockEditor.useSetting is deprecated since version 6.5. Please use wp.blockEditor.useSettings instead.';
const deprecatedRecursionProviderMessage =
  'wp.blockEditor.__experimentalRecursionProvider is deprecated since version 6.5. Please use wp.blockEditor.RecursionProvider instead.';

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

async function copyElementWithTrustedKeyboard(
  page: Page,
  selector: string,
): Promise<void> {
  await page.locator(selector).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press('Control+c');
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
    const installedVersion = await session.serviceWorker.evaluate(
      () => chrome.runtime.getManifest().version,
    );
    await expect(
      session.page.getByRole('heading', {
        level: 1,
        name: 'PagePerch settings',
      }),
    ).toBeVisible();
    await expect(
      session.page.getByText(`Version ${installedVersion}`, { exact: true }),
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

    const layoutState = await button.evaluate((element) => {
      const buttonBounds = element.getBoundingClientRect();
      const headerBounds = element
        .closest('.brand-header')
        ?.getBoundingClientRect();
      return {
        fitsViewport: document.documentElement.scrollWidth <= window.innerWidth,
        rightGap:
          headerBounds === undefined
            ? Number.POSITIVE_INFINITY
            : headerBounds.right - buttonBounds.right,
      };
    });

    expect(layoutState).toMatchObject({
      fitsViewport: true,
    });
    expect(layoutState.rightGap).toBeGreaterThanOrEqual(-1);
    expect(layoutState.rightGap).toBeLessThanOrEqual(1);
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
    const measureWritingInsets = () =>
      root.evaluate((rootElement) => {
        const firstBlock = rootElement.querySelector(':scope > .wp-block');
        if (!(firstBlock instanceof HTMLElement)) {
          throw new Error('The editor writing column has no first block.');
        }

        const rootBounds = rootElement.getBoundingClientRect();
        const blockBounds = firstBlock.getBoundingClientRect();
        return {
          fitsViewport:
            document.documentElement.scrollWidth <= window.innerWidth,
          left: blockBounds.left - rootBounds.left,
          right: rootBounds.right - blockBounds.right,
          top: blockBounds.top - rootBounds.top,
        };
      });
    const narrowInsets = await measureWritingInsets();
    expect(narrowInsets.fitsViewport).toBe(true);
    expect(narrowInsets.left).toBeCloseTo(16, 0);
    expect(narrowInsets.right).toBeCloseTo(16, 0);
    expect(narrowInsets.top).toBeCloseTo(16, 0);

    await panelPage.setViewportSize({ width: 640, height: 720 });
    const wideInsets = await measureWritingInsets();
    expect(wideInsets.fitsViewport).toBe(true);
    expect(wideInsets.left).toBeCloseTo(16, 0);
    expect(wideInsets.right).toBeCloseTo(16, 0);
    expect(wideInsets.top).toBeCloseTo(16, 0);
    await panelPage.setViewportSize({ width: 280, height: 720 });

    const noteStatus = panelPage.locator('.note-status');
    await expect(noteStatus).toBeVisible();
    const shortNoteLayout = await root.evaluate((rootElement) => {
      const editorRegion = rootElement.closest('.page-note-editor');
      const noteArea = rootElement.closest('.note-editor-area');
      const pageShell = rootElement.closest('.page-document-shell');
      const status = noteArea?.querySelector('.note-status');
      const lastBlock = [...rootElement.children]
        .filter((element) => element.matches('.wp-block'))
        .at(-1);

      if (
        editorRegion === null ||
        noteArea === null ||
        pageShell === null ||
        status === null ||
        status === undefined ||
        lastBlock === undefined
      ) {
        throw new Error('The short-note layout is incomplete.');
      }

      const editorBounds = editorRegion.getBoundingClientRect();
      const noteAreaBounds = noteArea.getBoundingClientRect();
      const pageShellBounds = pageShell.getBoundingClientRect();
      const rootBounds = rootElement.getBoundingClientRect();
      const lastBlockBounds = lastBlock.getBoundingClientRect();
      const statusBounds = status.getBoundingClientRect();

      return {
        canvasBelowLastBlock: editorBounds.bottom - lastBlockBounds.bottom,
        editorBottom: editorBounds.bottom,
        editorHeight: editorBounds.height,
        editorTop: editorBounds.top,
        noteAreaBottom: noteAreaBounds.bottom,
        noteAreaTop: noteAreaBounds.top,
        pageShellBottom: pageShellBounds.bottom,
        rootBottom: rootBounds.bottom,
        rootTop: rootBounds.top,
        statusTop: statusBounds.top,
        statusBottom: statusBounds.bottom,
        viewportHeight: window.innerHeight,
      };
    });
    expect(shortNoteLayout.editorHeight).toBeGreaterThan(450);
    expect(shortNoteLayout.canvasBelowLastBlock).toBeGreaterThan(350);
    expect(
      Math.abs(shortNoteLayout.editorTop - shortNoteLayout.noteAreaTop),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(shortNoteLayout.rootTop - shortNoteLayout.editorTop),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(shortNoteLayout.rootBottom - shortNoteLayout.editorBottom),
    ).toBeLessThanOrEqual(1);
    expect(shortNoteLayout.statusTop).toBeGreaterThanOrEqual(
      shortNoteLayout.editorBottom,
    );
    expect(
      Math.abs(shortNoteLayout.noteAreaBottom - shortNoteLayout.statusBottom),
    ).toBeLessThanOrEqual(1);
    expect(shortNoteLayout.pageShellBottom).toBeLessThanOrEqual(
      shortNoteLayout.viewportHeight - 7,
    );
    expect(shortNoteLayout.pageShellBottom).toBeGreaterThanOrEqual(
      shortNoteLayout.viewportHeight - 9,
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

test('lets a pointer user click multiple blank canvas spots, type, persist, and reload', async () => {
  test.setTimeout(45_000);
  const session = await launchExtension();
  const fixtureUrl = 'https://pageperch.test/basic-canvas-typing';
  const fixtureTitle = 'PagePerch basic canvas typing fixture';
  const noteProbe = storedNote(fixtureUrl, fixtureTitle, '');
  const deprecationMessages: string[] = [];

  try {
    await routeFixture(session.context, fixtureUrl, fixtureTitle);
    await session.page.goto(fixtureUrl);

    const panelPage = await session.context.newPage();
    await panelPage.setViewportSize({ width: 280, height: 720 });
    panelPage.on('console', (message) => {
      if (
        message.text().includes(deprecatedUseSettingMessage) ||
        message.text().includes(deprecatedRecursionProviderMessage)
      ) {
        deprecationMessages.push(message.text());
      }
    });
    await panelPage.goto(
      `chrome-extension://${session.extensionId}/side-panel.html`,
    );
    await activateTabForUrl(session.serviceWorker, fixtureUrl);

    const editable = await expectSimplifiedEditorReady(
      panelPage,
      fixtureUrl,
      fixtureTitle,
    );
    const canvas = panelPage.locator('.page-note-editor__canvas');
    await expect(canvas).toBeVisible();
    const canvasBounds = await canvas.boundingBox();

    if (canvasBounds === null) {
      throw new Error('The basic writing canvas has no visible bounds.');
    }

    const spots = [
      {
        name: 'upper-right',
        position: {
          x: Math.floor(canvasBounds.width * 0.75),
          y: Math.floor(canvasBounds.height * 0.25),
        },
        token: 'Upper canvas ',
      },
      {
        name: 'middle-left',
        position: {
          x: Math.floor(canvasBounds.width * 0.25),
          y: Math.floor(canvasBounds.height * 0.5),
        },
        token: 'Middle canvas ',
      },
      {
        name: 'lower-right',
        position: {
          x: Math.floor(canvasBounds.width * 0.75),
          y: Math.floor(canvasBounds.height * 0.8),
        },
        token: 'Lower canvas',
      },
    ] as const;
    let expectedText = '';

    for (const spot of spots) {
      await canvas.click({ position: spot.position });
      expect(
        await editable.evaluate(
          (element) => element === document.activeElement,
        ),
        `${spot.name} blank-canvas click should focus the editable`,
      ).toBe(true);
      await panelPage.keyboard.type(spot.token);
      expectedText += spot.token;
      await expect(editable).toContainText(expectedText);
    }

    await expect
      .poll(async () => {
        const stored = (await readStoredNote(
          session.serviceWorker,
          noteProbe,
        )) as Partial<StoredNote> | undefined;
        return stored?.contentHtml;
      })
      .toContain(expectedText);

    await panelPage.reload();
    await expectSimplifiedEditorReady(panelPage, fixtureUrl, fixtureTitle);
    await expect(
      panelPage.getByText(expectedText, { exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    });
    expect(deprecationMessages).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test('converts a trusted rich browser copy into semantic Gutenberg blocks and persists them', async () => {
  test.setTimeout(75_000);
  const session = await launchExtension();
  const fixtureUrl = 'https://pageperch.test/rich-paste-fixture';
  const fixtureTitle = 'PagePerch rich paste fixture';
  const noteProbe = storedNote(fixtureUrl, fixtureTitle, '');

  try {
    await session.page.route(fixtureUrl, async (route) => {
      await route.fulfill({
        body: `<!doctype html>
          <html>
            <head><title>${fixtureTitle}</title></head>
            <body>
              <article id="rich-source" tabindex="0">
                <h2 class="source-heading" style="color: red">Trusted rich heading</h2>
                <p class="source-copy">Body with <strong>trusted bold</strong>, <em>trusted emphasis</em>, <mark>trusted mark</mark>, <kbd>Ctrl+S</kbd>, H<sub>2</sub>O, and a <a href="https://safe.example/paste" style="color: red">trusted safe link</a>.</p>
                <ul><li>Trusted first item</li><li>Trusted second item</li></ul>
                <blockquote><p>Trusted quotation</p><cite>Trusted citation</cite></blockquote>
                <pre><code>const trustedPaste = true;</code></pre>
                <table class="unsupported-table" style="margin-left: 80px" onclick="window.unsafeTable = true">
                  <caption>Unsupported table caption</caption>
                  <thead><tr><th>Unsupported table heading</th></tr></thead>
                  <tbody>
                    <tr><td>Unsupported first cell</td><td><strong>Unsupported second cell</strong></td></tr>
                    <tr><td>Unsupported before<p>Unsupported middle</p>Unsupported after</td></tr>
                  </tbody>
                  <tfoot><tr><td>Unsupported table footer</td></tr></tfoot>
                </table>
                <figure class="unsupported-image" style="position: fixed">
                  <img src="javascript:alert(1)" alt="Unsupported image alternative">
                  <figcaption>Unsupported image caption</figcaption>
                </figure>
                <p>Repeated clipboard occurrence<img src="https://tracking.example/repeated.png" alt="Repeated clipboard occurrence"></p>
                <template>Hidden template token</template>
                <script>window.unsafePaste = true</script>
                <style>.unsupported-table { border-collapse: collapse }</style>
                <hr>
              </article>
            </body>
          </html>`,
        contentType: 'text/html',
        status: 200,
      });
    });
    await session.page.goto(fixtureUrl);
    await session.page.evaluate(() => {
      Object.assign(window, {
        __pageperchCopyEvidence: undefined,
      });
      document.addEventListener(
        'copy',
        (event) => {
          Object.assign(window, {
            __pageperchCopyEvidence: {
              isTrusted: event.isTrusted,
            },
          });
        },
        { once: true },
      );
    });

    const panelPage = await session.context.newPage();
    await panelPage.setViewportSize({ width: 280, height: 720 });
    await panelPage.emulateMedia({ colorScheme: 'light' });
    await panelPage.goto(
      `chrome-extension://${session.extensionId}/side-panel.html`,
    );
    await activateTabForUrl(session.serviceWorker, fixtureUrl);
    const editable = await expectSimplifiedEditorReady(
      panelPage,
      fixtureUrl,
      fixtureTitle,
    );

    await session.page.locator('#rich-source').focus();
    await session.page.keyboard.press('Control+a');
    await session.page.keyboard.press('Control+c');
    await expect
      .poll(() =>
        session.page.evaluate(
          () =>
            (
              window as typeof window & {
                __pageperchCopyEvidence?: {
                  readonly isTrusted: boolean;
                };
              }
            ).__pageperchCopyEvidence,
        ),
      )
      .toMatchObject({
        isTrusted: true,
      });

    await panelPage.evaluate(() => {
      Object.assign(window, {
        __pageperchPasteEvidence: undefined,
      });
      document.addEventListener(
        'paste',
        (event) => {
          Object.assign(window, {
            __pageperchPasteEvidence: {
              isTrusted: event.isTrusted,
              types: [...(event.clipboardData?.types ?? [])],
            },
          });
        },
        { capture: true, once: true },
      );
    });
    await editable.click();
    await panelPage.keyboard.press('Control+v');
    await expect
      .poll(() =>
        panelPage.evaluate(
          () =>
            (
              window as typeof window & {
                __pageperchPasteEvidence?: {
                  readonly isTrusted: boolean;
                  readonly types: readonly string[];
                };
              }
            ).__pageperchPasteEvidence,
        ),
      )
      .toMatchObject({
        isTrusted: true,
        types: expect.arrayContaining(['text/html']),
      });

    const editor = panelPage.getByRole('region', {
      name: 'Page note editor',
    });
    const headingBlock = editor.locator('[data-type="core/heading"]');
    const listBlock = editor.locator('[data-type="core/list"]');
    const quoteBlock = editor.locator('[data-type="core/quote"]');
    const codeBlock = editor.locator('[data-type="core/code"]');
    const separatorBlock = editor.locator('[data-type="core/separator"]');
    await expect(headingBlock).toContainText('Trusted rich heading');
    await expect(listBlock).toContainText('Trusted first item');
    await expect(listBlock).toContainText('Trusted second item');
    await expect(quoteBlock).toContainText('Trusted quotation');
    await expect(quoteBlock).toContainText('Trusted citation');
    await expect(codeBlock).toContainText('const trustedPaste = true;');
    await expect(separatorBlock).toBeVisible();
    const recoveredVisibleOccurrences = [
      'Unsupported table caption',
      'Unsupported table heading',
      'Unsupported first cell',
      'Unsupported second cell',
      'Unsupported before',
      'Unsupported middle',
      'Unsupported after',
      'Unsupported table footer',
      'Unsupported image alternative',
      'Unsupported image caption',
      'Repeated clipboard occurrence',
      'Repeated clipboard occurrence',
    ] as const;
    const hasExactRecoveredText = (value: string) => {
      let cursor = 0;
      for (const occurrence of recoveredVisibleOccurrences) {
        const index = value.indexOf(occurrence, cursor);
        if (index === -1) {
          return false;
        }
        cursor = index + occurrence.length;
      }

      const expectedCounts = new Map<string, number>();
      for (const occurrence of recoveredVisibleOccurrences) {
        expectedCounts.set(
          occurrence,
          (expectedCounts.get(occurrence) ?? 0) + 1,
        );
      }
      return [...expectedCounts].every(([occurrence, expectedCount]) => {
        let actualCount = 0;
        let occurrenceCursor = 0;
        while (true) {
          const index = value.indexOf(occurrence, occurrenceCursor);
          if (index === -1) {
            break;
          }
          actualCount += 1;
          occurrenceCursor = index + occurrence.length;
        }
        return actualCount === expectedCount;
      });
    };
    await expect
      .poll(async () => hasExactRecoveredText(await editor.innerText()))
      .toBe(true);
    const editorText = await editor.innerText();
    expect(hasExactRecoveredText(editorText)).toBe(true);
    await expect(
      editor.getByText('Unsupported content was removed.'),
    ).toHaveCount(0);
    await expect(editor.locator('strong')).toHaveText('trusted bold');
    await expect(editor.locator('em')).toHaveText('trusted emphasis');
    await expect(editor.locator('mark')).toHaveText('trusted mark');
    await expect(editor.locator('kbd')).toHaveText('Ctrl+S');
    await expect(editor.locator('sub')).toHaveText('2');
    const safeLink = editor.getByRole('link', { name: 'trusted safe link' });
    await expect(safeLink).toHaveAttribute(
      'href',
      'https://safe.example/paste',
    );

    const clickEditableWithMouse = async (blockSelector: string) => {
      const bounds = await editor.evaluate((editorElement, selector) => {
        const block = editorElement.querySelector(selector);
        const editable =
          block?.matches('[contenteditable="true"]') === true
            ? block
            : block?.querySelector('[contenteditable="true"]');
        if (!(editable instanceof HTMLElement)) {
          throw new Error(`The ${selector} writing block is not editable.`);
        }
        editable.scrollIntoView({ block: 'center' });
        const rect = editable.getBoundingClientRect();
        return {
          height: rect.height,
          width: rect.width,
          x: rect.x,
          y: rect.y,
        };
      }, blockSelector);
      if (bounds.width === 0 || bounds.height === 0) {
        throw new Error('The writing block has no clickable bounds.');
      }
      await panelPage.mouse.click(
        bounds.x + Math.min(8, bounds.width / 2),
        bounds.y + bounds.height / 2,
      );
    };
    const expectBlockFocused = async (blockSelector: string) =>
      expect
        .poll(() =>
          editor.evaluate((editorElement, selector) => {
            const block = editorElement.querySelector(selector);
            const editable =
              block?.matches('[contenteditable="true"]') === true
                ? block
                : block?.querySelector('[contenteditable="true"]');
            return (
              editable === document.activeElement ||
              editable?.contains(document.activeElement) === true
            );
          }, blockSelector),
        )
        .toBe(true);
    const exerciseBlockEditing = async (
      blockSelector: string,
      editProbe: string,
    ) => {
      const block = editor.locator(blockSelector).first();
      await clickEditableWithMouse(blockSelector);
      await expectBlockFocused(blockSelector);
      await panelPage.keyboard.press('End');
      await panelPage.keyboard.type(editProbe);
      await expect(block).toContainText(editProbe);
      await panelPage.keyboard.press('Control+z');
      await expect(block).not.toContainText(editProbe);
    };

    await exerciseBlockEditing(
      '[data-type="core/paragraph"]',
      ' paragraph edit probe',
    );
    await exerciseBlockEditing(
      '[data-type="core/heading"]',
      ' heading edit probe',
    );
    await exerciseBlockEditing(
      '[data-type="core/list-item"]',
      ' list edit probe',
    );

    await panelPage.emulateMedia({ colorScheme: 'dark' });
    await exerciseBlockEditing(
      '[data-type="core/heading"]',
      ' dark-mode edit probe',
    );

    await expect
      .poll(async () => {
        const note = (await readStoredNote(
          session.serviceWorker,
          noteProbe,
        )) as Partial<StoredNote> | undefined;
        return note?.contentHtml;
      })
      .toMatch(
        /wp:heading[\s\S]*wp:paragraph[\s\S]*wp:list[\s\S]*wp:quote[\s\S]*wp:code[\s\S]*wp:separator/u,
      );
    const stored = (await readStoredNote(
      session.serviceWorker,
      noteProbe,
    )) as StoredNote;
    expect(stored.contentHtml).toContain('<strong>trusted bold</strong>');
    expect(stored.contentHtml).toContain('<em>trusted emphasis</em>');
    expect(stored.contentHtml).toContain(
      '<a href="https://safe.example/paste" rel="noopener noreferrer">trusted safe link</a>',
    );
    expect(hasExactRecoveredText(stored.contentHtml)).toBe(true);
    expect
      .soft(stored.contentHtml)
      .not.toContain('Unsupported content was removed.');
    expect(stored.contentHtml).not.toMatch(
      /class="(?:source-|unsupported-)|style=|onclick=|javascript:|data:|wp:table|wp:image|Hidden template token|unsafePaste|unsafeTable/iu,
    );

    await panelPage.reload();
    await expectSimplifiedEditorReady(panelPage, fixtureUrl, fixtureTitle);
    await expect(panelPage.locator('[data-type="core/heading"]')).toContainText(
      'Trusted rich heading',
    );
    await expect(panelPage.locator('[data-type="core/list"]')).toContainText(
      'Trusted second item',
    );
    await expect(panelPage.locator('[data-type="core/quote"]')).toContainText(
      'Trusted quotation',
    );
    await expect(panelPage.locator('[data-type="core/code"]')).toContainText(
      'const trustedPaste = true;',
    );
    await expect(
      panelPage.getByRole('link', { name: 'trusted safe link' }),
    ).toHaveAttribute('href', 'https://safe.example/paste');
    const reloadedEditor = panelPage.getByRole('region', {
      name: 'Page note editor',
    });
    await expect
      .poll(async () => hasExactRecoveredText(await reloadedEditor.innerText()))
      .toBe(true);
    expect(hasExactRecoveredText(await reloadedEditor.innerText())).toBe(true);
    await expect(
      panelPage.getByText('Unsupported content was removed.'),
    ).toHaveCount(0);
  } finally {
    await closeExtension(session);
  }
});

test('replaces partial selections and preserves nested list roots during trusted structured paste', async () => {
  test.setTimeout(45_000);
  const session = await launchExtension();
  const fixtureUrl = 'https://pageperch.test/selection-paste-fixture';
  const fixtureTitle = 'PagePerch selection paste fixture';
  const noteProbe = storedNote(fixtureUrl, fixtureTitle, '');

  try {
    await session.page.route(fixtureUrl, async (route) => {
      await route.fulfill({
        body: `<!doctype html>
          <html>
            <head><title>${fixtureTitle}</title></head>
            <body>
              <article id="partial-source">
                <p>Trusted lead paragraph</p>
                <h3>Trusted inserted heading</h3>
                <ul><li>NestedBeforeAfter</li></ul>
                <blockquote><p>Trusted inserted quote</p></blockquote>
                <p>Trusted trailing paragraph</p>
              </article>
              <section id="nested-source">
                <p>Nested alpha</p>
                <p>Nested beta</p>
              </section>
            </body>
          </html>`,
        contentType: 'text/html',
        status: 200,
      });
    });
    await session.page.goto(fixtureUrl);

    const panelPage = await session.context.newPage();
    await panelPage.setViewportSize({ width: 280, height: 720 });
    await panelPage.goto(
      `chrome-extension://${session.extensionId}/side-panel.html`,
    );
    await activateTabForUrl(session.serviceWorker, fixtureUrl);
    const editable = await expectSimplifiedEditorReady(
      panelPage,
      fixtureUrl,
      fixtureTitle,
    );

    await copyElementWithTrustedKeyboard(session.page, '#partial-source');
    await editable.click();
    await panelPage.keyboard.type('BeforeAfter');
    for (let index = 0; index < 5; index += 1) {
      await panelPage.keyboard.press('Shift+ArrowLeft');
    }
    await panelPage.keyboard.press('Control+v');

    const editor = panelPage.getByRole('region', {
      name: 'Page note editor',
    });
    const root = editor.locator(
      '.block-editor-block-list__layout.is-root-container',
    );
    const firstParagraph = root.locator('[data-type="core/paragraph"]').first();
    await expect(firstParagraph).toContainText('Before');
    await expect(firstParagraph).toContainText('Trusted lead paragraph');
    await expect(firstParagraph).not.toContainText('After');
    await expect(root.locator('[data-type="core/heading"]')).toContainText(
      'Trusted inserted heading',
    );
    await expect(root.locator('[data-type="core/list"]')).toContainText(
      'NestedBeforeAfter',
    );
    await expect(root.locator('[data-type="core/quote"]')).toContainText(
      'Trusted inserted quote',
    );
    const partialOrder = await root.evaluate((rootElement) =>
      [...rootElement.children]
        .filter((element) => element.matches('[data-type]'))
        .map((element) => ({
          text: element.textContent ?? '',
          type: element.getAttribute('data-type'),
        })),
    );
    expect(partialOrder.map(({ type }) => type)).toEqual([
      'core/paragraph',
      'core/heading',
      'core/list',
      'core/quote',
      'core/paragraph',
    ]);

    await panelPage.keyboard.press('Control+z');
    await expect(root).toContainText('BeforeAfter');
    await expect(root.locator('[data-type="core/heading"]')).toHaveCount(0);
    await panelPage.keyboard.press('Control+Shift+z');
    await expect(root.locator('[data-type="core/heading"]')).toContainText(
      'Trusted inserted heading',
    );
    await expect(firstParagraph).not.toContainText('After');

    await copyElementWithTrustedKeyboard(session.page, '#nested-source');
    const nestedList = root.locator('[data-type="core/list"]').first();
    const targetListItem = nestedList
      .locator('[data-type="core/list-item"] [contenteditable="true"]')
      .filter({ hasText: 'NestedBeforeAfter' })
      .first();
    await targetListItem.click();
    await panelPage.keyboard.press('End');
    for (let index = 0; index < 5; index += 1) {
      await panelPage.keyboard.press('Shift+ArrowLeft');
    }
    await panelPage.keyboard.press('Control+v');

    await expect(nestedList).toContainText('NestedBefore');
    await expect(nestedList).toContainText('Nested alpha');
    await expect(nestedList).toContainText('Nested beta');
    await expect(nestedList).not.toContainText('After');
    const nestedTypes = await nestedList
      .locator('[data-type]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-type')),
      );
    expect(nestedTypes).not.toContain('core/paragraph');
    expect(nestedTypes).not.toContain('core/heading');
    expect(nestedTypes).toEqual(
      expect.arrayContaining(['core/list-item', 'core/list-item']),
    );

    await expect
      .poll(async () => {
        const note = (await readStoredNote(
          session.serviceWorker,
          noteProbe,
        )) as Partial<StoredNote> | undefined;
        return note?.contentHtml;
      })
      .toMatch(
        /Before[\s\S]*Trusted lead paragraph[\s\S]*Trusted inserted heading[\s\S]*NestedBefore[\s\S]*Nested alpha[\s\S]*Nested beta[\s\S]*Trusted inserted quote/u,
      );
    const stored = (await readStoredNote(
      session.serviceWorker,
      noteProbe,
    )) as StoredNote;
    expect(stored.contentHtml).not.toContain('NestedBeforeAfter');
    expect(stored.contentHtml).toMatch(
      /wp:list[\s\S]*wp:list-item[\s\S]*Nested alpha[\s\S]*wp:list-item[\s\S]*Nested beta/u,
    );

    await panelPage.reload();
    await expectSimplifiedEditorReady(panelPage, fixtureUrl, fixtureTitle);
    await expect(panelPage.locator('[data-type="core/heading"]')).toContainText(
      'Trusted inserted heading',
    );
    const reloadedList = panelPage.locator('[data-type="core/list"]').first();
    await expect(reloadedList).toContainText('NestedBefore');
    await expect(reloadedList).toContainText('Nested alpha');
    await expect(reloadedList).toContainText('Nested beta');
    await expect(reloadedList).not.toContainText('After');
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
