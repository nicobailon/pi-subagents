# Changelog

## [Unreleased]

## [0.20.1] - 2026-04-27

### Fixed
- Made the packaged `/parallel-cleanup` prompt self-contained instead of referencing local-only cleanup skills.

## [0.20.0] - 2026-04-27

### Added
- Added a packaged `/parallel-cleanup` prompt for focused cleanup review passes.

### Changed
- Consolidated the `oracle-executor` role into `worker`: `worker` now uses `openai-codex/gpt-5.3-codex` with high thinking and stricter approved-direction guardrails, while `researcher` and `context-builder` now use medium thinking.
- Updated the bundled `scout` agent model/thinking defaults.
- Hard-cut over grouped intercom bridge result delivery: with the bridge active, parent-side `pi-subagents` emits one grouped `subagent:result-intercom` message per foreground parent run (single, top-level parallel, or chain) and one per completed async result file. Acknowledged foreground delivery returns a compact receipt instead of duplicating full output in the normal tool result; unacknowledged delivery preserves the normal full output. Grouped messages include child intercom targets and full child summaries.

### Fixed
- Fixed status and manager row rendering so multiline or tabbed content cannot overflow table rows.

### Removed
- Removed the bundled `oracle-executor` agent and `/oracle-executor` prompt template in favor of using `worker` for approved oracle handoffs.

## [0.19.3] - 2026-04-27

### Changed
- Updated the packaged `/parallel-review` prompt so reviewer angles are generated dynamically from the user's intent, plan, implemented code, and current diff, with the listed angles framed as examples rather than fixed defaults.

## [0.19.2] - 2026-04-27

### Added
- Added packaged prompt templates for common subagent workflows: `/parallel-research`, `/gather-context-and-clarify`, and `/oracle-executor`.

### Changed
- Tightened the packaged `/parallel-review` prompt so fresh-context reviewers get distinct angles and return evidence-backed findings.
- Refreshed the packaged `pi-subagents` skill with doctor diagnostics, saved-chain launches, prompt shortcuts, builtin overrides, intercom bridge guidance, fresh-context review defaults, and parallel task behavior.
- Reworked the README around plain-language usage, good first prompts, packaged prompt shortcuts, builtin agent guidance, intercom setup, model overrides, and optional reference material.

## [0.19.1] - 2026-04-26

### Added
- Added `subagent({ action: "doctor" })` and `/subagents-doctor` for read-only subagent environment diagnostics.
- Added `/run-chain` to launch saved `.chain.md` workflows directly from slash commands with completion, shared task input, and `--bg`/`--fork` support.

## [0.19.0] - 2026-04-26

### Added
- Added top-level parallel task support for per-task `output`, `reads`, and `progress`, including `/parallel` inline forwarding and async preservation.
- Added `/agents` launch toggles for forked context, background execution, and worktree-isolated parallel runs.
- Added a read-only detail view to `/subagents-status` for inspecting selected async runs, including recent events, output tails, and useful run paths.
- Added a packaged `/parallel-review` prompt template for launching fresh-context adversarial review subagents.

### Fixed
- Parallel and chain child runs now detach cleanly when a child uses intercom, preventing incoming handoff messages from aborting the parent foreground run.

## [0.18.1] - 2026-04-25

### Changed
- Restyled live subagent rendering, async widgets, and background completion notifications with compact Claude-style visual grammar while preserving existing observability paths.
- Parallel subagent result rendering now labels parallel workers as `Agent N` instead of `Step N`, while chain rendering keeps step terminology.

### Fixed
- `/run` and single-agent tool calls now allow self-contained agents to run without a task string.
- The `subagent` tool description no longer advertises hardcoded builtin agent names and management list output now separates disabled builtins from executable agents.
- Flexible `subagent` tool schema fields now include explicit JSON Schema types so llama.cpp and local OpenAI-compatible providers accept them.
- Settings package sources now resolve explicit `git:` and `npm:` entries from project and user package caches.
- Slash-command subagent results are now export-friendly, including completed output and child session paths in visible export content.

## [0.18.0] - 2026-04-23

### Added
- Added subagent control notifications so `needs_attention` signals push structured parent events, persist async control events to `events.jsonl`, show visible transcript notices for the user and parent agent, include proactive `nudge`/`status`/`interrupt` commands when a child appears blocked, and show each visible notice at most once per child run and attention state.
- Added stable child intercom session names for controlled subagents so needs-attention pings can tell the orchestrator which agent needs attention and how to message it when intercom is available.

### Changed
- Replaced the unreleased `starting`/`active`/`quiet`/`stalled`/`paused` activity labels with factual activity reporting and a single `needs_attention` control signal, keeping `paused` as lifecycle state only.
- Added `subagent({ action: "status", id })` and `subagent({ action: "status" })` as the control-surface status checks, replacing the separate `subagent_status(...)` tool.
- Adjusted bundled agent defaults: most builtins now use `openai-codex/gpt-5.5`, while `scout` uses `openai-codex/gpt-5.4-mini`.
- Removed the incomplete e2e suite and stale `@marcfargas/pi-test-harness` dev dependency; `test:all` now runs the maintained unit and integration suites.

### Fixed
- Paused async runs now render `Background task paused` notifications instead of failed/completed copy, including after extension reloads with stale legacy listeners still present.
- Async status output no longer shows stale activity-age lines for paused or completed runs.

## [0.17.5] - 2026-04-23

### Added
- Added subagent control activity state for foreground and async runs, including `starting`/`active`/`quiet`/`stalled`/`paused` tracking, compact stalled/recovered/paused control events, and an in-tool `action: "interrupt"` soft interrupt that pauses the current child turn without adding another top-level tool.

### Changed
- Updated bundled agents to use `openai-codex/gpt-5.5` defaults, with `scout` on `openai-codex/gpt-5.5-mini` and `oracle-executor` on `openai-codex/gpt-5.5:xhigh`.

### Fixed
- Async/background status token reporting now falls back to in-memory model-attempt usage when detached runs do not produce session `.jsonl` files, which also preserves token totals across model fallback retries.
- Non-Windows subagent launches now use plain `pi` again instead of reusing the current CLI script path, avoiding runs that get confused by installed `dist/cli.js` entrypoints.

## [0.17.4] - 2026-04-22

### Added
- Bundled a `pi-subagents` skill that teaches agents how to use builtin subagents, slash-command vs tool workflows, management-mode agent creation/editing, fork/intercom coordination, clarify mode, worktrees, async status inspection, and chain templating.

### Changed
- Tightened the builtin `oracle` prompt so intercom-enabled forked reviews now prefer concise conversational handoffs during the review and send a short final recommendation via `pi-intercom` before returning the full structured result.
- Tightened `oracle-executor` so it explicitly frames itself as the single writer thread and escalates gaps in the approved direction instead of silently patching around them.

## [0.17.3] - 2026-04-22

### Added
- Added builtin `oracle` and `oracle-executor` agents for the `main -> oracle -> main decision -> oracle-executor` workflow, plus README guidance for invoking the oracle pair with forked context.

### Fixed
- Migrated extension tool schemas from `@sinclair/typebox` to `typebox` 1.x so packaged installs follow Pi's current extension runtime contract.

### Changed
- Moved TypeBox from `peerDependencies` to a real `dependencies` entry so `pi install` production installs keep the schema package available at runtime.

## [0.17.2] - 2026-04-21

### Added
- Added `forceTopLevelAsync` so depth-0 delegated runs can be forced into background mode with `clarify: false`, while nested runs keep their existing behavior.

### Fixed
- Background completion notifications now render `(no output)` instead of a blank body when a completion summary is empty or whitespace-only.
- Async status and token reporting now rerender more reliably when cleanup state changes, read token usage from `message.usage`, and prefer the newest session file when multiple async session files exist.
- Async/background startup now fails fast for invalid resolved `cwd` values and spawn failures instead of reporting false launch success.
- Sync and async runner paths now drain stuck child processes in bounded time, covering both post-exit stdio holders and children that emit a final message but never exit.

