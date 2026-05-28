# Issue: Whole-invocation fork promotion ignores per-agent `defaultContext: fresh`

## Summary

When `context` is omitted on a `subagent(...)` call, pi-subagents currently promotes the **entire** invocation to `fork` if **any** requested agent has `defaultContext: "fork"`.

That causes read-only agents configured with `defaultContext: fresh` (for example `scout`, `reviewer`) to inherit the full parent transcript when batched with `worker` or `oracle` in parallel or chain mode.

## Reproduction

1. Configure `scout` with `defaultContext: fresh`.
2. Configure `worker` with `defaultContext: fork`.
3. Run parallel subagent call without explicit `context`:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find relevant files" },
    { "agent": "worker", "task": "Implement fix" }
  ]
}
```

4. Observe both tasks run with forked/inherited parent context.

Root cause: `applyAgentDefaultContext()` in `src/runs/foreground/subagent-executor.ts`.

## Expected behavior

When caller omits top-level `context`:

- Each agent/task/step should use **its own** `defaultContext`.
- Explicit `context: "fresh"` or `context: "fork"` should override all agents in that call.
- Parallel scout + worker should fork only the worker task, not the scout.

## Proposed fix

- Remove whole-invocation fork promotion.
- Resolve context per flat task index via agent `defaultContext`.
- Fork session files and `wrapForkTask()` only for indices whose resolved context is `fork`.
- Update tool docs/schema descriptions accordingly.

## Impact

Users relying on implicit whole-invocation fork when mixing fork-default and fresh-default agents in one call would need to pass explicit `context: "fork"` for that behavior.
