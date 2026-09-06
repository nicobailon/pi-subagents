# Observability

Where running subagents show up, how to inspect them, and the files and events they leave behind.

## Foreground runs

Foreground runs stream progress in the conversation while they run. They default to a generous 30-minute wall-clock timeout when neither the call nor the selected agent provides a timeout; a global [`timeoutMs`](configuration.md#timeoutms) config replaces that default, and explicit `timeoutMs`/`maxRuntimeMs` and agent defaults win.

A foreground child is a pi session created inside the parent Pi process, not a second `pi` process. A run timeout, tool timeout, interrupt, or stop aborts the child session and disposes it. Detach keeps the session running inside the parent and publishes the same receipt and completion notification as before.

A background child is a pi session created inside the detached runner process. The runner mirrors session events into `events.jsonl`, `output-<index>.log`, and the transcript. Interrupt and stop abort the child session; steer requests are delivered with the session's `steer` or `followUp`.

Live progress shows compact detail for single, chain, and parallel modes: a bounded one-line task, current tool, recent output, token counts, aggregate cost, duration, activity freshness, current-tool duration, and chain graph metadata when available. Workflow `label` metadata wins over raw task text in compact multi-child cards.

Press Pi's configured expand key (`Ctrl+O` by default) to expand the full streaming view with complete output per step. Running-card hints also advertise `Ctrl+Alt+F` for the Fleet inspector.

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
    task: Review authentication boundaries
    ⎿  read: src/auth.ts | 2.0s
    Press configured-expand-key for live detail · Ctrl+Alt+F Fleet
```

To inspect one background child in text, use `subagent({ action: "status", id: "...", view: "transcript" })`; add `index` for a specific child in a parallel or chain run.

### Reducing status display noise

Chat records tool-call history; FleetView and the async widget show live run/child updates. Separate `subagent({ action: "status", id: "..." })` calls leave separate historical entries even when their `Status target: run …` labels match. A matching run ID identifies the queried run, not the tool call, and is not evidence of duplicate execution. Live Fleet/widget refreshes do not merge those entries.

For compact chat results with FleetView as the only live editor surface, merge these top-level keys into `~/.pi/agent/extensions/subagent/config.json` (not Pi's `settings.json` or a `subagents` object), then restart Pi:

```json
{
  "inlineToolDisplay": "summary",
  "fleetView": true,
  "asyncWidget": false
}
```

- `inlineToolDisplay: "summary"` keeps one static result row per call, alongside its call heading. A completed status query is not proof that the queried child has finished.
- `fleetView: true` retains live progress. Open `/subagents-fleet` or press `Ctrl+Alt+F` for details instead of repeatedly requesting status just to watch progress. Pi's expand key does not expand summary results; keep `"rich"` if you want expandable inline output.
- `asyncWidget: false` hides only the additional under-editor async widget, leaving FleetView available. This configuration reduces visible surfaces; it does not guarantee ordering relative to other extensions.

Thanks to [DraconDev](https://github.com/DraconDev) for reporting the display noise and suggesting summary mode in [#1931](https://github.com/nicobailon/pi-subagents/issues/1931).

## FleetView

In the TUI, a persistent FleetView below the editor keeps active work visible as a compact summary. Set `fleetViewPlacement` to `"aboveEditor"` to move it above the editor.

```text
2 active agents · 1 pane · ↓ 3.1k window · 4.2k spent · ↓/← to inspect
```

After you expand it:

```text
↑↓/jk select · enter inspect · esc back

> main
    scout · running         1m 12s · ↓ 2.0k window · 2.8k spent
    reviewer · running        38s · ↓ 1.1k window · 1.4k spent
```

When the focused editor is empty, press `↓` or `←` to expand the summary into `main` plus active children with agent name, state, elapsed time, and token usage. When providers report usage, `window` is the latest assistant turn's input plus cache-read tokens, while `spent` keeps the cumulative input-plus-output total. Old run artifacts without window data keep the existing token-total label. The compact line counts active current-session work and Herdr project panes. Then use `↑`/`↓` or `j`/`k` to select a child and `Enter` to open the Fleet lobby; press `Enter` or `H` there to open its child-specific Herdr inspector. Printable navigation keys are never intercepted before activation.

FleetView and the under-editor async widget are both enabled by default; set `asyncWidget: false` to keep only FleetView. Successful background completions stay quiet so inactive Pi tabs are not marked unread, while failed or paused completions still notify the originating session. Parallel runs show every active child independently. Chains with parallel groups keep their grouped shape in progress and results, so failed or paused agents stay visible next to completed ones. When a child is explicitly allowed to fan out with `tools: subagent` or `allowNestedSubagents: true`, its nested runs appear under that parent child in the main status tree instead of being hidden inside the child session.

## The fleet inspector

`/subagents-fleet` opens the live fleet inspector with current-session foreground work, recent async children, structured Markdown/tool transcripts, and completed output/session paths.

Default keys:

- `↑`/`↓` or `j`/`k` — select a child
- `Shift+K`/`Shift+J` — scroll one line
- `PgUp`/`PgDn` — scroll one page
- `x`/`Ctrl+O` — toggle tool details
- `r` — refresh
- `Esc` — close
- `Enter` — open the selected inspectable async child in its child-specific Herdr inspector
- `s` — compose an acknowledged message to a selected live async child; Tab cycles `steer`, `follow_up`, and `auto`
- `D` — stop a selected child's top-level async run after confirmation
- `H` — open the selected active async child in a Herdr inspector pane (Herdr 0.7.5+)

Set `fleetKeybindings` in the extension config to replace inspector-level keys when a terminal intercepts keys such as `PgUp`, `PgDn`, `Home`, or `End`. Prompt modes keep fixed keys such as `Esc`, `Enter`, `Tab`, and stop-confirmation `Y`/`N`.

`Ctrl+Alt+F` opens the same inspector even while a foreground turn is active and slash input is queued.

Enter and `H` use the existing Herdr pane path. In a child-specific Herdr inspector, type ordinary guidance and press Enter to send it through the acknowledged steer channel; `steer <message>`, `status`, and `stop` remain available as explicit controls.

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

## Host inspection protocol (RPC)

RPC hosts receive live async status through the bounded `subagent-async` widget
(`PI_SUBAGENT_ASYNC_JSON:` payload). For on-demand detail — a child's delegated
task, transcript window, or final output — hosts can invoke the extension
command:

```text
/subagents-inspect-rpc <requestId> <asyncId> [childId] [--lines N]
```

Extension commands execute inline over Pi RPC without a model turn. The reply
arrives as a single emit-then-retract update on the dedicated `subagent-inspect`
widget key: the first (and only) line is `PI_SUBAGENT_INSPECT_JSON:<JSON>` with a
versioned `pi-subagents.inspect-reply` payload correlated by `requestId`. Hosts
must not render this widget; they should buffer the payload by `requestId` and
drop unmatched replies.

Inspection properties:

- Read-only and on demand: nothing is persisted, broadcast, or added to
  notification details; every request re-reads canonical run artifacts after
  the same reconciliation the status action performs.
- Session-scoped: runs owned by another session fail with `foreign_session`;
  unknown ids fail with `not_found`; cleaned-up artifacts fail with `stale`.
- Bounded: per-field string caps, a message-count cap (`--lines`, max 200), and
  a hard 64 KB serialized budget with explicit `truncated` markers.
- No filesystem paths appear in the reply.
- `task` is the child session's first user message and is only populated when
  it is genuinely attributable (fresh-context child whose session file fits the
  read window); forked children omit it.
- `childId` is exactly the node id the host received in the status snapshot
  (step `workflowKey`/`runId`/`step:<index>`, or a nested run id).

In TUI mode the command only points at the interactive `/subagents` inspector.

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

`bg_wait` surfaces a slim projection of each terminal payload it covered in its own tool-result `details.completions` — run identity, per-child agent/`runId`/success, artifact paths, and the bounded `archivePath`, without duplicating output text. It reads the replay when watcher delivery or a watcher restart has removed the one-shot result file and in-memory completion state is unavailable. Durable non-blocking wait subscriptions use the same replay in their delivered details. Workflow result files record each child's `runId` explicitly, since a workflow child's `artifactPaths` entry points at its saved output rather than the artifact files keyed by the id. Extensions observing `tool_result` events can read run and artifact identity from there instead of parsing the text summary.

Output archives reference an existing child output artifact or session file when one is available. For children without either file, the archive stores a per-child `result-tail` entry with `resultIndex`, bounded to 64 KiB per child, and records whether it was truncated. Replay and archive JSON use `version: 1`; consumers must ignore unknown fields.

Nested fanout status is stored as compact sidecar event/registry metadata and merged into parent status views and result/intercom payloads; full recursive status snapshots are not embedded in parent result files.

Consumers should read these JSON files instead of scraping terminal output. Unknown fields and event types should be ignored for forward compatibility.

RPC hosts that need low-latency child-stop UI hints can subscribe to the
`subagent:child-status` event advertised by RPC `ping` as `events.childStatus`.
The payload uses `type: "subagent.child-status"`, `version: 1`, `runId`,
`childId`, `status` (`"stopping"` or `"stopped"`), `ts`, and optional child
metadata such as `stepIndex`, `agent`, `childRunId`, `workflowKey`, `phase`, and
`label`. These events are observer hints only. They can duplicate across RPC and
async replay paths, and they are not replayed after a host restart. Status
snapshots remain authoritative for recovery and final state. Child stop control
still uses the normal `stop` request with `childId`; there is no separate child
stop API.

### Status and result fields

The status/result fields are: `lifecycleArtifactVersion`, `runId`/`id`, `sessionId`, `mode`, `state`, `startedAt`, `lastUpdate`, `endedAt`, `durationMs`, `cwd`, `asyncDir`, `sessionFile`, `outputFile`, `workflowGraph`, `steps`, `results`, `totalTokens`, `totalCost`, `model`/`attemptedModels`/`modelAttempts`, `toolCount`, `turnCount`, optional `launchResolvedExtensions`, optional `runtimeAcknowledgedExtensions`, and nested `children` when a child is allowed to launch subagents.

`launchResolvedExtensions` is parent-resolved launch intent only: it reports opaque extension identifiers and whether ambient extensions were disabled, without exposing raw extension paths or claiming the child runtime acknowledged that those extensions loaded.

### Runtime extension acknowledgement

Cooperating child extensions can acknowledge child-runtime registration by emitting `subagent:acknowledge-extension` on the child session's `pi.events` bus with payload `{ id: string }`. The process that hosts the child session (the parent for foreground children, the runner for background children) captures the acknowledgement in memory.

Acknowledgement ids are self-declared opaque strings. They must be non-empty, at most 128 characters, contain only `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, `@`, `+`, or `-`, and must not contain `/`, `\`, or `..`.

The reported `runtimeAcknowledgedExtensions` projection is `{ version: 1, source: "child-runtime", ids, omitted }`. It deduplicates ids, keeps at most 32 ids, and counts additional valid unique ids in `omitted`. It is best-effort observability only: absence means no cooperating extension acknowledged, and presence means only that the extension registered in the child runtime, not that its tools, health checks, or features succeeded. Late acknowledgements after terminal serialization are ignored.

### Lifecycle events

`events.jsonl` records lifecycle transitions such as `subagent.run.started`, `subagent.step.started`, `subagent.step.completed`/`failed`/`paused`/`stopped`, control attention events, nested interrupt failures, and `subagent.run.completed`/`stopped`. Run boundary events include the lifecycle artifact version.

### Process-terminal proof

Lifecycle artifacts include `process-terminal-candidate.json` (private runner evidence) and `process-terminal.json` (the public proof projection).

A proof is `observed` only after the live parent observes the exact detached runner's `close` event and any tracked canonical-session lease is free. Children run inside the runner process, so the candidate records no separate writer processes. If the observer is unavailable, the proof is `unknown`; do not infer process exit from `endedAt`, result-file existence, PID disappearance, or lease-directory absence.

The `subagent:process-terminal` event and RPC `ping.capabilities.processTerminalProof` expose this status. Process proof is point-in-time evidence and remains separate from execution success or stopped/non-resumable state.

### Child session events

Both launch paths subscribe to the child session's event stream directly; there is no stdout protocol. The `events.jsonl` artifact mirrors those events with `message_update` dropped, and the transcript records them with `message_update` projected the same way pi's JSON mode prints it. `agent_end.willRetry` defers completion until the child settles, and `agent_settled` is the terminal watermark; a child whose run does not settle shortly after its terminal event is aborted and finished without it.

### Completion notification diagnostics

For an instrumented parent session, enable Node's opt-in debug sink **before starting Pi**:

```sh
NODE_DEBUG=pi-subagents-notify pi 2>notification-debug.log
```

This writes bounded JSON records prefixed `PI-SUBAGENTS-NOTIFY <pid>:` to stderr, not run artifacts or chat. The capture also contains other stderr output; review it before sharing. Records contain only `reason`, sanitized `id`/`runId` (up to 128 characters each), and `source`; task/output text, paths, credentials, and exception bodies are not included.

- `disposed`, `missing_session`, `foreground_session_mismatch`, `not_owned`: delivery rejected by an existing guard.
- `emit_foreground_session_mismatch`, `emit_not_owned`: ownership/session recheck rejected emission.
- `intercom_delivered`, `deduped_ttl`: already acknowledged; no new message needed.
- `deduped_pending`: shares an in-flight delivery promise.
- `batch_deferred`: held for batching, **not lost**; look for a later emission or disposal record for the same run.
- `send_accepted`, `send_failed`: `sendMessage` returned or threw, respectively. Acceptance is not proof the model read the message; failures remain retryable.
- `dispose_pending`: notifier shutdown left held results unacknowledged for later delivery.

Without `NODE_DEBUG`, tracing only checks the debug-enabled flag: no identity sanitization/serialization, diagnostic buffering, or log I/O. Existing delivery guards, TTL, timers and batching are unchanged. Traces cover notifier decisions only, not discovery gaps; absence of a trace does not diagnose the original missing-notification symptom.

## Workflow and debug artifacts

Each scripted workflow stores runtime artifacts under a workflow artifact directory. The on-disk directory is still named `chain-runs` for compatibility. With the default `artifactDir: "session"` or with `"temp"`, it is user-scoped temp storage. With `artifactDir: "project"`, the root is `<cwd>/.pi/subagents/chain-runs/`:

```text
<tmpdir>/pi-subagents-<scope>/chain-runs/{runId}/
```

A run directory may contain files such as `context.md`, `plan.md`, `progress.md`, and `parallel-{stepIndex}/.../output.md`. User-scoped temp workflow artifact directories older than 24 hours are cleaned up on extension startup; project-local and explicit persistent roots are not age-scanned.

Debug artifacts live under `{sessionDir}/subagent-artifacts/`, `.pi/subagents/artifacts/` for project-scoped runs, or a user-scoped temp artifact directory. Single-run relative `output` files are saved under `{artifactsDir}/outputs/{runId}/` unless `singleRunOutputBaseDir` is configured. For lane, review, council, and gate reports, prefer these managed artifacts or the aggregate workflow result instead of repo-root `reports/` files. Copy only final durable evidence to session memory, a mission artifact, a PR/comment, or an approved docs path. Per task you may see:

- `{runId}_{agent}_input.md`
- `{runId}_{agent}_output.md`
- `{runId}_{agent}.jsonl`
- `{runId}_{agent}_meta.json`

Metadata records timing, usage, exit code, final model, attempted models, fallback attempt outcomes, and the resolved acceptance ledger with its parsed child report.

For npm package projects, project-scoped artifacts need a `.npmignore` rule (or `.gitignore` when no `.npmignore` exists) or a `files` allowlist that does not include `.pi/subagents/`. pi-subagents warns at launch when these package settings can include the artifacts. Use `artifactDir: "session"` or `"temp"` to keep them outside the package worktree.

## Sessions

Session files are stored under a per-run session directory. With `context: "fork"`, each child starts from a branched session file produced from the parent's current leaf (foreground children open it in-process; background children receive it as `--session`). That is a real session fork, not an injected summary. An omitted launch `context` that resolves through `defaultContext: fork` uses the same branch when the parent session file and current leaf exist, and otherwise starts fresh.

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
