# Watchdog and child permissions

The watchdog is an opt-in adversarial reviewer for repo edits. This page covers what it reviews, how to pick its model, scope monitoring, LSP diagnostics, and the native child tool permission gate that uses the child watchdog as its arbiter.

## What the watchdog reviews

The watchdog is not the `reviewer` subagent. `subagents.defaultModel` and `subagents.agentOverrides.reviewer` do not configure it.

It reviews repo edits, not ordinary conversation:

- It runs at the safe `agent_end` boundary, only when the current agent or child writer changed the final repo state since the start of that turn.
- Multiple edits in one turn are coalesced into one review of the final changed state.
- Unchanged/reverted diffs are skipped.
- Generated `.pi/subagents/` or `tmp/` artifacts do not trigger review.
- In orchestrated runs, each writing child can review its own edited worktree, and the parent can still review the aggregate repo diff after child changes are applied.

## Choosing a model

Because the watchdog is an adversarial change reviewer, it should usually use a strong complementary model rather than a cheap/light one.

Ask pi-subagents for the current strong pairing:

```text
/subagents-watchdog recommend-model
/subagents-watchdog session model recommended
/subagents-watchdog model recommended
```

The current recommendation policy is Opus 4.8 with thinking high or GPT 5.5 with thinking high. If your main session is using one, the watchdog should use the other when that model is authenticated.

- `session model recommended` changes only the current Pi session.
- `model recommended` saves the recommendation to `~/.pi/agent/settings.json`. It does not turn the watchdog on; enable it separately with `/subagents-watchdog on`.

Or set the model explicitly:

```text
/subagents-watchdog model anthropic/claude-opus-4-8:high
/subagents-watchdog model openai-codex/gpt-5.5:high
/subagents-watchdog model inherit
/subagents-watchdog check
```

In settings files, use `subagents.watchdog.main.model` and `subagents.watchdog.main.thinking` for the main watchdog:

- If `main.model` is omitted, the main watchdog uses the current session model and thinking level.
- If `main.model` is set without a thinking suffix or `main.thinking`, it runs with thinking off. Prefer `:high` or `"thinking": "high"` for the strong-watchdog pairing.

Default strong-reviewer profile:

```json
{
  "subagents": {
    "watchdog": {
      "enabled": true,
      "main": {
        "model": "anthropic/claude-opus-4-8",
        "thinking": "high"
      }
    }
  }
}
```

## Scope monitoring

When enabled, the watchdog keeps a bounded in-memory current-scope artifact from real user prompts and prepends it to review input by default (`subagents.watchdog.scope.enabled`). Newer prompts supersede and mutate older prompts, so the reviewer can flag work that no longer serves the current scope as `scope-drift`.

