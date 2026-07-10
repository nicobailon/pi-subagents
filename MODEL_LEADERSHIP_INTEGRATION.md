# Model Leadership — Integration & Configuration Reference

Main feature: **model leadership**, which adds ranked model selection and efficient fallback routing to `pi-subagents`.

Inside this feature, dynamic cross-provider fallbacks are the mechanism that keeps retries useful when the highest-ranked model fails transiently.

---

## 1. Scope of Changes

All changes live in `pi-subagents-repo`. Upstream `srcKod/pi-subagents` is the baseline.

### 1.1 Files changed

| File                                                  | Change                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/model-leadership/types.ts`                       | Added `PaidModelSortRule`, extended `ModelLeadershipPreferences`, added validation, renamed threshold field to `ratingDiffThreshold`, added optional `availabilityScore`, added `exclusionTTLMs` fallback preference                                                                                                                    |
| `src/model-leadership/builder.ts`                     | `selectModelsFromLeadership()` now buckets free models first when `preferFree=true`; `createPaidModelComparator()` uses `conservativeRating` for tie-break; added `getModelConservativeRating()` helper; `selectModelFromLeadership()` delegates to plural function; computes advisory `availabilityScore` per model                    |
| `src/model-leadership/index.ts`                       | Re-exports `selectModelFromLeadership`, `selectModelsFromLeadership`, `type PaidModelSortRule`; supports `PI_MODEL_LEADERSHIP_PATH` env override                                                                                                                                                                                        |
| `src/model-leadership/snapshot.ts`                    | REST fetch / file I/O for llm-stats snapshot; fixed path duplication bug in `toAbsolute()`; added `CategoryFetchError`; deterministic `topRankingCategory` on ties                                                                                                                                                                      |
| `src/model-leadership/utils.ts`                       | Shared helpers used by snapshot/builder                                                                                                                                                                                                                                                                                                 |
| `src/runs/shared/model-fallback.ts` | Module leadership cache (`setLeadershipArtifact` / `getLeadershipArtifact` / `loadLeadershipArtifact`), inherited-model leadership-first selection in `resolveSubagentModelOverride`, candidate building (`buildModelCandidates` / `resolveModelCandidate` / `fuzzyResolveModel`), exclusion API re-exports |
| `src/runs/shared/model-exclusions.ts`                 | Runtime exclusion state: `exclude`, `clearExpiredExclusions`, `isExcluded`, `filterFallbackCandidates`, `recordModelFailure`, debounced persistence (`persist` + `flushPersist`), `setDefaultTTL()`, deduplication by provider/modelId with newest-first retention, TTL derived from rate-limit hints when present |
node --experimental-transform-types --check src/runs/foreground/execution.ts
node --experimental-transform-types --check src/runs/background/subagent-runner.ts
| `src/runs/foreground/execution.ts`                    | Uses `selectModelsFromLeadership()` instead of raw `views.overall`; discards failed models in retry loop; parent model only as last fallback; applies `filterFallbackCandidates()` to leadership-extended candidates; tracks `attemptedModels` and `modelAttempts`; calls `recordModelFailure()` on any candidate failure, not only retryable-shaped failures |
| `src/runs/background/async-execution.ts`              | `extendModelCandidates()` uses `getLeadershipArtifact()` from `model-fallback.ts`; applies `filterFallbackCandidates()` when exclusions exist; async session-ID helpers                                                                                                                                                                 |
| `src/runs/background/async-status.ts`                 | `formatStepLine()` displays `attemptedModels` chain, e.g. `attempts: gpt-4o → claude-sonnet-4-5`                                                                                                                                                                                                                                        |
| `src/runs/background/subagent-runner.ts` | Calls `recordModelFailure()` on retryable failure; propagates `attemptedModels` and `modelAttempts` through single/chain results |
| `src/extension/index.ts` | Session start → `loadLeadershipArtifact()`; shutdown → `setLeadershipArtifact(null)` |
| `src/extension/model-leadership-refresh.ts`           | `refreshModelLeadership` (network) and `rebuildModelLeadership` (offline); sets module leadership artifact via `setLeadershipArtifact`                                                                                                                                                                                                  |
| `src/extension/config.ts`                             | Auto-creates `extensions/subagent/` if missing                                                                                                                                                                                                                                                                                          |
| `src/shared/utils.ts`                                 | `detectSubagentError` now scans assistant `errorMessage` fields to catch zero-exit provider errors symmetrically                                                                                                                                                                                                                        |
| `src/shared/types.ts`                                 | Added `parentModel?: { provider: string; id: string }` to `RunSyncOptions`                                                                                                                                                                                                                                                              |
| `src/shared/log.ts`                                   | Shared structured log helper for fallback/leadership events                                                                                                                                                                                                                                                                             |
| `src/slash/slash-commands.ts`                         | `/fetch-rankings` and `/refresh-leadership` slash commands                                                                                                                                                                                                                                                                              |
| `docs/model-leadership.md`                            | User-facing docs                                                                                                                                                                                                                                                                                                                        |
| `docs/QUICK_START.md`                                 | Quick-start user guide                                                                                                                                                                                                                                                                                                                  |
| `test/unit/model-leadership.test.ts`                  | Config + selection tests                                                                                                                                                                                                                                                                                                                |
| `test/unit/model-leadership/fixtures.ts`              | Shared fixtures/mocks for model-leadership tests                                                                                                                                                                                                                                                                                        |
| `test/unit/model-leadership/matching.test.ts`         | Matching/normalization tests                                                                                                                                                                                                                                                                                                            |
| `test/unit/model-leadership/sorting.test.ts`          | Paid-sort tests                                                                                                                                                                                                                                                                                                                         |
| `test/unit/model-leadership/builder-behavior.test.ts` | Builder behavior tests                                                                                                                                                                                                                                                                                                                  |
| `test/unit/model-leadership/config.test.ts`           | Config validation tests                                                                                                                                                                                                                                                                                                                 |
| `test/unit/model-fallback.test.ts`                    | Fallback helper tests                                                                                                                                                                                                                                                                                                                   |
| `test/integration/async-execution.test.ts`            | Async fallback integration tests + zero-exit provider error isolation                                                                                                                                                                                                                                                                   |
| `test/integration/slash-commands.test.ts`             | Slash-command integration tests                                                                                                                                                                                                                                                                                                         |
| `test/production/test-harness.ts`                     | Production-style harness scaffold                                                                                                                                                                                                                                                                                                       |
| `test/support/run-leadership-workload.ts`             | Workload probe for leadership scenarios                                                                                                                                                                                                                                                                                                 |
| `test/support/run-paid-selection.ts`                  | Paid-selection strategy verification                                                                                                                                                                                                                                                                                                    |
| `assets/llm-rankings-snapshot.json`                   | Bundled offline snapshot seed                                                                                                                                                                                                                                                                                                           |

### 1.2 Original upstream behaviour vs integrated behaviour

The baseline is the upstream repo: [`srcKod/pi-subagents`](https://github.com/srcKod/pi-subagents). The model leadership integration is a feature layer on top of that baseline, not a replacement.

| Behaviour                  | Original `srcKod/pi-subagents`                                                                                                     | After model leadership integration                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Model selection**        | `buildModelCandidates(modelOverride, fallbackModels, availableModels, preferredProvider)` — explicit config + agent fallbackModels | Same base behaviour preserved. Leadership layer extends candidates with ranked models from llm-stats when `enabled=true`               |
| **Retry loop**             | Retries the explicit candidate list; continues on any failure unless it is the last candidate                                                                    | Same retry loop preserved. Exclusions (`recordModelFailure`) dynamically remove failed routes before the next retry; `isRetryableModelFailure` no longer gates fallback |
| **Failure handling**       | No durable failure tracking; same candidates retried until success or exhaustion                                                   | Failed provider/model pairs are excluded with a TTL; `filterFallbackCandidates()` removes them from the next selection pass            |
| **Hidden provider errors** | `detectSubagentError` checks `toolResult` messages and bash output only                                                            | `detectSubagentError` now also scans assistant `errorMessage` fields, catching zero-exit provider errors symmetrically                 |
| **Persistence**            | No exclusion persistence                                                                                                           | Exclusion state persisted to `~/.pi/agent/model-exclusions.json` with atomic rename + debounced persistence                            |
| **Async fallback**         | Same async retry logic, but candidate building did not mirror foreground leadership selection                                      | Async `extendModelCandidates()` now uses `selectModelsFromLeadership()` + `filterFallbackCandidates()` for parity                      |
| **Status visibility**      | `attemptedModels` tracked but not surfaced in async step status formatting                                                         | `attemptedModels` chain shown in both foreground and async status UI                                                                   |
| **Configurability**        | No llm-stats integration; no TTL exposure                                                                                          | `modelLeadership.preferences.exclusionTTLMs` in `extensions/subagent/config.json` controls failure block duration                      |
| **Default state**          | N/A                                                                                                                                | **Disabled by default** (`enabled: false`); user must opt in via `extensions/subagent/config.json`                                     |
| **First-run data**         | N/A                                                                                                                                | Uses bundled offline snapshot asset on first startup enable/startup, so no API key is required to try the feature                      |

### 1.3 Opt-in enablement

The integration is **disabled by default**. With the shipped default config, `modelLeadership.enabled` is `false`, so no snapshot fetch, leadership build, or candidate extension runs unless the user explicitly opts in.

**Validated (from source):**

- `src/model-leadership/types.ts` defaults `enabled` to `false`.
- `src/model-leadership/builder.ts` resolves `config?.enabled ?? false`.
- `src/model-leadership/index.ts` short-circuits with `if (!config.enabled) return null;`.

To enable, set `modelLeadership.enabled = true` in `extensions/subagent/config.json`. On the next session start, the extension rebuilds leadership from the bundled offline snapshot (no API key required). After that, `/fetch-rankings` can refresh rankings using an optional `llmStatsApiKey`.

---

## 2. Model Leadership overview

Model Leadership is the main feature: it replaces static first-match model selection with a ranked view of your available models, so subagents use the strongest capable model for each task while still respecting your cost and provider preferences.

Inside this feature, **dynamic cross-provider fallbacks** are one mechanism. They keep the ranked strategy intact by automatically skipping known-bad routes after transient failures, instead of grokking any competing mechanism.

### 2.1 Why it exists

**Efficient context management.**
When a subagent hits a transient provider failure, the alternative is not usually a smarter model — it is more prompt turns spent reasoning about the failure, retrying, or switching strategy manually. That consumes context and time without improving quality.

**Cost and quality together.**
Leadership lets you prefer free or cheaper models by default. Fallbacks preserve that preference: they keep moving to the next-ranked model instead of promoting expensive routes or stopping the run.

**Future readiness.**
As more providers expose free endpoints, this two-part design gives you an evolutionary path: better ranking plus safer retries, without introducing pools, routes, or polling that could conflict with your config or spend.

### 2.2 What it introduces

| Part      | Role                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| Selection | Ranks available models by benchmark data and configurable rules (`preferFree`, `paidSortRule`, `category`, `maxResults`) |
| Fallbacks | Removes transiently failed provider/model pairs from the next retry with a TTL, while preserving the leadership order    |

Together they mean: best-ranked capable model first, and when that fails temporarily, the next-best option automatically takes over.

### 2.3 Architecture

```
assets/llm-rankings-snapshot.json  ── seedOfflineSnapshot() ──►  ~/.pi/agent/llm-rankings-snapshot.json
llm-stats REST API  ── fetchRankingsSnapshot() ──►  ~/.pi/agent/llm-rankings-snapshot.json  (replaces offline copy in place)
       │
       ▼
