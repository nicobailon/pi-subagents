import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

export const shardCounts = { unit: 3, integration: 4 };
// Windows baseline case-time sums, not file wall-time guarantees. Keep the
// heavyweight placements from candidate-matrix.json; allocate the small tail
// deterministically. Re-measure on BOTH platforms before claiming a speedup.
const heavy = {
  unit: [
    [['index-child-registration', 96.095], ['mutation-evidence', 8.353], ['agent-management', 6.939], ['workflow-chat-progress', 5.120], ['nested-events', 4.743], ['nested-control', 4.543], ['inspect-rpc', 3.439], ['external-cli-runner', 2.636], ['watchdog-diff-tool', 2.206]],
    [['scripted-workflow', 30.529], ['tool-description', 21.201], ['worktree-cleanup-plan', 16.256], ['watchdog-change-signature', 13.660], ['watchdog-runtime', 12.537], ['mission-store', 8.520], ['project-panes-public-api', 8.010], ['scheduled-runs', 6.788], ['claude-code-adapter', 4.715], ['workflow-resume-hint', 4.095], ['skills-fallback', 2.799], ['mission-goal-driver', 2.648], ['agent-overrides', 2.209], ['mission-lifecycle', 2.136]],
    [['worktree', 26.902], ['package-manifest', 23.917], ['async-retention', 20.804], ['acceptance', 13.028], ['agent-frontmatter', 11.854], ['chain-append', 8.059], ['compaction-resume', 6.906], ['herdr-inspector-bootstrap', 4.979], ['run-fanout-budget', 4.754], ['cursor-agent-adapter', 4.626], ['codex-exec-adapter', 3.089], ['agent-eject-disable', 2.777], ['preflight', 2.348]],
  ],
  integration: [
    [['async-execution.part-3', 73.840], ['acceptance-file-report', 17.653], ['external-cli-runner', 8.012], ['result-watcher', 7.605], ['fork-context-execution', 5.031], ['async-job-tracker', 4.076]],
    [['async-execution.part-1', 72.862], ['intercom-result-delivery', 42.582], ['error-handling', 3.365]],
    [['single-execution.part-1', 72.196], ['async-execution.part-4', 69.869]],
    [['single-execution.part-2', 71.818], ['async-execution.part-2', 71.374]],
  ],
};

export function discover(category) {
  assert.ok(Object.hasOwn(shardCounts, category), `Unknown category: ${category}`);
  return readdirSync(`test/${category}`, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map(entry => `test/${category}/${entry.name}`).sort();
}

export function validateAssignments(files, shards, count) {
  assert.equal(shards.length, count, 'Wrong shard count');
  assert.ok(shards.every(shard => shard.length > 0), 'Empty shard');
  const assigned = shards.flat();
  assert.equal(new Set(files).size, files.length, 'Duplicate discovery');
  assert.equal(new Set(assigned).size, assigned.length, 'Duplicate assignment');
  assert.deepEqual(assigned.sort(), [...files].sort(), 'Missing or unknown file');
}

function assignments(category) {
  const files = discover(category);
  const shards = heavy[category].map(group => group.map(([name]) => `test/${category}/${name}.test.ts`));
  const weights = heavy[category].map(group => group.reduce((sum, [, seconds]) => sum + seconds, 0));
  const pinned = new Set(shards.flat());
  for (const file of files.filter(file => !pinned.has(file))) {
    const index = weights.indexOf(Math.min(...weights));
    shards[index].push(file);
    weights[index] += 0.5; // Small-tail estimate only; newly discovered files cannot disappear.
  }
  validateAssignments(files, shards, shardCounts[category]);
  return shards;
}

export function manifest() {
  return Object.fromEntries(Object.keys(shardCounts).map(category => [category, assignments(category)]));
}
