# Cost Tracking in Widget and Inline Results Plan

**Goal:** Show accumulated cost (`$X.XXXX`) in the async subagent widget and inline results so users don't need Ctrl+O to check spending.

**Architecture:** Add `cost: number` to `AgentProgress`, `AsyncStatus.steps[]`, `AsyncJobState`, and `AsyncRunStepSummary`. Add `totalCost: number` to `AsyncStatus`, `AsyncJobState`, and `AsyncRunSummary`. The runner accumulates cost from `usage.cost` on each step completion and writes it to `status.json`. The poller reads `totalCost` and the widget displays it.

**Tech Stack:** TypeScript (Node `--experimental-strip-types`), `node:fs`/`node:path`, `node:test`/`node:assert/strict`.

---

## Design notes (read before executing tasks)

### Upstream context
The upstream already tracks `currentTool`, `currentToolArgs`, `currentToolStartedAt`, `currentPath`, `recentTools`, `recentOutput`, `turnCount`, `toolCount`, `tokens` per step. Cost is the **only** missing metric. `Usage.cost` is already tracked per step in `runPiStreaming` — it just needs to propagate to `status.json` and the display layers.

### File locations (upstream structure)
- Types: `src/shared/types.ts`
- Runner: `src/runs/background/subagent-runner.ts`
- Status: `src/runs/background/async-status.ts`
- Job tracker: `src/runs/background/async-job-tracker.ts`
- Widget/inline render: `src/tui/render.ts`
- Formatters: `src/shared/formatters.ts`
- Utils: `src/shared/utils.ts`

### Cost semantics
- `cost: number` is non-optional, default `0` — matches `Usage.cost`
- `totalCost` at the payload level is the sum of all step costs
- Cost is accumulated from `singleResult.usage.cost` on step completion
- `formatCost(cost)` returns `''` for cost ≤ 0, otherwise `$X.XXXX`

---

### Task 1: Add cost fields to types

**Context:**
All types in the async status pipeline need `cost` (per-step) and `totalCost` (aggregate). This is a pure type addition with no behavioral changes.

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/runs/background/async-status.ts`

**What to implement:**

1. In `src/shared/types.ts`:
   - Add `cost: number` to `AgentProgress` (after `tokens: number`, line ~150)
   - Add `cost: number` to `AsyncStatus.steps[]` (after `error?: string`, line ~320)
   - Add `totalCost: number` to `AsyncStatus` (after `totalTokens`, line ~328)
   - Add `totalCost: number` to `AsyncJobState` (after `totalTokens`, line ~363)

2. In `src/runs/background/async-status.ts`:
   - Add `cost: number` to `AsyncRunStepSummary` (after `error?: string`, line ~29)
   - Add `totalCost: number` to `AsyncRunSummary` (after `totalTokens`, line ~56)
   - In `statusToSummary()`: map `cost: step.cost ?? 0` for each step (after `...(step.error ? { error: step.error } : {})`, line ~166)
   - In `statusToSummary()`: map `totalCost: status.totalCost ?? 0` (after `...(status.totalTokens ? { totalTokens: status.totalTokens } : {})`, line ~171)

**Steps:**
- [ ] Add `cost: number` to `AgentProgress` in `src/shared/types.ts`
- [ ] Add `cost: number` to `AsyncStatus.steps[]` in `src/shared/types.ts`
- [ ] Add `totalCost: number` to `AsyncStatus` in `src/shared/types.ts`
- [ ] Add `totalCost: number` to `AsyncJobState` in `src/shared/types.ts`
- [ ] Add `cost: number` to `AsyncRunStepSummary` in `src/runs/background/async-status.ts`
- [ ] Add `totalCost: number` to `AsyncRunSummary` in `src/runs/background/async-status.ts`
- [ ] Update `statusToSummary()` to map `cost` and `totalCost` with `?? 0` fallback
- [ ] Run `npm run test:unit`
  - Did all previously-passing tests still pass? If not, fix failures.
- [ ] Commit with message: "chore: add cost and totalCost fields to async status types"

**Acceptance criteria:**
- [ ] `AgentProgress` has `cost: number`
- [ ] `AsyncStatus.steps[]` has `cost: number`
- [ ] `AsyncStatus` has `totalCost: number`
- [ ] `AsyncJobState` has `totalCost: number`
- [ ] `AsyncRunStepSummary` has `cost: number`
- [ ] `AsyncRunSummary` has `totalCost: number`
- [ ] `statusToSummary` maps all new fields with `?? 0` fallback
- [ ] All previously-passing tests still pass

---

### Task 2: Wire cost tracking in runner

**Context:**
The runner needs to accumulate cost from `singleResult.usage.cost` on each step completion and write it to `status.json`. The `RunnerStatusPayload` inherits from `AsyncStatus` so it already has `totalCost` from Task 1.

**Files:**
- Modify: `src/runs/background/subagent-runner.ts`

**What to implement:**

1. In the initial `statusPayload` creation (around line ~896):
   - Add `cost: 0` to each step in the `flatSteps.map()` call (after `recentOutput: []`)
   - Add `totalCost: 0` to the statusPayload object (after the `steps` array)

2. In the step completion block (around line ~1346, after `statusPayload.steps[fi].error = singleResult.error`):
   - Add `statusPayload.steps[fi].cost = singleResult.usage.cost ?? 0;`
   - Add `statusPayload.totalCost = statusPayload.steps.reduce((sum, s) => sum + (s.cost ?? 0), 0);`

**Steps:**
- [ ] Add `cost: 0` to each step in the initial statusPayload creation
- [ ] Add `totalCost: 0` to the initial statusPayload
- [ ] Add cost accumulation after step completion (after `statusPayload.steps[fi].error = singleResult.error`)
- [ ] Run `npm run test:unit`
  - Did all previously-passing tests still pass? If not, fix failures.
- [ ] Commit with message: "feat: track cost in subagent runner status"

**Acceptance criteria:**
- [ ] Initial statusPayload has `cost: 0` on each step and `totalCost: 0`
- [ ] Step completion updates `cost` from `singleResult.usage.cost`
- [ ] Step completion recalculates `totalCost` from all steps
- [ ] All previously-passing tests still pass

---

### Task 3: Update job tracker and display

**Context:**
The job tracker polls `status.json` and needs to read `totalCost`. The widget and inline results need to display cost using a `formatCost` helper.

**Files:**
- Modify: `src/runs/background/async-job-tracker.ts`
- Modify: `src/shared/formatters.ts`
- Modify: `src/tui/render.ts`
- Modify: `src/shared/utils.ts`

**What to implement:**

1. In `src/runs/background/async-job-tracker.ts`:
   - Inside the poller loop (after `job.totalTokens = status.totalTokens ?? job.totalTokens;`): add `job.totalCost = status.totalCost ?? job.totalCost;`
   - In `handleStarted()` (creates initial `AsyncJobState`): add `totalCost: 0` to the initial job object (near `startedAt: now, updatedAt: now,`)

2. In `src/shared/formatters.ts` — add after `formatDuration`:
   ```ts
   export function formatCost(cost: number): string {
       if (cost <= 0) return "";
       return `$${cost.toFixed(4)}`;
   }
   ```

3. In `src/tui/render.ts`:
   - Import `formatCost` from `../shared/formatters.ts`
   - In the widget job stats (after `if (job.totalTokens?.total) parts.push(formatTokenStat(job.totalTokens.total));`): add `if (job.totalCost > 0) parts.push(formatCost(job.totalCost));`
   - In single-agent result header (after `progressInfo` calculation): add `const costInfo = r.usage.cost > 0 ? \` | ${formatCost(r.usage.cost)}\` : "";` and append `costInfo` to the header text
   - In chain/parallel result header (after `summaryStr` calculation): add `const totalCost = d.results.reduce((sum, r) => sum + (r.usage.cost ?? 0), 0); const costStr = totalCost > 0 ? \` | ${formatCost(totalCost)}\` : "";` and append `costStr` to the header text

