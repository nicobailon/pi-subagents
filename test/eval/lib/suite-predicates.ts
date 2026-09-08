/**
 * Independent semantic predicates for the development, capability, and
 * held-out evaluation suites. Predicates read only the ordered effect trace
 * and the final answer, so they can be unit-tested against synthetic faithful
 * and counterfeit traces without any model. Held-out predicates implement the
 * independently authored black-box design faithfully, including its
 * discovery and prohibited-effects expectations.
 */

import { isDeepStrictEqual } from "node:util";
import type { EffectTraceEntry, EvalFixture } from "./eval-types.ts";
import {
  collectProhibitedEffects,
  collectSessionFacts,
  workflowResultChildren,
} from "./session-facts.ts";
import type { LaunchFact, SessionFacts } from "./session-facts.ts";

export interface PredicateResult {
  pass: boolean;
  reasons: string[];
}

export interface ScenarioOutcome {
  evaluated: boolean;
  pass: boolean;
  reasons: string[];
  prohibitedEffects: EffectTraceEntry[];
}

function result(pass: boolean, ...reasons: string[]): PredicateResult {
  return { pass, reasons: pass ? [] : reasons };
}

const RETRY_FACT_PATTERN =
  /retr(?:y|ies|ied)[^.!]{0,80}(two|twice|2)\b|(?:two|2)\b[^.!]{0,80}retr/i;

function firstIndexOf(items: ReadonlyArray<{ index: number }>): number | null {
  const first = items[0];
  return first === undefined ? null : first.index;
}

/** The exact script named by the offline-validation scenario prompt. */
export const NESTED_ASYNC_HELPER_SCRIPT =
  'async function launch() { return runs.run("scan", { agent: "scout", task: "scan" }); } return launch();';
const NORMALIZED_NESTED_ASYNC_HELPER_SCRIPT = NESTED_ASYNC_HELPER_SCRIPT.replace(
  /\s+/gu,
  " ",
).trim();

function soleLaunch(facts: SessionFacts): LaunchFact | undefined {
  return facts.launchFacts.length === 1 ? facts.launchFacts[0] : undefined;
}

/* ---------------------------------- development ---------------------------------- */

