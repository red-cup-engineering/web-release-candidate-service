#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { argument as value } from '@red-cup-engineering/javascript-node-services-section/argv';
import { observePublicRelease } from '../src/observe-public-release.mjs';

const releasePath = resolve(value('--release') ?? 'public-release.json');
try {
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  const result = await observePublicRelease({
    release,
    ...(value('--origin') === undefined ? {} : { origin: value('--origin') }),
    observer: value('--observer') ?? 'observe-public-release-cli',
    observedAt: value('--observed-at') ?? new Date().toISOString(),
    ...(value('--timeout-ms') === undefined ? {} : { timeoutMs: Number(value('--timeout-ms')) }),
    fetch: globalThis.fetch,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.kind === 'public-release-observation-refusal') process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ kind: 'public-release-observation-refusal', version: 1, releaseDigest: null, origin: null, observer: value('--observer') ?? 'observe-public-release-cli', observedAt: null, probes: [], reasons: [error instanceof Error ? error.message : String(error)] }, null, 2)}\n`);
  process.exitCode = 1;
}
