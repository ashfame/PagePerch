import { constants as bufferConstants } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { auditPackage } from './packageAudit.ts';

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_LOCAL_FILE_HEADER_SIZE = 30;
const ZIP_CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const ZIP_VERSION_2_0 = 20;
const ZIP_UNIX_VERSION_2_0 = 0x0314;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORED_METHOD = 0;
const ZIP_EPOCH_DOS_DATE = 0x0021;
const ZIP_REGULAR_FILE_MODE = 0o100644;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const MAX_UINT32_BIGINT = BigInt(MAX_UINT32);

const forbiddenDirectoryNames = new Set([
  '.git',
  '.release',
  'coverage',
  'node_modules',
  'playwright-report',
  'profile',
  'profiles',
  'test-results',
]);
const forbiddenFileNames = new Set([
  '.ds_store',
  '.profile',
  'credentials',
  'secrets',
  'thumbs.db',
  'tokens',
]);
const forbiddenFileExtensions = [
  '.env',
  '.jks',
  '.key',
  '.map',
  '.p12',
  '.pem',
  '.pfx',
] as const;

const crc32Table = Array.from({ length: 256 }, (_, index) => {
  let value = index;

  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  return value >>> 0;
});

export interface ReleaseArchiveEntry {
  contents: Buffer;
  path: string;
}

export interface ClassicZipLayoutEntry {
  path: string;
  size: number;
}

export interface ClassicZipLayout {
  centralDirectorySize: number;
  localFileSectionSize: number;
  totalSize: number;
}

export interface ReleasePackageOptions {
  packageJsonPath: string;
  releaseDirectory: string;
  sourceDirectory: string;
}

export interface ReleasePackageResult {
  archivePath: string;
  checksum: string;
  checksumPath: string;
  entries: string[];
}

type ReleaseArtifact = 'archive' | 'checksum';

export type ReleasePublicationOperation =
  | Readonly<{
      artifact: ReleaseArtifact;
      phase: 'backup' | 'publish' | 'restore';
      sourcePath: string;
      targetPath: string;
    }>
  | Readonly<{
      artifact: ReleaseArtifact;
      path: string;
      phase: 'rollback-remove';
    }>
  | Readonly<{
      path: string;
      phase: 'lock-cleanup' | 'staging-cleanup';
    }>;

/**
 * A narrow orchestration seam for deterministic race and failure tests.
 * Production packaging omits this argument and always performs real I/O.
 */
export interface ReleasePackageRuntime {
  afterSourceSnapshot?: () => Promise<void> | void;
  beforePhysicalBoundaryCleanup?: () => Promise<void> | void;
  beforePublicationOperation?: (
    operation: ReleasePublicationOperation,
  ) => Promise<void> | void;
}

interface CreatedReleaseDirectory {
  device: number;
  inode: number;
  path: string;
}

interface PackageMetadata {
  name: string;
  version: string;
}

interface PreparedReleaseDirectory {
  cleanupProofError?: Error;
  createdDirectories: readonly CreatedReleaseDirectory[];
  firstCreatedPhysicalPath?: string;
  physicalPath: string;
}

interface Publication {
  artifact: ReleaseArtifact;
  backupPath: string;
  backedUp: boolean;
  finalPath: string;
  published: boolean;
  stagedPath: string;
}

interface PreparedZipEntry {
  checksum: number;
  contents: Buffer;
  name: Buffer;
  path: string;
}

class IncompleteRollbackError extends Error {
  constructor(publicationError: Error, rollbackErrors: readonly Error[]) {
    super('Release publication failed and automatic rollback was incomplete.', {
      cause: new AggregateError(
        [publicationError, ...rollbackErrors],
        'Release publication and rollback failures.',
      ),
    });
    this.name = 'IncompleteRollbackError';
  }
}