4. In `src/shared/utils.ts`:
   - In `compactCompletedProgress` (after `tokens: progress.tokens,`): add `cost: progress.cost,`
   - Export `compactCompletedProgress` (change `function` to `export function`) so it can be tested

**Steps:**
- [ ] Add `job.totalCost` polling in `async-job-tracker.ts` (poller loop)
- [ ] Add `totalCost: 0` to initial job in `handleStarted()` in `async-job-tracker.ts`
- [ ] Add `formatCost` helper in `formatters.ts`
- [ ] Import `formatCost` in `render.ts`
- [ ] Add cost display to widget job stats in `render.ts`
- [ ] Add cost display to single-agent result header in `render.ts`
- [ ] Add cost display to chain/parallel result header in `render.ts`
- [ ] Add `cost: progress.cost` to `compactCompletedProgress` in `utils.ts`
- [ ] Export `compactCompletedProgress` from `utils.ts`
- [ ] Run `npm run test:unit`
  - Did all previously-passing tests still pass? If not, fix failures.
- [ ] Commit with message: "feat: display cost in widget and inline results"

**Acceptance criteria:**
- [ ] Job tracker polls `totalCost` from status
- [ ] `formatCost` returns `''` for cost ≤ 0, `$X.XXXX` otherwise
- [ ] Widget shows cost after token stats (when > 0)
- [ ] Single-agent inline result shows cost in header
- [ ] Chain/parallel inline result shows total cost in header
- [ ] `compactCompletedProgress` preserves `cost`
- [ ] All previously-passing tests still pass

---

### Task 4: Tests

**Context:**
Verify cost tracking end-to-end: type mapping, runner accumulation, poller reading, and display formatting.

**Files:**
- Create: `test/unit/cost-tracking.test.ts`

**What to implement:**

1. Test `formatCost`:
   - `formatCost(0)` → `''`
   - `formatCost(-0.001)` → `''`
   - `formatCost(0.0123)` → `'$0.0123'`
   - `formatCost(1.5)` → `'$1.5000'`

2. Test `compactCompletedProgress` preserves cost (imported from utils.ts, now exported):
   - Create completed AgentProgress with known cost → verify cost preserved after compaction
   - Verify running progress is returned unchanged

3. Test cost field mapping via `listAsyncRuns()` (public API — `statusToSummary` is private):
   - Create a temp async run dir with status.json containing cost on steps and totalCost → call `listAsyncRuns()` → verify mapped to AsyncRunSummary
   - Create a temp async run dir with status.json missing cost (old format) → call `listAsyncRuns()` → verify defaults to 0

**Steps:**
- [ ] Write `formatCost` tests
- [ ] Write `compactCompletedProgress` cost preservation tests (import from utils.ts)
- [ ] Write `listAsyncRuns()` cost mapping tests (use temp dirs with mock status.json)
- [ ] Run `npm run test:unit`
  - Did all tests pass? If not, fix failures.
- [ ] Commit with message: "test: add unit tests for cost tracking"

**Acceptance criteria:**
- [ ] `formatCost` tests cover zero, negative, small, and large values
- [ ] `compactCompletedProgress` preserves cost
- [ ] Cost fields mapped correctly via `listAsyncRuns()` with `?? 0` fallback for old status.json
- [ ] All tests pass
