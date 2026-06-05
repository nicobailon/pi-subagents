# Subagent Read-Only Watch Overlay Design

Date: 2026-06-05
Branch: `feat/subagent-readonly-overlay`

## Goal

Add a read-only UI for observing subagents launched by the current Pi session through `pi-subagents` async/background runs. The feature should make it easy to discover and inspect a specific agent instance, including nested agents, without switching the current Pi session or opening a child session as writable.

## Non-goals

- Do not scan unrelated Pi sessions or system-wide subagent runs.
- Do not switch the parent Pi session to a child JSONL file.
- Do not mutate child session JSONL files.
- Do not implement special write/control actions from the watch overlay.
- Do not build a full replacement for Pi's session browser.

## User-facing UX

Add a command:

```text
/subagent-watch [target]
```

With no arguments, it opens a current-session-only tree selector of watchable agent instances. With an optional target, it may jump directly to a matching run/agent target when resolvable; this is an escape hatch, not the primary UX.

The selector groups entries into sections:

1. **Active** — runs with at least one currently running agent
2. **Queued** — queued or pending runs/agents that have not started
3. **Done** — fully terminal runs still known to the current session extension state, including complete, failed, and paused runs

The selector is a tree, not a flat run list. It should show root async runs and direct or nested agent instances underneath them, preserving ancestry. If an active run contains already-completed child agents, keep those completed children under that active run so the tree remains understandable. Fully terminal runs belong in the Done section.

Example:

```text
Subagent Watch · current session only

Active
▾ abc123  parallel-review  running · 2/3 active · 4m12s
  ├─ ● reviewer  correctness review      running · read · 48s
  ├─ ● reviewer  tests review            running · bash · 1m20s
  └─ ✓ reviewer  simplicity review       complete · 2m03s

▾ def456  worker-chain  running · step 2/3 · 7m41s
  ├─ ✓ scout    map auth flow            complete
  ├─ ● worker   implement fix            running · edit · 3m10s
  │  └─ ● reviewer nested sanity check   running · grep · 22s
  └─ ○ reviewer final review             pending

Queued
▾ fed111  validation-chain  queued
  └─ ○ reviewer final review             pending

Done
▾ ghi789  scout-plan  complete · 1m08s
  ├─ ✓ scout    map auth flow            complete
  └─ ✓ planner  create plan              complete
```

Users select a specific agent instance, not a run. Selector keys:

```text
↑ / ↓        move selection
Enter        open selected agent
Esc / q      close
```

Opening an agent shows a read-only overlay with tabs:

```text
Transcript | Status | Log
```

The overlay starts on **Transcript**. Header includes ancestry, run ID context, agent name/label, status, current tool, and session/log paths when available.

Overlay keys:

```text
Tab / Shift+Tab        switch tabs
Backspace / b          return to tree selector
Esc / q                close watch UI entirely
PgUp / PgDn            page scroll
Shift+↑ / Shift+↓      line scroll
```

Plain arrow keys are not used in the overlay scroll view, matching `pi-bulletin-board` behavior.

## Tailing and scrolling behavior

Transcript and log views tail live while the user is at the bottom.

Use the same mental model as `pi-bulletin-board`:

- `scrollOffset = 0` means pinned to latest content.
- `PgUp` increases offset by one page amount.
- `PgDn` decreases offset by one page amount.
- `Shift+↑` increases offset by one line.
- `Shift+↓` decreases offset by one line.
- If new content arrives while `scrollOffset === 0`, keep showing the bottom.
- If the user has scrolled up, preserve the user's position and do not auto-jump.

The overlay should watch or poll the relevant files and request re-render automatically. The user should not need to manually refresh for normal tailing.

## Current-session scope

The watch tree is scoped to the current parent Pi session only. It should not scan all global async directories or show subagents from other terminals, projects, or prior parent sessions.

Primary sources:

- `SubagentState.asyncJobs` for async/background jobs known to this extension instance
- each job's async directory and `status.json`
- `AsyncStatus.steps` for direct agent instances
- nested run registry/projection already used by `subagent({ action: "status" })`
- per-step metadata such as `agent`, `phase`, `label`, `status`, `sessionFile`, `currentTool`, `lastActivityAt`, `startedAt`, `endedAt`, `tokens`, `toolCount`, and `error`
- derived artifact paths such as `output-<stepIndex>.log`, `subagent-log-<runId>.md`, and `events.jsonl`

## Watch target model

The UI should derive watchable agent instances into a stable internal target shape, for example:

```ts
type WatchTarget = {
  id: string;              // display path, e.g. abc123/2 or abc123/1/nested456
  rootRunId: string;
  agent: string;
  status: string;
  label?: string;
  phase?: string;
  taskPreview?: string;
  sessionFile?: string;
  outputLog?: string;
  asyncDir?: string;
  eventsFile?: string;
  ancestry: string[];
};
```

Display naming should use existing metadata only for the first version:

1. `label` when present
2. `phase + agent` when present
3. compact task preview when available
4. fallback to `agent`

Run ID/path context should be visible in selector rows, but users should not need to know the run ID to navigate.

## Transcript rendering

Transcript reads the selected agent's child Pi session JSONL read-only.

Requirements:

- Parse only complete newline-terminated JSONL records.
- Ignore incomplete trailing lines while the child process is appending.
- Surface malformed complete lines as warnings without crashing the overlay.
- Reuse Pi's exported message components and styling instead of defining new transcript styles.

Components to reuse where possible:

- `UserMessageComponent`
- `AssistantMessageComponent`
- `ToolExecutionComponent`
- `CustomMessageComponent`
- `BranchSummaryMessageComponent`
- `CompactionSummaryMessageComponent`
- `BashExecutionComponent`

