import { canonicalJson } from "@red-cup-engineering/json-services-section/canonical-json";
import { makeNiUri } from "@red-cup-engineering/uri-services-section/ni-uri";

export { verifyWebReleaseDirectory } from './verify-web-release-directory.mjs';
export { observePublicRelease } from './observe-public-release.mjs';

const KIND = 'web-release-manifest';
const VERSION = 1;
const PUBLIC_RELEASE_KIND = 'public-release';
const PUBLIC_RELEASE_VERSION = 1;

export function createWebReleaseManifest({ artifacts, baseUrl, profile = 'candidate', excludePaths = [], metadata = {} } = {}) {
  const origin = normalizedBaseUrl(baseUrl);
  const candidateProfile = nonEmpty(profile, 'profile');
  const exclusions = normalizedPaths(excludePaths, 'excludePaths');
  const excluded = new Set(exclusions);
  const entries = inventory(artifacts)
    .filter(([path]) => !excluded.has(path))
    .map(([path, value]) => manifestArtifact(path, value, origin))
    .sort((left, right) => compareText(left.path, right.path));
  const safeMetadata = jsonValue(metadata, 'metadata');
  if (!safeMetadata || typeof safeMetadata !== 'object' || Array.isArray(safeMetadata)) {
    throw new TypeError('metadata must be a JSON object');
  }
  const core = {
    kind: KIND,
    version: VERSION,
    baseUrl: origin,
    profile: candidateProfile,
    exclusions,
    artifactCount: entries.length,
    byteCount: entries.reduce((total, artifact) => total + artifact.bytes, 0),
    metadata: safeMetadata,
    artifacts: entries,
  };
  const digest = makeNiUri(Buffer.from(canonicalJson(core), 'utf8'));
  return deepFreeze({ ...core, digest });
}

