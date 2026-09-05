# Models

How subagents pick models, and how to change that.

Builtin agents inherit your current Pi default model. This keeps new installs from depending on a provider you may not have configured. From there you can layer defaults and overrides:

- `subagents.defaultModel` — a default for every subagent that does not set its own model.
- `subagents.defaultProvider` — a provider preference for bare model ids, such as `llama-3`, when multiple providers expose the same id.
- `subagents.agentOverrides.<name>.model` — pin one role.
- `subagents.agentOverrides.<name>.defaultProvider` — choose or clear the provider preference for one role.
- `subagents.agentOverridesByProvider.<provider>.<name>` — layer role fields for the active parent provider.
- Per-run overrides — for one launch only.

Precedence, strongest first: per-run override → provider-scoped role override → `agentOverrides.<name>.model` → agent frontmatter `model` → `subagents.defaultModel` → the parent session model. A provider preference does not replace this order; it only resolves bare model ids when the active registry has more than one match. Fully qualified `provider/model` strings still win exactly.

Use `model: "inherit"` in agent frontmatter or `agentOverrides.<name>.model` to select the current parent session model explicitly.

## Setting defaults and overrides

In `~/.pi/agent/settings.json` (user) or the project config settings file (`.pi/settings.json` in standard Pi; project wins):

```json
{
  "defaultModel": "deepseek-v4-pro",
  "subagents": {
    "defaultModel": "deepseek-v4-flash",
    "defaultProvider": "gpu-a",
    "agentOverrides": {
      "oracle": {
        "model": "deepseek-v4-pro"
      },
      "worker": {
        "defaultProvider": "gpu-b"
      }
    }
  }
}
```

To keep one role definition but configure it differently for work and personal providers, add the unambiguous provider map beside `agentOverrides`:

```json
{
  "subagents": {
    "agentOverrides": {
      "worker": { "thinking": "medium" }
    },
    "agentOverridesByProvider": {
      "github-copilot": {
        "worker": { "model": "github-copilot/gpt-5-mini" }
      },
      "openrouter": {
        "worker": { "model": "openrouter/openai/gpt-5-mini" }
      }
    }
  }
}
```

The provider key comes from the active parent session model (or an explicit host `preferredProvider`) before fallback selection. Provider-scoped fields layer over the ordinary override in the same settings file; project settings still win over user settings. A fallback attempt does not switch the selected provider configuration.

For one run, put the override in the command:

```text
/run reviewer[model=anthropic/claude-sonnet-4:high] "Review this diff"
```