function comparePaths(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function crc32(contents: Buffer): number {
  let checksum = MAX_UINT32;

  for (const byte of contents) {
    const tableIndex = (checksum ^ byte) & 0xff;
    checksum = (crc32Table[tableIndex] ?? 0) ^ (checksum >>> 8);
  }

  return (checksum ^ MAX_UINT32) >>> 0;
}

function invalidArchivePathReason(path: string): string | undefined {
  if (path.length === 0) {
    return 'path is empty';
  }

  if (
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/u.test(path) ||
    isAbsolute(path)
  ) {
    return 'path is not a portable relative ZIP path';
  }

  const segments = path.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    return 'path contains an empty or traversing segment';
  }

  if (Buffer.byteLength(path, 'utf8') > MAX_UINT16) {
    return 'UTF-8 path exceeds the ZIP format limit';
  }

  return undefined;
}

function forbiddenReleasePathReason(path: string): string | undefined {
  const lowerCaseSegments = path
    .split('/')
    .map((segment) => segment.toLowerCase());
  const fileName = lowerCaseSegments.at(-1) ?? '';

  if (
    lowerCaseSegments.some((segment) => forbiddenDirectoryNames.has(segment))
  ) {
    return 'path belongs to a generated, dependency, or browser-profile directory';
  }

  if (
    fileName === '.env' ||
    fileName.startsWith('.env.') ||
    forbiddenFileNames.has(fileName) ||
    forbiddenFileExtensions.some((extension) => fileName.endsWith(extension))
  ) {
    return 'path looks like environment, credential, profile, or source-map material';
  }

  return undefined;
}

function validateArchivePath(path: string): void {
  const reason =
    invalidArchivePathReason(path) ?? forbiddenReleasePathReason(path);

  if (reason !== undefined) {
    throw new Error(`Unsafe release entry "${path}": ${reason}.`);
  }
}

function assertSafeEntrySize(size: number, path: string): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_UINT32) {
    throw new Error(
      `Release entry "${path}" exceeds the non-ZIP64 entry-size limit.`,
    );
  }
}

function assertClassicLimit(value: bigint, label: string): void {
  if (value > MAX_UINT32_BIGINT) {
    throw new Error(`${label} exceeds the non-ZIP64 archive limit.`);
  }
}

export function calculateClassicZipLayout(
  entries: readonly ClassicZipLayoutEntry[],
): ClassicZipLayout {
  if (entries.length === 0) {
    throw new Error('Cannot create an empty release archive.');
  }

  if (entries.length > MAX_UINT16) {
    throw new Error('Release file count exceeds the non-ZIP64 archive limit.');
  }

  const seenPaths = new Set<string>();
  let localFileSectionSize = 0n;
  let centralDirectorySize = 0n;

  for (const entry of entries) {
    validateArchivePath(entry.path);
    if (seenPaths.has(entry.path)) {
      throw new Error(`Duplicate release entry: ${entry.path}`);
    }
    seenPaths.add(entry.path);
    assertSafeEntrySize(entry.size, entry.path);

    const nameSize = BigInt(Buffer.byteLength(entry.path, 'utf8'));
    const entrySize = BigInt(entry.size);
    assertClassicLimit(localFileSectionSize, 'ZIP local-header offset');
    localFileSectionSize +=
      BigInt(ZIP_LOCAL_FILE_HEADER_SIZE) + nameSize + entrySize;
    centralDirectorySize +=
      BigInt(ZIP_CENTRAL_DIRECTORY_HEADER_SIZE) + nameSize;
  }

  assertClassicLimit(localFileSectionSize, 'ZIP local-file section');
  assertClassicLimit(centralDirectorySize, 'ZIP central directory');
  const totalSize =
    localFileSectionSize +
    centralDirectorySize +
    BigInt(ZIP_END_OF_CENTRAL_DIRECTORY_SIZE);
  assertClassicLimit(totalSize, 'ZIP archive total size');

  if (totalSize > BigInt(bufferConstants.MAX_LENGTH)) {
    throw new Error('ZIP archive total size exceeds the Node Buffer limit.');
  }

  return {
    centralDirectorySize: Number(centralDirectorySize),
    localFileSectionSize: Number(localFileSectionSize),
    totalSize: Number(totalSize),
  };
}

