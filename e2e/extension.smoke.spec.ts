import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  chromium,
  expect,
  test,
  type BrowserContext,
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
    await expect(session.page.getByRole('status')).toContainText(
      'Local foundation ready',
    );

    const button = session.page.getByRole('button', { name: 'Open settings' });
    await session.page.keyboard.press('Tab');
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

test('documents the unavailable toolbar-to-side-panel automation boundary', () => {
  test.skip(
    true,
    'Playwright cannot deterministically click a Chromium extension toolbar action or inspect its side-panel host; the real worker getPanelBehavior result and packaged global default_path are verified separately.',
  );
});
