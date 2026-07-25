import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  calculateClassicZipLayout,
  createDeterministicZip,
  createReleasePackage,
  isChromeExtensionVersion,
  type ReleaseArchiveEntry,
  type ReleasePackageRuntime,
  type ReleasePublicationOperation,
} from './releasePackage';

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const MAX_UINT32 = 0xffffffff;
const temporaryDirectories: string[] = [];

interface ParsedZipEntry {
  contents: Buffer;
  crc32: number;
  date: number;
  externalAttributes: number;
  flags: number;
  method: number;
  path: string;
  time: number;
}

interface ReleaseFixture {
  packageJsonPath: string;
  releaseDirectory: string;
  sourceDirectory: string;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

interface PriorRelease {
  archive: Buffer;
  archivePath: string;
  checksum: Buffer;
  checksumPath: string;
}

function validManifest(version: string) {
  return {
    manifest_version: 3,
    name: 'PagePerch',
    version,
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

async function createFixture(version = '1.2.3'): Promise<ReleaseFixture> {
  const rootDirectory = await mkdtemp(
    resolve(tmpdir(), 'pageperch-release-package-'),
  );
  temporaryDirectories.push(rootDirectory);
  const sourceDirectory = resolve(rootDirectory, 'dist');
  const releaseDirectory = resolve(rootDirectory, 'release');
  const packageJsonPath = resolve(rootDirectory, 'package.json');
  await Promise.all([
    mkdir(resolve(sourceDirectory, 'assets'), { recursive: true }),
    mkdir(resolve(sourceDirectory, 'icons'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(packageJsonPath, JSON.stringify({ name: 'pageperch', version })),
    writeFile(
      resolve(sourceDirectory, 'manifest.json'),
      JSON.stringify(validManifest(version)),
    ),
    writeFile(
      resolve(sourceDirectory, 'options.html'),
      '<script type="module" src="/assets/options.js"></script>',
    ),
    writeFile(
      resolve(sourceDirectory, 'side-panel.html'),
      '<script type="module" src="/assets/side-panel.js"></script>',
    ),
    writeFile(resolve(sourceDirectory, 'service-worker.js'), 'export {};\n'),
    writeFile(resolve(sourceDirectory, 'assets/options.js'), 'export {};\n'),
    writeFile(resolve(sourceDirectory, 'assets/side-panel.js'), 'export {};\n'),
    writeFile(resolve(sourceDirectory, 'icons/icon-16.png'), 'icon'),
  ]);

  return { packageJsonPath, releaseDirectory, sourceDirectory };
}

function createDeferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolveDeferred) => {
    resolvePromise = resolveDeferred;
  });

  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    },
  };
}

function findEndRecord(archive: Buffer): number {
  const signature = Buffer.alloc(4);
  signature.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  const offset = archive.lastIndexOf(signature);
  if (offset === -1) {
    throw new Error('ZIP end record was not found.');
  }
  return offset;
}

function parseZip(archive: Buffer): ParsedZipEntry[] {
  const endRecordOffset = findEndRecord(archive);
  const entryCount = archive.readUInt16LE(endRecordOffset + 10);
  let centralOffset = archive.readUInt32LE(endRecordOffset + 16);
  const entries: ParsedZipEntry[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    expect(archive.readUInt32LE(centralOffset)).toBe(
      ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE,
    );
    const flags = archive.readUInt16LE(centralOffset + 8);
    const method = archive.readUInt16LE(centralOffset + 10);
    const time = archive.readUInt16LE(centralOffset + 12);
    const date = archive.readUInt16LE(centralOffset + 14);
    const crc32 = archive.readUInt32LE(centralOffset + 16);
    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const nameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const externalAttributes = archive.readUInt32LE(centralOffset + 38);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const path = archive
      .subarray(centralOffset + 46, centralOffset + 46 + nameLength)
      .toString('utf8');

    expect(archive.readUInt32LE(localOffset)).toBe(
      ZIP_LOCAL_FILE_HEADER_SIGNATURE,
    );
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const contentsOffset =
      localOffset + 30 + localNameLength + localExtraLength;
    const contents = archive.subarray(
      contentsOffset,
      contentsOffset + compressedSize,
    );

    entries.push({
      contents,
      crc32,
      date,
      externalAttributes,
      flags,
      method,
      path,
      time,
    });
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }

  expect(centralOffset).toBe(endRecordOffset);
  return entries;
}