For a persistent role override with a backup model for provider failures:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high",
        "fallbackModels": ["openai-codex/gpt-5.6-luna:low"]
      }
    }
  }
}
```

`subagents.defaultModel` and `subagents.defaultProvider` apply to builtin, package, user, and project agents. `defaultModel` fills only agents that do not set `model` in frontmatter. `defaultProvider` is also applied to frontmatter and override models so bare ids resolve against the intended provider. Per-run model overrides and `agentOverrides.<name>.model` win over frontmatter and the global default. The same `agentOverrides` block can change `tools`, `skills`, inherited context, prompt text, or disable an agent (see [agents.md](agents.md)); matching custom-agent frontmatter is replaced for any field set by the override.

## Fast mode

Set `fast: true` on a run, in agent frontmatter, or in `subagents.agentOverrides.<name>.fast` to request the OpenAI priority service tier for supported native OpenAI-Codex children. This can use a higher quota tier or cost more. It is off by default.

Fast mode fails before launch unless every resolved model candidate is on the allowlist. The current allowlist is `openai-codex/gpt-5.6-luna` and `openai-codex/gpt-5.6-sol`. External runners, Anthropic models, and other providers do not use fast mode.

## Recommended model tiering (optional)

A setup that works well in practice: route agents by task shape instead of running everything on one model. Four tiers:

1. **Fast workhorse** — the cheapest capable model at low thinking, for recon, lookups, and mechanical edits. Example: `openai-codex/gpt-5.6-luna:low` on `scout`.
2. **Standard well-scoped** — a mid-tier model at medium thinking, for most delegations: routine multi-file edits, focused reviews, straightforward implementation. Example: `openai-codex/gpt-5.6-luna:max` on `worker`, `reviewer`, and a lightweight `delegate` agent.
3. **Deep but bounded** — a top reasoning model at high thinking, only for hard tasks that arrive with explicit goals and completion criteria. These models tend to loop on vague goals, so keep them off open-ended work. Example: `openai-codex/gpt-5.6-sol:high` on oracle-style agents.
4. **Taste and intent** — a model that reads human intent well and makes judgment calls without looping, for ambiguous work: UX and design decisions, product tradeoffs, planning from vague requirements, writing quality. Example: `anthropic/claude-fable-5` at `low` for lighter passes and `medium` for harder ones.

The routing rule: use the capability tiers (1–3) when the task is well-scoped, and the intent tier (4) when scoping or judging is the task itself.

Give tier-4 agents `fallbackModels` for retryable provider/model failures such as rate-limit, overload, unavailable-model, and provider-reported timeout errors **before any tool activity**. Once a tool has started, a provider failure (including HTTP 429) fails the run rather than replaying the task on another model. Ordinary task failures and the outer run-level `timeoutMs` / `maxRuntimeMs` deadline do not trigger fallback.

Fallback uses native Pi sessions, not fresh `pi` CLI processes. Even when an exact session file is reopened, normal fallback resubmits the original task; retained history alone does not make automatic continuation after tool work safe.

Example fallback configuration:

```yaml
---
name: shaper
description: Open-ended design/UX/product/planning agent for ambiguous tasks
model: anthropic/claude-fable-5
thinking: medium
fallbackModels: openai-codex/gpt-5.5:high
---
```

One interaction worth knowing for tier 4: forked context over an Anthropic parent transcript with signed thinking blocks forces the child's thinking off, so intent-tier agents work best with fresh context.

## Thinking level defaults

Set `subagents.defaultThinking` to give builtin, package, user, and project agents without a `thinking` value a shared thinking level, independent of the parent session's default. Project settings win over user settings. Matching `agentOverrides.<name>.thinking` and per-run thinking overrides replace frontmatter; otherwise explicit frontmatter remains in effect. `thinking: false` remains an explicit opt-out:

```json
{
  "subagents": {
    "defaultThinking": "medium",
    "agentOverrides": {
      "reviewer": { "thinking": "high" }
    }
  }
}
```

If your provider rejects model IDs with thinking suffixes, set `subagents.disableThinking: true` in user or project settings. That clears bundled builtin thinking defaults in one place. An explicit higher-precedence `agentOverrides.<name>.thinking` value can opt a role back in or replace custom-agent frontmatter thinking.

### Thinking ceiling

Set `subagents.maxThinking` to enforce a hard maximum for every native Pi child. The supported levels, from least to most thinking, are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`:

```json
{
  "subagents": {
    "defaultThinking": "medium",
    "maxThinking": "xhigh"
  }
}
```

Requests above the ceiling fail before child startup; the setting covers frontmatter, `agentOverrides`, per-run overrides, fallback models, parallel/chain children, nested launches, and resumed children. Project settings take precedence over user settings. External runners retain their existing behavior.

## Extension defaults

Set `subagents.defaultExtensions` to give builtin, package, user, and project agents without an `extensions` field a shared extension allowlist:

- Absent: preserves Pi's normal ambient extension discovery.
- Empty array: sets `extensions: []` for agents that do not explicitly define it, disabling ambient extension loading.
- Non-empty array: supplies that allowlist to agents that do not explicitly define one.

Project settings win over user settings. Use `agentOverrides.<name>.extensions` for per-agent settings; a matching override replaces custom-agent frontmatter for that field.

```json
{
  "subagents": {
    "defaultExtensions": [],
    "agentOverrides": {
      "researcher": {
        "extensions": ["./tools/research.ts"]
      }
    }
  }
}
```

A non-array value, an array containing a non-string entry, or an empty/whitespace-only string raises a settings error naming `defaultExtensions` and the offending settings file, matching the validation pattern used by `defaultModel` and `defaultThinking`.

## Inspecting the live mapping

To see what `pi-subagents` has actually loaded right now:

```text
/subagents-models
/subagents-models reviewer
```

That reports the live runtime mapping, which can differ from settings on disk until you reload Pi.

## Fuzzy model matching

