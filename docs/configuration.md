# Configuration

`pi-subagents` reads optional JSON config from `~/.pi/agent/extensions/subagent/config.json`. This page lists every key, plus the environment variables and the settings-file keys that affect config resolution.

Settings-level keys (`subagents.defaultModel`, `defaultProvider`, `defaultThinking`, `defaultExtensions`, `agentOverrides`, `agentScanDirs`, `modelScope`, `disableThinking`, `disableBuiltins`, watchdog settings) live in Pi settings files, not this config file. `modelScope.agents.<name>` adds per-agent restrictions, and `allow: ["inherit"]` permits the current parent model. See [models.md](models.md), [agents.md](agents.md), and [watchdog.md](watchdog.md).

## Project root resolution (settings)

By default, project settings resolve from the nearest parent directory that contains `.pi` or `.agents`, preserving existing nested-project behavior. In monorepos or git worktrees where an incidental nested `.pi` directory should not shadow the repository-level config, set this in the repository root `.pi/settings.json`:

```json
{
  "subagents": {
    "projectRootResolution": "git-root"
  }
}
```

`"git-root"` keeps package discovery, project agents, chains, and `agentOverrides` anchored to the git worktree root when that root also has Pi project config. A nested project can still opt back into nearest-root behavior by setting `"projectRootResolution": "nearest"` in its own `.pi/settings.json`.

## Extra agent scan directories (settings)

Add recursive user or project agent roots with `subagents.agentScanDirs` in Pi settings:

```json
{
  "subagents": {
    "agentScanDirs": ["~/.pi/flows/*/agents"]
  }
}
```

Entries support `~` expansion. A single `*` path segment expands one directory level, so package-like folders can each expose an `agents/` directory. Missing directories are ignored. Fixed user/project agent directories still win over same-name agents from scan roots.

## `modelResponseAliases`

In `~/.pi/agent/extensions/subagent/config.json` (top-level, not under `subagents`):

```json
{
  "modelResponseAliases": {
    "databricks-bedrock/ias-claude-opus-5": ["claude-opus-5"]
  }
}
```

Optionally accept exact response model IDs for an exact provider-qualified launch candidate. Keys use the resolved `provider/model` ID without its thinking suffix, including for fallback attempts; values are arrays of non-empty response ID strings. Alias matching is exact and case-sensitive, with no fuzzy or suffix matching. Empty arrays add no accepted IDs; malformed declarations fail config loading.

This is your explicit assertion that the declared response IDs identify the requested model, not proof from model output. It does not rewrite the outgoing model or provider route, authorize fallback models, or bypass verification for other routes. Foreground and background runs capture this declaration for launch and retain it on revival, including when no aliases were declared. Changing config affects new independent runs, not the retained declaration. Without a matching declaration, existing strict verification remains unchanged.

For a native Pi `model_verification_failed` where your proxy accepts `claude-haiku-4-5` but reports `anthropic.claude-haiku-4-5-20251001-v1:0`, independently confirm your proxy's mapping, then configure:

```json
{
  "modelResponseAliases": {
    "YOUR_PROVIDER/claude-haiku-4-5": ["anthropic.claude-haiku-4-5-20251001-v1:0"]
  }
}
```