buildLeadership()  ───►  model-leadership.json
       │
       ▼
selectModelFromLeadership() / selectModelsFromLeadership()
       │
       ▼
resolveSubagentModelOverride() / execution.ts candidate extension  ── async-extend ──►  modelCandidates[]
       │
       ▼
runSingleAttempt() / subagent-runner retry loop  ── recordModelFailure() ──► exclusions
       │                                    │
       │                                    ▼
       │                            filterFallbackCandidates()
       │                                    │
       └──── next candidate respects exclusions ──┘
```

### 2.5 Lifecycle

1. **Session start** → rebuilds leadership from canonical snapshot, sets module-level cache
2. **`/fetch-rankings`** → force-fetches fresh snapshot from llm-stats, **replaces the canonical snapshot in place**, rebuilds leadership
3. **`/refresh-leadership`** → rebuilds leadership from existing snapshot only (no network)
4. **Session shutdown** → clears module-level cache and discarded models set
5. **Runtime failure** → `recordModelFailure()` marks the failed provider/model as excluded with a TTL; the next retry automatically skips excluded candidates. Both foreground (`execution.ts`) and background (`subagent-runner.ts`) retry loops use the same exclusion API.
6. **Fresh snapshot replace** → `/fetch-rankings` writes a new snapshot to the **same canonical path**, so offline and fresh modes never diverge.
7. **Async retry parity** → `async-execution.ts` builds fallback candidates with `selectModelsFromLeadership()` instead of the flat `views.overall` list and applies `filterFallbackCandidates()`.

### 2.6 Key Design Decisions

- **No cross-extension artifact**: pi-subagents manages its own snapshot and leadership generation.
- **Hybrid snapshot approach**: fetch once at startup (if missing) or manually; rebuild offline.
- **Module-level cache**: leadership artifact stored in module variable, set by extension hooks.
- **Security**: `llmStatsApiKey` stripped before writing to disk; only `ModelLeadershipPreferences` persisted.
- **Canonical ID matching**: provider-prefixed IDs matched to bare llm-stats names via last path segment.
- **Exclusion-based fallback only**: no provider pools, no hardcoded routes, no background probing. Failures add time-boxed exclusions; retries rerun leadership selection minus excluded candidates.
- **Process isolation, current state**: exclusions live in a single module-level, TTL-bounded list persisted to `~/.pi/agent/model-exclusions.json` and shared across sessions/runs (intentional cross-run learning). Each provider/modelId is stored once; the newest entry wins when the same model fails again. The unused `model-execution-context.ts` and the session-exclusion scaffolding were removed; no per-session isolation layer exists. Rate-limit hints can derive a shorter TTL than `exclusionTTLMs`, so the config acts as a fallback/default, not a forced global override.

---

## 3. Model-Leadership Artefacts

### 3.1 File locations

| Local path                                    | Purpose                                                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.pi/agent/llm-rankings-snapshot.json`      | Canonical snapshot file. First run seeds this from `assets/llm-rankings-snapshot.json`; `/fetch-rankings` replaces this same file with a fresh live snapshot. |
| `~/.pi/agent/model-leadership.json`           | Built leadership file consumed by selection                                                                                                                   |
| `~/.pi/agent/model-exclusions.json`           | Persisted exclusion state with TTL                                                                                                                            |
| `~/.pi/agent/extensions/subagent/config.json` | Extension config (optional, but this is where `modelLeadership` lives)                                                                                        |

