import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareWebReleaseCandidates,
  createPublicRelease,
  createWebReleaseManifest,
  decidePublicRelease,
  projectWebReleaseManifestArtifact,
  serializeWebReleaseManifest,
  validateWebReleaseManifest,
  validatePublicRelease,
  verifyWebReleaseManifest,
} from '../src/web-release-candidate.mjs';
import { canonicalJson } from '@red-cup-engineering/json-services-section/canonical-json';

const BASE = 'https://example.test/';

test('release manifests are deterministic over inventory and metadata key order', () => {
  const left = createWebReleaseManifest({
    artifacts: new Map([['b.txt', 'two'], ['index.html', 'one']]), baseUrl: BASE,
    metadata: { z: 2, a: { y: true, x: false } },
  });
  const right = createWebReleaseManifest({
    artifacts: new Map([['index.html', 'one'], ['b.txt', 'two']]), baseUrl: BASE,
    metadata: { a: { x: false, y: true }, z: 2 },
  });
  assert.deepEqual(left, right);
  assert.equal(left.artifacts[0].path, 'b.txt');
  assert.equal(left.artifacts[1].url, BASE);
  assert.match(left.digest, /^ni:\/\/\/sha-256;/);
  assert.equal(Object.isFrozen(left.artifacts), true);
});

test('manifest digests are over RFC 8785 canonical JSON, numeric keys in code-unit order', () => {
  const value = { 10: 'ten', 2: 'two', nested: [{ 10: 'ten', 2: 'two' }] };
  assert.equal(canonicalJson(value), '{"10":"ten","2":"two","nested":[{"10":"ten","2":"two"}]}');
  const manifest = createWebReleaseManifest({
    artifacts: new Map([['10.txt', 'ten'], ['2.txt', 'two']]), baseUrl: BASE, metadata: value,
  });
  assert.equal(manifest.digest, 'ni:///sha-256;9wfJxE5I_DfpOZ8_Fp3_V4o4TfDEfxV86d3yi9D3vtA');
});

test('projection preserves useful artifact metadata and excludes recursive outputs', () => {
  const artifacts = new Map([
    ['index.html', { body: '<h1>Hello</h1>', mediaType: 'text/html; charset=utf-8', cacheControl: 'no-cache', provenance: { projector: 'page' } }],
    ['report.json', '{}'],
  ]);
  const result = projectWebReleaseManifestArtifact({ artifacts, config: { baseUrl: BASE, profile: 'production-candidate', excludePaths: ['report.json'] } });
  assert.equal(result.manifest.artifactCount, 1);
  assert.equal(result.manifest.artifacts[0].mediaType, 'text/html; charset=utf-8');
  assert.deepEqual(result.manifest.artifacts[0].provenance, { projector: 'page' });
  assert.deepEqual(result.manifest.exclusions, ['release-manifest.json', 'report.json']);
  assert.equal(JSON.parse(result.artifacts[0].body).digest, result.manifest.digest);
});

test('verification detects changed, missing, unexpected, and self-inconsistent candidates', () => {
  const inventory = new Map([['index.html', 'one'], ['asset.txt', 'two']]);
  const manifest = createWebReleaseManifest({ artifacts: inventory, baseUrl: BASE });
  assert.deepEqual(verifyWebReleaseManifest({ manifest, artifacts: inventory }), { valid: true, diagnostics: [] });
  const changed = verifyWebReleaseManifest({ manifest, artifacts: new Map([['index.html', 'changed'], ['extra.txt', 'x']]) });
  assert.equal(changed.valid, false);
  assert.deepEqual(new Set(changed.diagnostics.map(({ code }) => code)), new Set(['WRC-003', 'WRC-004', 'WRC-005', 'WRC-007']));
  const forged = { ...manifest, artifactCount: 99 };
  assert.ok(verifyWebReleaseManifest({ manifest: forged, artifacts: inventory }).diagnostics.some(({ code }) => code === 'WRC-006'));
});

