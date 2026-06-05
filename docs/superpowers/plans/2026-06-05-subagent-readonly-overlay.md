# Subagent Read-Only Watch Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/subagent-watch`, a current-session-only read-only overlay for discovering and tailing async/background subagent instances, including nested agents.

**Architecture:** Add a focused `src/watch/` module that converts existing async job/nested metadata into a watch tree, reads child session JSONL/log files read-only, and renders a selector plus tabbed overlay using Pi's existing TUI/message components. Register the command from the extension entrypoint and keep all session files read-only.

**Tech Stack:** TypeScript, Node built-in test runner, `@earendil-works/pi-coding-agent` exported message/TUI components, `@earendil-works/pi-tui`, existing `SubagentState`, `AsyncJobState`, and nested status helpers.

---

## File Structure

Create:

- `src/watch/watch-types.ts` — shared watch tree, target, tab, parse, and scroll-state types.
- `src/watch/watch-tree.ts` — builds current-session watch sections from `SubagentState.asyncJobs`, status files, and nested projections.
- `src/watch/transcript-reader.ts` — read-only complete-line JSONL parser for child session files.
- `src/watch/transcript-renderer.ts` — adapts parsed session entries to Pi message components with generic fallback rendering.
- `src/watch/watch-scroll.ts` — bulletin-board-style bottom-relative scroll math.
- `src/watch/watch-overlay.ts` — read-only tabbed overlay for one selected agent target.
- `src/watch/watch-selector.ts` — tree selector overlay for current-session watch targets.
- `src/watch/slash-command.ts` — registers `/subagent-watch [target]` and coordinates selector/overlay.

Modify:

- `src/extension/index.ts` — import and register the watch command.
- `test/unit/*.test.ts` — add unit tests for watch tree, transcript reader, scroll state, and overlay state.
- `test/integration/slash-commands.test.ts` — assert command registration and no-UI fallback behavior.
- `README.md` — add a short user-facing note for `/subagent-watch`.

---

### Task 1: Define watch types and tree builder

**Files:**
- Create: `src/watch/watch-types.ts`
- Create: `src/watch/watch-tree.ts`
- Test: `test/unit/watch-tree.test.ts`

- [ ] **Step 1: Write failing watch-tree tests**

Create `test/unit/watch-tree.test.ts`:

```ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildWatchSections } from "../../src/watch/watch-tree.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function stateWithJobs(jobs: Array<[string, Partial<SubagentState["asyncJobs"] extends Map<string, infer J> ? J : never>]>): SubagentState {
  return {
    baseCwd: process.cwd(),
    currentSessionId: "session-current",
    asyncJobs: new Map(jobs.map(([id, job]) => [id, job as any])),
    foregroundControls: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear: () => {} },
  } as any;
}

describe("subagent watch tree", () => {
  it("groups active, queued, and done jobs and includes run ids", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-tree-"));
    try {
      const activeDir = path.join(root, "active");
      const queuedDir = path.join(root, "queued");
      const doneDir = path.join(root, "done");
      fs.mkdirSync(activeDir, { recursive: true });
      fs.mkdirSync(queuedDir, { recursive: true });
      fs.mkdirSync(doneDir, { recursive: true });

      const state = stateWithJobs([
        ["run-active", { asyncId: "run-active", asyncDir: activeDir, status: "running", mode: "parallel", agents: ["reviewer", "reviewer"], steps: [
          { agent: "reviewer", label: "Correctness", status: "running", currentTool: "read", sessionFile: path.join(root, "a.jsonl") },
          { agent: "reviewer", label: "Tests", status: "complete", sessionFile: path.join(root, "b.jsonl") },
        ] }],
        ["run-queued", { asyncId: "run-queued", asyncDir: queuedDir, status: "queued", mode: "single", agents: ["worker"], steps: [
          { agent: "worker", status: "pending" },
        ] }],
        ["run-done", { asyncId: "run-done", asyncDir: doneDir, status: "complete", mode: "single", agents: ["scout"], steps: [
          { agent: "scout", status: "complete", sessionFile: path.join(root, "c.jsonl") },
        ] }],
      ]);

      const sections = buildWatchSections(state, { now: () => 1_000 });
      assert.deepEqual(sections.map((s) => s.title), ["Active", "Queued", "Done"]);
      assert.equal(sections[0]!.rows.some((r) => r.text.includes("run-active")), true);
      assert.equal(sections[0]!.targets.map((t) => t.agent), ["reviewer", "reviewer"]);
      assert.equal(sections[0]!.targets[0]!.displayName, "Correctness");
      assert.equal(sections[0]!.targets[0]!.outputLog, path.join(activeDir, "output-0.log"));
      assert.equal(sections[1]!.targets[0]!.rootRunId, "run-queued");
      assert.equal(sections[2]!.targets[0]!.rootRunId, "run-done");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders nested descendants as indented selectable targets", () => {
    const state = stateWithJobs([
      ["root", { asyncId: "root", asyncDir: "/tmp/root", status: "running", mode: "single", agents: ["orchestrator"], steps: [
        { agent: "orchestrator", status: "running", children: [
          { id: "nested-1", parentRunId: "root", depth: 1, path: [{ runId: "root", stepIndex: 0, agent: "orchestrator" }], state: "running", agent: "reviewer", currentTool: "grep", sessionFile: "/tmp/nested.jsonl" },
        ] },
      ] }],
    ]);

    const sections = buildWatchSections(state, { now: () => 1_000 });
    const nested = sections[0]!.targets.find((target) => target.id.includes("nested-1"));
    assert.ok(nested);
    assert.equal(nested.agent, "reviewer");
    assert.deepEqual(nested.ancestry, ["root", "orchestrator", "reviewer"]);
    assert.equal(sections[0]!.rows.some((row) => row.text.includes("└─") || row.text.includes("├─")), true);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
node --experimental-strip-types --test test/unit/watch-tree.test.ts
```

Expected: fails because `src/watch/watch-tree.ts` does not exist.

- [ ] **Step 3: Implement watch types**