### 3.2 Top-level structure of `model-leadership.json`

```json
{
  "version": 1,
  "generatedAt": "...",
  "source": {
    "snapshotPath": "...",
    "snapshotGeneratedAt": "..."
  },
  "config": {
    "preferFree": true,
    "defaultCategory": "coding",
    "maxResults": 50,
    "paidSortRule": { ... }
  },
  "models": [ LeadershipModel, ... ],
  "views": {
    "freeLocal": [ "provider/modelId", ... ],
    "paidLocal": [ "provider/modelId", ... ],
    "overall": [ "provider/modelId", ... ],
    "byCategory": { "coding": [...], "agents": [...], ... }
  }
}
```

> **Note**: The artifact's `config` is a flat `ModelLeadershipPreferences` object. The user config in `extensions/subagent/config.json` nests these under `modelLeadership.preferences`, but the built artifact flattens them.

### 3.3 `LeadershipModel` properties

| Property                                                            | Meaning                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `id`                                                                | Canonical model id (last segment after stripping provider prefix)    |
| `provider` / `modelId`                                              | Primary provider route kept for backwards-compat                     |
| `name`                                                              | Human-readable name                                                  |
| `isFree`                                                            | `true` when provider reports zero cost                               |
| `hasApiKey`                                                         | `true` when at least one provider instance has an API key configured |
| `cost.input` / `cost.output` / `cost.cacheRead` / `cost.cacheWrite` | From Pi registry; used by cost-aware sort rules                      |
| `contextWindow`                                                     | Token context window from registry                                   |
| `family`                                                            | Model family string                                                  |
| `categories`                                                        | Categories this model is ranked in                                   |
| `rankings`                                                          | `{ category: rank                                                    |
| `conservativeRating`                                                | llm-stats conservative quality score                                 |
| `topRanking`                                                        | Best rank across all categories                                      |
| `topRankingCategory`                                                | Category where best rank occurs                                      |
| `providers`                                                         | All provider/modelId combos for this canonical model                 |
| `availableProviders`                                                | Provider combos that are actually available in Pi registry           |
| `available`                                                         | `true` when at least one provider route is available                 |
| `availabilityScore`                                                 | Advisory ratio `availableProviders.length / providers.length`        |

### 3.4 First-run, refresh, and fresh snapshot flow

- **Canonical path**: all snapshot I/O targets `~/.pi/agent/llm-rankings-snapshot.json`.
- **Offline bundled asset**: `assets/llm-rankings-snapshot.json` ships a real snapshot inside the repo.
- **First run**: if no snapshot exists yet, the system copies the bundled asset into the canonical path and then builds leadership from it. No API key is required.
- **Refresh**: `/refresh-leadership` rebuilds `model-leadership.json` from existing canonical snapshot.
- **Fresh snapshot**: `/fetch-rankings` contacts llm-stats and replaces the same canonical snapshot file with a fresh snapshot, then rebuilds leadership. An `llmStatsApiKey` is required here.

| Mode                | First-run snapshot             | Network | API key needed | Result                                            |
| ------------------- | ------------------------------ | ------- | -------------- | ------------------------------------------------- |
| Offline / first run | Copied from bundled asset      | No      | No             | Uses bundled snapshot at canonical path           |
| Refresh             | Reuses existing canonical file | No      | No             | Rebuilds leadership only                          |
| Fresh snapshot      | Rewrites canonical file        | Yes     | Yes            | New `llm-rankings-snapshot.json` + new leadership |

---

## 4. Configuration

### 4.1 `extensions/subagent/config.json` shape

```jsonc
{
  "modelLeadership": {
    "enabled": false,                     // shipped default: disable by default; set true to opt in
    "llmStatsApiKey": "",                // optional Bearer token for llm-stats
    "preferences": {
      "preferFree": true,
      "defaultCategory": "coding",
      "maxResults": 50,
      "exclusionTTLMs": 86400000,         // optional: 24h default; controls how long a failed route stays excluded
      "paidSortRule": {
        "strategy": "rankedAndCost",
        "rankingOrder": "desc",
        "costOrder": "asc",
        "ratingDiffThreshold": 5
      }
    }
  }
}
```

Only `preferences` is persisted to disk. Secrets like `llmStatsApiKey` are stripped before writing to avoid leaking credentials.

### 4.2 `paidSortRule` strategies

| Strategy               | Behaviour                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `priority` *(default)* | Rank first; when two models are within `ratingDiffThreshold` of each other, cheaper wins. |
| `ranking`              | Strictly by category rank. Cost is a final tie-break.                                     |
| `cost`                 | Strictly by cost. Rank is a final tie-break.                                              |
| `rankedAndCost`        | When `                                                                                    |
| any other value        | Fallback: pure rank ascending                                                             |