## [0.17.1] - 2026-04-20

### Added
- Foreground subagent runs now make deeper live detail easier to discover. Running cards show an explicit `Ctrl+O` hint, lightweight live-state signals like recent activity, current-tool durations, and artifact output paths when available. Common array-heavy tool previews such as `web_search.queries` and `fetch_content.urls` are now summarized more clearly instead of collapsing into opaque fallback text.

### Changed
- Forked delegated runs now use stronger prompt-side guidance for `pi-intercom` coordination instead of runtime policing. The default fork preamble and intercom bridge instructions now explicitly treat inherited fork history as reference-only context, tell children not to continue the parent conversation in normal assistant text, and steer upstream questions or handoffs through `intercom` when needed.
- Documented an opt-in custom agent pattern for forked chat-back workflows so users can make that coordination contract explicit without changing builtin agents.
- Slash-run status text and `/subagents-status` summary output now use the same more explicit observability language, including clearer live-detail hints and surfaced output/session paths in the async status overlay.
- Builtin agent defaults now prefer `openai-codex` models for `planner`, `scout`, `researcher`, `context-builder`, and `worker`.

### Fixed
- Removed the short-lived foreground intercom enforcement/retry layer from delegated fork runs. Coordination behavior is now shaped by prompt and agent design only, avoiding hidden retries, heuristic output inspection, and failure paths based on guessed intent.

## [0.17.0] - 2026-04-16

### Added
- Builtin agents can now be disabled through `subagents.agentOverrides.<name>.disabled` or the bulk `subagents.disableBuiltins` setting, with `/agents` keeping disabled builtins visible so they can be re-enabled from the manager. This builds on PR `#81`. Thanks @danielcherubini.

### Fixed
- Builtin disable precedence is now coherent across user and project settings: project overrides beat user overrides, project bulk disable beats user re-enable attempts, and same-scope per-agent overrides can opt an agent out of bulk disable.
- `/agents` now blocks launching disabled builtins, shows their disabled state in list/detail views and management output, and avoids exposing the builtin-only `disabled` field when editing normal user/project agents.
- Multi-agent chain launches from `/agents` now collect a task before dispatching instead of emitting an empty task, and settings read failures now surface as read errors instead of being mislabeled as parse failures.

## [0.16.1] - 2026-04-16

### Changed
- Parallel subagent startup no longer applies any worker-start stagger in `mapConcurrent()`. `pi-subagents` now relies on Pi core's settings/auth lock retry behavior instead of carrying its own startup-delay workaround.

## [0.16.0] - 2026-04-16

### Added
- Top-level parallel `tasks` mode now supports a per-call `concurrency` override, matching the existing chain parallel-step concurrency control. This ships part of issue `#91`. Thanks @Gabrielgvl.

### Changed
- Top-level parallel defaults and limits can now be configured through `~/.pi/agent/extensions/subagent/config.json` under `parallel.maxTasks` and `parallel.concurrency`, while keeping the existing defaults of 8 tasks and concurrency 4 when unset. This completes issue `#91`. Thanks @Gabrielgvl.

### Fixed
- `context: "fork"` sync runs now create child sessions from a throwaway session-manager instance opened on the persisted parent session file, instead of mutating the live parent session manager. This keeps the parent session writing to its own file so the matching `toolResult(subagent)` no longer lands in a descendant session by accident. This fixes issue `#87`. Thanks @asmisha.
- Project agent and chain discovery now reads both `.agents/` and `.pi/agents/`, while preferring `.pi/agents/` when both locations define the same parsed name and keeping manager writes on the `.pi/agents/` path. This fixes issue `#88`. Thanks @desek.
- Ctrl+O expanded subagent results now actually show expanded content. Previously the `expanded` flag was received but ignored, so task text and tool-call args were identically truncated in both views. Now expanded mode shows the full task and longer (but still bounded) tool-call previews. Additionally, tool calls are no longer lost after foreground compaction: compact display summaries are preserved and shown in expanded view even after `messages` are stripped. This addresses issue `#90`. Thanks @asagajda.

## [0.15.0] - 2026-04-16

### Added
- Added `systemPromptMode` so subagents can replace Pi's base prompt with `--system-prompt` instead of always appending with `--append-system-prompt`, shipping the core of issue `#85` from @isvlasov.
- Added `inheritProjectContext` and `inheritSkills` so child runs can keep or strip inherited project instruction files (`AGENTS.md`, `CLAUDE.md`, etc.) and Pi's discovered skills block.

### Changed
- Builtin subagents now default to `systemPromptMode: replace`, with builtin `delegate` staying on `append`.
- Builtin agents now inherit project-level instruction files by default unless the user overrides them.
- Builtin agent prompts were rewritten for the new prompt-assembly model, and builtin `reviewer` / `context-builder` tool lists now match their documented behaviors. This rounds out the prompt-assembly work merged in PR `#92`, which closed issue `#85`. Thanks @isvlasov.

### Fixed
- Cross-platform tests now avoid machine-specific Pi install paths, align homedir-sensitive settings discovery on Windows CI, and use deterministic async config-write failure fixtures.
- Request-level `cwd` handling is now consistent across management and execution paths. `subagent` requests that target a worktree or nested checkout now resolve project agents, project settings, and builtin agent overrides from the requested `cwd` instead of accidentally inheriting the parent session's repo. This fixes issue `#83`. Thanks @hakin19 for the report.
- Relative child `cwd` values now resolve from the already-selected request/shared `cwd` across sync runs, async/background runs, chain steps, and top-level parallel tasks. This fixes cases where values like `packages/app` were interpreted from the wrong base directory, which could break skill lookup, output paths, and child process spawning.
- Worktree parallel-mode validation now compares task-level `cwd` overrides after relative-path resolution, so equivalent paths like `.` no longer trigger false conflict errors against the shared worktree base.
- Internal TypeScript source imports in the touched runtime paths now consistently use `.ts` local specifiers, matching the repo's direct TypeScript runtime loading conventions and reducing drift between adjacent modules.

## [0.14.1] - 2026-04-14

### Fixed
- Completed foreground subagent results now return compact payloads instead of inlining full raw message histories and per-result progress objects, preventing long tool-heavy sync runs from overwhelming the parent agent return path.
- Prompt-template delegation now rebuilds minimal assistant messages from compact foreground results when raw message arrays are intentionally omitted.
- UI/status wording now uses plain text labels instead of glyph-heavy markers across foreground rendering, parallel summaries, save-result receipts, installer output, agent manager views, clarify screens, and the corresponding README/CHANGELOG examples.
- Added a realistic foreground integration repro for issue `#80` and cleaned up the touched tests to remove the remaining blunt `as any` fixture casts.

## [0.14.0] - 2026-04-14

### Added
- Builtin agents can now be customized through settings-backed field overrides in `~/.pi/agent/settings.json` and `.pi/settings.json` under `subagents.agentOverrides`, with `/agents` exposing a create/edit override flow instead of forcing full-file copies for model/thinking/tool/prompt tweaks.

### Fixed
- Shared temp paths are now scoped under a user-specific temp root across async result storage, async run state, chain directories, artifact fallback storage, and detached async config files, avoiding cross-user collisions on shared machines while still handling arbitrary-UID/container environments where `os.userInfo()` can throw.
- Async/background runs now launch child `pi` processes in JSON mode, stream child events into `events.jsonl` with step metadata while the run is active, keep `output-<n>.log` live with human-readable child output, and document that `subagent-log-<id>.md` is a completion artifact.
- Bare model IDs now prefer the active parent-session provider when that provider actually exposes the model, across sync, chain, parallel, async, and clarify flows. Ambiguous bare IDs still fall back to conservative resolution.
- Skill resolution now includes local package roots declared in project/user `settings.json -> packages`, checks the effective task `cwd` before the runtime cwd, and still falls back to the runtime cwd when a nested task inherits package-provided skills from the repo root.

## [0.13.4] - 2026-04-13