export function createDeterministicZip(
  unsortedEntries: readonly ReleaseArchiveEntry[],
): Buffer {
  const entries = [...unsortedEntries].sort((left, right) =>
    comparePaths(left.path, right.path),
  );
  const layout = calculateClassicZipLayout(
    entries.map(({ contents, path }) => ({ path, size: contents.byteLength })),
  );
  const preparedEntries: PreparedZipEntry[] = entries.map((entry) => ({
    checksum: crc32(entry.contents),
    contents: entry.contents,
    name: Buffer.from(entry.path, 'utf8'),
    path: entry.path,
  }));
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of preparedEntries) {
    const size = entry.contents.byteLength;
    const localHeader = Buffer.alloc(ZIP_LOCAL_FILE_HEADER_SIZE);
    localHeader.writeUInt32LE(ZIP_LOCAL_FILE_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(ZIP_VERSION_2_0, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(ZIP_STORED_METHOD, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(ZIP_EPOCH_DOS_DATE, 12);
    localHeader.writeUInt32LE(entry.checksum, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(entry.name.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, entry.name, entry.contents);

    const centralHeader = Buffer.alloc(ZIP_CENTRAL_DIRECTORY_HEADER_SIZE);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE, 0);
    centralHeader.writeUInt16LE(ZIP_UNIX_VERSION_2_0, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION_2_0, 6);
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(ZIP_STORED_METHOD, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(ZIP_EPOCH_DOS_DATE, 14);
    centralHeader.writeUInt32LE(entry.checksum, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(entry.name.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((ZIP_REGULAR_FILE_MODE << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, entry.name);

    localOffset += ZIP_LOCAL_FILE_HEADER_SIZE + entry.name.byteLength + size;
  }

  const endRecord = Buffer.alloc(ZIP_END_OF_CENTRAL_DIRECTORY_SIZE);
  endRecord.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(layout.centralDirectorySize, 12);
  endRecord.writeUInt32LE(layout.localFileSectionSize, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat(
    [...localParts, ...centralParts, endRecord],
    layout.totalSize,
  );
}

function pathWithin(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== '..' &&
      !isAbsolute(relativePath))
  );
}

async function collectReleaseEntries(
  sourceDirectory: string,
): Promise<ReleaseArchiveEntry[]> {
  const sourceMetadata = await lstat(sourceDirectory);

  if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory()) {
    throw new Error('Release source must be a real directory, not a link.');
  }

  const collected: ReleaseArchiveEntry[] = [];

  async function visit(
    directory: string,
    relativeSegments: string[],
  ): Promise<void> {
    const children = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => comparePaths(left.name, right.name),
    );

    for (const child of children) {
      const childPath = resolve(directory, child.name);
      const childMetadata = await lstat(childPath);
      const childSegments = [...relativeSegments, child.name];
      const archivePath = childSegments.join('/');
      validateArchivePath(archivePath);

      if (childMetadata.isSymbolicLink()) {
        throw new Error(
          `Release source contains a symbolic link: ${archivePath}`,
        );
      }

      if (childMetadata.isDirectory()) {
        await visit(childPath, childSegments);
        continue;
      }

      if (!childMetadata.isFile()) {
        throw new Error(
          `Release source contains a non-file entry: ${archivePath}`,
        );
      }

      collected.push({
        contents: await readFile(childPath),
        path: archivePath,
      });
    }
  }

  await visit(sourceDirectory, []);

  if (!collected.some((entry) => entry.path === 'manifest.json')) {
    throw new Error('Release source does not contain manifest.json.');
  }

  return collected;
}

async function writeSnapshot(
  snapshotDirectory: string,
  entries: readonly ReleaseArchiveEntry[],
): Promise<void> {
  await mkdir(snapshotDirectory);

  for (const entry of entries) {
    const snapshotPath = resolve(snapshotDirectory, ...entry.path.split('/'));
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, entry.contents, {
      flag: 'wx',
      mode: 0o644,
    });
  }
}

async function assertSnapshotMatchesEntries(
  snapshotDirectory: string,
  entries: readonly ReleaseArchiveEntry[],
): Promise<void> {
  for (const entry of entries) {
    const snapshotPath = resolve(snapshotDirectory, ...entry.path.split('/'));
    if (!(await readFile(snapshotPath)).equals(entry.contents)) {
      throw new Error(
        `Audited release snapshot changed unexpectedly: ${entry.path}`,
      );
    }
  }
}

function parseObject(contents: string, label: string): Record<string, unknown> {
  let value: unknown;

  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }

  return value as Record<string, unknown>;
}

export function isChromeExtensionVersion(version: string): boolean {
  const components = version.split('.');

  if (components.length < 1 || components.length > 4) {
    return false;
  }

  let hasNonZeroComponent = false;
  for (const component of components) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(component)) {
      return false;
    }

    const value = Number(component);
    if (!Number.isSafeInteger(value) || value > MAX_UINT16) {
      return false;
    }
    hasNonZeroComponent ||= value !== 0;
  }

  return hasNonZeroComponent;
}

