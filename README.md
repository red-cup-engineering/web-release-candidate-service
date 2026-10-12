# Web release candidate service

This package creates deterministic manifests from completed web artifact
inventories, verifies a manifest against candidate bytes, and compares two
release profiles without hiding changes.

Reusable release logic lives in `src/`. Filesystem materialization, provider
upload, promotion, and rollback belong in callers' scripts or provider
adapters. Public probing is a provider-neutral operation with an injected
fetch capability, so it can be used by an independent receiving checker.

```js
import {
  createWebReleaseManifest,
  verifyWebReleaseManifest,
  compareWebReleaseCandidates,
} from '@red-cup-engineering/web-release-candidate-service';

const manifest = createWebReleaseManifest({
  artifacts,
  baseUrl: 'https://example.test/',
  profile: 'production-candidate',
  excludePaths: ['report.json', 'release-manifest.json'],
});

const verification = verifyWebReleaseManifest({ manifest, artifacts });
const parity = compareWebReleaseCandidates({ baseline, candidate: manifest });
```

After materialization, verify the directory without following symlinks:

```js
import { verifyWebReleaseDirectory } from '@red-cup-engineering/web-release-candidate-service';

const verification = await verifyWebReleaseDirectory({
  manifest,
  root: '.static/site',
  maxFiles: 50_000,
  maxBytes: 512 * 1024 * 1024,
});
```

Expected artifacts must match their declared byte counts and ni SHA-256
digests. Missing, changed, and unexpected files are diagnostics. Symbolic links
and other special filesystem entries are refused and never followed. Manifest
exclusions (normally `report.json` and `release-manifest.json`) may be present
without being content-bound; pass `allowExcluded: false` to require a directory
containing only manifested files. Excluded files still count toward the file
and byte bounds.

The packaged CLI is a thin adapter over the same function:

```sh
verify-web-release-directory --root .static/site \
  --manifest .static/site/release-manifest.json \
  --max-files 50000 --max-bytes 536870912
```

Parity classifies changed, added, and removed paths as unexpected unless the
caller supplies `classifyDelta(delta)` and returns a non-empty disposition.
That callback is where site-specific indexing, advertising, privacy, or other
deliberate profile differences belong.

## Public release admission

`PublicRelease` is the provider-neutral relation used before a public cutover.
It joins one source revision and declared build command, a verified release
manifest, the public channel contract, the target provider configuration and
bindings, and the provider version/route snapshot expected before deployment.
It is pure data: builds, credential use, uploads, DNS changes, and HTTP
observations remain caller-owned effects.

```js
import {
  createPublicRelease,
  decidePublicRelease,
} from '@red-cup-engineering/web-release-candidate-service';

const release = createPublicRelease({
  source: {
    repository: '561-group/example-site', revision: 'git-sha-or-content-id',
    build: { command: ['npm', 'run', 'build'], outputRoot: 'dist' },
  },
  artifact: { manifest },
  channel: {
    canonicalOrigin: 'https://example.561.group/',
    stateClass: 'static', // static | edge-static | durable
    probes: [{
      id: 'home', method: 'GET', path: '/', expectedStatus: 200,
      artifactPath: 'index.html', contentType: 'text/html',
    }],
  },
  target: {
    provider: 'cloudflare', receiver: 'worker:example-561-group',
    configDigest, bindingDigest,
  },
  snapshot: { providerVersion: 'current-version-id', routeDigest },
});

const decision = decidePublicRelease({ release });
// { disposition: 'candidate', ... }
```

The release digest identifies this complete declaration. A provider receipt
must repeat that digest plus the manifest, config, binding, provider-version,
and route identities, including the declared baseline provider-version and
route snapshot. An independent observation names its observer and UTC
time and supplies one outcome per declared probe. An artifact-backed probe also
supplies the observed artifact digest.

`decidePublicRelease` is intentionally a small state machine:

- `candidate`: deploy the declared candidate, then record a candidate receipt
  and independently observe every probe at its candidate origin.
- `cutover`: candidate receipt and candidate observation agree; authorization
  is now required to attach the canonical receiver. The caller must preserve
  the recorded prior version for rollback and obtain a new canonical probe.
- `no-op`: an active receipt and independent canonical observation already
  satisfy the exact release. A retry performs no provider effect.
- `refusal`: supplied release, receipt, or observation evidence disagrees with
  the declared relation. Its `requirements` identify the failed field.

For durable channels, the same relation makes state classification explicit;
the provider adapter must additionally require its state backup/replay and
protocol-specific acceptance evidence before emitting a receipt. This package
does not claim that static file conformance proves a durable receiver.

## Public receiver observation

`observePublicRelease` is the effect boundary for public receiver checks. It
validates the immutable release before calling its injected `fetch`, then calls
each declared probe in its canonical id order. It records the status, normalized
media type, and (for artifact-backed `GET` probes) SHA-256 ni digest. A failed
probe returns a refusal with the completed per-probe evidence; it never uploads,
promotes, rolls back, or otherwise mutates a provider.

```js
import { observePublicRelease } from '@red-cup-engineering/web-release-candidate-service';

const observation = await observePublicRelease({
  release,
  origin: 'https://weiqi.561.group/', // omit for the declared canonical origin
  observer: 'independent-release-qa',
  observedAt: new Date().toISOString(), // caller owns nondeterministic time
  fetch: globalThis.fetch, // caller supplies the network capability
});
```

Pass a successful observation as `receiverObservation` (or
`candidateObservation`) to `decidePublicRelease`. The CLI is the same thin
adapter, reading a release declaration and using the process fetch capability:

```sh
observe-public-release --release public-release.json \
  --observer independent-release-qa --origin https://weiqi.561.group/
```