Create `src/watch/watch-types.ts`:

```ts
import type { AsyncJobState, AsyncJobStep, NestedRunSummary } from "../shared/types.ts";

export type WatchSectionTitle = "Active" | "Queued" | "Done";
export type WatchTargetStatus = "pending" | "queued" | "running" | "complete" | "completed" | "failed" | "paused";
export type WatchTab = "transcript" | "status" | "log";

export interface WatchTarget {
  id: string;
  rootRunId: string;
  rootAsyncDir: string;
  rootStatus: AsyncJobState["status"];
  stepIndex?: number;
  nestedRunId?: string;
  agent: string;
  displayName: string;
  status: WatchTargetStatus;
  phase?: string;
  label?: string;
  taskPreview?: string;
  sessionFile?: string;
  outputLog?: string;
  rootLog?: string;
  eventsFile?: string;
  currentTool?: string;
  activityState?: string;
  lastActivityAt?: number;
  startedAt?: number;
  endedAt?: number;
  toolCount?: number;
  tokens?: { input: number; output: number; total: number };
  error?: string;
  ancestry: string[];
  depth: number;
  rawStep?: AsyncJobStep;
  rawNested?: NestedRunSummary;
}

export interface WatchTreeRow {
  key: string;
  selectable: boolean;
  targetId?: string;
  depth: number;
  text: string;
}

export interface WatchSection {
  title: WatchSectionTitle;
  rows: WatchTreeRow[];
  targets: WatchTarget[];
}
```

- [ ] **Step 4: Implement watch tree builder**

Create `src/watch/watch-tree.ts`:

```ts
import * as path from "node:path";
import { attachRootChildrenToSteps, projectNestedRegistryForRoot } from "../runs/shared/nested-events.ts";
import type { AsyncJobState, AsyncJobStep, NestedRunSummary, SubagentState } from "../shared/types.ts";
import { formatActivityLabel } from "../shared/status-format.ts";
import type { WatchSection, WatchSectionTitle, WatchTarget, WatchTargetStatus, WatchTreeRow } from "./watch-types.ts";

interface BuildWatchOptions {
  now?: () => number;
}

const STATUS_ICON: Record<string, string> = {
  running: "●",
  queued: "○",
  pending: "○",
  complete: "✓",
  completed: "✓",
  failed: "✕",
  paused: "Ⅱ",
};

function normalizeStatus(value: unknown): WatchTargetStatus {
  if (value === "queued" || value === "pending" || value === "running" || value === "complete" || value === "completed" || value === "failed" || value === "paused") return value;
  return "pending";
}

function sectionForJob(job: AsyncJobState): WatchSectionTitle {
  if (job.status === "queued") return "Queued";
  if (job.status === "running") return "Active";
  return "Done";
}

function displayName(agent: string, step: Partial<AsyncJobStep> = {}): string {
  if (step.label?.trim()) return step.label.trim();
  if (step.phase?.trim()) return `${step.phase.trim()} ${agent}`;
  const task = typeof (step as { task?: unknown }).task === "string" ? (step as { task: string }).task.trim().split("\n")[0] : "";
  if (task) return task.length > 80 ? `${task.slice(0, 77)}...` : task;
  return agent;
}

function outputLogFor(asyncDir: string, stepIndex?: number): string | undefined {
  return stepIndex === undefined ? undefined : path.join(asyncDir, `output-${stepIndex}.log`);
}

function targetLine(target: WatchTarget, now: number): string {
  const icon = STATUS_ICON[target.status] ?? "•";
  const tool = target.currentTool ? ` · ${target.currentTool}` : "";
  const activity = target.status === "running" ? formatActivityLabel(target.lastActivityAt, target.activityState as never, now) : target.status;
  return `${icon} ${target.agent.padEnd(10)} ${target.displayName}  ${activity}${tool}`;
}

function makeStepTarget(job: AsyncJobState, step: AsyncJobStep, index: number, now: number): WatchTarget {
  const agent = step.agent;
  const status = normalizeStatus(step.status);
  const name = displayName(agent, step);
  return {
    id: `${job.asyncId}/${index + 1}`,
    rootRunId: job.asyncId,
    rootAsyncDir: job.asyncDir,
    rootStatus: job.status,
    stepIndex: index,
    agent,
    displayName: name,
    status,
    ...(step.phase ? { phase: step.phase } : {}),
    ...(step.label ? { label: step.label } : {}),
    ...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
    ...(outputLogFor(job.asyncDir, index) ? { outputLog: outputLogFor(job.asyncDir, index) } : {}),
    rootLog: path.join(job.asyncDir, `subagent-log-${job.asyncId}.md`),
    eventsFile: path.join(job.asyncDir, "events.jsonl"),
    ...(step.currentTool ? { currentTool: step.currentTool } : {}),
    ...(step.activityState ? { activityState: step.activityState } : {}),
    ...(step.lastActivityAt !== undefined ? { lastActivityAt: step.lastActivityAt } : {}),
    ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
    ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
    ...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
    ...(step.tokens ? { tokens: step.tokens } : {}),
    ...(step.error ? { error: step.error } : {}),
    ancestry: [job.asyncId, agent],
    depth: 1,
    rawStep: step,
  };
}

function makeNestedTarget(job: AsyncJobState, run: NestedRunSummary, parentNames: string[], now: number): WatchTarget {
  const agent = run.agent ?? run.agents?.join("+") ?? run.id;
  const status = normalizeStatus(run.state);
  const ancestry = [...parentNames, agent];
  return {
    id: `${job.asyncId}/${run.id}`,
    rootRunId: job.asyncId,
    rootAsyncDir: job.asyncDir,
    rootStatus: job.status,
    nestedRunId: run.id,
    agent,
    displayName: agent,
    status,
    ...(run.sessionFile ? { sessionFile: run.sessionFile } : {}),
    ...(run.asyncDir ? { outputLog: path.join(run.asyncDir, "output-0.log") } : {}),
    rootLog: path.join(job.asyncDir, `subagent-log-${job.asyncId}.md`),
    eventsFile: path.join(job.asyncDir, "events.jsonl"),
    ...(run.currentTool ? { currentTool: run.currentTool } : {}),
    ...(run.activityState ? { activityState: run.activityState } : {}),
    ...(run.lastActivityAt !== undefined ? { lastActivityAt: run.lastActivityAt } : {}),
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.toolCount !== undefined ? { toolCount: run.toolCount } : {}),
    ...(run.totalTokens ? { tokens: run.totalTokens } : {}),
    ...(run.error ? { error: run.error } : {}),
    ancestry,
    depth: ancestry.length - 1,
    rawNested: run,
  };
}

function collectNested(job: AsyncJobState, nested: NestedRunSummary[] | undefined, parentNames: string[], rows: WatchTreeRow[], targets: WatchTarget[], now: number): void {
  for (let index = 0; index < (nested ?? []).length; index += 1) {
    const run = nested![index]!;
    const target = makeNestedTarget(job, run, parentNames, now);
    targets.push(target);
    rows.push({ key: target.id, selectable: true, targetId: target.id, depth: target.depth, text: `${index === (nested!.length - 1) ? "└─" : "├─"} ${targetLine(target, now)}` });
    collectNested(job, run.children, target.ancestry, rows, targets, now);
    for (const step of run.steps ?? []) collectNested(job, step.children, [...target.ancestry, step.agent], rows, targets, now);
  }
}

function buildJobRows(job: AsyncJobState, now: number): { rows: WatchTreeRow[]; targets: WatchTarget[] } {
  const rows: WatchTreeRow[] = [];
  const targets: WatchTarget[] = [];
  const status = job.status;
  const agents = job.agents?.join(", ") ?? job.steps?.map((step) => step.agent).join(", ") ?? "subagents";
  rows.push({ key: `${job.asyncId}:root`, selectable: false, depth: 0, text: `▾ ${job.asyncId}  ${job.mode ?? "single"}  ${status} · ${agents}` });

  const steps = (job.steps ?? []).map((step, index) => ({ ...step, index })) as AsyncJobStep[];
  try {
    const nested = projectNestedRegistryForRoot(job.asyncId)?.children ?? job.nestedChildren ?? [];
    attachRootChildrenToSteps(job.asyncId, steps, nested);
  } catch {
    // The watch tree is observational. If nested projection fails, keep direct steps visible.
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    const target = makeStepTarget(job, step, index, now);
    targets.push(target);
    rows.push({ key: target.id, selectable: true, targetId: target.id, depth: 1, text: `${index === steps.length - 1 && !step.children?.length ? "└─" : "├─"} ${targetLine(target, now)}` });
    collectNested(job, step.children, target.ancestry, rows, targets, now);
  }
  return { rows, targets };
}

export function buildWatchSections(state: SubagentState, options: BuildWatchOptions = {}): WatchSection[] {
  const now = options.now?.() ?? Date.now();
  const byTitle: Record<WatchSectionTitle, WatchSection> = {
    Active: { title: "Active", rows: [], targets: [] },
    Queued: { title: "Queued", rows: [], targets: [] },
    Done: { title: "Done", rows: [], targets: [] },
  };
  for (const job of state.asyncJobs.values()) {
    const section = byTitle[sectionForJob(job)];
    const built = buildJobRows(job, now);
    section.rows.push(...built.rows);
    section.targets.push(...built.targets);
  }
  return [byTitle.Active, byTitle.Queued, byTitle.Done].filter((section) => section.rows.length > 0 || section.title !== "Done");
}

export function flattenWatchTargets(sections: WatchSection[]): WatchTarget[] {
  return sections.flatMap((section) => section.targets);
}
```

