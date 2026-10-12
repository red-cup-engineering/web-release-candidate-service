import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createWebReleaseManifest, serializeWebReleaseManifest, verifyWebReleaseDirectory } from '../src/web-release-candidate.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'web-release-directory-'));
  await mkdir(join(root, 'notes'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<h1>Home</h1>\n');
  await writeFile(join(root, 'notes', 'index.html'), '<h1>Notes</h1>\n');
  const artifacts = new Map([
    ['index.html', '<h1>Home</h1>\n'],
    ['notes/index.html', '<h1>Notes</h1>\n'],
  ]);
  const manifest = createWebReleaseManifest({
    artifacts,
    baseUrl: 'https://example.test/',
    excludePaths: ['release-manifest.json', 'report.json'],
  });
  await writeFile(join(root, 'release-manifest.json'), serializeWebReleaseManifest(manifest));
  await writeFile(join(root, 'report.json'), '{}\n');
  return { root, manifest };
}

test('a materialized directory verifies expected files and permits declared exclusions', async (t) => {
  const found = await fixture();
  t.after(() => rm(found.root, { recursive: true, force: true }));
  const result = await verifyWebReleaseDirectory({ manifest: found.manifest, root: found.root });
  assert.equal(result.valid, true);
  assert.equal(result.expectedFileCount, 2);
  assert.equal(result.verifiedFileCount, 2);
  assert.equal(result.excludedFileCount, 2);
  assert.equal(result.fileCount, 4);

  const closed = await verifyWebReleaseDirectory({ manifest: found.manifest, root: found.root, allowExcluded: false });
  assert.equal(closed.valid, false);
  assert.deepEqual(closed.diagnostics.filter(({ code }) => code === 'WRC-D010').map(({ subject }) => subject), ['release-manifest.json', 'report.json']);
});

test('missing, changed, and unexpected files are separate diagnostics', async (t) => {
  const found = await fixture();
  t.after(() => rm(found.root, { recursive: true, force: true }));
  await writeFile(join(found.root, 'index.html'), 'changed');
  await rm(join(found.root, 'notes', 'index.html'));
  await writeFile(join(found.root, 'extra.txt'), 'extra');
  const result = await verifyWebReleaseDirectory({ manifest: found.manifest, root: found.root });
  assert.equal(result.valid, false);
  assert.deepEqual(new Set(result.diagnostics.map(({ code }) => code)), new Set(['WRC-D008', 'WRC-D009', 'WRC-D010']));
});

test('symbolic links are refused without following their targets', async (t) => {
  const found = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'web-release-outside-'));
  t.after(() => Promise.all([rm(found.root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(join(outside, 'secret.txt'), join(found.root, 'linked.txt'));
  const result = await verifyWebReleaseDirectory({ manifest: found.manifest, root: found.root });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some(({ code, subject }) => code === 'WRC-D003' && subject === 'linked.txt'));
  assert.equal(result.byteCount, Buffer.byteLength('<h1>Home</h1>\n<h1>Notes</h1>\n{}\n' + serializeWebReleaseManifest(found.manifest)), 'link target bytes are not counted');
});

test('file and byte bounds fail closed and unsafe manifest paths never reach the filesystem', async (t) => {
  const found = await fixture();
  t.after(() => rm(found.root, { recursive: true, force: true }));
  const byFiles = await verifyWebReleaseDirectory({ manifest: found.manifest, root: found.root, maxFiles: 1 });
  assert.ok(byFiles.diagnostics.some(({ code }) => code === 'WRC-D005'));
  const byBytes = await verifyWebReleaseDirectory({ manifest: found.manifest, root: found.root, maxBytes: 1 });
  assert.ok(byBytes.diagnostics.some(({ code }) => code === 'WRC-D006'));
  const unsafe = { ...found.manifest, artifacts: [{ ...found.manifest.artifacts[0], path: '../escape' }, ...found.manifest.artifacts.slice(1)] };
  const rejected = await verifyWebReleaseDirectory({ manifest: unsafe, root: found.root });
  assert.ok(rejected.diagnostics.some(({ code }) => code === 'WRC-D011'));
});

test('the CLI delegates verification, prints JSON, and selects its exit status', async (t) => {
  const found = await fixture();
  t.after(() => rm(found.root, { recursive: true, force: true }));
  const cli = join(import.meta.dirname, '..', 'scripts', 'verify-web-release-directory.mjs');
  const pass = spawnSync(process.execPath, [cli, '--root', found.root], { encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).valid, true);
  await writeFile(join(found.root, 'index.html'), 'changed');
  const fail = spawnSync(process.execPath, [cli, '--root', found.root], { encoding: 'utf8' });
  assert.equal(fail.status, 1);
  assert.equal(JSON.parse(fail.stdout).valid, false);
});