Replace `YOUR_PROVIDER` with the resolved Pi provider ID. Keep the outgoing model alias unchanged. This native remedy already exists in v0.65.1; it does not infer equivalence from provider prefixes or dates. The built-in external `claude-code` adapter does not invoke this verifier or use this setting. If an external run shows this diagnostic, identify the installed version, resolved runner kind/adapter, and error location before applying a native remedy. Thanks to [sixtus](https://github.com/sixtus) for the concrete request-ID/response-ID example in [#1922](https://github.com/nicobailon/pi-subagents/issues/1922).

## `modelExclusions`

```json
{
  "modelExclusions": {
    "defaultTtlMs": 300000
  }
}
```

Controls the duration, in milliseconds, for model exclusions. The default is `86400000` (24 hours), and the maximum is `8000000000000000` so generated expiry timestamps remain valid JavaScript dates. The extension applies this value when it starts or reloads. A lower configured value shortens active cached exclusions from their original `recordedAt`; it never extends an existing expiry. Authentication-related exclusions are ignored when Pi's `auth.json` was modified after the exclusion was recorded; other exclusion types are unaffected. Launches also warn when a candidate is skipped, including the cached reason and expiry. `PI_MODEL_EXCLUSIONS_PATH` changes the exclusion-store path but does not change this TTL.

## `toolDescriptionMode`

```json
{ "toolDescriptionMode": "compact" }
```

Controls the parent-facing `subagent` tool description registered at startup. The default registers split prompt metadata: a short tool description plus `promptSnippet` and `promptGuidelines`. Set `"full"` to register the complete description as one tool description, or `"compact"` to keep the execution modes, async/`bg_wait` guidance, child-safety boundary, management/action split, one-writer review guidance, and artifact/status essentials with less prompt bloat.

`custom` reads `subagent-tool-description.md` from the project config directory, then from `~/.pi/agent/subagent-tool-description.md`. Missing, empty, unreadable, or oversized custom files fall back to the full description. Custom templates may use `{{fullDescription}}`, `{{compactDescription}}`, `{{safetyGuidance}}`, `{{agentDir}}`, and `{{projectConfigDir}}`; the safety guidance is always present so custom prose cannot remove the runtime guardrails. Restart Pi after changing the mode or custom file.

## `inlineToolDisplay`

```json
{ "inlineToolDisplay": "summary" }
```

Controls the `subagent` tool result shown inline in chat. The default, `"rich"`, shows live child activity and expands to detailed output. `"summary"` keeps the inline result at one stable row for running, completed, failed, stopped, and paused runs; it does not animate, show elapsed time, preview child output, or change when Pi's expand key is pressed. FleetView remains available for live progress and detailed inspection.

This is one result row **per tool call**, not one panel per run; the call heading remains. Separate `status` calls for the same run remain separate historical transcript entries. Summary mode neither merges those calls nor changes cross-extension ordering. For a compact chat plus one live editor surface, see [Reducing status display noise](observability.md#reducing-status-display-noise).

## `mainWindowRenderer`

```json
{
  "mainWindowRenderer": {
    "horizontalSpacing": 0,
    "compactResultMaxLines": 4
  }
}
```

Controls only the main chat `subagent` call/result renderer. It does not change child execution, orchestration, FleetView, artifacts, transcripts, or model-facing content.

`horizontalSpacing` is an integer from `0` to `4`. The default preserves current spacing. Set it to `0` to remove the extra spaces before compact result details and between parts of the call row.

`compactResultMaxLines` is a positive integer. It caps only collapsed rich-result rows and adds an expand hint when rows are hidden. Expanded output remains uncapped.

With `"summary"`, a tool result looks like this:

```text
✓ reviewer · completed
```

## `foregroundDetachShortcut`

```json
{ "foregroundDetachShortcut": "ctrl+b" }
```

Optionally binds a shortcut that detaches the active foreground single-subagent run without terminating it. The running foreground card shows the configured shortcut beside its live-detail hint. The default is unset, so pi-subagents does not reserve a global key.

Pi binds `Ctrl+B` to editor cursor-left by default. The extension shortcut takes precedence, but Pi reports the conflict at startup. To reserve the key without that warning, override the editor action in `~/.pi/agent/keybindings.json`:

```json
{
  "tui.editor.cursorLeft": "left"
}
```

## `orcaProgressTabs` (experimental)

```json
{
  "orcaProgressTabs": {
    "enabled": true
  }
}
```

Opt in to a best-effort Orca observer that creates one Orca terminal tab for each top-level subagent call and mirrors the run's live tool and assistant progress. Parallel and chain children share that one tab, with child section headers in the mirrored log. Tab titles use a persistent worktree-local sequence (`subagents · <run-label> · 1`, `... · 2`, and so on), so separate top-level calls do not reuse the same number. For the same worktree, `orca terminal create` runs one at a time in that sequence so observer tabs appear from left to right as `1`, then `2`, then `3`. This does **not** replace Pi as the runner: native Pi children keep the same lifecycle, status, control, artifact, and result paths. External CLI profiles also keep their existing runner and can mirror their stdout/stderr.

The integration is off by default and supports macOS and Linux. It is disabled on Windows. When enabled, `pi-subagents` looks for executable `orca` on `PATH`, or uses the executable path in `PI_SUBAGENT_ORCA_BINARY`. If no executable is available, Orca is not running, the cwd is not an Orca-managed worktree, or `terminal create` fails, the authoritative subagent still runs normally. Tab creation is deliberately best-effort and never changes the child result. A passive observer manifest is also written under `<worktree>/.pi/subagents/views/orca/` when possible so future view surfaces can discover the Orca tab without making Orca authoritative.

Set `enabled` to `false` (or remove the block) as a kill switch. In that state, `pi-subagents` does not invoke `orca` and creates no Orca tabs. The temporary mirror files contain child output, use private file modes where supported, and are removed shortly after the run finishes. Each mirror is capped at 1 MiB. The observer stops accepting progress when the cap or stream backpressure is reached and appends a truncation notice. The viewer removes terminal control sequences with parser state that persists across file reads. On completion, the viewer exits back to the Orca terminal's shell prompt; the tab and its terminal scrollback remain open until the user closes the tab. A successfully completed native Pi run with a recorded session ends with a safely quoted `rm -- <exact-session-path>` command; failed, stopped, timed-out, and sessionless runs do not show the removal command.

## `asyncByDefault`

```json
{ "asyncByDefault": false }
```

WorkflowScript calls use background execution when the request omits `async`. Set `asyncByDefault` to `false` to restore foreground-by-default behavior for tool launches that still use the internal single-run primitive. Callers can still force foreground with `async: false` unless `forceTopLevelAsync` is enabled.

## `defaultSubagentContext`

```json
{ "defaultSubagentContext": "fresh" }
```

Sets `fresh` or `fork` for every subagent launch that omits `context`. This global preference replaces each agent-level `defaultContext`. Explicit `context: "fresh"` or `context: "fork"` still wins.

With `"fork"`, the setting uses the existing implicit-fork behavior. A launch starts fresh when the parent session file or current leaf is not available. `"fresh"` starts fresh even when the selected agent defaults to fork. Scheduled runs continue to set fresh context explicitly. A runner or provider that does not support fork context keeps its existing rejection behavior.

## `forkContext`

```json
{
  "forkContext": {
    "mode": "pruned",
    "model": "openai-codex/gpt-5.6-luna:max"
  }
}
```

Controls how resolved fork launches prepare the inherited session. The default `"full"` mode keeps the complete fork. `"pruned"` mode keeps inherited context exact while it fits the code-owned 64 KiB session budget. On overflow, the required `model` returns short JSON summaries keyed by stable item ids. Tool results spill first, then older assistant and tool context, and user text only when required. It applies to explicit `context: "fork"`, global and agent fork defaults, and `context: "profile"` when the selected profile resolves to fork.

Child-visible spilled items contain only the model summary and a stable `{ batchId, itemId }` recovery ref. Raw bodies and their digests, source entry ids, labels, sizes, and tool metadata go to a private `0600` sidecar next to the child session. This release does not add a recovery command or expose that payload to the child model.

Pruned forks keep the normal `parentSession` link, child cwd alignment, and fork thinking-block sanitization (signed Anthropic thinking blocks are stripped; the child keeps its requested thinking level). Missing model or auth, invalid or incomplete summary JSON, budget overflow, recovery validation failure, and raw overflow leakage all stop the launch before child spawn. The extension never falls back to a full fork or refs-only context after a prune failure.

## `fleetView`

```json
{ "fleetView": false }
```

Controls the persistent, navigable FleetView. The default is `true`. Set it to `false` to hide FleetView without disabling status tracking, completion notifications, `/subagents-fleet`, or lifecycle events.

## `fleetViewPlacement`

```json
{ "fleetViewPlacement": "aboveEditor" }
```

Places the persistent FleetView either `"belowEditor"` or `"aboveEditor"`. The default is `"belowEditor"`; invalid values fall back to `"belowEditor"`.

## `fleetKeybindings`

```json
{
  "fleetKeybindings": {
    "pageUp": ["u"],
    "pageDown": ["d"],
    "selectFirst": ["g"],
    "selectLast": ["G"]
  }
}
```

Customizes only the full Fleet inspector opened by `/subagents-fleet` or FleetView inspection. It does not change Pi's global keybindings or the compact persistent FleetView.

Each action accepts a non-empty array of key strings. Configured actions replace their defaults. Unset actions keep the defaults: `selectUp` is `up`/`k`, `selectDown` is `down`/`j`, `scrollUp` is `K`, `scrollDown` is `J`, `pageUp` is `pageUp`, `pageDown` is `pageDown`, `selectFirst` is `home`, `selectLast` is `end`, `toggleTools` is `x`/`X`/`ctrl+o`, `refresh` is `r`/`R`, `steer` is `s`, `stop` is `D`, `inspect` is `H`, and `close` is `escape`/`ctrl+c`/`q`.

Prompt modes keep their fixed keys. For example, `Esc` still cancels steer text or stop confirmation even when the Fleet-level close binding is changed.

## `asyncWidget`

```json
{ "asyncWidget": true }
```

Controls the under-editor widget for active background runs. It defaults to `true`, including when FleetView is enabled, so active work remains visible after reload. Set it to `false` to hide this widget while keeping FleetView available.

## `waitTool`

```json
{ "waitTool": { "enabled": true, "defaultTimeoutMs": 120000 } }
```

`defaultTimeoutMs` sets the blocking window used when a `bg_wait` call omits `timeoutMs`; explicit call values win, followed by this setting, then the 30-minute fallback. `bg_wait` is the only registered wait tool. When the window elapses, the tool returns a non-error `window_elapsed` result with the still-active work identities, and that work keeps running. Set `enabled` to `false` to make direct calls return immediately instead of blocking. The default is enabled. You can also set `"waitTool": false`; set `PI_SUBAGENT_WAIT_TOOL_ENABLED=false` (or `0`, `off`, `disabled`) to override config for one process. The effective enabled and default-timeout values are passed explicitly to child runtimes. Headless `agent_end` auto-drain retains its own strict deadline and fails if required work remains unresolved. Invalid config or environment values fail instead of being coerced.

Blocking `bg_wait({ id: "..." })` keeps the current tool call open until that run changes. By default it returns when a run needs attention. Use `bg_wait({ stopOnAttention: false })` only for run-to-completion flows that should wait through idle or long-thinking attention; supervisor/contact requests still stop the wait. In a long-lived interactive parent session, `bg_wait({ id: "...", nonBlocking: true })` instead resolves the prefix once, persists the exact run identity, returns a subscription token immediately, and wakes that session on completion, failure, attention, reconciliation failure, or timeout. Use it for provider, detached, or other background work without a native completion notification; ordinary async subagent runs notify the parent natively and do not need a wait subscription. Armed subscriptions appear in ordinary `subagent({ action: "status" })` output and are not counted as active child work.

This is different from `waitTool.enabled=false`, which returns immediately without registering any future wake. Provider items remain available only to blocking fleet-wide waits; non-blocking subscriptions require one async or remembered detached foreground run id.

## `resultScanLogging`

```json
{ "resultScanLogging": "activity" }
```

Controls how slow result-index scans are logged. Defaults to `"activity"`; valid values are `"all"`, `"activity"`, and `"off"`.

The watcher logs `Subagent result scan inspected … scheduled …` through `console.error` whenever a result-index scan passes the slow threshold (500ms). With `"activity"` (default), it logs only scans that inspected or scheduled actual work. Use `"all"` to log every slow scan, including the periodic healthy rescan that inspects zero files while no async runs are pending, or `"off"` to silence slow-scan logging entirely. `"off"` does not disable result delivery or the watcher itself, only its slow-scan log line.

## `forceTopLevelAsync`

```json
{ "forceTopLevelAsync": true }
```

Forces depth-0 internal single, parallel, and chain runs into background mode and bypasses launch UI by forcing `clarify: false`. Nested calls keep their own inherited settings.

## `timeoutMs`

```json
{ "timeoutMs": 3600000 }
```

Global default runtime deadline, in milliseconds, for subagent runs. It replaces the built-in 30-minute backstop for foreground launches (single, parallel, chain, and workflowScript) and plain single-agent async runs whenever no call-level `timeoutMs`/`maxRuntimeMs` applies. For single-agent launches, selected agent frontmatter `timeoutMs` still wins. This only moves the *default*. Expiring this run-level deadline is terminal and does not trigger `fallbackModels`; only provider/model failures reported before the deadline can fall back.

Use it when foreground orchestration or plain async single-agent runs need a longer default than 30 minutes. It does not set async composite top-level deadlines, and it does not replace async fan-out child deadlines.

Composite async runs (async chains, parallel tasks, and scripted workflows) stay unbounded at the top level by design. Their runner children are bounded individually by their own agent or runner defaults, so this value does not cap them. Must be a positive integer no greater than `2147483647` (the largest delay a Node.js timer can honor, roughly 24.8 days); invalid or out-of-range values are ignored and the built-in defaults apply.

## `toolTimeoutMs`

```json
{ "toolTimeoutMs": 600000 }
```

Optional hard per-tool-call deadline in milliseconds. When configured, a child that emits `tool_execution_start` but not `tool_execution_end` is terminated with `timedOut: true` and a tool-specific error. The effective value is resolved per child: explicit `subagent` call value, then agent frontmatter, then this config value, then `PI_SUBAGENT_TOOL_TIMEOUT_MS`.

Without a configured value, Pi still applies a five-minute hard timeout to known-fast built-in tools: `read`, `grep`, `find`, `ls`, `edit`, `write`, and `structured_output`. Long-running tools such as `bash`, custom tools, and MCP tools do not get a hard default. They get the normal open-tool attention notice after `activeNoticeAfterMs` and remain bounded by the run-level deadline.

The tool timer tracks each active `toolCallId` separately and never extends the run-level deadline: when the remaining run budget is shorter, the ordinary run-level timeout wins. `contact_supervisor`, `intercom`, and `bg_wait` are exempt because their legitimate purpose can be to wait for a human, supervisor, or background run. Use hard tool timeouts only for wedge protection; an elapsed timeout is not a mutation-safe boundary. Configured values must be positive integers no greater than `2147483647`; invalid or out-of-range values are rejected with a visible error rather than silently ignored.

## `globalConcurrencyLimit`

```json
{ "globalConcurrencyLimit": 20 }
```

Caps simultaneously running children inside one run, including durable legacy multi-child runs and `workflowScript` launches through `runs.run`/`runs.all`. Queued workflow children retain their stable keys and begin when a running sibling releases capacity. The default is `20`.

Inline or file-backed top-level workflow calls may set a positive safe-integer `globalConcurrencyLimit` to override this value for that workflow. The override is workflow-only and is not forwarded to child calls.

## `maxSubagentSpawnsPerSession`

```json
{ "maxSubagentSpawnsPerSession": 100 }
```

Optionally caps the total number of child subagent launches during one parent session, including completed and failed children, parallel task counts, static chain steps, and bounded dynamic fanout children. Sessions are unlimited by default. Set this value to `0` to disable a configured cap. `PI_SUBAGENT_MAX_SPAWNS_PER_SESSION` overrides the config for a process and follows the same positive-cap/zero-unlimited semantics.

`subagent({ action: "status" })`, fleet status, and `subagent({ action: "doctor" })` expose used, effective limit, remaining capacity, grants, and the remaining grant allowance for this budget. A user may explicitly call `subagent({ action: "grant-spawn-budget", additional: 10 })` from the root interactive parent after all children settle and confirm the native prompt. Grants are additive: they never erase cumulative usage, are rejected for unlimited sessions and child/headless callers, and total granted capacity cannot exceed the original configured cap. Compaction remains part of the same logical parent session and does not reset usage or grants; starting a new parent session does.

## `maxSubagentSpawnsPerRun`

```json
{ "maxSubagentSpawnsPerRun": 64 }
```

Caps cumulative logical child admissions in one top-level run tree. The default is `64`. `PI_SUBAGENT_MAX_SPAWNS_PER_RUN` overrides the config when it is a positive integer. Invalid, zero, or missing values fall back to the configured positive value or `64`.

Inline or file-backed top-level workflow calls may set a positive safe-integer `maxSubagentSpawnsPerRun`; it overrides the environment and config for that workflow. Inherited nested budgets remain authoritative, and the override is not forwarded to child calls.

The budget counts single launches, expanded `tasks`/`count`, static chain steps and parallel groups, actual dynamic `expand` items, appended chain steps, workflow children, and nested child calls. Static and materialized dynamic groups are admitted atomically. Startup retries, model fallback, and retained-child resume reuse the original logical child claim. Claims are never released or refunded. This cap is independent from the session-wide cumulative spawn budget and `globalConcurrencyLimit`.

## `maxActiveAsyncRunsPerSession`

```json
{ "maxActiveAsyncRunsPerSession": 4 }
```

Optionally caps concurrently active top-level async runs owned by one parent session. Unset or `0` keeps the existing unlimited behavior. A positive integer reserves one slot before an async single, parallel, chain, or workflow creates run artifacts or starts children. Foreground runs and nested/workflow children do not reserve another slot.

Queued, running, paused, and needs-attention runs retain capacity. Runner-backed slots release only after terminal logical state and matching observed process-terminal proof from #1030. Missing, malformed, or unknown cleanup proof retains the slot. A terminal async workflow releases after its controller is gone and every launched child is accounted for: awaited foreground children are covered by workflow settlement, while actual background children still require observed process-terminal proof. Resume transfers the source slot without a second charge. Dismissal and history cleanup do not release capacity.

When the runner is gone but process cleanup proof remains unknown, configure a bounded policy reclaim under `capacity.abandonedSlotReleaseAfterMs`:

```json
{ "maxActiveAsyncRunsPerSession": 4, "capacity": { "abandonedSlotReleaseAfterMs": 1200000 } }
```

The default is `1200000` milliseconds (20 minutes). The policy releases only a failed terminal run whose runner PID is dead and whose last activity is older than the threshold. A live or unknown PID, a non-failed terminal state, a recent run, or missing activity timestamp retains the slot. Set the value to `false` to keep strict retention. Valid configured durations range from 5 minutes through 24 hours. Policy release is reported as `abandoned-timeout` with `processProof: unknown`; it is not observed process-terminal proof and may reclaim capacity while an orphan child still exists.

This limit bounds current top-level async load. It is separate from cumulative `maxSubagentSpawnsPerSession`, `maxSubagentSpawnsPerRun`, and `globalConcurrencyLimit`.

`subagent({ action: "status" })`, fleet status, and `subagent({ action: "doctor" })` expose used, effective limit, and remaining active capacity. Static chains and parallel calls fail before creating run artifacts or starting partial work when their declared capacity cannot fit. Later retries or unbounded dynamic work are not guaranteed by that preflight.

## `scheduledRuns`

```json
{ "scheduledRuns": { "enabled": false, "maxPending": 20 } }
```

Durable schedules are enabled by default and stored per project under `.pi/subagents/schedules/<id>/`. See [missions.md](missions.md#schedules) for usage.

Set `storeRoot` to keep durable schedules outside project repositories. It must be an absolute path or a `~/` path, which expands from the user home directory. Each project is stored under a hash of its resolved working directory, so projects do not share schedules.

```json
{ "scheduledRuns": { "storeRoot": "~/.local/share/pi-subagents/schedules" } }
```

When `storeRoot` is omitted, schedules remain at `<cwd>/.pi/subagents/schedules`.

## `parallel`

```json
{
  "parallel": {
    "maxTasks": 12,
    "concurrency": 6
  }
}
```

`maxTasks` defaults to `8`; `concurrency` defaults to `4`. Per-call `concurrency` takes precedence.

## `defaultSessionDir`

```json
{ "defaultSessionDir": "~/.pi/agent/sessions/subagent/" }
```

Session directory precedence is: `params.sessionDir`, then `config.defaultSessionDir`, then a directory derived from the parent session. Sessions are always enabled.

## `singleRunOutputBaseDir`

```json
{ "singleRunOutputBaseDir": "~/.pi/subagent-outputs" }
```

Routes relative `output` paths for single-agent `/run` calls under this directory. Absolute per-call or agent output paths are still used as-is. When unset, relative single-run outputs go under the run's output artifact directory instead of the project root.

## `maxSubagentDepth`

```json
{ "maxSubagentDepth": 1 }
```

Controls nested delegation when no stricter limit is inherited from the launching child's runtime config. Per-agent `maxSubagentDepth` can tighten the limit for that agent's child runs, but cannot relax an inherited stricter limit. This applies even to children that explicitly declare `tools: subagent` or `allowNestedSubagents: true`; at the cap, execution fanout is blocked instead of silently hiding nested work.

## `PI_SUBAGENT_PI_BINARY`

```bash
export PI_SUBAGENT_PI_BINARY=/path/to/pi-or-wrapper
```

Overrides the `pi` command pi-subagents spawns for Herdr project panes (`action: "project.open"`) and for the profile model probe. Package wrappers can set this to their own `pi` binary so those launches inherit wrapper flags, environment setup, and bundled resources without relying on `PATH` ordering. Empty or whitespace-only values are ignored. It does not affect children: foreground children are sessions inside the parent Pi process and background children are sessions inside the detached runner process, and neither spawns a `pi` binary. Background children require pi installed as the npm package (`@earendil-works/pi-coding-agent`), because the runner imports pi's packages from that package directory; a standalone pi binary has no package directory, and background launches fail with an error saying so.

## `intercomBridge`

```json
{
  "intercomBridge": {
    "mode": "always",
    "instructionFile": "./intercom-bridge.md",
    "resultDelivery": true
  }
}
```

Controls whether subagents receive runtime coordination instructions and whether `contact_supervisor` is auto-added to their tool allowlist when needed.

Fields:

- `mode`: default `always`; use `fork-only` to inject only for forked runs, or `off` to disable the bridge.
- `instructionFile`: optional Markdown template replacing the default bridge instructions. `{orchestratorTarget}` is interpolated. Relative paths resolve from `~/.pi/agent/extensions/subagent/`.
- `resultDelivery`: default `false`; set `true` only when an external listener consumes `subagent:result-intercom` and acknowledges the grouped completion payload. This is optional external result delivery, not native supervisor messaging. Enabled delivery waits for acknowledgement and reports acknowledgement failures. It does not change supervisor asks or progress updates.

Bridge activation requires a targetable current parent session id, which `pi-subagents` passes to children automatically. Native supervisor messaging does not require an external `pi-intercom` installation or per-agent extension allowlists: children use `contact_supervisor`, and parents use `subagent_supervisor` to inspect or reply. Agents can still use an external `intercom` tool when they explicitly request a provider that supplies it.

The default injected guidance tells children to use `contact_supervisor` with `reason: "need_decision"` when blocked or needing a decision, `reason: "progress_update"` only for meaningful blocked/progress updates, and avoid routine completion handoffs.

## `worktreeBaseDir`

```json
{ "worktreeBaseDir": "/Users/matt/code/.worktrees/pi-subagents" }
```

Sets the native dedicated root directory for `worktree: true` runs. Relative paths resolve from the repository root, `~/...` expands to your home directory, and `PI_SUBAGENTS_WORKTREE_DIR` is used when config is unset. When native allocation is used and both are unset, the dedicated root defaults to `{dirname(repoRoot)}/worktrees`, a `worktrees` directory alongside the repository checkout.

Each native worktree leaf is `{dedicatedRoot}/{projectName}/pi-worktree-{runId}-{index}`, where `{projectName}` is the repository directory name (`basename(repoRoot)`), `{runId}` identifies the run, and `{index}` counts the children within the run. `worktreeBaseDir` and `PI_SUBAGENTS_WORKTREE_DIR` override only the dedicated root; the `{projectName}/pi-worktree-{runId}-{index}` nesting under it always applies for native allocation. Unsafe locations are rejected instead of created: setup fails when the dedicated root sits inside the repository checkout or the Pi extensions directory, or when a worktree would land directly inside the repository parent.

## `worktreeProvider`

```json
{ "worktreeProvider": "auto", "worktreeBranchPrefix": "pi-subagents/" }
```

Selects the managed worktree allocator: `auto` (the default) uses Worktrunk when its machine-readable interface is available and otherwise falls back to Pi's native Git worktrees; `native` always uses Pi's Git implementation; and `worktrunk` fails closed when Worktrunk is unavailable or incompatible. A configured `worktreeBaseDir` (or `PI_SUBAGENTS_WORKTREE_DIR`) selects native allocation and cannot be combined with explicit `worktrunk`.

`worktreeBranchPrefix` is normalized as a Git ref namespace and defaults to `pi-subagents/`. Branch names include readable task/lane identity plus run and fan-out indexes. Pi continues to own setup hooks, launch, handoff/diff evidence, resume, and cleanup; Worktrunk is used only to allocate and report the worktree path.

Set `worktree` to `true` to make managed worktree isolation the default for launches that omit the per-call `worktree` flag. A per-call value still takes precedence.

## `worktreeSetupHook`

```json
{
  "worktreeSetupHook": "./scripts/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 45000
}
```

The hook runs once per created worktree. Paths must be absolute, `~/...`, or repo-relative; bare command names are rejected.

Setup command waits are nonblocking and cancellable through existing run controls. Existing run deadlines and the hook timeout still apply; there is no new setup timeout or configuration.

Setup commands, including Git hooks, must be finite and await all descendants before reporting success; do not start background services. Exit zero, natural pipe closure, complete bounded output, and valid JSON/path metadata are trusted completion for launch and cleanup—not observed process-tree proof. Violations are unsupported: protection against deleting a worktree with an undisclosed live descendant is not guaranteed. No additional Windows containment guarantee is provided.

stdin is a JSON object with `repoRoot`, `worktreePath`, `agentCwd`, `branch`, `index`, `runId`, and `baseCommit`. stdout must be one JSON object, for example:

```json
{ "syntheticPaths": [".venv", ".env.local"] }
```

`syntheticPaths` must be relative to the worktree root. They are removed before diff capture so helper files do not pollute patches. Tracked files are never excluded; marking a tracked path as synthetic fails setup. Default timeout is `30000` ms.

## `missions`

```json
{
  "missions": {
    "enabled": true,
    "globalIndex": true,
    "retainTerminal": 200
  }
}
```

Automatic missions are enabled by default for ordinary launches with a task. Use per-launch `mission: false` for intentionally ephemeral work, or set `enabled: false` to disable automatic creation globally; explicit mission actions and `missionId`/`mission` launch fields still work.

- Mission records default to a project-keyed directory under pi's agent directory (`~/.pi/agent/missions/projects/<project-hash>/`). This keeps the project worktree clean.
- `directory` may be absolute, `~/...`, or project-relative. Set it to `.pi/subagents/missions` to opt in to project-scoped records.
- `retainTerminal` is a positive count (default `200`); pruning removes only the oldest completed, failed, or cancelled records and their pointers, never planned, active, waiting, needs-decision, or corrupt records.
- The user-global index contains pointers only; missing-record pointers self-heal when globally listed. Set `globalIndex: false` to disable writes or `globalIndexDir` to redirect it.

## `authorityPolicy`

```json
{
  "authorityPolicy": {
    "discardWorktree": "confirm",
    "destructiveCleanup": "confirm",
    "spawnBudgetGrant": "confirm",
    "scheduleCreate": "auto",
    "stopRun": "auto",
    "steerRun": "auto"
  }
}
```

Each fixed action resolves to `"auto"`, `"confirm"`, or `"forbid"`. This is intentionally a small action map, not a generic policy language. Confirm-required control actions fail closed without an interactive UI.

## `artifactDir`

```json
{ "artifactDir": "session" }
```

Controls where subagent artifact files (inputs, outputs, transcripts, metadata) are stored:

- `"project"`: writes to `<cwd>/.pi/subagents/artifacts/`.
- `"session"` (default): stores artifacts under pi's session directory (`~/.pi/agent/sessions/<session>/subagent-artifacts/`), keeping the working directory clean. It falls back to the OS temp directory when no session file exists.
- `"temp"`: uses the OS temp directory.

This preference also controls the default workflow artifact directory used by scripted chaining. `"project"` uses `<cwd>/.pi/subagents/chain-runs/`; the directory keeps its legacy name for compatibility. The default `"session"` and `"temp"` use the user-scoped temp workflow artifact directory.

The `"session"` option uses the same directory that `cleanupAllArtifactDirs` already scans for age-based cleanup, so artifacts are still cleaned up automatically. Temporary workflow artifact directories are cleaned up separately after 24 hours.

When a project-scoped launch runs from an npm package directory, pi-subagents warns if package settings can include `.pi/subagents/` in the published package. Add `.pi/subagents/` to `.npmignore` (or `.gitignore` when no `.npmignore` exists), use a `files` allowlist that does not include `.pi/subagents/`, or select `"session"` or `"temp"`.

## `completionBatch`

```json
{
  "completionBatch": {
    "enabled": true,
    "debounceMs": 150,
    "maxWaitMs": 1000,
    "stragglerDebounceMs": 75,
    "stragglerMaxWaitMs": 400,
    "stragglerWindowMs": 2000
  }
}
```

Controls smart batching of async-completion notifications. When several background subagents finish within a short window, their successful completions are held briefly and delivered as a single quiet grouped completion instead of separate completions.

- A hard `maxWaitMs` cap (measured from the first completion in a group) guarantees nothing is held indefinitely.
- Late-finishing siblings that arrive within `stragglerWindowMs` of a group emit join a shorter straggler group governed by `stragglerDebounceMs` and `stragglerMaxWaitMs`.
- Failed and paused completions bypass batching and fire immediately, flushing any held successes first, so failure and needs-attention signals are never delayed.
- Set `enabled` to `false` to restore the original one-notification-per-completion behavior. Changes apply on the next session start.

## `permissions`

Native child tool permission rules. See [watchdog.md](watchdog.md#native-child-tool-permissions).

## `PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS`

Caps the total time a single retried filesystem operation may sleep, in milliseconds. Environment-only; there is no config key.

Atomic status and result writes retry on `EACCES`, `EBUSY`, and `EPERM`, which on Windows are usually a scanner or a sibling process holding the destination of a rename for a moment. The retry ladder sleeps up to about 7.9s in total, and it sleeps *synchronously* — `Atomics.wait` parks the calling thread rather than spinning.

That is the right trade-off for a CLI. It is the wrong one for a long-lived process that loads `pi-subagents` in-process and runs those writers on its event loop: one contended rename stalls everything it serves for the length of the ladder, and because the thread is parked rather than busy, it presents as an unresponsive process sitting at 0% CPU. A wide fanout makes contention on a single `status.json` likely.

Set this to bound that stall. The ladder keeps its number of attempts and only the sleeps shrink, because `run-fanout-budget` and mission state locking use the ladder's length as their attempt budget:

```text
PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS=1000
```

Unset by default, so behaviour is unchanged unless you opt in. Opting in trades lock-wait tolerance for responsiveness: entries clamped to `0` return immediately, so contention that would previously have been waited out surfaces as an error sooner. Values that are not a non-negative integer fail instead of being coerced.
