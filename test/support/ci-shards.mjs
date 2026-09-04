import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { manifest } from './ci-shard-manifest.mjs';

export function verifyArtifacts(directory, platform, producerResult) {
  // The matrix result alone can hide a skipped/missing producer. Require both
  // success and one completed, matching receipt + native TAP per expected shard.
  assert.equal(producerResult, 'success', 'Producer matrix did not succeed');
  for (const [category, shards] of Object.entries(manifest())) {
    for (const [index, files] of shards.entries()) {
      const id = `${category}-${index + 1}`;
      const receipt = JSON.parse(readFileSync(resolve(directory, `${id}.json`), 'utf8'));
      assert.equal(receipt.platform, platform, `${id}: wrong platform`);
      assert.equal(receipt.category, category);
      assert.equal(receipt.shard, index + 1);
      assert.deepEqual(receipt.files, files, `${id}: mismatched file coverage`);
      assert.equal(receipt.exitCode, 0, `${id}: unsuccessful tests`);
      assert.equal(receipt.signal, null, `${id}: cancelled tests`);
      assert.ok(Number.isFinite(receipt.durationMs) && receipt.durationMs > 0);
      assert.ok(statSync(resolve(directory, `${id}.tap`)).size > 0, `${id}: missing outcomes`);
    }
  }
}

function main([mode, category, shardText, directory]) {
  if (mode === 'aggregate') {
    // aggregate <artifact directory> <platform> <producer result>
    verifyArtifacts(category, shardText, directory);
    console.log('All seven shard receipts and TAP artifacts match exact file coverage.');
    return;
  }
  const plan = manifest(); // Validate BOTH categories before running any shard.
  if (mode === 'validate') {
    assert.equal(category, undefined, 'validate takes no arguments');
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  assert.equal(mode, 'run', 'Usage: ci-shards.mjs validate | run <unit|integration> <shard> <output directory> | aggregate <directory> <platform> <producer result>');
  assert.ok(Object.hasOwn(plan, category), 'Unknown category');
  assert.match(shardText ?? '', /^[1-9]\d*$/, 'Invalid shard');
  const shard = Number(shardText);
  const files = plan[category][shard - 1];
  assert.ok(files, 'Unknown shard');
  assert.ok(directory, 'Output directory required');
  mkdirSync(directory, { recursive: true });
  const id = `${category}-${shard}`;
  const startedAt = new Date().toISOString();
  const start = performance.now();
  // CLI retains native default file-process isolation. Concurrency is ONLY file
  // processes, never the shared cases inside a suite. No shell/glob/name filter.
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--import',
    category === 'unit' ? './test/support/isolated-temp-root.mjs' : './test/support/register-loader.mjs',
    '--test', '--test-concurrency=2',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=tap', `--test-reporter-destination=${resolve(directory, `${id}.tap`)}`,
    ...files,
  ], { stdio: 'inherit' });
  writeFileSync(resolve(directory, `${id}.json`), JSON.stringify({
    platform: process.platform, node: process.version, category, shard, files,
    startedAt, completedAt: new Date().toISOString(), durationMs: performance.now() - start,
    exitCode: result.status, signal: result.signal, error: result.error?.message,
  }, null, 2));
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