### Fixed
- Intercom orchestration now uses a runtime-only `subagent-chat-<id>` fallback target for unnamed sessions instead of persisting a generic session title, so `pi --resume` keeps showing transcript snippets while delegated intercom routing still works.
- GitHub Actions test workflow now uses `actions/checkout@v5` and `actions/setup-node@v5`, removing Node 20 action-runtime deprecation warnings ahead of the enforced Node 24 transition.
- Worktree cwd mapping now derives repo-relative prefixes from `git rev-parse --show-prefix` instead of `path.relative(realpath, realpath)`, fixing Windows 8.3/canonical-path mismatches that could map `agentCwd` back to the source repo instead of the created worktree.
- Async background runs now pass the parent process `argv[1]` through to the detached runner, so Windows child spawning keeps targeting the intended `pi` CLI entry point instead of accidentally treating the runner's `jiti` bootstrap script as `pi`.
- Intercom detach listeners now guard optional event-bus subscriptions with optional-call semantics, so delegated runs no longer fail when host event buses expose `emit` without `on`.
- Skill discovery no longer depends on runtime imports from `@mariozechner/pi-coding-agent`; it now resolves skills directly from configured filesystem paths, preventing `ERR_MODULE_NOT_FOUND` crashes in local/integration test environments.

## [0.13.3] - 2026-04-13

### Added
- Added `intercomBridge.instructionFile` so subagent intercom guidance can be overridden from a Markdown template with `{orchestratorTarget}` interpolation.

### Fixed
- Intercom-enabled delegated runs now detach only after the child actually starts the `intercom` tool, preserving clean sync behavior until coordination is needed.
- Graceful intercom coordination no longer leaves detached child runs vulnerable to later parent abort listeners, and reply confirmation follow-ups avoid unnecessary orchestrator aborts.
- Child process spawn failures now preserve the original error message instead of collapsing to a generic failure.

## [0.13.2] - 2026-04-13

### Changed
- `intercomBridge` now defaults to `always` so intercom coordination instructions are injected for both `fresh` and `fork` delegated runs when `pi-intercom` is available.

## [0.13.1] - 2026-04-13

### Added
- Added optional intercom orchestration bridge for delegated runs. When enabled via `intercomBridge` (default `fork-only`) and `pi-intercom` is available, child subagents get runtime coordination instructions for contacting the orchestrator session via `intercom`, and `intercom` is auto-added to the child tool allowlist when needed.
- Added unit coverage for intercom bridge activation, config handling, and extension allowlist behavior.

### Changed
- Normalized `subagent-executor.ts` relative imports to `.ts` specifiers to match direct TypeScript runtime loading.
- Documented `pi-intercom` installation and activation requirements in README.

### Fixed
- Tightened intercom extension allowlist matching to avoid false positives from similarly named extension paths.

## [0.13.0] - 2026-04-11

### Added
- Added native agent `fallbackModels` support. Agents can now declare ordered backup models, and single, chain, parallel, and async/background runs retry on provider/model-style failures such as quota, auth, timeout, or provider/model unavailability.

### Fixed
- Fallback attempts now preserve observability across sync and async execution: results, artifact metadata, async status, and run logs record attempted models and per-attempt outcomes instead of only the final pass.
- Child subagent runs now pass model selections through `--model` instead of `--models`, so live execution pins the intended model correctly and end-to-end fallback behavior matches the validated test path.

## [0.12.5] - 2026-04-09

### Fixed
- Slash-command result cards now finalize through the extension's own snapshot timing instead of relying on core to treat hidden custom messages as in-place updates. The final slash snapshot and hidden persisted message are written before the last status-clear redraw, so live `/run`, `/chain`, and `/parallel` cards update to their final state more reliably.
- Added focused slash-command regression coverage for the success/error ordering around visible placeholder messages, hidden final messages, and the final status-clear redraw.

## [0.12.4] - 2026-04-04

### Added
- Added configurable subagent recursion depth controls with global `maxSubagentDepth` config and per-agent `maxSubagentDepth` frontmatter overrides. Child delegation now honors stricter inherited limits while still allowing per-agent tightening.
- Added optional worktree setup hooks via extension config (`worktreeSetupHook`, `worktreeSetupHookTimeoutMs`). Hooks run once per created worktree, receive JSON over stdin, return JSON on stdout, and can declare synthetic helper paths (e.g. `.venv`, copied local config files) to exclude from patch capture.

### Fixed
- Added support for loading agents and skills from `.agents/` and `~/.agents/` directories.
- Switched internal source imports from `.js` to `.ts` so the extension can be loaded directly from TypeScript sources under the strip-types/transform-types runtime path.
- Declared pi runtime packages and `@sinclair/typebox` as peer dependencies so direct source-loading environments fail less often from missing package resolution.
- Single-output runs now preserve agent-written file contents instead of overwriting them with the final assistant receipt, and artifacts/truncation now follow the authoritative saved file content.
- Async/background runs now reuse the current Node executable and prefer the resolved current pi CLI path on all platforms, avoiding PATH drift from wrapped or version-pinned parent launches.

### Changed
- Added release documentation for TypeScript direct-runtime loading support and related package requirements.

## [0.12.2] - 2026-04-04

### Changed
- Bumped pi package devDependencies to `^0.65.0` (`@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`) to stay aligned with current pi SDK/runtime.

## [0.12.1] - 2026-04-03

### Changed
- Updated session lifecycle handling for pi 0.65.0 by removing legacy post-transition resets and relying on `session_start` reinitialization, matching pi's removal of `session_switch` and `session_fork` extension events.

## [0.12.0] - 2026-03-31

### Added
- Added git worktree isolation for parallel execution via `worktree: true`. Applies to top-level parallel `tasks`, chain steps with `{ parallel: [...] }`, and async/background chain execution. Each parallel task gets its own temporary git worktree, and the aggregated output now includes per-task diff stats plus the directory path containing full patch files.
- Added `worktree.ts` to manage worktree lifecycle, diff capture, patch generation, and cleanup for isolated parallel runs.
- Added `count: N` shorthand for top-level parallel `tasks` and chain `parallel` entries so one authored task can expand into repeated identical runs without manual duplication.
- Added `subagent_status({ action: "list" })` to list active async runs with flattened step/member status summaries.
- Added `/subagents-status`, a read-only overlay for active async runs plus recent completed/failed runs with per-run step details. The overlay auto-refreshes while open and preserves the selected run when possible.
- Documented worktree isolation, async status surfaces, and the reorganized test layout in the README.

### Changed
- Consolidated tests under `test/unit`, `test/integration`, `test/e2e`, and `test/support`, replacing the old mixed root-level and `test/` layout. Test scripts now target those directories explicitly.
- Integration tests now use a tiny local file-based mock `pi` harness instead of relying on the external subprocess harness for normal subagent execution.
- Removed legacy extra session lifecycle resets and now rely on immutable-session `session_start` reinitialization, matching pi's removal of post-transition `session_switch`/`session_fork` events.

### Fixed
- Loader-based tests now resolve `.js` → `.ts` imports correctly when the repository path contains spaces or other URL-escaped characters. Added a focused regression test for the custom test loader.
- Worktree-isolated parallel runs now reject task-level `cwd` overrides that differ from the shared batch/step `cwd`, instead of silently ignoring them. Applies to foreground parallel runs, chain parallel steps, and async/background execution.
- Worktree diff capture now includes committed, modified, and newly created files without accidentally including the synthetic `node_modules` symlink used inside temporary worktrees.
- Worktree setup now cleans up already-created worktrees if a later worktree in the same batch fails to initialize.
- Prompt-template delegated parallel responses now preserve the aggregate worktree summary text instead of dropping it when rebuilding the final delegated output.
- Async status and result JSON files are now written atomically so readers do not observe partial JSON during background updates.
- `readStatus()` now returns `null` only for genuinely missing files and preserves real inspect/read/parse failures with context.
- Async status polling and result watching now log status/result/watcher failures instead of silently swallowing them, making background completion/debugging failures visible.
- Slash-command tests now match the current live snapshot contract instead of asserting the stale pre-finalized inline state.