async function seedPriorRelease(
  fixture: ReleaseFixture,
): Promise<PriorRelease> {
  const prior = await createReleasePackage(fixture);
  const result = {
    archive: await readFile(prior.archivePath),
    archivePath: prior.archivePath,
    checksum: await readFile(prior.checksumPath),
    checksumPath: prior.checksumPath,
  };
  await writeFile(
    resolve(fixture.sourceDirectory, 'assets/options.js'),
    'export const releaseRevision = 2;\n',
  );
  return result;
}

async function expectPriorRelease(prior: PriorRelease): Promise<void> {
  await expect(readFile(prior.archivePath)).resolves.toEqual(prior.archive);
  await expect(readFile(prior.checksumPath)).resolves.toEqual(prior.checksum);
}

async function expectCoherentRelease(
  archivePath: string,
  checksumPath: string,
): Promise<void> {
  const archive = await readFile(archivePath);
  const checksum = createHash('sha256').update(archive).digest('hex');
  await expect(readFile(checksumPath, 'utf8')).resolves.toBe(
    `${checksum}  ${basename(archivePath)}\n`,
  );
  expect(parseZip(archive).some(({ path }) => path === 'manifest.json')).toBe(
    true,
  );
}

async function expectNoTransientReleaseEntries(
  releaseDirectory: string,
): Promise<void> {
  const entries = await readdir(releaseDirectory);
  expect(
    entries.filter((entry) => entry.startsWith('.pageperch-release')),
  ).toEqual([]);
}

async function recoveryDirectory(releaseDirectory: string): Promise<string> {
  const entries = await readdir(releaseDirectory);
  const recoveryEntries = entries.filter(
    (entry) =>
      entry.startsWith('.pageperch-release-') &&
      entry !== '.pageperch-release.lock',
  );
  expect(recoveryEntries).toHaveLength(1);
  return resolve(releaseDirectory, recoveryEntries[0] ?? '');
}

function injectedFailureRuntime(
  predicate: (operation: ReleasePublicationOperation) => boolean,
): ReleasePackageRuntime {
  return {
    beforePublicationOperation: (operation) => {
      if (predicate(operation)) {
        throw new Error(
          `Injected ${operation.phase}${'artifact' in operation ? ` ${operation.artifact}` : ''} failure.`,
        );
      }
    },
  };
}

function nestedErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const visited = new Set<unknown>();

  function visit(value: unknown): void {
    if (visited.has(value)) {
      return;
    }
    visited.add(value);

    if (value instanceof Error) {
      messages.push(value.message);
      if (value instanceof AggregateError) {
        for (const nested of value.errors) {
          visit(nested);
        }
      }
      visit(value.cause);
    }
  }

  visit(error);
  return messages;
}

function fileSystemErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }

  return undefined;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('createDeterministicZip', () => {
  it('sorts entries and writes portable deterministic ZIP metadata', () => {
    const archive = createDeterministicZip([
      { contents: Buffer.from('last'), path: 'z-last.txt' },
      { contents: Buffer.from('123456789'), path: 'a-first.txt' },
    ]);
    const entries = parseZip(archive);

    expect(entries.map(({ path }) => path)).toEqual([
      'a-first.txt',
      'z-last.txt',
    ]);
    expect(entries[0]).toMatchObject({
      contents: Buffer.from('123456789'),
      crc32: 0xcbf43926,
      date: 0x0021,
      externalAttributes: (0o100644 << 16) >>> 0,
      flags: 0x0800,
      method: 0,
      time: 0,
    });
  });

  it.each([
    ['', 'empty'],
    ['../outside.js', 'traversing'],
    ['nested/../../outside.js', 'traversing'],
    ['/absolute.js', 'portable relative'],
    ['C:/absolute.js', 'portable relative'],
    ['nested\\windows.js', 'portable relative'],
    ['assets/app.js.map', 'source-map'],
    ['profiles/Default/Cookies', 'browser-profile'],
    ['.env.production', 'environment'],
    ['private.key', 'credential'],
  ])('rejects unsafe archive path %j', (path, expectedMessage) => {
    expect(() =>
      createDeterministicZip([{ contents: Buffer.from('x'), path }]),
    ).toThrow(expectedMessage);
  });

  it('rejects empty and duplicate entry collections', () => {
    expect(() => createDeterministicZip([])).toThrow('empty');

    const duplicateEntries: ReleaseArchiveEntry[] = [
      { contents: Buffer.from('first'), path: 'same.txt' },
      { contents: Buffer.from('second'), path: 'same.txt' },
    ];
    expect(() => createDeterministicZip(duplicateEntries)).toThrow(
      'Duplicate release entry',
    );
  });

  it('preflights total classic ZIP size and count without allocating the archive', () => {
    expect(() =>
      calculateClassicZipLayout([{ path: 'a', size: MAX_UINT32 - (30 + 1) }]),
    ).toThrow('ZIP archive total size exceeds');
    expect(() =>
      calculateClassicZipLayout([{ path: 'a', size: MAX_UINT32 }]),
    ).toThrow('ZIP local-file section exceeds');
    expect(() =>
      calculateClassicZipLayout(
        Array.from({ length: 65_536 }, (_, index) => ({
          path: `file-${String(index)}`,
          size: 0,
        })),
      ),
    ).toThrow('file count exceeds');
  });
});