async function readPackageMetadata(
  packageJsonPath: string,
): Promise<PackageMetadata> {
  const packageJson = parseObject(
    (await readFile(packageJsonPath)).toString('utf8'),
    'package.json',
  );
  const { name, version } = packageJson;

  if (
    typeof name !== 'string' ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(name)
  ) {
    throw new Error(
      'package.json name must be a lowercase, artifact-safe package name.',
    );
  }

  if (typeof version !== 'string' || !isChromeExtensionVersion(version)) {
    throw new Error(
      'package.json version must be one to four Chrome-compatible integers from 0 through 65535, without leading zeroes, and must not be all zero.',
    );
  }

  return { name, version };
}

function assertMatchingManifestVersion(
  entries: readonly ReleaseArchiveEntry[],
  packageVersion: string,
): void {
  const manifestEntry = entries.find((entry) => entry.path === 'manifest.json');
  if (manifestEntry === undefined) {
    throw new Error('Release source does not contain manifest.json.');
  }

  const manifest = parseObject(
    manifestEntry.contents.toString('utf8'),
    'dist/manifest.json',
  );

  if (manifest.version !== packageVersion) {
    throw new Error(
      `Manifest version ${String(manifest.version)} does not match package version ${packageVersion}.`,
    );
  }
}

function errorCode(error: unknown): string | undefined {
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

function normalizeError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

function aggregateErrors(
  previousError: Error | undefined,
  nextError: Error,
  message: string,
): Error {
  return previousError === undefined
    ? nextError
    : new AggregateError([previousError, nextError], message);
}

async function runPublicationHook(
  runtime: ReleasePackageRuntime,
  operation: ReleasePublicationOperation,
): Promise<void> {
  await runtime.beforePublicationOperation?.(operation);
}

async function backupExisting(
  publication: Publication,
  runtime: ReleasePackageRuntime,
): Promise<void> {
  try {
    const metadata = await lstat(publication.finalPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(
        `Release target is not a replaceable regular file: ${publication.finalPath}`,
      );
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return;
    }

    throw error;
  }

  await runPublicationHook(runtime, {
    artifact: publication.artifact,
    phase: 'backup',
    sourcePath: publication.finalPath,
    targetPath: publication.backupPath,
  });
  await rename(publication.finalPath, publication.backupPath);
  publication.backedUp = true;
}

async function rollbackPublications(
  publications: readonly Publication[],
  runtime: ReleasePackageRuntime,
): Promise<Error[]> {
  const rollbackErrors: Error[] = [];

  for (const publication of [...publications].reverse()) {
    let publishedRemovalFailed = false;

    if (publication.published) {
      try {
        await runPublicationHook(runtime, {
          artifact: publication.artifact,
          path: publication.finalPath,
          phase: 'rollback-remove',
        });
        await rm(publication.finalPath, { force: true });
        publication.published = false;
      } catch (error) {
        publishedRemovalFailed = true;
        rollbackErrors.push(
          normalizeError(
            error,
            `Could not remove partially published ${publication.artifact}.`,
          ),
        );
      }
    }

    if (publication.backedUp && !publishedRemovalFailed) {
      try {
        await runPublicationHook(runtime, {
          artifact: publication.artifact,
          phase: 'restore',
          sourcePath: publication.backupPath,
          targetPath: publication.finalPath,
        });
        await rename(publication.backupPath, publication.finalPath);
        publication.backedUp = false;
      } catch (error) {
        rollbackErrors.push(
          normalizeError(
            error,
            `Could not restore previous ${publication.artifact}.`,
          ),
        );
      }
    }
  }

  return rollbackErrors;
}

async function publish(
  publications: readonly Publication[],
  runtime: ReleasePackageRuntime,
): Promise<void> {
  try {
    for (const publication of publications) {
      await backupExisting(publication, runtime);
    }

    for (const publication of publications) {
      await runPublicationHook(runtime, {
        artifact: publication.artifact,
        phase: 'publish',
        sourcePath: publication.stagedPath,
        targetPath: publication.finalPath,
      });
      await rename(publication.stagedPath, publication.finalPath);
      publication.published = true;
    }
  } catch (error) {
    const publicationError = normalizeError(
      error,
      'Release publication failed.',
    );
    const rollbackErrors = await rollbackPublications(publications, runtime);
    if (rollbackErrors.length > 0) {
      throw new IncompleteRollbackError(publicationError, rollbackErrors);
    }

    throw publicationError;
  }
}

function physicalPathsFromLeafToFirst(
  leafPath: string,
  firstPath: string,
): string[] {
  if (!pathWithin(firstPath, leafPath)) {
    throw new Error(
      `Could not prove the newly created release directory range: ${firstPath} is not an ancestor of ${leafPath}.`,
    );
  }

  const paths = [leafPath];
  let currentPath = leafPath;
  while (currentPath !== firstPath) {
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath || !pathWithin(firstPath, parentPath)) {
      throw new Error(
        `Could not prove the newly created release directory range between ${firstPath} and ${leafPath}.`,
      );
    }
    paths.push(parentPath);
    currentPath = parentPath;
  }

  return paths;
}