export function serializeWebReleaseManifest(manifest) {
  assertManifest(manifest);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function validateWebReleaseManifest(manifest) {
  try {
    validateManifestShape(manifest);
    return frozenVerification([]);
  } catch (error) {
    return frozenVerification([diagnostic('WRC-001', error instanceof Error ? error.message : String(error), 'manifest')]);
  }
}

export function projectWebReleaseManifestArtifact({ artifacts, config = {} } = {}) {
  try {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('config must be an object');
    const allowed = new Set(['path', 'baseUrl', 'profile', 'excludePaths', 'metadata']);
    const unknown = Object.keys(config).filter((key) => !allowed.has(key));
    if (unknown.length) throw new TypeError(`unknown release configuration keys: ${unknown.sort(compareText).join(', ')}`);
    const path = config.path ?? 'release-manifest.json';
    safePath(path, 'config.path');
    const excludePaths = [...new Set([...(config.excludePaths ?? []), path])];
    const manifest = createWebReleaseManifest({ ...config, artifacts, excludePaths });
    return Object.freeze({
      manifest,
      artifacts: Object.freeze([Object.freeze({
        path,
        body: serializeWebReleaseManifest(manifest),
        mediaType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=0, must-revalidate',
        source: `release:${manifest.digest}`,
      })]),
      diagnostics: Object.freeze([]),
    });
  } catch (error) {
    return Object.freeze({
      manifest: null,
      artifacts: Object.freeze([]),
      diagnostics: Object.freeze([diagnostic('WRC-008', error instanceof Error ? error.message : String(error), 'config')]),
    });
  }
}

export function verifyWebReleaseManifest({ manifest, artifacts } = {}) {
  const diagnostics = [];
  const validation = validateWebReleaseManifest(manifest);
  if (!validation.valid) {
    const found = [...validation.diagnostics];
    try {
      if (makeNiUri(Buffer.from(canonicalJson(manifestCore(manifest)), 'utf8')) !== manifest.digest) found.push(diagnostic('WRC-006', 'manifest digest does not identify its declared content', 'manifest.digest'));
    } catch { /* the shape diagnostic already describes unreadable manifest content */ }
    return frozenVerification(found);
  }
  let recreated;
  try {
    recreated = createWebReleaseManifest({
      artifacts,
      baseUrl: manifest.baseUrl,
      profile: manifest.profile,
      excludePaths: manifest.exclusions,
      metadata: manifest.metadata,
    });
  } catch (error) {
    return frozenVerification([diagnostic('WRC-002', error.message, 'artifacts')]);
  }
  const expected = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
  const actual = new Map(recreated.artifacts.map((artifact) => [artifact.path, artifact]));
  for (const path of [...new Set([...expected.keys(), ...actual.keys()])].sort(compareText)) {
    if (!expected.has(path)) diagnostics.push(diagnostic('WRC-003', 'artifact is absent from the manifest', path));
    else if (!actual.has(path)) diagnostics.push(diagnostic('WRC-004', 'manifest artifact is absent from the inventory', path));
    else if (canonicalJson(expected.get(path)) !== canonicalJson(actual.get(path))) diagnostics.push(diagnostic('WRC-005', 'artifact bytes or metadata differ from the manifest', path));
  }
  const expectedCore = manifestCore(manifest);
  if (makeNiUri(Buffer.from(canonicalJson(expectedCore), 'utf8')) !== manifest.digest) diagnostics.push(diagnostic('WRC-006', 'manifest digest does not identify its declared content', 'manifest.digest'));
  if (recreated.digest !== manifest.digest) diagnostics.push(diagnostic('WRC-007', 'candidate inventory does not reproduce the manifest digest', 'manifest.digest'));
  return frozenVerification(diagnostics);
}

export function compareWebReleaseCandidates({ baseline, candidate, classifyDelta } = {}) {
  assertManifest(baseline);
  assertManifest(candidate);
  if (classifyDelta !== undefined && typeof classifyDelta !== 'function') throw new TypeError('classifyDelta must be a function');
  const before = new Map(baseline.artifacts.map((artifact) => [artifact.path, artifact]));
  const after = new Map(candidate.artifacts.map((artifact) => [artifact.path, artifact]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(compareText);
  const deltas = paths.map((path) => {
    const baselineArtifact = before.get(path);
    const candidateArtifact = after.get(path);
    const change = baselineArtifact === undefined ? 'added'
      : candidateArtifact === undefined ? 'removed'
        : canonicalJson(baselineArtifact) === canonicalJson(candidateArtifact) ? 'identical' : 'changed';
    if (change === 'identical') return Object.freeze({ path, change, disposition: 'identical', intentional: true });
    const delta = Object.freeze({ path, change, baseline: baselineArtifact, candidate: candidateArtifact });
    const classified = classifyDelta?.(delta);
    if (classified !== undefined && (typeof classified !== 'string' || !classified.trim())) {
      throw new TypeError('classifyDelta must return undefined or a non-empty disposition string');
    }
    return Object.freeze({ path, change, disposition: classified?.trim() ?? 'unexpected', intentional: classified !== undefined });
  });
  const unexpectedPaths = Object.freeze(deltas.filter((delta) => !delta.intentional).map((delta) => delta.path));
  return deepFreeze({
    kind: 'web-release-parity',
    version: 1,
    baselineDigest: baseline.digest,
    candidateDigest: candidate.digest,
    routeSetsEqual: [...before.keys()].sort(compareText).join('\n') === [...after.keys()].sort(compareText).join('\n'),
    exactArtifactCount: deltas.filter((delta) => delta.change === 'identical').length,
    intentionalDeltaCount: deltas.filter((delta) => delta.change !== 'identical' && delta.intentional).length,
    unexpectedDeltaCount: unexpectedPaths.length,
    unexpectedPaths,
    deltas,
    candidateReady: unexpectedPaths.length === 0,
  });
}

/**
 * Create one immutable release intent which joins source, artifact, public
 * contract, provider target, and the version/route expected before deployment.
 * This is deliberately an intent: upload, DNS changes, and probing remain
 * explicit provider/observer effects outside this package.
 */
export function createPublicRelease({ source, artifact, channel, target, snapshot } = {}) {
  const core = publicReleaseCore({ source, artifact, channel, target, snapshot });
  return deepFreeze({ ...core, digest: makeNiUri(Buffer.from(canonicalJson(core), 'utf8')) });
}

export function validatePublicRelease(release) {
  try {
    validatePublicReleaseShape(release);
    return frozenVerification([]);
  } catch (error) {
    return frozenVerification([diagnostic('WRC-100', error instanceof Error ? error.message : String(error), 'public-release')]);
  }
}

/**
 * Determine the sole next release action from immutable evidence. A caller
 * performs the indicated effect and supplies its receipt/observation on the
 * next invocation; this makes retries safe and exposes an unaccepted receiver.
 */
export function decidePublicRelease({ release, activeReceipt, candidateReceipt, candidateObservation, receiverObservation } = {}) {
  const validation = validatePublicRelease(release);
  if (!validation.valid) return publicReleaseDecision('refusal', release?.digest ?? null, validation.diagnostics.map((item) => item.message));
  const active = receiptAssessment(activeReceipt, release, release.channel.canonicalOrigin, 'activeReceipt');
  const canonical = observationAssessment(receiverObservation, release, release.channel.canonicalOrigin, 'receiverObservation');
  if (active.present && !active.valid) return publicReleaseDecision('refusal', release.digest, active.reasons);
  if (canonical.present && !canonical.valid) return publicReleaseDecision('refusal', release.digest, canonical.reasons);
  if (active.accepted && canonical.accepted) return publicReleaseDecision('no-op', release.digest, [], { receipt: activeReceipt, acceptance: receiverObservation });

  const candidate = receiptAssessment(candidateReceipt, release, null, 'candidateReceipt');
  const observedCandidateOrigin = candidateReceipt?.candidateOrigin;
  const candidateObserved = observationAssessment(candidateObservation, release, observedCandidateOrigin ?? null, 'candidateObservation');
  if (candidate.present && !candidate.valid) return publicReleaseDecision('refusal', release.digest, candidate.reasons);
  if (candidateObserved.present && !candidateObserved.valid) return publicReleaseDecision('refusal', release.digest, candidateObserved.reasons);
  if (candidate.accepted && candidateObserved.accepted) {
    return publicReleaseDecision('cutover', release.digest, [
      `authorize canonical receiver cutover for ${release.channel.canonicalOrigin}`,
      'preserve the recorded prior provider version for rollback',
      'obtain an independent canonical receiver observation after cutover',
    ], { candidateReceipt, candidateAcceptance: candidateObservation });
  }
  return publicReleaseDecision('candidate', release.digest, [
    'deploy a candidate with the exact artifact, target config, bindings, and recorded baseline route',
    'record a candidate receipt with provider version and candidate origin',
    'obtain an independent candidate observation satisfying every declared probe',
  ], { ...(candidate.present ? { candidateReceipt } : {}) });
}

function publicReleaseCore({ source, artifact, channel, target, snapshot }) {
  const normalizedSource = publicReleaseSource(source);
  const manifest = artifact?.manifest;
  assertManifest(manifest);
  const normalizedChannel = publicReleaseChannel(channel, manifest);
  const normalizedTarget = publicReleaseTarget(target);
  const normalizedSnapshot = publicReleaseSnapshot(snapshot);
  return {
    kind: PUBLIC_RELEASE_KIND,
    version: PUBLIC_RELEASE_VERSION,
    source: normalizedSource,
    artifact: { manifest, manifestDigest: manifest.digest },
    channel: normalizedChannel,
    target: normalizedTarget,
    snapshot: normalizedSnapshot,
  };
}

function validatePublicReleaseShape(release) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) throw new TypeError('public release must be an object');
  if (release.kind !== PUBLIC_RELEASE_KIND || release.version !== PUBLIC_RELEASE_VERSION) throw new TypeError('unsupported public release');
  const core = publicReleaseCore(release);
  if (canonicalJson(core) !== canonicalJson({ kind: release.kind, version: release.version, source: release.source, artifact: release.artifact, channel: release.channel, target: release.target, snapshot: release.snapshot })) throw new TypeError('public release is not normalized');
  if (typeof release.digest !== 'string' || !isNi(release.digest) || makeNiUri(Buffer.from(canonicalJson(core), 'utf8')) !== release.digest) throw new TypeError('public release digest does not identify its declared content');
}

function publicReleaseSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('source must be an object');
  const repository = nonEmpty(value.repository, 'source.repository');
  const revision = nonEmpty(value.revision, 'source.revision');
  const build = value.build;
  if (!build || typeof build !== 'object' || Array.isArray(build) || !Array.isArray(build.command) || build.command.length === 0) throw new TypeError('source.build.command must be a non-empty argument array');
  const command = build.command.map((argument) => nonEmpty(argument, 'source.build.command'));
  const outputRoot = safeRelativeDirectory(build.outputRoot, 'source.build.outputRoot');
  return deepFreeze({ repository, revision, build: { command, outputRoot } });
}

