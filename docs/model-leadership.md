# Model Leadership

This extension includes an **optional** model leadership feature. It ranks your locally available models against public benchmark data so subagents can pick the strongest model for each task.

## What Model Leadership gives you

Model Leadership has two parts that work together:

1. **Selection** — choose the best available model by category using offline benchmark rankings.
2. **Fallbacks** — if the chosen model fails transiently, automatically try the next-ranked model instead of stopping.

**Why this matters:**
- **Cost:** keeps sessions on the strongest free or low-cost models first, and only falls back to paid models when needed.
- **Quality:** uses public benchmark data instead of static first-match rules.
- **Context efficiency:** fewer failed turns means less context spent on retries, error traces, and strategy changes.
- **Future ready:** as more providers expose free endpoints, this keeps the runtime competitive without manual routing config.

The feature is **opt-in** and **offline-first**. It ships with a bundled snapshot asset, so it works immediately after enabling. An API key is only needed if you want to refresh rankings later.

## Opt-in default

The feature ships **disabled** by default. To use it, enable it in `extensions/subagent/config.json`:

```jsonc
{
  "modelLeadership": {
    "enabled": true
  }
}
```

An offline snapshot is bundled with the extension, so the feature works as soon as you enable it. If you want fresher rankings, you can later provide an `llmStatsApiKey` and run `/fetch-rankings`.

## How it works

1. On session start, `src/extension/index.ts` calls `rebuildModelLeadership()`.
2. `src/model-leadership/index.ts` loads the existing snapshot from `~/.pi/agent/llm-rankings-snapshot.json` and rebuilds the leadership file at `~/.pi/agent/model-leadership.json`.
3. `src/runs/shared/model-fallback.ts` consults that leadership file when a subagent has no explicit `--model` and no parent-session model to inherit.

Selection priority (highest → lowest):
1. Explicit `--model` passed to the subagent
2. Leadership recommendation when `modelLeadership.enabled=true`
3. Parent session model (cross-session inheritance)
4. Global `settings.json` default

When a model fails, the next-ranked leadership candidate is tried automatically. Exclusions are recorded with retry hints and TTL, so transient failures don't permanently block a model.

At selection time there are **no network calls**. The leadership file is a static JSON artifact generated at startup.

## Commands

### `/fetch-rankings`
Fetches a fresh llm-stats rankings snapshot over the network and rebuilds the leadership file. Use this when you want the latest benchmark data.

### `/refresh-leadership`
Rebuilds the leadership file from the existing snapshot on disk. **No network requests.** Use this after adding/removing providers or models, or after editing `models.json`.

## Overriding provider models via `models.json`

You **can** override the model list for built-in providers (including `cloudflare-ai-gateway`) without editing any Pi code files. Edit `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "cloudflare-ai-gateway": {
      "models": [
        {
          "id": "my-custom-model",
          "name": "My Custom Model",
          "api": "anthropic-messages",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          },
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

Key rules:
- Built-in providers (like `cloudflare-ai-gateway`) **inherit** `baseUrl` and API defaults, so `baseUrl` is optional when overriding models for a built-in provider.
- Non-built-in custom providers **require** a `baseUrl`.
- Custom models are merged with built-in models; a same-`provider` + same-`id` entry wins over the built-in.
- Per-field overrides like `modelOverrides`, `baseUrl`, `compat`, `headers`, and `apiKey` are also supported at the provider level without redefining the full model list.

After editing `models.json`, run `/refresh-leadership` to rebuild the leadership file with the new registry state.
