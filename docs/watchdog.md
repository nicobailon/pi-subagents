# Watchdog and child permissions

The watchdog is an opt-in second model that reviews what the agent just did and pushes findings back into the transcript. It looks for missed constraints, correctness risks, test gaps, unsafe changes, loop risks, and scope drift, and says nothing when the turn is clean. It is not the `reviewer` subagent; `subagents.defaultModel` and `agentOverrides.reviewer` do not configure it.

## When it runs

| Timing | Trigger | Gate | Delivery |
|---|---|---|---|
| Boundary review | `agent_end` of every main or child turn | Repo changed | Steered into the transcript; the agent gets one continuation, then that turn is reviewed again |
| Main activity review | `agent_end`, with `clarification: true` | New delivered orchestration evidence; at most one additional review per user prompt | Same warning/clarification path, even without local edits |
| Cadence review | Every `cadence.everyNTools` tool results, minimum 5 | Opt-in | Steered after the current tool, before the next step |
| LSP pre-pass | Before boundary review | Changed TypeScript/JavaScript files | Diagnostics become watchdog findings without a model call |

Boundary reviews coalesce a turn's edits into one final-state review. Unchanged or reverted diffs are skipped unless the main-only activity opt-in below admits new evidence; `.pi/subagents/` and `tmp/` artifacts remain excluded. In orchestrated runs, each writing child reviews its own worktree and the parent reviews the aggregate diff after child changes land. There are no idle timer reviews. Cadence monitoring is inspired by [Scopey](https://github.com/ArchAstro/scopey).

Children get the same boundary, cadence, and LSP behavior. Child cadence resolves from `children.overrides.<agent>.cadence`, then `children.cadence`, then top-level `cadence`:

```json
{
  "subagents": {
    "watchdog": {
      "enabled": true,
      "cadence": { "everyNTools": 10 },
      "children": {
        "enabled": true,
        "cadence": { "everyNTools": 20 },
        "overrides": {
          "worker": { "cadence": { "everyNTools": 5 } },
          "reviewer": { "enabled": false }
        }
      }
    }
  }
}
```

That means: main every 10 tools, worker every 5, other children every 20, reviewer never.

## What you see

Every finding is an ordinary transcript message: expandable, scrollable, and persisted in session JSONL. A clean review shows nothing.

```
you ─▶ agent turn ─▶ edits repo ─▶ agent_end ─▶ watchdog review
                                             ├─ clean: turn ends
                                             └─ warning: steered in; agent continues once
```

Collapsed warnings show the title and evidence line. Expanded warnings show evidence, recommended action, category, and source:

```
● Subagent watchdog Blocker (displayed): Claims tests passed without running them
  Evidence: The transcript claims `npm test` passed but no test command appears in the tool log.
  Recommended action: Run the focused test before finishing.
  Category: Test Gap · Source: main
```

When consecutive boundary reviews raise the same warning, the agent is not making progress. After `stalemateRepeats` identical warnings in a row (default 3), the warning is shown as `stalemate`, no continuation is triggered, and the turn ends. Your next prompt resets the count.

Child watchdog findings are lifted into the parent in three ways:

- The result envelope contains `watchdog.warnings` with severity, category, summary, evidence, recommended action, `addressed`, and `stalemate`, bounded to the last 20.
- The acceptance runtime check `watchdog-blocker` fails on blockers that are unaddressed or stalemate.
- Completion notices include `Watchdog blockers:` lines, and Fleet/status views show `wd:<n>` plus `resolve watchdog blockers`.

`/subagents-watchdog status` shows setting sources, enabled state, runtime state, review trigger, scope, cadence, LSP status, selected model/thinking, child overrides, timeout, stalemate count, launch-rule count, review backend, last warning, changed paths, and config errors when present.

## What the reviewer is given

- **Turn delta** with changed repo paths. Over-long input keeps the first 6,000 characters and the tail.
- **Current scope** (`scope.enabled`, default on): bounded real user prompts. Side questions are additive; only explicit changes supersede older requirements.
- **`watchdog_diff`** when inside git: diff since the session-start commit, including later commits, plus untracked paths to inspect with `read`; accepts `path` and `stat:true`.
- **`WATCHDOG.md`** standing instructions, read fresh on every review: `<project>/.pi/WATCHDOG.md` first, then `~/.pi/agent/WATCHDOG.md`, capped at 8,000 characters. Set `guidance.watchdogMd: false` to ignore them.
- **LSP diagnostics** from `typescript-language-server`, auto-detected in `node_modules/.bin` or `PATH`; it is never installed and never run over the whole workspace. Errors become blockers, warnings concerns, and info/hints stay in status.