function inferFirstCreatedPhysicalPath(
  physicalReleasePath: string,
  requestedPhysicalPath: string,
  firstCreatedPath: string,
): string {
  const resolvedFirstCreatedPath = resolve(firstCreatedPath);
  if (!pathWithin(resolvedFirstCreatedPath, requestedPhysicalPath)) {
    throw new Error(
      `Could not prove the first newly created release directory: ${resolvedFirstCreatedPath}.`,
    );
  }

  const relativeCreatedPath = relative(
    resolvedFirstCreatedPath,
    requestedPhysicalPath,
  );
  const descendantSegments =
    relativeCreatedPath === '' ? [] : relativeCreatedPath.split(sep);
  let firstCreatedPhysicalPath = physicalReleasePath;
  for (let index = 0; index < descendantSegments.length; index += 1) {
    firstCreatedPhysicalPath = dirname(firstCreatedPhysicalPath);
  }

  if (!pathWithin(firstCreatedPhysicalPath, physicalReleasePath)) {
    throw new Error(
      `Could not prove the canonical newly created release directory range ending at ${physicalReleasePath}.`,
    );
  }

  return firstCreatedPhysicalPath;
}

async function prepareReleaseDirectory(
  releaseDirectory: string,
): Promise<PreparedReleaseDirectory> {
  let existingPath = releaseDirectory;
  let existingMetadata;

  while (true) {
    try {
      existingMetadata = await lstat(existingPath);
      break;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw error;
      }

      const parentPath = dirname(existingPath);
      if (parentPath === existingPath) {
        throw new Error(
          `Release output has no existing filesystem ancestor: ${releaseDirectory}`,
        );
      }
      existingPath = parentPath;
    }
  }

  if (
    existingPath === releaseDirectory &&
    (existingMetadata.isSymbolicLink() || !existingMetadata.isDirectory())
  ) {
    throw new Error('Release output must be a real directory, not a link.');
  }

  const physicalExistingPath = await realpath(existingPath);
  const physicalExistingMetadata = await lstat(physicalExistingPath);
  if (!physicalExistingMetadata.isDirectory()) {
    throw new Error(
      `Release output must have a real directory ancestor: ${existingPath}`,
    );
  }

  const remainingPath = relative(existingPath, releaseDirectory);
  if (
    remainingPath !== '' &&
    (remainingPath === '..' ||
      remainingPath.startsWith(`..${sep}`) ||
      isAbsolute(remainingPath))
  ) {
    throw new Error(
      `Could not resolve release output beneath its existing ancestor: ${releaseDirectory}`,
    );
  }

  const requestedPhysicalPath =
    remainingPath === ''
      ? physicalExistingPath
      : resolve(physicalExistingPath, ...remainingPath.split(sep));
  if (!pathWithin(physicalExistingPath, requestedPhysicalPath)) {
    throw new Error(
      `Could not resolve a safe physical release output path: ${requestedPhysicalPath}`,
    );
  }

  const firstCreatedPath = await mkdir(requestedPhysicalPath, {
    recursive: true,
  });
  const releaseMetadata = await lstat(requestedPhysicalPath);
  if (releaseMetadata.isSymbolicLink() || !releaseMetadata.isDirectory()) {
    throw new Error('Release output must be a real directory, not a link.');
  }

  const physicalPath = await realpath(requestedPhysicalPath);
  if (firstCreatedPath === undefined) {
    return {
      createdDirectories: [],
      physicalPath,
    };
  }

  try {
    const firstCreatedPhysicalPath = inferFirstCreatedPhysicalPath(
      physicalPath,
      requestedPhysicalPath,
      firstCreatedPath,
    );
    const createdPaths = physicalPathsFromLeafToFirst(
      physicalPath,
      firstCreatedPhysicalPath,
    );
    const createdDirectories = await Promise.all(
      createdPaths.map(async (createdPath) => {
        const metadata = await lstat(createdPath);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error(
            `Could not prove a newly created release directory is still a real directory: ${createdPath}`,
          );
        }
        return {
          device: metadata.dev,
          inode: metadata.ino,
          path: createdPath,
        };
      }),
    );

    return {
      createdDirectories,
      firstCreatedPhysicalPath,
      physicalPath,
    };
  } catch (error) {
    return {
      cleanupProofError: normalizeError(
        error,
        'Could not prove the newly created physical release directory range.',
      ),
      createdDirectories: [],
      physicalPath,
    };
  }
}

