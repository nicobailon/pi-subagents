# Watchdog and child permissions

The watchdog is an opt-in second model that reviews what the agent just did and pushes findings back into the transcript. It looks for missed constraints, correctness risks, test gaps, unsafe changes, loop risks, and scope drift, and says nothing when the turn is clean. It is not the `reviewer` subagent; `subagents.defaultModel` and `agentOverrides.reviewer` do not configure it.

## When it runs

| Timing | Trigger | Gate | Delivery |
|---|---|---|---|
| Boundary review | `agent_end` of every main or child turn | Repo changed | Steered into the transcript; the agent gets one continuation, then that turn is reviewed again |
| Cadence review | Every `cadence.everyNTools` tool results, minimum 5 | Opt-in | Steered after the current tool, before the next step |
| LSP pre-pass | Before boundary review | Changed TypeScript/JavaScript files | Diagnostics become watchdog findings without a model call |

Boundary reviews coalesce a turn's edits into one final-state review. Unchanged or reverted diffs are skipped, as are `.pi/subagents/` and `tmp/` artifacts. In orchestrated runs, each writing child reviews its own worktree and the parent reviews the aggregate diff after child changes land. There is no timer or "every turn regardless of edits" mode; the closest is a low cadence such as `everyNTools: 5`. Cadence monitoring is inspired by [Scopey](https://github.com/ArchAstro/scopey).

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
- **Current scope** (`scope.enabled`, default on): bounded real user prompts, with newer prompts superseding older ones.
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
