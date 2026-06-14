# Deterministic Result Delivery

## Problem

Run 4 test: 240 subagent status polls in 241 turns. LLM tight-looped polling instead of receiving background notifications. triggerTurn notification never reached the LLM because it was never idle (always mid-turn, polling).

Two issues:
1. In `pi -p` mode, LLM runs one continuous turn — triggerTurn can't fire because LLM is never idle
2. Even in interactive mode, if the LLM decides to poll instead of ending its turn, notifications queue silently

## Design Goal

Result delivery must be deterministic — not dependent on prompt engineering ("please end your turn and wait") or polling loops. When a remote run completes, the orchestrator LLM must receive the result and get a chance to act on it.

## Proposed Architecture

### Option A: Blocking delegation (synchronous within a turn)

The `subagent()` tool call doesn't return until the remote run completes. The extension internally polls the HTTP endpoint and only returns the tool result when the run finishes (or times out).

```
LLM calls subagent({ agent: "researcher", task: "..." })
  → extension POSTs /invoke, gets runId
  → extension polls GET /status/:runId internally (not via LLM turns)
  → on completion, fetches GET /result/:runId
  → returns full result as tool output
LLM sees result in same turn, continues
```

Pros: Deterministic. No polling from LLM. Works in pi -p mode.
Cons: Tool call blocks for duration of remote work (could be minutes). LLM can't do other work while waiting. Parallel delegation still works (Promise.allSettled on multiple invokes).

### Option B: Async delegation + blocking status

Delegation returns immediately (current behavior). But `action: "status"` with an id BLOCKS until that run completes (long-poll). LLM calls status once, gets result when ready.

```
LLM calls subagent({ agent: "researcher", task: "..." }) → immediate return with runId
LLM calls subagent({ action: "status", id: "abc" }) → BLOCKS until complete → returns full result
```

Pros: LLM can delegate multiple tasks first, then block-wait on each. Explicit control.
Cons: Still requires LLM to call status (one call, not a loop). Timeout handling needed on the block.

### Option C: Hybrid — sync by default, async opt-in

Default: tool call blocks until result (Option A).
With `async: true`: returns immediately, relies on triggerTurn for interactive sessions, or explicit status call.

```typescript
// Blocks until researcher completes (default)
subagent({ agent: "researcher", task: "..." })

// Returns immediately, result delivered via notification
subagent({ agent: "researcher", task: "...", async: true })
```

## Recommendation

Option A (blocking) for v1. Simplest, most deterministic, works everywhere. Parallel delegation already handled — the extension can fire multiple /invoke calls and await all results before returning.

The blocking behavior should:
- Poll internally at configurable interval (default 3s)
- Stream progress updates to the LLM via onUpdate callback if available
- Timeout after configured limit
- Return full result (output, usage, model, durationMs) as tool content

## Test Cases

1. Single delegation blocks until result
2. Parallel delegation blocks until all results
3. Timeout produces error result (not infinite block)
4. Cancel still works during blocking wait
5. Progress updates stream to LLM during wait (if onUpdate supported)
6. async: true still returns immediately for cases where non-blocking is wanted