You do not have to spell a model exactly. Model ids are matched fuzzily against the registry, so these all resolve to the same model:

- Provider separator variations: `anthropic/claude-sonnet-4`, `anthropic:claude-sonnet-4`, `anthropic.claude-sonnet-4`
- Id separator variations: `claude-haiku-4.5` vs `claude-haiku-4-5`
- Case differences: `Claude-Sonnet-4` vs `claude-sonnet-4`
- Optional trailing date stamps: `claude-haiku-4-5-20251001` or `claude-haiku-4-5-2025-10-01` vs `claude-haiku-4-5`

Exact `provider/id` matches still win, and a qualified provider query never silently switches providers — it only matches within the named provider. Ambiguous bare ids that exist under multiple providers still require a provider prefix or the current session's provider to disambiguate.

Registry ids that themselves contain `/` (Hugging Face `owner/name`) resolve the same way as Pi's main agent: `thinkingmachines/Inkling` becomes `huggingface/thinkingmachines/Inkling` when that id is unique or offered by the current session provider. A first path segment that matches a registered provider still means `provider/id`.

## Model scope enforcement

To keep subagents inside a budget or compliance profile, enforce a model scope. Put `subagents.modelScope` in user or project settings (project overrides user):

```json
{
  "subagents": {
    "modelScope": {
      "enforce": true,
      "strict": true,
      "allow": ["inherit", "openai/gpt-5-*", "openai-codex/gpt-5.6-*"],
      "agents": {
        "worker": { "allow": ["openai-codex/gpt-5.6-luna"] },
        "reviewer": { "allow": ["inherit"] }
      }
    }
  }
}
```

- `allow` is a list of glob patterns matched against the resolved `provider/id` (only `*` is special, case-insensitive). The literal `inherit` means the current parent session model.
- `agents.<name>` adds a second allow-list for that agent. The model must pass both the global list and the matching agent list, so an agent rule cannot weaken the global rule. Agent rules inherit `enforce` and `strict` when those fields are absent.
- A top-level `enforce: true` with only agent allow-lists restricts only those named agents. Unknown names are allowed so settings can be shared across projects and machines.
- Models you pass explicitly — the tool-call `model`, `--model`, or a clarify pick — error and abort the run.
- By default, models from agent frontmatter, `subagents.defaultModel`, the inherited parent session model, or fallback chains only warn and remain available, so existing configurations keep working while you tighten the scope.
- Set `strict: true` with `enforce: true` to reject every resolved out-of-scope model. This includes inherited models and fallback candidates. An invalid fallback fails the run instead of being removed from the candidate chain.
- `enforce: true` requires at least one non-empty global or agent `allow` list; otherwise the config is rejected at load time.

Model scope is policy only. It rejects or warns; it does not select a cheaper model. Set `agentOverrides.worker.model` to choose a worker model and use `modelScope.agents.worker` to prevent a per-run override or fallback from escaping that restriction.

`inherit` expands in the parent process at each launch. It is never sent to the child as a model id. A nested child therefore inherits its immediate parent's current model, not the original top-level model. If no parent model is available, an enforced `inherit` entry does not match and fails closed.

Project `modelScope` settings replace the complete user `modelScope`, as with the existing project-over-user settings precedence. Project settings are trusted and can therefore replace user restrictions.

## Profiles and provider model catalogs

Profiles let you generate and save role-to-model assignments from a provider's live catalog.

Profiles are stored under:

```text
~/.pi/agent/profiles/pi-subagents/
```

Provider model catalogs are cached under:

```text
~/.pi/agent/profiles/pi-subagents/providers/
```

The workflow:

```text
/subagents-refresh-provider-models openai-codex
/subagents-generate-profiles openai-codex
/subagents-load-profile openai-codex.quota
```

- `/subagents-refresh-provider-models` writes a serialized provider model catalog with observed registry data, simple role-oriented classification, and live probe results from tiny one-shot `pi -p --model ... --no-tools` checks. The cache refreshes when missing or stale; use `--force` to ignore freshness and probe again immediately.
- `/subagents-generate-profiles` uses the provider catalog to produce quota and quality profiles.
- `/subagents-check-profile` re-checks each assigned model in a saved profile against the current registry and a live probe, so you can detect model removals, auth problems, or stale assignments.