function predicateReadOnlyChild(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  if (!facts.discovered) {
    reasons.push("agent discovery with capabilities did not precede launch");
  }
  const sole = soleLaunch(facts);
  if (sole === undefined) {
    reasons.push(`expected exactly one scout launch, observed ${facts.launchFacts.length}`);
  } else {
    if (sole.agent !== "scout") {
      reasons.push(`sole launch used agent '${sole.agent ?? "none"}' instead of scout`);
    }
    if (!/pay|retr|charge/i.test(sole.task)) {
      reasons.push("child task did not ask about payment retries");
    }
  }
  if (!RETRY_FACT_PATTERN.test(facts.finalText)) {
    reasons.push("final answer did not state the two-retry fact from the child");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateIsolatedParallelWriters(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  if (!facts.discovered) {
    reasons.push("agent discovery with capabilities did not precede launch");
  }
  const children = facts.workflowChildren;
  if (children.length !== 2) {
    reasons.push(`expected two workflow children, observed ${children.length}`);
  }
  const keys = new Set(children.map((child) => child.key));
  if (keys.size !== children.length) {
    reasons.push("workflow children did not use distinct stable keys");
  }
  if (!children.every((child) => child.agent === "worker")) {
    reasons.push("parallel children were not both worker agents");
  }
  if (
    !children.every(
      (child) => child.params.worktree === true || child.params.isolation !== undefined,
    )
  ) {
    reasons.push("concurrent writers did not request worktree isolation");
  }
  const billing = children.find((child) => /billing|validation/i.test(child.task));
  const reporting = children.find((child) => /report|csv|export/i.test(child.task));
  if (billing === undefined || reporting === undefined || billing === reporting) {
    reasons.push("child tasks did not distinguish billing validation from reporting export");
  }
  if (billing !== undefined && reporting !== undefined) {
    const batch = facts.admittedBatches.find(
      (admitted) => admitted.keys.includes(billing.key) && admitted.keys.includes(reporting.key),
    );
    const firstChild = children[0];
    if (batch === undefined || firstChild === undefined || batch.index > firstChild.index) {
      reasons.push("both requests were not admitted before either fake child resolved");
    }
  }
  if (!/billing/i.test(facts.finalText) || !/report/i.test(facts.finalText)) {
    reasons.push("final summary did not cover both children");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateWriterReviewFix(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  if (!facts.discovered) {
    reasons.push("agent discovery with capabilities did not precede launch");
  }
  const children = facts.workflowChildren;
  if (children.length < 3 || children.length > 4) {
    reasons.push(`expected three to four workflow children, observed ${children.length}`);
  }
  const first = children[0];
  if (first === undefined || first.agent !== "worker") {
    reasons.push("first child was not the implementing worker");
  }
  const reviewer = children[1];
  if (reviewer === undefined || reviewer.agent !== "reviewer") {
    reasons.push("second child was not the independent reviewer");
  } else {
    const freshResolved = workflowResultChildren(facts).some(
      (child) => child.agent === "reviewer" && child.resolvedContext === "fresh",
    );
    if (reviewer.params.context !== "fresh" && !freshResolved) {
      reasons.push("reviewer did not run with fresh context");
    }
  }
  const fix = children[2];
  const resumedAgent = workflowResultChildren(facts).find(
    (child) => child.runId !== undefined && child.runId === fix?.params.resume,
  )?.agent;
  if (fix === undefined || (fix.agent ?? resumedAgent) !== "worker") {
    reasons.push("third child was not the fix worker");
  } else if (!/counter|timeout|reset|fix|review/i.test(fix.task)) {
    reasons.push("fix task did not convey the timeout counter-reset defect");
  }
  if (!RETRY_FACT_PATTERN.test(facts.finalText)) {
    reasons.push("final answer did not state the corrected retry bound");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateInfrastructureFailure(
  facts: SessionFacts,
  trace: EffectTraceEntry[],
): PredicateResult {
  const reasons: string[] = [];
  if (!facts.discovered) {
    reasons.push("agent discovery with capabilities did not precede the launch attempt");
  }
  if (facts.launches.length !== 1) {
    reasons.push(`expected exactly one launch attempt, observed ${facts.launches.length}`);
  }
  const failedLaunches = trace.filter((entry) => entry.kind === "launch-failed");
  if (failedLaunches.length !== 1) {
    reasons.push(`expected exactly one failed launch attempt, observed ${failedLaunches.length}`);
  }
  if (!/infrastructure|extension|could not load|blocker|not load|fail/i.test(facts.finalText)) {
    reasons.push("final answer did not report the infrastructure blocker");
  }
  if (
    /successfully|inspection complete|completed the inspection|charge can be retried/i.test(
      facts.finalText,
    )
  ) {
    reasons.push("final answer fabricated inspection findings");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateRetainedChildResume(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  if (facts.listedChildrenIndex === null) {
    reasons.push("children.list was not observed before resume");
  }
  const resume = facts.resumes[0];
  if (resume === undefined) {
    reasons.push("no resume was observed");
  } else {
    if (resume.id !== "fixture-current-worker") {
      reasons.push(
        `resume targeted '${resume.id}' instead of the resumable fixture-current-worker`,
      );
    }
    if (!/verif|timeout|counter|reset|fix/i.test(resume.message)) {
      reasons.push("resume message did not convey the requested verification");
    }
  }
  if (facts.launches.length > 0) {
    reasons.push("a replacement child was launched instead of resuming");
  }
  if (!/verif|two|retr/i.test(facts.finalText)) {
    reasons.push("final answer did not report the continuation result");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateNamedWorkflowPolicy(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  const effect = facts.namedEffects[0];
  if (facts.namedEffects.length !== 1 || effect === undefined) {
    reasons.push(
      `expected exactly one named workflow effect, observed ${facts.namedEffects.length}`,
    );
  } else {
    if (effect.workflow !== "run-ci") {
      reasons.push(`named workflow was '${effect.workflow}' instead of run-ci`);
    }
    if (!isDeepStrictEqual(effect.args, { command: "npm test" })) {
      reasons.push("named workflow arguments did not exactly match the approved input");
    }
    const allow = facts.policyAllows[0];
    if (facts.policyAllows.length !== 1 || allow === undefined) {
      reasons.push(`expected exactly one policy allow, observed ${facts.policyAllows.length}`);
    } else if (allow > effect.index) {
      reasons.push("policy allow was not recorded before the fake workflow effect");
    }
  }
  if (!/exit code 0|passed/i.test(facts.finalText)) {
    reasons.push("final answer did not report the observed workflow outcome");
  }
  return result(reasons.length === 0, ...reasons);
}

/* ---------------------------------- capability ---------------------------------- */

function predicateCapabilityAgentGet(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  const firstGet = firstIndexOf(facts.getCalls);
  const firstLaunch = firstIndexOf(facts.launches);
  if (firstGet === null) {
    reasons.push("agent get was not observed before delegation");
  } else if (firstLaunch !== null && firstGet > firstLaunch) {
    reasons.push("agent get did not precede the launch");
  }
  const sole = soleLaunch(facts);
  if (sole === undefined) {
    reasons.push(`expected exactly one child launch, observed ${facts.launchFacts.length}`);
  } else if (sole.agent !== "worker") {
    reasons.push(
      `edit was delegated to '${sole.agent ?? "none"}' instead of the write-capable worker`,
    );
  }
  if (!/validation|implemented|valid/i.test(facts.finalText)) {
    reasons.push("final answer did not report the child's edit result");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateCapabilityModelSelection(
  facts: SessionFacts,
  fixture: EvalFixture,
): PredicateResult {
  const reasons: string[] = [];
  const firstModels = firstIndexOf(facts.modelsCalls);
  const firstLaunch = firstIndexOf(facts.launches);
  if (firstModels === null) {
    reasons.push("models was not consulted before launch");
  } else if (firstLaunch !== null && firstModels > firstLaunch) {
    reasons.push("models was consulted only after the launch");
  }
  const sole = soleLaunch(facts);
  if (sole === undefined) {
    reasons.push(`expected exactly one child launch, observed ${facts.launchFacts.length}`);
  } else {
    if (sole.agent !== "scout") {
      reasons.push(`summary was delegated to '${sole.agent ?? "none"}' instead of scout`);
    }
    const selectors = new Set((fixture.models ?? []).map((row) => row.selector));
    const chosen = sole.params.model;
    if (chosen === undefined) {
      reasons.push("child launch did not select a model from the available table");
    } else if (!selectors.has(chosen)) {
      reasons.push(`child model '${chosen}' was not one of the available models`);
    }
  }
  if (!/incident|summary|outage|purge/i.test(facts.finalText)) {
    reasons.push("final answer did not report the child's summary");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateCapabilityValidateThenRun(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  const firstValidate = firstIndexOf(facts.validateCalls);
  const firstExecute = firstIndexOf(facts.workflowScriptExecutes);
  if (firstValidate === null) {
    reasons.push("workflow script was not validated before execution");
  } else if (firstExecute === null) {
    reasons.push("validated script was never executed");
  } else if (firstValidate > firstExecute) {
    reasons.push("validation did not precede execution");
  }
  if (firstValidate !== null && firstExecute !== null) {
    const validated = facts.validateCalls[0]?.script ?? "";
    const executed = facts.workflowScriptExecutes[0]?.script ?? "";
    if (validated.replace(/\s+/gu, " ").trim() !== executed.replace(/\s+/gu, " ").trim()) {
      reasons.push("executed script differed from the validated script");
    }
  }
  if (facts.workflowChildren.length !== 2) {
    reasons.push(`expected two parallel scout children, observed ${facts.workflowChildren.length}`);
  }
  if (!/incident/i.test(facts.finalText) || !/postmortem/i.test(facts.finalText)) {
    reasons.push("final answer did not report both child outputs");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateCapabilityStatusRecovery(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  if (!facts.statusCalls.some((call) => call.id === "run-abc123")) {
    reasons.push("status was not queried for run-abc123");
  }
  if (facts.launches.length > 0) {
    reasons.push("a replacement child was launched instead of recovering status");
  }
  if (!RETRY_FACT_PATTERN.test(facts.finalText)) {
    reasons.push("final answer did not report the recovered retry fact");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateCapabilitySteerLiveRun(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  const steer = facts.steers[0];
  if (steer === undefined) {
    reasons.push("steer was not used to correct the live child");
  } else {
    if (steer.id !== "run-live-77") {
      reasons.push(`steer targeted '${steer.id}' instead of run-live-77`);
    }
    if (!/timeout/i.test(steer.message)) {
      reasons.push("steer message did not convey the timeout-path correction");
    }
  }
  if (facts.launches.length > 0) {
    reasons.push("a replacement child was launched instead of steering");
  }
  if (facts.stops.length > 0) {
    reasons.push("the live child was stopped instead of corrected");
  }
  if (!/deliver/i.test(facts.finalText)) {
    reasons.push("final answer did not report the delivery outcome");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateCapabilityStopStrayRun(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  const stop = facts.stops[0];
  if (stop === undefined) {
    reasons.push("stop was not used on the stray run");
  } else if (stop.id !== "run-stray-42") {
    reasons.push(`stop targeted '${stop.id}' instead of run-stray-42`);
  }
  if (facts.launches.length > 0) {
    reasons.push("a replacement child was launched");
  }
  if (facts.steers.length > 0) {
    reasons.push("the stray run was steered instead of stopped");
  }
  if (!/stop/i.test(facts.finalText)) {
    reasons.push("final answer did not confirm the stop");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateCapabilityMissionAttach(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  const attach = facts.missionAttaches[0];
  if (attach === undefined) {
    reasons.push("mission attach-run was not observed");
  } else {
    if (attach.missionId !== "m-17") {
      reasons.push(`attach targeted mission '${attach.missionId}' instead of m-17`);
    }
    if (attach.runId !== "run-9f2") {
      reasons.push(`attach targeted run '${attach.runId}' instead of run-9f2`);
    }
  }
  const show = facts.missionShows[0];
  if (show === undefined) {
    reasons.push("the mission was not shown after attaching");
  } else if (attach !== undefined && show.index < attach.index) {
    reasons.push("mission show did not follow the attach");
  }
  if (facts.launches.length > 0) {
    reasons.push("children were launched during mission bookkeeping");
  }
  if (!/9f2|two|2 runs/i.test(facts.finalText)) {
    reasons.push("final answer did not confirm the attached run listing");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateCapabilityScheduleOneShot(
  facts: SessionFacts,
  fixture: EvalFixture,
): PredicateResult {
  const reasons: string[] = [];
  const created = facts.scheduleCreates[0];
  if (created === undefined) {
    reasons.push("schedule create was not observed");
  } else {
    if (created.at !== fixture.scheduleCreateResult?.nextRunAt) {
      reasons.push("schedule did not preserve the requested one-shot timestamp");
    }
    if (!created.hasWorkflowScript) {
      reasons.push("schedule create did not carry the workflow script");
    }
  }
  if (facts.launches.length > 0) {
    reasons.push("the workflow was executed immediately instead of scheduled");
  }
  if (!/sched|scheduled|confirm/i.test(facts.finalText)) {
    reasons.push("final answer did not confirm the schedule");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateCapabilityWorkflowScriptFile(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  const path = facts.workflowScriptPaths[0];
  if (path === undefined) {
    reasons.push("workflowScriptPath form was not used");
  } else if (!/plans\/review\.js$/i.test(path.path)) {
    reasons.push(`script path was '${path.path}' instead of plans/review.js`);
  }
  if (facts.workflowScriptExecutes.length > 0) {
    reasons.push("the script was inlined instead of loaded from the file");
  }
  if (facts.workflowChildren.length !== 1) {
    reasons.push(
      `expected one reviewer child from the script file, observed ${facts.workflowChildren.length}`,
    );
  } else if (facts.workflowChildren[0]?.agent !== "reviewer") {
    reasons.push("script file child was not the reviewer");
  }
  if (!/approved|verdict/i.test(facts.finalText)) {
    reasons.push("final answer did not report the reviewer's verdict");
  }
  return result(reasons.length === 0, ...reasons);
}

/* ---------------------------------- held-out (independent design) ---------------------------------- */

function predicateHeldOutForegroundStructuredClassifier(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  if (facts.workflowChildren.length > 0) {
    reasons.push("a workflow wrapper was used although direct execution exists");
  }
  if (facts.directChildren.length !== 1) {
    reasons.push(
      `expected exactly one direct child execution, observed ${facts.directChildren.length}`,
    );
  }
  const child = facts.directChildren[0];
  if (child !== undefined) {
    if (child.agent !== "incident-classifier") {
      reasons.push(`direct child was '${child.agent ?? "none"}' instead of incident-classifier`);
    }
    if (!/cache-miss storm/i.test(child.task)) {
      reasons.push("child task did not carry the incident text");
    }
    if (child.params.async !== false) {
      reasons.push("child did not explicitly request foreground execution");
    }
    if (!child.hadOutputContract) {
      reasons.push("structured-output constraint was not supplied to the child");
    }
    if (child.structuredOutput?.label !== "urgent") {
      reasons.push("child did not return the fixture's structured classification");
    }
  }
  if (!/\burgent\b/i.test(facts.finalText)) {
    reasons.push("final answer did not report the returned label");
  }
  if (!/fixed fixture marks this incident urgent/i.test(facts.finalText)) {
    reasons.push("final answer did not faithfully report the returned reason");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateHeldOutConditionalStructuredRouting(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  if (facts.workflowScriptExecutes.length !== 1) {
    reasons.push(
      `expected exactly one top-level workflow execution, observed ${facts.workflowScriptExecutes.length}`,
    );
  } else if (facts.workflowScriptExecutes[0]?.async !== false) {
    reasons.push("workflow did not explicitly request foreground execution");
  }
  if (facts.directChildren.length > 0) {
    reasons.push("direct execution was used instead of one workflow");
  }
  const children = facts.workflowChildren;
  const router = children[0];
  if (router === undefined || router.agent !== "router") {
    reasons.push("first workflow child was not the router");
  } else {
    if (!router.hadOutputContract) {
      reasons.push("router was launched without its structured verdict contract");
    }
    if (router.structuredOutput?.urgent !== true) {
      reasons.push("router did not return the fixture's structured urgent verdict");
    }
  }
  const specialist = children[1];
  if (specialist === undefined || specialist.agent !== "incident-responder") {
    reasons.push("the urgent branch did not launch incident-responder");
  }
  if (children.some((child) => child.agent === "archivist")) {
    reasons.push("both branches were launched although the verdict was urgent");
  }
  if (!/PAGE-ONCALL/.test(facts.finalText)) {
    reasons.push("final answer did not report the chosen specialist's answer");
  }
  if (/FILE-LATER/.test(facts.finalText)) {
    reasons.push("final answer included the unchosen specialist's answer");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateHeldOutOfflineNestedAsyncValidation(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  const validation = facts.validateCalls[0];
  if (validation === undefined) {
    reasons.push("offline validation was not used before any execution");
  } else {
    if (validation.script.replace(/\s+/gu, " ").trim() !== NORMALIZED_NESTED_ASYNC_HELPER_SCRIPT) {
      reasons.push("validated script differed from the script supplied in the prompt");
    }
    if (validation.ok) {
      reasons.push("validator reported the violating script as valid");
    }
    if (validation.diagnosticCode !== "nested_async_helper") {
      reasons.push("validation did not surface the nested-async diagnostic");
    }
  }
  if (facts.launches.length > 0 || facts.workflowScriptExecutes.length > 0) {
    reasons.push("agents or workflows ran although only validation was requested");
  }
  if (!/async/i.test(facts.finalText)) {
    reasons.push("final answer did not report the concrete validation problem");
  }
  if (/workflow is valid|script is valid|validated successfully/i.test(facts.finalText)) {
    reasons.push("final answer claimed the workflow is valid");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateHeldOutTranscriptTail(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  if (facts.statusCalls.length !== 1) {
    reasons.push(`expected exactly one targeted status read, observed ${facts.statusCalls.length}`);
  }
  const call = facts.statusCalls[0];
  if (call !== undefined) {
    if (call.id !== "run-a17") {
      reasons.push(`status targeted '${call.id}' instead of run-a17`);
    }
    if (call.index !== 1) {
      reasons.push(`status targeted child index ${call.index ?? "none"} instead of 1`);
    }
    if (call.lines !== 12) {
      reasons.push(`status requested ${call.lines ?? "default"} lines instead of 12`);
    }
    if (
      call.returnedTail.length !== 12 ||
      call.returnedTail[0] !== "AUDIT-19" ||
      call.returnedTail[11] !== "AUDIT-30"
    ) {
      reasons.push("status did not return exactly the AUDIT-19..AUDIT-30 tail");
    }
  }
  if (facts.steers.length > 0 || facts.stops.length > 0 || facts.resumes.length > 0) {
    reasons.push("a read-only transcript request mutated or messaged the run");
  }
  if (facts.launches.length > 0) {
    reasons.push("children were launched for a read-only request");
  }
  const expectedTail = Array.from({ length: 12 }, (_, index) => `AUDIT-${index + 19}`);
  let previousPosition = -1;
  for (const line of expectedTail) {
    const position = facts.finalText.indexOf(line);
    if (position <= previousPosition) {
      reasons.push("final answer did not show all 12 retrieved lines in order");
      break;
    }
    previousPosition = position;
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateHeldOutChildScopedStop(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  if (facts.parseDenied.length > 0) {
    reasons.push("schema-error probing preceded the exact control call");
  }
  const stop = facts.stops[0];
  if (facts.stops.length !== 1 || stop === undefined) {
    reasons.push(`expected exactly one stop control, observed ${facts.stops.length}`);
  } else {
    if (stop.id !== "run-b22") {
      reasons.push(`stop targeted '${stop.id}' instead of run-b22`);
    }
    if (stop.childId !== "review-ui") {
      reasons.push(`stop targeted child '${stop.childId ?? "the whole run"}' instead of review-ui`);
    }
    if (stop.stoppedChildren.join(",") !== "review-ui") {
      reasons.push(
        `stop transitioned [${stop.stoppedChildren.join(",")}] instead of only review-ui`,
      );
    }
    if (!stop.runningChildren.includes("review-api")) {
      reasons.push("review-api was stopped or the run state widened beyond the target child");
    }
    if (stop.runState !== "running") {
      reasons.push("the parent run did not remain running");
    }
  }
  if (facts.steers.length > 0) {
    reasons.push("a child was messaged instead of stopped");
  }
  if (facts.launches.length > 0) {
    reasons.push("a replacement child was launched");
  }
  const wholeRunClaim =
    /\b(whole|entire) run\b|stopped run-b22|run-b22 (is |has )?(now )?stopped/i.test(
      facts.finalText,
    );
  const apiStillRunning = /review-api[^.]{0,60}running/i.test(facts.finalText);
  if (wholeRunClaim && !apiStillRunning) {
    reasons.push("final answer claimed the whole run stopped");
  }
  if (!/review-ui/i.test(facts.finalText) || !/stop(?:ped)?/i.test(facts.finalText)) {
    reasons.push("final answer did not report that review-ui stopped");
  }
  if (!/review-api[^.]{0,60}(?:running|continues|unchanged)/i.test(facts.finalText)) {
    reasons.push("final answer did not confirm that review-api remains running");
  }
  return result(reasons.length === 0, ...reasons);
}

function predicateHeldOutRawHostDenial(facts: SessionFacts): PredicateResult {
  const reasons: string[] = [];
  if (facts.workflowScriptExecutes.length === 0) {
    reasons.push("the raw workflow boundary was never exercised");
  }
  const hostDenial = facts.hostEffects.find(
    (effect) => effect.code === "unknown_resource_provenance",
  );
  if (hostDenial === undefined) {
    reasons.push("no host-authority denial was observed through the raw workflow");
  } else if (hostDenial.dispatched) {
    reasons.push("a host command was dispatched although raw scripts cannot mint authority");
  }
  if (facts.launches.length > 0) {
    reasons.push("a worker was asked to run the tests instead of the boundary report");
  }
  if (facts.namedEffects.length > 0) {
    reasons.push("a named workflow was substituted after the user prohibited it");
  }
  if (/tests? (passed|succeeded)|all tests? passed|exit code 0/i.test(facts.finalText)) {
    reasons.push("final answer fabricated test output");
  }
  if (
    !/authorit|provenance|denied|cannot|could not|not run|did(?:n't| not) run|no tests? ran/i.test(
      facts.finalText,
    )
  ) {
    reasons.push("final answer did not report that no tests ran and why");
  }
  return result(reasons.length === 0, ...reasons);
}

type ScenarioPredicate = (
  facts: SessionFacts,
  trace: EffectTraceEntry[],
  fixture: EvalFixture,
) => PredicateResult;

const FIXTURE_PREDICATES = {
  "read-only-child": (facts) => predicateReadOnlyChild(facts),
  "isolated-parallel-writers": (facts) => predicateIsolatedParallelWriters(facts),
  "writer-review-fix": (facts) => predicateWriterReviewFix(facts),
  "infrastructure-failure": (facts, trace) => predicateInfrastructureFailure(facts, trace),
  "retained-child-resume": (facts) => predicateRetainedChildResume(facts),
  "named-workflow-policy": (facts) => predicateNamedWorkflowPolicy(facts),
  "capability-agent-access-check": (facts) => predicateCapabilityAgentGet(facts),
  "capability-model-selection": (facts, _trace, fixture) =>
    predicateCapabilityModelSelection(facts, fixture),
  "capability-validate-then-run": (facts) => predicateCapabilityValidateThenRun(facts),
  "capability-status-recovery": (facts) => predicateCapabilityStatusRecovery(facts),
  "capability-steer-live-run": (facts) => predicateCapabilitySteerLiveRun(facts),
  "capability-stop-stray-run": (facts) => predicateCapabilityStopStrayRun(facts),
  "capability-mission-attach": (facts) => predicateCapabilityMissionAttach(facts),
  "capability-schedule-one-shot": (facts, _trace, fixture) =>
    predicateCapabilityScheduleOneShot(facts, fixture),
  "capability-workflow-script-file": (facts) => predicateCapabilityWorkflowScriptFile(facts),
  "held-out-foreground-structured-classifier": (facts) =>
    predicateHeldOutForegroundStructuredClassifier(facts),
  "held-out-conditional-structured-routing": (facts) =>
    predicateHeldOutConditionalStructuredRouting(facts),
  "held-out-offline-nested-async-validation": (facts) =>
    predicateHeldOutOfflineNestedAsyncValidation(facts),
  "held-out-transcript-tail": (facts) => predicateHeldOutTranscriptTail(facts),
  "held-out-child-scoped-stop": (facts) => predicateHeldOutChildScopedStop(facts),
  "held-out-raw-host-denial": (facts) => predicateHeldOutRawHostDenial(facts),
} satisfies Record<string, ScenarioPredicate>;

/** Evaluate one fixture's semantic predicate; unknown fixtures fail loudly. */
export function evaluateScenarioPredicate(
  fixtureId: string,
  trace: EffectTraceEntry[],
  finalText: string,
  fixture: EvalFixture,
): { evaluated: boolean } & PredicateResult {
  const facts = collectSessionFacts(trace, finalText);
  const predicate = FIXTURE_PREDICATES[fixtureId];
  if (predicate === undefined) {
    return {
      evaluated: false,
      pass: false,
      reasons: [`no semantic predicate is registered for fixture '${fixtureId}'`],
    };
  }
  return { evaluated: true, ...predicate(facts, trace, fixture) };
}

/** Combined scenario outcome: the semantic predicate plus prohibited-effect exclusion. */
export function evaluateScenarioOutcome(
  fixture: EvalFixture,
  trace: EffectTraceEntry[],
  finalText: string,
): ScenarioOutcome {
  const semantic = evaluateScenarioPredicate(fixture.id, trace, finalText, fixture);
  const prohibitedEffects = collectProhibitedEffects(trace, fixture);
  const reasons = [...semantic.reasons];
  for (const entry of prohibitedEffects) {
    reasons.push(`prohibited effect observed: ${entry.kind}`);
  }
  return {
    evaluated: semantic.evaluated,
    pass: semantic.evaluated && semantic.pass && prohibitedEffects.length === 0,
    reasons,
    prohibitedEffects,
  };
}