async function physicalSourceDirectory(
  sourceDirectory: string,
): Promise<string> {
  const sourceMetadata = await lstat(sourceDirectory);
  if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory()) {
    throw new Error('Release source must be a real directory, not a link.');
  }

  return realpath(sourceDirectory);
}

async function assertPhysicalOutputBoundary(
  physicalSourceDirectoryPath: string,
  releaseDirectory: PreparedReleaseDirectory,
  runtime: ReleasePackageRuntime,
): Promise<string> {
  if (!pathWithin(physicalSourceDirectoryPath, releaseDirectory.physicalPath)) {
    return releaseDirectory.physicalPath;
  }

  const boundaryError = new Error(
    `Release output directory must not be physically inside the release source: ${releaseDirectory.physicalPath}`,
  );
  if (releaseDirectory.cleanupProofError !== undefined) {
    throw new AggregateError(
      [boundaryError, releaseDirectory.cleanupProofError],
      'Physical release boundary validation and cleanup proof both failed.',
    );
  }
  if (releaseDirectory.firstCreatedPhysicalPath === undefined) {
    throw boundaryError;
  }

  try {
    await runtime.beforePhysicalBoundaryCleanup?.();

    for (const createdDirectory of releaseDirectory.createdDirectories) {
      const metadata = await lstat(createdDirectory.path);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        metadata.dev !== createdDirectory.device ||
        metadata.ino !== createdDirectory.inode
      ) {
        throw new Error(
          `Newly created release directory changed before cleanup: ${createdDirectory.path}`,
        );
      }
    }

    for (const createdDirectory of releaseDirectory.createdDirectories) {
      await rmdir(createdDirectory.path);
    }
  } catch (error) {
    throw new AggregateError(
      [
        boundaryError,
        normalizeError(
          error,
          `Could not remove rejected release directories through ${releaseDirectory.firstCreatedPhysicalPath}.`,
        ),
      ],
      'Physical release boundary validation and cleanup both failed.',
    );
  }

  throw boundaryError;
}