- [ ] **Step 5: Run tests and verify they pass**

Run:

```bash
node --experimental-strip-types --test test/unit/watch-tree.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/watch/watch-types.ts src/watch/watch-tree.ts test/unit/watch-tree.test.ts
git commit -m "feat: build subagent watch tree"
```

---

### Task 2: Add transcript reader with partial-line safety

**Files:**
- Create: `src/watch/transcript-reader.ts`
- Test: `test/unit/transcript-reader.test.ts`

- [ ] **Step 1: Write failing transcript reader tests**

Create `test/unit/transcript-reader.test.ts`:

```ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readTranscriptEntries } from "../../src/watch/transcript-reader.ts";

describe("readTranscriptEntries", () => {
  it("parses complete JSONL lines and ignores an incomplete trailing line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-reader-"));
    try {
      const file = path.join(dir, "session.jsonl");
      fs.writeFileSync(file, [
        JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello", timestamp: 1 } }),
        "{\"type\":\"message\"",
      ].join("\n"), "utf-8");

      const result = readTranscriptEntries(file);
      assert.equal(result.entries.length, 2);
      assert.equal(result.warnings.length, 0);
      assert.equal(result.partialTail, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports malformed complete lines as warnings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-reader-bad-"));
    try {
      const file = path.join(dir, "session.jsonl");
      fs.writeFileSync(file, "{bad json}\n", "utf-8");
      const result = readTranscriptEntries(file);
      assert.equal(result.entries.length, 0);
      assert.equal(result.warnings.length, 1);
      assert.match(result.warnings[0]!, /line 1/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an unavailable result for missing files", () => {
    const result = readTranscriptEntries("/tmp/does-not-exist-subagent-watch.jsonl");
    assert.equal(result.available, false);
    assert.match(result.warnings[0]!, /not found/);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
node --experimental-strip-types --test test/unit/transcript-reader.test.ts
```

Expected: fails because `transcript-reader.ts` does not exist.

- [ ] **Step 3: Implement transcript reader**

Create `src/watch/transcript-reader.ts`:

