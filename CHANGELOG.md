# Changelog

## [Unreleased]

### Added
- Add default-off, main-only watchdog questions and task-continuity reviews from bounded delivered orchestration evidence (#2010).

### Changed
- Simplify watchdog clarification to a visible question and native orchestrator continuation; remove the reply action, exchange tracking, deadlines and mandatory follow-up reviews.
- Document task-derived behavior labels for workflow launches in the built-in pi-subagents skill, including reviews and retained follow-ups.

### Fixed
- Show exact recorded async child IDs in workflow status and actionable child steering guidance when an owned workflow has no foreground route, without treating queued messages as consumed (#2011).
- Bound transcript previews by individual line size and total rendered body size, preserving recent context and full artifact references. Thanks to [@rtbe](https://github.com/rtbe) for #2015.
- Await a bounded, offline model registry refresh before opening `/subagents` model and thinking pickers, and warn on refresh failures. Thanks to [@ianbmacdonald](https://github.com/ianbmacdonald) for #2008.

## [0.66.0] - 2026-09-06

### Highlights
- Background results and completion notifications arrive more reliably, including after storage problems.
- Steering and supervisor replies reach the right run, with clearer guidance when a reply is needed first.
- Read-only tasks can continue after a rate limit on a compatible fallback model without starting over.
- Live progress, transcripts, and stable status displays make ongoing work easier to follow.
- Custom agents can opt into discovery, and trusted extensions can provide named workflows.

### Added
- Let agents appear in the parent prompt with `advertise: true`. Thanks to [@nwalke](https://github.com/nwalke) for #1972.
- Allow one read-only continuation after an HTTP 429 rate limit on a compatible fallback model from the same configured provider. Keep the session without replaying the task, within existing recovery, time, and budget limits (#1936). Thanks to [@peedrr](https://github.com/peedrr).
- Add targeted source checks and clearer evidence, confidence, and uncertainty reporting to researcher responses (#1932). Thanks to [@Muskos](https://github.com/Muskos).
- Let trusted extensions register session-scoped named workflows with validated arguments and permission to run specific host commands (#1907).
- Add opt-in completion notification diagnostics with `NODE_DEBUG=pi-subagents-notify` (#1981). Thanks to [@brandonmwest](https://github.com/brandonmwest) for the report and diagnostic sessions.

### Changed
- Explain model-verification failures and how to configure exact `modelResponseAliases` (#1922). Thanks to [@sixtus](https://github.com/sixtus).
- Clarify when startup fallback and read-only rate-limit continuation are supported (#1936). Thanks to [@peedrr](https://github.com/peedrr).
- Document steering delivery modes and `scheduledRuns.storeRoot` (#1933). Thanks to [@G0-0000](https://github.com/G0-0000).
- Remove generation suffixes from developer-facing types and helpers without changing request shapes, saved formats, or behavior (#1913).

### Fixed
- Deliver background results and completion notices reliably after early failures, delayed publication, or storage-capacity recovery. Save results before reporting successful completion, without adding idle polling (#1981). Thanks to [@brandonmwest](https://github.com/brandonmwest).
- Keep completion requirements intact when child sessions compact their context (#1996). Thanks to [@Zsbyqx20](https://github.com/Zsbyqx20).
- Correct supervisor action names and reply and steering guidance. Thanks to [@rtbe](https://github.com/rtbe) for #2002.
- Require an explicit answer to a pending supervisor question before steering or following up on a single background run; include the request ID in the response (#1980). Thanks to [@brandonmwest](https://github.com/brandonmwest).
- Detect supervisor questions when background or scheduled workflows start, including after earlier work finishes, while keeping macOS idle polling disabled (#1977). Thanks to [@brandonmwest](https://github.com/brandonmwest) and [@youlikemodernart](https://github.com/youlikemodernart) for #1220 and #1228.
- Queue steering for workflows owned by another runtime without incorrectly claiming delivery or taking over the run (#1978). Thanks to [@brandonmwest](https://github.com/brandonmwest).
- Find supervisor questions without a UI, keep notification failures from interrupting discovery, and require explicit answers (#1975, #1982). Thanks to [@brandonmwest](https://github.com/brandonmwest).
- Deliver background workflow steering to the intended child and report requests that cannot be delivered before shutdown (#1976, #1983). Thanks to [@brandonmwest](https://github.com/brandonmwest) for the diagnosis, reproduction, implementation, and tests.
- Leave the prompt runtime inactive when it is not configured. Thanks to [@lertian](https://github.com/lertian) for #1973.
- Return `invalid_state` instead of queuing stop requests that cannot reach a live workflow (#1965).
- Retain unreadable stop requests for retry, reject invalid workflow arguments even when validation returns an empty error message, and preserve worktree timeout details.
- Show live tool activity, timing, model, effort, and counters for foreground workflow children without forwarding full transcripts (#1964).
- Allow `action: "status", view: "transcript"` to inspect live foreground child output on demand (#1963).
- Keep the background status widget in place during progress updates (#1931). Thanks to [@DraconDev](https://github.com/DraconDev).
- Recognize `REQUEST_LIMIT_EXCEEDED` rate limits and avoid excluding healthy models because of invalid requests or context overflow (#1955, #1957). Thanks to [@slyons-vamp](https://github.com/slyons-vamp).
- Wait for resumed workflow results to be saved before reporting them missing on Windows (#1906).
- Send foreground workflow progress to RPC, headless, and cross-repository hosts even when the live chat card is off (#1951). Thanks to [@yanqianglu](https://github.com/yanqianglu).
- Resolve undici from the official npm registry for npm 12 compatibility (#1935). Thanks to [@chem](https://github.com/chem).
- Fix background launches on stable Pi 0.85.1 without experimental packages, while retaining Pi 0.85.0 support (#1944). Thanks to [@geril07](https://github.com/geril07).
- Include the saved workflow receipt path in wait results, notifications, and status and debug responses (#1938).
- Show structured output in completion notices when text is blank or contains only a closing think-tag (#1945). Thanks to [@npfedwards](https://github.com/npfedwards).
- Validate workflow `baseRef` values before execution and clarify supported refs (#1934, #1937). Thanks to [@jeanduplessis](https://github.com/jeanduplessis).
- Make boolean tool options compatible with restricted Gemini schema converters without changing which values are accepted (#1950). Thanks to [@Biaogo94](https://github.com/Biaogo94).
- Keep Fleet runs in start-time order instead of reshuffling them as activity changes (#1923, #1924). Thanks to [@expoli](https://github.com/expoli).
- Preserve links to previous runs when continuing a workflow by its string ID (#1920).
- Clear recovered errors after successful tool use or structured output (#1919). Thanks to [@Jonathanm10](https://github.com/Jonathanm10).
- Report empty final responses as empty-output failures instead of blaming earlier tool errors (#1921).
- Avoid missing-edit failures for successful read-only background tasks misclassified as implementation work (#1911). Thanks to [@yanqianglu](https://github.com/yanqianglu).
- Batch background streaming updates while showing child activity changes immediately (#1901).
- Honor new output paths on workflow follow-ups without overwriting the original report (#1903).
- Keep worktree setup responsive and cancellable, and preserve uncertain allocations for manual inspection (#1902).

## [0.65.1] - 2026-09-04

### Highlights
- Background sessions stay alive until their work and result delivery finish.
- Background runs work on Pi 0.85.0 without missing-package errors.
- Custom-provider models and proxy connections work more reliably in background runs.
- Parallel children keep separate session logs, even with a shared log directory.
- Worktree cleanup preserves changes until a complete, usable patch has been saved.

### Changed
- Clarify that switching execution modes after a failed run requires your approval (#1879).

### Fixed
- Accept configured model aliases returned by gateways without changing the requested model. Thanks to [@drudko-ias](https://github.com/drudko-ias) for #1897.
- Hide the empty, unlimited async capacity summary in Fleet. Thanks to [@youssefsiam38](https://github.com/youssefsiam38) for #1892.
- Fix missing-server import errors in Pi 0.85.0 background runs, including runs that load extensions.
- Remove repeated metadata and reply instructions from supervisor request cards. Thanks to [@youssefsiam38](https://github.com/youssefsiam38) for #1893.
- Stop foreground runs before contacting a provider when required tools are missing. Respect workflow async defaults and show each failure once. Thanks to [@youssefsiam38](https://github.com/youssefsiam38) for #1891.
- Keep pi-web parent sessions alive while subagent work or completion delivery remains active. Thanks to [@vcing](https://github.com/vcing) for #1857.
- Avoid unnecessary startup delays and preserve active locks when process IDs are reused. Thanks to [@ducaoya](https://github.com/ducaoya) for #1878.
- Make extension-provided models available before starting child sessions, including on Pi versions without native provider queues. Thanks to [@kevinkirkup](https://github.com/kevinkirkup) for #1885.
- Handle long or unusual workflow IDs without creating invalid file paths. Thanks to [@jstillwa](https://github.com/jstillwa) for #1875.
- Avoid startup import errors when optional Pi packages are not installed beside the extension. Thanks to [@VladimirGVP](https://github.com/VladimirGVP) for #1860.
- Use custom provider streams for task classification only when they match the selected model's API. Thanks to [@pwguler](https://github.com/pwguler) for #1874.
- Give concurrent children separate session files under an explicit `sessionDir`. Thanks to [@dat9uy](https://github.com/dat9uy) for #1859 and #1858.
- Honor proxy environment variables in detached background runs. Thanks to [@jasonrale](https://github.com/jasonrale) for #1867 and #1866.
- Allow previously unavailable models to run once they reappear in the model registry. Thanks to [@x1prog](https://github.com/x1prog) for #1862.
- Resolve Pi package imports correctly in detached runs, including subpath imports. Thanks to [@plopezlpz](https://github.com/plopezlpz) for #1871 and [@pwguler](https://github.com/pwguler) for #1880.
- Initialize the theme before child extensions access `ctx.ui.theme`. Thanks to [@danielmarbach](https://github.com/danielmarbach) for #1865.
- Save complete worktree patches, including binary changes, regardless of Git display settings. Validate them before removing worktrees. Thanks to [@jeanduplessis](https://github.com/jeanduplessis) for #1868.
- Accept `acceptance: false` alongside `gate`, treating it as omitted.

## [0.65.0] - 2026-09-04

### Highlights
- Subagents now run through native Pi sessions instead of spawning separate `pi` processes, making delegation simpler and less fragile.
- Workflow status is easier to scan with compact lane summaries and clearer supervisor messages.
- Model selection fails clearly when configured models are unavailable, instead of silently using a provider default.
- Managed worktrees are safer and more flexible, with validated `baseRef` support and per-project nesting.
- Background children can use provider-extension models reliably, including dynamically registered models such as router providers.

### Added
- Include sanitized model, provider, reason, and expiry details when no usable subagent model candidates remain. Thanks [@AlexKucera](https://github.com/AlexKucera) for #1841.
- Allow managed worktrees to start from a validated `baseRef` instead of always using `HEAD`. Thanks [@jaudiger](https://github.com/jaudiger) for #1842.

### Changed
- Run subagents as native Pi `AgentSession`s instead of spawned `pi` CLI processes (#1844). Foreground children run in the parent process, and background children run in the detached runner.
- Foreground children no longer load ambient extensions. Use background children for agents that need MCP tools or provider-extension models. Background children require Pi from the installed `@earendil-works/pi-coding-agent` package, not a standalone `pi` binary.
- Rename package subpath `pi-subagents/pi-args` to `pi-subagents/child-tool-plan`; `PI_SUBAGENT_PI_BINARY` now applies only to Herdr project panes and the profile model probe.
- Replace collapsed async workflow role summaries with a compact lane view while keeping full details available when expanded (#1827).
- Add `contact_supervisor` to the bundled reviewer and scout tool allowlists without adding mutation tools (#1846).

### Fixed
- Drop only malformed persisted model-exclusion entries and rewrite the cleaned cache.
- Stop live workflow children when a run-level stop targets an in-memory async workflow controller.
- Fail closed when a fallback-only model configuration resolves no launch candidates. Thanks [@AdenosineTP](https://github.com/AdenosineTP) for #1853.
- Resolve native child models after child extensions register provider models. Thanks [@mystery4f](https://github.com/mystery4f) for #1855.
- Ignore stale authentication-related model exclusions after Pi's `auth.json` is refreshed, while preserving quota, rate-limit, overload, and model-unavailable exclusions. Thanks [@wesleyfei1](https://github.com/wesleyfei1) for #1835.
- Show native supervisor requests and outbound replies as bounded TUI cards in parent sessions (#1845).
- Suppress stale async supervisor-request notices after the native request has already been answered (#1838). Thanks [@VladimirGVP](https://github.com/VladimirGVP).
- Flush async workflow result assembly after session replacement when every child is already terminal, without permitting stale-context launches (#1833). Thanks [@redcomet168](https://github.com/redcomet168).
- Accept calendar/platform `claude --version` output during Claude Code adapter preflight while retaining required launch-flag validation. Thanks [@drouhard](https://github.com/drouhard).
- Show passive local command availability for external CLI agents in capability listings without replacing launch preflight (#1829). Thanks [@drouhard](https://github.com/drouhard).
- Nest native managed worktrees under per-project directories while preserving unsafe-location checks (#1831). Thanks [@moofone](https://github.com/moofone).

## [0.64.0] - 2026-09-02

### Highlights
- Watchdog can now warn or block child launches before they start, based on role and model rules.
- Watchdog reviews are easier to guide with safe diff access, reusable `WATCHDOG.md` instructions, and configurable child review cadence.
- Watchdog findings are easier to see in parent results, completion notices, acceptance evidence, and Fleet.
- Workflow status and async results are less noisy and more accurate.

### Added
- Add watchdog launch rules under `subagents.watchdog.rules`, with per-role model allow and deny globs that warn or block before a child starts.
- Give watchdog reviewers a read-only `watchdog_diff` tool for session-start diffs, untracked paths, path narrowing, and stat summaries.
- Run child watchdog reviews on a configurable cadence with `children.cadence` and `children.overrides.<agent>.cadence`.
- Show child watchdog warnings in parent results, acceptance evidence, completion notices, and Fleet `wd:<n>` chips.
- Load watchdog reviewer instructions from project and agent `WATCHDOG.md` files.

### Changed
- Reject unsupported watchdog settings that never took effect: `delivery`, `showDuringRun`, `syncBacklog`, `lateWarningPolicy`, `compactAtPercent`, `reviewRetryDelayMs`, `maxReviewFailures`, `asyncCompletion`, and `guidance.systemPromptPath`.
- Remove watchdog auto-follow. Pi 0.84+ already continues after displayed boundary warnings, and repeated identical warnings now stop after `subagents.watchdog.stalemateRepeats`. The `autoFollow` settings block is now unknown.

### Fixed
- Keep advisory preflight checks out of runtime workflow rows and queued checklist counts (#1821). Thanks [@stekman08](https://github.com/stekman08).
- Preserve effective thinking in completed async step results. Thanks to [@Nickonomic](https://github.com/Nickonomic) for #1823.
- Forward workflow child control overrides through new and retained launches, and suppress idle needs-attention notices before the first assistant turn (#1817). Thanks [@rrocxela](https://github.com/rrocxela).

## [0.63.0] - 2026-09-01

### Highlights
- Workflow progress is easier to scan in status, Fleet, and live widgets.
- Additional agent folders can now be configured without copying definitions into one directory.
- Worktrunk users get managed worktrees automatically, with native Git available as the fallback.
- Fleet can jump straight into the selected child run's Herdr inspector.
- Async runs clean up and report edge cases more reliably.

### Added
- Show workflow progress as stacked checklist summaries in status, Fleet, and live widget views (#1806).
- Add configurable extra agent scan directories with one-segment wildcard expansion. Thanks to [@mystery4f](https://github.com/mystery4f) for #1801.
- Make Worktrunk a first-class managed worktree provider, selected automatically when available with native Git as the fallback (#1800).
- Let Fleet open the selected async child in its child-specific Herdr inspector. Thanks to [@stekman08](https://github.com/stekman08) for #1790.

### Changed
- Show workflow checklist phases first in collapsed views, while keeping child details available when expanded (#1810).

### Fixed
- Keep isolated test runs from writing agent definitions into an inherited `PI_CODING_AGENT_DIR`. Thanks to [@mapleluvr](https://github.com/mapleluvr) for #1809.
- Prevent nested tool-availability diagnostics from failing an otherwise valid parent result. Thanks to [@robertvangor](https://github.com/robertvangor) for #1802.
- Free async capacity correctly after workflows finish, even when saved step status is stale. Thanks to [@boggylp](https://github.com/boggylp) for #1804.
- Make `subagents.agentOverrides.<name>` replace matching custom-agent frontmatter fields, consistently with builtin agents. Thanks to [@expoli](https://github.com/expoli) for #1796.
- Strip the trailing Pi turn-timing footer from child output. Thanks to [@fkhawajagh](https://github.com/fkhawajagh) for #1792.
- Keep inferred acceptance reports out of reviewer and read-only child prompts. Thanks to [@expoli](https://github.com/expoli) for #1797.
- Preserve coordinated read-only intent when direct async children resume, and show captured structured output in completion and status evidence. Thanks to [@fkhawajagh](https://github.com/fkhawajagh) for #1788.
- Keep macOS subagent tasks out of argv by delivering them through temporary files. Thanks to [@josephkallas](https://github.com/josephkallas) for #1793.

## [0.62.0] - 2026-08-31

### Highlights
- Child agents can report completion evidence more cleanly and stay away from tools they should not use.
- Session-only schedules keep personal scheduled work tied to the session that created it.
- Async forked runs now start and resume in the working directory you requested.
- Windows child launches are more reliable, with clearer errors when Pi cannot find a valid CLI.
- External CLI and read-only recovery paths are sturdier when workers disappear or prompts include unusual line separators.

### Added
- Let native children with `outputSchema` include required acceptance evidence in the same `structured_output` call with `acceptance.report: "on"`; `acceptance.report: "off"` keeps fenced acceptance reports. Thanks [@mapleluvr](https://github.com/mapleluvr) for #1770.
- Add per-agent `excludeTools` deny-lists that compose with Pi's ambient or explicit child tool selection. Thanks [@expoli](https://github.com/expoli) for #1776.
- Add session-only durable schedules that only run in the session that created them. Thanks [@yangfeng20](https://github.com/yangfeng20) for #1777.

### Fixed
- Keep async forked runs in the requested child `cwd` when they start or resume. Thanks [@stekman08](https://github.com/stekman08) for #1785.
- Accept JSON-encoded acceptance objects from model tool calls, while still failing clearly for malformed strings. Thanks [@mapleluvr](https://github.com/mapleluvr) for #1781.
- Keep steer and follow-up receipt statuses separate from their redacted message previews (#1773).
- Create async lifecycle sidecars before external CLI workers begin worktree changes, so disappeared runners are reported as failed runs. Thanks [@fkhawajagh](https://github.com/fkhawajagh) for #1764.
- Preserve explicit read-only intent when escaped line separators surround no-edit wording. Thanks [@fkhawajagh](https://github.com/fkhawajagh) for #1765.
- Launch child Pi processes through the resolved CLI JavaScript on Windows, and run JavaScript `PI_SUBAGENT_PI_BINARY` overrides with Node. Thanks [@caohuipeng](https://github.com/caohuipeng) for #1768.
- Resolve the installed Pi CLI on Windows wrapper hosts from the forwarded package root, and report a clear error when no verified CLI can be found. Thanks [@lux032](https://github.com/lux032) for #1780.

## [0.61.0] - 2026-08-31

### Highlights
- Subagent runs use less context and repeat less status text, so everyday delegation is cheaper and easier to scan.
- Status, Fleet, widgets, RPC, and background-work views refresh with less duplicated work.
- Async recovery is more reliable when active status files, child reports, or provider fallback attempts go wrong.
- Workflow permissions are clearer with named workflow resources and `bg_wait` as the primary background wait tool.
- Model listings now show effective models for discovered and runtime-registered agents.

### Added
- Add extension-owned named workflow resources so permission and policy extensions can distinguish trusted workflow resources from raw scripts. Thanks [@mathiasloh](https://github.com/mathiasloh) for #1751.
- Add workflow-only `globalConcurrencyLimit` and `maxSubagentSpawnsPerRun` overrides for top-level `workflowScript` calls. Thanks [@RapierCraft](https://github.com/RapierCraft) for #1760.
- Remove the deprecated compatibility wait alias; use `bg_wait` instead (#1729).

### Changed
- Show effective model mappings for discovered and runtime-registered subagents through management and `/subagents-models`. Thanks [@RapierCraft](https://github.com/RapierCraft) for #1732.
- Trim default subagent prompt guidelines to five parent-facing entries while keeping advanced workflow details in the packaged guide. Thanks [@Ran-Xing](https://github.com/Ran-Xing) for #1746.
- Reduce repeated heartbeat status updates during delegated runs while keeping foreground progress and complete terminal responses (#1739).
- Clarify that `fallbackModels` handles provider/model timeouts but not run-level `timeoutMs` / `maxRuntimeMs` expiry. Thanks [@kaplan-shaked](https://github.com/kaplan-shaked) for #1745.
- Pass requested session and timestamp context to background-work providers so they can avoid listing unrelated sessions while preserving strict validation (#1737).
- Avoid repeated external-run display normalization during Fleet refresh while still validating externally replaced or mutated records (#1736).
- Clarify that `oracle` and top-reasoning models are escalation tools, not routine defaults.
- Serve broad RPC status requests from restored in-memory state when safe, while preserving targeted status and transcript behavior (#1735).

### Fixed
- Isolate corrupt active async status files during restoration so valid runs remain available and corrupt run artifacts are preserved. Thanks [@zhexulong](https://github.com/zhexulong) for #1756.
- Reduce async widget update churn during running workflows by repainting animation ticks without reinstalling the widget and coalescing close status refreshes (#1726).
- Avoid repeated staged workflow projection during widget rendering. Thanks [@kkkhs](https://github.com/kkkhs) for #1730.
- Preserve durable file-only child reports and continue read-only workflow review after malformed acceptance metadata (#1724).
- Preserve model origins across fallback and fork preparation, so eligible fallbacks work for unavailable configured primaries while invalid explicit models still fail closed. Thanks [@xz-dev](https://github.com/xz-dev) for #1747.
- Stop hidden 125ms spinner redraws while keeping progress refreshes and one-second animation frames (#1747).

## [0.60.0] - 2026-08-30

### Highlights
- Agent selection is easier with compact capability lists and structured capability details.
- Async status views are calmer and show workflow progress with clearer grouping and labels.
- Subagent guidance is clearer about when to work directly and when to orchestrate delegated planning, implementation, and review.
- Windows and macOS runs avoid more distracting console flashes, delayed failures, and startup hangs.
- Recovery paths preserve better diagnostics when child runs time out, fail early, or cannot provide requested output.

### Added
- Add `action: "list", capabilities: true` for compact prompt-free agent capability discovery. Thanks to [@peedrr](https://github.com/peedrr) for #1717.
- Add structured `details.agentCapabilities` records so callers can select agents without parsing prose rows (#1720).

### Changed
- Show `runs.lanes(...)` workflows with active-stage focus and planned-stage progress in async status widgets (#1699).
- Align foreground subagent result labels with async widget labels and disambiguate duplicate rows (#1697).
- Render parallel subagent workflow groups as readable cards with nested agent rows (#1696).
- Remove repeated one-child async widget status labels and compact progress echoes (#1695).
- Tighten packaged subagent and Council Mode guidance for one-child launches, composed `workflowScript` runs, generic review validation, and private policy boundaries.
- Clarify portable model-tier guidance for parent, worker, scout, reviewer, and critique subagents without requiring a specific provider.
- Trim duplicated orchestration recipes from the packaged skill while keeping detailed policy and execution references in one place.
- Clarify when the parent should work directly versus orchestrate delegated subagent work, including who owns decisions and publication (#1722).
- Clarify `workflowScript` portability and `runs.host(...)` working-directory limits, including outer workflow `cwd` and trusted `cd ... && command` patterns (#1679).

### Fixed
- Treat malformed persisted async status states as partial, bound persisted workflow stage text, and fail closed when an explicit child-output path cannot be inspected before a run.
- Surface recovery diagnostics for dirty timed-out children that miss requested reports, while keeping them fail-closed (#1713).
- Keep retained-session resume runners from flashing console windows on Windows while preserving Unix background detachment. Thanks to [@Zethu5](https://github.com/Zethu5) for #1711.
- Hide mutation-evidence Git subprocess windows on Windows to prevent visible console flashes or terminal tabs. Thanks to [@dnnkeeper](https://github.com/dnnkeeper) for #1706.
- Deliver immediate async workflow terminal failures on macOS without requiring a later status refresh (#1700).
- Skip untracked-file enumeration for watchdog signatures when the Git root is the user home or has no tracked files, avoiding startup and turn hangs in accidental large home repositories. Thanks to [@AluxesLAS](https://github.com/AluxesLAS) for #1693.
- Reuse a fork-family prompt cache key for OpenAI-style forked subagent requests so sibling fork children keep cache affinity without pooling fresh children. Thanks to [@Shinkicast](https://github.com/Shinkicast) for #1682.
- Show workflow child `[fresh]` and `[fork]` context labels in Fleet status rows alongside model and thinking badges.
- Match pi-mcp-adapter direct-tool names when configured MCP server names contain hyphens. Thanks to [@unrelentingfox](https://github.com/unrelentingfox) for #1685.
- Animate running FleetView glyphs from the wall clock and repaint unchanged running entries. Thanks to [@Pudgey](https://github.com/Pudgey) for #1688.

## [0.59.0] - 2026-08-28

### Highlights
- Run host commands from workflow scripts with safer saved output and clearer command results.
- Build sequential parallel workflows with `runs.lanes(...)`, launch preflight labels, and better retained-resume behavior.
- See cleaner async status, child labels, and worktree handoff details without extra setup.
- Recover more reliably from stale contexts, provider aborts, missing outputs, malformed MCP metadata, and Windows file locks.
- Control live workflow children from more places, including non-TUI and RPC hosts.

### Added
- Add `runs.host(...)` command steps to `workflowScript`, with required timeouts, saved output, and status and receipt evidence (#1648).
- Add CI and gate monitor rows that record monitor kind, terminal verdict, freshness, and report pointers in workflow status and receipts.
- Persist workflow lane metadata in child status, receipts, and existing worktree handoff manifests, including display-only worktree paths and branches.
- Add `runs.lanes(...)` for parallel sequential workflow stages with per-lane results and retained-resume support (#1633).
- Add display-only `preflight` lane metadata for workflowScript launches, with coverage warnings and planned-lane rendering in launch, status, and live-card views.
- Add a plan-only `worktree.cleanup` management action that records a cleanup plan without removing worktrees or branches.
- Give every subagent child session a human-readable display name, and include it in result, progress, status, workflow, nested, and intercom payloads. Thanks to [@yanqianglu](https://github.com/yanqianglu) for #1615.
- Add `/subagents-steer <run-id> [--child <child-id>] <message>` so non-TUI sessions and RPC hosts can steer live async runs. Thanks to [@yanqianglu](https://github.com/yanqianglu) for #1608.
- Add explicit `allowNestedSubagents` agent authorization for nested fanout without replacing inherited tools or extensions. Thanks to [@tutu359](https://github.com/tutu359) for #1587.
- Accept a child id on `/subagents-stop <run-id> <child-id>` so one child of a multi-child async run can be stopped without stopping the whole run. Thanks to [@yanqianglu](https://github.com/yanqianglu) for #1603.

### Changed
- Reduce noisy launch, status, output, settings, and worktree cleanup messages without changing behavior.
- Include a direct resumable child id in missing workflow receipt guidance when retained status proves it is safe.
- Clarify `workflowScript` contracts for retained resume keys and durable child output paths.
- Record merge or supersession evidence in existing worktree handoff manifests and show cleanup eligibility without removing anything.
- Show optional lane and work-item context in async status rows, including phase, gate, next action, output, run reference, and stale or blocked state.
- Show workflow child labels and phases in async status progress while preserving stable workflow keys.
- Remove assistant turn budgets, including hard termination, wrap-up prompt injection, and launch configuration.
- Split internal launch, status, settlement, evidence, and direct-MCP planning code into smaller modules without changing public behavior.

### Fixed
- Match detached workflow completion by exact child identity, keep host gate rows in snapshots, and report missing host verdicts as inconclusive.
- Replace explicit `runs.host(...)` output files atomically inside their verified directory, and retry transient Windows destination locks.
- Reject malformed MCP direct-tool server and metadata-cache fields when JSON is loaded.
- Preserve live composite child tool-call ids for `cursor-native`, so Cursor MCP results keep matching pending execs. Thanks to [@moofone](https://github.com/moofone) for #1677 and #1678.
- Ignore stale cached UI contexts during background status refresh and session lifecycle cleanup (#1670).
- Compact workflow preflight status in default TUI and status views while keeping full details available when expanded (#1668).
- Give `runs.lanes(...)` stage-0 retained-resume validation actionable `runs.run(...)` guidance instead of a generic error (#1657).
- Remove the remaining `lane:` prefix from operator-facing async status rows in the TUI (#1658).
- Allow scheduled project roots shared through a registered Git worktree's `.pi` symlink while rejecting unrelated or unproven Git-layout escapes. Thanks to [@sususu98](https://github.com/sususu98) for #1656.
- Include delegated child usage in subagent tool results and `/subagent-cost`, including completed async workflow children and parent compaction usage with persisted workflow-receipt recovery when needed (#1662, #1666). Thanks to [@Geraldo-Morais](https://github.com/Geraldo-Morais) for #1662 and [@jf88888](https://github.com/jf88888) for #1666.
- Avoid false preflight mismatch warnings for generated `runs.lanes(...)` stage keys (#1649).
- Accept long host tool-call ids in workflow child summaries, matching the existing 4,096-byte session id bound. Thanks to [@SudoKillMe](https://github.com/SudoKillMe) for #1653.
- Keep an async `workflowScript` continuation live while an awaited child coordinates with its supervisor, so later sequential steps still run (#1634).
- Stop stale extension and slash-command contexts from escaping during reload or session replacement.
- Include saved workflow child output paths and inline previews in completion notices (#1629).
- Format million-scale context limits as `1M` instead of `1000k` in live status displays.
- Restore active workflow children under their workflow parent in Fleet Status after reload, while keeping unmatched shell rows visible.
- Prefer loaded workspace context over repeated internal workflow keys in async TUI lane rows (#1619).
- Accept path-like Pi session ids up to 4,096 characters when snapshotting background work. Thanks to [@dvishoot](https://github.com/dvishoot) for #1616.
- Accept bare leaf model ids reported by provider drivers when verifying provider-qualified launch candidates. Thanks to [@lallenlowe](https://github.com/lallenlowe) for #1609.
- Resume compaction-induced child aborts once when retained state is safe, and report the exact recovery blocker otherwise.
- Report aborted or signalled no-output child runs with their terminal stop, stderr, or process signal before missing-output handoff diagnostics.
- Apply `globalConcurrencyLimit` to `workflowScript` children launched through `runs.run` and `runs.all`, not only legacy multi-child runners. Thanks to [@mateominato](https://github.com/mateominato) for #1600.
- Ignore nested `.pi` and `sync-backups` directories during agent discovery so stale backup definitions cannot become executable agents. Thanks to [@arlishansenn](https://github.com/arlishansenn) for #1596.
- Let projects layer agent overrides by the active parent model provider without duplicating agent definitions. Thanks to [@arichiardi](https://github.com/arichiardi) for #1597.
- Let operators configure the default `subagent_wait` window and report window expiry as non-error active work while preserving strict headless draining. Thanks to [@Shujakuinkuraudo](https://github.com/Shujakuinkuraudo) for #1591.
- Degrade run status to the stored fan-out budget snapshot when persisted state is unavailable, instead of failing the entire run list. Thanks to [@qsgy-edge](https://github.com/qsgy-edge) for #1595.
- Enforce MCP server `includeTools` and `excludeTools` policies for child direct-tool grants, including adapter-compatible glob matching. Thanks to [@Shujakuinkuraudo](https://github.com/Shujakuinkuraudo) for #1590.
- Prevent Fleet prompt audit rendering from crashing on malformed non-string task payloads. Thanks to [@bengidev](https://github.com/bengidev) for #1586.
- Resume a retained child session once after a provider or transport abort follows useful progress, without restarting the task or involving the parent model.
- Retry unused fallback models after a provider reports a plain-text `500` or `internal server error`. Thanks to [@rafafortes](https://github.com/rafafortes) for #1642.
- Mark missing required child handoffs with useful mutation evidence as partial needs-attention results.

## [0.58.0] - 2026-08-27

### Highlights
- Launch MCP tools from more places, including runtime-registered servers, Pi package manifests, and Agent Plugin configs.
- Keep agent context smaller by default, with an explicit `inheritGlobalContext` opt-in when a child needs the operator's global context.
- Make detached and recovered workflow results more reliable, with clearer terminal handoffs and recovery actions.
- Show better launch and status diagnostics for workspace, authority, context-window, and missing-directory problems.
- Keep fast OpenAI-Codex launches compatible with priority service tier without losing provider request fields.

### Added
- Support direct MCP tool launches from runtime-registered servers.
- Add `inheritGlobalContext` agent configuration so children can opt into the operator's global context file separately from repository context. Thanks to [@hknatm](https://github.com/hknatm) for #1560.
- Add process-local event registration so independent Pi extensions can register runtime agents through the installed owner. Thanks to [@fmoda3](https://github.com/fmoda3) for #1533.
- Add advisory launch preflight diagnostics for likely workspace scope and authority mismatches.
- Document per-run thinking suffixes in model-facing subagent guidance. Thanks to [@yanqianglu](https://github.com/yanqianglu) for #1565.
- Document unsupported native child options for external CLI agents in the subagent tool help, packaged guide, and packaged skill.

### Changed
- Agents now omit the operator's global context file by default, including existing agents with `inheritProjectContext: true`; set `inheritGlobalContext: true` to preserve the previous behavior. Thanks to [@hknatm](https://github.com/hknatm) for #1560.

### Fixed
- Fail explicitly requested models closed when a cached model exclusion is active, instead of silently selecting a fallback. Thanks to [@harpsychord](https://github.com/harpsychord) for #1556.
- Preserve fast-mode provider request root fields when adding OpenAI's priority service tier. Thanks to [@nothingrotf](https://github.com/nothingrotf) for #1570.
- Classify workflow budget and timeout stops as partial terminal outcomes while preserving settled child evidence. Thanks to [@yceachan](https://github.com/yceachan) for #1530.
- Publish a deterministic terminal handoff with settled child evidence and keyed recovery actions when detached workflow lanes settle. Thanks to [@yceachan](https://github.com/yceachan) for #1530.
- Resolve direct MCP tool selections from Pi package manifests and Agent Plugin configs. Thanks to [@fmoda3](https://github.com/fmoda3) for #1541.
- Fail closed with a launch diagnostic when configured runtime-style MCP direct-tool selectors cannot be resolved.
- Sync Herdr status after restoring active async jobs, so recovered work appears without waiting for another lifecycle event. Thanks to [@vicocamacho](https://github.com/vicocamacho) for #1553.
- Show task intent and context-window use in compact in-progress async status rows.
- Report deterministic settlement diagnostics when background children fail before required output handoff.
- Auto-resume workflow children once after setup-phase aborts that produce zero usage, preserving the retained transcript instead of rerunning the whole task.
- Finalize detached foreground worktree handoffs after terminal child completion, preserving captured changes before cleanup. Thanks to [@jpriverar](https://github.com/jpriverar) for #1562.
- Fail native child launches before spawn when the requested local working directory is missing or not a directory, with the requested and resolved paths in the error.
- Map report paths requested in workflow child tasks to the actual saved child output when workflow output routing overrides them.
- Stop same-session workflows recovered after extension reload through the durable control channel.
- Let agents declare extension mutation tools so real non-Git or untracked edits satisfy the implementation completion guard. Thanks to [@AlphaGodzilla](https://github.com/AlphaGodzilla) for #1532.
- Deliver async results from an explicitly replaced predecessor session without accepting unrelated session results. Thanks to [@DresvyanskiyDenis](https://github.com/DresvyanskiyDenis) for #1531.
- Avoid attributing assistant-issued workflow stops to the user.

## [0.57.0] - 2026-08-26

### Highlights
- Run Codex, Claude Code, and Cursor Agent subagents with packaged read-only and writing profiles.
- Validate workflow scripts before launch, and reuse workflow code from files with `workflowScriptPath`.
- Resume, inspect, and recover workflow children more reliably after errors, compaction, or session reloads.
- See clearer Fleet and status output, including task labels and live context-window usage.
- Recover from more async, scheduling, discovery, model fallback, and Windows edge cases without losing useful run history.

### Added
- Add read-only and workspace-writing profiles for `codex-exec`, `claude-code`, and `cursor-agent`, with bounded result capture and opt-in smoke checks.
- Add external one-shot runner support for bounded parser hooks and logs, environment allowlists, cached launch preflight, parser progress, and process cleanup.
- Add compact external CLI capability and receipt metadata for adapter identity, artifacts, handoff mode, supervisor support, and resumability.
- Add configured pruned fork sessions with budgeted transcript-overflow summaries, stable recovery refs, and private recovery sidecars.
- Add offline `workflowScript` syntax and structural validation through the public subagent tool. Thanks to [@elecnix](https://github.com/elecnix) for #1462.
- Add `workflowScriptPath` so workflows can be loaded from files for execution, validation, and schedules. Thanks to [@elecnix](https://github.com/elecnix) for #1464.
- Add bounded workflow-child summaries to workflow results, status, receipts, and completion replay. Thanks to [@rochecompaan](https://github.com/rochecompaan) for #1453.
- Add live context-window usage to status and Fleet views, separate from cumulative token spend. Thanks to [@nazzeDe](https://github.com/nazzeDe) for #1444.
- Add active workflow task labels to compact status surfaces and Herdr pane metadata. Thanks to [@phoenixdam](https://github.com/phoenixdam) for #1459.
- Add `modelExclusions.defaultTtlMs` for controlling how long model exclusions stay active, with launch diagnostics for skipped candidates. Thanks to [@mithyer](https://github.com/mithyer) for #1439 and #1438.
- Add a package-internal one-use permit for one exact native child in a foreground `workflowScript`. Thanks to [@maroffo](https://github.com/maroffo) for #1494.

### Fixed
- Preserve agent frontmatter output defaults for prompt-template delegated leaves. Thanks to [@ashlineldridge](https://github.com/ashlineldridge) for #1521.
- Preserve structured-output and related bounded child contract fields when foreground workflow children resume. Thanks to [@Livan-pro](https://github.com/Livan-pro) for #1460.
- Preserve typed errors, partial output, transcript metadata, and artifact metadata when foreground workflow children resume. See #1513.
- Keep inline workflow children resumable from their foreground runs without mistaking a missing async directory for lost state. Thanks to [@lancegui](https://github.com/lancegui) for #1442.
- Make workflow validation and return serialization failures easier to recover from with no-child-launch diagnostics, portable rewrite guidance, workflow ids, and completed-child output references (#1432, #1434).
- Clarify terminal keyed workflow-resume failures when `workflow-receipt.json` is unavailable, including direct child-run recovery from status and event logs (#1512).
- Preserve bounded async child failure context after compaction, including missing file-only output, instead of leaving failed run summaries empty. See #1495.
- Ignore stale child-settled events from retrying compaction attempts, so resumed children are not aborted before their replacement attempt can finish. See #1504.
- Make async runs visible to exact status lookup as soon as launch succeeds, and deliver one completion when a runner dies before its normal status write. Thanks to [@rafafortes](https://github.com/rafafortes) for #1471 and [@VincentHanxiaoDu](https://github.com/VincentHanxiaoDu) for #1480.
- Record explicit completed, failed, timed-out, stopped, and interrupted outcomes in run history. Thanks to [@rafafortes](https://github.com/rafafortes) for #1474.
- Repair bounded dead async run candidates before retention classifies them, so stale run directories can be reclaimed without deleting ambiguous worktrees or branches. Thanks to [@rafafortes](https://github.com/rafafortes) for #1477.
- Exclude completed one-shot schedules from the pending schedule limit without deleting their durable history. Thanks to [@rafafortes](https://github.com/rafafortes) for #1478.
- Reclaim failed async capacity slots after a configurable abandoned timeout when the runner PID is gone, while keeping clear diagnostics for unknown process state. Thanks to [@rafafortes](https://github.com/rafafortes) for #1472.
- Preserve parent model inheritance for workflow children when workflow setup reads session data before launch, and avoid carrying a stale live-session model into scheduled owners. Thanks to [@alexei-led](https://github.com/alexei-led) for #1489 and #1490.
- Retry fallback models for transient provider connection failures. Thanks to [@genkikadomatsu](https://github.com/genkikadomatsu) for #1508.
- Resolve the `advisor` builtin alias through the bundled `oracle` definition in model listings. Thanks to [@smileBeda](https://github.com/smileBeda) for #1502.
- Follow symlinked directories during agent discovery without revisiting recursive links. Thanks to [@robsdudeson](https://github.com/robsdudeson) for #1505 and #1510.
- Explain unknown-agent failures with the effective cwd and discovery inputs. Thanks to [@genkikadomatsu](https://github.com/genkikadomatsu) for #1511.
- Resolve package subagents from bare HTTP(S) Git URLs stored in Pi settings. Thanks to [@trancikk](https://github.com/trancikk) for #1452.
- Preview runtime-recorded workflow child sessions in Fleet and inspect without trusting sibling transcripts. Thanks to [@JHa13y](https://github.com/JHa13y) for #1441.
- Distinguish same-agent parallel children in Fleet with their explicit task labels. Thanks to [@ljie-PI](https://github.com/ljie-PI) for #1487.
- Preserve the local user identity and temporary-directory environment needed by authenticated Claude Code adapter runs.
- Report child processes that exit during tool execution as mid-tool failures instead of cold starts, even when earlier assistant text exists. Thanks to [@cyzlmh](https://github.com/cyzlmh) for #1437.
- Keep unaddressable legacy result aliases and overlong public result filenames from blocking canonical hashed or pending fallbacks. Thanks to [@LeonardBode](https://github.com/LeonardBode) for #1440.
- Bypass repository fsmonitor hooks when collecting mutation evidence. Thanks to [@jpriverar](https://github.com/jpriverar) for #1497.
- Avoid the fatal Node `ReadFileUtf8` retention path. Thanks to [@pgoodjohn](https://github.com/pgoodjohn) for #1501.
- Base64-encode Herdr inspector session roots so `inspector.open` handles Windows PowerShell argument parsing correctly. Thanks to [@stavg91](https://github.com/stavg91) for #1499.
- Keep async runner terminal event delivery from crashing the session when the captured extension context is stale after a session replacement or reload. Thanks to [@AdrianAcala](https://github.com/AdrianAcala) for #1485.
- Reject non-string workflow-child summary identifiers when reading receipt metadata.

## [0.56.0] - 2026-08-23

### Highlights
- Run allowlisted OpenAI-Codex subagents with opt-in `fast` mode when you want priority service tier.
- Pass bounded extension metadata into native child launches without leaking that authority to external runners.
- Workflow scripts are easier to read when child results are stringified or returned.
- Completion guards now use safer tracked-file evidence, including large dirty files and interrupted runs.
- Model verification is less fragile for provider-qualified and variant-tagged model ids.

### Added
- Add opt-in `fast: true` launches for allowlisted native OpenAI-Codex subagents, using OpenAI's priority service tier.
- Add bounded namespaced extension bindings to child launch contracts. Thanks to [@FL03](https://github.com/FL03) for #1410.

### Fixed
- Render workflow child results as useful text when scripts stringify `runs.all` or awaited `runs.run` result objects.
- Keep checked acceptance compatible with strict workflow child `outputSchema` results. Thanks to [@rtbe](https://github.com/rtbe) for #1406.
- Use bounded tracked-file mutation evidence for implementation completion guards, including files that were already dirty when the child started. Thanks to [@rtbe](https://github.com/rtbe) for #1407.
- Bind fast mode into launch contract provenance and keep large tracked-file mutation evidence precise.
- Add timeout recovery summaries with changed tracked files, active child state, and session/artifact paths. Thanks to [@rtbe](https://github.com/rtbe) for #1409.
- Fail closed when reviewer runs are interrupted or detached workflow children settle without persisted top-level continuation proof. Thanks to [@rtbe](https://github.com/rtbe) for #1408.
- Stop flagging awaited `.then()` workflow chains as unawaited when a handler returns another child launch.
- Preserve variant-tagged model ids during verification and fallback exclusion parsing. Thanks to [@rafafortes](https://github.com/rafafortes) for #1420.

## [0.55.0] - 2026-08-23

### Highlights
- Stop a single stuck child in an async workflow without stopping the whole run.
- Continue finished external jobs, like `gpt-pro` from [Surf](https://github.com/nicobailon/surf-cli/), with follow-up requests through `resume`.
- Cap child thinking with `subagents.maxThinking` and set a preferred default provider for bare model ids.
- Scripted workflow outputs now land in the run's managed artifact directory instead of the repository root.
- Child launches fail fast with clear reasons when requested models or write tools are unavailable.

### Added
- Add `subagents.maxThinking` to enforce a thinking ceiling across native subagent launches. Thanks to [@alex-real14](https://github.com/alex-real14) for #1397.
- Add `subagents.defaultProvider` and per-agent `defaultProvider` overrides so bare subagent model ids can prefer a configured provider. Thanks to [@swingtempo](https://github.com/swingtempo) for #1393.
- Add external-job follow-ups through `subagent({ action: "resume" })` for completed provider jobs that expose `followUp(input)`, with duplicate request dedupe, durable parent-job lineage (#1381), and clearer errors when a follow-up cannot start.
- Add child-scoped stop support and child stop observer events for async/workflow runs. Malformed child stop requests are rejected instead of widening to a run-level stop. Thanks to [@yanqianglu](https://github.com/yanqianglu) for #1367.
- Create one passive Orca observer tab per top-level subagent call, with shared chain/parallel progress and project-local observer manifests. Thanks to [@hyein-cbio](https://github.com/hyein-cbio) for #1360.
- Count Herdr project panes in inline status and report compact Herdr pane title suffixes for active subagent work.
- Let `agentOverrides` set or clear default `output` paths and `defaultReads`, while preserving explicit custom-agent frontmatter and preventing settings-derived values from being serialized into custom definitions. Thanks to [@mevatron](https://github.com/mevatron) for #1349.
- Surface copyable `provider/id` model selectors from `{ action: "models" }` and point invalid model warnings at that discovery path. Thanks to [@lixinglong27](https://github.com/lixinglong27) for #1365.
- Add bundled skill guidance for lightweight task profiles before subagent fanout. Thanks to [@srcKod](https://github.com/srcKod) for #1395.
- Add delegated review guidance that separates evidence requirements from severity labels so first-pass reviews do not default to `blockers only`.

### Fixed
- Route relative `workflowScript` output paths through managed artifacts instead of creating report files in the repository root.
- Keep the async widget spinner and elapsed timer moving while the parent is idle by routing animation ticks through the live widget rebuild path. Thanks to [@0xFlo](https://github.com/0xFlo) for #1390.
- Slow async widget animation rerenders to 1 Hz so quiet running jobs do not repaint the full TUI at the liveness tick rate. Thanks to [@0xFlo](https://github.com/0xFlo) for #1376.
- Fail a Pi child launch when the child reports a different provider/model than the resolved requested model. Thanks to [@zzzubair](https://github.com/zzzubair) for #1377.
- Render detached workflow supervisor handoffs as paused/waiting and include workflow and child run ids in completion notifications.
- Report implementation runs blocked by missing child tools as blocked mutation effects instead of no-edit completion guard failures.
- Fail child launch attempts when the runtime lacks requested core write tools or an implementation worker has only read-only launch tools, including workflow children that inherit a read-only capability ceiling.
- Let read-only reviewer acceptance rely on the parent-side staged-file check instead of requiring child-reported `noStagedFiles` evidence.
- Run public single-child launches directly instead of wrapping them in a workflow, so async external-job agents do not show a completed workflow before the real provider job finishes.
- Start omitted-`async` public external-runner single-child launches in the supported background mode, so package agents such as `gpt-pro` from [Surf](https://github.com/nicobailon/surf-cli/) do not fail as foreground requests.
- Let workflow scripts await omitted-`async` external-runner children by launching them in the background internally and returning their terminal result.
- Report helpful workflow errors when `runs.all(...)` results are read as keyed objects instead of ordered arrays. Thanks to [@ravshansbox](https://github.com/ravshansbox) for #1351.
- Clarify that Council Mode can include installed external-runner advisors such as `gpt-pro` from [Surf](https://github.com/nicobailon/surf-cli/) when the `surf-cli` Pi extension has registered `surf-oracle`, with text JSON reports instead of `outputSchema`.

## [0.54.0] - 2026-08-21

### Highlights
- Subagent model selection is more precise with per-agent restrictions and an `inherit` shortcut for the current parent model.
- Package agents are easier to discover because list and detail output now shows where they come from and whether their external provider is ready.
- Workflow runs are less fragile: tool-result backfill, context-overflow handling, resumed children, and permission asks now behave more predictably.
- Child launches are lighter and safer because subagent processes avoid loading the parent extension graph and avoid unnecessary permission bridge setup.
- Council Mode is easier to use from natural language and no longer requires invented advisor role labels.

### Added
- Add per-agent model restrictions and a current-parent `inherit` allow-list alias. Thanks to [@hieudmg](https://github.com/hieudmg) for #1328.

### Changed
- Show package names, versions, and external-job provider status in subagent list and detail output so package agents such as Surf's `gpt-pro` are easier to find and use.
- Make scripted workflow helper support and stale-session recovery easier to see in `doctor` and the workflow guide (#1344).
- Keep structured single-child execution receipts quieter by removing an internal conversion log from public workflow output.
- Route natural-language requests for advisor councils, plan critique, cross-exam, or multiple model perspectives to the Council Mode protocol.
- Simplify Council Mode advisor selection so model-based profiles provide the perspective and the question supplies the decision frame.

### Fixed
- Layer custom-agent user and project overrides without dropping user-only fields, while preserving project precedence. Thanks to [@jagaliano](https://github.com/jagaliano) for #1348.
- Avoid child tool-call hangs by loading the external permission-system bridge only for explicit native permission rules and by failing stalled ask decisions closed. Thanks to [@moekyo](https://github.com/moekyo) for #1339.
- Keep foreground workflow children from timing out after a tool result is backfilled without a separate execution-end event. Thanks to [@moekyo](https://github.com/moekyo) for #1339.
- Mark completed foreground workflow children as resumable in keyed receipts when their persisted session file is available (#1335).
- Avoid loading the parent extension graph in subagent child processes. Thanks to [@ccharname](https://github.com/ccharname) for #1330.
- Stop model fallback on context-overflow failures and surface `contextOverflow`. Thanks to [@srcKod](https://github.com/srcKod) for #1323.
- Stop empty slow result scans from spamming the session transcript. Thanks to [@afrodao2394](https://github.com/afrodao2394) for #1329.
- Surface logical tool failures so subagent tool results backfill correctly. Thanks to [@abdwhb-png](https://github.com/abdwhb-png) for #1332 and [@moekyo](https://github.com/moekyo) for #1331.

## [0.53.0] - 2026-08-20

### Highlights
- New `/council` mode helps with material decisions by running a small, bounded group of advisors and ending with a parent-written decision memo.
- Pi extensions can now register runtime agents without writing user or project config.
- Async workflows are easier to resume because completed children now have durable keyed receipts.
- Model fallback is less noisy and less wasteful when a model fails or the prompt is too large.
- Extension RPC hosts can safely inspect status, launch async work, steer children, and manage schedules.

### Added
- Carry full model registry metadata, including tiered pricing, into normalized model information. Thanks to [@srcKod](https://github.com/srcKod) for #1317.
- Add runtime agent registration for Pi extensions, with name and alias collision checks. Thanks to [@fmoda3](https://github.com/fmoda3) for #1310.
- Skip recently failed fallback models for a TTL-backed window during model selection. Thanks to [@srcKod](https://github.com/srcKod) for #1318.
- Add a schedule-only `manage` method to extension RPC for list/show/history/pause/resume/run/delete, while rejecting unrelated management actions. Thanks to [@aboubakrine](https://github.com/aboubakrine) for #1319.
- Let agent definitions and `agentOverrides` set a default `outputMode`, while
  call-level output mode stays higher priority. Thanks to [@bbbRye007](https://github.com/bbbRye007) for #1305.
- Add `context: "profile"` for workflow children that should use the selected
  agent profile's declared context instead of the global default (#1303).
- Add durable keyed async workflow receipts and resume-by-key selectors for
  retained workflow children (#1302).
- Add the `resultScanLogging` config to control result scan logging. Thanks to [@apoapostolov](https://github.com/apoapostolov) for #1293.
- Add `/council` and `council-mode` for bounded advisor councils. Use it for material decisions that need multiple perspectives: the parent picks 2–3 advisors, collects independent reports, optionally runs one cross-exam pass, and writes the final decision memo. The package also documents model-based `council-*` profile examples (#1295).

### Changed
- Show bounded workflow progress in Fleet detail views while keeping workflow
  parents as the only actionable async items (#1304).
- Make `/council` easier to supervise with structured advisor contracts,
  aggregate pass receipts, and visible pass checkpoints (#1301).
- Reuse validated workflow launch fingerprints during `runs.all` batch setup, reducing focused fingerprint bookkeeping time by 48.7% (#1287).
- Speed up recent terminal run history reads when the marker history is large and the requested limit is small.
- Reduce repeated serialization while applying async status snapshot byte caps (#1288).

### Fixed
- Add tolerant `subagent_wait({ stopOnAttention: false })` blocking waits and scale idle attention defaults for higher-thinking children. Thanks to [@elecnix](https://github.com/elecnix) for #1315 and #1316.
- Add a separate classifier for model context-overflow errors. Thanks to [@srcKod](https://github.com/srcKod) for #1312.
- Normalize child result metadata before workflow return persistence (#1307).
- Quote only confidently identified leading Windows executable paths in acceptance verification commands. Thanks to [@srcKod](https://github.com/srcKod) for #1294.
- Keep forked subagent sessions out of top-level `pi -c` discovery by storing them under the parent session root. Thanks to [@xz-dev](https://github.com/xz-dev) for #1297.
- Preserve `/council` advisor context defaults during fallback and cross-exam runs (#1298).

## [0.52.1] - 2026-08-20

### Highlights
- Model setup errors now point to the right alternate provider when there is one clear match.
- Surf's optional `gpt-pro` package agent has a smoother path to run ChatGPT Pro web jobs through the external-job bridge when the user is logged in.
- External-job providers can add metadata or extra operations without breaking provider discovery.
- The packaged skill now includes a concise guide for coordinating multiple tasks, worktrees, and repositories.
- Pi extension worktrees now have clearer guidance to avoid duplicate auto-loaded tools and shortcuts.

### Fixed
- Suggest the unique alternate provider model when an explicit qualified subagent model is unavailable, without resolving across providers. Thanks to [@lallenlowe](https://github.com/lallenlowe) for #1280.
- Accept extra fields on registered external-job providers, such as `kind`, `wakeChannels`, or additional operations. This keeps integrations such as Surf's `gpt-pro` package agent from breaking provider discovery as they add browser-backed job metadata, while job payload validation stays strict.

### Changed
- Add a pi-subagents reference for coordinating multiple tasks, worktrees, and repositories, including guidance for keeping Pi extension worktrees outside auto-discovered extension directories.

## [0.52.0] - 2026-08-19

### Highlights
- Async workflows are much harder to break mid-flight: a transient status-file lock, a stalled child, or a paused supervisor hand-off no longer fails or loses an otherwise healthy run.
- Hosts can now inspect a running or completed async child on demand — task, recent transcript, and final output — without spending a model turn, and that output stays available after delivery.
- macOS and FreeBSD sandboxes stop warning about setuid `/bin/ps`, and Windows stops flashing console windows during busy runs.
- Gateway and proxy models work better: children can inherit the parent's session model, and Hugging Face-style `owner/name` model ids resolve correctly.

### Added
- Add `/subagents-inspect-rpc`, a host-facing bridge command that answers on-demand async child inspection requests with a correlated, bounded `PI_SUBAGENT_INSPECT_JSON:` widget payload (task, transcript window, final output), so RPC hosts can inspect children without a model turn while the live status feed stays small. Thanks to [@yanqianglu](https://github.com/yanqianglu) for #1254.

### Changed
- Guide oracle plan and design advice through a short same-session consultation when a material tradeoff remains, while keeping the parent as final decision-maker (#1245).
- Improve bundled role and parent prompts for source-first discovery in noisy codebases (#1247).
- Make Surf's `gpt-pro` agent an optional package integration instead of a pi-subagents builtin. If you disabled the old builtin workaround, remove `agentOverrides.gpt-pro.disabled` before using Surf's package agent. Thanks to [@binhex](https://github.com/binhex) for #1256.

### Fixed
- Stop spawning setuid `/bin/ps` for process start identity on macOS and FreeBSD. Sandboxes such as nono no longer report `forbidden-exec-sugid` from session leases, retention locks, external-job claims, or mission state. Those platforms stay fail-closed without pid-reuse detection. Thanks to [@jdumas](https://github.com/jdumas) for #1273.
- Stop a transient lock on `status.json` (seen on Windows) from failing an already-completed workflow child and aborting its still-running siblings. Status updates after launch now degrade to a `subagent.workflow.status_write_failed` event instead of failing the run, and a throwing `onTrace` host callback can no longer reject a child promise. Follow-up to #1143. Thanks to [@MarcusNeufeldt](https://github.com/MarcusNeufeldt) for #1272.
- Keep a still-paused workflow result when reconcile republishes updated child output during paused delivery, so a same-state revision is not overwritten or deleted as the old payload.
- Persist async terminal `status.json` before publishing the result file, so observers cannot see a completed result while the run still looks `running`.
- Stop Windows opening a console window for each helper process (Git, `gh`, PowerShell, `npm root -g`) spawned during a run, which made a busy run disruptive to work alongside. Thanks to [@MarcusNeufeldt](https://github.com/MarcusNeufeldt) for #1274.
- Keep completed inspect RPC output available from the durable completion replay after result delivery consumes its one-shot payload, including per-child inline result tails (#1254).
- After a workflow child detaches for supervisor coordination, clear attention once the reply is delivered, keep `subagent_wait` blocked until the child exits, and reconcile the paused workflow when that child completes — even after the paused payload was already delivered. A timed-out workflow can also resume from its persisted child session when the workflow dir has no recovery descriptor. Thanks to [@skystar567](https://github.com/skystar567) for #1263.
- Wake the idle parent when an async workflow child needs attention, and persist that control event on the enclosing workflow. Status already showed the stall; the parent notice did not. Thanks to [@Yibo-Zhang](https://github.com/Yibo-Zhang) for #1266.
- Resolve Hugging Face-style `owner/name` model ids against the registry instead of treating every slash as `provider/id`. Fully qualified `huggingface/owner/name` still wins, and a first path segment that matches a registered provider still means `provider/id`. Thanks to [@mr-brobot](https://github.com/mr-brobot) for #1264.
- Keep public structured single-child calls synchronous when `asyncByDefault:false` and `async` is omitted. Thanks to [@Nofuture123](https://github.com/Nofuture123) for #1257.
- Trust the running parent session model when no model is configured, so gateway and proxy parent models can launch children outside the host registry. Thanks to [@Nofuture123](https://github.com/Nofuture123) for #1258.
- Isolate colliding inherited workflow child output defaults while preserving explicit output collision checks. Thanks to [@Reverier-Xu](https://github.com/Reverier-Xu) for #1253.
- Show a scheduled run's completion and name the schedule that produced it, so scheduled work no longer finishes silently in a session that cannot attribute it. Thanks to [@albertgwo](https://github.com/albertgwo) for #1246.
- Show resume-first guidance for failed async runs only when a matching recovery descriptor exists, so missing recovery data no longer points users to a resume command that cannot work. Thanks to [@graadient](https://github.com/graadient) for #1241.
- Keep bundled agent discovery stable across hot package updates, so long-running sessions do not parse newer bundled agent files with older loaded code. Thanks to [@graadient](https://github.com/graadient) for #1242.
- Resolve relative extension paths against the defining agent file, so portable agent definitions load child extensions from the declared location. Thanks to [@tayiorbeii](https://github.com/tayiorbeii) for #1249.

## [0.51.0] - 2026-08-18

### Highlights
- Workflow orchestration is easier to control with stable-key steering, clearer fanout guidance, and a supported external-job runner path.
- Async runs are harder to lose when storage is full, file access is temporarily denied, identifiers are too long, or multiple Pi windows share one session.
- macOS reloads and idle sessions do less fragile filesystem watching, which avoids reload hangs without adding always-on work.
- Herdr and Fleet are less disruptive: panes stay in the background by default, trusted transcripts open cleanly, and live workflow children steer through the right route.
- The workflow API is cleaner: scripted workflows are the supported path, and removed legacy chain surfaces now have direct migration guidance.

### Added
- Add stable-key `runs.steer` to `workflowScript`, with routing for foreground and async children, structured receipts, trace entries, and checks for unawaited calls (#1186).
- Add `runner.type: external-job`, the exported provider bridge, the Surf GPT Pro `gpt-pro` profile, and docs for external advisor data boundaries (#1189).
- Add `defaultSubagentContext: "fork"` for launches that do not set an explicit context (#1161).
- Allow `defaultSubagentContext: "fresh"` to override agent fork defaults for launches that do not set an explicit context.
- Add `PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS` so hosts can cap filesystem retry waits. Unset by default. Thanks to [@MarcusNeufeldt](https://github.com/MarcusNeufeldt) for #1143.

### Changed
- Document rolling `workflowScript` fanout with `runs.run`, `Promise.race`, `runs.steer`, and `Promise.all` (#1187).
- Document scripted chaining as the supported workflow API, with migration examples for removed top-level chain and task inputs.
- Clarify `workflowScript` fanout guidance: use awaited `runs.all` for ordinary parallel work, and use stored `runs.run` promises only for fully observed advanced rolling fanout (#1229, #1230).
- Clarify that async workflows do not have inline `live-card` projection (#1229, #1230).
- Describe `async:false` as a blocking parent wait, not a UI or foreground-only mode.
- Clarify that subagent reviews and gates should stay async unless the parent must block until completion.
- Document that a host's session lifetime owns completion wakes, and how to key an idle check on live run state rather than parent activity. Thanks to [@MarcusNeufeldt](https://github.com/MarcusNeufeldt) for #1144.
- Register the default `subagent` tool prompt as split metadata with a short description, `promptSnippet`, and `promptGuidelines`, while keeping explicit `full`, `compact`, and `custom` description modes.
- Keep `worktree: true` workflow children on the single-child path while preserving managed patch handoffs.

### Removed
- Remove unused foreground chain and parallel execution and durable chain management surfaces.
- Remove legacy subagent tool compatibility fields for append-step control, schedule aliases, async recovery metadata, and string mission goals.
- Remove chain approval checkpoint steps and the `approve-checkpoint` / `reject-checkpoint` controls.
- Remove `prompts.render` from `workflowScript`; pass explicit task text to `runs.run` or use `/prompt-workflow` for reusable prompt templates.

### Fixed
- Avoid Darwin reload hangs by disabling idle native filesystem watchers and using demand-gated delivery for live results, supervisor messages, controls, and steering. Thanks to [@youlikemodernart](https://github.com/youlikemodernart) for #1220.
- Bound async result session, run, active-run, and result-index path segments so long provider IDs do not break launches or waits with `ENAMETOOLONG`. Thanks to [@hlstwizard](https://github.com/hlstwizard) for #1131 and [@zhouatie](https://github.com/zhouatie) for #1135.
- Hash result-index session segments that look like Windows paths or file names, keep reading previous URI-encoded keys, and treat `EPERM` and `EACCES` as empty scans. Thanks to [@apoapostolov](https://github.com/apoapostolov) for #1211.
- Sanitize foreground workflow output path segments derived from provider run IDs, so Windows launches do not fail when tool-call IDs contain path-invalid characters. Thanks to [@maxime-louward-shift](https://github.com/maxime-louward-shift) for #1235.
- Keep async status and result persistence retrying after temporary `ENOSPC`, quota, or file-descriptor exhaustion errors. Thanks to [@ahmadaccino](https://github.com/ahmadaccino) for #1227.
- Route async completion notifications and cleanup only to the parent Pi process that launched the run, so concurrent windows sharing one session file cannot consume each other's results. Thanks to [@wangjianming](https://github.com/wangjianming) for #1225.
- Keep extension reload cleanup scoped to the replaced session runtime, so concurrent Pi sessions in one process do not remove each other's subscriptions or parent-session identity. Thanks to [@ryanbbrown](https://github.com/ryanbbrown) for #1222.
- Stop failing child runs when an explicit allowlist names `contact_supervisor` without the legacy `intercom` companion. A lone `intercom` entry still requires a real external provider. Thanks to [@MingTeer](https://github.com/MingTeer) for #1207.
- Add explicit `isolation: "none"` for schema-driven workflows without Git worktree setup, while keeping strict `isolation: "worktree"` behavior. Thanks to [@tlsneo](https://github.com/tlsneo) for #1203.
- Fail closed when an existing external-job `status.json` is unreadable or malformed, including an invalid `steps` shape.
- Skip malformed agent definitions during discovery so valid agents still list and launch, while showing configuration errors in management diagnostics (#1200).
- Resolve `/subagents-generate-profiles` provider probes through the shared Pi executable resolver so configured and Windows-specific Pi commands work. Thanks to [@Wumpf](https://github.com/Wumpf) for #1199.
- Resolve the workflowScript parser from pi-subagents instead of the caller's working directory, so workflows start in projects that do not install Acorn. Thanks to [@xz-dev](https://github.com/xz-dev) for #1214, following up #1190.
- Keep workflowScript child-launch tracking working on Bun-built Pi without a hard dependency on V8 promise hooks. Thanks to [@rochecompaan](https://github.com/rochecompaan) for #1158 and [@rholak](https://github.com/rholak) for the version-window diagnosis.
- Treat provider subscription usage-limit errors as retryable model failures so `fallbackModels` can continue to the next configured model. Thanks to [@dwizzle204](https://github.com/dwizzle204) for #1215.
- Skip fallback models that are unavailable in the active registry, so shared agent configs still run where their primary model is available. Thanks to [@JPFrancoia](https://github.com/JPFrancoia) for #1147.
- Preserve workflow async session roots for Herdr inspectors so workflow runs open with the same trusted session-root context as standalone runs. Thanks to [@hank-warren](https://github.com/hank-warren) for #1219.
- Keep Herdr project and inspector panes in the background by default, and move focus only when callers set `focus: true`. The FleetView inspect key still focuses the pane it opens. Thanks to [@boggylp](https://github.com/boggylp) for #1226.
- Show FleetView transcript fallbacks for trusted session roots instead of warning about an untrusted session file. Thanks to [@aliceisjustplaying](https://github.com/aliceisjustplaying) for #1154.
- Route Fleet inspector steering for live in-process workflow children through their foreground routes instead of the detached async queue. Thanks to [@ViktorBarzin](https://github.com/ViktorBarzin) for #1218 and #1216.
- Serialize same-worktree Orca progress-tab creation so numbered tabs appear left to right in sequence. Thanks to [@hyein-cbio](https://github.com/hyein-cbio) for #1196.
- Bound repeated async-state queries to active, exact-id, and recent-terminal indexes instead of scanning the full async history (#1162).
- Move retention directory discovery to a read-only worker so full scans do not block the extension event loop (#1188).
- Reclaim proven-safe async run and orphan result state after 30 days in bounded, locked cleanup passes with rename-first tombstones (#1163).
- Sweep expired wait subscriptions armed by another session, so stale records stop accumulating in the subscriptions directory. Thanks to [@MarcusNeufeldt](https://github.com/MarcusNeufeldt) for #1142.
- Restore and list schedules after their project directory is deleted, and skip orphan schedule directories without letting create reuse stale state. Thanks to [@ELA718](https://github.com/ELA718) for #1171 and [@colinb4987](https://github.com/colinb4987) for #1167.
- Fall back from an implicit `defaultContext: fork` to `fresh` when the parent session file or current leaf is not available yet. Explicit `context: "fork"` remains fail-fast. Thanks to [@hyein-cbio](https://github.com/hyein-cbio) for #1137.
- Keep retained workflow children resumable when their managed worktree cwd is preserved in the handoff manifest (#1172).
- Preserve workflow child task output when neither the workflow nor child configures an output file (#1136).
- Preserve a child's file-only report when its output path also names the workflow summary output.
- Keep concurrent async result promotion from deleting a newer payload or another promoter's published result. Thanks to [@albertgwo](https://github.com/albertgwo) for #1130.
- Keep `mcp:<server>` direct tools available when pi-mcp-adapter cache identity includes a request-header command. Thanks to [@xz-dev](https://github.com/xz-dev) for #1141.
- Isolate test async state from the user temp root and write each missing-mission sync diagnostic only once (#1164, #1165).
- Keep structured delegation integration coverage active when the test process inherits a subagent-child environment marker.

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