test('profile parity exposes unexpected changes and accepts explicit classifications', () => {
  const baseline = createWebReleaseManifest({ artifacts: new Map([['index.html', 'one'], ['robots.txt', 'Disallow: /']]), baseUrl: BASE, profile: 'shadow' });
  const candidate = createWebReleaseManifest({ artifacts: new Map([['index.html', 'two'], ['robots.txt', 'Allow: /'], ['new.txt', 'new']]), baseUrl: BASE, profile: 'candidate' });
  const strict = compareWebReleaseCandidates({ baseline, candidate });
  assert.equal(strict.candidateReady, false);
  assert.deepEqual(strict.unexpectedPaths, ['index.html', 'new.txt', 'robots.txt']);
  const classified = compareWebReleaseCandidates({
    baseline, candidate,
    classifyDelta: ({ path }) => path === 'robots.txt' ? 'indexing-policy' : path === 'index.html' ? 'profile-shell' : undefined,
  });
  assert.equal(classified.intentionalDeltaCount, 2);
  assert.deepEqual(classified.unexpectedPaths, ['new.txt']);
});

test('unsafe paths, non-JSON metadata, invalid origins, and invalid classifiers fail closed', () => {
  assert.throws(() => createWebReleaseManifest({ artifacts: new Map([['../escape', 'x']]), baseUrl: BASE }), /safe relative/);
  assert.throws(() => createWebReleaseManifest({ artifacts: new Map([['page?draft', 'x']]), baseUrl: BASE }), /safe relative/);
  assert.throws(() => createWebReleaseManifest({ artifacts: new Map(), baseUrl: 'file:///tmp/' }), /HTTP/);
  assert.throws(() => createWebReleaseManifest({ artifacts: new Map(), baseUrl: BASE, metadata: { value: undefined } }), /JSON/);
  const cyclic = []; cyclic.push(cyclic);
  assert.throws(() => createWebReleaseManifest({ artifacts: new Map(), baseUrl: BASE, metadata: { cyclic } }), /cycles/);
  const baseline = createWebReleaseManifest({ artifacts: new Map([['a', 'x']]), baseUrl: BASE });
  const candidate = createWebReleaseManifest({ artifacts: new Map([['a', 'y']]), baseUrl: BASE });
  assert.throws(() => compareWebReleaseCandidates({ baseline, candidate, classifyDelta: () => '' }), /non-empty/);
  assert.doesNotThrow(() => JSON.parse(serializeWebReleaseManifest(baseline)));
  const projected = projectWebReleaseManifestArtifact({ artifacts: new Map(), config: { baseUrl: BASE, unknown: true } });
  assert.equal(projected.manifest, null);
  assert.equal(projected.diagnostics[0].code, 'WRC-008');
});

