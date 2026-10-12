#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { argument as value } from '@red-cup-engineering/javascript-node-services-section/argv';
import { verifyWebReleaseDirectory } from '../src/verify-web-release-directory.mjs';

const integer = (name) => value(name) === undefined ? undefined : Number(value(name));
const root = resolve(value('--root') ?? '.');
const manifestPath = resolve(value('--manifest') ?? `${root}/release-manifest.json`);

try {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const verification = await verifyWebReleaseDirectory({
    manifest,
    root,
    allowExcluded: !process.argv.includes('--deny-excluded'),
    ...(integer('--max-files') === undefined ? {} : { maxFiles: integer('--max-files') }),
    ...(integer('--max-bytes') === undefined ? {} : { maxBytes: integer('--max-bytes') }),
  });
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
  if (!verification.valid) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ kind: 'web-release-directory-verification', version: 1, valid: false, diagnostics: [{ severity: 'error', code: 'WRC-CLI-001', message: error instanceof Error ? error.message : String(error), subject: manifestPath }] }, null, 2)}\n`);
  process.exitCode = 1;
}