async function acquireReleaseLock(releaseDirectory: string): Promise<string> {
  const lockDirectory = resolve(releaseDirectory, '.pageperch-release.lock');

  try {
    await mkdir(lockDirectory);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new Error(
        `Release packaging is already running or requires recovery. Lock: ${lockDirectory}`,
        { cause: error },
      );
    }

    throw error;
  }

  return lockDirectory;
}

function recoveryError(
  error: Error,
  stagingDirectory: string,
  lockDirectory: string,
): Error {
  return new Error(
    `Release recovery is incomplete. Do not package again until the retained artifacts are inspected. Recovery directory: ${stagingDirectory}. Lock: ${lockDirectory}`,
    { cause: error },
  );
}

async function releaseLock(
  lockDirectory: string,
  runtime: ReleasePackageRuntime,
  operationError: Error | undefined,
): Promise<void> {
  try {
    await runPublicationHook(runtime, {
      path: lockDirectory,
      phase: 'lock-cleanup',
    });
    await rm(lockDirectory, { recursive: true });
  } catch (error) {
    const lockError = normalizeError(error, 'Release lock cleanup failed.');
    throw new Error(
      `Release lock could not be removed. Inspect and remove it before packaging again: ${lockDirectory}`,
      {
        cause: aggregateErrors(
          operationError,
          lockError,
          'Release operation and lock cleanup both failed.',
        ),
      },
    );
  }
}

