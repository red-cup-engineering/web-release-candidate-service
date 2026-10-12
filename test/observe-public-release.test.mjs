import assert from 'node:assert/strict';
import test from 'node:test';

import { createPublicRelease, createWebReleaseManifest, decidePublicRelease, observePublicRelease } from '../src/web-release-candidate.mjs';

const ni = (letter) => `ni:///sha-256;${letter.repeat(43)}`;

function release() {
  const manifest = createWebReleaseManifest({
    artifacts: new Map([['index.html', { body: '<h1>Weiqi</h1>\n', mediaType: 'text/html' }]]),
    baseUrl: 'https://weiqi.example.test/',
  });
  return createPublicRelease({
    source: { repository: '561-group/weiqi', revision: 'test-revision', build: { command: ['npm', 'run', 'build'], outputRoot: 'dist' } },
    artifact: { manifest },
    channel: { canonicalOrigin: 'https://weiqi.example.test/', stateClass: 'edge-static', probes: [
      { id: 'home', method: 'GET', path: '/', expectedStatus: 200, artifactPath: 'index.html', contentType: 'text/html' },
    ] },
    target: { provider: 'test-provider', receiver: 'test-receiver', configDigest: ni('a'), bindingDigest: ni('b') },
    snapshot: { providerVersion: 'before', routeDigest: ni('c') },
  });
}

test('observer uses the injected public fetch capability in declared probe order and emits receiver-ready evidence', async () => {
  const declared = release();
  const calls = [];
  const observed = await observePublicRelease({
    release: declared,
    observer: 'independent-qa',
    observedAt: '2026-09-10T00:00:00.000Z',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response('<h1>Weiqi</h1>\n', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  assert.equal(observed.kind, 'public-release-observation');
  assert.equal(observed.origin, 'https://weiqi.example.test/');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://weiqi.example.test/');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'follow');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(observed.probes[0].contentType, 'text/html');
  assert.equal(observed.probes[0].digest, declared.artifact.manifest.artifacts[0].digest);
  const decision = decidePublicRelease({ release: declared, receiverObservation: observed });
  assert.equal(decision.disposition, 'candidate');
  assert.ok(!decision.requirements.some((requirement) => requirement.includes('receiverObservation')));
});

test('observer aborts and refuses a stalled receiver probe at its configured deadline', async () => {
  let aborted = false;
  const observed = await observePublicRelease({
    release: release(),
    observer: 'independent-qa',
    observedAt: '2026-09-10T00:00:00.000Z',
    timeoutMs: 1,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      }, { once: true });
    }),
  });
  assert.equal(observed.kind, 'public-release-observation-refusal');
  assert.equal(aborted, true);
  assert.deepEqual(observed.reasons, ['home: timed out after 1ms']);
  assert.equal(observed.probes[0].error, 'timed out after 1ms');
});

test('observer preserves per-probe evidence and refuses status, content, and byte mismatches without provider effects', async () => {
  const declared = release();
  const observed = await observePublicRelease({
    release: declared,
    observer: 'independent-qa',
    observedAt: '2026-09-10T00:00:00.000Z',
    fetch: async () => new Response('wrong', { status: 503, headers: { 'content-type': 'text/plain' } }),
  });
  assert.equal(observed.kind, 'public-release-observation-refusal');
  assert.equal(observed.probes[0].status, 503);
  assert.equal(observed.probes[0].contentType, 'text/plain');
  assert.match(observed.probes[0].digest, /^ni:\/\/\/sha-256;/u);
  assert.equal(observed.reasons.length, 3);
});

test('observer refuses an invalid operation before invoking fetch', async () => {
  const declared = release();
  const invalid = { ...declared, digest: 'not-an-ni' };
  let calls = 0;
  const observed = await observePublicRelease({
    release: invalid,
    observer: 'independent-qa',
    observedAt: '2026-09-10T00:00:00.000Z',
    fetch: async () => { calls += 1; return new Response('unexpected'); },
  });
  assert.equal(observed.kind, 'public-release-observation-refusal');
  assert.equal(calls, 0);
});
