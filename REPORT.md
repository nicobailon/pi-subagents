# Upstream PR Merge Report

Target branch: `dev`
Upstream remote: `origin` (`https://github.com/nicobailon/pi-subagents.git`)

Decision rule: merge bug fixes and functionality judged 100% necessary; skip redundant, optional, draft, or risky/conflicting changes. Each merge candidate is simulated in a separate worktree and reviewed by a subagent panel before merging.

## Decisions

### Baseline: `origin/main` — MERGED
- **Decision:** Merge before reviewing PRs.
- **Reason:** `dev` needed the current upstream baseline bug fix `fix: return final assistant text part` before evaluating PR refs.

### PR #273 — MERGED
- **Title:** `fix: launch async runner with node`
- **Decision:** Merge.
- **Reason:** Necessary async-runner bug fix: detached runner must be launched through the Node executable instead of assuming the script is directly executable.
- **Process:** Simulated in `/tmp/pi-subagents-pr273-panel`; GPT-5.5 panel recommended merge.
- **Validation:** Targeted async execution tests passed in the simulation worktree.
- **Post-merge review-loop:** No fix-now blockers found.

### PR #272 — MERGED WITH REVIEW FIXES
- **Title:** `fix: async parallel Windows crash`
- **Decision:** Merge, then immediately fix review-loop findings.
- **Reason:** Necessary Windows async parallel crash fix.
- **Process:** Simulated in `/tmp/pi-subagents-pr272-panel`; GPT-5.5 panel recommended merge only with immediate follow-up fixes.
- **Review-loop fixes implemented:**
  - Added retry-testable atomic JSON writes and coverage for transient Windows rename failures.
  - Added crash-result payload shape with `state`, `summary`, and `results` so async consumers can display failures consistently.
  - Logged repeated best-effort status/crash-result write failures instead of silently swallowing them.
  - Separated top-level intercom target from child result intercom target in crash payloads.
- **Validation:**
  - `node --experimental-strip-types --test test/unit/atomic-json.test.ts test/unit/subagent-runner-crash-result.test.ts` passed.
  - `node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/async-execution.test.ts` passed.
  - Combined async/parallel integration run had one unrelated timeout-sensitive failure in `parallel-execution.test.ts`.

### PR #271 — MERGED
- **Title:** legacy skill directories are not discovered as agents.
- **Decision:** Merge.
- **Reason:** Necessary bug fix: legacy `.agents/skills` and `~/.agents/skills` skill files could be recursively discovered as agents.
- **Process:** Simulated in `/tmp/pi-subagents-pr271-panel`; GPT-5.5 panel unanimously recommended merge.
- **Validation:** `node --experimental-strip-types --test test/unit/agent-frontmatter.test.ts` passed.
- **Post-merge review-loop:** No fix-now blockers found.
- **Redundancy note:** Prefer #271 over #258/#204 for this issue because #271 is narrower and has project/user regression coverage.

### PR #270 — MERGED WITH REVIEW FIXES
- **Title:** preserve nested fanout subagent tool history.
- **Decision:** Merge, then immediately fix review-loop finding.
- **Reason:** Necessary nested fanout fixes: prevents duplicate child registration, preserves authorized fanout child subagent history, and improves nested foreground visibility. It also supersedes PR #205's duplicate-registration fix.
- **Process:** Simulated in `/tmp/pi-subagents-pr270-panel`; GPT-5.5 panel split. Parent decision: merge only with immediate fanout-history leak fix; record chain/parallel live nested UI as non-blocking risk.
- **Review-loop fix implemented:** Fanout child context now preserves subagent tool calls/results only after the current child task user message, while still stripping inherited parent subagent artifacts and parent-only custom messages. Added mixed-history regression test.
- **Validation:**
  - `node --experimental-strip-types --test test/unit/subagent-prompt-runtime.test.ts test/unit/index-child-registration.test.ts test/unit/widget-nested-render.test.ts` passed.
  - `node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/render-fork-badge.test.ts` passed.
- **Residual risk:** Live `nestedChildren` propagation for chain/parallel foreground updates may still be incomplete; final details are enriched. Recorded as non-blocking because the core bug fix is necessary.