```ts
import * as fs from "node:fs";

export interface TranscriptReadResult {
  available: boolean;
  entries: unknown[];
  warnings: string[];
  partialTail: boolean;
  bytes: number;
}

export function readTranscriptEntries(sessionFile: string | undefined): TranscriptReadResult {
  if (!sessionFile) {
    return { available: false, entries: [], warnings: ["Transcript unavailable: no session file was recorded for this agent."], partialTail: false, bytes: 0 };
  }
  let content: string;
  try {
    content = fs.readFileSync(sessionFile, "utf-8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    const reason = code === "ENOENT" ? "not found" : error instanceof Error ? error.message : String(error);
    return { available: false, entries: [], warnings: [`Transcript unavailable: ${sessionFile} (${reason})`], partialTail: false, bytes: 0 };
  }

  const bytes = Buffer.byteLength(content, "utf-8");
  const partialTail = content.length > 0 && !content.endsWith("\n");
  const completeContent = partialTail ? content.slice(0, content.lastIndexOf("\n") + 1) : content;
  const lines = completeContent.split("\n").filter((line) => line.trim().length > 0);
  const entries: unknown[] = [];
  const warnings: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      entries.push(JSON.parse(lines[index]!));
    } catch (error) {
      warnings.push(`Ignoring malformed transcript JSONL line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { available: true, entries, warnings, partialTail, bytes };
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
node --experimental-strip-types --test test/unit/transcript-reader.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/watch/transcript-reader.ts test/unit/transcript-reader.test.ts
git commit -m "feat: read subagent transcripts safely"
```

---

### Task 3: Implement bulletin-board-style scroll state

**Files:**
- Create: `src/watch/watch-scroll.ts`
- Test: `test/unit/watch-scroll.test.ts`

- [ ] **Step 1: Write failing scroll tests**

Create `test/unit/watch-scroll.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWatchScrollState, getVisibleRange, scrollWatchState } from "../../src/watch/watch-scroll.ts";