function publicReleaseChannel(value, manifest) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('channel must be an object');
  const canonicalOrigin = normalizedBaseUrl(value.canonicalOrigin);
  const stateClass = value.stateClass;
  if (!['static', 'edge-static', 'durable'].includes(stateClass)) throw new TypeError('channel.stateClass must be static, edge-static, or durable');
  if (!Array.isArray(value.probes) || value.probes.length === 0) throw new TypeError('channel.probes must be a non-empty array');
  const ids = new Set();
  const probes = value.probes.map((probe) => {
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) throw new TypeError('channel probes must be objects');
    const id = nonEmpty(probe.id, 'channel.probe.id');
    if (ids.has(id)) throw new TypeError(`channel probe id is duplicated: ${id}`);
    ids.add(id);
    const method = probe.method;
    if (!['GET', 'HEAD', 'POST'].includes(method)) throw new TypeError(`channel probe method is unsupported: ${id}`);
    const path = publicProbePath(probe.path, id);
    const expectedStatus = probe.expectedStatus;
    if (!Number.isSafeInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) throw new TypeError(`channel probe expectedStatus is invalid: ${id}`);
    const artifactPath = probe.artifactPath === undefined ? undefined : safePath(probe.artifactPath, `channel probe artifactPath: ${id}`);
    if (artifactPath !== undefined && !manifest.artifacts.some((artifact) => artifact.path === artifactPath)) throw new TypeError(`channel probe artifactPath is absent from the release manifest: ${id}`);
    const contentType = probe.contentType === undefined ? undefined : nonEmpty(probe.contentType, `channel probe contentType: ${id}`);
    return deepFreeze({ id, method, path, expectedStatus, ...(artifactPath === undefined ? {} : { artifactPath }), ...(contentType === undefined ? {} : { contentType }) });
  }).sort((left, right) => compareText(left.id, right.id));
  if (canonicalJson(probes) !== canonicalJson(value.probes)) throw new TypeError('channel.probes must be sorted by id');
  return deepFreeze({ canonicalOrigin, stateClass, probes });
}

function publicReleaseTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('target must be an object');
  return deepFreeze({
    provider: nonEmpty(value.provider, 'target.provider'), receiver: nonEmpty(value.receiver, 'target.receiver'),
    configDigest: requiredNi(value.configDigest, 'target.configDigest'), bindingDigest: requiredNi(value.bindingDigest, 'target.bindingDigest'),
  });
}

function publicReleaseSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('snapshot must be an object');
  return deepFreeze({ providerVersion: nonEmpty(value.providerVersion, 'snapshot.providerVersion'), routeDigest: requiredNi(value.routeDigest, 'snapshot.routeDigest') });
}

function receiptAssessment(value, release, requiredOrigin, field) {
  if (value === undefined) return { present: false, valid: true, accepted: false, reasons: [] };
  const reasons = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) reasons.push(`${field} must be an object`);
  else {
    if (value.kind !== 'public-release-receipt' || value.version !== 1) reasons.push(`${field} has an unsupported kind or version`);
    if (value.releaseDigest !== release.digest) reasons.push(`${field}.releaseDigest does not match the release`);
    if (value.provider !== release.target.provider || value.receiver !== release.target.receiver) reasons.push(`${field} target does not match the release`);
    if (value.artifactManifestDigest !== release.artifact.manifestDigest || value.configDigest !== release.target.configDigest || value.bindingDigest !== release.target.bindingDigest) reasons.push(`${field} identity does not match the release`);
    if (typeof value.providerVersion !== 'string' || !value.providerVersion.trim()) reasons.push(`${field}.providerVersion is absent`);
    if (!isNi(value.routeDigest)) reasons.push(`${field}.routeDigest is not an ni digest`);
    if (value.baselineProviderVersion !== release.snapshot.providerVersion || value.baselineRouteDigest !== release.snapshot.routeDigest) reasons.push(`${field} was not made from the declared provider version and route snapshot`);
    if (requiredOrigin !== null && value.canonicalOrigin !== requiredOrigin) reasons.push(`${field}.canonicalOrigin does not match the release`);
    if (requiredOrigin === null && normalizedOptionalOrigin(value.candidateOrigin) === null) reasons.push(`${field}.candidateOrigin is absent or invalid`);
  }
  return { present: true, valid: reasons.length === 0, accepted: reasons.length === 0, reasons };
}

