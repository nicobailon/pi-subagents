---
topic: runtime-model-fallback
feature_id: runtime-model-fallback
document_type: brainstorm
date: 2026-03-11
---

# Runtime Model Fallback

## What We're Building
Add a runtime model fallback policy to `pi-subagents` so delegated runs can recover from model and provider failures without masking genuine task mistakes.

Today model selection is effectively one-shot: explicit override wins, then agent frontmatter model, then the child Pi process falls back to its own defaults. The new behavior should make model choice an execution policy instead of a single resolution step.

The desired candidate order is:
1. explicit invocation or step/task model override
2. agent frontmatter model
3. parent session’s current active model
4. configured fallback model list

Fallback should happen only for classified runtime/provider failures such as auth expiry, quota exhaustion, rate limiting, provider outages, model unavailability, tool-schema incompatibility, and transient transport or 5xx failures. It should not retry prompt mistakes, bad paths, invalid files, or other deterministic user/task errors.

## Why This Approach
We considered a minimal patch in each execution path and a sync-only first version. Both would be smaller initially, but they would increase the odds of behavior drift between sync, async, single, parallel, and chain execution.

The chosen direction is a centralized fallback policy plus a shared execution wrapper. That keeps precedence, retry classification, cooldown handling, and observability consistent everywhere the tool runs. It is also the most contributor-friendly upstream story: one clear policy, one mental model, and fewer mode-specific exceptions.

This stays YAGNI by keeping v1 intentionally narrow. The first version should expose only the smallest useful config surface and defer richer provider-specific routing until there is real demand.

## Key Decisions
- **Parent session model is a default fallback candidate:** It should be enabled by default, but only after explicit and agent-configured models. This preserves user context without overriding deliberate choices.
- **Minimal config surface for v1:** Start with `preferCurrentSessionModel`, `fallbackModels`, and `cooldownMinutes`.
- **No `providerFallbacks` in v1:** Provider-directed routing is deferred. A simple ordered fallback list is easier to understand and upstream.
- **Retry classification should be moderately conservative:** Retry on auth expiry, quota/rate-limit issues, model unavailable, provider outage, tool-schema incompatibility, and generic transport/API 5xx/network failures.
- **Do not retry deterministic task errors:** Bad prompts, missing files, invalid paths, malformed inputs, and similar user-caused failures should fail immediately.
- **Session-scoped cooldown cache should support provider-wide failures:** Mark exact model routes bad by default, but mark an entire provider bad when the failure clearly appears provider-wide.
- **Fallback behavior should be visible:** Progress and final results should show the requested model, attempted models, chosen model, and fallback reason.
- **Existing model precedence remains intact:** Runtime fallback extends the current order; it does not replace explicit overrides or agent frontmatter.
- **`ctx.modelRegistry` remains the source of availability metadata, not policy:** It should help normalize and validate candidate models, but fallback decisions should come from the execution policy.
- **`ctx.model` is safe to use as ambient context only:** It should be treated as a fallback candidate, not as hidden inheritance magic.
- **Minimum robust validation scope:** The feature should be validated across sync single, sync parallel, sync chain, async single, and async chain flows, including retryable failure, non-retryable failure, cooldown reuse, and observability output.

## Resolved Questions
- **Should the parent session’s current model participate in fallback?** Yes. Enabled by default after explicit and agent models.
- **What should the first config surface be?** A minimal v1 with `preferCurrentSessionModel`, `fallbackModels`, and `cooldownMinutes`.
- **How conservative should retry behavior be?** Moderate: include transient transport/network/API failures in addition to obvious provider/runtime failures.
- **How should cooldown caching work?** Cache exact model failures, and escalate to provider-wide cooldowns when the failure is clearly provider-wide.
- **How visible should fallback behavior be?** Visible in both progress updates and final results.

## Open Questions
- None for the brainstorm phase. Implementation mechanics, exact error taxonomy sources, and serialization details should be handled in planning.

## Next Steps
→ Run `/workflows-plan` to turn this into a concrete implementation plan, file-by-file changes, and a test matrix.