async function packageUnderLock(
  options: {
    lockDirectory: string;
    packageJsonPath: string;
    releaseDirectory: string;
    sourceDirectory: string;
  },
  runtime: ReleasePackageRuntime,
): Promise<ReleasePackageResult> {
  const { lockDirectory, packageJsonPath, releaseDirectory, sourceDirectory } =
    options;
  let stagingDirectory: string | undefined;
  let operationError: Error | undefined;
  let result: ReleasePackageResult | undefined;
  let retainRecovery = false;

  try {
    const [metadata, entries] = await Promise.all([
      readPackageMetadata(packageJsonPath),
      collectReleaseEntries(sourceDirectory),
    ]);
    assertMatchingManifestVersion(entries, metadata.version);
    await runtime.afterSourceSnapshot?.();

    stagingDirectory = await mkdtemp(
      resolve(releaseDirectory, '.pageperch-release-'),
    );
    const snapshotDirectory = resolve(stagingDirectory, 'snapshot');
    await writeSnapshot(snapshotDirectory, entries);

    const auditResult = await auditPackage(snapshotDirectory);
    await assertSnapshotMatchesEntries(snapshotDirectory, entries);
    if (auditResult.filesInspected !== entries.length) {
      throw new Error(
        'Audited release snapshot contains an unexpected number of files.',
      );
    }
    if (auditResult.violations.length > 0) {
      throw new Error(
        [
          'Production package audit failed:',
          ...auditResult.violations.map(
            ({ file, message }) => `${file}: ${message}`,
          ),
        ].join('\n'),
      );
    }

    const archiveName = `${metadata.name}-${metadata.version}.zip`;
    const checksumName = `${archiveName}.sha256`;
    const archive = createDeterministicZip(entries);
    const checksum = createHash('sha256').update(archive).digest('hex');
    const checksumContents = `${checksum}  ${archiveName}\n`;
    const archivePath = resolve(releaseDirectory, archiveName);
    const checksumPath = resolve(releaseDirectory, checksumName);
    const stagedArchivePath = resolve(stagingDirectory, archiveName);
    const stagedChecksumPath = resolve(stagingDirectory, checksumName);

    await writeFile(stagedArchivePath, archive, {
      flag: 'wx',
      mode: 0o644,
    });
    await writeFile(stagedChecksumPath, checksumContents, {
      flag: 'wx',
      mode: 0o644,
    });

    await publish(
      [
        {
          artifact: 'archive',
          backedUp: false,
          backupPath: resolve(stagingDirectory, 'previous-archive'),
          finalPath: archivePath,
          published: false,
          stagedPath: stagedArchivePath,
        },
        {
          artifact: 'checksum',
          backedUp: false,
          backupPath: resolve(stagingDirectory, 'previous-checksum'),
          finalPath: checksumPath,
          published: false,
          stagedPath: stagedChecksumPath,
        },
      ],
      runtime,
    );

    result = {
      archivePath,
      checksum,
      checksumPath,
      entries: entries.map((entry) => entry.path).sort(comparePaths),
    };
  } catch (error) {
    operationError = normalizeError(error, 'Release packaging failed.');
    retainRecovery = error instanceof IncompleteRollbackError;
  }

  if (stagingDirectory !== undefined && !retainRecovery) {
    try {
      await runPublicationHook(runtime, {
        path: stagingDirectory,
        phase: 'staging-cleanup',
      });
      await rm(stagingDirectory, { force: true, recursive: true });
    } catch (error) {
      operationError = aggregateErrors(
        operationError,
        normalizeError(error, 'Release staging cleanup failed.'),
        'Release operation and staging cleanup both failed.',
      );
      retainRecovery = true;
    }
  }

  if (retainRecovery && stagingDirectory !== undefined) {
    // The staging directory may contain the only good pre-release copies.
    // Keeping both it and the lock prevents a later run from destroying them.
    throw recoveryError(
      operationError ?? new Error('Release recovery is incomplete.'),
      stagingDirectory,
      lockDirectory,
    );
  }

  await releaseLock(lockDirectory, runtime, operationError);

  if (operationError !== undefined) {
    throw operationError;
  }

  if (result === undefined) {
    throw new Error('Release packaging finished without a result.');
  }

  return result;
}

export async function createReleasePackage(
  options: ReleasePackageOptions,
  runtime: ReleasePackageRuntime = {},
): Promise<ReleasePackageResult> {
  const sourceDirectory = resolve(options.sourceDirectory);
  const releaseDirectory = resolve(options.releaseDirectory);
  const packageJsonPath = resolve(options.packageJsonPath);

  if (pathWithin(sourceDirectory, releaseDirectory)) {
    throw new Error(
      'Release output directory must not be inside the release source.',
    );
  }

  const physicalSource = await physicalSourceDirectory(sourceDirectory);
  const preparedReleaseDirectory =
    await prepareReleaseDirectory(releaseDirectory);
  const physicalRelease = await assertPhysicalOutputBoundary(
    physicalSource,
    preparedReleaseDirectory,
    runtime,
  );
  const lockDirectory = await acquireReleaseLock(physicalRelease);

  return packageUnderLock(
    {
      lockDirectory,
      packageJsonPath,
      releaseDirectory: physicalRelease,
      sourceDirectory: physicalSource,
    },
    runtime,
  );
}
