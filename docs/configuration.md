# Configuration

`pi-subagents` reads optional JSON config from `~/.pi/agent/extensions/subagent/config.json`. This page lists every key, plus the environment variables and the settings-file keys that affect config resolution.

Settings-level keys (`subagents.defaultModel`, `defaultThinking`, `defaultExtensions`, `agentOverrides`, `modelScope`, `disableThinking`, `disableBuiltins`, watchdog settings) live in Pi settings files, not this config file. See [models.md](models.md), [agents.md](agents.md), and [watchdog.md](watchdog.md).

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

## `toolDescriptionMode`

```json
{ "toolDescriptionMode": "compact" }
```

Controls the parent-facing `subagent` tool description registered at startup. `full` is the default. `compact` keeps the execution modes, async/`subagent_wait` guidance, child-safety boundary, management/action split, one-writer review guidance, and artifact/status essentials with less prompt bloat.

`custom` reads `subagent-tool-description.md` from the project config directory, then from `~/.pi/agent/subagent-tool-description.md`. Missing, empty, unreadable, or oversized custom files fall back to the full description. Custom templates may use `{{fullDescription}}`, `{{compactDescription}}`, `{{safetyGuidance}}`, `{{agentDir}}`, and `{{projectConfigDir}}`; the safety guidance is always present so custom prose cannot remove the runtime guardrails. Restart Pi after changing the mode or custom file.

## `inlineToolDisplay`

```json
{ "inlineToolDisplay": "summary" }
```

Controls the `subagent` tool result shown inline in chat. The default, `"rich"`, shows live child activity and expands to detailed output. `"summary"` keeps the inline result at one stable row for running, completed, failed, stopped, and paused runs; it does not animate, show elapsed time, preview child output, or change when Pi's expand key is pressed. FleetView remains available for live progress and detailed inspection.

## `asyncByDefault`

```json
{ "asyncByDefault": false }
```

WorkflowScript calls use background execution when the request omits `async`. Set `asyncByDefault` to `false` to restore foreground-by-default behavior for tool launches that still use the internal single-run primitive. Callers can still force foreground with `async: false` unless `forceTopLevelAsync` is enabled.

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

## `asyncWidget`

```json
{ "asyncWidget": true }
```

Controls the under-editor widget for active background runs. It defaults to `true`, including when FleetView is enabled, so active work remains visible after reload. Set it to `false` to hide this widget while keeping FleetView available.

## `waitTool`

```json
{ "waitTool": { "enabled": false } }
```

Keeps the `subagent_wait` tool registered but makes direct calls return immediately instead of blocking on active subagent or provider work. The default is enabled. You can also set `"waitTool": false`; set `PI_SUBAGENT_WAIT_TOOL_ENABLED=false` (or `0`, `off`, `disabled`) to override config for one process. The effective value is passed explicitly to child runtimes. Headless `agent_end` auto-drain remains a lifecycle safeguard even when direct wait calls are disabled. Invalid config or environment values fail instead of being coerced.

Blocking `subagent_wait({ id: "..." })` keeps the current tool call open until that run changes. In a long-lived interactive parent session, `subagent_wait({ id: "...", nonBlocking: true })` instead resolves the prefix once, persists the exact run identity, returns a subscription token immediately, and wakes that session on completion, failure, attention, reconciliation failure, or timeout. Armed subscriptions appear in ordinary `subagent({ action: "status" })` output and are not counted as active child work.

This is different from `waitTool.enabled=false`, which returns immediately without registering any future wake. Provider items remain available only to blocking fleet-wide waits; non-blocking subscriptions require one async or remembered detached foreground run id.

## `forceTopLevelAsync`

```json
{ "forceTopLevelAsync": true }
```

Forces depth-0 internal single, parallel, and chain runs into background mode and bypasses launch UI by forcing `clarify: false`. Nested calls keep their own inherited settings.

## `globalConcurrencyLimit`

```json
{ "globalConcurrencyLimit": 20 }
```

Caps simultaneously running children inside existing durable legacy multi-child runs. New orchestration uses `workflowScript` and `runs.all`.

## `maxSubagentSpawnsPerSession`

```json
{ "maxSubagentSpawnsPerSession": 100 }
```

Optionally caps the total number of child subagent launches during one parent session, including completed and failed children, parallel task counts, static chain steps, and bounded dynamic fanout children. Sessions are unlimited by default. Set this value to `0` to disable a configured cap. `PI_SUBAGENT_MAX_SPAWNS_PER_SESSION` overrides the config for a process and follows the same positive-cap/zero-unlimited semantics.

`subagent({ action: "status" })`, fleet status, and `subagent({ action: "doctor" })` expose used, effective limit, remaining capacity, grants, and the remaining grant allowance. Static chains and parallel calls fail before creating run artifacts or starting partial work when their declared capacity cannot fit. Later retries or unbounded dynamic work are not guaranteed by that preflight.

