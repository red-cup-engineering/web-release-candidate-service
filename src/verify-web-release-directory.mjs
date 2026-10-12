import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { canonicalJson } from '@red-cup-engineering/json-services-section/canonical-json';
import { makeNiUri } from "@red-cup-engineering/uri-services-section/ni-uri";

const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const NI_SHA256 = /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u;

/**
 * Verify one materialized web release without following filesystem links.
 * Manifest exclusions may be present but are deliberately not content-bound.
 */
export async function verifyWebReleaseDirectory({
  manifest,
  root,
  allowExcluded = true,
  maxFiles = DEFAULT_MAX_FILES,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const diagnostics = [];
  const expected = manifestInventory(manifest, diagnostics);
  const exclusions = manifestExclusions(manifest, diagnostics);
  const limits = normalizedLimits({ maxFiles, maxBytes });
  if (typeof allowExcluded !== 'boolean') throw new TypeError('allowExcluded must be a boolean');

  let directory;
  try {
    if (typeof root !== 'string' || root.length === 0) throw new TypeError('root must be a non-empty path');
    const requested = resolve(root);
    const rootStat = await lstat(requested);
    if (rootStat.isSymbolicLink()) throw new TypeError('root must not be a symbolic link');
    if (!rootStat.isDirectory()) throw new TypeError('root must be a directory');
    directory = await realpath(requested);
  } catch (error) {
    diagnostics.push(diagnostic('WRC-D001', errorMessage(error), 'root'));
    return result({ root: typeof root === 'string' ? resolve(root) : null, manifest, diagnostics });
  }

  const observed = new Map();
  let fileCount = 0;
  let byteCount = 0;
  let fileLimitReported = false;
  let byteLimitReported = false;

  async function visit(at) {
    const entries = await readdir(at, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const path = resolve(at, entry.name);
      const subject = relative(directory, path).split(sep).join('/');
      if (!inside(directory, path) || !safePath(subject)) {
        diagnostics.push(diagnostic('WRC-D002', 'filesystem entry escaped the release root or has an unsafe path', subject || entry.name));
        continue;
      }
      const status = await lstat(path);
      if (status.isSymbolicLink()) {
        diagnostics.push(diagnostic('WRC-D003', 'release directory contains a symbolic link', subject));
        continue;
      }
      if (status.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!status.isFile()) {
        diagnostics.push(diagnostic('WRC-D004', 'release directory contains a non-file entry', subject));
        continue;
      }
      fileCount += 1;
      byteCount += status.size;
      if (fileCount > limits.maxFiles) {
        if (!fileLimitReported) diagnostics.push(diagnostic('WRC-D005', `release directory exceeds maxFiles (${limits.maxFiles})`, subject));
        fileLimitReported = true;
        continue;
      }
      if (byteCount > limits.maxBytes) {
        if (!byteLimitReported) diagnostics.push(diagnostic('WRC-D006', `release directory exceeds maxBytes (${limits.maxBytes})`, subject));
        byteLimitReported = true;
        continue;
      }
      const bytes = await readFile(path);
      observed.set(subject, Object.freeze({ bytes: bytes.byteLength, digest: makeNiUri(bytes) }));
    }
  }

  try {
    await visit(directory);
  } catch (error) {
    diagnostics.push(diagnostic('WRC-D007', `release directory could not be read: ${errorMessage(error)}`, directory));
  }

  let verifiedFileCount = 0;
  for (const [path, artifact] of expected) {
    const found = observed.get(path);
    if (found === undefined) {
      diagnostics.push(diagnostic('WRC-D008', 'manifest artifact is missing from the release directory', path));
    } else if (found.bytes !== artifact.bytes || found.digest !== artifact.digest) {
      diagnostics.push(diagnostic('WRC-D009', 'release file bytes or digest differ from the manifest', path, { expected: { bytes: artifact.bytes, digest: artifact.digest }, observed: found }));
    } else {
      verifiedFileCount += 1;
    }
  }
  for (const path of [...observed.keys()].sort(compareText)) {
    if (expected.has(path)) continue;
    if (allowExcluded && exclusions.has(path)) continue;
    diagnostics.push(diagnostic('WRC-D010', 'release directory contains a file absent from the manifest', path));
  }

  return result({
    root: directory,
    manifest,
    diagnostics,
    fileCount,
    byteCount,
    expectedFileCount: expected.size,
    verifiedFileCount,
    excludedFileCount: [...observed.keys()].filter((path) => !expected.has(path) && exclusions.has(path)).length,
    limits,
  });
}

function manifestInventory(manifest, diagnostics) {
  const expected = new Map();
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.kind !== 'web-release-manifest' || manifest.version !== 1 || !Array.isArray(manifest.artifacts)) {
    diagnostics.push(diagnostic('WRC-D011', 'manifest must be a supported web release manifest', 'manifest'));
    return expected;
  }
  const baseUrl = normalizedBaseUrl(manifest.baseUrl);
  if (baseUrl === undefined || baseUrl !== manifest.baseUrl) diagnostics.push(diagnostic('WRC-D011', 'manifest baseUrl must be a normalized absolute HTTP(S) directory URL', 'manifest.baseUrl'));
  if (typeof manifest.profile !== 'string' || !manifest.profile.trim() || manifest.profile.trim() !== manifest.profile) diagnostics.push(diagnostic('WRC-D011', 'manifest profile must be a non-empty trimmed string', 'manifest.profile'));
  if (!jsonObject(manifest.metadata)) diagnostics.push(diagnostic('WRC-D011', 'manifest metadata must contain only JSON values', 'manifest.metadata'));
  let priorPath;
  for (const artifact of manifest.artifacts) {
    const path = artifact?.path;
    if (!safePath(path) || !Number.isSafeInteger(artifact?.bytes) || artifact.bytes < 0 || !NI_SHA256.test(artifact?.digest ?? '')) {
      diagnostics.push(diagnostic('WRC-D011', 'manifest artifact needs a safe path, byte count, and ni SHA-256 digest', typeof path === 'string' ? path : 'manifest.artifacts'));
      continue;
    }
    if (priorPath !== undefined && compareText(priorPath, path) >= 0) diagnostics.push(diagnostic('WRC-D011', 'manifest artifacts must be sorted by path', path));
    priorPath = path;
    if (Array.isArray(manifest.exclusions) && manifest.exclusions.includes(path)) diagnostics.push(diagnostic('WRC-D011', 'manifest artifact is also excluded', path));
    if (baseUrl !== undefined && artifact.url !== publicUrl(path, baseUrl)) diagnostics.push(diagnostic('WRC-D011', 'manifest artifact URL does not match its path', path));
    if (Object.hasOwn(artifact, 'mediaType') && (typeof artifact.mediaType !== 'string' || !artifact.mediaType.trim())) diagnostics.push(diagnostic('WRC-D011', 'manifest artifact mediaType must be a non-empty string', path));
    if (Object.hasOwn(artifact, 'cacheControl') && !jsonValue(artifact.cacheControl)) diagnostics.push(diagnostic('WRC-D011', 'manifest artifact cacheControl must contain only JSON values', path));
    if (Object.hasOwn(artifact, 'provenance') && !jsonValue(artifact.provenance)) diagnostics.push(diagnostic('WRC-D011', 'manifest artifact provenance must contain only JSON values', path));
    if (expected.has(path)) {
      diagnostics.push(diagnostic('WRC-D011', 'manifest repeats an artifact path', path));
      continue;
    }
    expected.set(path, artifact);
  }
  if (manifest.artifactCount !== expected.size) diagnostics.push(diagnostic('WRC-D011', 'manifest artifactCount does not match its artifact inventory', 'manifest.artifactCount'));
  const expectedBytes = [...expected.values()].reduce((total, artifact) => total + artifact.bytes, 0);
  if (manifest.byteCount !== expectedBytes) diagnostics.push(diagnostic('WRC-D011', 'manifest byteCount does not match its artifact inventory', 'manifest.byteCount'));
  if (!NI_SHA256.test(manifest.digest ?? '')) diagnostics.push(diagnostic('WRC-D011', 'manifest needs an ni SHA-256 digest', 'manifest.digest'));
  else if (makeNiUri(Buffer.from(canonicalJson(manifestCore(manifest)), 'utf8')) !== manifest.digest) diagnostics.push(diagnostic('WRC-D011', 'manifest digest does not identify its declared content', 'manifest.digest'));
  return expected;
}