describe("watch scroll state", () => {
  it("uses offset 0 as bottom/tail", () => {
    const state = createWatchScrollState();
    const range = getVisibleRange(state, 100, 10);
    assert.deepEqual(range, { start: 90, end: 100 });
  });

  it("scrolls by page and line from the bottom", () => {
    const state = createWatchScrollState();
    scrollWatchState(state, "pageUp", 100, 10);
    assert.equal(state.scrollOffset, 10);
    scrollWatchState(state, "lineUp", 100, 10);
    assert.equal(state.scrollOffset, 11);
    scrollWatchState(state, "pageDown", 100, 10);
    assert.equal(state.scrollOffset, 1);
    scrollWatchState(state, "lineDown", 100, 10);
    assert.equal(state.scrollOffset, 0);
  });

  it("clamps offsets when content shrinks", () => {
    const state = createWatchScrollState();
    scrollWatchState(state, "pageUp", 100, 10);
    scrollWatchState(state, "pageUp", 100, 10);
    assert.equal(state.scrollOffset, 20);
    const range = getVisibleRange(state, 12, 10);
    assert.deepEqual(range, { start: 0, end: 2 });
    assert.equal(state.scrollOffset, 2);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
node --experimental-strip-types --test test/unit/watch-scroll.test.ts
```

Expected: fails because `watch-scroll.ts` does not exist.

- [ ] **Step 3: Implement scroll helper**

Create `src/watch/watch-scroll.ts`:

```ts
export type WatchScrollAction = "pageUp" | "pageDown" | "lineUp" | "lineDown";

export interface WatchScrollState {
  scrollOffset: number;
}

export function createWatchScrollState(): WatchScrollState {
  return { scrollOffset: 0 };
}

function maxOffset(totalLines: number, visibleLines: number): number {
  return Math.max(0, totalLines - visibleLines);
}

export function clampWatchScroll(state: WatchScrollState, totalLines: number, visibleLines: number): void {
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxOffset(totalLines, visibleLines)));
}

export function scrollWatchState(state: WatchScrollState, action: WatchScrollAction, totalLines: number, visibleLines: number): void {
  const page = Math.max(1, visibleLines);
  if (action === "pageUp") state.scrollOffset += page;
  if (action === "pageDown") state.scrollOffset -= page;
  if (action === "lineUp") state.scrollOffset += 1;
  if (action === "lineDown") state.scrollOffset -= 1;
  clampWatchScroll(state, totalLines, visibleLines);
}

export function getVisibleRange(state: WatchScrollState, totalLines: number, visibleLines: number): { start: number; end: number } {
  clampWatchScroll(state, totalLines, visibleLines);
  const start = Math.max(0, totalLines - visibleLines - state.scrollOffset);
  const end = Math.max(0, totalLines - state.scrollOffset);
  return { start, end };
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
node --experimental-strip-types --test test/unit/watch-scroll.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/watch/watch-scroll.ts test/unit/watch-scroll.test.ts
git commit -m "feat: add subagent watch scrolling"
```

---

### Task 4: Render transcripts with Pi components and fallbacks

**Files:**
- Create: `src/watch/transcript-renderer.ts`
- Test: `test/unit/transcript-renderer.test.ts`

- [ ] **Step 1: Write failing transcript renderer tests**

Create `test/unit/transcript-renderer.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderTranscriptComponents } from "../../src/watch/transcript-renderer.ts";

function textOf(component: unknown): string {
  if (!component || typeof component !== "object") return "";
  const rendered = (component as { render?: (width: number) => string[] }).render?.(80);
  return rendered?.join("\n") ?? "";
}

describe("renderTranscriptComponents", () => {
  it("renders user and assistant entries with Pi components", () => {
    const components = renderTranscriptComponents([
      { type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello", timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } },
    ], { warnings: [] });
    const text = components.map(textOf).join("\n");
    assert.match(text, /hello/);
    assert.match(text, /hi/);
  });

  it("renders warnings as fallback text", () => {
    const components = renderTranscriptComponents([], { warnings: ["bad line"] });
    assert.match(components.map(textOf).join("\n"), /bad line/);
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
node --experimental-strip-types --test test/unit/transcript-renderer.test.ts
```

Expected: fails because `transcript-renderer.ts` does not exist.

- [ ] **Step 3: Implement transcript renderer**

Create `src/watch/transcript-renderer.ts`:

```ts
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  UserMessageComponent,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text, type Component } from "@earendil-works/pi-tui";

interface RenderTranscriptOptions {
  warnings: string[];
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n");
  return "";
}

function fallback(label: string, text: string): Component {
  return new Markdown(`**${label}**\n\n${text || "(empty)"}`, 1, 0, getMarkdownTheme());
}

export function renderTranscriptComponents(entries: unknown[], options: RenderTranscriptOptions): Component[] {
  const components: Component[] = [];
  for (const warning of options.warnings) components.push(new Text(`Warning: ${warning}`, 1, 0));

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (raw.type === "message" && raw.message && typeof raw.message === "object") {
      const message = raw.message as { role?: unknown };
      if (message.role === "user") {
        components.push(new UserMessageComponent(textContent((message as UserMessage).content), getMarkdownTheme()));
      } else if (message.role === "assistant") {
        components.push(new AssistantMessageComponent(message as AssistantMessage, false, getMarkdownTheme()));
      } else if (message.role === "toolResult") {
        const tool = message as ToolResultMessage;
        components.push(fallback(`tool result: ${tool.toolName}`, textContent(tool.content)));
      } else if (message.role === "bashExecution") {
        components.push(new BashExecutionComponent(message as never));
      } else if (message.role === "custom") {
        components.push(new CustomMessageComponent(message as never, undefined, getMarkdownTheme()));
      } else {
        components.push(fallback(String(message.role ?? "message"), JSON.stringify(message, null, 2)));
      }
      continue;
    }
    if (raw.type === "custom_message") {
      components.push(new CustomMessageComponent({ role: "custom", customType: String(raw.customType ?? "custom"), content: raw.content as never, display: raw.display !== false, details: raw.details, timestamp: Date.now() } as never, undefined, getMarkdownTheme()));
      continue;
    }
    if (raw.type === "compaction") {
      components.push(new CompactionSummaryMessageComponent({ role: "compactionSummary", summary: String(raw.summary ?? ""), tokensBefore: Number(raw.tokensBefore ?? 0), timestamp: Date.now() } as never, getMarkdownTheme()));
      continue;
    }
    if (raw.type === "branch_summary") {
      components.push(new BranchSummaryMessageComponent({ role: "branchSummary", summary: String(raw.summary ?? ""), fromId: String(raw.fromId ?? ""), timestamp: Date.now() } as never, getMarkdownTheme()));
    }
  }
  return components;
}

export function renderTranscriptLines(entries: unknown[], options: RenderTranscriptOptions, width: number): string[] {
  const components = renderTranscriptComponents(entries, options);
  if (components.length === 0) return ["Transcript is empty."];
  return components.flatMap((component) => component.render(width));
}
```

- [ ] **Step 4: Run tests and adjust only for actual exported constructor signatures**

Run:

```bash
node --experimental-strip-types --test test/unit/transcript-renderer.test.ts
```

Expected: pass after correcting any constructor signature mismatch against installed Pi types. Do not replace Pi components with custom styling.

- [ ] **Step 5: Commit**

```bash
git add src/watch/transcript-renderer.ts test/unit/transcript-renderer.test.ts
git commit -m "feat: render watched transcripts"
```

---

### Task 5: Implement watch overlay state and rendering

**Files:**
- Create: `src/watch/watch-overlay.ts`
- Test: `test/unit/watch-overlay.test.ts`

- [ ] **Step 1: Write failing overlay state tests**

Create `test/unit/watch-overlay.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWatchOverlayState, handleWatchOverlayKey } from "../../src/watch/watch-overlay.ts";

describe("watch overlay state", () => {
  it("cycles tabs with tab and shift-tab", () => {
    const state = createWatchOverlayState();
    assert.equal(state.tab, "transcript");
    handleWatchOverlayKey(state, "\t", { totalLines: 0, visibleLines: 10 });
    assert.equal(state.tab, "status");
    handleWatchOverlayKey(state, "\t", { totalLines: 0, visibleLines: 10 });
    assert.equal(state.tab, "log");
    handleWatchOverlayKey(state, "\x1b[Z", { totalLines: 0, visibleLines: 10 });
    assert.equal(state.tab, "status");
  });

  it("returns navigation actions for back and close", () => {
    const state = createWatchOverlayState();
    assert.equal(handleWatchOverlayKey(state, "b", { totalLines: 0, visibleLines: 10 }), "back");
    assert.equal(handleWatchOverlayKey(state, "q", { totalLines: 0, visibleLines: 10 }), "close");
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
node --experimental-strip-types --test test/unit/watch-overlay.test.ts
```

Expected: fails because `watch-overlay.ts` does not exist.

- [ ] **Step 3: Implement overlay component skeleton**

Create `src/watch/watch-overlay.ts`:

```ts
import * as fs from "node:fs";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth, type Component, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { formatActivityLabel } from "../shared/status-format.ts";
import type { WatchTab, WatchTarget } from "./watch-types.ts";
import { createWatchScrollState, getVisibleRange, scrollWatchState, type WatchScrollState } from "./watch-scroll.ts";
import { readTranscriptEntries } from "./transcript-reader.ts";
import { renderTranscriptLines } from "./transcript-renderer.ts";

export interface WatchOverlayState {
  tab: WatchTab;
  scroll: WatchScrollState;
}

export type WatchOverlayAction = "handled" | "back" | "close" | "none";

const TABS: WatchTab[] = ["transcript", "status", "log"];

export function createWatchOverlayState(): WatchOverlayState {
  return { tab: "transcript", scroll: createWatchScrollState() };
}

function nextTab(tab: WatchTab, delta: 1 | -1): WatchTab {
  const index = TABS.indexOf(tab);
  return TABS[(index + delta + TABS.length) % TABS.length]!;
}

export function handleWatchOverlayKey(state: WatchOverlayState, data: string, view: { totalLines: number; visibleLines: number }): WatchOverlayAction {
  if (matchesKey(data, Key.escape) || data === "q") return "close";
  if (matchesKey(data, Key.backspace) || data === "b") return "back";
  if (matchesKey(data, Key.tab)) { state.tab = nextTab(state.tab, 1); state.scroll.scrollOffset = 0; return "handled"; }
  if (matchesKey(data, Key.shift("tab"))) { state.tab = nextTab(state.tab, -1); state.scroll.scrollOffset = 0; return "handled"; }
  if (matchesKey(data, Key.pageUp)) { scrollWatchState(state.scroll, "pageUp", view.totalLines, view.visibleLines); return "handled"; }
  if (matchesKey(data, Key.pageDown)) { scrollWatchState(state.scroll, "pageDown", view.totalLines, view.visibleLines); return "handled"; }
  if (matchesKey(data, Key.shift("up"))) { scrollWatchState(state.scroll, "lineUp", view.totalLines, view.visibleLines); return "handled"; }
  if (matchesKey(data, Key.shift("down"))) { scrollWatchState(state.scroll, "lineDown", view.totalLines, view.visibleLines); return "handled"; }
  return "none";
}

function padToWidth(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function readTextFile(file: string | undefined): string[] {
  if (!file) return ["No log file recorded for this agent."];
  try {
    return fs.readFileSync(file, "utf-8").split("\n");
  } catch (error) {
    return [`Log unavailable: ${file} (${error instanceof Error ? error.message : String(error)})`];
  }
}

function statusLines(target: WatchTarget, theme: Theme): string[] {
  return [
    `Agent: ${target.agent}`,
    `Display: ${target.displayName}`,
    `Status: ${target.status}`,
    target.currentTool ? `Current tool: ${target.currentTool}` : undefined,
    target.lastActivityAt !== undefined ? `Activity: ${formatActivityLabel(target.lastActivityAt, target.activityState as never)}` : undefined,
    `Root run: ${target.rootRunId}`,
    `Path: ${target.ancestry.join(" › ")}`,
    target.sessionFile ? `Session: ${target.sessionFile}` : undefined,
    target.outputLog ? `Log: ${target.outputLog}` : undefined,
    target.eventsFile ? `Events: ${target.eventsFile}` : undefined,
    target.error ? theme.fg("error", `Error: ${target.error}`) : undefined,
  ].filter((line): line is string => Boolean(line));
}

export class WatchOverlay implements Component {
  private state = createWatchOverlayState();
  private totalLines = 0;

  constructor(private input: { tui: TUI; theme: Theme; target: WatchTarget; onBack: () => void; onClose: () => void }) {}

  private contentLines(width: number): string[] {
    const inner = Math.max(1, width - 4);
    if (this.state.tab === "status") return statusLines(this.input.target, this.input.theme);
    if (this.state.tab === "log") return readTextFile(this.input.target.outputLog ?? this.input.target.rootLog);
    const transcript = readTranscriptEntries(this.input.target.sessionFile);
    return renderTranscriptLines(transcript.entries, { warnings: transcript.warnings }, inner);
  }

  render(width: number): string[] {
    const { theme, target } = this.input;
    if (width < 8) return [" ".repeat(Math.max(0, width))];
    const inner = Math.max(1, width - 4);
    const rows = this.input.tui.terminal.rows ?? process.stdout.rows ?? 24;
    const visibleRows = Math.max(1, rows - 8);
    const content = this.contentLines(width);
    this.totalLines = content.length;
    const range = getVisibleRange(this.state.scroll, content.length, visibleRows);
    const visible = content.slice(range.start, range.end);
    const tabText = TABS.map((tab) => tab === this.state.tab ? theme.bold(theme.fg("accent", tab)) : theme.fg("dim", tab)).join(theme.fg("dim", " | "));
    const title = `${target.ancestry.join(" › ")} · ${target.status}`;
    const lines = [
      theme.fg("border", "┌" + "─".repeat(width - 2) + "┐"),
      this.frame(theme.fg("accent", truncateToWidth(title, inner)), width),
      this.frame(tabText, width),
      theme.fg("border", "├" + "─".repeat(width - 2) + "┤"),
      ...visible.map((line) => this.frame(line, width)),
      ...Array.from({ length: Math.max(0, visibleRows - visible.length) }, () => this.frame("", width)),
      theme.fg("border", "├" + "─".repeat(width - 2) + "┤"),
      this.frame(theme.fg("dim", "Tab/Shift+Tab tabs · Backspace/b selector · PgUp/PgDn page · Shift+↑/↓ line · Esc/q close"), width),
      theme.fg("border", "└" + "─".repeat(width - 2) + "┘"),
    ];
    return lines.map((line) => visibleWidth(line) > width ? truncateToWidth(line, width) : line);
  }

  private frame(content: string, width: number): string {
    const inner = Math.max(1, width - 4);
    const safe = truncateToWidth(content.replaceAll("\r", " "), inner, "...", true);
    return this.input.theme.fg("border", "│ ") + padToWidth(safe, inner) + this.input.theme.fg("border", " │");
  }

  handleInput(data: string): void {
    const action = handleWatchOverlayKey(this.state, data, { totalLines: this.totalLines, visibleLines: Math.max(1, (this.input.tui.terminal.rows ?? 24) - 8) });
    if (action === "close") this.input.onClose();
    else if (action === "back") this.input.onBack();
    else if (action === "handled") this.input.tui.requestRender();
  }

  invalidate(): void {}
}
```

- [ ] **Step 4: Run overlay tests and typecheck via unit runner**

```bash
node --experimental-strip-types --test test/unit/watch-overlay.test.ts
```

Expected: pass. If `BashExecutionComponent` constructor signature from Task 4 requires adjustment, keep the adjustment in `transcript-renderer.ts` and rerun its test too.

- [ ] **Step 5: Commit**

```bash
git add src/watch/watch-overlay.ts test/unit/watch-overlay.test.ts
git commit -m "feat: add subagent watch overlay"
```

---

### Task 6: Implement tree selector and command registration

**Files:**
- Create: `src/watch/watch-selector.ts`
- Create: `src/watch/slash-command.ts`
- Modify: `src/extension/index.ts`
- Test: `test/integration/slash-commands.test.ts`

- [ ] **Step 1: Add failing command registration test**

Append to `test/integration/slash-commands.test.ts` inside the existing describe block or create a new describe block using the same helpers:

```ts
it("registers /subagent-watch", async () => {
  await withIsolatedHome(async () => {
    const commands = new Map<string, RegisteredSlashCommand>();
    const pi = {
      events: createEventBus(),
      registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
      registerShortcut() {},
      sendMessage(_message: unknown) {},
    };
    registerSlashCommands!(pi, createState(process.cwd()));
    assert.equal(commands.has("subagent-watch"), true);
  });
});
```

This test will fail until the command is registered. If `registerSlashCommands` remains the registration location, add it there. If `slash-command.ts` is registered from `extension/index.ts`, write a smaller unit test for `registerSubagentWatchCommand` instead and update this integration test to import that module.

- [ ] **Step 2: Implement selector component**

Create `src/watch/watch-selector.ts`:

```ts
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { WatchSection, WatchTarget, WatchTreeRow } from "./watch-types.ts";

function padToWidth(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

interface SelectableRow {
  section: string;
  row: WatchTreeRow;
  target?: WatchTarget;
}

export class WatchSelector implements Component {
  private selected = 0;
  private rows: SelectableRow[];

  constructor(private input: { tui: TUI; theme: Theme; sections: WatchSection[]; onSelect: (target: WatchTarget) => void; onClose: () => void }) {
    const byId = new Map(input.sections.flatMap((section) => section.targets.map((target) => [target.id, target] as const)));
    this.rows = input.sections.flatMap((section) => [
      { section: section.title, row: { key: `${section.title}:header`, selectable: false, depth: 0, text: section.title } },
      ...section.rows.map((row) => ({ section: section.title, row, target: row.targetId ? byId.get(row.targetId) : undefined })),
    ]);
    const first = this.rows.findIndex((entry) => entry.row.selectable);
    this.selected = first === -1 ? 0 : first;
  }

  private move(delta: 1 | -1): void {
    if (this.rows.length === 0) return;
    let next = this.selected;
    for (let i = 0; i < this.rows.length; i += 1) {
      next = (next + delta + this.rows.length) % this.rows.length;
      if (this.rows[next]?.row.selectable) break;
    }
    this.selected = next;
  }

  render(width: number): string[] {
    const { theme } = this.input;
    const inner = Math.max(1, width - 4);
    const lines = [
      theme.fg("border", "┌" + "─".repeat(width - 2) + "┐"),
      this.frame(theme.bold(theme.fg("accent", "Subagent Watch · current session only")), width),
      theme.fg("border", "├" + "─".repeat(width - 2) + "┤"),
    ];
    if (this.rows.length === 0) {
      lines.push(this.frame(theme.fg("dim", "No current-session async subagents are available."), width));
    } else {
      for (let index = 0; index < this.rows.length; index += 1) {
        const item = this.rows[index]!;
        const isHeader = !item.row.selectable && item.row.key.endsWith(":header");
        const prefix = item.row.selectable ? (index === this.selected ? theme.fg("accent", "› ") : "  ") : "";
        const indent = "  ".repeat(Math.max(0, item.row.depth));
        const raw = isHeader ? theme.bold(theme.fg("accent", item.row.text)) : `${prefix}${indent}${item.row.text}`;
        lines.push(this.frame(truncateToWidth(raw, inner, "...", true), width));
      }
    }
    lines.push(theme.fg("border", "├" + "─".repeat(width - 2) + "┤"));
    lines.push(this.frame(theme.fg("dim", "↑/↓ select · Enter open · Esc/q close"), width));
    lines.push(theme.fg("border", "└" + "─".repeat(width - 2) + "┘"));
    return lines;
  }

  private frame(content: string, width: number): string {
    const inner = Math.max(1, width - 4);
    const safe = truncateToWidth(content.replaceAll("\r", " "), inner, "...", true);
    return this.input.theme.fg("border", "│ ") + padToWidth(safe, inner) + this.input.theme.fg("border", " │");
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") { this.input.onClose(); return; }
    if (matchesKey(data, Key.up)) { this.move(-1); this.input.tui.requestRender(); return; }
    if (matchesKey(data, Key.down)) { this.move(1); this.input.tui.requestRender(); return; }
    if (matchesKey(data, Key.enter)) {
      const target = this.rows[this.selected]?.target;
      if (target) this.input.onSelect(target);
    }
  }

  invalidate(): void {}
}
```

- [ ] **Step 3: Implement slash command coordinator**

Create `src/watch/slash-command.ts`:

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildWatchSections, flattenWatchTargets } from "./watch-tree.ts";
import { WatchOverlay } from "./watch-overlay.ts";
import { WatchSelector } from "./watch-selector.ts";
import type { SubagentState } from "../shared/types.ts";
import type { WatchTarget } from "./watch-types.ts";

function resolveTarget(args: string, targets: WatchTarget[]): WatchTarget | undefined {
  const query = args.trim();
  if (!query) return undefined;
  return targets.find((target) => target.id === query || target.id.includes(query) || target.rootRunId === query || target.nestedRunId === query);
}

export function registerSubagentWatchCommand(pi: Pick<ExtensionAPI, "registerCommand">, state: SubagentState): void {
  pi.registerCommand("subagent-watch", {
    description: "Watch current-session async subagents in a read-only overlay",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/subagent-watch requires interactive UI.", "error");
        return;
      }
      const openSelector = async (): Promise<void> => {
        const sections = buildWatchSections(state);
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new WatchSelector({
          tui,
          theme,
          sections,
          onClose: () => done(undefined),
          onSelect: (target) => {
            done(undefined);
            void openOverlay(target);
          },
        }), { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } });
      };
      const openOverlay = async (target: WatchTarget): Promise<void> => {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new WatchOverlay({
          tui,
          theme,
          target,
          onClose: () => done(undefined),
          onBack: () => {
            done(undefined);
            void openSelector();
          },
        }), { overlay: true, overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" } });
      };

      const sections = buildWatchSections(state);
      const direct = resolveTarget(args, flattenWatchTargets(sections));
      if (direct) await openOverlay(direct);
      else await openSelector();
    },
  });
}
```

- [ ] **Step 4: Register from extension index**

Modify `src/extension/index.ts` imports:

```ts
import { registerSubagentWatchCommand } from "../watch/slash-command.ts";
```

Find the existing `registerSlashCommands(pi, state);` call in the extension setup and add immediately after it:

```ts
registerSubagentWatchCommand(pi, state);
```

If there is no single visible registration block, register next to the other slash/prompt bridge registration calls so command lifetime matches the current session.

- [ ] **Step 5: Run command tests**

```bash
node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/slash-commands.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/watch/watch-selector.ts src/watch/slash-command.ts src/extension/index.ts test/integration/slash-commands.test.ts
git commit -m "feat: register subagent watch command"
```

---

### Task 7: Add file watching / polling for live tailing

**Files:**
- Modify: `src/watch/watch-overlay.ts`
- Test: `test/unit/watch-overlay.test.ts`

- [ ] **Step 1: Add failing render-refresh test**

Append to `test/unit/watch-overlay.test.ts`:

```ts
import { collectWatchFiles } from "../../src/watch/watch-overlay.ts";

it("collects transcript, log, root log, and events files for refresh", () => {
  const files = collectWatchFiles({
    sessionFile: "/tmp/session.jsonl",
    outputLog: "/tmp/output-0.log",
    rootLog: "/tmp/root.md",
    eventsFile: "/tmp/events.jsonl",
  } as any);
  assert.deepEqual(files, ["/tmp/session.jsonl", "/tmp/output-0.log", "/tmp/root.md", "/tmp/events.jsonl"]);
});
```

Run the test before adding `collectWatchFiles`; it must fail because the export does not exist yet.

- [ ] **Step 2: Add watch file collection and best-effort timers**

Modify `src/watch/watch-overlay.ts`:

```ts
export function collectWatchFiles(target: Pick<WatchTarget, "sessionFile" | "outputLog" | "rootLog" | "eventsFile">): string[] {
  return [...new Set([target.sessionFile, target.outputLog, target.rootLog, target.eventsFile].filter((file): file is string => Boolean(file)))];
}
```

Inside `WatchOverlay`, add fields:

```ts
private watchers: Array<{ close: () => void }> = [];
private poller?: ReturnType<typeof setInterval>;
```

In constructor, after assigning input:

```ts
for (const file of collectWatchFiles(input.target)) {
  try {
    this.watchers.push(fs.watch(file, () => input.tui.requestRender()));
  } catch {
    // Missing files are common while a child is starting. Polling below covers them.
  }
}
this.poller = setInterval(() => input.tui.requestRender(), 1000);
```

Add cleanup method:

```ts
dispose(): void {
  for (const watcher of this.watchers) watcher.close();
  this.watchers = [];
  if (this.poller) clearInterval(this.poller);
  this.poller = undefined;
}
```

Update `onBack` and `onClose` calls in `handleInput` to call `this.dispose()` first:

```ts
if (action === "close") { this.dispose(); this.input.onClose(); }
else if (action === "back") { this.dispose(); this.input.onBack(); }
```

- [ ] **Step 3: Run overlay tests**

```bash
node --experimental-strip-types --test test/unit/watch-overlay.test.ts
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/watch/watch-overlay.ts test/unit/watch-overlay.test.ts
git commit -m "feat: tail subagent watch files"
```

---

### Task 8: Documentation and full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add README documentation**

In `README.md`, under the existing observability section near “Where running subagents show up”, add:

```md
### Watch a running subagent

Use `/subagent-watch` in interactive mode to inspect current-session async/background subagents without switching sessions. It opens a read-only tree selector grouped by Active, Queued, and Done. Select an agent instance to open a tabbed overlay:

- **Transcript** tails the child Pi session JSONL using Pi's normal message styling.
- **Status** shows run, agent, tool, session, log, and ancestry metadata.
- **Log** tails the relevant async output log when available.

Keys in the selector: `↑/↓` selects, `Enter` opens, `Esc` or `q` closes. Keys in the overlay: `Tab` / `Shift+Tab` switches tabs, `Backspace` or `b` returns to the selector, `PgUp/PgDn` page-scrolls, `Shift+↑/Shift+↓` scrolls by line, and `Esc` or `q` closes.

The watch view is scoped to the current Pi session. It does not scan unrelated sessions or open child JSONL files as writable sessions.
```

- [ ] **Step 2: Run focused unit tests**

```bash
node --experimental-strip-types --test test/unit/watch-tree.test.ts test/unit/transcript-reader.test.ts test/unit/transcript-renderer.test.ts test/unit/watch-scroll.test.ts test/unit/watch-overlay.test.ts
```

Expected: pass.

- [ ] **Step 3: Run slash integration test**

```bash
node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/slash-commands.test.ts
```

Expected: pass.

- [ ] **Step 4: Run full unit suite**

```bash
npm run test:unit
```

Expected: pass.

- [ ] **Step 5: Run full integration suite**

```bash
npm run test:integration
```

Expected: pass. If integration tests fail due to local Pi package availability, capture the exact failure and rerun the focused integration command from Step 3 as minimum evidence.

- [ ] **Step 6: Commit docs and any final fixes**

```bash
git add README.md src/watch test/unit test/integration src/extension/index.ts
git commit -m "docs: document subagent watch overlay"
```

- [ ] **Step 7: Final verification summary**

Run:

```bash
git status --short
```

Expected: clean working tree. Summarize the tests run and any skipped/unavailable tests.

---

## Self-Review Notes

- Spec coverage: this plan covers current-session scoping, tree selector, nested ancestry, transcript/status/log tabs, Pi component reuse, live tailing, bulletin-board scrolling, command registration, docs, and tests.
- Red-flag scan: no task uses open-ended “handle later” language, and every test step includes concrete code or a concrete command.
- Type consistency: `WatchTarget`, `WatchSection`, `WatchTreeRow`, `WatchOverlayState`, and tab/status names are defined once and reused consistently across tasks.