## [0.11.12] - 2026-03-28

### Changed
- Tool history (`recentTools`) in execution progress is now chronological (oldest first) and uncapped, replacing the old newest-first order with a 5-entry cap. Affects all execution paths (tool, slash commands, chains, parallel, async, delegation). Both single-task and chain-step render paths in `render.ts` now consistently use `slice(-3)` for most-recent display.
- Removed 50ms throttle on execution progress updates. `onUpdate` now fires immediately on every tool start, tool end, message end, and tool result. Affects all execution paths.
- Delegation bridge now passes through full `recentOutputLines` arrays, `recentTools` history, and resolved `model` to prompt-template consumers, replacing the old stripped-down single-line updates.

## [0.11.11] - 2026-03-23

### Changed
- Updated for pi 0.62.0 compatibility. `Skill.source` replaced with `Skill.sourceInfo` for skill provenance, `Widget` type replaced with `Component`. Bumped devDependencies to `^0.62.0`.

## [0.11.10] - 2026-03-21

### Changed
- Trimmed tool schema and description to reduce per-turn token cost by ~166 tokens (13%). Removed `maxOutput` from the LLM-facing schema (still accepted internally), shortened `context` and `output` descriptions, removed redundant CHAIN DATA FLOW section from tool description, condensed MANAGEMENT bullet points.

## [0.11.9] - 2026-03-21

### Fixed
- `/agents` overlay launches (single, chain, parallel) and slash commands (`/run`, `/chain`, `/parallel`) now render an inline result card in chat instead of relaying through `sendUserMessage`.
- `/agents` overlay chain launches no longer bypass the executor for async fallback, fixing a path where async chain errors were silently swallowed.

### Changed
- All slash and overlay subagent execution now routes through an event bus request/response protocol (`slash-bridge.ts`), matching the pattern used by pi-prompt-template-model. This replaces both the old `sendUserMessage` relay and the direct `executeChain` call in the overlay handler.
- Slash launches show a live inline card immediately on start that streams current tool, recent tools, and output in real time, rather than appearing only after completion.
- `/parallel` now uses the native `tasks` parameter directly instead of wrapping through `{ chain: [{ parallel: tasks }] }`.

### Added
- `slash-bridge.ts` — event bus bridge for slash command execution. Manages AbortController lifecycle, cancel-before-start races, and progress streaming via `subagent:slash:*` events.
- `slash-live-state.ts` — request-id keyed snapshot store that drives live inline card rendering during execution and restores finalized results from session entries on reload.
- Clarified README Usage section to distinguish LLM tool parameters from user-facing slash commands.

## [0.11.8] - 2026-03-21

### Added
- Prompt-template delegation bridge now supports parallel task execution: accepts `tasks` array payloads, emits per-task `parallelResults` with individual error/success states, and streams per-task progress updates with `taskProgress` entries.

## [0.11.7] - 2026-03-20

### Changed
- Removed the cwd mismatch guard from the prompt-template delegation bridge, allowing delegated requests to specify a working directory different from the active session's cwd.

## [0.11.6] - 2026-03-20

### Added
- Added `delegate` builtin agent — a lightweight subagent with no model, output, or default reads. Inherits the parent session's model, making it the natural target for prompt-template delegated execution.

## [0.11.5] - 2026-03-20

### Added
- Added fork context preamble: tasks run with `context: "fork"` are now wrapped with a default preamble that anchors the subagent to its task, preventing it from continuing the parent conversation. The default is `DEFAULT_FORK_PREAMBLE` in `types.ts`. Internal/programmatic callers can use `wrapForkTask(task, false)` to disable it or pass a custom string (this is not exposed as a tool parameter).
- Added a prompt-template delegation bridge (`prompt-template-bridge.ts`) on the shared extension event bus. The subagent extension now listens for `prompt-template:subagent:request` and emits correlated `started`/`response`/`update` events, with cwd safety checks and race-safe cancellation handling.
- Added delegated progress streaming via `prompt-template:subagent:update`, mapped from subagent executor `onUpdate` progress payloads.

### Changed
- Session lifecycle reset now preserves the latest extension context for event-bus delegated runs.
- `[fork]` badge is now shown only on the result row, not duplicated on both the tool-call and result rows.

## [0.11.4] - 2026-03-19

### Added
- Added explicit execution context mode for tool calls: `context: "fresh" | "fork"` (default: `fresh`).
- Added true forked-context execution for single, parallel, and chain runs. In `fork` mode each child run now starts from a real branched session file created from the parent session's current leaf.
- Added `--fork` slash-command flag for `/run`, `/chain`, and `/parallel` to forward `context: "fork"`.
- Added regression coverage for fork execution/session wiring and fork badge rendering, including slash command forwarding tests.

### Changed
- Session argument wiring now supports `--session <file>` in addition to `--session-dir`, enabling exact leaf-preserving forks without summary injection.
- Async runner step payloads now carry per-step session files so background single/chain/parallel executions can also honor `context: "fork"`.
- Clarified docs for foreground vs background semantics so `--bg` behavior is explicit.

### Fixed
- `context: "fork"` now fails fast with explicit errors when parent session state is unavailable (missing persisted session, missing current leaf, or failed branch extraction), with no silent fallback to `fresh`.
- Fork-session creation errors are now surfaced as tool errors instead of bubbling as uncaught exceptions during execution.
- Session directory preparation now fails loudly with actionable errors (instead of silently swallowing mkdir failures).
- Async launch now fails with explicit errors when the async run directory cannot be created.
- Share logs now correctly include forked session files even when no session directory exists.
- Tool-call and result rendering now explicitly show `[fork]` when `context: "fork"` is used, including empty-result responses.
- `subagent_status` now surfaces async result-file read failures instead of returning a misleading missing-status message.

## [0.11.3] - 2026-03-17

### Changed
- Decomposed `index.ts` (1,450 → ~350 lines) into focused modules: `subagent-executor.ts`, `async-job-tracker.ts`, `result-watcher.ts`, `slash-commands.ts`. Shared mutable state centralized in `SubagentState` interface. Three identical session handlers collapsed into one.
- Extracted shared pi CLI arg-builder (`pi-args.ts`) from duplicated logic in `execution.ts` and `subagent-runner.ts`.
- Consolidated `mapConcurrent` (canonical in `parallel-utils.ts`, re-exported from `utils.ts`), `aggregateParallelOutputs` (canonical in `parallel-utils.ts` with optional header formatter, re-exported from `settings.ts`), and `parseFrontmatter` (extracted to `frontmatter.ts`).

## [0.11.2] - 2026-03-11

### Fixed
- `--no-skills` was missing from the async runner (`subagent-runner.ts`). PR #41 added skill scoping to the sync path but the async runner spawns pi through its own code path, so background subagents with explicit skills still got the full `<available_skills>` catalog injected.
- `defaultSessionDir` and `sessionDir` with `~` paths (e.g. `"~/.pi/agent/sessions/subagent/"`) were not expanded — `path.resolve("~/...")` treats `~` as a literal directory name. Added tilde expansion matching the existing pattern in `skills.ts`.
- Multiple subagent calls within a session would collide when `defaultSessionDir` was configured, since it wasn't appending a unique `runId`. Both `defaultSessionDir` and parent-session-derived paths now get `runId` appended.

### Removed
- Removed exported `resolveSessionRoot()` function and `SessionRootInput` interface. These were introduced by PR #46 but never called in production — the inline resolution logic diverged (always-on sessions, `runId` appended) making the function's contract misleading. Associated tests and dead code from PR #47 scaffolding also removed from `path-handling.test.ts`.

## [0.11.1] - 2026-03-08

### Changed
- **Session persistence**: Subagent sessions are now stored alongside the parent session file instead of in `/tmp`. If the parent session is `~/.pi/agent/sessions/abc123.jsonl`, subagent sessions go to `~/.pi/agent/sessions/abc123/{runId}/run-{N}/`. This enables tracking subagent performance over time, analyzing token usage patterns, and debugging past delegations. Falls back to a unique temp directory when no parent session exists (API/headless mode).