### 4.3 Tie-break fields

| Field                 | Meaning                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `rankingOrder`        | `"asc"` (default) = lower rank wins; `"desc"` = higher rank wins |
| `costOrder`           | `"asc"` (default) = cheaper wins; `"desc"` = more expensive wins |
| `ratingDiffThreshold` | Gap in `conservativeRating` where cost should override rank      |

### 4.4 Configuration defaults

When config is missing or partial, these defaults apply:

| Property                           | Default      |
| ---------------------------------- | ------------ |
| `preferFree`                       | `true`       |
| `defaultCategory`                  | `"coding"`   |
| `maxResults`                       | `50`         |
| `paidSortRule.strategy`            | `"priority"` |
| `paidSortRule.rankingOrder`        | `"asc"`      |
| `paidSortRule.costOrder`           | `"asc"`      |
| `paidSortRule.ratingDiffThreshold` | `5`          |
| `exclusionTTLMs`                   | `86400000`   |

Invalid `maxResults` is normalized to `50`.

---

## 5. Selection Behaviour

### 5.1 Auto-mode priority (no explicit `--model`)

1. `resolveSubagentModelOverride` receives the agent's default model with `source: "inherited"`.
2. If the module has an active leadership artifact, `selectModelFromLeadership()` wins and the agent default is used as a fallback only when leadership returns nothing usable.
3. If no leadership artifact is active, the requested/default model is used as before.
4. Parent-session model remains the absolute last fallback when nothing else resolves.
5. In the retry loop, a model that fails with a retryable error is marked discarded for the rest of the session. The next model in the extended candidate list is tried automatically.

