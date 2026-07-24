import { readFile, readdir, stat } from 'node:fs/promises';
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

const exactPermissions = [
  'sidePanel',
  'storage',
  'unlimitedStorage',
  'tabs',
  'identity',
  'alarms',
];
const exactHosts = ['https://byos.ashfame.com/*'];
const javaScriptExtensions = new Set(['.cjs', '.js', '.mjs']);
const textExtensions = new Set([
  '',
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.key',
  '.map',
  '.md',
  '.mjs',
  '.pem',
  '.scss',
  '.svg',
  '.toml',
  '.ts',
  '.txt',
  '.webmanifest',
  '.xml',
  '.yaml',
  '.yml',
]);
const credentialPatterns = [
  { label: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u },
  {
    label: 'private key',
    pattern: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  },
  {
    label: 'OAuth client secret',
    pattern: /\bclient_secret\s*[:=]\s*["'][^"']+["']/iu,
  },
  { label: 'bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/u },
] as const;
const unsafeExecutionPatterns = [
  {
    label: 'eval invocation',
    pattern: /\beval\s*(?:\?\.)?\s*\(/u,
  },
  {
    label: 'indirect eval invocation',
    pattern:
      /(?:\(\s*(?:(?:0|void\s+0)\s*,\s*)?eval\s*\)\s*(?:\?\.)?\s*\(|\beval\s*\.\s*(?:call|apply)\s*\(|\b(?:globalThis|self|window)\s*(?:\.\s*eval|\[\s*["']eval["']\s*\])\s*(?:\?\.)?\s*\()/u,
  },
  {
    label: 'Function constructor invocation',
    pattern:
      /\b(?:new\s+)?(?:(?:globalThis|self|window)\s*\.\s*)?Function\s*\(/u,
  },
] as const;
const remoteJavaScriptPatterns = [
  {
    label: 'remote dynamic import',
    pattern: /\bimport\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?["'`](?:https?:)?\/\//iu,
  },
  {
    label: 'remote static module reference',
    pattern:
      /\b(?:import\s+(?:(?!\bfrom\b)[^"'`])*\bfrom\s+|import\s*|export\s+(?:(?!\bfrom\b)[^"'`])*\bfrom\s+)["'`](?:https?:)?\/\//iu,
  },
  {
    label: 'remote worker constructor',
    pattern:
      /\b(?:new\s+)?(?:SharedWorker|Worker)\s*\(\s*(?:new\s+URL\s*\(\s*)?["'`](?:https?:)?\/\//iu,
  },
  {
    label: 'remote importScripts call',
    pattern: /\bimportScripts\s*\(\s*["'`](?:https?:)?\/\//iu,
  },
  {
    label: 'remote service worker registration',
    pattern: /\bserviceWorker\s*\.\s*register\s*\(\s*["'`](?:https?:)?\/\//iu,
  },
] as const;

export interface PackageViolation {
  file: string;
  message: string;
}

export interface PackageAuditResult {
  filesInspected: number;
  violations: PackageViolation[];
}

interface ManifestShape {
  action?: { default_icon?: Record<string, string> };
  background?: { service_worker?: string; type?: string };
  content_security_policy?: { extension_pages?: string };
  host_permissions?: string[];
  icons?: Record<string, string>;
  manifest_version?: number;
  options_page?: string;
  permissions?: string[];
  side_panel?: { default_path?: string };
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? listFiles(path) : Promise.resolve([path]);
      }),
  );

  return nested.flat();
}

function cleanResourceReference(value: string): string {
  const withoutQueryOrFragment = value.split(/[?#]/u, 1)[0] ?? '';

  try {
    return decodeURIComponent(withoutQueryOrFragment);
  } catch {
    return withoutQueryOrFragment;
  }
}

function isRemoteReference(value: string): boolean {
  return /^(?:https?:)?\/\//iu.test(value.trim());
}

function isEmbeddedReference(value: string): boolean {
  return /^(?:data:|blob:|#)/iu.test(value.trim());
}

function localResourcePath(
  rootDirectory: string,
  ownerPath: string,
  reference: string,
): string | undefined {
  const cleaned = cleanResourceReference(reference);
  if (cleaned.length === 0 || isEmbeddedReference(cleaned)) {
    return undefined;
  }

  const candidate = cleaned.startsWith('/')
    ? resolve(rootDirectory, cleaned.replace(/^\/+/u, ''))
    : resolve(dirname(ownerPath), cleaned);
  const relativePath = relative(rootDirectory, candidate);

  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }

  return candidate;
}

async function resourceExists(
  rootDirectory: string,
  ownerPath: string,
  resource: string,
): Promise<boolean> {
  const resourcePath = localResourcePath(rootDirectory, ownerPath, resource);
  if (resourcePath === undefined) {
    return false;
  }

  try {
    return (await stat(resourcePath)).isFile();
  } catch {
    return false;
  }
}

function displayPath(rootDirectory: string, path: string): string {
  return relative(rootDirectory, path).split(sep).join('/');
}

function arraysEqual(left: string[] | undefined, right: string[]): boolean {
  return (
    left?.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function cssReferences(contents: string): string[] {
  const references = new Set<string>();

  for (const match of contents.matchAll(
    /url\(\s*(?:(["'])(.*?)\1|([^)"']+))\s*\)/giu,
  )) {
    const reference = (match[2] ?? match[3])?.trim();
    if (reference !== undefined) {
      references.add(reference);
    }
  }

  for (const match of contents.matchAll(
    /@import\s+(?!url\()["']([^"']+)["']/giu,
  )) {
    const reference = match[1]?.trim();
    if (reference !== undefined) {
      references.add(reference);
    }
  }

  return [...references];
}

function htmlReferences(contents: string): string[] {
  const references = new Set<string>();

  for (const match of contents.matchAll(
    /<(?:audio|img|link|script|source|video)\b[^>]*\b(?:href|poster|src)=["']([^"']+)["'][^>]*>/giu,
  )) {
    const reference = match[1]?.trim();
    if (reference !== undefined) {
      references.add(reference);
    }
  }

  for (const match of contents.matchAll(
    /<(?:img|source)\b[^>]*\bsrcset=["']([^"']+)["'][^>]*>/giu,
  )) {
    const sourceSet = match[1];
    if (sourceSet === undefined) {
      continue;
    }

    for (const reference of sourceSetReferences(sourceSet)) {
      if (!reference.startsWith('data:')) {
        references.add(reference);
      }
    }
  }

  return [...references];
}

function sourceSetReferences(sourceSet: string): string[] {
  const references: string[] = [];
  let position = 0;

  while (position < sourceSet.length) {
    while (
      position < sourceSet.length &&
      (sourceSet[position] === ',' || /\s/u.test(sourceSet[position] ?? ''))
    ) {
      position += 1;
    }

    const referenceStart = position;

    while (
      position < sourceSet.length &&
      !/\s/u.test(sourceSet[position] ?? '')
    ) {
      position += 1;
    }

    const rawReferenceToken = sourceSet.slice(referenceStart, position);
    const referenceToken = rawReferenceToken.replace(/,+$/u, '');

    if (referenceToken !== '') {
      if (referenceToken.startsWith('data:')) {
        references.push(referenceToken);
      } else {
        references.push(
          ...referenceToken.split(',').filter((reference) => reference !== ''),
        );
      }
    }

    if (rawReferenceToken.endsWith(',')) {
      continue;
    }

    while (position < sourceSet.length && sourceSet[position] !== ',') {
      position += 1;
    }
  }

  return references;
}

function isEscaped(contents: string, position: number): boolean {
  let backslashes = 0;

  for (
    let preceding = position - 1;
    preceding >= 0 && contents[preceding] === '\\';
    preceding -= 1
  ) {
    backslashes += 1;
  }

  return backslashes % 2 === 1;
}

function hasSourceMapAnnotation(contents: string): boolean {
  type ScannerMode = 'code' | 'double-quoted' | 'single-quoted' | 'template';

  const templateExpressionDepths: number[] = [];
  let mode: ScannerMode = 'code';
  let position = 0;

  while (position < contents.length) {
    const character = contents[position];

    if (mode === 'single-quoted' || mode === 'double-quoted') {
      if (character === '\\') {
        position += 2;
        continue;
      }

      if (
        (mode === 'single-quoted' && character === "'") ||
        (mode === 'double-quoted' && character === '"')
      ) {
        mode = 'code';
      }

      position += 1;
      continue;
    }

    if (mode === 'template') {
      if (character === '\\') {
        position += 2;
        continue;
      }

      if (character === '`') {
        mode = 'code';
        position += 1;
        continue;
      }

      if (character === '$' && contents[position + 1] === '{') {
        templateExpressionDepths.push(1);
        mode = 'code';
        position += 2;
        continue;
      }

      position += 1;
      continue;
    }

    if (character === "'") {
      mode = 'single-quoted';
      position += 1;
      continue;
    }

    if (character === '"') {
      mode = 'double-quoted';
      position += 1;
      continue;
    }

    if (character === '`') {
      mode = 'template';
      position += 1;
      continue;
    }

    if (templateExpressionDepths.length > 0 && character === '{') {
      const expressionIndex = templateExpressionDepths.length - 1;
      templateExpressionDepths[expressionIndex] =
        (templateExpressionDepths[expressionIndex] ?? 0) + 1;
      position += 1;
      continue;
    }

    if (templateExpressionDepths.length > 0 && character === '}') {
      const expressionIndex = templateExpressionDepths.length - 1;
      const remainingDepth =
        (templateExpressionDepths[expressionIndex] ?? 0) - 1;

      if (remainingDepth === 0) {
        templateExpressionDepths.pop();
        mode = 'template';
      } else {
        templateExpressionDepths[expressionIndex] = remainingDepth;
      }

      position += 1;
      continue;
    }

    if (
      character === '/' &&
      contents[position + 1] === '/' &&
      !isEscaped(contents, position)
    ) {
      const commentStart = position + 2;
      const lineEnd = contents.indexOf('\n', commentStart);
      const commentEnd = lineEnd === -1 ? contents.length : lineEnd;

      if (
        /^[#@]\s*sourceMappingURL\s*=/u.test(
          contents.slice(commentStart, commentEnd),
        )
      ) {
        return true;
      }

      position = commentEnd + 1;
      continue;
    }

    if (
      character === '/' &&
      contents[position + 1] === '*' &&
      !isEscaped(contents, position)
    ) {
      const commentStart = position + 2;
      const closingComment = contents.indexOf('*/', commentStart);
      const commentEnd =
        closingComment === -1 ? contents.length : closingComment;

      if (
        /^[#@]\s*sourceMappingURL\s*=/u.test(
          contents.slice(commentStart, commentEnd),
        )
      ) {
        return true;
      }

      position = closingComment === -1 ? contents.length : closingComment + 2;
      continue;
    }

    position += 1;
  }

  return false;
}

async function auditBundleFiles(
  rootDirectory: string,
  files: string[],
): Promise<PackageViolation[]> {
  const violations: PackageViolation[] = [];

  for (const path of files) {
    const file = displayPath(rootDirectory, path);
    const extension = extname(path).toLowerCase();

    if (path.endsWith('.map')) {
      violations.push({
        file,
        message: 'source map is present in the production package',
      });
    }

    if (/-[a-f0-9]{8,}\.(?:css|js)$/u.test(file)) {
      violations.push({
        file,
        message: 'content-hashed filename breaks the stable package contract',
      });
    }

    if (!textExtensions.has(extension)) {
      continue;
    }

    const contents = await readFile(path, 'utf8');

    for (const { label, pattern } of credentialPatterns) {
      if (pattern.test(contents)) {
        violations.push({
          file,
          message: `possible credential found: ${label}`,
        });
      }
    }

    if (hasSourceMapAnnotation(contents)) {
      violations.push({ file, message: 'source map reference is present' });
    }

    if (javaScriptExtensions.has(extension)) {
      for (const { label, pattern } of [
        ...unsafeExecutionPatterns,
        ...remoteJavaScriptPatterns,
      ]) {
        if (pattern.test(contents)) {
          violations.push({
            file,
            message: `forbidden executable construct found: ${label}`,
          });
        }
      }
    }

    if (extension === '.html') {
      if (
        /<script\b(?![^>]*\bsrc=)[^>]*>\s*\S[\s\S]*?<\/script>/iu.test(contents)
      ) {
        violations.push({
          file,
          message: 'inline executable script is forbidden by the extension CSP',
        });
      }

      if (/\son[a-z]+\s*=/iu.test(contents)) {
        violations.push({
          file,
          message: 'inline event handler is forbidden by the extension CSP',
        });
      }

      for (const reference of htmlReferences(contents)) {
        if (isRemoteReference(reference)) {
          violations.push({
            file,
            message: `remote HTML resource reference found: ${reference}`,
          });
        } else if (
          !isEmbeddedReference(reference) &&
          !(await resourceExists(rootDirectory, path, reference))
        ) {
          violations.push({
            file,
            message: `HTML resource is missing: ${reference}`,
          });
        }
      }
    }

    if (extension === '.css') {
      for (const reference of cssReferences(contents)) {
        if (isRemoteReference(reference)) {
          violations.push({
            file,
            message: `remote stylesheet or CSS resource reference found: ${reference}`,
          });
        } else if (
          !isEmbeddedReference(reference) &&
          !reference.startsWith('var(') &&
          !(await resourceExists(rootDirectory, path, reference))
        ) {
          violations.push({
            file,
            message: `CSS resource is missing: ${reference}`,
          });
        }
      }
    }
  }

  return violations;
}

export async function auditBundle(
  rootDirectory: string,
): Promise<PackageAuditResult> {
  const files = await listFiles(rootDirectory);

  return {
    filesInspected: files.length,
    violations: await auditBundleFiles(rootDirectory, files),
  };
}

export async function auditPackage(
  rootDirectory: string,
): Promise<PackageAuditResult> {
  const bundleResult = await auditBundle(rootDirectory);
  const violations: PackageViolation[] = [];
  const manifestPath = resolve(rootDirectory, 'manifest.json');
  const manifest = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  ) as ManifestShape;

  if (manifest.manifest_version !== 3) {
    violations.push({
      file: 'manifest.json',
      message: 'manifest_version must be 3',
    });
  }

  if (!arraysEqual(manifest.permissions, exactPermissions)) {
    violations.push({
      file: 'manifest.json',
      message: 'permissions differ from the reviewed exact list',
    });
  }

  if (!arraysEqual(manifest.host_permissions, exactHosts)) {
    violations.push({
      file: 'manifest.json',
      message: 'host_permissions differ from the reviewed BYOS host',
    });
  }

  if (
    manifest.content_security_policy?.extension_pages !==
    "script-src 'self'; object-src 'self'"
  ) {
    violations.push({
      file: 'manifest.json',
      message: 'extension page CSP is not the strict local-only policy',
    });
  }

  const manifestResources = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    manifest.options_page,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ].filter((value): value is string => typeof value === 'string');

  for (const resource of new Set(manifestResources)) {
    if (!(await resourceExists(rootDirectory, manifestPath, resource))) {
      violations.push({
        file: 'manifest.json',
        message: `declared resource is missing: ${resource}`,
      });
    }
  }

  return {
    filesInspected: bundleResult.filesInspected,
    violations: [...violations, ...bundleResult.violations],
  };
}
