
import { validatePublicRelease } from './web-release-candidate.mjs';
import { makeNiUri } from "@red-cup-engineering/uri-services-section/ni-uri";

/**
 * Observe every declared public receiver probe through a caller-supplied
 * fetch capability. This operation never changes a provider: the caller owns
 * credentials, transport selection, time, and any deployment effect.
 */
export async function observePublicRelease({ release, origin = release?.channel?.canonicalOrigin, observer, observedAt, timeoutMs = 10_000, fetch } = {}) {
  const refusal = ({ releaseDigest = release?.digest ?? null, normalizedOrigin = null, outcomes = [], reasons }) => deepFreeze({
    kind: 'public-release-observation-refusal', version: 1, releaseDigest, origin: normalizedOrigin,
    observer: typeof observer === 'string' ? observer.trim() || null : null,
    observedAt: typeof observedAt === 'string' ? observedAt : null,
    probes: outcomes, reasons,
  });
  const validation = validatePublicRelease(release);
  if (!validation.valid) return refusal({ reasons: validation.diagnostics.map(({ message }) => message) });
  if (typeof fetch !== 'function') return refusal({ releaseDigest: release.digest, reasons: ['fetch must be an injected function'] });
  if (typeof observer !== 'string' || !observer.trim()) return refusal({ releaseDigest: release.digest, reasons: ['observer must be a non-empty string'] });
  if (!isUtcInstant(observedAt)) return refusal({ releaseDigest: release.digest, reasons: ['observedAt must be a UTC ISO-8601 instant'] });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return refusal({ releaseDigest: release.digest, reasons: ['timeoutMs must be a positive safe integer'] });

  let normalizedOrigin;
  try { normalizedOrigin = normalizedBaseUrl(origin); } catch (error) {
    return refusal({ releaseDigest: release.digest, reasons: [error instanceof Error ? error.message : String(error)] });
  }

  const artifacts = new Map(release.artifact.manifest.artifacts.map((artifact) => [artifact.path, artifact]));
  const reasons = [];
  const outcomes = [];
  for (const probe of release.channel.probes) {
    let url;
    try {
      url = new URL(probe.path, normalizedOrigin);
      if (url.origin !== new URL(normalizedOrigin).origin) throw new TypeError('probe path resolves outside the declared origin');
      if (probe.artifactPath !== undefined && probe.method !== 'GET') throw new TypeError('artifact-backed probes require GET');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push(deepFreeze({ id: probe.id, url: probe.path, error: message }));
      reasons.push(`${probe.id}: ${message}`);
      continue;
    }
    try {
      const response = await fetchWithinDeadline({ fetch, method: probe.method, timeoutMs, url: url.href });
      if (!response || !Number.isSafeInteger(response.status)) throw new TypeError('fetch returned no HTTP response');
      const contentType = normalizedMediaType(response.headers?.get?.('content-type'));
      const outcome = { id: probe.id, url: url.href, status: response.status, ...(contentType === undefined ? {} : { contentType }) };
      if (response.status !== probe.expectedStatus) reasons.push(`${probe.id}: expected status ${probe.expectedStatus}, received ${response.status}`);
      if (probe.contentType !== undefined && contentType !== probe.contentType) reasons.push(`${probe.id}: expected content type ${probe.contentType}, received ${contentType ?? 'none'}`);
      if (probe.artifactPath !== undefined) {
        if (typeof response.arrayBuffer !== 'function') throw new TypeError('artifact-backed response has no arrayBuffer method');
        const artifact = artifacts.get(probe.artifactPath);
        const digest = makeNiUri(Buffer.from(await response.arrayBuffer()));
        outcome.digest = digest;
        if (digest !== artifact.digest) reasons.push(`${probe.id}: expected artifact digest ${artifact.digest}, received ${digest}`);
      }
      outcomes.push(deepFreeze(outcome));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push(deepFreeze({ id: probe.id, url: url.href, error: message }));
      reasons.push(`${probe.id}: ${message}`);
    }
  }
  if (reasons.length) return refusal({ releaseDigest: release.digest, normalizedOrigin, outcomes: Object.freeze(outcomes), reasons: Object.freeze(reasons) });
  return deepFreeze({
    kind: 'public-release-observation', version: 1, releaseDigest: release.digest, independent: true,
    observer: observer.trim(), origin: normalizedOrigin, observedAt,
    probes: Object.freeze(outcomes.map(({ id, status, contentType, digest }) => deepFreeze({ id, status, ...(contentType === undefined ? {} : { contentType }), ...(digest === undefined ? {} : { digest }) }))),
  });
}

async function fetchWithinDeadline({ fetch, method, timeoutMs, url }) {
  const controller = new AbortController();
  let timedOut = false;
  let timeout;
  try {
    return await Promise.race([
      fetch(url, { method, redirect: 'follow', signal: controller.signal }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timedOut) throw new Error(`timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('origin must be an absolute HTTP(S) directory URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) {
    throw new TypeError('origin must be an absolute HTTP(S) directory URL without credentials, query, or fragment');
  }
  return url.href;
}
function normalizedMediaType(value) { return typeof value === 'string' && value.trim() ? value.split(';', 1)[0].trim().toLowerCase() : undefined; }
function isUtcInstant(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) && Number.isFinite(Date.parse(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; for (const item of Object.values(value)) deepFreeze(item); return Object.freeze(value); }