describe('Chrome extension versions', () => {
  it.each(['1', '1.0', '0.1.0.0', '3.1.2.4567', '65535.65535.65535.65535'])(
    'accepts %s',
    (version) => {
      expect(isChromeExtensionVersion(version)).toBe(true);
    },
  );

  it.each([
    '',
    '0',
    '0.0.0.0',
    '01.2',
    '1.02',
    '65536',
    '1.2.3.4.5',
    '1.-2',
    '1.2-beta',
  ])('rejects %s', (version) => {
    expect(isChromeExtensionVersion(version)).toBe(false);
  });
});

describe('createReleasePackage', () => {
  it('creates a version-derived archive and correct SHA-256 sidecar from only sorted dist files', async () => {
    const fixture = await createFixture('3.4.5.6');
    const result = await createReleasePackage(fixture);
    const archive = await readFile(result.archivePath);
    const entries = parseZip(archive);
    const parsedManifest = JSON.parse(
      entries
        .find(({ path }) => path === 'manifest.json')
        ?.contents.toString('utf8') ?? '',
    ) as { version: string };

    expect(basename(result.archivePath)).toBe('pageperch-3.4.5.6.zip');
    expect(basename(result.checksumPath)).toBe('pageperch-3.4.5.6.zip.sha256');
    expect(result.entries).toEqual([
      'assets/options.js',
      'assets/side-panel.js',
      'icons/icon-16.png',
      'manifest.json',
      'options.html',
      'service-worker.js',
      'side-panel.html',
    ]);
    expect(entries.map(({ path }) => path)).toEqual(result.entries);
    expect(parsedManifest.version).toBe('3.4.5.6');

    const expectedChecksum = createHash('sha256').update(archive).digest('hex');
    expect(result.checksum).toBe(expectedChecksum);
    await expect(readFile(result.checksumPath, 'utf8')).resolves.toBe(
      `${expectedChecksum}  pageperch-3.4.5.6.zip\n`,
    );
    await expectNoTransientReleaseEntries(fixture.releaseDirectory);
  });

  it('replaces previous output reproducibly despite source timestamp changes', async () => {
    const fixture = await createFixture();
    const first = await createReleasePackage(fixture);
    const firstArchive = await readFile(first.archivePath);
    await utimes(
      resolve(fixture.sourceDirectory, 'manifest.json'),
      new Date('2040-01-01T12:00:00Z'),
      new Date('2040-01-01T12:00:00Z'),
    );

    const second = await createReleasePackage(fixture);
    const secondArchive = await readFile(second.archivePath);

    expect(second.checksum).toBe(first.checksum);
    expect(secondArchive).toEqual(firstArchive);
    await expectNoTransientReleaseEntries(fixture.releaseDirectory);
  });

  it('allows only one simultaneous invocation and leaves one coherent result', async () => {
    const fixture = await createFixture();
    const snapshotEntered = createDeferred();
    const allowFirstToContinue = createDeferred();
    const first = createReleasePackage(fixture, {
      afterSourceSnapshot: async () => {
        snapshotEntered.resolve();
        await allowFirstToContinue.promise;
      },
    });
    await snapshotEntered.promise;

    let secondOutcome: 'rejected' | 'resolved' = 'resolved';
    try {
      await createReleasePackage(fixture);
    } catch (error) {
      secondOutcome = 'rejected';
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        'Release packaging is already running or requires recovery',
      );
      expect((error as Error).message).toContain(
        resolve(fixture.releaseDirectory, '.pageperch-release.lock'),
      );
    } finally {
      allowFirstToContinue.resolve();
    }

    const firstResult = await first;
    expect(secondOutcome).toBe('rejected');
    await expectCoherentRelease(
      firstResult.archivePath,
      firstResult.checksumPath,
    );
    await expectNoTransientReleaseEntries(fixture.releaseDirectory);
  });

  it('archives the audited immutable snapshot when dist mutates afterward', async () => {
    const fixture = await createFixture();
    const originalOptions = await readFile(
      resolve(fixture.sourceDirectory, 'assets/options.js'),
    );
    const result = await createReleasePackage(fixture, {
      afterSourceSnapshot: async () => {
        await writeFile(
          resolve(fixture.sourceDirectory, 'assets/options.js'),
          'eval("mutated after snapshot");',
        );
      },
    });
    const archivedOptions = parseZip(await readFile(result.archivePath)).find(
      ({ path }) => path === 'assets/options.js',
    );

    expect(archivedOptions?.contents).toEqual(originalOptions);
    await expect(
      readFile(resolve(fixture.sourceDirectory, 'assets/options.js'), 'utf8'),
    ).resolves.toContain('eval');
  });

  it('rejects unsafe snapshotted bytes even if dist is repaired before audit', async () => {
    const fixture = await createFixture();
    await writeFile(
      resolve(fixture.sourceDirectory, 'assets/unsafe.js'),
      'eval("snapshotted unsafe source");',
    );

    await expect(
      createReleasePackage(fixture, {
        afterSourceSnapshot: async () => {
          await writeFile(
            resolve(fixture.sourceDirectory, 'assets/unsafe.js'),
            'export {};\n',
          );
        },
      }),
    ).rejects.toThrow('Production package audit failed');
    expect(await readdir(fixture.releaseDirectory)).toEqual([]);
  });

  it('excludes a source file added after the immutable snapshot', async () => {
    const fixture = await createFixture();
    const latePath = resolve(fixture.sourceDirectory, 'assets/late-source.js');
    const result = await createReleasePackage(fixture, {
      afterSourceSnapshot: async () => {
        await writeFile(latePath, 'eval("must not enter the archive");');
      },
    });
    const archivedPaths = parseZip(await readFile(result.archivePath)).map(
      ({ path }) => path,
    );

    expect(archivedPaths).not.toContain('assets/late-source.js');
    await expect(readFile(latePath, 'utf8')).resolves.toContain('eval');
    expect(result.entries).toHaveLength(7);
  });

  it('retains a captured source file removed after the immutable snapshot', async () => {
    const fixture = await createFixture();
    const iconPath = resolve(fixture.sourceDirectory, 'icons/icon-16.png');
    const capturedIcon = await readFile(iconPath);
    const result = await createReleasePackage(fixture, {
      afterSourceSnapshot: async () => {
        await rm(iconPath);
      },
    });
    const archivedIcon = parseZip(await readFile(result.archivePath)).find(
      ({ path }) => path === 'icons/icon-16.png',
    );

    expect(archivedIcon?.contents).toEqual(capturedIcon);
    await expect(readFile(iconPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.entries).toHaveLength(7);
  });

  it('rejects manifest version drift and invalid Chrome package versions', async () => {
    const fixture = await createFixture();
    await writeFile(
      resolve(fixture.sourceDirectory, 'manifest.json'),
      JSON.stringify(validManifest('9.9.9')),
    );

    await expect(createReleasePackage(fixture)).rejects.toThrow(
      'does not match package version',
    );
    expect(await readdir(fixture.releaseDirectory)).toEqual([]);

    await writeFile(
      fixture.packageJsonPath,
      JSON.stringify({ name: 'pageperch', version: '01.2.3' }),
    );
    await writeFile(
      resolve(fixture.sourceDirectory, 'manifest.json'),
      JSON.stringify(validManifest('01.2.3')),
    );
    await expect(createReleasePackage(fixture)).rejects.toThrow(
      'one to four Chrome-compatible integers',
    );
    expect(await readdir(fixture.releaseDirectory)).toEqual([]);
  });

  it('rejects source symlinks and forbidden package files without transient output', async () => {
    const fixture = await createFixture();
    const externalPath = resolve(fixture.sourceDirectory, '..', 'external.txt');
    await writeFile(externalPath, 'outside');
    await symlink(externalPath, resolve(fixture.sourceDirectory, 'linked.txt'));

    await expect(createReleasePackage(fixture)).rejects.toThrow(
      'contains a symbolic link',
    );
    await rm(resolve(fixture.sourceDirectory, 'linked.txt'));
    await writeFile(resolve(fixture.sourceDirectory, '.env.production'), 'x');
    await expect(createReleasePackage(fixture)).rejects.toThrow('environment');
    expect(await readdir(fixture.releaseDirectory)).toEqual([]);
  });

  it('rejects a non-directory source and an output nested inside the source', async () => {
    const fixture = await createFixture();
    const sourceFile = resolve(
      fixture.sourceDirectory,
      '..',
      'not-a-directory',
    );
    await writeFile(sourceFile, 'file');

    await expect(
      createReleasePackage({ ...fixture, sourceDirectory: sourceFile }),
    ).rejects.toThrow('real directory');
    await expect(readdir(fixture.releaseDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      createReleasePackage({
        ...fixture,
        releaseDirectory: resolve(fixture.sourceDirectory, '.release'),
      }),
    ).rejects.toThrow('must not be inside');
  });

  it('rejects source/output alias boundary bypasses and final symlink paths', async (context) => {
    const fixture = await createFixture();
    const fixtureRoot = resolve(fixture.sourceDirectory, '..');
    const sourceAlias = resolve(fixtureRoot, 'source-alias');

    try {
      await symlink(fixture.sourceDirectory, sourceAlias, 'junction');
    } catch (error) {
      if (
        ['EACCES', 'ENOSYS', 'EPERM'].includes(fileSystemErrorCode(error) ?? '')
      ) {
        context.skip(
          `Directory symlinks/junctions are unavailable on this platform (${fileSystemErrorCode(error)}).`,
        );
        return;
      }
      throw error;
    }

    const aliasedNestedRelease = resolve(
      sourceAlias,
      'release-via-alias',
      'new-parent',
      'release',
    );
    await expect(
      createReleasePackage({
        ...fixture,
        releaseDirectory: aliasedNestedRelease,
      }),
    ).rejects.toThrow('must not be physically inside');
    await expect(
      lstat(resolve(fixture.sourceDirectory, 'release-via-alias')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const existingParent = resolve(
      fixture.sourceDirectory,
      'existing-release-parent',
    );
    await mkdir(existingParent);
    await expect(
      createReleasePackage({
        ...fixture,
        releaseDirectory: resolve(
          sourceAlias,
          'existing-release-parent',
          'new-parent',
          'release',
        ),
      }),
    ).rejects.toThrow('must not be physically inside');
    await expect(
      lstat(resolve(existingParent, 'new-parent')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(existingParent)).toEqual([]);

    await expect(
      createReleasePackage({
        ...fixture,
        releaseDirectory: resolve(fixtureRoot, 'source-link-output'),
        sourceDirectory: sourceAlias,
      }),
    ).rejects.toThrow('Release source must be a real directory, not a link');

    const realOutput = resolve(fixtureRoot, 'real-output');
    const outputAlias = resolve(fixtureRoot, 'output-alias');
    await mkdir(realOutput);
    await symlink(realOutput, outputAlias, 'junction');
    await expect(
      createReleasePackage({
        ...fixture,
        releaseDirectory: outputAlias,
      }),
    ).rejects.toThrow('Release output must be a real directory, not a link');
  });

  it('never follows a retargeted lexical alias during rejected-output cleanup', async (context) => {
    const fixture = await createFixture();
    const fixtureRoot = resolve(fixture.sourceDirectory, '..');
    const sourceAlias = resolve(fixtureRoot, 'retargeted-source-alias');
    const alternateTarget = resolve(fixtureRoot, 'alternate-target');
    const alternateRelease = resolve(alternateTarget, 'new-parent', 'release');
    await mkdir(alternateRelease, { recursive: true });

    try {
      await symlink(fixture.sourceDirectory, sourceAlias, 'junction');
    } catch (error) {
      if (
        ['EACCES', 'ENOSYS', 'EPERM'].includes(fileSystemErrorCode(error) ?? '')
      ) {
        context.skip(
          `Directory symlinks/junctions are unavailable on this platform (${fileSystemErrorCode(error)}).`,
        );
        return;
      }
      throw error;
    }

    await expect(
      createReleasePackage(
        {
          ...fixture,
          releaseDirectory: resolve(sourceAlias, 'new-parent', 'release'),
        },
        {
          beforePhysicalBoundaryCleanup: async () => {
            await rm(sourceAlias);
            await symlink(alternateTarget, sourceAlias, 'junction');
          },
        },
      ),
    ).rejects.toThrow('must not be physically inside');

    await expect(
      lstat(resolve(fixture.sourceDirectory, 'new-parent')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(alternateRelease)).isDirectory()).toBe(true);
    expect(await readdir(alternateRelease)).toEqual([]);
  });

  it('restores an existing archive and removes staging files when a target is not a file', async () => {
    const fixture = await createFixture();
    const archivePath = resolve(
      fixture.releaseDirectory,
      'pageperch-1.2.3.zip',
    );
    const checksumPath = `${archivePath}.sha256`;
    await mkdir(fixture.releaseDirectory, { recursive: true });
    await writeFile(archivePath, 'previous archive');
    await mkdir(checksumPath);

    await expect(createReleasePackage(fixture)).rejects.toThrow(
      'not a replaceable regular file',
    );
    await expect(readFile(archivePath, 'utf8')).resolves.toBe(
      'previous archive',
    );
    expect(await readdir(checksumPath)).toEqual([]);
    await expectNoTransientReleaseEntries(fixture.releaseDirectory);
  });

  it('refuses to package an audited production-policy violation', async () => {
    const fixture = await createFixture();
    await writeFile(
      resolve(fixture.sourceDirectory, 'assets/unsafe.js'),
      'eval("unsafe");',
    );

    await expect(createReleasePackage(fixture)).rejects.toThrow(
      'Production package audit failed',
    );
    expect(await readdir(fixture.releaseDirectory)).toEqual([]);
  });

  it.each(['archive', 'checksum'] as const)(
    'restores both previous files after an injected %s backup failure',
    async (artifact) => {
      const fixture = await createFixture();
      const prior = await seedPriorRelease(fixture);

      await expect(
        createReleasePackage(
          fixture,
          injectedFailureRuntime(
            (operation) =>
              operation.phase === 'backup' && operation.artifact === artifact,
          ),
        ),
      ).rejects.toThrow(`Injected backup ${artifact} failure`);
      await expectPriorRelease(prior);
      await expectNoTransientReleaseEntries(fixture.releaseDirectory);
    },
  );

  it('retains the prior archive and actual partial state when archive rollback removal fails', async () => {
    const fixture = await createFixture();
    const prior = await seedPriorRelease(fixture);
    const runtime: ReleasePackageRuntime = {
      beforePublicationOperation: (operation) => {
        if (
          operation.phase === 'publish' &&
          operation.artifact === 'checksum'
        ) {
          throw new Error('Injected checksum publication failure.');
        }
        if (
          operation.phase === 'rollback-remove' &&
          operation.artifact === 'archive'
        ) {
          throw new Error('Injected archive rollback removal failure.');
        }
      },
    };

    let recoveryFailure: unknown;
    try {
      await createReleasePackage(fixture, runtime);
    } catch (error) {
      recoveryFailure = error;
    }
    expect(recoveryFailure).toBeInstanceOf(Error);
    const retainedDirectory = await recoveryDirectory(fixture.releaseDirectory);
    const partialArchive = await readFile(prior.archivePath);
    expect(partialArchive).not.toEqual(prior.archive);
    expect(
      parseZip(partialArchive)
        .find(({ path }) => path === 'assets/options.js')
        ?.contents.toString('utf8'),
    ).toContain('releaseRevision = 2');
    await expect(readFile(prior.checksumPath)).resolves.toEqual(prior.checksum);
    await expect(
      readFile(resolve(retainedDirectory, 'previous-archive')),
    ).resolves.toEqual(prior.archive);
    await expect(
      lstat(resolve(retainedDirectory, 'previous-checksum')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(
        resolve(retainedDirectory, 'pageperch-1.2.3.zip.sha256'),
        'utf8',
      ),
    ).resolves.toContain('pageperch-1.2.3.zip');
    const lockPath = resolve(
      fixture.releaseDirectory,
      '.pageperch-release.lock',
    );
    expect((await lstat(lockPath)).isDirectory()).toBe(true);
    expect((recoveryFailure as Error).message).toContain(retainedDirectory);
    expect((recoveryFailure as Error).message).toContain(lockPath);
    expect(nestedErrorMessages(recoveryFailure)).toEqual(
      expect.arrayContaining([
        'Injected checksum publication failure.',
        'Injected archive rollback removal failure.',
      ]),
    );
  });

  it.each(['archive', 'checksum'] as const)(
    'restores both previous files after an injected %s publish failure',
    async (artifact) => {
      const fixture = await createFixture();
      const prior = await seedPriorRelease(fixture);

      await expect(
        createReleasePackage(
          fixture,
          injectedFailureRuntime(
            (operation) =>
              operation.phase === 'publish' && operation.artifact === artifact,
          ),
        ),
      ).rejects.toThrow(`Injected publish ${artifact} failure`);
      await expectPriorRelease(prior);
      await expectNoTransientReleaseEntries(fixture.releaseDirectory);
    },
  );

  it.each(['archive', 'checksum'] as const)(
    'retains the previous %s and exact recovery paths when restore fails',
    async (artifact) => {
      const fixture = await createFixture();
      const prior = await seedPriorRelease(fixture);
      const runtime: ReleasePackageRuntime = {
        beforePublicationOperation: (operation) => {
          if (
            operation.phase === 'publish' &&
            operation.artifact === 'checksum'
          ) {
            throw new Error('Injected checksum publication failure.');
          }
          if (
            operation.phase === 'restore' &&
            operation.artifact === artifact
          ) {
            throw new Error(`Injected ${artifact} restore failure.`);
          }
        },
      };

      let recoveryFailure: unknown;
      try {
        await createReleasePackage(fixture, runtime);
      } catch (error) {
        recoveryFailure = error;
      }
      expect(recoveryFailure).toBeInstanceOf(Error);
      expect((recoveryFailure as Error).message).toContain(
        'Release recovery is incomplete',
      );
      const retainedDirectory = await recoveryDirectory(
        fixture.releaseDirectory,
      );
      const retainedBackup = resolve(retainedDirectory, `previous-${artifact}`);
      await expect(readFile(retainedBackup)).resolves.toEqual(
        artifact === 'archive' ? prior.archive : prior.checksum,
      );
      if (artifact === 'archive') {
        await expect(readFile(prior.archivePath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(readFile(prior.checksumPath)).resolves.toEqual(
          prior.checksum,
        );
      } else {
        await expect(readFile(prior.archivePath)).resolves.toEqual(
          prior.archive,
        );
        await expect(readFile(prior.checksumPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      const lockPath = resolve(
        fixture.releaseDirectory,
        '.pageperch-release.lock',
      );
      expect((await lstat(lockPath)).isDirectory()).toBe(true);
      expect((recoveryFailure as Error).message).toContain(retainedDirectory);
      expect((recoveryFailure as Error).message).toContain(lockPath);
    },
  );

  it('retains prior backups and the lock when staging cleanup fails after a coherent publish', async () => {
    const fixture = await createFixture();
    const prior = await seedPriorRelease(fixture);
    const runtime = injectedFailureRuntime(
      (operation) => operation.phase === 'staging-cleanup',
    );

    let cleanupFailure: unknown;
    try {
      await createReleasePackage(fixture, runtime);
    } catch (error) {
      cleanupFailure = error;
    }
    expect(cleanupFailure).toBeInstanceOf(Error);
    expect((cleanupFailure as Error).message).toContain(
      'Release recovery is incomplete',
    );
    const retainedDirectory = await recoveryDirectory(fixture.releaseDirectory);
    await expect(
      readFile(resolve(retainedDirectory, 'previous-archive')),
    ).resolves.toEqual(prior.archive);
    await expect(
      readFile(resolve(retainedDirectory, 'previous-checksum')),
    ).resolves.toEqual(prior.checksum);
    await expectCoherentRelease(prior.archivePath, prior.checksumPath);
    const lockPath = resolve(
      fixture.releaseDirectory,
      '.pageperch-release.lock',
    );
    expect((await lstat(lockPath)).isDirectory()).toBe(true);
    expect((cleanupFailure as Error).message).toContain(retainedDirectory);
    expect((cleanupFailure as Error).message).toContain(lockPath);
  });

  it('retains the prior pair, recovery snapshot, lock, and both causes when staging cleanup follows an ordinary failure', async () => {
    const fixture = await createFixture();
    const prior = await seedPriorRelease(fixture);
    const unsafePath = resolve(fixture.sourceDirectory, 'assets/unsafe.js');
    await writeFile(unsafePath, 'eval("ordinary package audit failure");');
    const runtime = injectedFailureRuntime(
      (operation) => operation.phase === 'staging-cleanup',
    );

    let combinedFailure: unknown;
    try {
      await createReleasePackage(fixture, runtime);
    } catch (error) {
      combinedFailure = error;
    }
    expect(combinedFailure).toBeInstanceOf(Error);
    await expectPriorRelease(prior);
    const retainedDirectory = await recoveryDirectory(fixture.releaseDirectory);
    await expect(
      readFile(resolve(retainedDirectory, 'snapshot/assets/unsafe.js'), 'utf8'),
    ).resolves.toContain('ordinary package audit failure');
    await expect(
      lstat(resolve(retainedDirectory, 'previous-archive')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      lstat(resolve(retainedDirectory, 'previous-checksum')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const lockPath = resolve(
      fixture.releaseDirectory,
      '.pageperch-release.lock',
    );
    expect((await lstat(lockPath)).isDirectory()).toBe(true);
    expect((combinedFailure as Error).message).toContain(retainedDirectory);
    expect((combinedFailure as Error).message).toContain(lockPath);
    expect(nestedErrorMessages(combinedFailure)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Production package audit failed'),
        'Injected staging-cleanup failure.',
      ]),
    );
  });

  it('retains and reports the exact lock when lock cleanup fails', async () => {
    const fixture = await createFixture();
    const lockPath = resolve(
      fixture.releaseDirectory,
      '.pageperch-release.lock',
    );
    const runtime = injectedFailureRuntime(
      (operation) => operation.phase === 'lock-cleanup',
    );

    await expect(createReleasePackage(fixture, runtime)).rejects.toThrow(
      lockPath,
    );
    expect((await lstat(lockPath)).isDirectory()).toBe(true);
    expect(
      (await readdir(fixture.releaseDirectory)).filter(
        (entry) =>
          entry.startsWith('.pageperch-release-') &&
          entry !== '.pageperch-release.lock',
      ),
    ).toEqual([]);
    await expectCoherentRelease(
      resolve(fixture.releaseDirectory, 'pageperch-1.2.3.zip'),
      resolve(fixture.releaseDirectory, 'pageperch-1.2.3.zip.sha256'),
    );
  });

  it('retains the prior pair and lock with both causes when lock cleanup follows an ordinary failure', async () => {
    const fixture = await createFixture();
    const prior = await seedPriorRelease(fixture);
    await writeFile(
      resolve(fixture.sourceDirectory, 'assets/unsafe.js'),
      'eval("ordinary package audit failure");',
    );
    const lockPath = resolve(
      fixture.releaseDirectory,
      '.pageperch-release.lock',
    );
    const runtime = injectedFailureRuntime(
      (operation) => operation.phase === 'lock-cleanup',
    );

    let combinedFailure: unknown;
    try {
      await createReleasePackage(fixture, runtime);
    } catch (error) {
      combinedFailure = error;
    }
    expect(combinedFailure).toBeInstanceOf(Error);
    await expectPriorRelease(prior);
    expect((await lstat(lockPath)).isDirectory()).toBe(true);
    expect(
      (await readdir(fixture.releaseDirectory)).filter(
        (entry) =>
          entry.startsWith('.pageperch-release-') &&
          entry !== '.pageperch-release.lock',
      ),
    ).toEqual([]);
    expect((combinedFailure as Error).message).toContain(lockPath);
    expect(nestedErrorMessages(combinedFailure)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Production package audit failed'),
        'Injected lock-cleanup failure.',
      ]),
    );
  });
});