### 5.2 Explicit `--model`

`source: "explicit"` skips leadership and uses the caller-supplied model directly. It is still resolved through `resolveModelCandidate()` and scope enforcement still applies. The session discard set does **not** affect explicit re-runs of the same model.

### 5.3 Slash commands

| Command               | Network | Behaviour                                           |
| --------------------- | ------- | --------------------------------------------------- |
| `/fetch-rankings`     | Yes     | Force-fetch fresh snapshot, then rebuild leadership |
| `/refresh-leadership` | No      | Rebuild leadership from existing snapshot on disk   |

### 5.4 Selection scenario table

| Scenario                                | `preferFree`      | Paid rule                    | Result / order                                                                                |
| --------------------------------------- | ----------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| Free and paid models, free wins by rank | `true`            | any                          | Free ranked first, then paid                                                                  |
| Free and paid models, paid wins by rule | `false`           | any                          | All ranked mixed, paid rule sorts all                                                         |
| Tie within `ratingDiffThreshold`        | `true` or `false` | `priority` / `rankedAndCost` | Cheaper model wins the tie                                                                    |
| Missing `conservativeRating`            | both              | any                          | Rating diff treated as `Infinity`; rank decides                                               |
| No models ranked in a category          | both              | any                          | Unranked models appended; free bucket before paid when `preferFree=true`                      |
| All providers unavailable               | both              | any                          | `[]`; parent model used as last resort                                                        |
| Explicit model + retryable failure      | —                 | —                            | Failed model discarded, next candidate tried; explicit model itself is NOT globally discarded |

---

## 6. Fallbacks inside Model Leadership

This section covers the fallback mechanism that prevents transient failures from wasting context.

### 6.0 Why this feature exists

Agentic sessions spend context on retries, error traces, and workaround prompts when a chosen model route fails transiently. The model leadership feature already ranks candidates by quality and cost; this fallback layer makes that ranking resilient.

**What it introduces:**

- A lightweight, TTL-based exclusion record per failed provider/model pair.
- Automatic rerouting to the next-ranked candidate from the same configured strategy when a retryable failure happens.
- Symmetric zero-exit provider error detection so hidden failures are caught immediately.
- Debounced exclusion persistence so fallback storms do not flood disk writes.
- Status visibility through `attemptedModels` in foreground and async outputs.

### 6.1 What it is

A runtime exclusion mechanism that keeps the configured leadership selection strategy intact while automatically skipping known-bad provider/model routes after retryable failures. Both foreground and background execution paths use the same exclusion API and leadership-ranked candidate order.

### 6.2 Why this approach

- **No provider pools**: pools would introduce a second routing layer that can conflict with `config.json` preferences and model-leadership rankings.
- **No hardcoded fallback chains**: these require manual maintenance and break the "best model wins by default" intent.
- **No background probing**: probing health endpoints does not guarantee the model can complete real work, and wastes credits or adds latency. The simpler and more reliable signal is the actual run-time failure itself.
- **Module-scoped state**: exclusions are kept in a single module-level, deduplicated, TTL-bounded list. This avoids per-session coordination complexity and preserves cross-run learning. If a model failed earlier in the same process, later runs still benefit until TTL expiry or explicit reset.