## [0.11.0] - 2026-02-23

### Added
- **Background mode toggle in clarify TUI**: Press `b` to toggle background/async execution for any mode (single, parallel, chain). Shows `[b]g:ON` in footer when enabled. Previously async execution required programmatic `clarify: false, async: true` — now users can interactively choose background mode after previewing/editing parameters.
- **`--bg` flag for slash commands**: `/run scout "task" --bg`, `/chain scout "task" -> planner --bg`, `/parallel scout "a" -> scout "b" --bg` now run in background without needing the TUI.

### Fixed
- Task edits in clarify TUI were lost when launching in background mode if no other behavior (model, output, reads) was modified. The async handoff now always applies the edited template.

## [0.10.0] - 2026-02-23

### Added
- **Async parallel chain support**: Chains with `{ parallel: [...] }` steps now work in async mode. Previously they were rejected with "Async mode doesn't support chains with parallel steps." The async runner now spawns concurrent pi processes for parallel step groups with configurable `concurrency` and `failFast` options. Inspired by PR #31 from @marcfargas.
- **Comprehensive test suite**: 85 integration tests and 12 E2E tests covering all execution modes (single, parallel, chain, async), error handling, template resolution, and tool validation. Uses `@marcfargas/pi-test-harness` for subprocess mocking and in-process session testing. Thanks @marcfargas for PR #32.
- GitHub Actions CI workflow running tests on both Ubuntu and Windows with Node.js 24.

### Changed
- **BREAKING:** `share` parameter now defaults to `false`. Previously, sessions were silently uploaded to GitHub Gists without user consent. Users who want session sharing must now explicitly pass `share: true`. Added documentation explaining what the feature does and its privacy implications.

### Fixed
- `mapConcurrent` with `limit=0` returned array of undefined values instead of processing items sequentially. Now clamps limit to at least 1.
- ANSI background color bleed in truncated text. The `truncLine` function now properly tracks and re-applies all active ANSI styles (bold, colors, etc.) before the ellipsis, preventing style leakage. Also uses `Intl.Segmenter` for correct Unicode/emoji handling. Thanks @monotykamary for identifying the issue.
- `detectSubagentError` no longer produces false positives when the agent recovers from tool errors. Previously, any error in the last tool result would override exitCode 0→1, even if the agent had already produced complete output. Now only errors AFTER the agent's final text response are flagged. Thanks @marcfargas for the fix and comprehensive test coverage.
- Parallel mode (`tasks: [...]`) now returns aggregated output from all tasks instead of just a success count. Previously only returned "3/3 succeeded" with actual task outputs lost.
- Session sharing fallback no longer fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The fallback now resolves the main entry point and walks up to find the package root instead of trying to resolve `package.json` directly.
- Skills from globally-installed npm packages (via `pi install npm:...`) are now discoverable by subagents. Previously only scanned local `.pi/npm/node_modules/` paths, missing the global npm root where pi actually installs packages.
- **Windows compatibility**: Fixed `ENAMETOOLONG` errors when tasks exceed command-line length limits by writing long tasks to temp files using pi's `@file` syntax. Thanks @marcfargas.
- **Windows compatibility**: Suppressed flashing console windows when spawning async runner processes (`windowsHide: true`).
- **Windows compatibility**: Fixed pi CLI resolution in async runner by passing `piPackageRoot` through to `getPiSpawnCommand`.
- **Cross-platform paths**: Replaced `startsWith("/")` checks with `path.isAbsolute()` for correct Windows absolute path detection. Replaced template string path concatenation with `path.join()` for consistent path separators.
- **Resilience**: Added error handling and auto-restart for the results directory watcher. Previously, if the directory was deleted or became inaccessible, the watcher would die silently.
- **Resilience**: Added `ensureAccessibleDir` helper that verifies directory accessibility after creation and attempts recovery if the directory has broken ACLs (can happen on Windows with Azure AD/Entra ID after wake-from-sleep).

## [0.9.2] - 2026-02-19

### Fixed
- TUI crash on async subagent completion: "Rendered line exceeds terminal width." `render.ts` never truncated output to fit the terminal — widget lines (`agents.join(" -> ")`), chain visualizations, skills lists, and task previews could all exceed the terminal width. Added `truncLine` helper using pi-tui's `truncateToWidth`/`visibleWidth` and applied it to every `Text` widget and widget string. Task preview lengths are now dynamic based on terminal width instead of hardcoded.
- Agent Manager scope badge showed `[built]` instead of `[builtin]` in list and detail views. Widened scope column to fit.

## [0.9.1] - 2026-02-17

### Fixed
- Builtin agents were silently excluded from management listings, chain validation, and agent resolution. Added `allAgents()` helper that includes all three tiers (builtin, user, project) and applied it to `handleList`, `findAgents`, `availableNames`, and `unknownChainAgents`.
- `resolveTarget` now blocks mutation of builtin agents with a clear error message suggesting the user create a same-named override, instead of allowing `fs.unlinkSync` or `fs.writeFileSync` on extension files.
- Agent Manager TUI guards: delete and edit actions on builtin agents are blocked with an error status. Detail screen hides `[e]dit` from the footer for builtins. Scope badge shows `[builtin]` instead of falling through to `[proj]`.
- Cloning a builtin agent set the scope to `"builtin"` at runtime (violating the `"user" | "project"` type), causing wrong badge display and the clone inheriting builtin protections until session reload. Now maps to `"user"`.
- Agent Manager `loadEntries` suppresses builtins overridden by user/project agents, preventing duplicate entries in the TUI list.
- `BUILTIN_AGENTS_DIR` resolved via `import.meta.url` instead of hardcoded `~/.pi/agent/extensions/subagent/agents` path. Works regardless of where the extension is installed.
- `handleCreate` now warns when creating an agent that shadows a builtin (informational, not an error).

### Changed
- Simplified Agent Manager header from per-scope breakdown to total count (per-row badges already show scope).
- Reviewer builtin model changed from `openai/gpt-5.2` to `openai-codex/gpt-5.3-codex`.
- Removed `code-reviewer` builtin agent (redundant with `reviewer`).

## [0.9.0] - 2026-02-17

### Added
- **Builtin agents** — the extension now ships with a default set of agent definitions in `agents/`. These are loaded with lowest priority so user and project agents always override them. New users get a useful set of agents out of the box without manual setup.
  - `scout` — fast codebase recon (claude-haiku-4-5)
  - `planner` — implementation plans from context (claude-opus-4-6, thinking: high)
  - `worker` — general-purpose execution (claude-sonnet-4-6)
  - `reviewer` — validates implementation against plans (gpt-5.3-codex, thinking: high)
  - `context-builder` — analyzes requirements and codebase (claude-sonnet-4-6)
  - `researcher` — autonomous web research with search, evaluation, and synthesis (claude-sonnet-4-6)
- **`"builtin"` agent source** — new third tier in agent discovery. Priority: builtin < user < project. Builtin agents appear in listings with a `[builtin]` badge and cannot be modified or deleted through management actions (create a same-named user agent to override instead).

### Fixed
- Async subagent session sharing no longer fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The runner tried `require.resolve("@mariozechner/pi-coding-agent/package.json")` to find pi's HTML export module, but pi's `exports` map doesn't include that subpath. The fix resolves the package root in the main pi process by walking up from `process.argv[1]` and passes it to the spawned runner through the config, bypassing `require.resolve` entirely. The Windows CLI resolution fallback in `getPiSpawnCommand` benefits from the same walk-up function.

## [0.8.5] - 2026-02-16

### Fixed
- Async subagent execution no longer fails with "jiti not found" on machines without a global `jiti` install. The jiti resolution now tries three strategies: vanilla `jiti`, the `@mariozechner/jiti` fork, and finally resolves `@mariozechner/jiti` from pi's own installation via `process.argv[1]`. Since pi always ships the fork as a dependency, async mode now works out of the box.
- Improved the "jiti not found" error message to explain what's needed and how to fix it.

