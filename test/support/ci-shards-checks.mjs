import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discover, manifest, shardCounts, validateAssignments } from './ci-shard-manifest.mjs';
import { verifyArtifacts } from './ci-shards.mjs';

test('deterministic shards cover both current discovery globs exactly once', () => {
  const plan = manifest();
  assert.deepEqual(plan, manifest());
  for (const category of Object.keys(shardCounts)) {
    validateAssignments(discover(category), plan[category], shardCounts[category]);
  }
  assert.throws(() => discover('unknown'));
});

test('coverage rejects duplicate, missing, unknown files and empty/wrong-count shards', () => {
  for (const shards of [[['a'], ['a', 'b']], [['a'], ['c']], [['a'], []], [['a']], [['a'], ['b', 'c']]]) {
    assert.throws(() => validateAssignments(['a', 'b'], shards, 2));
  }
  assert.throws(() => validateAssignments(['a', 'a'], [['a'], ['b']], 2));
  validateAssignments(['a', 'b'], [['a'], ['b']], 2);
});

test('aggregate fails closed on unsuccessful producers or incomplete/mismatched artifacts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-shard-checks-'));
  try {
    for (const [category, shards] of Object.entries(manifest())) {
      shards.forEach((files, index) => {
        const id = `${category}-${index + 1}`;
        writeFileSync(join(directory, `${id}.json`), JSON.stringify({
          category, shard: index + 1, files, platform: process.platform,
          exitCode: 0, signal: null, durationMs: 1,
        }));
        writeFileSync(join(directory, `${id}.tap`), 'TAP version 13\n');
      });
    }
    const check = () => verifyArtifacts(directory, process.platform, 'success');
    check();
    for (const result of ['failure', 'cancelled', 'skipped', undefined, '']) {
      assert.throws(() => verifyArtifacts(directory, process.platform, result));
    }
    const receiptPath = join(directory, 'unit-1.json');
    const original = readFileSync(receiptPath, 'utf8');
    for (const patch of [
      { exitCode: 1 }, { exitCode: null }, { signal: 'SIGTERM' },
      { platform: 'wrong' }, { files: [] }, { category: 'integration' },
      { shard: 2 }, { durationMs: 0 },
    ]) {
      writeFileSync(receiptPath, JSON.stringify({ ...JSON.parse(original), ...patch }));
      assert.throws(check);
    }
    writeFileSync(receiptPath, original);
    writeFileSync(join(directory, 'unit-1.tap'), '');
    assert.throws(check);
    unlinkSync(join(directory, 'unit-1.tap'));
    assert.throws(check);
    writeFileSync(join(directory, 'unit-1.tap'), 'TAP version 13\n');
    unlinkSync(receiptPath);
    assert.throws(check);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