function observationAssessment(value, release, expectedOrigin, field) {
  if (value === undefined) return { present: false, valid: true, accepted: false, reasons: [] };
  const reasons = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) reasons.push(`${field} must be an object`);
  else {
    if (value.kind !== 'public-release-observation' || value.version !== 1 || value.releaseDigest !== release.digest) reasons.push(`${field} does not identify this release`);
    if (value.independent !== true || typeof value.observer !== 'string' || !value.observer.trim()) reasons.push(`${field} is not an independent named observation`);
    if (expectedOrigin === null || normalizedOptionalOrigin(value.origin) !== expectedOrigin) reasons.push(`${field}.origin does not match its receiver`);
    if (!isInstant(value.observedAt)) reasons.push(`${field}.observedAt is not a UTC instant`);
    const found = new Map(Array.isArray(value.probes) ? value.probes.map((probe) => [probe?.id, probe]) : []);
    if (!Array.isArray(value.probes) || found.size !== value.probes.length) reasons.push(`${field}.probes must have unique ids`);
    for (const probe of release.channel.probes) {
      const observed = found.get(probe.id);
      if (!observed || observed.status !== probe.expectedStatus) { reasons.push(`${field} did not satisfy ${probe.id}`); continue; }
      if (probe.contentType !== undefined && observed.contentType !== probe.contentType) reasons.push(`${field} content type differs for ${probe.id}`);
      if (probe.artifactPath !== undefined) {
        const expected = release.artifact.manifest.artifacts.find((artifact) => artifact.path === probe.artifactPath);
        if (observed.digest !== expected.digest) reasons.push(`${field} artifact digest differs for ${probe.id}`);
      }
    }
  }
  return { present: true, valid: reasons.length === 0, accepted: reasons.length === 0, reasons };
}

function publicReleaseDecision(disposition, releaseDigest, requirements, evidence = {}) {
  return deepFreeze({ kind: 'public-release-decision', version: 1, disposition, releaseDigest, requirements: [...requirements], ...evidence });
}