## [0.8.4] - 2026-02-13

### Fixed
- JSONL artifact files no longer written by default — they duplicated pi's own session files and were the sole cause of `subagent-artifacts` directories growing to 10+ GB. Changed `includeJsonl` default from `true` to `false`. `_output.md` and `_meta.json` still capture the useful data.
- Artifact cleanup now covers session-based directories, not just the temp dir. Previously `cleanupOldArtifacts` only ran on `os.tmpdir()/pi-subagent-artifacts` at startup, while sync runs (the common path) wrote to `<session-dir>/subagent-artifacts/` which was never cleaned. Now scans all `~/.pi/agent/sessions/*/subagent-artifacts/` dirs on startup and cleans the current session's artifacts dir on session lifecycle events.
- JSONL writer now enforces a 50 MB size cap (`maxBytes` on `JsonlWriterDeps`) as defense-in-depth for users who opt into JSONL. Silently stops writing at the cap without pausing the source stream, so the progress tracker keeps working.

## [0.8.3] - 2026-02-11

### Added
- Agent `extensions` frontmatter support for extension sandboxing: absent field keeps default extension discovery, empty value disables all extensions, and comma-separated values create an explicit extension allowlist.

### Fixed
- Parallel chain aggregation now surfaces step failures and warnings in `{previous}` instead of silently passing empty output.
- Empty-output warnings are now context-aware: runs that intentionally write to explicit output paths are not flagged as warning-only successes in the renderer.
- Async execution now respects agent `extensions` sandbox settings, matching sync behavior.
- Single-mode `output` now resolves explicit paths correctly: absolute paths are used directly, and relative paths resolve against `cwd`.
- Single-mode output persistence is now caller-side in both sync and async execution, so output files are still written when agents run with read-only tools.
- Pi process spawning now uses a shared cross-platform helper in sync and async paths; on Windows it prefers direct Node + CLI invocation to avoid `ENOENT` and argument fragmentation.
- Sync JSONL artifact capture now streams lines directly to disk with backpressure handling, preventing unbounded memory growth in long or parallel runs.
- Execution now defaults `agentScope` to `both`, aligning run behavior with management `list` so project agents shown in discovery execute without explicit scope overrides.
- Async completion notifications now dedupe at source and notify layers, eliminating duplicate/triple "Background task completed" messages.
- Async notifications now standardize on canonical `subagent:started` and `subagent:complete` events (legacy enhanced event emissions removed).

### Changed
- Reworked `skills.ts` to resolve skills through Pi core skill loading with explicit project-first precedence and support for project/user package and settings skill paths.
- Skill discovery now normalizes and prioritizes collisions by source so project-scoped skills consistently win over user-scoped skills.
- Documentation now references `<tmpdir>` instead of hardcoded `/tmp` paths for cross-platform clarity.

## [0.8.2] - 2026-02-11

### Added
- Recursion depth guard (`PI_SUBAGENT_MAX_DEPTH`) to prevent runaway nested subagent spawning. Default max depth is 2 (main -> subagent -> sub-subagent). Deeper calls are blocked with guidance to the calling agent.

## [0.8.1] - 2026-02-10

### Added
- **`chainDir` param** for persistent chain artifacts — specify a directory to keep artifacts beyond the default 24-hour temp-directory cleanup. Relative paths are resolved to absolute via `path.resolve()` for safe use in `{chain_dir}` template substitutions.

## [0.8.0] - 2026-02-09

### Added
- **Management mode for `subagent` tool** via `action` field — the LLM can now discover, create, modify, and delete agent/chain definitions at runtime without manual file editing or restarts. Five actions:
  - `list` — discover agents and chains with scope + description
  - `get` — full detail for agent or chain, including path and system prompt/steps
  - `create` — create agent (`.md`) or chain (`.chain.md`) definitions from `config`; immediately usable
  - `update` — merge-update agent or chain fields, including rename with chain reference warnings
  - `delete` — remove agent or chain definitions with dangling reference warnings
- **New `agent-management.ts` module** with all management handlers, validation, and serialization helpers
- **New management params** in tool schema: `action`, `chainName`, `config`
- **Agent/chain CRUD safeguards**
  - Name sanitization (lowercase-hyphenated) for create/rename
  - Scope-aware uniqueness checks across agents and chains
  - File-path collision checks to prevent overwriting non-agent markdown files
  - Scope disambiguation for update/delete when names exist in both user and project scope
  - Not-found errors include available names for fast self-correction
  - Per-step validation warnings for model registry and skill availability
  - Validate-then-mutate ordering — all validation completes before any filesystem mutations
- **Config field mapping**: `tools` (comma-separated with `mcp:` prefix support), `reads` -> `defaultReads`, `progress` -> `defaultProgress`
- **Uniform field clearing** — all optional string fields accept both `false` and `""` to clear
- **JSON string parsing for `config` param** — handles `Type.Any()` delivering objects as JSON strings through the tool framework

## [0.7.0] - 2026-02-09

### Added
- **Agents Manager overlay** — browse, view, edit, create, and delete agent definitions from a TUI opened via `Ctrl+Shift+A` or the `/agents` command
  - List screen with search/filter, scope badges (user/project), chain badges
  - Detail screen showing resolved prompt, recent runs, all frontmatter fields
  - Edit screen with field-by-field editing, model picker, skill picker, thinking picker, full-screen prompt editor
  - Create from templates (Blank, Scout, Planner, Implementer, Code Reviewer, Blank Chain)
  - Delete with confirmation
  - Launch directly from overlay with task input and skip-clarify toggle (`Tab`)
- **Chain files** — `.chain.md` files define reusable multi-step chains with YAML-style frontmatter per step, stored alongside agent `.md` files
  - Chain serializer with round-trip parse/serialize fidelity
  - Three-state config semantics: `undefined` (inherit), value (override), `false` (disable)
  - Chain detail screen with flow visualization and dependency map
  - Chain edit screen (raw file editing)
  - Create new chains from the template picker or save from the chain-clarify TUI (`W`)
- **Save overrides from clarify TUI** — press `S` to persist model/output/reads/skills/progress overrides back to the agent's frontmatter file, or `W` (chain mode) to save the full chain configuration as a `.chain.md` file
- **Multi-select and parallel from overlay** — select agents with `Tab`, then `Ctrl+R` for sequential chain or `Ctrl+P` to open the parallel builder
  - Parallel builder: add same agent multiple times, set per-slot task overrides, shared task input
  - Progressive footer: 0 selected (default hints), 1 selected (`[ctrl+r] run [ctrl+p] parallel`), 2+ selected (`[ctrl+r] chain [ctrl+p] parallel`)
  - Selection count indicator in footer
- **Slash commands with per-step tasks** — `/run`, `/chain`, and `/parallel` execute subagents with full live progress rendering and tab-completion. Results are sent to the conversation for the LLM to discuss.
  - Per-step tasks with quotes: `/chain scout "scan code" -> planner "analyze auth"`
  - Per-step tasks for parallel: `/parallel scanner "find bugs" -> reviewer "check style"`
  - `--` delimiter also supported: `/chain scout -- scan code -> planner -- analyze auth`
  - Shared task (no `->`): `/chain scout planner -- shared task`
  - Tab completion for agent names, aware of task sections (quotes and `--`)
  - Inline per-step config: `/chain scout[output=ctx.md] "scan code" -> planner[reads=ctx.md] "analyze auth"`
  - Supported keys: `output`, `reads` (`+` separates files), `model`, `skills`, `progress`
  - Works on all three commands: `/run agent[key=val]`, `/chain`, `/parallel`
- **Run history** — per-agent JSONL recording of task, exit code, duration, timestamp
  - Recent runs shown on agent detail screen (last 5)
  - Lazy JSONL rotation (keeps last 1000 entries)