You can opt into Scopey-style scope monitoring, inspired by [Scopey](https://github.com/ArchAstro/scopey), by setting `subagents.watchdog.cadence.everyNTools` to run additional non-blocking reviews every N tool results. Cadence warnings are transcript-visible and delivered with Pi's `steer` mode after the current tool boundary; they are never hidden. The same configured watchdog model is used for all checks, so choose a cheap model for frequent monitoring or a strong model for rarer adversarial review.

Scopey-style profile:

```json
{
  "subagents": {
    "watchdog": {
      "enabled": true,
      "main": {
        "model": "anthropic/claude-haiku-4-5",
        "thinking": "medium"
      },
      "scope": { "enabled": true },
      "cadence": { "everyNTools": 10 },
      "stalemateRepeats": 3
    }
  }
}
```

## Stalemate

A warning displayed at `agent_end` is steered into the transcript, so Pi continues the run and the agent sees it before finishing. When consecutive boundary reviews keep raising the same warning, the agent is not making progress: after `subagents.watchdog.stalemateRepeats` identical warnings in a row (default 3) the watchdog marks the warning `stalemate` and shows it without continuing the run. A new user prompt resets the count.

## Standing instructions

The watchdog reads standing reviewer instructions from `WATCHDOG.md` on every review, so edits take effect without restarting Pi. Two locations are read, project first and then user:

- `<project>/.pi/WATCHDOG.md` (the project config directory)
- `~/.pi/agent/WATCHDOG.md` (the agent directory)

Both files are concatenated and capped at 8,000 characters from the head. Use them for project rules the reviewer should hold the agent to, such as "never accept skipped tests" or "do not raise backwards compatibility unless the task requires it". Set `subagents.watchdog.guidance.watchdogMd` to `false` to ignore both files.

## LSP diagnostics

When the watchdog is enabled, it also checks changed TypeScript and JavaScript files for fresh language-server diagnostics before the model review.

- It auto-detects `typescript-language-server` from the project `node_modules/.bin` or `PATH`. It never installs tools or scans the whole workspace.
- LSP errors surface as watchdog blockers, warnings as concerns, and info/hints stay in status details.
- Slow or missing servers are reported in `/subagents-watchdog status` without blocking the turn or emitting late mid-turn warnings.
- Configure the bounds with `subagents.watchdog.lsp.enabled`, `timeoutMs`, `maxFiles`, and `maxDiagnostics`.

## Child watchdogs

For child subagent watchdogs, use `subagents.watchdog.children.model` as the default child watchdog model, or `subagents.watchdog.children.overrides.<agent>.model` for a specific child role.

Child watchdogs are opt-in and follow the same edit-gated rule: read-only children do not trigger watchdog reviews, while writer children are reviewed at their own `agent_end` if their worktree changed.

Children also run the mid-run cadence reviews described under scope monitoring. The cadence comes from `subagents.watchdog.children.overrides.<agent>.cadence`, then `subagents.watchdog.children.cadence`, then the top-level `subagents.watchdog.cadence`. Cadence reviews are not edit-gated, so a worker that wanders without editing is still checked every N tool results.

### Seeing the diff

Every reviewer, main or child, gets a read-only `watchdog_diff` tool alongside `read`, `grep`, `find`, and `ls`. It shows the repository diff against the commit that was current when the session started (tracked changes, later commits included, plus untracked files as additions), optionally narrowed to one path or reduced to per-file counts. A child in a managed worktree therefore sees exactly its own changes; a child in a shared cwd also sees changes that were already pending when it started. Sessions outside a git repository do not get the tool.

### Findings reach the orchestrator

A child watchdog warning is displayed inside the child session and also lifted into the parent:

- **Envelope.** Every warning is summarized on the result's `watchdog.warnings` (severity, category, summary, evidence, recommended action, `addressed`, `stalemate`), bounded to the last 20. `addressed` becomes true when a later assistant turn in the child followed the warning. Workflow status files carry the same list per step.
- **Acceptance.** When a watchdog was attached, acceptance evaluation adds the runtime check `watchdog-blocker`. A blocker that no turn followed, or that reached stalemate, fails the check with `Unresolved watchdog blocker: <summary>`, which rejects explicit acceptance like any other failed check.
- **Notify.** Completion notices list blockers after the result preview as `Watchdog blockers:` with one `- <agent>: <summary> (addressed | unaddressed | stalemate)` line each. Fleet and status views show a `wd:<n>` chip for unresolved blockers.
- **Live.** A blocker is also posted to the parent immediately over the supervisor channel as a non-reply `watchdog_blocker` notice, so an orchestrator can react before the child exits. Concerns stay in the envelope only.

## Launch rules

`subagents.watchdog.rules` holds deterministic checks that run before a child starts. They need no model call and apply whether or not the model review is enabled.

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
        },
        "minStages": { "worker": 2 },
        "forbidAfterLaunch": ["bg_wait"]
      }
    }
  }
}
```

- `action`: `warn` (default) steers a watchdog concern into the orchestrator's transcript and lets the launch proceed; `block` returns a tool error and starts nothing.
- `roleModels.<agent>.allow` / `deny`: globs (`*`, `?`) matched against the resolved `provider/id[:thinking]` and against the bare `provider/id`. `deny` wins. An optional `note` is included in the warning text. Evaluated for direct launches, workflow children, and chain or parallel steps.
- `minStages.<agent>`: a workflowScript that launches `<agent>` at least once but fewer than N times, or a direct single launch of `<agent>`, triggers the rule. Literal `agent:` names in `runs.run` and `runs.all` are counted; dynamic agent expressions are not.
- `forbidAfterLaunch`: tool names the orchestrator should not call after a subagent launch in the same run. Checked on every `tool_call`; `block` refuses the call with the rule as the reason.

`/subagents-watchdog status` reports the number of configured rules and the action.

## Agent-driven configuration

Agents can configure the same values through the tool when you ask them to set up the watchdog:

```ts
subagent({ action: "watchdog.recommend-model" })
subagent({ action: "watchdog.configure", model: "recommended", scope: "session" })
subagent({ action: "watchdog.configure", model: "recommended", scope: "project" })
```

Persistent scopes (`user` or `project`) should only be used when you ask for a lasting default. Otherwise the agent should use `scope: "session"`.

## Native child tool permissions

Native permissions are opt-in and apply only to Pi child runtimes. With no rules configured, every tool call passes through unchanged.

Configure explicit non-bash rules globally in `~/.pi/agent/extensions/subagent/config.json`:

```json
{
  "permissions": {
    "rules": {
      "read": "allow",
      "write": "ask",
      "edit": "deny"
    }
  }
}
```

Custom agents can override matching global rules with a `permission:` or `permissions:` frontmatter block:

```yaml
---
name: worker
permission:
  write: allow
  edit: ask
---
```

Rules support `allow`, `ask`, and `deny`:

- Agent rules override matching global rules.
- Omitted and unknown tools default to `allow`.
- Explicit `allow` removes an inherited restriction.
- The gate is not registered when the resolved policy has no `ask` or `deny` rules.

### How `ask` works

An explicit `ask` pauses that exact tool call and sends a bounded, redacted preview to a one-call permission arbiter owned by the built-in child watchdog. The arbiter uses the configured child-watchdog model and returns only `approve` or `deny`; it does not notify the parent agent.

Enable and configure `subagents.watchdog.children` before using `ask` rules. A disabled watchdog, missing model/auth, timeout, malformed response, or runtime error denies the call with a clear error.

Asked requests and decisions are written to bounded audit JSONL, including `decisionSource: "watchdog"` and bounded failure reasons. Ordinary direction and clarification through `contact_supervisor` or the optional `pi-intercom` extension remain separate and are never permission-gated.

### Bash is out of scope

`bash` is always passed through by pi-subagents. Bash rules are rejected rather than parsed, gated, denied, or audited. Install and configure `pi-guard` when command-level bash policy is needed.

A pi-subagents child is headless, so a pi-guard rule that resolves to `ask` cannot request approval from the parent Pi UI. Native permissions do not forward pi-guard decisions; they only apply to the separate non-bash child permission gate. For child-specific policy, use `PI_GUARD` through a `PI_SUBAGENT_PI_BINARY` wrapper or an equivalent launch wrapper, and configure explicit `allow` or `deny` rules. An `allow` rule grants execution; it is not approval forwarding, so retain explicit denies for commands the child must not run.

### External CLI profiles

External CLI profiles are opaque processes, so native permissions cannot intercept their tools. A launch with effective `ask` or `deny` rules is rejected for an external CLI agent instead of claiming enforcement.