function safeRelativeDirectory(value, field) {
  safePath(value, field);
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
function publicProbePath(value, id) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\') || /[?#\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`channel probe path is invalid: ${id}`);
  return value;
}
function requiredNi(value, field) { if (!isNi(value)) throw new TypeError(`${field} must be an ni SHA-256 identifier`); return value; }
function isNi(value) { return typeof value === 'string' && /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u.test(value); }
function normalizedOptionalOrigin(value) { try { return normalizedBaseUrl(value); } catch { return null; } }
function isInstant(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) && Number.isFinite(Date.parse(value)); }

function manifestArtifact(path, value, baseUrl) {
  const record = artifactRecord(value);
  const body = bytes(record.body, path);
  if (record.mediaType !== undefined && (typeof record.mediaType !== 'string' || !record.mediaType.trim())) {
    throw new TypeError(`${path}.mediaType must be a non-empty string`);
  }
  return deepFreeze({
    path,
    url: publicUrl(path, baseUrl),
    bytes: body.byteLength,
    digest: makeNiUri(body),
    ...(record.mediaType === undefined ? {} : { mediaType: record.mediaType }),
    ...(record.cacheControl === undefined ? {} : { cacheControl: jsonValue(record.cacheControl, `${path}.cacheControl`) }),
    ...(record.provenance === undefined ? {} : { provenance: jsonValue(record.provenance, `${path}.provenance`) }),
  });
}

function inventory(value) {
  if (!value || typeof value[Symbol.iterator] !== 'function') throw new TypeError('artifacts must be an iterable inventory');
  const result = new Map();
  for (const entry of value) {
    const tuple = Array.isArray(entry);
    const path = tuple ? entry[0] : entry?.path;
    const artifact = tuple ? entry[1] : entry;
    safePath(path, 'artifact path');
    if (result.has(path)) throw new TypeError(`artifact path is duplicated: ${path}`);
    result.set(path, artifact);
  }
  return [...result];
}

function artifactRecord(value) {
  return value && typeof value === 'object' && !(value instanceof Uint8Array) && 'body' in value ? value : { body: value };
}

function bytes(value, path) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError(`artifact body must be a string or Uint8Array: ${path}`);
}

function publicUrl(path, baseUrl) {
  const route = path === 'index.html' ? '' : path.endsWith('/index.html') ? path.slice(0, -'index.html'.length) : path;
  return new URL(route, baseUrl).href;
}