function manifestExclusions(manifest, diagnostics) {
  const exclusions = new Set();
  if (!Array.isArray(manifest?.exclusions)) {
    diagnostics.push(diagnostic('WRC-D011', 'manifest exclusions must be an array', 'manifest.exclusions'));
    return exclusions;
  }
  for (const path of manifest.exclusions) {
    if (!safePath(path)) diagnostics.push(diagnostic('WRC-D011', 'manifest exclusion has an unsafe path', typeof path === 'string' ? path : 'manifest.exclusions'));
    else exclusions.add(path);
  }
  if (exclusions.size !== manifest.exclusions.length || [...exclusions].sort(compareText).join('\n') !== manifest.exclusions.join('\n')) diagnostics.push(diagnostic('WRC-D011', 'manifest exclusions must be sorted and unique', 'manifest.exclusions'));
  return exclusions;
}

function normalizedLimits({ maxFiles, maxBytes }) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0) throw new TypeError('maxFiles must be a non-negative safe integer');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative safe integer');
  return Object.freeze({ maxFiles, maxBytes });
}

function result({ root, manifest, diagnostics, fileCount = 0, byteCount = 0, expectedFileCount = 0, verifiedFileCount = 0, excludedFileCount = 0, limits = Object.freeze({ maxFiles: DEFAULT_MAX_FILES, maxBytes: DEFAULT_MAX_BYTES }) }) {
  return Object.freeze({
    kind: 'web-release-directory-verification',
    version: 1,
    valid: diagnostics.length === 0,
    root,
    manifestDigest: typeof manifest?.digest === 'string' ? manifest.digest : null,
    fileCount,
    byteCount,
    expectedFileCount,
    verifiedFileCount,
    excludedFileCount,
    limits,
    diagnostics: Object.freeze(diagnostics),
  });
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\')
    && !/[?#\u0000-\u001f\u007f]/u.test(value)
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}
function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
}
function manifestCore(manifest) {
  return {
    kind: manifest.kind, version: manifest.version, baseUrl: manifest.baseUrl,
    profile: manifest.profile, exclusions: manifest.exclusions,
    artifactCount: manifest.artifactCount, byteCount: manifest.byteCount,
    metadata: manifest.metadata, artifacts: manifest.artifacts,
  };
}
function normalizedBaseUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith('/') ? url.href : undefined;
  } catch { return undefined; }
}
function publicUrl(path, baseUrl) {
  const route = path === 'index.html' ? '' : path.endsWith('/index.html') ? path.slice(0, -'index.html'.length) : path;
  return new URL(route, baseUrl).href;
}
function jsonObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && jsonValue(value); }
function jsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value)).every((item) => jsonValue(item, seen));
  seen.delete(value);
  return valid;
}
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function diagnostic(code, message, subject, details) { return Object.freeze({ severity: 'error', code, message, subject, ...(details === undefined ? {} : { details }) }); }
