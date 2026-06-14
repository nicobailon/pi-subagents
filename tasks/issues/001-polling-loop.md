# Issue #001: LLM polls 240 times instead of receiving results via notification

## Observed

M0.1 test run 4: 241 turns, 240 subagent tool calls. Nearly every turn was `subagent({ action: "status" })` in a tight loop. LLM never received a background completion notification.

## Root Cause

Two compounding problems:

1. **triggerTurn can't fire during an active turn.** The LLM never goes idle — it delegates, then immediately starts polling in a loop within the same turn. `pi.sendMessage({ triggerTurn: true })` only wakes an idle LLM. Since the LLM is always mid-turn (polling), the notification queues silently.

2. **`pi -p` mode has no idle state.** Single-prompt mode runs one continuous interaction. The LLM can't "end turn and wait" — there's no session to return to. triggerTurn is architecturally incompatible with `pi -p`.

3. **Prompt engineering is not a fix.** Telling the LLM "end your turn and wait for notification" is unreliable. Different models behave differently. The tool API must be deterministic.

## Impact

- 240 wasted tool calls (tokens, latency, cost)
- 241 turns for a 4-task workflow that should take ~8 turns
- LLM burns context window on repeated status responses
- Unreliable — depends on model following instructions to stop polling

## Fix: Blocking delegation by default

The `subagent()` tool call should block internally until the remote run completes. The extension polls HTTP status inside the execute() function and only returns when the result is ready (or timeout).

```
Current: delegate → return immediately → LLM polls 240 times → gets result
Fixed:   delegate → block internally → return result → LLM continues (1 call)
```

### Changes needed

1. **extension/index.ts**: Single delegation path — after invoke(), poll /status internally, fetch /result on completion, return full output as tool content
2. **extension/index.ts**: Parallel delegation path — fire all invokes, Promise.allSettled on internal polling, return combined results
3. **extension/schemas.ts**: Add `async: true` opt-in field for cases that need fire-and-forget
4. **transport/job-tracker.ts**: Keep for async opt-in path, remove from default path
5. **skills/SKILL.md**: Remove "poll for results" instructions, document blocking behavior

### Test coverage

7 failing tests in `test/unit/blocking-delegation.test.ts`:
- Single delegation blocks until result
- Timeout returns error (not infinite block)
- Zero LLM-side polling needed
- Parallel blocks until all complete
- Partial failure returns mixed results
- async: true opt-in returns immediately
- Progress updates stream via onUpdate during block

## Priority

P0 — This is the primary UX issue with the extension. Every workflow wastes 95%+ of its turns on polling.