function manifestCore(manifest) {
  return {
    kind: manifest.kind, version: manifest.version, baseUrl: manifest.baseUrl,
    profile: manifest.profile, exclusions: manifest.exclusions,
    artifactCount: manifest.artifactCount, byteCount: manifest.byteCount,
    metadata: manifest.metadata, artifacts: manifest.artifacts,
  };
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new TypeError('manifest must be an object');
  if (manifest.kind !== KIND || manifest.version !== VERSION) throw new TypeError('unsupported web release manifest');
  const baseUrl = normalizedBaseUrl(manifest.baseUrl);
  if (baseUrl !== manifest.baseUrl) throw new TypeError('manifest.baseUrl must be normalized');
  if (nonEmpty(manifest.profile, 'manifest.profile') !== manifest.profile) throw new TypeError('manifest.profile must not have surrounding whitespace');
  const exclusions = normalizedPaths(manifest.exclusions, 'manifest.exclusions');
  if (canonicalJson(exclusions) !== canonicalJson(manifest.exclusions)) throw new TypeError('manifest.exclusions must be sorted and unique');
  const metadata = jsonValue(manifest.metadata, 'manifest.metadata');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('manifest.metadata must be a JSON object');
  if (!Array.isArray(manifest.artifacts)) throw new TypeError('manifest.artifacts must be an array');
  const paths = new Set();
  let byteCount = 0;
  let priorPath;
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new TypeError('manifest artifacts must be objects');
    safePath(artifact.path, 'manifest artifact path');
    if (paths.has(artifact.path)) throw new TypeError(`manifest repeats artifact path: ${artifact.path}`);
    if (priorPath !== undefined && compareText(priorPath, artifact.path) >= 0) throw new TypeError('manifest artifacts must be sorted by path');
    if (exclusions.includes(artifact.path)) throw new TypeError(`manifest artifact is also excluded: ${artifact.path}`);
    paths.add(artifact.path); priorPath = artifact.path;
    if (artifact.url !== publicUrl(artifact.path, baseUrl)) throw new TypeError(`manifest artifact URL does not match its path: ${artifact.path}`);
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) throw new TypeError(`manifest artifact bytes must be a non-negative safe integer: ${artifact.path}`);
    if (typeof artifact.digest !== 'string' || !/^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u.test(artifact.digest)) throw new TypeError(`manifest artifact digest must be an ni SHA-256 identifier: ${artifact.path}`);
    if (Object.hasOwn(artifact, 'mediaType') && (typeof artifact.mediaType !== 'string' || !artifact.mediaType.trim())) throw new TypeError(`manifest artifact mediaType must be a non-empty string: ${artifact.path}`);
    if (Object.hasOwn(artifact, 'cacheControl')) jsonValue(artifact.cacheControl, `${artifact.path}.cacheControl`);
    if (Object.hasOwn(artifact, 'provenance')) jsonValue(artifact.provenance, `${artifact.path}.provenance`);
    byteCount += artifact.bytes;
    if (!Number.isSafeInteger(byteCount)) throw new TypeError('manifest byteCount exceeds the safe integer range');
  }
  if (manifest.artifactCount !== manifest.artifacts.length) throw new TypeError('manifest.artifactCount does not match its artifacts');
  if (manifest.byteCount !== byteCount) throw new TypeError('manifest.byteCount does not match its artifacts');
  if (typeof manifest.digest !== 'string' || !/^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u.test(manifest.digest)) throw new TypeError('manifest.digest must be an ni SHA-256 identifier');
  if (makeNiUri(Buffer.from(canonicalJson(manifestCore(manifest)), 'utf8')) !== manifest.digest) throw new TypeError('manifest.digest does not identify its declared content');
}

function assertManifest(manifest) {
  const validation = validateWebReleaseManifest(manifest);
  if (!validation.valid) throw new TypeError(validation.diagnostics[0].message);
}

function normalizedBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('baseUrl must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) {
    throw new TypeError('baseUrl must be an absolute HTTP(S) directory URL without credentials, query, or fragment');
  }
  return url.href;
}

function normalizedPaths(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return Object.freeze([...new Set(value.map((path) => safePath(path, field)))].sort(compareText));
}

function safePath(value, field) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || /[?#\u0000-\u001f\u007f]/u.test(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError(`${field} must contain safe relative artifact paths`);
  }
  return value;
}

function nonEmpty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function jsonValue(value, field, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError(`${field} must not contain cycles`);
    seen.add(value);
    const result = value.map((item) => jsonValue(item, field, seen));
    seen.delete(value);
    return result;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${field} must contain only JSON values`);
  if (seen.has(value)) throw new TypeError(`${field} must not contain cycles`);
  seen.add(value);
  const result = Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, jsonValue(value[key], field, seen)]));
  seen.delete(value);
  return result;
}

/**
 * Render JSON after recursively sorting object keys.
 *
 * JSON.stringify deliberately retains its property enumeration behavior,
 * including numeric-key ordering, because release manifest digests identify
 * these exact bytes.
 */
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function diagnostic(code, message, subject) { return Object.freeze({ severity: 'error', code, message, subject }); }
function frozenVerification(diagnostics) { return Object.freeze({ valid: diagnostics.length === 0, diagnostics: Object.freeze(diagnostics) }); }
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