## Choosing a model

One model setting serves both boundary and cadence reviews per endpoint. Use a strong complementary model for rare adversarial boundary reviews, or a cheap one for frequent cadence monitoring.

```text
/subagents-watchdog recommend-model
/subagents-watchdog session model recommended
/subagents-watchdog model recommended
/subagents-watchdog model anthropic/claude-opus-4-8:high
/subagents-watchdog model openai-codex/gpt-5.5:high
/subagents-watchdog model inherit
/subagents-watchdog check
/subagents-watchdog on
```

The recommendation is Opus 4.8 or GPT 5.5 at thinking high, whichever your main session is not using and is authenticated. Saving a model does not enable the watchdog; use `on` separately.

```json
{
  "subagents": {
    "watchdog": {
      "enabled": true,
      "main": { "model": "anthropic/claude-opus-4-8", "thinking": "high" },
      "scope": { "enabled": true },
      "cadence": { "everyNTools": 10 },
      "stalemateRepeats": 3
    }
  }
}
```

Omit `main.model` to inherit the session model and thinking level. A `main.model` without a thinking suffix or `main.thinking` runs with thinking off, so prefer `:high` for the strong pairing.

Agents can call `subagent({ action: "watchdog.recommend-model" })` and `subagent({ action: "watchdog.configure", model: "recommended", scope: "session" | "user" | "project" })`. They should use `scope: "session"` unless you ask for a lasting default.

## Optional main-session clarification

Use `watchdog_warn` directly for evidence-backed reminders of forgotten authorized work; a question is not a prerequisite. Distinguish forgotten work from dependencies still pending or explicit holds. Use clarification when task status or intent is genuinely unclear. The orchestrator remains owner of its task/lane board.

With this opt-in, completed `turn_end` events retain a recent actual-activity tail: paired calls/results for `subagent` dispatch (no action), `subagent` actions `status`, `resume`, `interrupt`, `steer`, `stop`, `bg_wait`, and `subagent_supervisor` actions `pending`, `list`, `reply`. Pairing requires the same tool name and exact tool-call ID; raw results, unrelated tool names and watchdog management/reply actions do not qualify. Each activity entry is bounded to 3,000 characters, with a 6,000-character recent tail retained across ordinary new prompts and skipped edit boundaries. Session replacement, compaction, shutdown or disabling clears it. This is observed text, not an inferred task board.

New unreviewed activity permits at most one additional boundary review per user prompt even with no local edit. Side questions keep earlier authorized task evidence available; they do not themselves trigger a model call. Activity gathered after that prompt's extra review remains available for the next prompt. Watchdog reply receipts and warning continuations cannot supply fresh triggering activity. No polling, task scheduling, cross-worktree scans or idle calls are added.

**Visibility limit:** external task/gate completions are visible when returned through those parent tool results. Standalone native completion notifications, arbitrary custom messages, direct shell/CI output, and events not delivered to the parent through these contracts are not ingested by this activity tail. Existing scope retains at most eight prompts (2,000 characters each); new streaming user input cancels an exchange but is not added to scope unless `before_agent_start` fires. Reminders depend on retained evidence and model judgment, not an exhaustive view of running work.

Set `subagents.watchdog.clarification: true` in Pi settings alongside `enabled: true`. It defaults to `false` and applies **only to the main watchdog**, not child watchdogs or child permission arbitration.

```json
{ "subagents": { "watchdog": { "enabled": true, "clarification": true } } }
```

At an eligible activity or Git-backed repo-edit boundary, the reviewer may use `watchdog_ask` for one focused question when missing orchestrator context prevents a concrete judgment. The non-Git observed-edit fallback cannot verify unchanged edits across Q/A and remains warning-only; no-edit activity exchanges instead check the prompt epoch and activity sequence. The reviewer cannot ask during cadence reviews, after an accepted warning, during stalemate, or during the reply review. There is at most one question per real user prompt, including unanswered questions.