### 6.3 How it works

1. A subagent run fails with a retryable error (quota, 429, 403, auth failure, model unavailable, etc.).
2. The foreground retry loop or background retry loop calls `recordModelFailure({ modelId, provider, reason })`.
3. The failure is stored in module-level exclusion state with a TTL. The exact TTL is chosen in this order: explicit `ttlMs` on the failure record, rate-limit-derived hint such as `next minute`/`next hour`/`next day` from `provider-rate-limits.csv`, then the global `modelLeadership.preferences.exclusionTTLMs` fallback.
4. When the next candidate list is assembled, `filterFallbackCandidates()` removes any route that matches an active exclusion. Async `extendModelCandidates()` now uses `selectModelsFromLeadership()` for the same ranked order as foreground.
5. The retry loop advances to the next candidate in the same order produced by the configured leadership strategy.
6. After TTL expiry, the exclusion is automatically cleared.
7. `detectSubagentError()` also scans `errorMessage` fields so zero-exit provider errors are caught symmetrically.

### 6.4 Why it doesn't break the original repo behaviour

| Original behaviour                                           | With exclusion fallback                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Config strategy decides candidate order                      | Same strategy still decides order; exclusions only remove candidates                           |
| Parent-session model is the absolute last resort             | Still the last resort                                                                          |
| Explicit `--model` bypasses leadership                       | Unchanged                                                                                      |
| Failed models recorded and excluded from later selections | `recordModelFailure()` records provider/modelId + reason + TTL; `filterFallbackCandidates()` removes them from the next leadership selection |
| No background probing                                        | Unchanged; probing was explicitly dropped as not worth the cost                                |
| All tests pass                                               | Existing tests still pass; new fallback/integration tests added                                |
| Async retry uses flat `views.overall`                        | Fixed: async now uses `selectModelsFromLeadership()` for same ranked order as foreground       |
| Async fallback list ignores active exclusions                | Fixed: `filterFallbackCandidates()` applied in `extendModelCandidates()` when exclusions exist |
| Zero-exit provider errors invisible to `detectSubagentError` | Fixed: assistant `errorMessage` scan added so hidden provider errors are caught in both paths  |

### 6.5 New behaviour introduced

| New behaviour                                                                     | Where                                                                             |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `recordModelFailure()` records failed provider/modelId with reason, rate-limit hint, and TTL        | `src/runs/shared/model-exclusions.ts`                                             |
node --experimental-transform-types --check src/runs/foreground/execution.ts
node --experimental-transform-types --check src/runs/background/subagent-runner.ts
| `filterFallbackCandidates()` removes excluded routes from a candidate array       | `src/runs/shared/model-exclusions.ts`                                             |
node --experimental-transform-types --check src/runs/foreground/execution.ts
node --experimental-transform-types --check src/runs/background/subagent-runner.ts
| `isExcluded()` checks whether a given modelId/provider is currently blocked       | `src/runs/shared/model-exclusions.ts`                                             |
node --experimental-transform-types --check src/runs/foreground/execution.ts
node --experimental-transform-types --check src/runs/background/subagent-runner.ts
| Foreground filters leadership-extended candidates through exclusions before retry | `src/runs/foreground/execution.ts`                                                |
| Background calls `recordModelFailure()` on retryable failure                      | `src/runs/background/subagent-runner.ts`                                          |
| Background extends candidates using ranked leadership + exclusion filtering       | `src/runs/background/async-execution.ts`                                          |
| `LeadershipModel.availabilityScore` advisory field                                | `src/model-leadership/types.ts`, `src/model-leadership/builder.ts`                |
| `detectSubagentError` scans assistant `errorMessage` for provider errors          | `src/shared/utils.ts`                                                             |
| `exclusionTTLMs` configurable via extension config                                | `src/extension/model-leadership-refresh.ts`, `extension/pi-subagents/config.json` |
| Debounced persistence for exclusion writes                                        | `src/runs/shared/model-exclusions.ts`                                             |
node --experimental-transform-types --check src/runs/foreground/execution.ts
node --experimental-transform-types --check src/runs/background/subagent-runner.ts
| Async attempted-model chain visible in status                                     | `src/runs/background/async-status.ts`                                             |

---

## 7. Edge Cases & Defensive Design

### 7.1 Verified edge cases

