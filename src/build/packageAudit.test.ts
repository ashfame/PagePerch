import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { auditPackage } from './packageAudit';

const temporaryDirectories: string[] = [];

function validManifest() {
  return {
    manifest_version: 3,
    permissions: [
      'sidePanel',
      'storage',
      'unlimitedStorage',
      'tabs',
      'identity',
      'alarms',
    ],
    host_permissions: ['https://byos.ashfame.com/*'],
    action: { default_icon: { 16: 'icons/icon-16.png' } },
    background: { service_worker: 'service-worker.js', type: 'module' },
    side_panel: { default_path: 'side-panel.html' },
    options_page: 'options.html',
    icons: { 16: 'icons/icon-16.png' },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  };
}

async function createFixture(): Promise<string> {
  const directory = await mkdtemp(
    resolve(tmpdir(), 'pageperch-package-audit-'),
  );
  temporaryDirectories.push(directory);
  await mkdir(resolve(directory, 'assets'), { recursive: true });
  await mkdir(resolve(directory, 'icons'), { recursive: true });
  await Promise.all([
    writeFile(
      resolve(directory, 'manifest.json'),
      JSON.stringify(validManifest()),
    ),
    writeFile(
      resolve(directory, 'options.html'),
      '<script type="module" src="/assets/options.js"></script>',
    ),
    writeFile(
      resolve(directory, 'side-panel.html'),
      '<script type="module" src="/assets/side-panel.js"></script>',
    ),
    writeFile(resolve(directory, 'service-worker.js'), 'export {};'),
    writeFile(resolve(directory, 'assets/options.js'), 'export {};'),
    writeFile(resolve(directory, 'assets/side-panel.js'), 'export {};'),
    writeFile(resolve(directory, 'icons/icon-16.png'), ''),
  ]);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('auditPackage', () => {
  it('accepts a local-only package with declared resources', async () => {
    const directory = await createFixture();

    await expect(auditPackage(directory)).resolves.toEqual({
      filesInspected: 7,
      violations: [],
    });
  });

  it('rejects unsafe execution, source maps, remote scripts, missing resources, and credentials', async () => {
    const directory = await createFixture();
    await Promise.all([
      writeFile(
        resolve(directory, 'options.html'),
        '<body onload="start()"><script>start()</script><script src="https://cdn.example.invalid/app.js"></script><script src="/missing.js"></script>',
      ),
      writeFile(
        resolve(directory, 'assets/unsafe.js'),
        'eval("x"); new Function("x"); //# sourceMappingURL=unsafe.js.map',
      ),
      writeFile(
        resolve(directory, 'assets/token.js'),
        'const authorization = "Bearer abcdefghijklmnopqrstuvwxyz123456";',
      ),
      writeFile(
        resolve(directory, 'assets/remote.css'),
        '@import url("https://cdn.example.invalid/theme.css");',
      ),
      writeFile(resolve(directory, 'assets/unsafe.js.map'), '{}'),
    ]);

    const result = await auditPackage(directory);
    const messages = result.violations.map(({ message }) => message);

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('remote HTML resource reference'),
        expect.stringContaining('HTML resource is missing'),
        expect.stringContaining('inline executable script'),
        expect.stringContaining('inline event handler'),
        expect.stringContaining('remote stylesheet or CSS resource'),
        expect.stringContaining('eval invocation'),
        expect.stringContaining('Function constructor invocation'),
        expect.stringContaining('source map reference'),
        expect.stringContaining('source map is present'),
        expect.stringContaining('bearer token'),
      ]),
    );
  });

  it('rejects Function constructors, indirect eval, and obvious remote JavaScript loaders', async () => {
    const directory = await createFixture();
    await writeFile(
      resolve(directory, 'assets/loaders.js'),
      [
        'Function("return 1")();',
        '(0, eval)("code");',
        'window["eval"]("code");',
        'import("https://cdn.example.invalid/module.js");',
        'importScripts("//cdn.example.invalid/worker.js");',
        'new Worker("https://cdn.example.invalid/worker.js");',
        'navigator.serviceWorker.register("//cdn.example.invalid/sw.js");',
        'import value from "https://cdn.example.invalid/static.js";',
      ].join('\n'),
    );

    const messages = (await auditPackage(directory)).violations.map(
      ({ message }) => message,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        'forbidden executable construct found: Function constructor invocation',
        'forbidden executable construct found: indirect eval invocation',
        'forbidden executable construct found: remote dynamic import',
        'forbidden executable construct found: remote static module reference',
        'forbidden executable construct found: remote worker constructor',
        'forbidden executable construct found: remote importScripts call',
        'forbidden executable construct found: remote service worker registration',
      ]),
    );
  });

  it.each([
    ['parenthesized eval', '(eval)("code");'],
    ['comma-operator eval', '(0, eval)("code");'],
    ['member eval', 'window["eval"]("code");'],
    ['eval.call', 'eval.call(globalThis, "code");'],
  ])('rejects %s as an indirect eval form', async (_name, source) => {
    const directory = await createFixture();
    await writeFile(resolve(directory, 'assets/indirect-eval.js'), source);

    const messages = (await auditPackage(directory)).violations.map(
      ({ message }) => message,
    );

    expect(messages).toContain(
      'forbidden executable construct found: indirect eval invocation',
    );
  });

  it('checks local HTML and CSS resources relative to the referencing file', async () => {
    const directory = await createFixture();
    await mkdir(resolve(directory, 'assets/images'), { recursive: true });
    await Promise.all([
      writeFile(
        resolve(directory, 'options.html'),
        '<link rel="stylesheet" href="/assets/local.css"><img src="/assets/images/bird.png" alt=""><source srcset="/assets/images/bird.png 1x">',
      ),
      writeFile(
        resolve(directory, 'assets/local.css'),
        '@import "./theme.css"; .bird { background: url("./images/bird.png"); }',
      ),
      writeFile(resolve(directory, 'assets/theme.css'), ''),
      writeFile(resolve(directory, 'assets/images/bird.png'), ''),
    ]);

    await expect(auditPackage(directory)).resolves.toMatchObject({
      violations: [],
    });
  });

  it('rejects missing and traversing HTML or CSS resources', async () => {
    const directory = await createFixture();
    await Promise.all([
      writeFile(
        resolve(directory, 'options.html'),
        '<link rel="stylesheet" href="/assets/missing.css"><img src="/assets/missing.png" alt=""><source srcset="/assets/missing-2x.png 2x">',
      ),
      writeFile(
        resolve(directory, 'assets/resources.css'),
        '@import "./missing-theme.css"; .one { background: url("./missing-image.svg"); } .two { background: url("../../outside.png"); }',
      ),
    ]);

    const messages = (await auditPackage(directory)).violations.map(
      ({ message }) => message,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        'HTML resource is missing: /assets/missing.css',
        'HTML resource is missing: /assets/missing.png',
        'HTML resource is missing: /assets/missing-2x.png',
        'CSS resource is missing: ./missing-theme.css',
        'CSS resource is missing: ./missing-image.svg',
        'CSS resource is missing: ../../outside.png',
      ]),
    );
  });

  it('scans reasonable non-executable text files for credentials', async () => {
    const directory = await createFixture();
    await Promise.all([
      writeFile(
        resolve(directory, 'release-notes.txt'),
        'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
      ),
      writeFile(
        resolve(directory, 'assets/diagram.svg'),
        '<metadata>client_secret = "must-not-ship"</metadata>',
      ),
    ]);

    const credentialFiles = (await auditPackage(directory)).violations
      .filter(({ message }) => message.startsWith('possible credential found'))
      .map(({ file }) => file);

    expect(credentialFiles).toEqual(
      expect.arrayContaining(['assets/diagram.svg', 'release-notes.txt']),
    );
  });

  it('scans PEM and key files for private key material', async () => {
    const directory = await createFixture();
    await Promise.all([
      writeFile(
        resolve(directory, 'private.pem'),
        '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
      ),
      writeFile(
        resolve(directory, 'deployment.key'),
        '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n',
      ),
    ]);

    const credentialFiles = (await auditPackage(directory)).violations
      .filter(
        ({ message }) => message === 'possible credential found: private key',
      )
      .map(({ file }) => file);

    expect(credentialFiles).toEqual(
      expect.arrayContaining(['deployment.key', 'private.pem']),
    );
  });

  it.each([
    ['hash line comment', '//# sourceMappingURL=hidden.map'],
    ['at line comment', '//@ sourceMappingURL=hidden.map'],
    ['hash block comment', '/*# sourceMappingURL=hidden.map */'],
    ['at block comment', '/*@ sourceMappingURL=hidden.map */'],
  ])(
    'detects a non-final source-map annotation in a %s',
    async (_description, annotation) => {
      const directory = await createFixture();

      await writeFile(
        resolve(directory, 'assets/non-final.js'),
        `const before = true;\n${annotation}\nconst after = true;\n`,
      );

      const result = await auditPackage(directory);

      expect(result.violations).toContainEqual({
        file: 'assets/non-final.js',
        message: 'source map reference is present',
      });
    },
  );

  it('ignores source-map annotation tokens inside string literals', async () => {
    const directory = await createFixture();

    await writeFile(
      resolve(directory, 'assets/inert-markers.js'),
      [
        'const lineMarker = "//# sourceMappingURL=inert-line.map";',
        "const blockMarker = '/*@ sourceMappingURL=inert-block.map */';",
      ].join('\n'),
    );

    const result = await auditPackage(directory);

    expect(result.violations).not.toContainEqual({
      file: 'assets/inert-markers.js',
      message: 'source map reference is present',
    });
  });

  it('ignores comments and escaped tokens inside JavaScript literals and regular expressions', async () => {
    const directory = await createFixture();

    await writeFile(
      resolve(directory, 'assets/inert-syntax.js'),
      [
        'const doubleQuoted = "escaped \\\\ value";',
        "const singleQuoted = 'escaped \\\\ value';",
        'const templateEscaped = `escaped \\\\ value`;',
        'const templateExpression = `value ${{ nested: { okay: true } }.nested.okay}`;',
        'const nestedTemplate = `value ${`inner ${true}`}`;',
        'const protocol = /^\\\\w+:\\\\/\\\\//;',
        '// ordinary comment',
        '/* ordinary block comment */',
      ].join('\n'),
    );

    const result = await auditPackage(directory);

    expect(result.violations).not.toContainEqual({
      file: 'assets/inert-syntax.js',
      message: 'source map reference is present',
    });
  });

  it('checks non-data candidates that follow a data URL in srcset', async () => {
    const directory = await createFixture();
    const imagePath = resolve(directory, 'assets/srcset-image.png');

    await writeFile(
      resolve(directory, 'options.html'),
      '<source srcset="data:image/svg+xml,%3Csvg%3E%3C/svg%3E, /assets/srcset-image.png 2x">',
    );

    const missingResult = await auditPackage(directory);

    expect(missingResult.violations).toEqual([
      {
        file: 'options.html',
        message: 'HTML resource is missing: /assets/srcset-image.png',
      },
    ]);

    await writeFile(imagePath, 'not-a-real-image');

    await expect(auditPackage(directory)).resolves.toMatchObject({
      violations: [],
    });
  });

  it('rejects manifest privilege drift, weak CSP, hashed names, and credential markers', async () => {
    const directory = await createFixture();
    await Promise.all([
      writeFile(
        resolve(directory, 'manifest.json'),
        JSON.stringify({
          ...validManifest(),
          manifest_version: 2,
          permissions: ['storage'],
          host_permissions: ['https://example.invalid/*'],
          options_page: 'missing-options.html',
          content_security_policy: {
            extension_pages: "script-src 'self' 'unsafe-eval'",
          },
        }),
      ),
      writeFile(
        resolve(directory, 'assets/chunk-deadbeef.js'),
        'const key = "AKIAABCDEFGHIJKLMNOP";',
      ),
      writeFile(
        resolve(directory, 'assets/private.js'),
        'const key = "-----BEGIN PRIVATE KEY-----";',
      ),
      writeFile(
        resolve(directory, 'assets/oauth.js'),
        'const client_secret = "must-not-ship";',
      ),
    ]);

    const result = await auditPackage(directory);
    const messages = result.violations.map(({ message }) => message);

    expect(messages).toEqual(
      expect.arrayContaining([
        'manifest_version must be 3',
        'permissions differ from the reviewed exact list',
        'host_permissions differ from the reviewed BYOS host',
        'extension page CSP is not the strict local-only policy',
        'declared resource is missing: missing-options.html',
        'content-hashed filename breaks the stable package contract',
        'possible credential found: AWS access key',
        'possible credential found: private key',
        'possible credential found: OAuth client secret',
      ]),
    );
  });
});