- **Thinking level as first-class agent field** — `thinking` frontmatter field (off, minimal, low, medium, high, xhigh) editable in the Agents Manager
  - Picker with arrow key navigation and level descriptions
  - At runtime, appended as `:level` suffix to the model string
  - Existing suffix detection prevents double-application
  - Displayed on agent detail screen

### Fixed
- **Parallel live progress** — top-level parallel execution (`tasks: [...]`) now shows live progress for all concurrent tasks. Each task's `onUpdate` updates its slot in a shared array and emits a merged view, so the renderer can display per-task status, current tools, recent output, and timing in real time. Previously only showed results after all tasks completed.
- **Slash commands frozen with no progress** — `/run`, `/chain`, and `/parallel` called `runSync`/`executeChain` directly, bypassing the tool framework. No `onUpdate` meant zero live progress, and `await`-ing execution blocked the command handler, making inputs unresponsive. Now all three route through `sendToolCall` → LLM → tool handler, getting full live progress rendering and responsive input for free.
- **`/run` model override silently dropped** — `/run scout[model=gpt-4o] task` now correctly passes the model through to the tool handler. Added `model` field to the tool schema for single-agent runs.
- **Quoted tasks with `--` inside split incorrectly** — the segment parser now checks for quoted strings before the `--` delimiter, so tasks like `scout "analyze login -- flow"` parse correctly instead of splitting on the embedded ` -- `.
- **Chain first-step validation in per-step mode** — `/chain scout -> planner "task"` now correctly errors instead of silently assigning planner's task to scout. The first step must have its own task when using `->` syntax.
- **Thinking level ignored in async mode** — `async-execution.ts` now applies thinking suffix to the model string before serializing to the runner, matching sync behavior
- **Step-level model override ignored in async mode** — `executeAsyncChain` now uses `step.model ?? agent.model` as the base for thinking suffix, matching the sync path in `chain-execution.ts`
- **mcpDirectTools not set in async mode** — `subagent-runner.ts` now sets `MCP_DIRECT_TOOLS` env var per step, matching the sync path in `execution.ts`
- **`{task}` double-corruption in saved chain launches** — stopped pre-replacing `{task}` in the overlay launch path; raw user task passed as top-level param to `executeChain()`, which uses `params.task` for `originalTask`
- **Agent serializer `skill` normalization** — `normalizedField` now maps `"skill"` to `"skills"` on the write path
- **Clarify toggle determinism** — all four ManagerResult paths (single, chain, saved chain, parallel) now use deterministic JSON with `clarify: !result.skipClarify`, eliminating silent breakage from natural language variants

### Changed
- Agents Manager single-agent and saved-chain launches default to quick run (skip clarify TUI) — the user already reviewed config in the overlay. Multi-agent ad-hoc chains default to showing the clarify TUI so users can configure per-step tasks, models, output files, and skills before execution. Toggle with `Tab` in the task-input screen.
- Extracted `applyThinkingSuffix(model, thinking)` helper from inline logic in `execution.ts`, shared with `async-execution.ts`
- Text editor: added word navigation (Alt+Left/Right, Ctrl+Left/Right), word delete (Alt+Backspace), paste support
- Agent discovery (`agents.ts`): loads `.chain.md` files via `loadChainsFromDir`, exposes `discoverAgentsAll` for overlay

## [0.6.0] - 2026-02-02

### Added
- **MCP direct tools for subagents** - Agents can request specific MCP tools as first-class tools via `mcp:` prefix in frontmatter: `tools: read, bash, mcp:chrome-devtools` or `tools: read, bash, mcp:github/search_repositories`. Requires pi-mcp-adapter.
- **`MCP_DIRECT_TOOLS` env var** - Subagent processes receive their direct tool config via environment variable. Agents without `mcp:` items get a `__none__` sentinel to prevent config leaking from the parent process.

## [0.5.3] - 2026-02-01

### Fixed
- Adapt execute signatures to pi v0.51.0: reorder signal, onUpdate, ctx parameters for subagent tool; add missing parameters to subagent_status tool

## [0.5.2] - 2026-01-28

### Improved
- **README: Added agent file locations** - New "Agents" section near top of README clearly documents:
  - User agents: `~/.pi/agent/agents/{name}.md`
  - Project agents: `.pi/agents/{name}.md` (searches up directory tree)
  - `agentScope` parameter explanation (`"user"`, `"project"`, `"both"`)
  - Complete frontmatter example with all fields
  - Note about system prompt being the markdown body after frontmatter

## [0.5.1] - 2026-01-27

### Fixed
- Google API compatibility: Use `Type.Any()` for mixed-type unions (`SkillOverride`, `output`, `reads`, `ChainItem`) to avoid unsupported `anyOf`/`const` JSON Schema patterns

## [0.5.0] - 2026-01-27

### Added
- **Skill support** - Agents can declare skills in frontmatter that get injected into system prompts
  - Agent frontmatter: `skill: tmux, chrome-devtools` (comma-separated)
  - Runtime override: `skill: "name"` or `skill: false` to disable all skills
  - Chain-level skills additive to agent skills, step-level override supported
  - Skills injected as XML: `<skill name="...">content</skill>` after agent system prompt
  - Missing skills warn but continue execution (warning shown in result summary)
- **TUI skill selector** - Press `[s]` to browse and select skills for any step
  - Multi-select with space bar
  - Fuzzy search by name or description
  - Shows skill source (project/user) and description
  - Project skills (`.pi/skills/`) override user skills (`~/.pi/agent/skills/`)
- **Skill display** - Skills shown in TUI, progress tracking, summary, artifacts, and async status
- **Parallel task skills** - Each parallel task can specify its own skills via `skill` parameter

### Fixed
- **Chain summary formatting** - Fixed extra blank line when no skills are present
- **Duplicate skill deduplication** - `skill: "foo,foo"` now correctly deduplicates to `["foo"]`
- **Consistent skill tracking in async mode** - Both chain and single modes now track only resolved skills

## [0.4.1] - 2026-01-26

### Changed
- Added `pi-package` keyword for npm discoverability (pi v0.50.0 package system)

## [0.4.0] - 2026-01-25

### Added
- **Clarify TUI for single and parallel modes** - Use `clarify: true` to preview/edit before execution
  - Single mode: Edit task, model, thinking level, output file
  - Parallel mode: Edit each task independently, model, thinking level
  - Navigate between parallel tasks with ↑↓
- **Mode-aware TUI headers** - Header shows "Agent: X" for single, "Parallel Tasks (N)" for parallel, "Chain: X → Y" for chains
- **Model override for single/parallel** - TUI model selection now works for all modes

### Fixed
- **MAX_PARALLEL error mode** - Now correctly returns `mode: 'parallel'` (was incorrectly `mode: 'single'`)
- **`output: true` handling** - Now correctly treats `true` as "use agent's default output" instead of creating a file literally named "true"

### Changed
- **Schema description** - `clarify` parameter now documents all modes: "default: true for chains, false for single/parallel"

## [0.3.3] - 2026-01-25

### Added
- **Thinking level selector in chain TUI** - Press `[t]` to set thinking level for any step
  - Options: off, minimal, low, medium, high, xhigh (ultrathink)
  - Appends to model as suffix (e.g., `anthropic/claude-sonnet-4-5:high`)
  - Pre-selects current thinking level if already set
- **Model selector in chain TUI** - Press `[m]` to select a different model for any step
  - Fuzzy search through all available models
  - Shows the current model with a `current` badge
  - Provider/model format (e.g., `anthropic/claude-haiku-4-5`)
  - Override indicator (✎) when model differs from agent default
- **Model visibility in chain execution** - Shows which model each step is using
  - Display format: `Step 1: scout (claude-haiku-4-5) | 3 tools, 16.8s`
  - Model shown in both running and completed steps
- **Auto-propagate output changes to reads** - When you change a step's output filename,
  downstream steps that read from it are automatically updated to use the new filename
  - Maintains chain dependencies without manual updates
  - Example: Change scout's output from `context.md` to `summary.md`, planner's reads updates automatically