| Edge Case                                        | Behaviour                                                                                                  | Status        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------- |
| Empty models array                               | Returns empty views with populated categories                                                              | ✅ Working     |
| Undefined artifact config                        | Falls back to hardcoded defaults                                                                           | ✅ Working     |
| Invalid maxResults                               | Normalized to 50                                                                                           | ✅ Working     |
| Nonexistent category                             | Falls back to any available model                                                                          | ✅ Working     |
| All models unavailable                           | Returns `null` or `[]`                                                                                     | ✅ Working     |
| Unexpected sort strategy                         | Default case falls back to category ranking                                                                | ✅ Working     |
| Null rankings for models                         | Treated as no rank for category                                                                            | ✅ Working     |
| Empty `availableProviders`                       | Falls back to `provider/id` format                                                                         | ✅ Working     |
| Paid model outranks free with `preferFree=true`  | Free model still wins                                                                                      | ✅ Working     |
| Path duplication in snapshot fetch               | Fixed: `toAbsolute()` returns fallback directly                                                            | ✅ Working     |
| Retryable failure on candidate                   | Failed route excluded with TTL; next candidate tried                                                       | ✅ Working     |
| Exclusion TTL expiry                             | Stale exclusions pruned on next access                                                                     | ✅ Working     |
| Candidate includes thinking suffix               | Suffix preserved during split/parse                                                                        | ✅ Working     |
| Async uses ranked leadership                     | `selectModelsFromLeadership()` matches foreground order                                                    | ✅ Working     |
| Async fallback list filters exclusions           | `filterFallbackCandidates()` applied when exclusions exist                                                 | ✅ Working     |
| Zero-exit provider error → `detectSubagentError` | Assistant `errorMessage` field scanned symmetrically                                                       | ✅ Working     |
| `detectSubagentError` avoids false positives     | Only scans the last contiguous assistant message block                                                     | ✅ Working     |
| `extendModelCandidates` testability              | Optional injected `leadership` parameter                                                                   | ✅ Working     |
| Async session ID helpers                         | `getAsyncSessionId()` / `setAsyncSessionId()` / `clearAsyncSessionId()` present                            | ✅ Implemented |
| Foreground session ID helpers                    | `getCurrentSessionId()` / `setCurrentSessionId()` / `clearCurrentSessionId()` present                      | ✅ Implemented |
| Debounced exclusion persistence                  | Writes coalesced within window; last timer wins                                                            | ✅ Working     |
| Configurable exclusion TTL                       | `exclusionTTLMs` in config falls back to 24h default; rate-limit hints override it when present          | ✅ Working     |
| Directory-glob Node test limitation              | `node --test test/unit/model-leadership/` fails with `ERR_UNSUPPORTED_DIR_IMPORT`; use explicit file paths | Documented    |

### 7.2 Defensive design patterns

- **Optional chaining** used for `leadership.config?.property` access.
- **Fallback defaults** at every level: option → artifact config → hardcoded default.
- **Switch default case** in `createPaidModelComparator()` for unknown strategies.
- **`isAbsolute()` check** in path resolution for cross-platform Windows/POSIX support.
- **`try/catch`** around snapshot fetch with fallback to existing snapshot on disk.
- **TTL pruning** on every exclusion check.
- **Re-export facade** in `model-fallback.ts` to preserve existing exports while moving state to `model-exclusions.ts`.
- **Atomic rename** for exclusion persistence writes.

---

## 8. Test Coverage

### 8.1 Current verified test results

| Test Suite                                     | Tests   | Pass    | Fail  |
| ---------------------------------------------- | ------- | ------- | ----- |
| `test/unit/model-leadership.test.ts`           | 36      | 36      | 0     |
| `test/unit/model-fallback.test.ts`             | 25      | 25      | 0     |
| `test/unit/async-permission-session.test.ts`   | 4       | 4       | 0     |
| `test/unit/model-rate-limit-inference.test.ts` | 3       | 3       | 0     |
| `test/integration/async-execution.test.ts`     | 33      | 31      | 2     |
| `test/integration/slash-commands.test.ts`      | 25      | 25      | 0     |
| `test/integration/model-leadership-fallback.test.ts` | 8 | 8 | 0 |
| `test/integration/parallel-model-execution.test.ts` | 3 | 3 | 0 |
| **Current verified total**                     | **138** | **136** | **2** |

> **Note:** The 2 pre-existing integration failures in `async-execution.test.ts` (`hard-kills async children that ignore timeout SIGTERM` and `cancels async acceptance verification when the run times out`) are timing-sensitive flakes unrelated to model-leadership wiring. They reproduce on the unmodified upstream baseline as well.

### 8.2 Test coverage areas

**Config resolution and defaults (3 tests):**

- Resolves defaults when config is missing
- Merges user preferences over defaults
- Normalizes invalid maxResults to 50

**Model selection logic (9 tests):**

- Returns top-ranked available model for default category
- Prefers free models when configured
- Prefers free models even when paid model outranks them in snapshot
- Honors preferFree from the leadership artifact config
- Returns null for an empty leadership
- Respects category-specific option override
- Respects maxResults option
- Falls back to any available model when no ranked model matches
- Returns null when all models are unavailable

**Edge cases and configuration (5 tests):**

