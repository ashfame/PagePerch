import { mkdtemp, rm } from 'node:fs/promises';
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

async function launchExtension(): Promise<ExtensionSession> {
  const userDataDirectory = await mkdtemp(
    resolve(tmpdir(), 'pageperch-playwright-'),
  );
  const context = await chromium.launchPersistentContext(userDataDirectory, {
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
}

async function closeExtension(session: ExtensionSession): Promise<void> {
  await session.context.close();
  await rm(session.userDataDirectory, { force: true, recursive: true });
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

    const button = session.page.getByRole('button', { name: 'Open settings' });
    await focusWithKeyboard(session.page, button);
    await expect(button).toBeFocused();

    const visualState = await button.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        fitsViewport: document.documentElement.scrollWidth <= window.innerWidth,
        outlineStyle: styles.outlineStyle,
        outlineWidth: styles.outlineWidth,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        transitionDurations: styles.transitionDuration
          .split(',')
          .map((duration) => Number.parseFloat(duration)),
      };
    });

    expect(visualState).toMatchObject({
      backgroundColor: 'rgb(16, 23, 18)',
      fitsViewport: true,
      outlineStyle: 'solid',
      outlineWidth: '3px',
      reducedMotion: true,
    });
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

    await expect(
      panelPage.getByRole('heading', {
        level: 2,
        name: 'Notes for PagePerch editor fixture',
      }),
    ).toBeVisible();
    await expect(panelPage.getByText('Loading cached note')).toBeHidden();
    await panelPage
      .getByRole('button', {
        name: 'Add default block',
      })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
      });
    await expect(
      panelPage.locator('[contenteditable="true"]').first(),
    ).toBeVisible({
      timeout: 15_000,
    });
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

test('documents the unavailable toolbar-to-side-panel automation boundary', () => {
  test.skip(
    true,
    'Playwright cannot deterministically click a Chromium extension toolbar action or inspect its side-panel host; the real worker getPanelBehavior result and packaged global default_path are verified separately.',
  );
});
