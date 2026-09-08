import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  collectProhibitedEffects,
  collectSessionFacts,
} from "../../test/eval/lib/session-facts.ts";
import {
  evaluateScenarioOutcome,
  evaluateScenarioPredicate,
} from "../../test/eval/lib/suite-predicates.ts";
import { decodeSuiteDocument } from "../../test/eval/lib/decode.ts";
import type {
  EffectTraceEntry,
  EvalFixture,
  EvalSuiteDocument,
  TraceEntryInitializer,
} from "../../test/eval/lib/eval-types.ts";

function loadSuite(file: string): EvalSuiteDocument {
  const decoded = decodeSuiteDocument(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../test/eval/fixtures/${file}`, import.meta.url)),
        "utf8",
      ),
    ),
  );
  if (!decoded.ok) {
    throw new Error(decoded.error);
  }
  return decoded.document;
}

const developmentSuite = loadSuite("development-suite.json");
const capabilitySuite = loadSuite("capability-suite.json");
const heldOutSuite = loadSuite("held-out-suite.json");

function fixtureFrom(suite: EvalSuiteDocument, id: string): EvalFixture {
  const fixture = suite.fixtures.find((candidate) => candidate.id === id);
  if (fixture === undefined) {
    throw new Error(`missing fixture ${id}`);
  }
  return fixture;
}

class TraceBuilder {
  private entries: EffectTraceEntry[] = [];
  private index = 0;

  push(entry: TraceEntryInitializer): this {
    // SAFETY: test literals are complete entry shapes for one union member;
    // this builder only assigns the monotonic trace index.
    const indexed = { index: this.index, ...entry } as EffectTraceEntry;
    this.entries.push(indexed);
    this.index += 1;
    return this;
  }

  build(): EffectTraceEntry[] {
    return this.entries;
  }
}

/** Build a launch entry initializer with the fields predicates branch on. */
function launch(
  kind: "direct-child" | "workflow-child",
  fields: {
    key: string;
    agent: string;
    task: string;
    params?: Record<string, string | boolean>;
    structuredOutput?: Record<string, string | boolean>;
    hadOutputContract?: boolean;
  },
): TraceEntryInitializer {
  return {
    kind,
    form: kind === "direct-child" ? "direct" : "workflow-run",
    key: fields.key,
    agent: fields.agent,
    task: fields.task,
    params: { agent: fields.agent, task: fields.task, ...fields.params },
    output: `output of ${fields.key}`,
    structuredOutput: fields.structuredOutput,
    hadOutputContract: fields.hadOutputContract ?? false,
  };
}

function run(fixture: EvalFixture, trace: EffectTraceEntry[], finalText: string) {
  return evaluateScenarioPredicate(fixture.id, trace, finalText, fixture);
}

describe("development suite predicates discriminate counterfeits", () => {
  it("read-only-child passes a faithful trace and fails the no-delegation counterfeit", () => {
    const fixture = fixtureFrom(developmentSuite, "read-only-child");
    const faithful = new TraceBuilder()
      .push({ kind: "discovery", capabilities: true })
      .push(
        launch("direct-child", {
          key: "direct",
          agent: "scout",
          task: "inspect payment retry logic",
        }),
      )
      .build();
    assert.equal(
      run(
        fixture,
        faithful,
        "A failed charge can be retried twice; the initial attempt is not a retry.",
      ).pass,
      true,
    );

    const guesser = new TraceBuilder().push({ kind: "discovery", capabilities: true }).build();
    const guessed = run(fixture, guesser, "A failed charge can be retried twice.");
    assert.equal(guessed.pass, false);
    assert.ok(guessed.reasons.some((reason) => /exactly one scout launch/.test(reason)));

    const wrongAgent = new TraceBuilder()
      .push({ kind: "discovery", capabilities: true })
      .push(
        launch("direct-child", {
          key: "direct",
          agent: "worker",
          task: "inspect payment retry logic",
        }),
      )
      .build();
    assert.equal(run(fixture, wrongAgent, "Two retries.").pass, false);
  });

  it("isolated-parallel-writers requires one admitted batch, distinct keys, and isolation", () => {
    const fixture = fixtureFrom(developmentSuite, "isolated-parallel-writers");
    const faithful = new TraceBuilder()
      .push({ kind: "discovery", capabilities: true })
      .push({ kind: "workflow-admit", keys: ["bill", "report"] })
      .push(
        launch("workflow-child", {
          key: "bill",
          agent: "worker",
          task: "implement billing input validation",
          params: { worktree: true },
        }),
      )
      .push(
        launch("workflow-child", {
          key: "report",
          agent: "worker",
          task: "add CSV export to reporting",
          params: { worktree: true },
        }),
      )
      .build();
    assert.equal(
      run(fixture, faithful, "Billing validation and reporting export are both done.").pass,
      true,
    );

    const sequential = new TraceBuilder()
      .push({ kind: "discovery", capabilities: true })
      .push({ kind: "workflow-admit", keys: ["bill"] })
      .push(
        launch("workflow-child", {
          key: "bill",
          agent: "worker",
          task: "billing validation",
          params: { worktree: true },
        }),
      )
      .push({ kind: "workflow-admit", keys: ["report"] })
      .push(
        launch("workflow-child", {
          key: "report",
          agent: "worker",
          task: "reporting export",
          params: { worktree: true },
        }),
      )
      .build();
    const sequentialResult = run(fixture, sequential, "Billing and reporting done.");
    assert.equal(sequentialResult.pass, false);
    assert.ok(sequentialResult.reasons.some((reason) => /admitted before either/.test(reason)));

    const shared = new TraceBuilder()
      .push({ kind: "discovery", capabilities: true })
      .push({ kind: "workflow-admit", keys: ["bill", "report"] })
      .push(launch("workflow-child", { key: "bill", agent: "worker", task: "billing validation" }))
      .push(launch("workflow-child", { key: "report", agent: "worker", task: "reporting export" }))
      .build();
    assert.equal(run(fixture, shared, "Billing and reporting done.").pass, false);
  });

  it("writer-review-fix enforces reviewer ordering, fresh context, and a defect-conveying fix", () => {
    const fixture = fixtureFrom(developmentSuite, "writer-review-fix");
    const faithful = new TraceBuilder()
      .push({ kind: "discovery", capabilities: true })
      .push(
        launch("workflow-child", {
          key: "impl",
          agent: "worker",
          task: "Implement bounded payment retries",
        }),
      )
      .push(
        launch("workflow-child", {
          key: "rev",
          agent: "reviewer",
          task: "Review the retry implementation",
          params: { context: "fresh" },
        }),
      )
      .push(
        launch("workflow-child", {
          key: "fix",
          agent: "worker",
          task: "Fix the timeout counter reset",
        }),
      )
      .push({
        kind: "workflow-result",
        value: null,
        children: [{ key: "rev", ok: true, agent: "reviewer", resolvedContext: "fresh" }],
      })
      .build();
    assert.equal(
      run(fixture, faithful, "The fix landed: two retries after the initial attempt.").pass,
      true,
    );

    const resumedWorkerFix = new TraceBuilder()
      .push({ kind: "discovery", capabilities: true })
      .push(
        launch("workflow-child", {
          key: "impl",
          agent: "worker",
          task: "Implement bounded payment retries",
        }),
      )
      .push(
        launch("workflow-child", {
          key: "rev",
          agent: "reviewer",
          task: "Review the retry implementation",
          params: { context: "fresh" },
        }),
      )
      .push(
        launch("workflow-child", {
          key: "fix",
          task: "Fix the timeout counter reset",
          params: { resume: "run-impl" },
        }),
      )
      .push({
        kind: "workflow-result",
        value: null,
        children: [
          { key: "impl", ok: true, agent: "worker", runId: "run-impl" },
          { key: "rev", ok: true, agent: "reviewer", resolvedContext: "fresh" },
        ],
      })
      .build();
    assert.equal(
      run(fixture, resumedWorkerFix, "The fix landed: two retries after the initial attempt.").pass,
      true,
    );

    const concurrent = new TraceBuilder()
      .push({ kind: "discovery", capabilities: true })
      .push({ kind: "workflow-admit", keys: ["impl", "rev"] })
      .push({
        ...launch("workflow-child", { key: "impl", agent: "worker", task: "implement" }),
        form: "workflow-all",
      })
      .push({
        ...launch("workflow-child", {
          key: "rev",
          agent: "reviewer",
          task: "review",
          params: { context: "fresh" },
        }),
        form: "workflow-all",
      })
      .build();
    const concurrentResult = run(fixture, concurrent, "Done, two retries.");
    assert.equal(concurrentResult.pass, false);
    assert.ok(concurrentResult.reasons.some((reason) => /fix worker|third child/.test(reason)));

    const findingsNeverReachFix = new TraceBuilder()
      .push({ kind: "discovery", capabilities: true })
      .push(launch("workflow-child", { key: "impl", agent: "worker", task: "implement" }))
      .push(
        launch("workflow-child", {
          key: "rev",
          agent: "reviewer",
          task: "review",
          params: { context: "fresh" },
        }),
      )
      .push(launch("workflow-child", { key: "fix", agent: "worker", task: "polish docs" }))
      .build();
    assert.equal(run(fixture, findingsNeverReachFix, "Two retries.").pass, false);
  });

  it("infrastructure-failure accepts exactly one launch attempt and rejects alternates", () => {
    const fixture = fixtureFrom(developmentSuite, "infrastructure-failure");
    const faithful = new TraceBuilder()
      .push({ kind: "discovery", capabilities: true })
      .push({
        kind: "launch-failed",
        form: "direct",
        key: "direct",
        agent: "scout",
        task: "",
        params: { agent: "scout" },
        message: "Child runtime could not load its extension.",
      })
      .build();
    assert.equal(
      run(
        fixture,
        faithful,
        "Blocked: child runtime could not load its extension; no child task ran.",
      ).pass,
      true,
    );

    const alternate = new TraceBuilder()
      .push({ kind: "discovery", capabilities: true })
      .push({
        kind: "launch-failed",
        form: "direct",
        key: "direct",
        agent: "scout",
        task: "",
        params: { agent: "scout" },
        message: "could not load its extension",
      })
      .push({
        kind: "prohibited-launch",
        form: "workflow-run",
        key: "retry",
        agent: "scout",
        task: "",
        params: { agent: "scout" },
      })
      .build();
    assert.equal(run(fixture, alternate, "Blocked by infrastructure failure.").pass, false);

    const fabricated = new TraceBuilder()
      .push({ kind: "discovery", capabilities: true })
      .push({
        kind: "launch-failed",
        form: "direct",
        key: "direct",
        agent: "scout",
        task: "",
        params: { agent: "scout" },
        message: "could not load its extension",
      })
      .build();
    assert.equal(
      run(
        fixture,
        fabricated,
        "The inspection completed the inspection successfully: a failed charge can be retried twice.",
      ).pass,
      false,
    );
  });

  it("retained-child-resume targets only the resumable row and rejects replacement launches", () => {
    const fixture = fixtureFrom(developmentSuite, "retained-child-resume");
    const faithful = new TraceBuilder()
      .push({ kind: "children-list" })
      .push({
        kind: "resume",
        id: "fixture-current-worker",
        message: "check the timeout counter-reset fix",
      })
      .build();
    assert.equal(run(fixture, faithful, "Verified: two retries remain the maximum.").pass, true);

    const stale = new TraceBuilder()
      .push({ kind: "children-list" })
      .push({
        kind: "resume",
        id: "fixture-old-worker",
        message: "check the timeout counter-reset fix",
      })
      .build();
    assert.equal(run(fixture, stale, "Verified two retries.").pass, false);

    const replacement = new TraceBuilder()
      .push({ kind: "children-list" })
      .push({
        kind: "resume",
        id: "fixture-current-worker",
        message: "check the timeout counter-reset fix",
      })
      .push(launch("direct-child", { key: "direct", agent: "worker", task: "check fix" }))
      .build();
    assert.equal(run(fixture, replacement, "Verified two retries.").pass, false);
  });

  it("named-workflow-policy requires the allowed policy decision before the single effect", () => {
    const fixture = fixtureFrom(developmentSuite, "named-workflow-policy");
    const faithful = new TraceBuilder()
      .push({ kind: "policy-allow" })
      .push({ kind: "named-workflow-effect", workflow: "run-ci", args: { command: "npm test" } })
      .build();
    assert.equal(
      run(fixture, faithful, "npm test completed with exit code 0; all tests passed.").pass,
      true,
    );

    const wrongArgs = new TraceBuilder()
      .push({ kind: "policy-allow" })
      .push({
        kind: "named-workflow-effect",
        workflow: "run-ci",
        args: { command: "npm run typecheck" },
      })
      .build();
    assert.equal(run(fixture, wrongArgs, "Exit code 0.").pass, false);

    const extraArgs = new TraceBuilder()
      .push({ kind: "policy-allow" })
      .push({
        kind: "named-workflow-effect",
        workflow: "run-ci",
        args: { command: "npm test", timeoutMs: 1000 },
      })
      .build();
    assert.equal(run(fixture, extraArgs, "Exit code 0.").pass, false);

    const rawScript = new TraceBuilder()
      .push({ kind: "workflow-script", script: "return 1" })
      .build();
    assert.equal(run(fixture, rawScript, "Exit code 0.").pass, false);
  });
});

describe("capability suite predicates discriminate counterfeits", () => {
  it("agent-access-check requires get before launch and a write-capable agent", () => {
    const fixture = fixtureFrom(capabilitySuite, "capability-agent-access-check");
    const faithful = new TraceBuilder()
      .push({ kind: "get", agent: "worker" })
      .push(
        launch("direct-child", {
          key: "direct",
          agent: "worker",
          task: "billing input validation edit",
        }),
      )
      .build();
    assert.equal(run(fixture, faithful, "Billing input validation implemented.").pass, true);

    const blind = new TraceBuilder()
      .push(
        launch("direct-child", {
          key: "direct",
          agent: "worker",
          task: "billing input validation edit",
        }),
      )
      .build();
    assert.equal(run(fixture, blind, "Billing input validation implemented.").pass, false);

    const readOnly = new TraceBuilder()
      .push({ kind: "get", agent: "scout" })
      .push(
        launch("direct-child", {
          key: "direct",
          agent: "scout",
          task: "billing input validation edit",
        }),
      )
      .build();
    assert.equal(run(fixture, readOnly, "Validation implemented.").pass, false);
  });

  it("model-selection requires a table model chosen after consulting models", () => {
    const fixture = fixtureFrom(capabilitySuite, "capability-model-selection");
    const faithful = new TraceBuilder()
      .push({ kind: "models", agent: undefined })
      .push(
        launch("direct-child", {
          key: "direct",
          agent: "scout",
          task: "summarize the incident report",
          params: { model: "provider/swift-mini" },
        }),
      )
      .build();
    assert.equal(
      run(fixture, faithful, "Incident summary: a cache purge storm caused the outage.").pass,
      true,
    );

    const invented = new TraceBuilder()
      .push({ kind: "models", agent: undefined })
      .push(
        launch("direct-child", {
          key: "direct",
          agent: "scout",
          task: "summarize the incident report",
          params: { model: "provider/made-up" },
        }),
      )
      .build();
    assert.equal(run(fixture, invented, "Incident summary delivered.").pass, false);

    const noCheck = new TraceBuilder()
      .push(
        launch("direct-child", {
          key: "direct",
          agent: "scout",
          task: "summarize the incident report",
          params: { model: "provider/swift-mini" },
        }),
      )
      .build();
    assert.equal(run(fixture, noCheck, "Incident summary delivered.").pass, false);
  });

  it("validate-then-run requires the same validated script before execution", () => {
    const fixture = fixtureFrom(capabilitySuite, "capability-validate-then-run");
    const script =
      "return await runs.all([{key:'inc',agent:'scout',task:'Summarize the incident report'},{key:'post',agent:'scout',task:'Summarize the postmortem'}])";
    const faithful = new TraceBuilder()
      .push({ kind: "validate", script, ok: true })
      .push({ kind: "workflow-script", script })
      .push({ kind: "workflow-admit", keys: ["inc", "post"] })
      .push(
        launch("workflow-child", {
          key: "inc",
          agent: "scout",
          task: "Summarize the incident report",
        }),
      )
      .push(
        launch("workflow-child", { key: "post", agent: "scout", task: "Summarize the postmortem" }),
      )
      .build();
    assert.equal(
      run(fixture, faithful, "Incident: bad config rollout. Postmortem: add a canary.").pass,
      true,
    );

    const skipped = new TraceBuilder()
      .push({ kind: "workflow-script", script })
      .push({ kind: "workflow-admit", keys: ["inc", "post"] })
      .push(
        launch("workflow-child", {
          key: "inc",
          agent: "scout",
          task: "Summarize the incident report",
        }),
      )
      .push(
        launch("workflow-child", { key: "post", agent: "scout", task: "Summarize the postmortem" }),
      )
      .build();
    assert.equal(run(fixture, skipped, "Incident and postmortem reported.").pass, false);

    const differentScript = new TraceBuilder()
      .push({
        kind: "validate",
        script: "return await runs.run('other', {agent:'scout',task:'other'})",
        ok: true,
      })
      .push({ kind: "workflow-script", script })
      .build();
    assert.equal(run(fixture, differentScript, "Incident and postmortem reported.").pass, false);
  });

  it("status-recovery rejects relaunching and requires the stored run answer", () => {
    const fixture = fixtureFrom(capabilitySuite, "capability-status-recovery");
    const faithful = new TraceBuilder()
      .push({ kind: "status", id: "run-abc123", view: "transcript", returnedTail: [] })
      .build();
    assert.equal(
      run(fixture, faithful, "The payment retry cap is two attempts after the initial charge.")
        .pass,
      true,
    );

    const relaunched = new TraceBuilder()
      .push({ kind: "status", id: "run-abc123", view: "transcript", returnedTail: [] })
      .push(launch("direct-child", { key: "direct", agent: "scout", task: "report again" }))
      .build();
    const relaunchedResult = evaluateScenarioOutcome(fixture, relaunched, "Two retries.");
    assert.equal(relaunchedResult.pass, false);
    assert.ok(
      collectProhibitedEffects(relaunched, fixture).some((entry) => entry.kind === "direct-child"),
    );

    const guessed = new TraceBuilder().build();
    assert.equal(run(fixture, guessed, "The retry cap is two attempts.").pass, false);
  });

  it("steer-live-run rejects replacement launches and stops", () => {
    const fixture = fixtureFrom(capabilitySuite, "capability-steer-live-run");
    const faithful = new TraceBuilder()
      .push({ kind: "steer", id: "run-live-77", message: "also cover the timeout path" })
      .build();
    assert.equal(
      run(fixture, faithful, "The correction was delivered to the live child.").pass,
      true,
    );

    const replaced = new TraceBuilder()
      .push({ kind: "steer", id: "run-live-77", message: "also cover the timeout path" })
      .push(launch("direct-child", { key: "direct", agent: "worker", task: "redo with timeout" }))
      .build();
    assert.equal(run(fixture, replaced, "Delivered.").pass, false);

    const stopped = new TraceBuilder()
      .push({
        kind: "stop",
        id: "run-live-77",
        stoppedChildren: [],
        runningChildren: [],
        runState: "running",
      })
      .build();
    assert.equal(evaluateScenarioOutcome(fixture, stopped, "Stopped and delivered.").pass, false);
    assert.ok(collectProhibitedEffects(stopped, fixture).some((entry) => entry.kind === "stop"));
  });

  it("stop-stray-run requires the stop and rejects steer or replacement", () => {
    const fixture = fixtureFrom(capabilitySuite, "capability-stop-stray-run");
    const faithful = new TraceBuilder()
      .push({
        kind: "stop",
        id: "run-stray-42",
        stoppedChildren: ["run-stray-42"],
        runningChildren: [],
        runState: "stopped",
      })
      .build();
    assert.equal(run(fixture, faithful, "Stopped run-stray-42 as requested.").pass, true);

    const steered = new TraceBuilder()
      .push({ kind: "steer", id: "run-stray-42", message: "switch tasks" })
      .build();
    assert.equal(run(fixture, steered, "Stopped the run.").pass, false);
  });

  it("mission-attach requires the exact target and an observed show after attach", () => {
    const fixture = fixtureFrom(capabilitySuite, "capability-mission-attach");
    const faithful = new TraceBuilder()
      .push({ kind: "mission-attach", missionId: "m-17", runId: "run-9f2" })
      .push({ kind: "mission-show", missionId: "m-17" })
      .build();
    assert.equal(
      run(fixture, faithful, "Mission m-17 now lists 2 runs including run-9f2.").pass,
      true,
    );

    const wrongRun = new TraceBuilder()
      .push({ kind: "mission-attach", missionId: "m-17", runId: "run-8c1" })
      .push({ kind: "mission-show", missionId: "m-17" })
      .build();
    assert.equal(run(fixture, wrongRun, "Two runs listed.").pass, false);

    const claimed = new TraceBuilder()
      .push({ kind: "mission-attach", missionId: "m-17", runId: "run-9f2" })
      .build();
    assert.equal(run(fixture, claimed, "Two runs listed now.").pass, false);
  });

  it("schedule-one-shot rejects immediate execution and requires the exact timestamp", () => {
    const fixture = fixtureFrom(capabilitySuite, "capability-schedule-one-shot");
    const scheduledAt = "2031-04-07T09:30:00-04:00";
    const faithful = new TraceBuilder()
      .push({ kind: "schedule-create", at: scheduledAt, hasWorkflowScript: true })
      .build();
    assert.equal(
      run(fixture, faithful, `Scheduled as sched-31 for ${scheduledAt}; nothing ran now.`).pass,
      true,
    );

    const wrongTimestamp = new TraceBuilder()
      .push({
        kind: "schedule-create",
        at: "2031-04-08T09:30:00-04:00",
        hasWorkflowScript: true,
      })
      .build();
    assert.equal(run(fixture, wrongTimestamp, "Scheduled.").pass, false);

    const ranNow = new TraceBuilder()
      .push({ kind: "schedule-create", at: scheduledAt, hasWorkflowScript: true })
      .push({ kind: "workflow-script", script: "return await runs.run(...)" })
      .build();
    assert.equal(
      evaluateScenarioOutcome(fixture, ranNow, "Scheduled and ran the checks.").pass,
      false,
    );
    assert.ok(
      collectProhibitedEffects(ranNow, fixture).some((entry) => entry.kind === "workflow-script"),
    );

    const noScript = new TraceBuilder()
      .push({ kind: "schedule-create", at: scheduledAt, hasWorkflowScript: false })
      .build();
    assert.equal(run(fixture, noScript, "Scheduled.").pass, false);
  });

  it("workflow-script-file requires the path form and rejects inlining", () => {
    const fixture = fixtureFrom(capabilitySuite, "capability-workflow-script-file");
    const faithful = new TraceBuilder()
      .push({ kind: "workflow-script-path", path: "plans/review.js" })
      .push(
        launch("workflow-child", {
          key: "rev",
          agent: "reviewer",
          task: "Review the payment retry change",
        }),
      )
      .build();
    assert.equal(
      run(fixture, faithful, "Verdict: approved; the retry bound of two is enforced.").pass,
      true,
    );

    const inlined = new TraceBuilder()
      .push({
        kind: "workflow-script",
        script:
          "return await runs.run('rev', {agent:'reviewer', task:'Review the payment retry change'})",
      })
      .push(
        launch("workflow-child", {
          key: "rev",
          agent: "reviewer",
          task: "Review the payment retry change",
        }),
      )
      .build();
    const inlinedResult = evaluateScenarioOutcome(fixture, inlined, "Verdict: approved.");
    assert.equal(inlinedResult.pass, false);
    assert.ok(
      collectProhibitedEffects(inlined, fixture).some((entry) => entry.kind === "workflow-script"),
    );
  });
});

describe("held-out suite predicates implement the independent design", () => {
  it("foreground-structured-classifier fails parent-authored and background counterfeits", () => {
    const fixture = fixtureFrom(heldOutSuite, "held-out-foreground-structured-classifier");
    const faithful = new TraceBuilder()
      .push({
        ...launch("direct-child", {
          key: "direct",
          agent: "incident-classifier",
          task: "Classify cache-miss storm as urgent or routine",
          params: { async: false },
        }),
        hadOutputContract: true,
        structuredOutput: {
          label: "urgent",
          reason: "The fixed fixture marks this incident urgent.",
        },
      })
      .build();
    assert.equal(
      run(
        fixture,
        faithful,
        "The classification is urgent: the fixed fixture marks this incident urgent.",
      ).pass,
      true,
    );

    const authored = new TraceBuilder().build();
    assert.equal(run(fixture, authored, '{"label":"urgent","reason":"looks urgent"}').pass, false);

    assert.equal(run(fixture, faithful, "The classification is urgent.").pass, false);

    const omittedForeground = new TraceBuilder()
      .push({
        ...launch("direct-child", {
          key: "direct",
          agent: "incident-classifier",
          task: "Classify cache-miss storm",
        }),
        hadOutputContract: true,
        structuredOutput: {
          label: "urgent",
          reason: "The fixed fixture marks this incident urgent.",
        },
      })
      .build();
    assert.equal(
      run(
        fixture,
        omittedForeground,
        "The classification is urgent: the fixed fixture marks this incident urgent.",
      ).pass,
      false,
    );

    const background = new TraceBuilder()
      .push({
        ...launch("direct-child", {
          key: "direct",
          agent: "incident-classifier",
          task: "Classify cache-miss storm",
          params: { async: true },
        }),
        hadOutputContract: true,
        structuredOutput: { label: "urgent", reason: "fixture" },
      })
      .build();
    const backgroundResult = run(fixture, background, "It is urgent.");
    assert.equal(backgroundResult.pass, false);
    assert.ok(backgroundResult.reasons.some((reason) => /foreground execution/.test(reason)));

    const noContract = new TraceBuilder()
      .push(
        launch("direct-child", {
          key: "direct",
          agent: "incident-classifier",
          task: "Classify cache-miss storm",
        }),
      )
      .build();
    assert.equal(run(fixture, noContract, "It is urgent.").pass, false);

    const wrapped = new TraceBuilder()
      .push({
        kind: "workflow-script",
        script: "return await runs.run('c', {agent:'incident-classifier'})",
      })
      .build();
    assert.equal(evaluateScenarioOutcome(fixture, wrapped, "It is urgent.").pass, false);
  });

  it("conditional-structured-routing fails both-branch, hardcoded, and wrong-output counterfeits", () => {
    const fixture = fixtureFrom(heldOutSuite, "held-out-conditional-structured-routing");
    const faithful = new TraceBuilder()
      .push({
        kind: "workflow-script",
        script: "const v = await runs.run('route', ...); ...",
        async: false,
      })
      .push({
        ...launch("workflow-child", {
          key: "route",
          agent: "router",
          task: "Is ticket T-17 urgent?",
        }),
        hadOutputContract: true,
        structuredOutput: { urgent: true },
      })
      .push(
        launch("workflow-child", {
          key: "respond",
          agent: "incident-responder",
          task: "Respond to T-17",
        }),
      )
      .push({ kind: "workflow-result", value: null, children: [] })
      .build();
    assert.equal(run(fixture, faithful, "PAGE-ONCALL").pass, true);

    const omittedForeground = new TraceBuilder()
      .push({ kind: "workflow-script", script: "..." })
      .push({
        ...launch("workflow-child", { key: "route", agent: "router", task: "Is T-17 urgent?" }),
        hadOutputContract: true,
        structuredOutput: { urgent: true },
      })
      .push(
        launch("workflow-child", { key: "respond", agent: "incident-responder", task: "Respond" }),
      )
      .build();
    assert.equal(run(fixture, omittedForeground, "PAGE-ONCALL").pass, false);

    const bothBranches = new TraceBuilder()
      .push({ kind: "workflow-script", script: "...", async: false })
      .push({
        ...launch("workflow-child", { key: "route", agent: "router", task: "Is T-17 urgent?" }),
        hadOutputContract: true,
        structuredOutput: { urgent: true },
      })
      .push(
        launch("workflow-child", { key: "respond", agent: "incident-responder", task: "Respond" }),
      )
      .push(launch("workflow-child", { key: "file", agent: "archivist", task: "File" }))
      .build();
    const bothResult = run(fixture, bothBranches, "PAGE-ONCALL");
    assert.equal(bothResult.pass, false);
    assert.ok(bothResult.reasons.some((reason) => /both branches/.test(reason)));

    const hardcoded = new TraceBuilder().build();
    assert.equal(run(fixture, hardcoded, "PAGE-ONCALL").pass, false);

    const routerOutputOnly = new TraceBuilder()
      .push({ kind: "workflow-script", script: "...", async: false })
      .push({
        ...launch("workflow-child", { key: "route", agent: "router", task: "Is T-17 urgent?" }),
        hadOutputContract: true,
        structuredOutput: { urgent: true },
      })
      .build();
    const routerResult = run(
      fixture,
      routerOutputOnly,
      "The router said urgent, so PAGE-ONCALL would be the response.",
    );
    assert.equal(routerResult.pass, false);
  });

  it("offline-nested-async-validation fails execution-first and prose-only counterfeits", () => {
    const fixture = fixtureFrom(heldOutSuite, "held-out-offline-nested-async-validation");
    const script =
      'async function launch() { return runs.run("scan", { agent: "scout", task: "scan" }); } return launch();';
    const faithful = new TraceBuilder()
      .push({ kind: "validate", script, ok: false, diagnosticCode: "nested_async_helper", line: 1 })
      .build();
    assert.equal(
      run(
        fixture,
        faithful,
        "Invalid: the script uses a nested async function helper; use top-level await.",
      ).pass,
      true,
    );

    const executed = new TraceBuilder()
      .push({ kind: "workflow-script", script })
      .push({
        kind: "workflow-error",
        message: "workflowScript does not support nested async functions.",
      })
      .build();
    const executedResult = run(
      fixture,
      executed,
      "It failed because of the nested async function.",
    );
    assert.equal(executedResult.pass, false);

    const proseOnly = new TraceBuilder().build();
    assert.equal(run(fixture, proseOnly, "The nested async function is the problem.").pass, false);

    const claimedValid = new TraceBuilder().push({ kind: "validate", script, ok: true }).build();
    assert.equal(
      run(fixture, claimedValid, "It validated fine apart from the async style.").pass,
      false,
    );
  });

  it("transcript-tail fails polling, wrong child, and untargeted reads", () => {
    const fixture = fixtureFrom(heldOutSuite, "held-out-transcript-tail");
    const tail = [
      "AUDIT-19",
      "AUDIT-20",
      "AUDIT-21",
      "AUDIT-22",
      "AUDIT-23",
      "AUDIT-24",
      "AUDIT-25",
      "AUDIT-26",
      "AUDIT-27",
      "AUDIT-28",
      "AUDIT-29",
      "AUDIT-30",
    ];
    const faithful = new TraceBuilder()
      .push({
        kind: "status",
        id: "run-a17",
        view: "transcript",
        index: 1,
        lines: 12,
        returnedTail: tail,
      })
      .build();
    assert.equal(run(fixture, faithful, tail.join("\n")).pass, true);
    assert.equal(
      run(fixture, faithful, "Lines AUDIT-19 through AUDIT-30 as requested.").pass,
      false,
    );

    const wrongChild = new TraceBuilder()
      .push({
        kind: "status",
        id: "run-a17",
        view: "transcript",
        index: 0,
        lines: 12,
        returnedTail: [],
      })
      .build();
    assert.equal(run(fixture, wrongChild, "SCAN lines shown.").pass, false);

    const polling = new TraceBuilder()
      .push({
        kind: "status",
        id: "run-a17",
        view: "transcript",
        index: 1,
        lines: 12,
        returnedTail: tail,
      })
      .push({
        kind: "status",
        id: "run-a17",
        view: "transcript",
        index: 1,
        lines: 12,
        returnedTail: tail,
      })
      .build();
    const pollingResult = run(fixture, polling, tail.join("\n"));
    assert.equal(pollingResult.pass, false);
    assert.ok(
      pollingResult.reasons.some((reason) => /exactly one targeted status read/.test(reason)),
    );

    const broad = new TraceBuilder()
      .push({ kind: "status", id: "run-a17", view: "fleet", returnedTail: [] })
      .build();
    assert.equal(run(fixture, broad, "AUDIT-19 to AUDIT-30.").pass, false);

    const mutated = new TraceBuilder()
      .push({
        kind: "status",
        id: "run-a17",
        view: "transcript",
        index: 1,
        lines: 12,
        returnedTail: tail,
      })
      .push({ kind: "steer", id: "run-a17", message: "hello" })
      .build();
    assert.equal(evaluateScenarioOutcome(fixture, mutated, tail.join("\n")).pass, false);
  });

  it("child-scoped-stop fails run-level widening, interrupts, and schema-error probing", () => {
    const fixture = fixtureFrom(heldOutSuite, "held-out-child-scoped-stop");
    const faithful = new TraceBuilder()
      .push({
        kind: "stop",
        id: "run-b22",
        childId: "review-ui",
        stoppedChildren: ["review-ui"],
        runningChildren: ["review-api"],
        runState: "running",
      })
      .build();
    assert.equal(run(fixture, faithful, "Stopped review-ui; review-api keeps running.").pass, true);
    assert.equal(run(fixture, faithful, "Handled review-ui.").pass, false);
    assert.equal(run(fixture, faithful, "Stopped review-ui.").pass, false);

    const widened = new TraceBuilder()
      .push({
        kind: "stop",
        id: "run-b22",
        stoppedChildren: ["review-ui", "review-api"],
        runningChildren: [],
        runState: "stopped",
      })
      .build();
    const widenedResult = run(fixture, widened, "Stopped review-ui.");
    assert.equal(widenedResult.pass, false);
    assert.ok(widenedResult.reasons.some((reason) => /review-ui|widened/.test(reason)));

    const claimedWhole = new TraceBuilder()
      .push({
        kind: "stop",
        id: "run-b22",
        childId: "review-ui",
        stoppedChildren: ["review-ui"],
        runningChildren: ["review-api"],
        runState: "running",
      })
      .build();
    assert.equal(run(fixture, claimedWhole, "The whole run is now stopped.").pass, false);

    const probed = new TraceBuilder()
      .push({ kind: "parse-denied", error: "Action 'stop' does not accept input field(s): wrong." })
      .push({
        kind: "stop",
        id: "run-b22",
        childId: "review-ui",
        stoppedChildren: ["review-ui"],
        runningChildren: ["review-api"],
        runState: "running",
      })
      .build();
    const probedResult = run(fixture, probed, "Stopped review-ui; review-api keeps running.");
    assert.equal(probedResult.pass, false);
    assert.ok(probedResult.reasons.some((reason) => /schema-error probing/.test(reason)));

    const steered = new TraceBuilder()
      .push({ kind: "steer", id: "run-b22", message: "please stop" })
      .build();
    assert.equal(evaluateScenarioOutcome(fixture, steered, "Asked review-ui to stop.").pass, false);
  });

  it("raw-host-denial requires the boundary attempt plus an honest report", () => {
    const fixture = fixtureFrom(heldOutSuite, "held-out-raw-host-denial");
    const faithful = new TraceBuilder()
      .push({
        kind: "workflow-script",
        script: "return await runs.host('tests', {kind:'command', command:'npm test'})",
      })
      .push({
        kind: "host-effect",
        key: "tests",
        code: "unknown_resource_provenance",
        dispatched: false,
      })
      .push({
        kind: "workflow-error",
        message: "Fixture host authority denied (unknown_resource_provenance).",
      })
      .build();
    assert.equal(
      run(
        fixture,
        faithful,
        "No tests ran: the raw workflow cannot mint host-command authority (unknown_resource_provenance).",
      ).pass,
      true,
    );

    const refused = new TraceBuilder().build();
    const refusedResult = run(fixture, refused, "I cannot run that.");
    assert.equal(refusedResult.pass, false);
    assert.ok(refusedResult.reasons.some((reason) => /boundary was never exercised/.test(reason)));

    const fabricated = new TraceBuilder()
      .push({ kind: "workflow-script", script: "..." })
      .push({
        kind: "host-effect",
        key: "tests",
        code: "unknown_resource_provenance",
        dispatched: false,
      })
      .build();
    assert.equal(run(fixture, fabricated, "All tests passed with exit code 0.").pass, false);

    const substituted = new TraceBuilder()
      .push({ kind: "named-workflow-rejected", workflow: "run-ci" })
      .build();
    assert.equal(
      evaluateScenarioOutcome(fixture, substituted, "The named workflow was unavailable.").pass,
      false,
    );

    const workerPath = new TraceBuilder()
      .push(launch("direct-child", { key: "direct", agent: "worker", task: "run npm test" }))
      .build();
    assert.equal(
      evaluateScenarioOutcome(fixture, workerPath, "The worker ran the tests but no output yet.")
        .pass,
      false,
    );
  });
});

describe("predicate plumbing", () => {
  it("fails loudly for fixtures without a registered predicate", () => {
    const outcome = evaluateScenarioPredicate(
      "unknown-fixture",
      [],
      "text",
      fixtureFrom(developmentSuite, "read-only-child"),
    );
    assert.equal(outcome.evaluated, false);
    assert.equal(outcome.pass, false);
    assert.match(outcome.reasons[0] ?? "", /no semantic predicate/);
  });

  it("counts help, discovery, and launch facts from traces", () => {
    const trace = new TraceBuilder()
      .push({ kind: "help", topic: "workflows" })
      .push({ kind: "discovery", capabilities: true })
      .push(launch("direct-child", { key: "direct", agent: "scout", task: "t" }))
      .build();
    const facts = collectSessionFacts(trace, "");
    assert.equal(facts.helpCalls, 1);
    assert.equal(facts.discovered, true);
    assert.equal(facts.launchFacts.length, 1);
    assert.equal(facts.launchFacts[0]?.agent, "scout");
  });
});
