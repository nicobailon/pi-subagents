# Changelog

## [Unreleased]

### Fixed
- Keep `mcp:<server>` direct tools available when pi-mcp-adapter cache identity includes a request-header command. Thanks to [@xz-dev](https://github.com/xz-dev) for #1141.
- Fall back from an implicit `defaultContext: fork` to `fresh` when the parent session file or current leaf is not available yet, instead of failing the first launch. Explicit `context: "fork"` remains fail-fast. Thanks to [@hyein-cbio](https://github.com/hyein-cbio) for #1137.
- Preserve a child's file-only report when its output path also names the workflow summary output.
- Keep concurrent async result promotion from deleting a newer payload or another promoter's published result. Thanks to [@albertgwo](https://github.com/albertgwo) for #1130.
- Bound opaque tool-call IDs used by async active-run and result indexes, preventing provider-generated IDs longer than the filesystem component limit from aborting background launches with `ENAMETOOLONG`. Optional active-run aliases now fail open without losing the authoritative run marker. Thanks to [@hlstwizard](https://github.com/hlstwizard) for #1131.
- Bound async result session and run path segments so long identities do not make `subagent_wait` fail with `ENAMETOOLONG`. Thanks to [@zhouatie](https://github.com/zhouatie) for #1135.
- Preserve workflow child task output when neither the workflow nor child configures an output file (#1136).

### Changed
- Remove legacy subagent tool compatibility fields for append-step control, schedule aliases, async recovery metadata, and string mission goals.
- Clarify that subagent reviews and gates should stay async unless foreground behavior is the actual requirement.
- Remove `prompts.render` from `workflowScript`; pass explicit task text to `runs.run` or use `/prompt-workflow` for reusable prompt templates.

## [0.50.0] - 2026-08-15

### Added
- Add optional Orca progress tabs with bounded, sanitized mirrors for native Pi and external CLI children. Thanks to @hyein-cbio for #1080.
- Show caller-owned external jobs in FleetView through a bounded push/cache API, without polling or exposing managed controls. Thanks to @ssyram for #1083.
- Add a bounded current-status snapshot for async runs in RPC surfaces, without replaying terminal history. Thanks to @yanqianglu for #1078.
- Add an optional `foregroundDetachShortcut` binding and show it in the running single-subagent card, so foreground work can be moved to the background without editing package source. Thanks to @Lewis-E for #1097.

### Changed
- Clarify retained-child resumability and native supervisor coordination guidance. Thanks to @ELA718 for #1126.
- Clarify that completed retained writers should use `resume`, while `steer` with `mode: "follow_up"` only queues text for the next revival (#1104).
- Treat oracle/advisor consultation prompts as supervisor-backed dialogue when material unknowns remain (#1102).
- Show explicit resumable and not-resumable states, with fallback guidance, in retained child listings (#1101).
- Reduce reload work for large async histories by indexing the async result inbox by session, observer, and tool-call id instead of scanning every old result file. Stale terminal active markers now age out, and replay cleanup scans run less often.

### Fixed
- Keep Orca progress tabs from treating write-stream backpressure as mirror truncation.
- Stop advertising an `output-<index>.log` artifact in run transcripts when that file was never written, so workflow runs no longer point at a path that cannot exist. Thanks to @lbijeau for #1124.
- Keep FleetView working when a session file path is longer than a short identity, instead of failing external-job inspection on every poll. Thanks to @albertgwo for #1121 and @Don-Yin for #1122.
- Keep structured single-child runs from overriding output paths in the task, while preserving explicit and agent-configured outputs. Thanks to @pasemes for #1119.
- Keep no-edit confirmations guarded after later changes retract a prior implementation (#1115).
- Remove the native generic `intercom` compatibility fallback from supervisor coordination while preserving `contact_supervisor`, `subagent_supervisor`, and external `intercom` providers. Thanks to @jaudiger for #1107.
- Report an actionable project-settings override when duplicate ambient Pi extensions prevent a child from starting (#1114).
- Keep the FleetView overlay refreshed while open and count active leaf agents in the compact summary. Thanks to @Don-Yin for #1108.
- Keep user-requested foreground detaches from showing supervisor-response recovery guidance. Thanks to @Lewis-E for #1109.
- Reject configured subagent models that are not in the active host model registry before spawning a child, instead of forwarding an invalid `--model` argument to Pi. Thanks to @DresvyanskiyDenis for #1093.
- Start Herdr inspector and project pane commands with a shell-safe executable token, including paths that need quoting in Nushell. Thanks to @Rival for #1092.
- Stop `agentContract.version` from using an `enum` on an integer, which Gemini's function-calling schema subset rejects. Integer bounds express the same constraint and are valid everywhere. Thanks to @MarcusNeufeldt for #1095.
- Show supervisor-detached workflow children as paused and needing attention instead of failed while preserving recovery guidance (#1096).
- Show workflow-owned foreground children and recursive nested runs as a bounded tree in FleetView. Thanks to @expoli for #1086.
- Warn once, instead of on every heartbeat, when a long-running workflow child outlives its mission record. Thanks to @albertgwo for #1079.
- Keep deleted-schedule timers from exiting Pi and re-arm recurring schedules after unexpected timer fire failures. Thanks to @albertgwo for #1084.
- Count native `await` use of `runs.run`, `runs.all`, and launch-containing Promise combinators as consumed without allowing fire-and-forget launches. Thanks to @kebinzhi for #1082.

## [0.49.0] - 2026-08-13

### Added
- Run a single child with `{ agent, task? }` when a full workflow script is not needed (#1059).
- Adjust FleetView spacing and collapsed result height from the main window. Thanks to @pierre-mgmt for #1048.
- Inspect async run state with `debug.run`, without exposing prompts, secrets, or transcripts (#1037).
- Let builtin role overrides keep Pi's normal tools and extensions with `tools: "inherit"`. Thanks to @estanexanavsem for #1047 and @davidarny for #1049.
- Add simple terminal examples for FleetView, the async widget, and inline tool display. Thanks to @czottmann for #1050.
- Add per-tool-call wedge protection with `toolTimeoutMs` call → agent → config → environment precedence. Known-fast built-in tools get a five-minute default, long-running tools get attention notices without a hard default, matching `toolCallId` timers survive parallel tool completions, and supervisor waits (`contact_supervisor`, `intercom`, `subagent_wait`) remain exempt. Thanks to @forrestbthomas for #1077.

### Changed
- Clean up active-run limits and artifact packaging code without changing behavior.

### Fixed
- Trust live Herdr session roots only when the parent executor registered them for that async run.
- Let a workflow child disable the intercom bridge for one run with `intercomBridge: { mode: "off" }`, while normal async completion still works. Thanks to @jaudiger for #1072.
- Recover sibling children after a detached workflow fails (#1066).
- Show child session transcripts in standalone Herdr inspectors when the transcript is in a trusted session folder (#1069).
- Keep watchdog reviews, permission checks, Prompt Audit rewriting, and completion intent checks on the authenticated provider stream across the Pi 0.81 and 0.84 APIs. Thanks to @nuzayets for #1067.
- Mark children stopped by a parent workflow as stopped, not failed, and keep the stop reason (#1060).
- Keep subagent artifacts and automatic mission records out of project worktrees by default, so read-only workflows leave the tree clean (#1062).
- Make parents wait at dependency barriers after async launches, so child results are available before dependent work continues. Thanks to @exuanbo for #1045.
- Keep wait callers alive for intercom replies instead of reviving a detached wrapper. Thanks to @yayamaz for #1053.
- Keep workflow summary reports separate from child reports, and reject report path collisions before launch (#1038).
- Accept no-edit implementation challenge passes when the writer says the current solution is already best (#1054).
- Make the mutation guard safer for LLM intent checks, long tasks, and provider authentication. Thanks to @MarcusNeufeldt for #1044.
- Launch Herdr inspector panes with Node when Pi runs as a standalone executable. Thanks to @kevinpita for #1051.
- Sanitize async, nested, and result transcript output before showing it in terminal views. Thanks to @riesbri for #1046.

## [0.48.0] - 2026-08-13

### Added
- Limit each run to 64 child launches by default, so accidental fan-out loops stop before they create too many children. Thanks to @asjer for #1031.
- Add an optional limit for how many top-level async runs one session can have active at the same time. Fleet, status, RPC, and doctor now show the limit and current usage. Thanks to @asjer for #1029.
- Add a live Prompt Audit drawer to Fleet for foreground children owned by the current session. It shows the prompt on screen without saving it to status files, history, transcripts, metadata, results, progress, or run artifacts (#1021).
- Add a global `timeoutMs` setting for default run deadlines on foreground launches and plain single-agent async runs. It applies when a launch or agent does not set its own timeout, and it prevents long foreground fan-outs from falling back to the built-in 30-minute limit. Composite async runs stay unbounded at the top level. Thanks to @shaharmor for #1018.
- Add `PI_SUBAGENT_TASK_DELIVERY=auto|file` for hosts that block child processes when the task text appears in the command line. File mode writes the task to a temporary `task.md` and passes that path instead. Thanks to @yanqianglu for #1028.
- Retry with file-based task delivery after a child exits with no activity, which helps recover from endpoint protection tools that block long command lines. Thanks to @yanqianglu for #1028.

### Fixed
- Open Fleet Prompt Audit with the original task visible by default, and show a short task summary in the normal Fleet detail pane (#1021).
- Use the full task text when caching LLM intent decisions, so similar tasks with the same prefix cannot share the wrong answer.
- Stop async Pi writer processes as full process groups, and only mark process cleanup as proven after the process tree has actually exited. Thanks to @asjer for #1030.
- Explain when a mission belongs to another worktree, including both the current project root and the mission directory (#1024).
- Keep the configured output reference when explicit acceptance rejects a foreground child, so useful reports remain available (#1023).
- Reject worktree base directories inside the agent extensions directory, including symlinked paths (#1014).
- Make unnamed intercom fallback targets match pi-intercom's registered name length, so subagents without a custom session name can still reach their parent. Thanks to @mystery4f for #1017.
- Stop treating phrases like "must-fix items" or "should-fix tests" as instructions to edit files during read-only review tasks. Thanks to @MarcusNeufeldt for #1020.
- Add an optional LLM check before the mutation guard fails a foreground single, parallel, or chain child that made no edits. If the task was actually read-only, the run now completes instead of failing. Thanks to @MarcusNeufeldt for #1020.
- Accept empty strings inside acceptance-report string arrays instead of rejecting the full report. Thanks to @hjiang for #1015.
- Let single external-CLI workflow children start without inheriting a Pi model, so model-less external runners do not fail preflight. Thanks to @twosunnus for #1016.

## [0.47.1] - 2026-08-12

### Fixed
- Honor configured artifact cleanup retention days and let `0` disable artifact cleanup. Thanks to @elecnix for #1012.
- Add a display-only dismiss action for reload-recovered running workflows without claiming or attempting to stop their work (#1010).
- Stop the bundled reviewer from inheriting chain-only plan/progress reads in ad-hoc review runs. Thanks to @Ostii for #1000.
- Remove mutation-capable tools from the bundled reviewer so read-only review lanes have a hard launch-time tool boundary (#1007).
- Show the requested child agent in workflow started trace entries. Thanks to @albertgwo for #1001.

## [0.47.0] - 2026-08-11

### Changed
- Avoid fully parsing stale cross-session result files during watcher recovery and reduce healthy watcher safety scans.
- Index active async runs so status restoration no longer scans all historical run directories.
- Refresh active async job state from filesystem events while reserving polling for slow liveness repair.
- Add optional strict model-scope enforcement that rejects inherited and fallback models outside the configured allowlist. Thanks to @antonioc-cl for #995.
- Trim legacy chain-control schema fields and guidance by default, saving 1,319 `o200k_base` tokens from the serialized default tool schema plus description versus `legacyChainControls: true`. Thanks to @tajquitgenius for #977.
- Move project-scoped pi-subagents storage from `.pi-subagents/` to `.pi/subagents/` for cleaner project roots. Thanks to @yceachan for #971.
- Clarify the accepted mission launch object contract for tool callers.
- Reduce repeated async status parsing, workflow trace projection, and constrained widget rendering work.
- Coalesce rapid running-status writes while keeping terminal and attention status changes durable immediately.
- Keep parsed async statuses cached beyond 50 runs while preserving per-read freshness checks. Thanks to @bcanvural for #982.
- Prefer native control inbox watchers over per-process 250 ms polling, with polling retained as a fallback.

### Fixed
- Omit missing configured read files from child task instructions.
- Stabilize steering recovery budget coverage around the confirmed paused handoff.
- Keep timeout-sensitive async acceptance verification coverage off Windows CI where signal delivery is intermittent.
- Retry transient Windows mission state lock creation failures and stabilize no-session steering recovery coverage.
- Keep async widget running glyphs moving while children are quiet but active. Thanks to @bcanvural for #983.
- Let active-session workflows live-steer their workflow-owned foreground children by child or unique workflow identity. Thanks to @youlikemodernart for #988.
- Accept persisted async recovery descriptors that include internal turn-budget state fields (#985).
- Add a 30-minute default wall-clock timeout to async children while keeping async composite parents unbounded by default. Thanks to @forrestbthomas for #978 and #979.
- Keep tool argument previews on one physical terminal line so live widget updates do not leave stacked terminal frames. Thanks to @xz-dev for #972.
- Recover durable async completions when a healthy native result watcher misses a filesystem event. Thanks to @xz-dev for #973.

## [0.46.0] - 2026-08-11

### Added
- Add `prompts.render(ref, vars?)` to `workflowScript` for explicitly scoped package, user, and project prompt fragments with simple `{{name}}` interpolation (#960).
- Expose a versioned `pi-subagents/project-panes` TypeScript API so other Pi extensions can deterministically open, inspect, and close project-owned Herdr panes without invoking the model-facing `subagent` tool. The structured status includes bounded pane runtime state and an opt-in idle-only close guard; Pi project trust remains an explicit human verification step. Thanks to @wiizard-chen for #949.
- Preserve short-lived completion replay records and bounded output archives so waits can recover consumed async result details after watcher delivery or restart.
- Add `subagent({ action: "guide" })` and `/subagents-guide [topic]` to read current-version packaged guides.
- Persist workflow child attempts, status heartbeats, session paths, and artifacts in their enclosing mission, and add explicit mission decision resolution.

### Fixed
- Suspend subagent status widgets during automatic compaction to prevent duplicate terminal frames.
- Make live foreground workflow children visible as workflow-owned Fleet rows, route Herdr inspection to their workflow parent, and report their active and needs-attention state to Herdr. Thanks to @lukechen526 for #965.
- Wait for retained-child resumes inside `workflowScript` to finish and return completed output before the script continues (#961).
- Keep fork-context workflow children inside their managed worktree by aligning the persisted child session cwd before launch. Thanks to @flopsi for #953.
- Show the resolved child agent in async workflow status while keeping the workflow key as its stable label. Thanks to @albertgwo for #955.
- Reject workflow scripts that finish with unawaited child launches and name every launch that was aborted. Thanks to @zig-zag-zig for #957.
- Reject mismatched completion replay archive paths so stale replay cleanup cannot delete another run's saved output archive.
- Keep `git-root` project agent and package discovery stable when incidental `.pi` state appears in a nested linked worktree. Thanks to @klajdo-f for #950.
- Read skill descriptions from YAML block scalars instead of exposing their markers. Thanks to @ashlineldridge for #945.
- Collapse repeated subagent status snapshots in live widgets so status polling does not overflow the chat.
- Give invalid `subagent` actions safe next steps and typo suggestions without suggesting destructive actions for ambiguous input.
- Let the Fleet inspector use extension-local keybindings for terminals that intercept navigation keys. Thanks to @epheien for #940.
- Restore completed foreground children from a compact Fleet history index after session resume. Thanks to @epheien for #946.
- Compact noisy repeated subagent live-output lines and bound workflow live-card rows so progress stays readable in the TUI (#947).

## [0.45.2] - 2026-08-10

### Fixed
- Tell parents to revive resumable failed async runs before reporting failure or launching a replacement. Thanks to @Livan-pro for #938.
- Persist the actual agent and session file for workflow children when they start so their sessions can resume after a parent restart. Thanks to @Livan-pro for #932.
- Retry steering requests that remain pending after manual compaction and fail unresolved requests at shutdown. Thanks to @jtac for #933.
- Omit undefined object fields from `workflowScript` return values so completed `runs.all` results are not discarded when callers include unsupported fields such as `status` (#930).
- Keep child steering inbox `auto` requests queued between `agent_end` and `agent_settled` so settlement-time guidance is not sent as an idle prompt too early. Thanks to @jtac for #928.

## [0.45.1] - 2026-08-09

### Changed
- Simplified async workflow activity projection and its regression test to reuse canonical status types.

### Fixed
- Add actionable guidance when Markdown fence backticks make a `workflowScript` invalid JavaScript.
- Prevent async interrupt requests from signaling unverified runner PIDs, including the shared host PID stored by workflows. Thanks to @kdasme for #925.

## [0.45.0] - 2026-08-09

### Added
- Surface terminal completion payloads in `subagent_wait` tool-result details (`details.completions`): run identity, per-child agent/`runId`/success, and artifact paths. Async completions previously reached the parent only as text — the result file is consumed and deleted after delivery — so extensions and automation had no structured way to learn which runs finished or where their artifacts live. Workflow result files now also record each child's `runId`, which was previously dropped even though the workflow engine knows it; a workflow child's `artifactPaths` entry points at its saved output (`outputs/<runId>/…`), so without the explicit field the child's identity was not recoverable from the payload. Thanks to @lucasgrecco for #915.

### Changed
- Clarified mission-use policy in the packaged `pi-subagents` skill.

### Fixed
- Prefix quoted Herdr pane commands with PowerShell's call operator on Windows. Thanks to @qsgy-edge for #921.
- Report live child activity for async workflow runs instead of deriving a false activity age from the workflow launch time. Thanks to @alexei-led (Alexei Ledenev) for #920.
- Expand `reads` home paths and apply configured reads to single-run launches. Thanks to @Adjuvant (Thomas Deacon) for #916.
- Drop late workflow child responses after worker settlement. Thanks to @xz-dev (Xiangzhe) for #922.
- Stabilize steering recovery tests by invalidating cached status metadata after fast test rewrites.

## [0.44.0] - 2026-08-08

### Added
- Added one automatic enclosing mission and durable workflow state to plain `workflowScript` launches; child runs no longer create separate missions.
- Added `scheduledRuns.storeRoot` for durable schedules outside project repositories. Thanks to @ProCleiton for #891 and the prior #890 implementation.

### Changed
- Clarified native supervisor messaging and optional external intercom result delivery in the docs and packaged skill.
- Identify status and transcript targets before the spawn-budget summary in collapsed tool-result cards.
- Point interactive async-launch guidance to `subagent_wait({ id, nonBlocking: true })` when an explicit wake is needed without blocking the current turn.

### Fixed
- Report the explicit workflow execution cwd in async workflow status, job, and result records. Thanks to @nicobailon for #907.
- Ignore stale extension-context errors from advisory foreground control notifications after reload. Thanks to @alexei-led for #905.
- Bound inherited portable tool IDs to 64 characters for Codex-compatible child contexts while keeping tool calls and results paired. Thanks to @alexei-led for #903.
- Prevent boolean chain `output` values from crashing clarify rendering. Thanks to @ftoleedo for #901.
- Preserve `workflow` mode when asynchronous workflow mission runs complete.
- Serialize and merge each mission workflow-state write with the latest file so separate workflows do not drop unrelated keys.
- Preserve `workflowScript` worktree children that detach for supervisor coordination instead of cleaning a live managed worktree. Thanks to @astarktc for #896.
- Accept schema-valid structured output after a child recovers from an earlier tool error. Thanks to @white-hat for the report in #888.

## [0.43.0] - 2026-08-07

### Added
- Added explicit project-local subagent refinement overlays through `/subagents-refine <agent>` and `refine`, `refine.show`, and `refine.rollback` actions.
- Added opt-in goal missions that send one needs-attention continuation notice after idle parent turns, account linked-run token usage against a mission budget, pause or stop through `mission.update`, and name retained children when resume is the next ready action.
- Added `steer`, `follow_up`, and `auto` delivery modes with delivered/queued receipts, bounded FIFO follow-ups, retained-child revival briefs, RPC parity, and Fleet mode selection.
- Added one-command `gate` verification for direct and scripted workflow children, with host evidence and tracked-workspace memoization.
- Added mission-scoped durable JSON state to `workflowScript` through `state.get(key)` and `state.set(key, value)`.
- Added a session-scoped `children.list` roster for the last 10 completed retained workflow children and let `workflowScript` resume one through `runs.run` without changing its stored agent, model, or tool contract.

### Changed
- Documented the one-command `gate` shorthand, retained `children.list`/`resume` flow, and refinement overlays in the tool reference and agents docs, and refreshed the packaged `pi-subagents` skill for the current mission `objective` shape, workflow `state`, and child-protocol limits.
- Removed the bundled `planner` and `context-builder` roles and their stale context-handoff prompt templates.
- Made `workflowScript` the only public subagent execution surface, including one-child and scheduled runs. Scripts now use ordinary JavaScript statement-body semantics and require an explicit `return` for useful results.
- Require workflowScript-only persisted schedule targets. Removed legacy agent-target restore conversion.

### Fixed
- Use portable internal ids for async workflow directories and preserve host tool-call ids as correlation metadata. Thanks to @DrunkenDonkey80 for #889.
- Represent gate normalization with explicit success and failure results, removing ambiguous internal states without changing gate behavior.
- Preserve live composite child tool-call ids for APIs that normalize them, preventing context rewriting from breaking the next tool-loop turn.
- Sanitize inherited child tool history ids so forked subagent context stays provider-portable.
- Prevent async workflow result finalization from reading stale extension contexts after session replacement or reload.
- Create default missions for static parallel-only chain launches, reject invalid explicit mission ids, and reject legacy `parallel` workflow child params.
- Keep very narrow TUI result wrapping within its width budget and simplify Fleet nested status row construction.
- Clean up fanout-child nested-control listeners on reload so stale listeners cannot duplicate resume handling.
- Prevent path-resolution tests from modifying or deleting the user's real `~/.agents` directory. Thanks to @meatcar for the report and fix in #865.
- Show the target agent for simple scheduled one-child workflow scripts and mark dynamic scripts clearly.
- Stop quiet async status widget animation redraws from spilling progress updates into the editor input area.

## [0.42.1] - 2026-08-06

### Fixed
- Prevent Pi from crashing when subagent status widgets and overlays are shown in narrow or resized terminal layouts. Thanks to @alanvardy for the report in #858 and @meatcar for the fix.
- Keep async scripted workflows running without an implicit 30-minute timeout, while preserving the foreground default and explicit timeout controls.
- Limit `workflowScript` chat progress to the supported `auto`, `off`, and `live-card` projections.

## [0.42.0] - 2026-08-06

### Added
- Split the README reference material into focused docs and keep the README as a concise quick-start guide.
- Verified scripted workflows can mix dynamic parallel and sequential phases with managed worktree isolation.
- Added native `@gotgenes/pi-permission-system` compatibility for child processes. Thanks to @jagaliano for #847.

### Fixed
- Accept `mission.summary` as a title alias for workflow launches, so child runs start normally.
- Keep async subagent widget spinners moving during quiet running periods without adding extra polling.
- Preserve workflow child output after grouped intercom delivery, so scripts can consume `runs.run(...).output`. Thanks to @kaushal9696 for #846.
- Match pi-mcp-adapter cache identities that include `protocolVersion`, so direct MCP tool selections resolve from current adapter caches. Thanks to @ProCleiton for #848.
- Reject commandless verified acceptance at the runtime launch boundary before a child starts. Use `checked` or provide `acceptance.verify`. Thanks to @simonasr for #849.
- Warn when project-scoped subagent artifacts can be included in an npm package. Thanks to @nicobailon for #840.
- Fail child launch setup when an installed permission-system manifest cannot be read or names a missing extension entry.
- Let the Fleet inspector use the full 85% terminal-height budget on tall terminals. Thanks to @xz-dev for #839.
- Launch Herdr inspector panes through a JavaScript bootstrap instead of asking Node to type-strip TypeScript installed under `node_modules`. Thanks to @williamleong for #837.
- Removed the Pi CLI devDependency from the default install and test against a local runtime shim, so repo audits no longer report the upstream dev-only Undici advisory while real Pi E2E remains optional. Thanks to @dmg-egg for #782.
- Stream immediate and periodic progress for blocking foreground subagent runs, so long reasoning intervals remain visibly active. Thanks to @walter-erquinigo for #833.

## [0.41.0] - 2026-08-05

### Added
- Added live status streaming for `subagent_wait` while it waits on subagent runs. Thanks to @walter-erquinigo for #832.
- Added opt-in `inlineToolDisplay: "summary"` for a stable one-row inline subagent result while FleetView remains the live progress surface. Thanks to @ryanbbrown for #805.
- Added project-scoped durable schedules with one-shot and fixed-interval triggers, `workflowScript` or agent targets, overlap/catch-up policy, text management actions, external `schedule.run-due`, and durable history/event/run receipts. Thanks to @nicobailon for #815.
- Added an observational `pi-subagents/external-runs` provider API for visible terminal work, without taking process ownership. Thanks to @nicobailon for #795.
- Added durable non-blocking `subagent_wait({ id, nonBlocking: true })` subscriptions that return immediately, preserve exact run identity, remain visible in status, and wake the originating interactive session on terminal, attention, reconciliation-failure, or timeout outcomes.
- Added narrow public entrypoints for extension consumers to access async stop requests, intercom session targeting, launch tool-plan resolution, and fork-task helpers without deep imports. Thanks to @shaneconner for #794.
- FleetView nested trees now retain and display each leaf's effective model and thinking effort, including completed siblings while the owner remains active. Thanks to @fgpaz for #776.
- Restored same-repo watched `workflowScript` live chat progress cards, with `chatProgress` controls and Git-worktree-aware same-repo detection.
- Enabled TypeScript `noUncheckedIndexedAccess` for production source after narrowing indexed reads at their runtime invariant boundaries.
- Added managed per-child worktree isolation to scripted workflows through `worktree: true` on `runs.run` / `runs.all` items or as a workflow-level default, with child overrides and handoff paths preserved in child artifacts.
- Added opt-in native Pi-child tool permissions with global and per-agent `allow`/`ask`/`deny` rules, watchdog-owned exact-call decisions, and bounded redacted audit records. Unconfigured tools pass through, while bash policy remains with `pi-guard`.
- Added a source-only, strict TypeScript typecheck command and CI gate.
- Added trusted inline `workflowScript` orchestration with stable-key child launches through the ordinary executor, timed worker isolation, captured console and emitted milestones, artifact references, status lookup, and a concise call trace.
- Added opt-in async one-shot `external-cli` agent profiles with stdin prompt delivery, argv-only spawning, lifecycle/status artifacts, stdout/stderr logs, timeout, and stop support.
- Added default-on durable project missions with management actions, launch attachment, lifecycle/artifact links, explicit opt-out, a user-local cross-project pointer index, and typed delivery receipts for pull requests, CI, deployments, and releases.
- Made ordinary top-level subagent launches run asynchronously by default; `async: false`, agent defaults, and clarify UI retain foreground escape hatches.
- Added a small fixed authority policy for worktree discard, destructive cleanup, spawn-budget grants, schedule creation, stop, and steer actions.
- Added automatic Herdr status metadata for active async runs, including reload recovery, needs-attention blocking, and a forward-compatible `herdr:busy` sibling event for semantic working state. Thanks to @magoz for #730.
- Added optional Herdr 0.7.5+ drill-in inspector panes for async runs, with durable pane bindings, lifecycle/transcript/mission dashboards, FleetView opening, and steer/stop controls through the existing file control channel.
- Added Herdr project panes so an orchestrator can open a project-rooted Pi session for substantial cross-codebase work.
- Added optional `thinking` and `fallbackModels` fields to `/subagents` profile agent overrides, so a saved profile can pin reasoning effort and fallbacks (not just the model) — important for reasoning-sensitive models where the thinking level is load-bearing. Thanks to @dt-benedict for #741.

### Changed
- Collapsed the inactive FleetView roster to one active-work summary line while preserving keyboard expansion and inspector state restoration. Thanks to @xz-dev for #826.
- Clarified packaged pi-subagents guidance for cross-repository delegation, authority boundaries, and evidence-only external gates.
- Clarified when direct single-child calls are appropriate versus coordinated `workflowScript` orchestration, including stable keys and durable child outputs.
- Documented the headless pi-guard compatibility path for child-specific explicit allow/deny policy. Thanks to @chama-chomo for #742.
- Replaced session-scoped one-shot schedule actions with the `schedule.*` API and project-local schedule records. Calendar recurrence and the schedule inspector remain deferred to the next slice.
- Replaced the separate version-numbered extension delegation contracts with one structured owned-leaf delegation API, while keeping the unversioned prompt-template bridge as a temporary legacy fallback.
- Removed the public top-level `tasks[]`, `chain[]`, static parallel controls, and `/chain`, `/parallel`, and `/run-chain` commands; `workflowScript` is now the sole public multi-agent orchestration surface. `append-step` now accepts a control-only `step` object.
- Scripted workflows now start asynchronously by default as first-class status/fleet runs, stream trace and emitted progress, support stop by workflow id, preserve async child parentage, and present single + workflow as the public authoring surface.
- `runs.ref()` now returns concise `[run <key>; id=<short-id>]` references; callers that need artifact, session, or handoff paths should read the child result `artifactPaths` or the corresponding status artifacts.
- Scheduled subagent runs are now enabled by default; set `{ "scheduledRuns": { "enabled": false } }` to opt out.

### Fixed
- Kept durable schedule timers and completion ownership isolated per project, recorded elapsed overlaps without queueing an immediate rerun, rejected symlink-backed schedule paths, and made the deferred mission contract explicit. Thanks to @nicobailon for #815.
- Preserve actionable multi-line subagent tool errors in collapsed result rendering. Thanks to @xz-dev for #824.
- Sanitize Fleet transcript content and warnings before terminal display while preserving normal Unicode and formatting. Thanks to @xz-dev for #823.
- Unified subagent status presentation across compact, expanded, and Fleet views, including terminal interruption precedence and terminal-safe selection markers. Thanks to @xz-dev for #822.
- Display model and thinking metadata consistently in expanded multi-result and async Fleet views. Thanks to @xz-dev for #825.
- Keep the under-editor async status widget visible by default while FleetView is enabled, including after active runs restore following reload. Thanks to @nicobailon for #804.
- Restore active under-editor subagent status after management calls, so `status` and `list` do not hide running disk-backed work. Thanks to @nicobailon for #816.
- Allow direct single-child `worktree: true` launches to use managed isolation without requiring `workflowScript`. Thanks to @nicobailon for #808.
- Isolated each mock Pi test queue so late child processes cannot consume or lose responses after the next test resets the harness. Thanks to @nicobailon for #810.
- Show a workflow lane manifest with mode and stable lane keys in the launch card instead of only `subagent workflow script`. Thanks to @nicobailon for #813.
- Reject scalar or commandless verified acceptance before spawning a child; verified policies now require object form with at least one runtime command. Thanks to @ryanbbrown for #807.
- Let every `runs.all` child settle and return ordered per-child outcomes instead of aborting siblings when one child fails; `runs.run` remains fail-fast. Thanks to @ryanbbrown for #807.
- Wake the originating parent session after a hidden successful background completion while preserving explicit `triggerTurn: false` delivery. Thanks to @ryanbbrown for #805.
- Preserve successful async completion when project-local artifact or mission files are removed before final bookkeeping by recreating artifact directories and recording missing-mission warnings.
- Keep active Fleet inspector runs ahead of terminal history, which now sorts by recency instead of failure state so old failures do not look attached to current workflow work. Thanks to @nicobailon for #802.
- Normalize undefined fields in workflow child results before scripts can return them, preserving artifact-only child output.
- Show current-session async runs in the Fleet inspector even when this Pi process did not start them.
- Replace the duplicate advisor agent with an alias on the oracle agent.
- Suppress stale foreground needs-attention transcript notices after the target run completes.
- Retry zero-activity `SIGKILL` exits during child startup.
- Make grouped-result intercom delivery opt-in while preserving local foreground output by default.
- Resume the parent session after compaction while async subagent work remains active.
- Avoid invoking `npm root -g` on Windows when the standard `%APPDATA%\\npm\\node_modules` global root is available, preserving custom terminal tab titles during agent and skill discovery. Thanks to @Suchwert for #767.
- Preserved nested foreground failure events when resolved launch metadata is unavailable.
- Launch standalone Pi child processes directly instead of prepending the resolved Pi CLI script path. Thanks to @ZacharyQin for #764.
- Kept foreground `workflowScript` live-card runs from flooding chat with routine successful child-result intercom messages while preserving failure surfacing and final artifact references.
- Project oversized redundant Pi `turn_end` and `agent_end` child events to bounded lifecycle records instead of failing image-heavy runs with `protocol_output_limit`, while preserving `agent_end.willRetry` drain behavior. Thanks to @barto-sh for #743.
- Count clear `git add`, `git commit`, and `git push` bash calls as implementation mutation attempts so workers that finalize pre-applied changes do not fail the completion guard.
- Render structured-output-only children as useful JSON output instead of misleading `(no output)` summaries and empty output artifacts.
- Preserved unrelated `subagents` settings (e.g. `disableBuiltins`, `modelScope`, `watchdog`) when applying a `/subagents` profile, instead of replacing the whole `subagents` object; a profile still owns the complete `agentOverrides` mapping. Also validate profile `thinking`, `fallbackModels`, and `disableBuiltins` fields. Thanks to @dt-benedict for #741.
- Journaled managed worktree ownership before child execution so abrupt exits retain a manifest-backed cleanup path.
- Made automatic mission persistence best-effort without weakening explicit mission requests, bounded terminal mission retention and stale global pointers, exposed auto missions without modifying structured JSON output, added authority-consistent manifest-backed preserved-worktree discard, and clarified the Herdr inspector/schema surface.
- Recovered valid structured acceptance reports from unterminated explicit `acceptance-report` fences while retaining hard failures for malformed or invalid reports.
- Preserved dirty or divergent managed worktrees when no successful handoff patch was captured, instead of force-removing uncaptured work and its temporary branch.
- Routed foreground chain scratch files to user-scoped temp storage when `artifactDir` is `"session"` or `"temp"`, preventing `.pi-subagents/` clutter in the working directory. Thanks to @magoz for #729.
- Retry transient Windows `EPERM`/`EBUSY`/`EACCES` locks when atomically replacing the async runner startup-control handshake file, so a transient antivirus/indexer lock no longer makes the parent believe the runner never reached the ready state. Thanks to @franktheglock for #731.
- Kept successful background subagent completions quiet so inactive Pi tabs are not marked unread, while failed and paused completions still notify the originating session. Thanks to @killianMei for #728.
- Avoid crashing the extension at load on Windows when shared temp async result/run directories are persistently blocked by `EPERM`/`EACCES`, falling back to pid-scoped sibling paths without deleting saved run state. Thanks to @franktheglock for #734.

## [0.40.0] - 2026-08-01

### Added
- Documented an optional recommended model-tiering setup in the README: fast workhorse, standard well-scoped, deep-but-bounded, and taste/intent tiers, with cross-provider `fallbackModels` guidance for usage-limit resilience.
- Added `description` to `subagents.agentOverrides` so deployments can replace the discovered description for builtin and custom agents in list output. Thanks to @chronoAP for #724.

### Changed
- Refreshed the bundled `pi-subagents` skill for the 0.39 surface: Fleet inspector live controls (`s` steer, `D` stop), the recommended model-tiering recipe, `agentOverrides.description`, `projectRootResolution: "git-root"`, running-card live-detail/model badges, and the newer extension RPC capability projections (`fleetStatus`, `launchResolvedExtensions`, `runtimeAcknowledgedExtensions`, `(runId, index)` correlation). Corrected the stale README "inspection-only" fleet inspector wording.

### Fixed
- Grouped intercom results now report child process status separately from provenance-aware output availability, including salvage guidance when a failed process produced output. Thanks to @youlikemodernart for #727.
- Collapsed running foreground subagent rows now show the model and thinking level: single-result cards include the effective thinking suffix and parallel/chain rows show the per-child model badge, matching the async widget.

## [0.39.0] - 2026-08-01

### Added
- Added session-scoped `allowedAgents` capability ceilings for restricting launchable agent roles without global agent disabling. Thanks to @aoguai for #719.
- Added stable foreground result row indexes for correlating child progress and final results. Thanks to @rochecompaan (Patchmill) for #720.
- Added watchdog current-scope context, optional every-N-tools scope-monitor cadence, and visible main-session blocker auto-follow, inspired by Scopey (github.com/ArchAstro/scopey) by Calvin Grunewald (@CalvinGrunewald).
- Added optional `runtimeAcknowledgedExtensions` status/result/RPC metadata for cooperating child-runtime extensions that emit `subagent:acknowledge-extension`. Thanks to @saleemlala for #705.
- Added `/subagents-detach` for detaching the active foreground single-subagent run without terminating the child. Thanks to @magoz for #708/#711.
- Added agent frontmatter aliases and built-in worker aliases for `developer`, `coder`, `implementer`, and `develop`, while keeping canonical names in execution state. Thanks to @selimerunkut for #695.
- Added explicit chain approval checkpoints with `{ checkpoint, message? }`, `approve-checkpoint`/`reject-checkpoint` controls, persisted checkpoint status, and terminal `rejected` outcomes. Thanks to @saleemlala for #694.
- Added optional root `usageBudget` limits for reported token and cost totals, with soft status reporting and hard gating for later child launches without stopping already-running children. Thanks to @saleemlala for #693.
- Added optional `launchResolvedExtensions` status/result/RPC metadata with opaque launch-resolved child extension identifiers and ambient-extension state. Thanks to @saleemlala for #691.
- Added Fleet inspector controls to steer the selected live async child and stop its top-level async run with confirmation. Thanks to @saleemlala for #692.

### Changed
- Reduced repeated runtime filesystem work by caching stable Pi config-directory resolution, incrementally sanitizing run history, and limiting nested control-result polling to files created for the active request.

### Fixed
- Show per-child async task descriptions in the persistent running-subagents status widget instead of repeating the run-level description for every parallel child.
- Restored model and thinking-effort badges in the persistent running-subagents status widget.
- Retained foreground controls until scheduling owners and active children settle, keeping queued foreground work steerable after early result handling. Thanks to @magoz for #708/#709/#710.
- Render resolved model and thinking effort for active and recent foreground children in Fleet inspector summaries and details. Thanks to @saleemlala for #706.
- Resynchronized async job control-event scans that resume inside an oversized JSONL record, avoiding malformed-tail parse noise while preserving later control events. Thanks to @vicary for #700.
- Report signal-terminated child processes with a canonical signal error instead of stderr-tail noise and classify those results separately from ordinary task failures. Thanks to @cking000bigdemon for #688.

## [0.38.0] - 2026-07-30

### Added
- Added `j`/`k` navigation aliases to the non-filterable `/subagents-stop` selector and clarify step list while preserving text input in editor and search modes. Thanks to @magoz for #686.
- Added the optional versioned `fleetStatus` RPC capability with bounded, current-session child roles, goals, model/effort, split token usage, elapsed timestamps, stable opaque reconciliation keys, and explicit overflow counts. Thanks to @neumie for #682.

### Fixed
- Enabled the advertised `j`/`k` navigation aliases after activating the persistent FleetView while leaving printable editor input untouched before activation. Thanks to @magoz for #685.
- Added opt-in `subagents.projectRootResolution: "git-root"` so monorepos and git worktrees can keep the default nearest-root behavior unless they choose to resolve project packages and `agentOverrides` from the git root. Thanks to @klajdo-f for #677.
- Recognized structurally compatible custom editors in FleetView focus detection, restoring FleetView arrow-key activation and navigation when a custom editor has focus. Thanks to @magoz for #679.
- Scoped foreground fleet records to their originating parent session and propagated resolved model, thinking effort, and split input/output usage through live foreground controls.
- Matched fleet RPC filtering to the canonical session-file identity used by live async and foreground state.
- Kept pi-intercom stable IDs from leaking into child sessions and used the current intercom runtime ID for unnamed supervisor targets.
- Improved acceptance policy validation errors and tool-schema guidance for invalid evidence kinds. Thanks to @atimofeev for #672.
- Tolerated temporary steering inbox scan failures so pending steer requests can be retried on the next poll. Thanks to @hughcars for #670.
- Retried short, zero-activity child startup exits on the same model with bounded backoff, reducing concurrent subagent launch races without replaying model or tool work. Thanks to @felipeteodorocw for #671.
- Bounded streamed subagent progress snapshots so a long or deeply nested fan-out no longer emits a `tool_execution_update` line above the child-stdout protocol cap and gets the child killed with `protocol_output_limit`. Streamed `onUpdate` snapshots now carry compact tool-call summaries instead of the full message transcript, cap `recentTools`, and truncate `recentOutput` line length; the returned result and detached-exit recovery keep the full transcript. Thanks to @shaharmor for #680/#681.

## [0.37.2] - 2026-07-28

### Changed
- Reduced repeated scanning and file reads in live TUI rendering and skill loading.

### Fixed
- Passed `--no-context-files` to child Pi runs when an agent disables inherited project context, avoiding stale prompt-header parsing as Pi's context block format changes. Thanks to @KorenKrita for #667.

## [0.37.1] - 2026-07-27

### Added
- Added package-owned resume control to the extension RPC surface, including preserved revival metadata and native result-delivery controls. Thanks to @shaneconner for #656.

### Changed
- Added a generous 30-minute foreground wall-clock timeout when neither the call nor selected agent provides `timeoutMs`/`maxRuntimeMs`. Explicit call values and agent timeout defaults remain authoritative.
- Split the bundled `pi-subagents` skill into a short router plus focused reference files to avoid truncation and unnecessary context loading. Thanks to @peedrr for #659.
- Added `fleetViewPlacement` so the persistent FleetView can be placed above or below the editor. Thanks to @rtbe for #660.
- Refreshed the bundled `pi-subagents` skill for 0.35–0.37 control and config surface: `/subagents`, `/subagents-stop`, `/subagents-watchdog`, `stop`/`append-step`, parallel `count`, watchdog overview, frontmatter `async`/`timeoutMs`/`turnBudget` defaults, `artifactDir`/`asyncWidget`, fresh/fork badges, and builtin worker/delegate ambient-tool boundaries.

### Fixed
- Suppressed redundant local completion notifications after acknowledged grouped intercom delivery, while preserving fallback notifications when relay delivery is unavailable. Thanks to @Wiandono for #662.
- Stopped the persistent FleetView from refreshing through a stale extension context after session replacement or reload. Thanks to @kylegl for #657.
- Invalidated the live Fleet inspector before timer-driven refreshes so cached transcript frames do not repeat stale headers. Thanks to @shaneconner for #661.
- Removed repository write tools from the bundled planner and marked it read-only so planning-only runs cannot modify project files while producing `plan.md`. Thanks to @DrunkenDonkey80 for #664.
- Kept async child model inheritance stable after parent continuation so background launches keep using the authenticated parent provider/model. Thanks to @DrunkenDonkey80 for #663.
- Accepted persisted async recovery descriptors that include the launch contract digest written by async execution. Thanks to @boadij for #654 and #652.
- Classified verification-only tasks that prohibit product/source/config files as read-only. Thanks to @git-geeky for #648.
- Matched pi-mcp-adapter metadata cache identity so valid direct MCP tools are not rejected as stale when tool filters, socket transport, URL interpolation, or command-backed secrets are configured. Thanks to @mattrobenolt for #649.

## [0.37.0] - 2026-07-25

### Added
- Bound public launch preflight to versioned selected-agent definition digests, projected async lifecycle/status/result/process-terminal roots, and actual foreground/async execution digests in result and status metadata. Thanks to @shaggitza for #637.
- Added `subagents.defaultExtensions` for shared child extension allowlists and `agentOverrides.<name>.extensions` for per-agent settings. Thanks to chronoAP for #642.
- Added a public `pi-subagents/preflight` API that resolves an ordinary single-agent launch contract without creating child sessions, temp prompt files, structured-output runtimes, or run artifacts. Thanks to @shaggitza for #634.
- Added an out-of-band, session-scoped capability-ceiling API for monotonic child tool and extension restrictions, with inherited async/nested propagation and bounded audit metadata. Thanks to aoguai for #585.
- Added durable v3 process-terminal proof for detached async runners, with exact close observation, conservative unknown states after observer loss, and status/RPC projections. Thanks to shaggitza for #626.
- Added `subagents.defaultThinking` for project- or user-scoped default thinking levels on agents without explicit thinking settings. Thanks to corrius for #612.
- Documented that builtin worker and delegate agents use strict tool allowlists and do not inherit ambient parent extension tools; custom agents must explicitly name extension tools and load their providers. Thanks to buihongduc132 for #586.

### Fixed
- Preferred direct empty terminal-response evidence over stale tool errors so fallback models can retry abandoned child turns, and stopped treating successful tool output as a hidden failure. Thanks to Dmitry S. (@nuzayets) for #645.
- Separated evidence acceptance from independent review: evidence levels now end at `verified`, risky runs carry an orthogonal review requirement, `review-required` reports pending review while preserving `evidenceStatus`, and `reviewed` is reserved for achieved independent review. Explicit `reviewed` remains schema-recognized solely for actionable preflight recovery. Thanks to Theodor Hillmann (@t0dorakis) for #440.
- Bound public preflight launch digests to resolved skill injection metadata, matching execution when skill descriptions change.
- Classified missing resolved MCP direct tools as a host/pi-mcp-adapter child-registration problem while preserving strict fail-closed diagnostics. Thanks to peedrr for #638.

## [0.36.0] - 2026-07-24

### Added
- Added versioned aggregate handoff manifests for worktree-isolated parallel runs, including per-child status and output references, durable patch metadata, explicit cleanup outcomes, async status/result projection, and completion-delivery paths.
- Added delegation v2 for extension-owned concurrent foreground leaves, with logical run/node ownership, exact per-attempt cancellation, explicit duplicate-node outcomes, literal or structured values, effective model/thinking metadata, detailed usage, and an exact zero-tool budget while preserving delegation v1 and the model-facing single-dispatch guard. Thanks to Jakub Neumann (@neumie) for #610.
- Added acknowledged `steer` support to the extension RPC for exact-child async orchestration without recovery replacement. Thanks to Daan Bosch (@daanbosch) for #607.
- Added a persistent below-editor FleetView with safe empty-editor navigation and a structured inspector for Markdown, code, tool calls, and compact or expanded tool results. Thanks to Rui Pu (@Zeppelinpp) for #587.
- Added `artifactDir` config to store subagent artifacts in the project, Pi session, or temp artifact directory while keeping project-local artifacts as the default. Thanks to WeZZard (@WeZZard) for #582.
- Added opt-in `agentContract: { version: 1 }` runs with explicit execution, acceptance, review, and effects projections, report-optional acceptance, observational file-mutation effects, generic `outputSchema` plumbing, and `gateOn` chain controls while keeping the current/default contract unchanged. Thanks to mapleluv (@mapleluvr) for #499.
- Replaced the flat `/subagents` admin model, thinking, and agent pickers with a searchable, bounded-scroll selector docked in place of the editor, matching Pi's built-in `/model` picker so the current selection no longer scrolls off screen when the option list is long. Thanks to Chanyeong Lim (@asp345) for #568.
- Added `advisor` as an `oracle`-compatible bundled agent alias for users switching between Claude Code and Pi naming. Thanks to Serhii Chernenko (@serhii-chernenko) for #552.
- Show each subagent child’s resolved `[fresh]` or `[fork]` launch context in foreground results, async status, fleet, and widget surfaces, with `[mixed]` on aggregate headers when a run uses both modes.

### Fixed
- Kept explicit empty and MCP-only child tool allowlists from falling back to Pi's default builtin tools. Thanks to @jstokke for #628.
- Kept completed Fleet inspector durations stable when legacy terminal status lacks an explicit end timestamp, preventing time-sensitive redraws from changing rendered snapshots.
- Deferred strict child tool availability diagnostics until after child extension startup hooks, so tools registered asynchronously by child-only extensions no longer falsely fail as unavailable. Thanks to ConjugativeIndicator (@CovetingEpiphany2152) for #567.
- Made parent-facing subagent tool descriptions lead with delegation and clarified that `action` is omitted for execution. Thanks to @donwellsav for #600.
- Required `@earendil-works/pi-ai` 0.80.0 or newer because watchdog reviews import its `./compat` entrypoint, preventing background runs from loading on older hosts. Thanks to @donwellsav for #599.
- Removed evicted nested async status event files after the bounded cursor is written so old records are not rediscovered and replayed after the retention cap. Thanks to @mhbzhy-lost for #579.
- Counted provider-native `pi-checkpoint` commit changes as mutation evidence so CompletionGuard does not falsely fail Cursor SDK writer runs that already edited files. Thanks to Matias Gigena (@MatiasGigena) for #615.
- Re-derived foreground delegation structured-output hardening on current main: schema-bound runs now require the runtime-owned `structured_output` tool call, report `structured_output_failed`, preserve strict versioned hard-turn boundaries, and clean temporary protocol files when artifacts are disabled. Thanks to @dimahike for #571.
- Kept foreground slash execution commands responsive while their live result finalization continues asynchronously. Thanks to Eli Stark (@white-hat) for #594.
- Re-armed remembered detached foreground children on every blocking `contact_supervisor` request so targeted `subagent_wait` calls wake for repeated supervisor decisions.
- Suspended the persistent FleetView while its inspector overlay is open, preventing live status redraws from leaving repeated inspector frames in terminal scrollback.
- Kept simultaneous foreground parallel children independently visible with stable descriptions, metrics, lifecycle state, and transcripts.
- Avoided scanning and reconciling every historical async run when `subagent_wait({ id })` targets an exact run, preventing supervisor-attention waits from being delayed until the child completes.
- Routed independent strict v1 extension delegation requests through a correlated concurrent-safe executor while preserving the one-foreground-call-per-turn guard for the ordinary model-facing tool and non-versioned prompt-template requests. Thanks to Nova (@bianyeyu) for #565.
- Mapped sparse parallel slash progress updates by child index so one child’s live tool/output state no longer appears on another chain placeholder. Thanks to Eli Stark (@white-hat) for #595.
- Retried transient Windows filesystem locks while creating async result directories and stopped destructively recreating shared async directories during startup access checks, so concurrent Pi instances are less likely to lose completed async results to `EPERM` directory handles. Thanks to AiraNadih (@AiraNadih) for #566.
- Pruned broad agent and chain discovery roots so package-declared `.` scans no longer descend into `node_modules`, `.git`, Git submodules, or nested project roots during startup. Thanks to tupe12334 (@tupe12334) for #570 and shoehn (@shoehn) for narrowing the startup trace.
- Made `subagent_wait({ id })` wake when an async child is blocked in `contact_supervisor` for a supervisor decision, instead of waiting for completion or timeout. Thanks to @DrunkenDonkey80 for #581.
- Scoped async result delivery to the active session lease so stale watchers and recovered result files cannot wake or redeliver completions after reload, while retaining unaccepted result files for retry. Thanks to KawaiiNahida (@KawaiiNahida) for #588.
- Namespaced inherited relative agent output paths for foreground top-level parallel tasks so repeated builtin agents no longer collide before launch. Thanks to Artem Timofeev (@atimofeev) for #580.
- Use Pi's native editor for `/subagents` system-prompt editing so terminal editors receive terminal ownership and cannot leave a stale waiting status. Thanks to Prodipta Guha (@proguha) for #576.
- Bundled TypeBox as a production dependency so detached runners can always load `typebox/compile`, including managed extension installs where Pi's host package is not visible from the child process. Thanks to Matteo Collina (@mcollina) for #583.
- Updated the Pi development SDK to 0.81.0 and passed the watchdog stream through the renamed `Agent.streamFunction` option, preventing watchdog reviews from terminating with `streamFunction is not a function`. Thanks to Wang Zixiong (@XWIlluDelu) for #574.
- Documented that relative chain `output` paths are chain-artifact paths under `{chain_dir}`, with persistent `chainDir` and absolute `output` paths as the supported ways to keep artifacts outside the temp run directory. Thanks to @dougEfresh for #529.
- Bounded main-watchdog repository signatures so startup and agent-end checks no longer recurse through nested Git worktrees or generated dependency trees, reducing slow starts in large repos. Thanks to @pompanonb for #551 and @markg85 for #555.
- Raised the child stdout line limit above Pi’s resized-image payload range so image OCR subagents no longer fail with `protocol_output_limit` on valid `read` tool image events. Thanks to @zmarty for #538.
- Wrote an explanatory failure stub to output artifacts when a child run ends before producing output, so advertised `_output.md` breadcrumbs are no longer empty. Thanks to Mattias Petter Johansson (@mpj) for #547.
- Routed main watchdog reviews through matching provider-scoped `streamSimple` handlers before falling back to the compat dispatcher, restoring custom-provider watchdog models on newer Pi runtimes. Thanks to @alexei-led for #527.
- Kept async resume recovery descriptors from rejecting acceptance metadata written by earlier async runs, and now persist only the public acceptance input needed for safe revival. Thanks to Phil (@philliugithub) for #537.
- Made `subagent_wait({ id })` wake when a remembered detached foreground child reaches `needs_attention`, so headless parents can answer pending supervisor requests instead of waiting until timeout. Thanks to Mattias Petter Johansson (@mpj) for #554.
- Made `run-history.jsonl` and its agent directory owner-only where supported, redacted stored task prompts, and retained only a SHA-256 task hash for history correlation. Thanks to @avishkandi for #534.
- Registered the native child `intercom` fallback before strict tool-allowlist diagnostics run and stopped treating Pi core tools as missing extension tools, preventing read-only scouts and workers from failing before execution when strict child tool allowlists are active.
- Kept async oracle review tasks with implementation vocabulary from triggering write-evidence acceptance contracts or the no-mutation implementation guard.
- Added the missing `context: "fork"` field to the fork-context example in the bundled `pi-subagents` skill. Thanks to Kier (@kierr) for #540.
- Resolved host-provided TypeBox compiler lookup for detached async runners and structured-output validation. Thanks to @nistaux for #526, 96tommykim (@96tommykim) for #545, and @git-geeky and @lukechen526 for reproduction and validation details.
- Recognize Cursor edit/write thinking traces and replay tool calls as mutation evidence, so Cursor-provider workers that actually edit files no longer false-fail with `completed-without-making-edits`. Thanks to Mikhail Wijanarko (@mwijanarko1) for #539.
- Skip repository change signatures while the watchdog is disabled and inspect modified nested Git worktrees through Git, preventing startup from recursively hashing ignored submodule dependencies. Thanks to 傅洋 (@4ier) for #531/#532, tlhc (@tlhc) for #528, and 小旭 (@BigSharkLx) for #548.
- Stream detached foreground child tool and transcript activity through `subagent_wait({ id })` pending updates while waiting after supervisor handoff. Thanks to Dominic (@DevDominic) for #544.
- Stopped hashing the full content of very large changed/untracked files when computing the watchdog repo change signature, and made signature computation non-fatal, so `pi` no longer crashes at startup with `Failed to load extension … File size (N) is greater than 2 GiB` in repositories that contain files ≥ 2 GiB. Files larger than a threshold (64 MiB default, overridable via `PI_SUBAGENTS_MAX_HASH_FILE_BYTES`) are now fingerprinted by size and mtime instead of being read into memory. Thanks to Alexander Prilipko (@axelbaumlisto) for #553, @astarktc for #535, @restrolla for #536, and @pompanonb for #551.

## [0.35.1] - 2026-07-17

### Fixed
- Collapsed multiline management/status output behind a first-line preview and the configured expand-key hint. Thanks to Nikolay Panov (@niksite) for #523.

## [0.35.0] - 2026-07-17

### Fixed
- Updated Pi development packages and real-session SDK coverage to 0.80.10, removing known dependency audit findings. Thanks to dmg (@dmg-egg) for #520.
- `subagent({ action: "get" })` now honors `agentScope` for agent and chain details. Thanks to Kyle (@kylegl) for #519.
- Removed timer-driven foreground spinner redraws that repeatedly rendered the full Pi TUI and could survive session shutdown; running indicators now advance only with real progress updates.
- Exposed cumulative spawn-budget usage in status and doctor output, preflighted declared static work before partial launch, and added bounded root-interactive additive grants without changing unlimited or compaction semantics. Thanks to Mati Gummá (@matigumma) for #495.
- Skipped optional global npm package discovery while Pi is offline, avoiding `npm root -g` subprocesses during agent and skill discovery. Thanks to Rafiq Rashid (@rrvsh) for #506.
- Invalidated cached async status reads when a replacement changes file identity but reuses the same modification time, preventing steering and recovery from observing stale lifecycle state.
- Moved Pi-owned `@earendil-works/pi-tui` and `typebox` imports to optional wildcard peer dependencies while retaining exact dev versions for local and CI tests. Thanks to Alexei Ledenev (@alexei-led) for #510.
- Made steering pre-recovery acknowledgment and Windows async hard-kill regressions synchronize around their actual lifecycle boundaries instead of depending on CI scheduler or process-start timing.
- Added YAML folded block scalar support for agent and chain frontmatter descriptions, preserving quoted indicators, more-indented content, and blank-line separators. Thanks to Luis Cinco (@tekniko24) for #488.
- Accepted simple-scalar newline block lists in agent frontmatter for tools, reads, skills, skill paths, fallback models, and extensions while preserving comma-separated syntax. Thanks to klopket (@klopket) for #507.
- Distinguished interactive async yielding from headless auto-drain guidance, so interactive sessions return control by default while non-interactive sessions retain a completion path. Thanks to Luke Chen (@lukechen526) for #480.
- Deferred hard turn-budget termination when an assistant starts tool work at the limit, exposing `termination-deferred` until the next safe assistant boundary while elapsed timeout and explicit stop retain precedence. Guidance now conservatively keeps hard turn and tool-call caps off mutation-capable workers. Thanks to JT (@juicetin) for #482 and #483.
- Prevented watchdog idle notices while a child tool is actively running and made top-level live async `resume` a non-destructive error that directs callers to `steer`; paused, completed, or failed children retain current-session-scoped revival behavior, while stopped runs remain non-resumable. Thanks to Vlad Bereznyuk (@vrolok) for #496 and #497, and @wiansapu for confirming #496's user impact.
- Disposed pending completion-notification timers during extension reload and session shutdown so stale runtimes cannot send delayed messages. Thanks to Alexander Penkin (@SSS135) for #489.
- Removed the hidden default limit of 40 cumulative subagent launches per session. Sessions are unlimited unless a positive `maxSubagentSpawnsPerSession` or `PI_SUBAGENT_MAX_SPAWNS_PER_SESSION` cap is configured; `0` explicitly means unlimited. Thanks to @Maverobot, @KawaiiNahida, and @markng for the follow-up reports on #239.
- Fork-context sanitization no longer disables thinking for every child. Forking over a transcript with signed Anthropic thinking blocks now classifies each child’s effective primary and fallback models through registry provider/API metadata, forces thinking off for Anthropic-backed or unresolved candidates, and reports every downgrade even when the run fails. Other resolved providers keep their requested thinking level. The tool description also documents thinking suffixes, including `max`, and the fork/thinking interaction. Thanks to Jeff (@jefftheai) for #476.
- Nested subagent activity snapshots now render event-time timestamps from result-owned foreground children across single, parallel, and chain runs without a continuously advancing clock. Thanks to James Wood (@jamesjwood) for #486.

### Added
- Added `/subagents` as a compact interactive administration flow for inspecting agents, selecting models and supported thinking levels, and editing system prompts in an external editor. Edits persist to the owning frontmatter or settings override layer, and model choices refresh the registry before display. Thanks to Benedict Evert (@dt-benedict) for #498.
- Added a versioned `pi-subagents/background-work` provider contract so `subagent_wait` can track exact current-session jobs from other extensions without count races. Child runtimes can expose the wait tool through their strict allowlist, effective wait config is propagated to every child launch path, and headless sessions drain active work before ending. Thanks to RoboBryce (@robobryce) for #472 and #473.
- Added a typed v1 foreground delegation contract for extension consumers through the existing `prompt-template:subagent:*` transport, with strict bounded controls, structured terminal states, cancellation, and a supported `pi-subagents/delegation` package export. Thanks to JT (@juicetin) for #465 and #467.
- Added `acceptanceRole: read-only | writer` to agent frontmatter, settings overrides, and agent management so custom agent names can declare automatic acceptance semantics. Explicit task mutation or no-edit intent wins, while omitted metadata preserves the existing name heuristics. Thanks to Taylor C Jensen (@taylorcjensen) for #466.
- Added acknowledged async steering: action `steer` returns a correlated request id and waits up to three seconds for child-Pi input acceptance, supports scheduled pending children, records a bounded steering ledger, and fail-closed single-run recovery after confirmed pause within a further 15-second bound. Chain, parallel, and nested runs report per-child partial/failure states without automatic interruption.
- Added a native, live-refreshing, inspection-only fleet opened by `/subagents-fleet` or `Ctrl+Alt+F`, with current-session foreground and recent async child navigation, transcript detail, and completed output/session paths. The textual status view remains available without a TUI, while stop, steer, and resume stay in explicit commands. Thanks to Jakub Neumann (@neumie) for #454 and Manfred Liiv (@manfredlift) for #412.
- Added `asyncWidget: false` to disable the above-editor background-run widget for companion footer/dashboard extensions, and exposed the workflow-level `goal` on `subagent:async-started` lifecycle events.
- Added agent-local `skillPath` discovery so custom agents can select private skills without publishing them to Pi's parent/global catalog. Relative paths resolve from the defining agent file, local matches take precedence, and missing or unreadable candidates fall back to normal discovery. Thanks to Kylegl (@kylegl) for #428.
- Added strict `acceptance` defaults in agent frontmatter and agent management. The default applies only to single-agent launches, explicit call values win, and chain/parallel acceptance remains task or step configuration. Thanks to ConjugativeIndicator (@CovetingEpiphany2152) for #453.
- Added canonical-session leases for direct child revival so independent parent processes cannot write the same persisted session concurrently. Lease ownership includes the revived/source run, parent session, runner and writer process identities, and host; a two-phase startup handshake rejects contention before Pi starts, and stale recovery remains conservative. Thanks to Luke Parke (@LukasParke) for #446.
- Added single-agent launch defaults for `async`, `timeoutMs`, and `turnBudget` in agent frontmatter, with explicit tool-call values taking precedence. Thanks to ConjugativeIndicator (@CovetingEpiphany2152) for #410.
- Added `/subagents-stop` and `subagent({ action: "stop", id })` for current-session top-level async runs. The slash command opens a confirmation selector when no id is provided, falls back to exact commands without a TUI, routes scheduled jobs through `schedule-cancel`, and records manual stops as `stopped`/cancelled lifecycle events instead of timeouts. Thanks to Sean Seaman (@seans-leadsonline) for #407 and #408.
- Added an opt-in read-only subagent watchdog that reviews actual repo edits at safe agent-end boundaries, with visible warnings, main and child watchdog coordination, strong complementary model recommendations, changed-file TypeScript/JavaScript LSP diagnostics, `/subagents-watchdog` status/model commands, and agent-facing watchdog configuration actions. Thanks to can1357/oh-my-pi for the advisor/watchdog concept, and to apmantza/pi-lens, gjczone/pi-shazam, and can1357/oh-my-pi for LSP diagnostics patterns.
- Added a chain quick-reference (sequential, parallel fan-out, and mixed examples) to the `subagent` tool description in both full and compact modes so agents have the correct nested schema format up front. Thanks to Nicolas Marchildon (@elecnix) for #417 and #424.

### Changed
- Updated the bundled `pi-subagents` skill so Fable mode is the default orchestration posture for complex work, and refreshed recent command/config guidance.
- Documented `contact_supervisor` structured interview requests in the default child bridge instructions.

### Fixed
- Moved the published extension entrypoint to the package root so Pi displays the startup label as `pi-subagents` instead of an internal source path. Thanks to Ramin Hazegh (@rhazegh) for #475.
- Accepted empty optional `manualNotes` and `notes` strings in acceptance reports while retaining the `manual-notes` evidence requirement when configured. Thanks to Nick Tripp (@nicholastripp) for #474.
- Kept explicit child tool allowlists strict while surfacing actionable errors when named extension tools are requested without a loaded provider. Internal `structured_output` is now admitted automatically when an output schema is active, and direct and chained children share the same registry check. Thanks to DesertThief (@DesertThief) for #429 and Chris-Kode (@Chris-Kode) for confirming the structured-output case.
- Prevented model fallback retries for trailing child tool failures even when their details resemble provider outages, and retried provider streams that end without `finish_reason`. Thanks to 虚妄IlluDelu (@XWIlluDelu) for #436.
- Recognized Pi's `max` thinking level in child model suffixes, Clarify selection, watchdog settings, and status formatting, while exposing it only when model metadata explicitly supports it. Thanks to mapleluv (@mapleluvr) for #423.
- Labeled every chain-clarification shortcut with its action, made the background state explicit, and kept primary actions in a separate footer without widening the fixed 84-column overlay. Thanks to GonzaloRocca (@gonzalonicolasr) for #430.
- Hardened acceptance reports so explicit empty changed-file and test arrays are treated as not applicable, required criteria are reflected in examples, known model-output variants normalize to one strict canonical shape, unknown or ambiguous values fail with exact diagnostics, and parsed reports plus ledgers persist in child metadata while normal output stays clean. Thanks to Nick Tripp (@nicholastripp) for #442, maxsturmb (@maxsturmb) for #452, and techmodv90 (@techmodv90) for #449 and #450.
- Shared task-intent classification between acceptance inference and the completion guard so read-only tasks with explicit no-edit wording do not receive impossible write-evidence gates, while scoped prohibitions still preserve later implementation clauses. Thanks to 虚妄IlluDelu (@XWIlluDelu) for #433.
- Rejected explicit `acceptance: "reviewed"` and `{ level: "reviewed" }` before launch because the current run cannot supply the required independent reviewer result; inferred and `auto` review policies remain non-blocking. Thanks to Theodor Hillmann (@t0dorakis) for #440 and #441.
- Rejected bare `acceptance: "none"` before spawning because disabling inferred gates requires the reason-bearing `{ level: "none", reason: "..." }` form; retained `false` only as a deprecated shorthand. Thanks to 虚妄IlluDelu (@XWIlluDelu) for #435.
- Canonicalized native `fs.watch` registration paths for async results, control inboxes, and child steering inboxes so Windows 8.3 short paths do not conflict with long-form libuv event paths. Thanks to NahidaChan (@KawaiiNahida) for #455.
- Made configured output instructions capability-aware: read-only children now return the complete artifact for runtime persistence instead of treating an unavailable write tool as a supervisor blocker. Thanks to Alexander Gerdes (@Avg8888) for #426.
- Bounded live child JSONL lines and stderr tails in foreground and async runners, preserving split UTF-8 and final unterminated events while returning structured `protocol_output_limit` failures for oversized lines. Completion now honors `agent_end.willRetry` and prefers `agent_settled` without removing the legacy terminal-message fallback. Thanks to Luke Parke (@LukasParke) for #444 and #445.
- Made `subagent_wait({ id })` track remembered detached foreground runs, defer acceptance until the child exits, and wake the originating session with recovered output so parents do not launch duplicate replacements after supervisor coordination. Thanks to Ramin Hazegh (@rhazegh) for #456.
- Renamed the parent blocking tool from `wait` to `subagent_wait` with no legacy alias, avoiding startup conflicts with unrelated extension wait tools. Thanks to DesZhang (@DesZhang) for #437 and Nate Rutman (@nrutman) for confirming the conflict and clarifying the incompatible semantics.
- Reused the verified current or installed Pi CLI on POSIX instead of resolving a potentially missing or different `pi` from `PATH`. Thanks to Luke Parke (@LukasParke) for #443.
- Preserved `{outputs.name}` as literal task text in async single runs while keeping named-output interpolation for real chains. Thanks to Tristan Storch (@tstorch) for #427.
- Recovered acceptance reports from child-written configured outputs, honoring file-only source precedence and surfacing malformed primary reports. Thanks to 虚妄IlluDelu (@XWIlluDelu) for #434.
- Isolated inherited output files for async parallel siblings and rejected duplicate resolved output paths before launch, preventing silent report loss. Thanks to basher83 (@basher83) for #420.
- Replaced raw chain-schema failures with actionable errors that name invalid properties, list allowed fields, and show valid examples. Thanks to Nicolas Marchildon (@elecnix) for #416 and #425.
- Hide lower-priority agent definitions from `subagent({ action: "list" })` when a higher-priority project or user agent shadows them. Thanks to Kylegl (@kylegl) for #415.
- Resolve the real Pi CLI on Windows when pi-subagents runs inside an embedded SDK host instead of relaunching the host application's entry point. Thanks to Marc Kassubeck (@CompN3rd) for #413.
- Avoid rendering active subagent activity as `now ago`. Thanks to Viktor Chernodub (@chernodub) for #414.
- Preserve async resume model/thinking metadata for live, completed, and result-only child runs, and repair stale status metadata from final results. Thanks to BoxChen (@nishuzumi) for #403.
- Gate foreground `contact_supervisor`/intercom detaches on delivered supervisor handoff events, keep detached foreground runs visible through status/fleet, and mark detached placeholders as non-successful so missing explicit outputs are not mistaken for completed work.

## [0.34.0] - 2026-07-07

### Added
- Added `waitTool` config and `PI_SUBAGENT_WAIT_TOOL_ENABLED` so interactive users can keep the `subagent_wait` tool registered while making it return immediately instead of blocking on background subagents. Thanks to Rebecca Dessonville (@TwistedTabby) for #394.

### Fixed
- Coerce agent frontmatter `thinking: false` to disabled thinking so child model IDs do not gain invalid `:false` suffixes. Thanks to Alberto Vasquez (@albertovasquez) for #399.
- Suppress stale native supervisor-channel asks after replies, expiry, or inactive child runs, and clean cancelled child requests so `subagent_supervisor` and visible intercom notices stay aligned. Thanks to Artem Timofeev (@atimofeev) for #393.
- Avoid completion-guard failures for read-only issue-drafting tasks that mention suggested fixes while preserving mutation expectations for real implementation tasks. Thanks to Artem Timofeev (@atimofeev) for #395.
- Prune stale empty native supervisor-channel directories before polling while preserving fresh or non-empty channels. Thanks to Koen Van Geert (@koenvg) for #400.

## [0.33.1] - 2026-07-03

### Fixed
- Avoid native supervisor-channel tool conflicts when `pi-intercom` is also installed by deferring native tool registration until runtime startup and keeping a namespaced native supervisor reply tool.

## [0.33.0] - 2026-07-03

### Added
- Added optional `toolBudget` limits for child subagent tool calls. Runs, steps, and agents can set `{ soft?, hard, block? }`; the child runtime nudges at the soft limit and blocks configured tools after the hard limit so runaway browsing can still finish with final text. Thanks to Jürgen Schmied (@jschmied) for #379.
- Added a stable v1 in-process event-bus RPC for other Pi extensions, with `ping`, `status`, async-only `spawn`, `interrupt`, and async `stop` over versioned request/reply envelopes.
- Added `toolDescriptionMode` with `full`, `compact`, and `custom` modes for the parent-facing `subagent` tool description. Compact mode reduces prompt bloat while keeping safety-critical orchestration guidance, and invalid custom descriptions fall back to full mode.
- Added an optional read-only subagent fleet/status view with `/subagents-fleet` and `subagent({ action: "status", view: "fleet" })`, plus `view: "transcript"` to tail active async child output/session artifacts.
- Added uniform per-child transcript artifacts (`<run>_<agent>_transcript.jsonl`) for foreground and async subagent runs, gated by `subagents.artifacts.includeTranscript` (default on). Each transcript is a versioned JSONL stream of child messages, tool starts/ends, and stdout/stderr lines with a byte cap and truncation marker.
- Added `subagent({ action: "steer", id, message, index? })` for non-terminal guidance to live async Pi child sessions, with file-backed control requests, per-child steering inboxes, status/event visibility, and queued delivery for pending indexed async children when the runtime supports mid-run steering.
- Added an optional `turnBudget` (`maxTurns` with `graceTurns`) for foreground and async/background subagent runs. At the soft `maxTurns` limit the child is warned via its system prompt to wrap up; after `graceTurns` additional assistant turns the run is aborted and partial output is returned. `turnBudget`, `turnBudgetExceeded`, and `wrapUpRequested` propagate through results, async status, and nested summaries.
- Added optional scheduled subagent runs so callers can defer a subagent launch until a future time. `subagent({ action: "schedule", agent, task?, schedule: "+10m" | "2030-01-01T09:00:00Z", scheduleName? })` arms a one-shot timer that launches the run as a normal tracked async run once it fires, with `schedule-list`, `schedule-status`, and `schedule-cancel` management actions. Schedules are persisted per session and restored after a Pi restart; jobs missed by more than the configured lateness window are marked `missed` instead of firing late. The feature is opt-in and requires `{ "scheduledRuns": { "enabled": true } }` in `~/.pi/agent/extensions/subagent/config.json`. Only schedule explicit delayed runs the user asked for. Thanks to @tintinweb for the concept.
- Added a real Pi-session E2E test lane with faux provider routing to verify parent-child subagent result delivery without network model calls.
- Hardened the `wait` tool's wake path so an event wake cancels its poll-interval fallback timer instead of letting both run, and so an already-aborted turn resolves immediately. Added a test that verifies an event wakes `wait` before the poll interval elapses.
- Added smart completion batching for async subagent notifications. Successful sibling completions that finish within a short window now arrive as a single grouped message instead of separate notifications; a hard max-wait cap prevents holding them indefinitely, and late-finishing siblings join a shorter straggler group. Failed and paused completions bypass batching and fire immediately so failure and attention signals are never delayed. The debounce window, max-wait cap, and straggler windows are configurable via `completionBatch` in `config.json`.
- Added `subagent({ action: "eject" })`, `disable`, `enable`, and `reset` management actions for bundled and custom agents. `eject` copies a builtin or package agent to user/project scope as an editable custom file that shadows the original; `disable`/`enable` toggle a reversible `agentOverrides.<name>.disabled` settings override without deleting the agent; `reset` removes the scope's custom agent file and/or settings override to restore the bundled default. All four accept `agentScope: "user" | "project"` (default `user`) and are blocked from child-safe fanout mode alongside `create`/`update`/`delete`.
- Added fuzzy model resolution so callers can specify models with provider separator variations, optional date-stamp parts, and case differences instead of exact `provider/modelId` strings. When `subagents.modelScope: { enforce: true, allow: [...] }` is configured, explicit caller-supplied out-of-scope models error while frontmatter/parent-inherited/fallback models warn. Inspired by @tintinweb's pi-subagents.
- Added a parent-side `wait` tool for detached async subagent runs. `wait()` returns when the next active run finishes or needs attention, `wait({ all: true })` drains all active runs, `wait({ id })` targets one run, and `wait({ timeoutMs })` caps the block. This lets background-launching skills and non-interactive `pi -p` runs keep going without sleep/status-polling loops or abandoned children. Thanks to RoboBryce (@robobryce) for #365.
- Added an opt-in `memory` frontmatter field for agent definitions so recurring custom agents can maintain role-specific durable memory (e.g. a security reviewer accumulating threat-model notes). `memory: { scope: "project" | "user", path: "<name>" }` resolves a safe `agent-memory/` directory, injects the first 200 lines of a `MEMORY.md` into the child system prompt, and falls back to a read-only memory block for agents without write tools. Memory lives under a dedicated namespace that does not conflict with Pi's parent/session/project memory system. Inspired by @tintinweb's pi-subagents.
- Added native supervisor coordination for child subagents. Children can use `contact_supervisor` without installing `pi-intercom`, and parent-side requests are scoped to the exact session id that spawned the child.
- Added native prompt workflow commands: `/prompt-workflow` runs a prompt template through a subagent, and `/chain-prompts` turns prompt templates into native subagent chain steps.

### Fixed
- Let foreground sequential chain tool calls launch directly when `clarify` is omitted; use `clarify: true` to opt into the clarify UI. Thanks to neander-squirrel (@neander-squirrel) for #385.
- Tolerate execution-mode action aliases such as `single`, `parallel`, `PARALLEL`, and `tasks` when the matching execution fields are present, while preserving clear runtime errors for unknown management actions. Thanks to Artem Timofeev (@atimofeev) for #382.
- Removed companion-package recommendation messages from session start, `subagent({ action: "list" })`, and `/subagents-doctor`. Thanks to Mark Gaiser (@markg85) for #381.
- Recover detached foreground subagent results after intercom handoff so completed detached runs remain visible to status and resume paths. Thanks to Artem Timofeev (@atimofeev) for #384.
- Scope async subagent completion notifications to the exact owning Pi session so another session in the same repo no longer receives result notices.
- Harden scheduled-run timestamp parsing and persisted store validation so ambiguous absolute times and corrupted job records fail clearly instead of being normalized or dropped.
- Derive live-detail and full-notification hints from Pi's configured expand key instead of hard-coding `Ctrl+O`. Thanks to Kylegl (@kylegl) for #364.
- Tolerate transient Windows `EPERM`/`EBUSY`/`EACCES` locks when atomically replacing async JSON files. Thanks to ThanhNT29Jacky (@ThanhNT29Jacky) for #380.
- Hardened the async timeout integration test to wait for the mock child to spawn before asserting the timeout result, fixing a race where the timeout could fire before the child existed.

## [0.32.0] - 2026-07-01

### Added
- Added `subagents.defaultModel` so subagents can have a global default model separate from the parent session model. Thanks to Artem Timofeev (@atimofeev) for #339.
- Added `/subagent-cost` and `totalChildUsage` run details so parent sessions can inspect aggregate subagent child usage and cost. Thanks to Aaron Ky-Riesenbach (@aaronkyriesenbach) for #343.
- Added configurable companion package recommendations for `pi-intercom` and `pi-prompt-template-model`, surfaced in session-start transcript messages, `subagent({ action: "list" })`, and `/subagents-doctor`, with `/subagents-companions` hide/show/status controls. Removed again in the next release after #381 because context-visible package recommendations were too noisy.
- Added detached async runner stdout and stderr log files. Thanks to Daniel Mateos Carballares (@danim47c) for #358.
- Added `totalCost` rollups to foreground single, parallel, and chain run details, including nested foreground subagent costs and compact progress display. Thanks to Clark Everson (@gr3enarr0w) for #345.
- Added `globalConcurrencyLimit` to cap simultaneously running subagent tasks across parallel groups in a single run. Thanks to Clark Everson (@gr3enarr0w) for #349.
- Added stable v1 async lifecycle artifact metadata in `status.json`, `events.jsonl`, and result JSON so observability and workflow gates can correlate subagent runs without scraping terminal output. Thanks to Clark Everson (@gr3enarr0w) for #350.
- Added `PI_SUBAGENT_PI_BINARY` to let wrappers launch child agents through an explicit Pi binary instead of resolving `pi` from `PATH`. Thanks to David Barroso (@dbarrosop) for #341.
- Added `worktreeBaseDir` and `PI_SUBAGENTS_WORKTREE_DIR` so worktree isolation can use a stable trusted base directory. Thanks to Matt Robenolt (@mattrobenolt) for #185.
- Added `singleRunOutputBaseDir` so single-agent relative outputs can be routed to a configured artifact directory. Thanks to Oleksii Nikiforov (@NikiforovAll) for #173.
- Added `maxSubagentSpawnsPerSession` and `PI_SUBAGENT_MAX_SPAWNS_PER_SESSION` to cap total subagent launches in one session. Thanks to @eightHundreds for #239.
- Enforce `timeoutMs` and `maxRuntimeMs` on async and background subagent runs. The per-launch deadline drives an AbortController that cancels acceptance verification, imported async roots, and fallback retries; direct children get SIGTERM with SIGKILL escalation on a bounded timer; nested descendants get timeout requests distinct from manual interrupt. `timedOut`, `deadlineAt`, and `error` propagate across status, results, and nested summaries. Thanks to @pkese for #361.

### Fixed
- Keep generated subagent markdown outputs, progress files, and run artifacts under the project-local `.pi-subagents/` directory by default. Thanks to Carolina (@carolitascl) for #326.
- Detach foreground subagent runs immediately when a child starts a blocking `contact_supervisor` or `intercom.ask` call, avoiding parent/child intercom deadlocks. Thanks to huarkiou (@huarkiou) for #335.
- Made child boundary prompt editing instructions tool-agnostic so Codex-style adapters are not told to call unavailable `edit`/`write` tools. Thanks to Artem Timofeev (@atimofeev) for #338.
- Recursively interrupt active async parallel children and nested async descendants when pausing a background run. Thanks to Vicary (@vicary) for #355.
- Avoid runtime peer imports from detached async runners while still forwarding the Pi package root when available. Thanks to @aurbina83 for #352 and @huangkun3251 for #342.
- Fall back to PATH `node` for async runners when the current Node executable path is stale or deleted. Thanks to Richard Hao (@0xRichardH) for #347.
- Retry fallback models when a zero-exit subagent attempt produces no output, including background async runs, preserve structured-output-only completions, and pre-warm forked session files for parallel children. Thanks to Clark Everson (@gr3enarr0w) for #344.
- Preserve explicit empty companion suggestion surfaces and keep global companion suggestions disabled when writing package dismissal state.
- Include bounded async runner stderr tails when stale-run reconciliation marks a startup crash failed. Thanks to Salem Sayed (@salemsayed) for #340.
- Persist forked child session files when Pi returns a branch path before writing it to disk. Thanks to @trisforrestcam for #174.
- Pass explicit `thinking: off` through to child model arguments as a `:off` suffix. Thanks to Thomas Dietert (@tdietert) for #147.
- Sanitize Anthropic signed `thinking` / `redacted_thinking` blocks out of forked child sessions and force child thinking off so fork-context subagents survive signed-thinking transcripts after branching or compaction. Thanks to Thomas Dietert (@tdietert) for #147.
- Restore queued and running detached async jobs into the widget after restarting Pi. Thanks to Vicary (@vicary) for #362.
- Fix session-start freeze where restoring active async jobs did O(runs × nested-route-dirs) directory scans over stale terminal runs; `listAsyncRuns` now builds a single nested-route index and filters by state before lookup.

## [0.31.1] - 2026-06-25

### Added
- Added `/chain` inline parallel groups with per-step metadata, group options, and tab completion. Thanks to loss-and-quick (@loss-and-quick) for #312.
- Added subagent profile commands and provider model catalog generation for quota and quality model profiles. Thanks to tencnivel (@tencnivel) for #333.

### Fixed
- Discover `pi-intercom` installations created by `--extension npm:pi-intercom` under Pi's temporary npm extension cache. Thanks to loss-and-quick (@loss-and-quick) for #336.
- Made async subagent interrupt, steer, and stop requests portable across platforms that do not support Unix signals. Thanks to AeonDave (@AeonDave) for #332.
- Hardened profile commands by probing models without tools, rejecting unsafe profile/provider path tokens, and resolving short model IDs and thinking suffixes against the current registry.
- Limited inline `/chain` acceptance values to levels expressible in slash syntax and kept completion disabled inside shared `--` tasks with literal parentheses.

## [0.31.0] - 2026-06-24

### Added
- Added `subagents.disableThinking` so bundled builtin agents can drop thinking suffix defaults for providers that do not accept them. Thanks to Joshua Harding (@jhstatewide) for #212.
- Discover nested grouped skills such as `.pi/skills/group/name/SKILL.md` so subagents match the host runtime's recursive skill lookup. Thanks to Weaxs (@Weaxs) for #262.
- Follow Pi's configured project config directory for project-local agents, chains, skills, packages, settings, direct MCP config, and intercom package discovery instead of hardcoding `.pi`, while retaining `.pi` as the fallback for older Pi versions.

### Changed
- Hardened npm installs by tracking `package-lock.json`, pinning direct dependencies, and using `npm ci --ignore-scripts` in CI and release workflows. Thanks to Modestas Vainius (@modax) for #234.
- List configured subagent skills by name, description, and file path instead of inlining full skill bodies, and ensure tool-restricted children can read those skill files on demand. Thanks to Ruben Paz (@Istar-Eldritch) for #183.

### Fixed
- Resolve the async result watcher directory with `fs.realpathSync.native()` before `fs.watch()` so Windows profiles with 8.3 temp paths do not crash Pi when async subagent results arrive. Thanks to kerushidao (@kerushidao) for #254.
- Accept structured acceptance reports emitted in JSON-family fences when the fenced body has the acceptance-report shape. Thanks to Suleiman Tawil (@stawils) for #253.
- Report field-level acceptance-report validation errors instead of a generic parse failure, and clarify array element types in the acceptance prompt. Thanks to Whisperfall (@Whisperfall) for #264 and josephkEA (@josephkEA) for the follow-up reproduction.
- Simplified the public `acceptance` and chain tool schemas so Kimi/Moonshot-style parsers can load `subagent`, while runtime validation still rejects malformed acceptance config and dynamic fanout steps. Thanks to Sergio Agosti (@sergio-agosti) for #249.
- Reject duplicate concurrent `subagent` execution calls while a prior subagent dispatch is still in progress, keeping intentional parallel mode within a single call unchanged. Thanks to desideratum (@desideratum) for #247.
- Bound async `events.jsonl` growth by dropping noisy child `message_update` snapshots, capping persisted child diagnostics, and scanning control events in chunks during status polling. Thanks to Tri Van Pham (@pvtri96) for #246.
- Keep crowded async subagent widgets at a stable collapsed height in short terminals, reducing destructive full-screen TUI redraws and flicker. Thanks to ssyram (@ssyram) for #186.
- Actually wire the previously documented foreground-only `timeoutMs`/`maxRuntimeMs` aliases through single, parallel, chain, and dynamic fanout runs, including stable `timedOut: true` results, preserved partial output, manual-interrupt precedence, and skipped acceptance verification after timeout.
- Apply `subagents.agentOverrides.<name>` to matching user-scope and project-scope custom agents, while keeping explicit agent frontmatter authoritative per field. Thanks to Jacek Juraszek (@jjuraszek) for #218.
- Preserve compact foreground `write`/`edit` tool-call evidence in prompt-template delegation responses so convergence checks do not stop loops early. Thanks to Hans Schnedlitz (@hschne) for #207.
- Respect each agent's `defaultContext` in mixed parallel and chain subagent calls when no explicit `context` is provided, so fresh-default scouts no longer inherit forked parent transcripts just because another agent in the same invocation defaults to fork. Thanks to Mitch Fultz (@fitchmultz) for #228.
- Make runtime `output` overrides authoritative in child task and system prompts, and remove stale static filenames from bundled output-format instructions. Thanks to youngshine (@smithyyang) for #223.
- Keep top-level parallel `defaultProgress` files in run-scoped artifact storage instead of the parent working directory. Thanks to youngshine (@smithyyang) for #224.

## [0.30.0] - 2026-06-20

### Added
- Allow active async chains to accept an `append-step` request that adds one new tail step while the chain is still running.
- Allow async subagent results to be attached as the root step of a new follow-up chain.
- Added `subagentOnlyExtensions` so agents can pass selected tool extensions only to spawned subagents without exposing them to the parent agent.
- Added proactive skill-subagent suggestions to `subagent({ action: "list" })` based on repeatedly configured skill use, while keeping the behavior advisory and opt-out friendly.
- Added regression coverage for long worker/reviewer chains and parallel -> funnel -> fanout chain flows across foreground and async execution.

### Fixed
- Interrupt live async children before delivering `resume` follow-up messages so intercom nudges reach workers that are stuck mid-turn more reliably.
- Reject appended chain steps with duplicate reserved output names or unknown named-output references before they are queued.
- Ignore legacy `.agents/skills` files during agent discovery so skill definitions are not registered as subagents. Thanks to chyax98 (@chyax98) for #257.
- Launch detached async runners through Node when Pi itself is not the Node executable. Thanks to Tetsuya.dev (@tetsuya-dev-jp) for #273.
- Preserve the slash command requester context when bridge requests launch subagents. Thanks to Victor Sumner (@vsumner) for #268.
- Trim repeated nested `subagent` tool schema descriptions so provider payloads stay compact while retaining top-level parameter guidance. Thanks to Thomas Mustier (@tmustier) for #250.

## [0.29.0] - 2026-06-19

### Added
- Added package-provided agent and chain discovery from installed Pi packages and package settings, including read-only management behavior, package source counts in doctor output, nested-cwd project package discovery, and package definitions that remain below user/project overrides. Thanks to Fabian Jocks (@iamfj) for #278.
- Added `PI_SUBAGENT_EXTRA_AGENT_DIRS` and `PI_INTERCOM_EXTENSION_DIR` overrides so bundled agents and `pi-intercom` can be loaded from read-only package locations. Thanks to David Barroso (@dbarrosop) for #288.

### Fixed
- Show captured output from failed foreground subagents instead of returning only the failure summary. Thanks to Jürgen Schmied (@jschmied) for #277.
- Preserve nested fanout child subagent history when building child prompts. Thanks to James Wood (@jamesjwood) for the original #270 fix.
- Retry Windows atomic JSON renames on transient `EPERM`, `EBUSY`, and `EACCES` failures. Thanks to Wings Butterfly (@wings1848) for #269.
- Inherit the parent session model for subagents instead of falling back to global settings, including foreground, chain, async chain, async single, and resume/revive paths. Thanks to Rogerio Saulo (@rsaulo) for #266 and Nicolas Marchildon (@elecnix) for the original #283 fix.
- Avoid duplicate `subagent` tool registration in fanout-authorized child processes. Thanks to Aleksei Gurianov (@Guria) for #279.
- Hardened the parallel intercom integration test fixture after Windows CI exposed nondeterministic failure ordering.

## [0.28.0] - 2026-06-03

### Added
- Added foreground-only `timeoutMs`/`maxRuntimeMs` for single, parallel, and chain subagent runs. Timed-out children are soft-interrupted, keep completed sibling/prior results, and return `timedOut: true` with a stable timeout message.
- Added per-agent `maxExecutionTimeMs` and `maxTokens` resource limits. Foreground and async children stop with a clear `resourceLimitExceeded` result when the configured runtime or observed token budget is reached.

### Changed
- Strengthened tool and skill guidance so writer subagents launched from plans, specs, issues, or broad fixes proactively use structured `acceptance` instead of burying validation requirements only in task prose.

### Fixed
- Removed a provider-unfriendly required-only subschema from the public `acceptance` tool schema so Kimi models served through OpenCode Go can load the `subagent` tool, while keeping runtime validation for empty acceptance contracts.
- Clarified acceptance-report prompts so required evidence like `diff-summary` must be copied into structured JSON fields such as `diffSummary`, not only described in visible prose.

## [0.27.0] - 2026-05-30

### Changed
- Reworked public acceptance config to be object-only and evidence-driven, removing public `level`/disable shorthands. Explicit acceptance now triggers a same-session self-review/repair finalization loop, with `maxFinalizationTurns` controlling the cap.
- Documented goal-style acceptance guidance so `/goal`, “active goal”, and “work until evidence says done” requests map to run-scoped `acceptance` contracts.
- Refined acceptance finalization prompts and status output to emphasize evidence, blockers, stop rules, and finalization progress such as `completed after 1/3 turns`.

### Fixed
- Treat explicit acceptance as the completion contract for acceptance-enabled runs, avoiding implementation completion-guard false positives when the visible output is only an `acceptance-report` or a finalization self-review turn does not need a repair edit.

## [0.26.0] - 2026-05-29

### Added
- Added first-wave acceptance gates with optional public `acceptance` config, inferred effective policies, structured child reports, provenance ledgers, checked evidence gates, explicit runtime verification commands, async/status persistence, and saved `.chain.json` validation.
- Added chain step metadata (`phase`, `label`), named outputs (`as` with `{outputs.name}`), workflow graph snapshots, and strict `outputSchema` structured-output contracts across foreground and async chain execution.
- Added dynamic chain fanout with `expand`/single-template `parallel`/`collect`, structured named-output sources, bounded item expansion, collected result outputs, async status graph persistence, and saved `.chain.json` support.

### Fixed
- Fixed dynamic fanout acceptance blockers around real `structured_output` tool validation, malformed dynamic-like chain rejection, async dynamic failure status/details, dynamic child intercom target indexing, and saved `.chain.json` management diagnostics.
- Fixed acceptance-gate semantics so reviewed status requires an independent reviewer result, required criteria must be reported as satisfied, only fenced `acceptance-report` blocks satisfy attestation, malformed reports preserve parse errors, `{ level: "none", reason }` disables inferred gates, and zero-child dynamic aggregates no longer fabricate evidence.

## [0.25.0] - 2026-05-21

### Added
- Allow child agents whose resolved builtin tools explicitly include `subagent` to run child-safe nested fanout, with parent-visible nested status trees and nested `status`/`interrupt`/`resume` by id.

### Fixed
- Preserve compact nested child summaries in grouped result/intercom payloads and async completion metadata before ordinary result files are processed and deleted.
- Keep async result files retryable when nested registry enrichment temporarily fails, instead of marking them seen before a successful delivery pass.
- Require an explicit id for child-safe nested `status` when no local foreground run is active, preventing fanout children from listing unrelated top-level async runs.
- Keep fanout child control inbox polling alive across transient filesystem errors, and retain control requests for retry when control-result writes fail.
- Share nested path/env sanitization between child launch arguments and nested event projection.

## [0.24.4] - 2026-05-20

### Fixed
- Treat provider-coerced single-run `output: "false"` the same as boolean `false`, preventing literal `false` output files in foreground and async runs.
- Include selected direct MCP tool names in explicit child `--tools` allowlists when metadata cache/config resolution is available.
- Honor `PI_CODING_AGENT_DIR` for runtime config, agent/chain/settings discovery, skills, run history, artifact cleanup, and intercom defaults.
- Hide nested child Pi process windows on Windows for both foreground and background subagent runs.
- Avoid completion-guard false positives for declared read-only agents, and add `completionGuard: false` for bash-enabled non-implementation agents that should not be required to edit files.
- Skip empty or whitespace-only assistant text parts when selecting subagent final output, so later meaningful text in the same or earlier assistant message is not masked.
- Declare `@earendil-works/pi-tui` as a runtime dependency so packaged installs can load the extension without relying on dev dependencies or optional peers.
- Treat recovered intermediate child tool/provider errors as successful when a later clean final assistant response is emitted, preventing false failed subagent results.
- Use progress-driven spinner frames in subagent result rows and async widgets, avoiding timer-driven off-screen redraw flicker in small terminals.

## [0.24.3] - 2026-05-14

### Added
- Show provider-free model and thinking labels in async subagent widgets and status views.
- Added a packaged `/review-loop` prompt for parent-controlled worker, fresh-reviewer, and fix-worker cycles that can run as an initial async chain or as follow-up subagent runs after async worker completions, stopping when reviewers find no fixes worth doing now or the review-round cap is reached.

### Fixed
- Let `async: true` chain tool calls run in the background when `clarify` is omitted, and avoid showing the async badge for explicit foreground clarify runs.

## [0.24.2] - 2026-05-10

### Fixed
- Show the `Ctrl+O` live-detail affordance for running single async subagent widgets when step details are available, while keeping the generic activity fallback before step status arrives.

## [0.24.1] - 2026-05-10

### Changed
- Migrated Pi package imports and package metadata to the `@earendil-works/*` scope, switched async TypeScript execution discovery to upstream `jiti`, and hardened forked-session creation to use the public `SessionManager.open()` path.

## [0.24.0] - 2026-05-03

### Changed
- Consolidated async step activity and parallel-outcome formatting used by widgets and `subagent({ action: "status" })` output.
- Updated `/parallel-review` and `/parallel-cleanup` to end review synthesis with numbered follow-up choices, plus an `autofix` mode for automatically applying fixes worth doing now.
- Include async run output paths in `subagent({ action: "status" })` output so the remaining inspection path covers the logs previously surfaced by the removed overlay.

### Removed
- Removed the unnecessary `/agents` manager overlay, its `Ctrl+Shift+A` shortcut, and the `agentManager.newShortcut` setting to cut unnecessary UI surface area; agent and chain management remains available through tool actions, settings, and markdown files.
- Removed persistent save actions from the chain clarify UI: `S` no longer writes runtime overrides back to agent frontmatter, and `W` no longer saves `.chain.md` files. Clarify now only edits the imminent run.
- Removed the `/subagents-status` read-only overlay and its slash command; async runs remain inspectable through `subagent({ action: "status" })`, completion notifications, logs, and the async widget.
- Removed the standalone `src/tui/text-editor.ts`; chain clarify now keeps its small runtime editor logic local to the only remaining consumer.

## [0.23.1] - 2026-05-02

### Added
- Persist async per-child session metadata and remember recent foreground child session metadata so `resume` can revive multi-child async runs and foreground children by index.

### Fixed
- Keep foreground children alive when they call `contact_supervisor` for a blocking decision by treating it as intercom coordination during parent detach, matching the generic `intercom` handoff path.
- Pause foreground parallel and chain flows when a child detaches for intercom coordination instead of counting the child as a successful completed result and continuing the workflow, and suppress grouped completion receipts for detached chains.
- Tighten resume/revive safety by rejecting pending async children, detached foreground children that may still be live, ambiguous foreground/async id prefixes, and exact invalid resume matches that would otherwise be masked by a prefix match in the other namespace.
- Preserve child session metadata in stale-run repaired results and avoid advertising revive from top-level-only or missing child session files.
- Stop builtin `reviewer` runs from writing progress by default, clarify that review-only/no-edit instructions win over progress-writing or artifact-writing instructions, and suppress automatic progress injection for explicit no-edit tasks even when chain templates use `{task}`.
- Treat parsed provider errors as failed foreground and async subagent attempts even when the child process exits successfully, and baseline saved output files per fallback attempt.
- Preserve output-file read and inspect errors instead of silently overwriting or falling back when a changed saved-output path cannot be read.
- Show each active async widget row's lifecycle status (`running`, `complete`, `failed`, or `paused`) alongside activity and usage stats.
- Start new direct, slash, prompt-template, foreground, and async subagent launches in compact view while keeping `Ctrl+O` available for live detail.
- Label top-level async parallel completion notifications as parallel runs instead of leaking the internal chain-shaped runner plan.

## [0.23.0] - 2026-05-02

### Fixed
- Detect `pi-intercom` when installed through the documented `pi install npm:pi-intercom` package flow, instead of only checking the legacy local extension path.

### Changed
- Store and discover saved chain workflows from dedicated chain directories: user chains in `~/.pi/agent/chains/**/*.chain.md` and project chains in `.pi/chains/**/*.chain.md`.
- Retry foreground subagent fallback models when Pi reports a retryable provider error, such as 429/quota, even if the child process exits successfully.
- Align single-run async subagent widgets and `/subagents-status` rendering with foreground subagent result styling for parallel, chain, and grouped chain runs, including inline live detail when tool output expansion is enabled, while keeping multi-job async widgets compact.
- Render async subagent widgets through an adaptive component so active parallel agent rows fit without Pi's fixed string-widget truncation marker.
- Tell parent agents that async runs are detached and they should end the turn instead of running sleep/poll loops when no independent work remains.

## [0.22.0] - 2026-05-02

### Added
- Added child-only supervisor contact support for delegated subagents through `contact_supervisor`, with `need_decision` for blocking supervisor replies and `progress_update` for concise non-blocking updates.
- Pass supervisor intercom metadata into foreground, chain, parallel, and background child runs so the child-facing pi-intercom tool can resolve the delegating session automatically.

### Changed
- Builtin agents now inherit the user's configured default model instead of pinning `openai-codex/gpt-5.5`; use builtin overrides to pin a model for a role.
- Hide unsupported thinking levels in subagent clarify and agent-manager pickers when Pi exposes per-model thinking metadata.
- Updated builtin agent prompts, README, and bundled skill docs to prefer `contact_supervisor` for blocked decisions and avoid child-side routine completion handoffs.
- Teach reviewer agents that repo-local `progress.md` files are intentional scratch files that should remain untracked and covered by `.gitignore`.

### Fixed
- Added regression coverage for supervisor metadata propagation into child process environments.

## [0.21.5] - 2026-05-02

### Fixed
- Show top-level async parallel runs as `parallel` instead of `chain`, with foreground-style running/done wording in widgets and status output, and group running async chain detail by chain step.
- Scoped `/subagents-status` to async runs launched from the current pi session instead of showing prior or unrelated sessions.
- Declared the Pi TUI package as a direct dev dependency and added a manifest guard so CI installs do not rely on transitive optional peer dependencies for tests.
- Made prompt-runtime extension path assertions portable on Windows.

## [0.21.4] - 2026-05-01

### Added
- Added explicit frontmatter `package` identifiers for agents and saved chains, registering runtime names like `code-analysis.scout` while preserving separate `name` and `package` fields on save.
- Added recursive subdirectory discovery for user and project agent and chain definitions.
- Added `outputMode: "inline" | "file-only"` for saved subagent outputs. `inline` remains the default, while `file-only` returns a concise saved-file reference instead of injecting full saved output back into the parent context.

### Fixed
- Marked Pi runtime peer dependencies as optional so npm package installs do not auto-install duplicate Pi packages or emit unrelated transitive dependency warnings.

## [0.21.3] - 2026-04-30

### Fixed
- Debounce foreground `needs_attention` notices, make them non-triggering, and cancel them when the run finishes so stale chain-step alerts do not launch parent turns after completion.

## [0.21.2] - 2026-04-30

### Added
- Added a packaged `/parallel-context-build` prompt for parallel `context-builder` handoff passes.
- Added a packaged `/parallel-handoff-plan` prompt for external-reference research plus local `context-builder` passes that produce an implementation handoff meta-prompt.

### Changed
- Strengthened `context-builder` guidance so handoffs require reading all relevant files and doing needed tool-available research before summarizing.
- Expanded the bundled `pi-subagents` skill with tool-level recipes for the packaged prompt workflows, including context-build and handoff-plan patterns that parent agents can apply without slash commands.
- Updated `README.md` to explain the bundled `pi-subagents` skill, what it covers, and how it helps the orchestrating agent.

### Fixed
- Make active-long-running notices time-based by default, with turn and token thresholds available only as explicit opt-in budget guards.
- Stop async status listing from inventing `needs_attention` with default thresholds when the runner has not persisted a control state.
- Treat string `"false"` output settings as disabled output so parallel reviewers do not collide on a `/false` output path, including chain-parallel agent defaults.
- Wrap long `/subagents-status` detail output/event lines instead of truncating them with ellipses.
- Treat cleanup after a clean terminal assistant stop as success even when the final assistant text is empty, using a short grace period before terminating lingering child processes without surfacing scary final-drain warnings.
- Express flexible tool schema fields as `anyOf` unions without parent-level `type` arrays, avoiding schema shapes rejected by strict providers such as Moonshot/opencode-go.

## [0.21.1] - 2026-04-30

### Changed
- Changed the `/agents` new-agent shortcut from `Alt+N` to `Shift+Ctrl+N`, and added `agentManager.newShortcut` config for overriding it.

### Fixed
- Fall back to polling async result files when native result watching is unavailable due to `EMFILE` or `ENOSPC`.
- Treat forced final-drain termination after a valid final assistant output as cleanup success instead of failing the subagent run.
- Hide disabled builtin agents from `subagent({ action: "list" })` output so agent-facing choices match executable runtime discovery.
- Resolve intercom bridge default paths at runtime so tests and isolated environments that change `HOME` use the correct `pi-intercom` location.
- Made the tool-description source check tolerant of Windows line endings.

## [0.21.0] - 2026-04-29

### Changed
- Document the recommended parent-agent workflow as `clarify → planner → worker → fresh reviewers → worker` in the docs and bundled skill.
- Packaged `planner`, `worker`, and `oracle` now default to forked session context when the launch omits `context`; explicit `context: "fresh"` still overrides the agent default.
- Expanded builtin subagent guidance so agents with a safe pi-intercom target can hand results back with blocking `intercom ask`, documented the self-orchestrated clarify → plan → implement → review workflow, and added GPT-5.5-oriented subagent prompt guidance to the bundled skill and `context-builder`.

### Fixed
- Prevent child subagents from receiving parent orchestration tooling/history, and inject boundary instructions that forbid sub-delegation and pseudo tool calls.
- Added active-long-running and repeated mutating-tool failure notices so supervised/forked workers cannot burn turns silently while still appearing healthy.
- Fixed task editor wrapping so wide characters cannot push text past the right border.
- Mark implementation subagents as failed when they complete without any file mutation attempt.
- Applied the same no-mutation completion guard to async/background runner paths.
- Split terminal no-mutation guard notices from live idle notices so completed failures do not suggest status or interrupt commands.
- Clarified worker/intercom bridge instructions so blocked decisions use `intercom ask` and stay alive for the reply instead of completing with a question.
- Labeled the Agents widget as async/background work so running detached agents are easier to identify.
- Reworked parallel progress wording so parallel runs show running/done agent counts (and chain parallel groups show `step X/Y · parallel group` with agent fractions) instead of serial `step X/Y` counters.
- Expanded `/parallel-cleanup` guidance to flag redundant wrapper tests when one focused regression is enough.
- Fixed flexible schema validation for `reads` and `skill` overrides so `reads: false`, `skill: "review"`, and `skill: false` no longer trigger `element.reads.every is not a function` (issue #124).
- Hardened slash-result and async-widget animation timers so stale extension contexts after `/new` or reload stop their timers instead of crashing on `ctx.ui` access (issue #122).

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
