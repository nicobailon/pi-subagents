# Provider Rate Limits

## Why this exists

Normal model selection in `pi-subagents` is already handled by existing leadership and fallback logic. Adding another implicit routing layer on top of that is unnecessary and makes behavior harder to reason about.

This feature exists for a narrower purpose: make retries smarter without changing the core selection strategy.

The CSV is useful because provider documentation usually publishes static maximum caps per time window, but rarely publishes exact live reset timestamps. The CSV turns that static documentation into a tunable retry policy layer: explicit hints can be edited in place without changing code, and inferred hints give sensible fallback windows when explicit values are blank.

## What this feature does

`assets/provider-rate-limits.csv` is an optional data source for **runtime exclusion enrichment** only.

It does **not** drive model selection ordering or fallback ranking. The selection/fallback strategy remains deterministic and driven by existing leadership/fallback logic. Rate limits are used only after a real runtime failure, to record an exclusion with clearer reason and retry hint.

This keeps things simple:
- selection = deterministic rank/cost/latency
- fallback = full ordered candidate set preserved unless excluded
- retry = smarter because failures can carry retry hints

In other words, this feature adds richer retry metadata, not another router.

## Behavior

### Explicit retry control

Each row may include `retry_after_hint`. When present, the runtime uses that exact hint first. This lets you tune retry behavior per provider, model, tier, endpoint, and usage profile without changing code.

### Inferred retry hints

When `retry_after_hint` is blank, the runtime may infer a best-effort retry window from the applicable row's documented caps:
- request windows: `rpm_max` → next minute, `rph_max` → next hour, `rpd_max` → next day
- token windows: `tpm_max` → next minute, `tph_max` → next hour, `tpd_max` → next day
- request windows are preferred over token windows when both are present
- if no time-bounded cap is present, the runtime falls back to the normal exclusion TTL

Inference is best-effort. Provider docs describe maximum sustained caps, not exact live refill instants, so inferred windows are conservative hints rather than guaranteed reset times.

### Matching behavior

When enriching an exclusion, the runtime picks the most specific applicable row first:
- exact model match beats provider/family match
- exact `rate_type`, `usage_profile`, and `endpoint` add specificity
- `limit_mode=hard` is preferred over `adaptive` when everything else ties
- effective date windows are respected

If no row matches, or the snapshot is missing or invalid, the runtime skips enrichment and keeps ordinary TTL behavior.

## How it is used

### CSV editor

Edits to the bundled snapshot go through the TypeScript editor only:

```bash
node scripts/provider-rate-limits.ts validate --csv assets/provider-rate-limits.csv --json
node scripts/provider-rate-limits.ts providers --csv assets/provider-rate-limits.csv --json
node scripts/provider-rate-limits.ts search <query> --csv assets/provider-rate-limits.csv --provider <provider> --scope <scope> --endpoint <pattern> --usage-profile <profile> --rate-type <type> --json
node scripts/provider-rate-limits.ts check-duplicates --csv assets/provider-rate-limits.csv --json
node scripts/provider-rate-limits.ts check-natural-key-duplicates --csv assets/provider-rate-limits.csv --json
node scripts/provider-rate-limits.ts add --json-input items.json --csv assets/provider-rate-limits.csv --json
node scripts/provider-rate-limits.ts update --json-input updates.json --csv assets/provider-rate-limits.csv --json
node scripts/provider-rate-limits.ts remove --json-input matches.json --csv assets/provider-rate-limits.csv --json
node scripts/provider-rate-limits.ts upsert --json-input items.json --csv assets/provider-rate-limits.csv --json
node scripts/provider-rate-limits.ts import --json-input research.json --skip-duplicates --continue-on-error --csv assets/provider-rate-limits.csv --json
node scripts/provider-rate-limits.ts deduplicate --csv assets/provider-rate-limits.csv --dry-run --json
node scripts/provider-rate-limits.ts reset-provider --provider <provider> --csv assets/provider-rate-limits.csv --dry-run --json
```

For batch research/import flows, prefer `--continue-on-error` with structured JSON input.

### Runtime

Runtime code may import read-only helpers:

```ts
import { enrichExclusionWithRateLimits } from './src/runs/shared/model-exclusions.ts';
```

Actual integration point:
- File: `src/runs/shared/model-exclusions.ts`
- Purpose: enrich persisted model exclusions with `retryAfterHint` and `retryCondition` after real failures
- Rule: runtime code must not mutate `assets/provider-rate-limits.csv`; all edits go through the TS CLI

## Bundled snapshot

- Path: `assets/provider-rate-limits.csv`
- Schema: maintained by the TS editor
- Missing or invalid file behavior: treat as no insights, do not block selection/fallback
- Empty file behavior: acceptable, equivalent to no insights

## Skills

This repository includes `.agents/skills/provider-rate-limits/SKILL.md`. When working on provider rate limits, follow that skill's process: validate, search, edit only through the TS script, and re-check duplicates after changes.