test('manifest-only validation rejects aggregate, artifact-shape, and identity drift', () => {
  const manifest = createWebReleaseManifest({ artifacts: new Map([['index.html', { body: 'one', mediaType: 'text/plain' }]]), baseUrl: BASE });
  assert.deepEqual(validateWebReleaseManifest(manifest), { valid: true, diagnostics: [] });
  for (const changed of [
    { ...manifest, artifactCount: 2 },
    { ...manifest, byteCount: 4 },
    { ...manifest, artifacts: [{ ...manifest.artifacts[0], path: '../escape' }] },
    { ...manifest, artifacts: [{ ...manifest.artifacts[0], url: 'https://example.test/wrong' }] },
    { ...manifest, artifacts: [{ ...manifest.artifacts[0], mediaType: '' }] },
    { ...manifest, artifacts: [...manifest.artifacts, manifest.artifacts[0]], artifactCount: 2, byteCount: 6 },
    { ...manifest, digest: 'ni:///sha-256;AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  ]) assert.equal(validateWebReleaseManifest(changed).valid, false);
  assert.throws(() => serializeWebReleaseManifest({ ...manifest, artifactCount: 2 }), /artifactCount/);
  assert.throws(() => compareWebReleaseCandidates({ baseline: manifest, candidate: { ...manifest, byteCount: 4 } }), /byteCount/);
  assert.throws(() => createWebReleaseManifest({ artifacts: new Map([['index.html', { body: 'one', mediaType: 42 }]]), baseUrl: BASE }), /mediaType/);
});

function publicReleaseFixture() {
  const manifest = createWebReleaseManifest({
    artifacts: new Map([['index.html', { body: '<h1>ready</h1>', mediaType: 'text/html' }]]), baseUrl: BASE,
  });
  const release = createPublicRelease({
    source: { repository: '561-group/web', revision: 'abc123', build: { command: ['npm', 'run', 'build'], outputRoot: 'dist' } },
    artifact: { manifest },
    channel: { canonicalOrigin: BASE, stateClass: 'static', probes: [{ id: 'home', method: 'GET', path: '/', expectedStatus: 200, artifactPath: 'index.html', contentType: 'text/html' }] },
    target: { provider: 'cloudflare', receiver: 'worker:example', configDigest: manifest.digest, bindingDigest: manifest.digest },
    snapshot: { providerVersion: 'before', routeDigest: manifest.digest },
  });
  const receipt = (fields) => ({
    kind: 'public-release-receipt', version: 1, releaseDigest: release.digest, provider: 'cloudflare', receiver: 'worker:example',
    artifactManifestDigest: manifest.digest, configDigest: manifest.digest, bindingDigest: manifest.digest,
    providerVersion: 'after', routeDigest: manifest.digest, baselineProviderVersion: 'before', baselineRouteDigest: manifest.digest, ...fields,
  });
  const observation = (origin, fields = {}) => ({
    kind: 'public-release-observation', version: 1, releaseDigest: release.digest, independent: true, observer: 'external-probe',
    origin, observedAt: '2026-09-09T12:00:00.000Z', probes: [{ id: 'home', status: 200, contentType: 'text/html', digest: manifest.artifacts[0].digest }], ...fields,
  });
  return { manifest, release, receipt, observation };
}

test('a public release binds source, manifest, channel, target, and deployment baseline deterministically', () => {
  const { release } = publicReleaseFixture();
  assert.deepEqual(validatePublicRelease(release), { valid: true, diagnostics: [] });
  assert.equal(Object.isFrozen(release.channel.probes), true);
  assert.match(release.digest, /^ni:\/\/\/sha-256;/);
  assert.equal(validatePublicRelease({ ...release, target: { ...release.target, receiver: 'other' } }).valid, false);
  assert.throws(() => createPublicRelease({
    ...release,
    artifact: { manifest: release.artifact.manifest },
    channel: { ...release.channel, probes: [{ ...release.channel.probes[0], artifactPath: 'absent.html' }] },
  }), /absent from the release manifest/);
});

test('public release decision is candidate, cutover, no-op, or typed refusal from evidence', () => {
  const { release, receipt, observation } = publicReleaseFixture();
  const candidate = decidePublicRelease({ release });
  assert.equal(candidate.disposition, 'candidate');
  const candidateReceipt = receipt({ candidateOrigin: 'https://candidate.example/' });
  const cutover = decidePublicRelease({ release, candidateReceipt, candidateObservation: observation('https://candidate.example/') });
  assert.equal(cutover.disposition, 'cutover');
  const noOp = decidePublicRelease({
    release,
    activeReceipt: receipt({ canonicalOrigin: BASE }),
    receiverObservation: observation(BASE),
  });
  assert.equal(noOp.disposition, 'no-op');
  const refused = decidePublicRelease({ release, candidateReceipt, candidateObservation: observation('https://wrong.example/') });
  assert.equal(refused.disposition, 'refusal');
  assert.match(refused.requirements[0], /origin/);
  const drifted = decidePublicRelease({ release, candidateReceipt: receipt({ candidateOrigin: 'https://candidate.example/', baselineProviderVersion: 'someone-else' }) });
  assert.equal(drifted.disposition, 'refusal');
  assert.match(drifted.requirements[0], /snapshot/);
});
