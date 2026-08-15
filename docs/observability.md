# Observability

Where running subagents show up, how to inspect them, and the files and events they leave behind.

## Foreground runs

Foreground runs stream progress in the conversation while they run. They default to a generous 30-minute wall-clock timeout when neither the call nor the selected agent provides a timeout; a global [`timeoutMs`](configuration.md#timeoutms) config replaces that default, and explicit `timeoutMs`/`maxRuntimeMs` and agent defaults win.

Live progress shows compact detail for single, chain, and parallel modes: current tool, recent output, token counts, aggregate cost, duration, activity freshness, current-tool duration, and chain graph metadata when available.

Press Pi's configured expand key (`Ctrl+O` by default) to expand the full streaming view with complete output per step.

Sequential chains show a flow line like `done scout → running worker`. Chains with parallel steps show per-step cards instead. Chain status uses `label` and `phase` metadata when present, while falling back to agent names for older chains.

## Background runs

Background runs keep working after control returns to you. Inspect them with:

```ts
subagent({ action: "status" })                 // all active runs
subagent({ action: "status", id: "..." })      // one run
```

Or ask naturally: "Show me the current async runs."

The under-editor async widget gives a short view while work runs. Its expand key follows your Pi keybinding:

```text
async subagent worker · background
● worker
  ● Step 1/1: worker · running
    ⎿  read: src/auth.ts | 2.0s
    Press configured-expand-key for live detail
```

To inspect one background child in text, use `subagent({ action: "status", id: "...", view: "transcript" })`; add `index` for a specific child in a parallel or chain run.

## FleetView

In the TUI, a persistent FleetView below the editor keeps active work visible as a compact summary. Set `fleetViewPlacement` to `"aboveEditor"` to move it above the editor.

```text
2 active agents · ↓ 4.2k tokens · ↓/← to inspect
```

After you expand it:

```text
↑↓/jk select · enter inspect · esc back

> main
    scout · running                  1m 12s · ↓ 2.8k tokens
    reviewer · running                 38s · ↓ 1.4k tokens
```

When the focused editor is empty, press `↓` or `←` to expand the summary into `main` plus active children with agent name, state, elapsed time, and token totals. Then use `↑`/`↓` or `j`/`k` to select a child and `Enter` to inspect it. Printable navigation keys are never intercepted before activation.

FleetView replaces the legacy above-editor async widget by default. Successful background completions stay quiet so inactive Pi tabs are not marked unread, while failed or paused completions still notify the originating session. Parallel runs show every active child independently. Chains with parallel groups keep their grouped shape in progress and results, so failed or paused agents stay visible next to completed ones. When a child is explicitly allowed to fan out with `tools: subagent`, its nested runs appear under that parent child in the main status tree instead of being hidden inside the child process.

## The fleet inspector

`/subagents-fleet` opens the live fleet inspector with current-session foreground work, recent async children, structured Markdown/tool transcripts, and completed output/session paths.

Default keys:

- `↑`/`↓` or `j`/`k` — select a child
- `Shift+K`/`Shift+J` — scroll one line
- `PgUp`/`PgDn` — scroll one page
- `x`/`Ctrl+O` — toggle tool details
- `r` — refresh
- `Esc` — close
- `s` — compose an acknowledged message to a selected live async child; Tab cycles `steer`, `follow_up`, and `auto`
- `D` — stop a selected child's top-level async run after confirmation
- `H` — open the selected active async child in a Herdr inspector pane (Herdr 0.7.5+)

Set `fleetKeybindings` in the extension config to replace inspector-level keys when a terminal intercepts keys such as `PgUp`, `PgDn`, `Home`, or `End`. Prompt modes keep fixed keys such as `Esc`, `Enter`, `Tab`, and stop-confirmation `Y`/`N`.

`Ctrl+Alt+F` opens the same inspector even while a foreground turn is active and slash input is queued.

Without a TUI, `/subagents-fleet` retains the textual `subagent({ action: "status", view: "fleet" })` fallback, and mutations use explicit commands: run `/subagents-stop` and pick from the selector, or use `/subagents-stop <run-id>` / `subagent({ action: "stop", id: "..." })` when you already know the id.

Use `/subagents-detach [run-id]` only for an active foreground single-subagent run you want to leave running without terminating; the eventual result remains available through status/wait.

Set `foregroundDetachShortcut` in `~/.pi/agent/extensions/subagent/config.json` to bind the same action to a shortcut. The running foreground card shows the configured shortcut beside its live-detail hint:

```json
{
  "foregroundDetachShortcut": "ctrl+b"
}
```

Pi binds `Ctrl+B` to editor cursor-left by default. The extension shortcut takes precedence, but Pi reports the conflict at startup. To reserve the key without that warning, override the editor action in `~/.pi/agent/keybindings.json`:

```json
{
  "tui.editor.cursorLeft": "left"
}
```

If something feels misconfigured, run `/subagents-doctor` or ask: "Check whether subagents and intercom are set up correctly."

## Async run artifacts

Async runs write machine-readable lifecycle artifacts for observability and workflow gates:

```text
<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>/
  status.json
  events.jsonl
  output-<n>.log
  subagent-log-<id>.md
```

- `status.json` powers the widget and `subagent({ action: "status" })` output.
- `events.jsonl` contains wrapper events plus child Pi JSON events annotated with run and step metadata, including correlated `subagent.steer.requested`, `scheduled`, `routed`, `queued`, `delivered`, `failed`, and `recovered` events plus failure/partial/recovery notices.
- `output-<n>.log` is a live human-readable tail.
- Fallback information is persisted so background runs are debuggable after completion.

For a top-level async run, `details.asyncDir` points at that directory; the final summary is written to Pi's subagent results directory as `<runId>.json`. Nested async runs use the same shape under the nested async root and are discoverable through status projections that read the nested-run registry. These files are append/update artifacts only; interactive foreground behavior is unchanged.

The result file is consumed and deleted once its completion notice is delivered. Before deletion, the watcher writes a versioned replay record under `<resultsDir>/completion-replay/<runId>.json` and a bounded output archive under `<resultsDir>/output-archives/<runId>.json`. Replay records expire with the completion deduplication window and are best-effort temporary state, not a permanent run ledger.

`subagent_wait` surfaces a slim projection of each terminal payload it covered in its own tool-result `details.completions` — run identity, per-child agent/`runId`/success, artifact paths, and the bounded `archivePath`, without duplicating output text. It reads the replay when watcher delivery or a watcher restart has removed the one-shot result file and in-memory completion state is unavailable. Durable non-blocking wait subscriptions use the same replay in their delivered details. Workflow result files record each child's `runId` explicitly, since a workflow child's `artifactPaths` entry points at its saved output rather than the artifact files keyed by the id. Extensions observing `tool_result` events can read run and artifact identity from there instead of parsing the text summary.

Output archives reference an existing child output artifact or session file when one is available. For children without either file, the archive stores only the tail of result text, bounded to 64 KiB per run, and records whether it was truncated. Replay and archive JSON use `version: 1`; consumers must ignore unknown fields.

Nested fanout status is stored as compact sidecar event/registry metadata and merged into parent status views and result/intercom payloads; full recursive status snapshots are not embedded in parent result files.

Consumers should read these JSON files instead of scraping terminal output. Unknown fields and event types should be ignored for forward compatibility.

### Status and result fields

The status/result fields are: `lifecycleArtifactVersion`, `runId`/`id`, `sessionId`, `mode`, `state`, `startedAt`, `lastUpdate`, `endedAt`, `durationMs`, `cwd`, `asyncDir`, `sessionFile`, `outputFile`, `workflowGraph`, `steps`, `results`, `totalTokens`, `totalCost`, `model`/`attemptedModels`/`modelAttempts`, `toolCount`, `turnCount`, optional `launchResolvedExtensions`, optional `runtimeAcknowledgedExtensions`, and nested `children` when a child is allowed to launch subagents.

`launchResolvedExtensions` is parent-resolved launch intent only: it reports opaque extension identifiers and whether ambient extensions were disabled, without exposing raw extension paths or claiming the child runtime acknowledged that those extensions loaded.

### Runtime extension acknowledgement

Cooperating child extensions can acknowledge child-runtime registration by emitting `subagent:acknowledge-extension` on the child process `pi.events` bus with payload `{ id: string }`.

Acknowledgement ids are self-declared opaque strings. They must be non-empty, at most 128 characters, contain only `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, `@`, `+`, or `-`, and must not contain `/`, `\`, or `..`.

The reported `runtimeAcknowledgedExtensions` projection is `{ version: 1, source: "child-runtime", ids, omitted }`. It deduplicates ids, keeps at most 32 ids, and counts additional valid unique ids in `omitted`. It is best-effort observability only: absence means no cooperating extension acknowledged, and presence means only that the extension registered in the child runtime, not that its tools, health checks, or features succeeded. Late acknowledgements after terminal serialization are ignored.

### Lifecycle events

`events.jsonl` records lifecycle transitions such as `subagent.run.started`, `subagent.step.started`, `subagent.step.completed`/`failed`/`paused`/`stopped`, control attention events, nested interrupt failures, and `subagent.run.completed`/`stopped`. Run boundary events include the lifecycle artifact version.

### Process-terminal proof

Lifecycle artifact v3 adds `process-terminal-candidate.json` (private runner evidence) and `process-terminal.json` (the public proof projection).

A proof is `observed` only after the live parent observes the exact detached runner's `close` event, every recorded child writer has a close record, and any tracked canonical-session lease is free. If the observer is unavailable, the proof is `unknown`; do not infer process exit from `endedAt`, result-file existence, PID disappearance, or lease-directory absence.

The `subagent:process-terminal` event and RPC `ping.capabilities.processTerminalProof` expose this status. Process proof is point-in-time evidence and remains separate from execution success or stopped/non-resumable state.

### Child-protocol bounds

Foreground and async runners share bounded child-protocol handling:

- A child JSONL line above 16 MiB fails with structured `protocolError` code `protocol_output_limit`. Oversized Pi `turn_end` and `agent_end` aggregates are the exception because they duplicate granular events, so runners replace them with bounded lifecycle records while preserving `agent_end.willRetry`.
- Stderr retains only its latest 128 KiB.
- Split UTF-8 and final unterminated JSON events remain valid.
- `agent_end.willRetry` defers completion until the child settles.
- Current Pi builds use `agent_settled` as the terminal watermark; older builds retain the bounded terminal-message fallback.

## Workflow and debug artifacts

Each scripted workflow stores runtime artifacts under a workflow artifact directory. The on-disk directory is still named `chain-runs` for compatibility. With the default `artifactDir: "session"` or with `"temp"`, it is user-scoped temp storage. With `artifactDir: "project"`, the root is `<cwd>/.pi/subagents/chain-runs/`:

```text
<tmpdir>/pi-subagents-<scope>/chain-runs/{runId}/
```

A run directory may contain files such as `context.md`, `plan.md`, `progress.md`, and `parallel-{stepIndex}/.../output.md`. User-scoped temp workflow artifact directories older than 24 hours are cleaned up on extension startup; project-local and explicit persistent roots are not age-scanned.

Debug artifacts live under `{sessionDir}/subagent-artifacts/`, `.pi/subagents/artifacts/` for project-scoped runs, or a user-scoped temp artifact directory. Single-run relative `output` files are saved under `{artifactsDir}/outputs/{runId}/` unless `singleRunOutputBaseDir` is configured. Per task you may see:

- `{runId}_{agent}_input.md`
- `{runId}_{agent}_output.md`
- `{runId}_{agent}.jsonl`
- `{runId}_{agent}_meta.json`

Metadata records timing, usage, exit code, final model, attempted models, fallback attempt outcomes, and the resolved acceptance ledger with its parsed child report.

For npm package projects, project-scoped artifacts need a `.npmignore` rule (or `.gitignore` when no `.npmignore` exists) or a `files` allowlist that does not include `.pi/subagents/`. pi-subagents warns at launch when these package settings can include the artifacts. Use `artifactDir: "session"` or `"temp"` to keep them outside the package worktree.

## Sessions

Session files are stored under a per-run session directory. With `context: "fork"`, each child starts with `--session <branched-session-file>` produced from the parent's current leaf. That is a real session fork, not an injected summary. An omitted launch `context` that resolves through `defaultContext: fork` uses the same branch when the parent session file and current leaf exist, and otherwise starts fresh.

## Completion notifications

Async completions belong only to the originating session. The result watcher emits `subagent:async-complete`, and the extension consumes that event to record completion state.

Successful sibling completions are held briefly and delivered as a quiet grouped completion when they finish within a short window (see `completionBatch` in [configuration.md](configuration.md)), avoiding unread markers on inactive tabs. Failed and paused completions remain visible and fire immediately.

## Events

Async events:

- `subagent:async-started`
- `subagent:async-complete`

The `subagent:async-started` payload includes `task`, the backwards-compatible first child task truncated to 50 characters, and `goal`, the workflow-level caller task truncated to 120 characters (falling back to the first child task). Companion UI extensions can combine `goal`, `workflowGraph`, and the live lifecycle artifacts under `asyncDir` without scraping terminal output.

Intercom delivery events:

- `subagent:control-intercom`
- `subagent:result-intercom`

`src/extension/index.ts` registers the notification handler that consumes `subagent:async-complete`. Control/attention events are surfaced as visible parent notices and persisted for async runs. Native supervisor requests are delivered only to the exact parent session that spawned the child.

`pi.events` is in-process only. It does not reach separate Pi processes or child subagents; use the file lifecycle artifacts or `pi-intercom` for cross-process coordination.
