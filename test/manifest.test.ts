import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import manifest from '../public/manifest.json';

const projectRoot = resolve(import.meta.dirname, '..');

describe('Manifest V3 package contract', () => {
  it('uses Chrome 114+, exact permissions, and only the BYOS host', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe('114');
    expect(manifest.permissions).toEqual([
      'sidePanel',
      'storage',
      'unlimitedStorage',
      'tabs',
      'identity',
      'alarms',
    ]);
    expect(manifest.host_permissions).toEqual(['https://byos.ashfame.com/*']);
    expect(manifest).not.toHaveProperty('content_scripts');
    expect(manifest).not.toHaveProperty('web_accessible_resources');
    expect(manifest.action).not.toHaveProperty('default_popup');
  });

  it('declares deterministic module-worker, panel, options, icon, and CSP resources', () => {
    expect(manifest.background).toEqual({
      service_worker: 'service-worker.js',
      type: 'module',
    });
    expect(manifest.side_panel).toEqual({ default_path: 'side-panel.html' });
    expect(manifest.options_page).toBe('options.html');
    expect(manifest.icons).toEqual({
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    });
    expect(manifest.action.default_icon).toEqual(manifest.icons);
    expect(manifest.content_security_policy.extension_pages).toBe(
      "script-src 'self'; object-src 'self'",
    );
  });

  it('pins the isolated editor without loading it before the editor milestone', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(projectRoot, 'package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
    };

    expect(packageJson.dependencies['@automattic/isolated-block-editor']).toBe(
      '2.30.0',
    );
  });
});