A user may explicitly call `subagent({ action: "grant-spawn-budget", additional: 10 })` from the root interactive parent after all children settle and confirm the native prompt. Grants are additive: they never erase cumulative usage, are rejected for unlimited sessions and child/headless callers, and total granted capacity cannot exceed the original configured cap. Compaction remains part of the same logical parent session and does not reset usage or grants; starting a new parent session does.

## `scheduledRuns`

```json
{ "scheduledRuns": { "enabled": false, "maxPending": 20 } }
```

Durable schedules are enabled by default and stored per project under `.pi-subagents/schedules/<id>/`. See [missions.md](missions.md#schedules) for usage.

Set `storeRoot` to keep durable schedules outside project repositories. It must be an absolute path or a `~/` path, which expands from the user home directory. Each project is stored under a hash of its resolved working directory, so projects do not share schedules.

```json
{ "scheduledRuns": { "storeRoot": "~/.local/share/pi-subagents/schedules" } }
```

When `storeRoot` is omitted, schedules remain at `<cwd>/.pi-subagents/schedules`.

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

Controls nested delegation when no inherited `PI_SUBAGENT_MAX_DEPTH` is already in effect. Per-agent `maxSubagentDepth` can tighten the limit for that agent's child runs, but cannot relax an inherited stricter limit. This applies even to children that explicitly declare `tools: subagent`; at the cap, execution fanout is blocked instead of silently hiding nested work.

## `PI_SUBAGENT_PI_BINARY`

```bash
export PI_SUBAGENT_PI_BINARY=/path/to/pi-or-wrapper
```

Overrides the command used to launch child Pi processes. Package wrappers can set this to their own `pi`/agent binary so subagents inherit wrapper flags, environment setup, and bundled resources without relying on `PATH` ordering. Empty or whitespace-only values are ignored.

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

Controls whether subagents receive runtime intercom coordination instructions and whether `intercom` and `contact_supervisor` are auto-added to their tool allowlist when needed.

Fields:

- `mode`: default `always`; use `fork-only` to inject only for forked runs, or `off` to disable the bridge.
- `instructionFile`: optional Markdown template replacing the default bridge instructions. `{orchestratorTarget}` is interpolated. Relative paths resolve from `~/.pi/agent/extensions/subagent/`.
- `resultDelivery`: default `false`; set `true` only when an external listener consumes `subagent:result-intercom` and acknowledges the grouped completion payload. This is optional external result delivery, not native supervisor messaging. Enabled delivery waits for acknowledgement and reports acknowledgement failures. It does not change supervisor asks or progress updates.

Bridge activation requires a targetable current parent session id, which `pi-subagents` passes to children automatically. Native supervisor messaging does not require an external `pi-intercom` installation or per-agent extension allowlists: children use `contact_supervisor`, and parents use `subagent_supervisor` to inspect or reply. The external `intercom` tool is fallback plumbing when present.

The default injected guidance tells children to use `contact_supervisor` with `reason: "need_decision"` when blocked or needing a decision, `reason: "progress_update"` only for meaningful blocked/progress updates, generic `intercom` as fallback plumbing, and avoid routine completion handoffs.

## `worktreeBaseDir`

```json
{ "worktreeBaseDir": "/Users/matt/code/.worktrees/pi-subagents" }
```

Sets the base directory for `worktree: true` runs. Relative paths resolve from the repository root, `~/...` expands to your home directory, and `PI_SUBAGENTS_WORKTREE_DIR` is used when config is unset. The default remains the system temp directory.

## `worktreeSetupHook`

```json
{
  "worktreeSetupHook": "./scripts/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 45000
}
```

The hook runs once per created worktree. Paths must be absolute, `~/...`, or repo-relative; bare command names are rejected.

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
    "directory": ".pi-subagents/missions",
    "globalIndex": true,
    "retainTerminal": 200
  }
}
```

Automatic missions are enabled by default for ordinary launches with a task. Use per-launch `mission: false` for intentionally ephemeral work, or set `enabled: false` to disable automatic creation globally; explicit mission actions and `missionId`/`mission` launch fields still work.

- `directory` may be absolute, `~/...`, or project-relative.
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

- `"project"` (default): writes to `<cwd>/.pi-subagents/artifacts/`.
- `"session"`: stores artifacts under pi's session directory (`~/.pi/agent/sessions/<session>/subagent-artifacts/`), keeping the working directory clean.
- `"temp"`: uses the OS temp directory.

This preference also controls the default chain scratch directory. `"project"` uses `<cwd>/.pi-subagents/chain-runs/`, while `"session"` and `"temp"` use the user-scoped temp chain directory.

The `"session"` option uses the same directory that `cleanupAllArtifactDirs` already scans for age-based cleanup, so artifacts are still cleaned up automatically. Temporary chain directories are cleaned up separately after 24 hours.

When a project-scoped launch runs from an npm package directory, pi-subagents warns if package settings can include `.pi-subagents/` in the published package. Add `.pi-subagents/` to `.npmignore` (or `.gitignore` when no `.npmignore` exists), use a `files` allowlist that does not include `.pi-subagents/`, or select `"session"` or `"temp"`.

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
