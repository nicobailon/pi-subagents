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

### PR #268 — MERGED WITH REVIEW FIXES
- **Title:** Use requester context for slash bridge runs.
- **Decision:** Merge, then immediately fix review-loop finding.
- **Reason:** Necessary slash bridge bug fix: bridge runs could use stale/null `lastUiContext` instead of the live slash command requester context.
- **Process:** Simulated in `/tmp/pi-subagents-pr268-panel`; GPT-5.5 panel unanimously recommended merge.
- **Review-loop fix implemented:** Runtime cleanup now disposes slash and prompt-template bridge subscriptions on hot reload/session shutdown, preventing duplicate handlers and stale pre-fix bridges.
- **Validation:**
  - `node --experimental-strip-types --test test/unit/slash-bridge.test.ts test/unit/index-child-registration.test.ts` passed.
  - `node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/slash-commands.test.ts` passed.

### PR #280 — ALREADY INCLUDED
- **Title:** `[Feature Request] Configurable minimum timeout`
- **Decision:** Retain as part of the starting branch used to create `dev`.
- **Reason:** `dev` was created from the current branch `configurable-foreground-timeout-floor`, whose tip is `origin/pr/280`; no separate merge was performed.
- **Follow-up:** Updated the parallel foreground timeout integration test to set a low `minForegroundTimeoutMs`, because the new default floor intentionally raises short foreground timeouts.

## Skipped Open PRs

### PR #276 — SKIPPED
- **Title:** Add configurable subagent live widget placement.
- **Reason:** Optional UI configuration feature, not a 100% necessary bug fix/functionality for this sweep.

### PR #261 — SKIPPED
- **Title:** `feat(skills): support nested directories and lightweight injection`
- **Reason:** Useful feature, but broad and optional; not necessary under the strict merge rule.

### PR #258 — SKIPPED
- **Title:** prevent skill files from being registered as subagents.
- **Reason:** Redundant after merging PR #271, which fixes the same issue more narrowly and with project/user tests.

### PR #255 — SKIPPED
- **Title:** pi permission system integration.
- **Reason:** Broad optional integration with an external permission-system package; useful, but not 100% necessary for core subagent operation.

### PR #251 — SKIPPED
- **Title:** parallel groups, metadata, group options, completion via `/chain`.
- **Reason:** Large slash-command feature expansion; optional and not a necessary bug fix.

### PR #250 — SKIPPED
- **Title:** Trim repeated schema descriptions / harden schema pruning coverage.
- **Reason:** Token/schema-surface optimization and tests; beneficial but optional.

### PR #248 — SKIPPED
- **Title:** remove `allOf`/`anyOf`/`const`/`if`/`then` from tool parameter schemas for provider compatibility.
- **Reason:** Real provider-compatibility intent, but the PR is stale against current acceptance-contract/schema semantics. Simulation conflicted in `src/extension/schemas.ts`; taking the PR side would reintroduce old `level`/`reason` acceptance policy and `type: [...]` unions that current tests reject. Needs an updated patch, not a direct merge.

### PR #244 — SKIPPED
- **Title:** keep subagent spinners animating with session-scoped dirs.
- **Reason:** UI polish/animation bug; not necessary enough under the strict rule.

### PR #232 — SKIPPED
- **Title:** EPERM-tolerant `ensureAccessibleDir` with pid-scoped fallback.
- **Reason:** Necessary Windows/ACL bug-fix intent, but simulation conflicted in `src/extension/index.ts`; review found a build issue (`DIRS` use without import in `nested-events.ts`) and weak fallback coverage. Needs fixes before merge.

### PR #231 — SKIPPED
- **Title:** run-history v2 and builtin override extensions.
- **Reason:** Broad feature/refactor; optional and conflict-prone.

### PR #230 — SKIPPED
- **Title:** document `contact_supervisor` as runtime-bridge-injected.
- **Reason:** Documentation-only clarification; not necessary for runtime correctness.

### PR #229 — SKIPPED
- **Title:** resolve subagent context per agent `defaultContext`.
- **Reason:** Large, stale/conflicting branch. Simulation conflicted across changelog/package/executor/tests, and current `dev` already contains modern default-context handling. Needs rebasing before reconsideration.

### PR #227 — SKIPPED
- **Title:** make default output paths unique and authoritative across all run modes.
- **Reason:** Useful output-path correctness work, but simulation conflicted in async/foreground execution paths and overlaps with newer output handling; not safe as a direct merge.

### PR #226 — SKIPPED
- **Title:** auto-add unique runId/index suffix to default output paths.
- **Reason:** Older/narrower version of PR #227 plus unrelated builtin progress changes; skipped as redundant/conflicting.

### PR #219 — SKIPPED
- **Title:** apply `agentOverrides` to user/project custom agents.
- **Reason:** Configuration feature, not a necessary bug fix under the strict rule.

### PR #206 — SKIPPED
- **Title:** handle deferred session file writes from `createBranchedSession`.
- **Reason:** Necessary fork-context bug-fix intent, but panel review found a correctness blocker: fallback-written session files can later duplicate header/history after child messages. Targeted tests passed but did not cover post-spawn persistence. Needs a safer patch.

### PR #205 — SKIPPED
- **Title:** prevent duplicate `subagent` tool registration in child processes.
- **Reason:** Redundant after merging PR #270, which includes this fix and additional nested fanout fixes.

### PR #204 — SKIPPED
- **Title:** ignore legacy skill dirs in agent discovery.
- **Reason:** Redundant after merging PR #271.

### PR #177 — SKIPPED
- **Title:** sanitize forked session tool IDs and thinking signatures for Anthropic compatibility.
- **Reason:** Draft PR; skip until ready.

## Final Validation

- `gh pr list --repo nicobailon/pi-subagents --state open --limit 200` matched every open upstream PR to a decision above.
- `npm run test:unit` passed: 523 tests.
- `npm run test:integration` passed: 379 tests.