The tool **yields and ends that review**; it does not wait for or return an answer. A visible request steers the main session into Pi's native automatic continuation after the boundary hook returns. The orchestrator answers before changing files:

```js
subagent({ action: "watchdog.reply", id: "<exact request UUID>", message: "The missing context..." })
```

The action records a receipt only. At the next boundary, one fresh review receives the original bounded evidence and Q/A, even if answering made no edits. Freeform prose, wrong IDs, duplicate replies and late replies do not count. Changed repo or activity evidence cancels the exchange; new evidence can receive an eligible ordinary review, without another question that prompt. A question or answer is **not approval, permission, or a warning**. Read-only tools, warning thresholds, budgets and stalemate protections still apply.

Requests expire after 60 seconds or close unanswered at the next boundary, without retrying or triggering a nag. A timely recorded answer can start its bounded review after that deadline. Cancel by disabling watchdog (`/subagents-watchdog session off`), turning clarification off, or submitting a new user prompt. Aborts, model changes, session switch/fork/compaction and shutdown also discard pending exchanges and invalidate active reply reviews. Status shows the request ID and pending/answered/terminal state; terminal notices never trigger a turn. Requests are in-memory only and are never restored from transcripts.

Each review phase uses the existing `agentEndTimeoutMs`. Questions, evidence and replies are capped at 1,000, 2,000 and 4,000 characters respectively; scope, activity, delta and Q/A share the existing 24,000-character input limit. Enabled cost adds at most one activity boundary review plus one question/answer continuation and its fresh review per prompt. Disabled execution does not collect activity or add clarification timers, scans, polling, model calls or reviewer prompt/tool content. Child warning messaging and permission decisions remain unchanged.

## Child watchdogs

Opt in under `subagents.watchdog.children`. `model` and `thinking` set the default child watchdog; `overrides.<agent>` can set `model`, `thinking`, `enabled`, or `cadence` per role.

## Launch rules

`subagents.watchdog.rules` pins which models each role may run on. It runs before a child starts, needs no model call, and applies even when model review is off.

```json
{
  "subagents": {
    "watchdog": {
      "rules": {
        "action": "warn",
        "roleModels": {
          "scout": { "allow": ["openai-codex/gpt-5.6-luna:max"] },
          "oracle": { "deny": ["*"], "note": "oracle is for hard questions only; ask before launching" },
          "worker": { "deny": ["openai-codex/gpt-5.6-sol:high"] }
        }
      }
    }
  }
}
```

`action: "warn"` steers a concern into the orchestrator transcript and lets the launch proceed. `action: "block"` returns a tool error and starts nothing. `allow` and `deny` are anchored, case-sensitive globs (`*`, `?`) matched against `provider/id[:thinking]` and bare `provider/id`; `deny` wins. Rules apply to direct launches, workflow children, and chain/parallel steps using settings visible at the launch cwd.

## Native child tool permissions

Opt-in, Pi child runtimes only. With no rules, every tool call passes through. Global non-bash rules live in `~/.pi/agent/extensions/subagent/config.json`; agents override matching rules in `permission:` or `permissions:` frontmatter:

```yaml
---
name: worker
permission:
  write: allow
  edit: ask
---
```

Values are `allow`, `ask`, and `deny`. Agent rules override global ones, omitted and unknown tools default to `allow`, an explicit `allow` removes an inherited restriction, and the gate is not registered when the resolved policy has no `ask` or `deny`.

`ask` pauses that exact tool call and sends a bounded, redacted preview to a one-call arbiter owned by the child watchdog, using the configured child-watchdog model. The arbiter returns only `approve` or `deny` and does not notify the parent. A disabled watchdog, missing model/auth, timeout, malformed response, or runtime error denies the call with a clear error. Requests and decisions are written to bounded audit JSONL. `contact_supervisor` and the optional `pi-intercom` extension are never permission-gated.

Bash is always passed through; bash rules are rejected. Use `pi-guard` for command-level policy. Children are pi sessions inside the parent process (foreground) or the detached runner process (background), not separate `pi` binaries, so there is no per-child command wrapper; load `pi-guard` into a child through the agent's `extensions` or `subagentOnlyExtensions`, and background children also pick it up as an ambient extension. External CLI profiles are opaque processes, so native permissions cannot intercept their tools; launches with effective `ask` or `deny` rules are rejected for external CLI agents.