### Changed
- **Progress is now chain-level** - `[p]` toggles progress for ALL steps at once
  - Progress setting shown at chain level (not per-step)
  - Chains share a single progress.md, so chain-wide toggle is more intuitive
- **Clearer output/writes labeling** - Renamed `output:` to `writes:` to clarify it's a file
  - Hotkey changed from `[o]` to `[w]` for consistency
- **{previous} data flow indicator** - Shows on the PRODUCING step (not receiving):
  - `↳ response → {previous}` appears after scout's reads line
  - Only shows when next step's template uses `{previous}`
  - Clearer mental model: output flows DOWN the chain
- Chain TUI footer updated: `[e]dit [m]odel [t]hinking [w]rites [r]eads [p]rogress`

### Fixed
- **Chain READ/WRITE instructions now prepended** - Instructions restructured:
  - `[Read from: /path/file.md]` and `[Write to: /path/file.md]` prepended BEFORE task
  - Overrides any hardcoded filenames in task text from parent agent
  - Previously: instructions were appended at end and could be overlooked
- **Output file validation** - After each step, validates expected file was created:
  - If missing, warns: "Agent wrote to different file(s): X instead of Y"
  - Helps diagnose when agents don't create expected outputs
- **Root cause: agents need `write` tool** - Agents without `write` in their tools list
  cannot create output files (they tried MCP workarounds which failed)
- **Thinking level suffixes now preserved** - Models with thinking levels (e.g., `claude-sonnet-4-5:high`)
  now correctly resolve to `anthropic/claude-sonnet-4-5:high` instead of losing the provider prefix

### Improved
- **Per-step progress indicators** - When progress is enabled, each step shows its role:
  - Step 1: `writes progress.md`
  - Step 2+: `reads progress.md`
  - Clear visualization of progress.md data flow through the chain
- **Comprehensive tool descriptions** - Better documentation of chain variables:
  - Tool description now explains `{task}`, `{previous}`, `{chain_dir}` in detail
  - Schema descriptions clarify what each variable means and when to use them
  - Helps agents construct proper chain queries for any use case

## [0.3.2] - 2026-01-25

### Performance
- **4x faster polling** - Reduced poll interval from 1000ms to 250ms (efficient with mtime caching)
- **Mtime-based caching** - status.json and output tail reads cached to avoid redundant I/O
- **Unified throttled updates** - All onUpdate calls consolidated under 50ms throttle
- **Widget change detection** - Hash-based change detection skips no-op re-renders
- **Array optimizations** - Use concat instead of spread for chain progress updates

### Fixed
- **Timer leaks** - Track and clear pendingTimer and cleanupTimers properly
- **Updates after close** - processClosed flag prevents updates after process terminates  
- **Session cleanup** - Clear cleanup timers on session_start/switch/branch/shutdown

## [0.3.1] - 2026-01-24

### Changed
- **Major code refactor** - Split monolithic index.ts into focused modules:
  - `execution.ts` - Core runSync function for single agent execution
  - `chain-execution.ts` - Chain orchestration (sequential + parallel steps)
  - `async-execution.ts` - Async/background execution support
  - `render.ts` - TUI rendering (widget, tool result display)
  - `schemas.ts` - TypeBox parameter schemas
  - `formatters.ts` - Output formatting utilities
  - `utils.ts` - Shared utility functions
  - `types.ts` - Shared type definitions and constants

### Fixed
- **Expanded view visibility** - Running chains now properly show:
  - Task preview (truncated to 80 chars) for each step
  - Recent tools fallback when between tool calls
  - Increased recent output from 2 to 3 lines
- **Progress matching** - Added agent name fallback when index doesn't match
- **Type safety** - Added defensive `?? []` for `recentOutput` access on union types

## [0.3.0] - 2026-01-24

### Added
- **Full edit mode for chain TUI** - Press `e`, `o`, or `r` to enter a full-screen editor with:
  - Word wrapping for long text that spans multiple display lines
  - Scrolling viewport (12 lines visible) with scroll indicators (↑↓)
  - Full cursor navigation: Up/Down move by display line, Page Up/Down by viewport
  - Home/End go to start/end of current display line, Ctrl+Home/End for start/end of text
  - Auto-scroll to keep cursor visible
  - Esc saves, Ctrl+C discards changes

### Improved
- **Tool description now explicitly shows the three modes** (SINGLE, CHAIN, PARALLEL) with syntax - helps agents pick the right mode when user says "scout → planner"
- **Chain execution observability** - Now shows:
  - Chain visualization with status labels: `done scout → running planner` (`done`, `running`, `pending`, `failed`) - sequential chains only
  - Accurate step counter: "step 1/2" instead of misleading "1/1"
  - Current tool and recent output for running step

## [0.2.0] - 2026-01-24

### Changed
- **Rebranded to `pi-subagents`** (was `pi-async-subagents`)
- Now installable via `npx pi-subagents`

### Added
- Chain TUI now supports editing output paths, reads lists, and toggling progress per step
- New keybindings: `o` (output), `r` (reads), `p` (progress toggle)
- Output and reads support full file paths, not just relative to chain_dir
- Each step shows all editable fields: task, output, reads, progress

### Fixed
- Chain clarification TUI edit mode now properly re-renders after state changes (was unresponsive)
- Changed edit shortcut from Tab to 'e' (Tab can be problematic in terminals)
- Edit mode cursor now starts at beginning of first line for better UX
- Footer shows context-sensitive keybinding hints for navigation vs edit mode
- Edit mode is now single-line only (Enter disabled) - UI only displays first line, so multi-line was confusing
- Added Ctrl+C in edit mode to discard changes (Esc saves, Ctrl+C discards)
- Footer now shows "Done" instead of "Save" for clarity
- Absolute paths for output/reads now work correctly (were incorrectly prepended with chainDir)

### Added
- Parallel-in-chain execution with `{ parallel: [...] }` step syntax for fan-out/fan-in patterns
- Configurable concurrency and fail-fast options for parallel steps
- Output aggregation with clear separators (`=== Parallel Task N (agent) ===`) for `{previous}`
- Namespaced artifact directories for parallel tasks (`parallel-{step}/{index}-{agent}/`)
- Pre-created progress.md for parallel steps to avoid race conditions

### Changed
- TUI clarification skipped for chains with parallel steps (runs directly in sync mode)
- Async mode rejects chains with parallel steps with clear error message
- Chain completion now returns summary blurb with progress.md and artifacts paths instead of raw output

### Added
- Live progress display for sync subagents (single and chain modes)
- Shows current tool, recent output lines, token count, and duration during execution
- Ctrl+O hint during sync execution to expand full streaming view
- Throttled updates (150ms) for smoother progress display
- Updates on tool_execution_start/end events for more responsive feedback

### Fixed
- Async widget elapsed time now freezes when job completes instead of continuing to count up
- Progress data now correctly linked to results during execution (was showing "ok" instead of "...")

### Added
- Extension API support (registerTool) with `subagent` tool name
- Session logs (JSONL + HTML export) and optional share links via GitHub Gist
- `share` and `sessionDir` parameters for session retention control
- Async events: `subagent:started`/`subagent:complete` (legacy events still emitted)
- Share info surfaced in TUI and async notifications
- Async observability folder with `status.json`, `events.jsonl`, and `subagent-log-*.md`
- `subagent_status` tool for inspecting async run state
- Async TUI widget for background runs

### Changed
- Parallel mode auto-downgrades to sync when async:true is passed (with note in output)
- TUI now shows "parallel (no live progress)" label to set expectations
- Tools passed via agent config can include extension paths (forwarded via `--extension`)

### Fixed
- Chain mode now sums step durations instead of taking max (was showing incorrect total time)
- Async notifications no longer leak across pi sessions in different directories

## [0.1.0] - 2026-01-03

Initial release forked from async-subagent example.

### Added
- Output truncation with configurable byte/line limits
- Real-time progress tracking (tools, tokens, duration)
- Debug artifacts (input, output, JSONL, metadata)
- Session-tied artifact storage for sync mode
- Per-step duration tracking for chains