The transcript adapter still needs to assemble session entries into renderable components and pair assistant tool calls with subsequent tool results. If a tool definition or renderer is unavailable in the parent session, fall back to a generic tool call/result rendering rather than failing.

If `sessionFile` is missing or unreadable, the Transcript tab should clearly say that the transcript is unavailable and point users to the Status and Log tabs.

## Status tab

The Status tab shows operational information for the selected agent and its ancestry.

It should include:

- selected agent name, label, phase, and status
- current tool and activity freshness when available
- tool count, token usage, duration, start/end time when available
- root run ID and async directory
- session JSONL path
- log path
- events path
- parent path / ancestry tree
- error or paused information when present

The Status tab should be useful even when transcript rendering is unavailable.

## Log tab

The Log tab shows the selected agent's raw output/log stream where available.

Primary source for a direct async step is:

```text
<asyncDir>/output-<stepIndex>.log
```

It may also reference root-level logs such as:

```text
<asyncDir>/subagent-log-<runId>.md
<asyncDir>/events.jsonl
```

For v1, Log can display the most relevant text log for the selected target and clearly state when no log file is available. Like Transcript, it should tail while at bottom.

## Implementation layout

Create a focused `src/watch/` area:

```text
src/watch/
  watch-types.ts
  watch-tree.ts
  transcript-reader.ts
  transcript-renderer.ts
  watch-overlay.ts
  watch-selector.ts
  slash-command.ts
```

Responsibilities:

- `watch-tree.ts`
  - Build the current-session watch tree from `SubagentState` and status metadata.
  - Include nested agents where known.
  - Group targets into Active, Queued, and Done.
  - Produce tree rows and selectable `WatchTarget`s.

- `transcript-reader.ts`
  - Read session JSONL read-only.
  - Parse complete lines only.
  - Ignore partial tails.
  - Return parsed entries plus warnings.

- `transcript-renderer.ts`
  - Adapt parsed session entries to Pi message components.
  - Pair tool calls and tool results as far as practical.
  - Use generic fallback rendering for unsupported cases.

- `watch-selector.ts`
  - Render the current-session tree selector.
  - Handle selector input.
  - Open `watch-overlay` for the selected agent.

- `watch-overlay.ts`
  - Render Transcript, Status, and Log tabs.
  - Implement bulletin-board-style scrolling and tailing.
  - Watch or poll transcript/log/status files and request re-render.
  - Support back-to-selector and close shortcuts.

- `slash-command.ts`
  - Register `/subagent-watch [target]`.
  - Resolve optional direct targets.

Integration:

- `src/extension/index.ts` calls `registerSubagentWatchCommand(pi, state)`.
- The feature uses existing state, status, nested projection, and artifact paths.
- It must never call session switching APIs for child sessions.

## Error handling and fallbacks

- Missing session file: show a clear Transcript unavailable message.
- Missing log file: show a clear Log unavailable message.
- Malformed complete JSONL line: show a warning and continue rendering other entries.
- Partial trailing JSONL line: ignore silently until completed.
- Unavailable Pi tool renderer: use generic fallback text.
- Incomplete nested metadata: show known parts of the tree rather than failing.
- File watcher failures: fall back to periodic polling so tailing still works without manual refresh.

## Testing strategy

Unit tests:

1. **Watch tree building**
   - Converts async job state/status steps into selector tree sections.
   - Groups Active, Queued, and Done correctly.
   - Includes completed children under active runs.
   - Includes nested children with correct ancestry when metadata is present.
   - Stays scoped to current session state.

2. **Display labels**
   - Prefers label.
   - Falls back to phase/agent, task preview, then agent.
   - Includes run ID/path context in selector output.

3. **Transcript parsing**
   - Parses newline-delimited session JSONL.
   - Ignores incomplete trailing line.
   - Handles malformed complete lines with warnings.
   - Extracts supported entry types for rendering.

4. **Tailing and scroll math**
   - `scrollOffset = 0` means bottom.
   - Page and line scrolling match bulletin-board behavior.
   - New content stays pinned only when at bottom.

5. **Overlay state**
   - Tab and Shift+Tab cycle Transcript, Status, and Log.
   - Backspace and `b` return to selector.
   - Esc and `q` close.

Integration/component tests where feasible:

1. `/subagent-watch` command registration.
2. Selector flow with fake async job state: move selection with arrows, Enter opens overlay, Backspace returns, Esc closes.
3. Live transcript refresh: append complete JSONL records and verify rendered content updates without manual refresh; append partial JSONL and verify no crash/no partial render.
4. Status/log tabs: fake status/log files, switch tabs with Tab, and verify expected text appears.

Full terminal-level tests may be replaced with component-level render/input tests if the existing harness cannot drive overlays end-to-end.

## Risks

- Reusing Pi message components may require adapting tool definitions and TUI context carefully.
- Nested run discovery depends on metadata retained by the current extension state.
- Live file watching must handle partial writes and platform-specific watcher behavior.
- Rendering very large transcripts may need truncation/windowing to keep the TUI responsive.

## Acceptance criteria

- `/subagent-watch` opens a current-session-only tree selector for async/background agent instances.
- The selector shows Active, Queued, and Done sections and includes run ID/path context.
- Selecting an agent opens a read-only overlay with Transcript, Status, and Log tabs.
- Transcript uses Pi message styling/components and tails the selected session file.
- Status/log tabs provide useful observability even when transcript is unavailable.
- Backspace/`b` returns to the selector; Esc/`q` closes; Tab/Shift+Tab switches tabs.
- Overlay scrolling matches bulletin-board behavior.
- Unit tests cover tree building, transcript parsing, tailing/scrolling, and overlay state.