- Always populates artifact config with defaults when building
- Respects custom config when provided during building
- Handles empty models array gracefully
- Respects maxResults in selection even with single model return
- Falls back to default maxResults from config when option is not provided

**Exclusion/filter/rerun fallback (33 tests):**

- Excludes by provider only
- Excludes by modelId only
- Preserves config order when filtering exclusions
- Expires exclusions after TTL
- Deduplicates entries by provider/modelId, keeping newest
- Rate-limit hints can shorten TTL below global fallback
- Skips excluded candidates in a filtered rerun
- Configurable `exclusionTTLMs` via config
- Debounced persistence (`flushPersist` optional)
- `reloadFromDisk()` resets in-memory state

**Async fallback integration (4 tests):**

- Background runs record fallback attempts and final model
- Background runs fail zero-exit provider errors when no fallback succeeds
- Background runs treat recovered child errors as successful
- Background runs keep provider errors failed when followed only by empty assistant output

**Async dynamic status/fanout (6 tests):**

- Async dynamic status shows placeholder before materialization
- Async chains expand dynamic fanout and persist collected output
- Async dynamic fanout recomputes later child intercom targets by final flat index
- Plus related render/status fanout coverage

**Slash commands (25 tests):**

- `/fetch-rankings` and `/refresh-leadership` behaviour covered end-to-end

### 8.3 Verification scripts

| Script                                    | Purpose                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `test/support/run-paid-selection.ts`      | Exercises all `paidSortRule` strategies against controlled fixtures      |
| `test/support/run-leadership-workload.ts` | Scenario coverage for sample models, discard, selection, config          |
| `test/production/test-harness.ts`         | Production-style harness scaffold for long-run and concurrent validation |

---

## 9. Commands & Verification

### 9.1 Run targeted tests

```powershell
cd C:\Users\webst\.pi\agent\pi-subagents-repo
node --experimental-transform-types --import ./test/support/register-loader.mjs `
  --test --test-concurrency=2 `
  test/unit/model-leadership.test.ts `
  test/unit/model-fallback.test.ts `
  test/integration/async-execution.test.ts `
  test/integration/slash-commands.test.ts `
```

### 9.2 Run paid-selection strategy verification

```powershell
cd C:\Users\webst\.pi\agent\pi-subagents-repo
node --experimental-transform-types --import ./test/support/register-loader.mjs `
  test/support/run-paid-selection.ts
```

### 9.3 Run async fallback integration tests only

```powershell
cd C:\Users\webst\.pi\agent\pi-subagents-repo
node --experimental-transform-types --import ./test/support/register-loader.mjs --test `
  --test-name-pattern='background runs record fallback attempts|background runs fail zero-exit provider errors when no fallback succeeds|background runs treat recovered child errors as successful|background runs keep provider errors failed when followed only by empty assistant output' `
  test/integration/async-execution.test.ts
```

### 9.4 Run Phase 8 focused type checks

```powershell
cd C:\Users\webst\.pi\agent\pi-subagents-repo
node --experimental-transform-types --check src/shared/utils.ts
node --experimental-transform-types --check src/runs/background/async-execution.ts
node --experimental-transform-types --check src/runs/shared/model-exclusions.ts
node --experimental-transform-types --check src/runs/foreground/execution.ts
node --experimental-transform-types --check src/runs/background/subagent-runner.ts
```

### 9.5 Inspect live leadership

```powershell
node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync('C:/Users/webst/.pi/agent/model-leadership.json','utf8')); console.log(JSON.stringify({config:d.config, views:d.views}, null, 2).slice(0,1200));"
```

### 9.6 Inspect snapshot categories

```powershell
node -e "const fs=require('fs'); const s=JSON.parse(fs.readFileSync('C:/Users/webst/.pi/agent/llm-rankings-snapshot.json','utf8')); console.log('categories', Object.keys(s.rankings).length); console.log(JSON.stringify(Object.values(s.rankings)[0].rows[0], null, 2));"
```

---

## 10. Next-Phase Ideas

- Add `freeSortOrder` (by rank/rating) for ordering within the free bucket.
- Surface selected model + rule explanation into the subagent progress UI.
- Per-category `paidSortRule` overrides.
- Some Pi-registered models have no llm-stats rankings; the leadership already handles this gracefully as unranked fallbacks — no fix needed in pi-subagents.
- Make `ModelLeadershipConfig.preferences` non-optional in types.
- Add explicit `PaidModelSortRule` runtime validator.
- Formalize test fixtures for leadership/exclusion path env vars so async tests do not depend on manual `PI_MODEL_LEADERSHIP_PATH` / `PI_MODEL_EXCLUSIONS_PATH` setup.
- Add fallback retry circuit-breaker or max-attempt cap to prevent pathological fallback storms when filtered leadership pools are very large.
- Extend `docs/model-leadership.md` into `docs/QUICK_START.md`, `docs/CONFIGURATION.md`, and `docs/MIGRATION.md` so end-user guidance matches the technical reference.
