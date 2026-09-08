import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { parseSubagentCatalogCall } from "../../src/extension/subagent-command-catalog.ts";
import {
  runWorkflowScript,
  validateWorkflowScript,
} from "../../src/workflows/scripted-workflow.ts";
import { decodeCanonicalParams, decodeSuiteDocument } from "../../test/eval/lib/decode.ts";
import { createFakeSubagentRuntime } from "../../test/eval/lib/fake-runtime.ts";
import type { FakeSubagentRuntime, FakeRuntimeServices } from "../../test/eval/lib/fake-runtime.ts";
import type {
  CanonicalRequest,
  DiscoveryAgentRow,
  EvalFixture,
  EvalSuiteDocument,
  VariantCall,
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

function services(): FakeRuntimeServices {
  return {
    runWorkflowScript: (options) => runWorkflowScript(options),
    validateWorkflowScript: (script) => validateWorkflowScript(script),
    renderHelp: (topic) => ({
      content: [{ type: "text", text: `catalog help for ${topic ?? "overview"}` }],
    }),
  };
}

function runtimeFor(fixture: EvalFixture, agents?: DiscoveryAgentRow[]): FakeSubagentRuntime {
  return createFakeSubagentRuntime(
    fixture,
    agents ?? developmentSuite.discovery.agents,
    services(),
  );
}

function canonical(call: VariantCall): CanonicalRequest {
  const parsed = parseSubagentCatalogCall(call);
  assert.equal(parsed.ok, true, JSON.stringify(call));
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  if (parsed.request.kind === "help") {
    return { kind: "help", topic: parsed.request.topic };
  }
  const params = decodeCanonicalParams(parsed.request.params);
  if (params === null) {
    throw new Error("canonical params failed the boundary decoder");
  }
  return parsed.request.kind === "management"
    ? { kind: "management", params }
    : { kind: "execute", params };
}

async function executeCall(runtime: FakeSubagentRuntime, call: VariantCall) {
  const request = canonical(call);
  const result = await runtime.execute(request);
  const first = result.content[0];
  return { request, result, text: first !== undefined && first.type === "text" ? first.text : "" };
}

describe("eval fake runtime literal action table", () => {
  it("serves discovery with and without capability rows", async () => {
    const runtime = runtimeFor(fixtureFrom(developmentSuite, "read-only-child"));
    const plain = await executeCall(runtime, { action: "list" });
    assert.equal(plain.result.isError, undefined);
    assert.match(plain.text, /note.*capabilities:true/);
    const capabilities = await executeCall(runtime, {
      action: "list",
      input: { capabilities: true },
    });
    const rows = JSON.parse(capabilities.text);
    assert.deepEqual(
      rows.agents.map((agent: DiscoveryAgentRow) => agent.name),
      ["scout", "worker", "reviewer"],
    );
    assert.ok(runtime.trace.some((entry) => entry.kind === "discovery" && entry.capabilities));
  });

  it("serves get, models, steer, stop, children.list, and resume from fixture data", async () => {
    const steerRuntime = runtimeFor(
      fixtureFrom(capabilitySuite, "capability-steer-live-run"),
      capabilitySuite.discovery.agents,
    );
    const steer = await executeCall(steerRuntime, {
      action: "steer",
      input: { id: "run-live-77", message: "also cover the timeout path" },
    });
    assert.equal(steer.result.isError, undefined);
    assert.equal(JSON.parse(steer.text).state, "delivered");

    const stopRuntime = runtimeFor(
      fixtureFrom(capabilitySuite, "capability-stop-stray-run"),
      capabilitySuite.discovery.agents,
    );
    const stop = await executeCall(stopRuntime, { action: "stop", input: { id: "run-stray-42" } });
    assert.equal(JSON.parse(stop.text).stopped, true);
    const unknownStop = await executeCall(stopRuntime, {
      action: "stop",
      input: { id: "run-other" },
    });
    assert.equal(unknownStop.result.isError, true);

    const runtime = runtimeFor(fixtureFrom(developmentSuite, "retained-child-resume"));
    const get = await executeCall(runtime, { action: "get", input: { agent: "scout" } });
    assert.equal(JSON.parse(get.text).access, "read-only");

    const models = await executeCall(runtime, { action: "models" });
    assert.ok(Array.isArray(JSON.parse(models.text).models));

    const children = await executeCall(runtime, { action: "children.list" });
    const listed = JSON.parse(children.text);
    assert.equal(listed.children.length, 2);
    assert.equal(
      listed.children.filter((child: { resumable: boolean }) => child.resumable).length,
      1,
    );

    const resume = await executeCall(runtime, {
      action: "resume",
      input: { id: "fixture-current-worker", message: "check the timeout counter-reset fix" },
    });
    assert.equal(JSON.parse(resume.text).runId, "fixture-resumed-worker");

    const stale = await executeCall(runtime, {
      action: "resume",
      input: { id: "fixture-old-worker", message: "again" },
    });
    assert.equal(stale.result.isError, true);
    assert.match(stale.text, /not resumable/);
  });

  it("serves held-out status runs with per-child transcript tails", async () => {
    const runtime = runtimeFor(
      fixtureFrom(heldOutSuite, "held-out-transcript-tail"),
      heldOutSuite.discovery.agents,
    );
    const status = await executeCall(runtime, {
      action: "status",
      input: { id: "run-a17", view: "transcript", index: 1, lines: 12 },
    });
    const payload = JSON.parse(status.text);
    assert.equal(payload.child.index, 1);
    assert.equal(payload.child.agent, "audit");
    assert.equal(payload.transcriptTail.length, 12);
    assert.equal(payload.transcriptTail[0], "AUDIT-19");
    assert.equal(payload.transcriptTail[11], "AUDIT-30");
    const entry = runtime.trace.find((traceEntry) => traceEntry.kind === "status");
    assert.ok(entry !== undefined && entry.kind === "status");
    assert.equal(entry.returnedTail[0], "AUDIT-19");
    assert.equal(entry.returnedTail.length, 12);

    const wrongIndex = await executeCall(runtime, {
      action: "status",
      input: { id: "run-a17", index: 5, lines: 12 },
    });
    assert.equal(wrongIndex.result.isError, true);
  });

  it("applies child-scoped stop without widening to the run", async () => {
    const runtime = runtimeFor(
      fixtureFrom(heldOutSuite, "held-out-child-scoped-stop"),
      heldOutSuite.discovery.agents,
    );
    const before = await executeCall(runtime, {
      action: "status",
      input: { id: "run-b22" },
    });
    assert.deepEqual(JSON.parse(before.text), {
      runId: "run-b22",
      runState: "running",
      children: [
        { id: "review-ui", state: "running" },
        { id: "review-api", state: "running" },
      ],
    });

    const scoped = await executeCall(runtime, {
      action: "stop",
      input: { id: "run-b22", childId: "review-ui" },
    });
    const payload = JSON.parse(scoped.text);
    assert.deepEqual(payload.stoppedChildren, ["review-ui"]);
    assert.deepEqual(payload.runningChildren, ["review-api"]);
    assert.equal(payload.runState, "running");
    const entry = runtime.trace.find((traceEntry) => traceEntry.kind === "stop");
    assert.ok(entry !== undefined && entry.kind === "stop");
    assert.equal(entry.childId, "review-ui");
    assert.deepEqual(entry.runningChildren, ["review-api"]);

    const after = await executeCall(runtime, {
      action: "status",
      input: { id: "run-b22" },
    });
    assert.deepEqual(JSON.parse(after.text), {
      runId: "run-b22",
      runState: "running",
      children: [
        { id: "review-ui", state: "stopped" },
        { id: "review-api", state: "running" },
      ],
    });

    const wholeRun = runtimeFor(
      fixtureFrom(heldOutSuite, "held-out-child-scoped-stop"),
      heldOutSuite.discovery.agents,
    );
    const widened = await executeCall(wholeRun, { action: "stop", input: { id: "run-b22" } });
    const widenedPayload = JSON.parse(widened.text);
    assert.deepEqual(widenedPayload.stoppedChildren, ["review-ui", "review-api"]);
    assert.equal(widenedPayload.runState, "stopped");
  });

  it("serves mission attach/show and schedule create without executing effects", async () => {
    const runtime = runtimeFor(
      fixtureFrom(capabilitySuite, "capability-mission-attach"),
      capabilitySuite.discovery.agents,
    );
    const before = await executeCall(runtime, {
      action: "mission.show",
      input: { missionId: "m-17" },
    });
    assert.deepEqual(JSON.parse(before.text).runs, ["run-8c1"]);
    const attach = await executeCall(runtime, {
      action: "mission.attach-run",
      input: { missionId: "m-17", runId: "run-9f2" },
    });
    assert.equal(JSON.parse(attach.text).attached, true);
    const after = await executeCall(runtime, {
      action: "mission.show",
      input: { missionId: "m-17" },
    });
    assert.deepEqual(JSON.parse(after.text).runs, ["run-8c1", "run-9f2"]);

    const scheduleRuntime = runtimeFor(
      fixtureFrom(capabilitySuite, "capability-schedule-one-shot"),
      capabilitySuite.discovery.agents,
    );
    const schedule = await executeCall(scheduleRuntime, {
      action: "schedule.create",
      input: {
        at: "tomorrow 09:30",
        workflowScript:
          'return await runs.run("chk", {agent:"scout", task:"Run the readiness checks"})',
      },
    });
    assert.equal(JSON.parse(schedule.text).id, "sched-31");
    const launchKinds = new Set(["launch-failed", "direct-child", "workflow-child"]);
    assert.equal(
      scheduleRuntime.trace.some((entry) => launchKinds.has(entry.kind)),
      false,
    );
    assert.ok(
      scheduleRuntime.trace.some(
        (entry) => entry.kind === "schedule-create" && entry.hasWorkflowScript,
      ),
    );
  });

  it("validates scripts with the production validator and maps the nested-async diagnostic", async () => {
    const runtime = runtimeFor(
      fixtureFrom(heldOutSuite, "held-out-offline-nested-async-validation"),
    );
    const violating =
      'async function launch() { return runs.run("scan", { agent: "scout", task: "scan" }); } return launch();';
    const invalid = await executeCall(runtime, {
      action: "validate",
      input: { workflowScript: violating },
    });
    const invalidPayload = JSON.parse(invalid.text);
    assert.equal(invalidPayload.ok, false);
    assert.equal(invalidPayload.diagnosticCode, "nested_async_helper");
    assert.equal(invalidPayload.line, 1);
    const entry = runtime.trace.find((traceEntry) => traceEntry.kind === "validate");
    assert.ok(entry !== undefined && entry.kind === "validate");
    assert.equal(entry.diagnosticCode, "nested_async_helper");

    const valid = await executeCall(runtime, {
      action: "validate",
      input: { workflowScript: 'return await runs.run("a", {agent:"scout", task:"t"})' },
    });
    assert.equal(JSON.parse(valid.text).ok, true);
  });

  it("rejects children whose structured-output contract is not satisfied", async () => {
    const fixture = fixtureFrom(heldOutSuite, "held-out-foreground-structured-classifier");
    const outputSchema = {
      type: "object",
      required: ["label", "reason"],
      properties: {
        label: { type: "string", enum: ["urgent", "routine"] },
        reason: { type: "string" },
      },
      additionalProperties: false,
    };
    const runtime = runtimeFor(fixture, fixture.discoveryAgents);
    const conforming = await executeCall(runtime, {
      action: "execute",
      input: {
        agent: "incident-classifier",
        task: "Classify cache-miss storm as urgent or routine",
        outputSchema,
      },
    });
    const child = JSON.parse(conforming.text);
    assert.equal(child.ok, true);
    assert.equal(child.structuredOutput.label, "urgent");
    const entry = runtime.trace.find((traceEntry) => traceEntry.kind === "direct-child");
    assert.ok(entry !== undefined && entry.kind === "direct-child");
    assert.equal(entry.hadOutputContract, true);

    const missing = runtimeFor(fixture, fixture.discoveryAgents);
    const rejected = await executeCall(missing, {
      action: "execute",
      input: { agent: "incident-classifier", task: "Classify cache-miss storm" },
    });
    assert.equal(JSON.parse(rejected.text).ok, false);
    assert.match(rejected.text, /requires a structured output schema/);
    assert.ok(missing.trace.some((traceEntry) => traceEntry.kind === "launch-rejected"));

    const acceptedRetry = await executeCall(missing, {
      action: "execute",
      input: {
        agent: "incident-classifier",
        task: "Classify cache-miss storm as urgent or routine",
        outputSchema,
      },
    });
    const retryChild = JSON.parse(acceptedRetry.text);
    assert.equal(retryChild.ok, true);
    assert.equal(retryChild.structuredOutput.label, "urgent");
  });
});

describe("eval launch-form-neutral infrastructure failure", () => {
  const fixture = fixtureFrom(developmentSuite, "infrastructure-failure");

  it("fails the only direct launch and records any second launch as prohibited", async () => {
    const runtime = runtimeFor(fixture);
    const first = await executeCall(runtime, {
      action: "execute",
      input: { agent: "scout", task: "inspect payment retry logic" },
    });
    assert.equal(first.result.isError, true);
    assert.match(first.text, /could not load its extension/);
    const second = await executeCall(runtime, {
      action: "execute",
      input: { agent: "scout", task: "retry" },
    });
    assert.equal(second.result.isError, true);
    assert.match(second.text, /prohibited/);
    const kinds = runtime.trace.map((entry) => entry.kind);
    assert.equal(kinds.filter((kind) => kind === "launch-failed").length, 1);
    assert.equal(kinds.filter((kind) => kind === "prohibited-launch").length, 1);
    assert.equal(kinds.includes("direct-child"), false);
  });

  it("fails a runs.run workflow launch without fabricating success", async () => {
    const runtime = runtimeFor(fixture);
    const executed = await executeCall(runtime, {
      action: "execute",
      input: {
        workflowScript:
          'return await runs.run("s", {agent:"scout", task:"inspect payment retry logic"})',
      },
    });
    assert.equal(executed.result.isError, true);
    const failed = runtime.trace.filter((entry) => entry.kind === "launch-failed");
    assert.equal(failed.length, 1);
    assert.ok(failed[0] !== undefined && failed[0].kind === "launch-failed");
    assert.equal(failed[0].form, "workflow-run");
    assert.match(failed[0].message, /could not load its extension/);
  });

  it("marks runs.all launches with the batch form and still accepts exactly one failed attempt", async () => {
    const runtime = runtimeFor(fixture);
    const executed = await executeCall(runtime, {
      action: "execute",
      input: {
        workflowScript:
          'const results = await runs.all([{key:"a",agent:"scout",task:"inspect retry logic"},{key:"b",agent:"scout",task:"inspect charges"}]); return results.map((r) => r.ok)',
      },
    });
    assert.equal(executed.result.isError, undefined);
    const payload = JSON.parse(executed.text);
    assert.deepEqual(payload.value, [false, false]);
    assert.ok(payload.children.every((child: { ok: boolean }) => child.ok === false));
    assert.ok(
      payload.children.some((child: { error?: string }) =>
        /could not load its extension/.test(child.error ?? ""),
      ),
    );
    assert.ok(
      payload.children.some((child: { error?: string }) => /prohibited/.test(child.error ?? "")),
    );
    const failed = runtime.trace.filter((entry) => entry.kind === "launch-failed");
    const prohibited = runtime.trace.filter((entry) => entry.kind === "prohibited-launch");
    assert.equal(failed.length, 1);
    assert.ok(failed[0] !== undefined && failed[0].kind === "launch-failed");
    assert.equal(failed[0].form, "workflow-all");
    assert.equal(prohibited.length, 1);
    assert.ok(prohibited[0] !== undefined && prohibited[0].kind === "prohibited-launch");
    assert.equal(prohibited[0].form, "workflow-all");
  });

  it("derives batch form per launch so a later runs.run never inherits the runs.all form", async () => {
    const runtime = runtimeFor(fixtureFrom(developmentSuite, "read-only-child"));
    const executed = await executeCall(runtime, {
      action: "execute",
      input: {
        workflowScript: [
          'const batch = runs.all([{key:"a",agent:"scout",task:"summarize the incident report"},{key:"b",agent:"scout",task:"summarize the postmortem"}])',
          'const single = await runs.run("c", {agent:"scout", task:"scan"})',
          "const both = await batch",
          "return [single.ok, both.map((r) => r.ok)]",
        ].join("; "),
      },
    });
    assert.equal(executed.result.isError, undefined);
    const forms = runtime.trace
      .filter((entry) => entry.kind === "workflow-child")
      .map((entry) => (entry.kind === "workflow-child" ? entry.form : ""));
    assert.deepEqual(forms.sort(), ["workflow-all", "workflow-all", "workflow-run"]);
    const keys = runtime.trace
      .filter((entry) => entry.kind === "workflow-child")
      .map((entry) => (entry.kind === "workflow-child" ? entry.key : ""));
    assert.deepEqual(keys.sort(), ["a", "b", "c"]);
  });

  it("does not inject failure for fixtures without infrastructure failure config", async () => {
    const runtime = runtimeFor(fixtureFrom(developmentSuite, "read-only-child"));
    const executed = await executeCall(runtime, {
      action: "execute",
      input: { agent: "scout", task: "inspect payment retry logic" },
    });
    assert.equal(executed.result.isError, undefined);
    const child = JSON.parse(executed.text);
    assert.equal(child.ok, true);
    assert.match(child.output, /two retries/);
  });
});

describe("eval fake runtime execution forms", () => {
  it("serves the configured named workflow only for the exact name", async () => {
    const runtime = runtimeFor(fixtureFrom(developmentSuite, "named-workflow-policy"));
    const named = await executeCall(runtime, {
      action: "execute",
      input: { workflow: "run-ci", args: { command: "npm test" } },
    });
    assert.match(named.text, /exit code 0/);
    const wrong = await executeCall(runtime, {
      action: "execute",
      input: { workflow: "deploy", args: { command: "npm test" } },
    });
    assert.equal(wrong.result.isError, true);
    assert.equal(runtime.trace.filter((entry) => entry.kind === "named-workflow-effect").length, 1);
  });

  it("records the caller's actual named-workflow arguments", async () => {
    const runtime = runtimeFor(fixtureFrom(developmentSuite, "named-workflow-policy"));
    await executeCall(runtime, {
      action: "execute",
      input: { workflow: "run-ci", args: { command: "npm test", unexpected: true } },
    });
    const effect = runtime.trace.find((entry) => entry.kind === "named-workflow-effect");
    assert.deepEqual(effect?.args, { command: "npm test", unexpected: true });
  });

  it("loads workflowScriptPath from the fixture file table and distinguishes it from inline scripts", async () => {
    const runtime = runtimeFor(
      fixtureFrom(capabilitySuite, "capability-workflow-script-file"),
      capabilitySuite.discovery.agents,
    );
    const viaPath = await executeCall(runtime, {
      action: "execute",
      input: { workflowScriptPath: "plans/review.js" },
    });
    assert.equal(viaPath.result.isError, undefined);
    assert.ok(
      runtime.trace.some(
        (entry) => entry.kind === "workflow-script-path" && entry.path === "plans/review.js",
      ),
    );
    assert.ok(
      runtime.trace.some((entry) => entry.kind === "workflow-child" && entry.agent === "reviewer"),
    );
    assert.equal(
      runtime.trace.some((entry) => entry.kind === "workflow-script"),
      false,
    );

    const missing = await executeCall(runtime, {
      action: "execute",
      input: { workflowScriptPath: "plans/missing.js" },
    });
    assert.equal(missing.result.isError, true);
  });

  it("answers writer-review-fix child responses positionally without consulting model output", async () => {
    const runtime = runtimeFor(fixtureFrom(developmentSuite, "writer-review-fix"));
    const executed = await executeCall(runtime, {
      action: "execute",
      input: {
        workflowScript: [
          'const w = await runs.run("impl", {agent:"worker", task:"Implement bounded payment retries"})',
          'const r = await runs.run("rev", {agent:"reviewer", task:"Review the retry implementation", context:"fresh"})',
          'if (r.structuredOutput?.verdict === "defect") { return await runs.run("fix", {agent:"worker", task:"Fix the timeout counter reset"}) }',
          "return r",
        ].join("; "),
      },
    });
    const payload = JSON.parse(executed.text);
    assert.match(payload.value.output, /Fixed the timeout counter reset/);
    const reviewer = payload.children.find(
      (child: { agent?: string }) => child.agent === "reviewer",
    );
    assert.equal(reviewer?.structuredOutput?.verdict, "defect");
    assert.equal(reviewer?.resolvedContext, "fresh");
  });

  it("denies raw runs.host attempts with the provenance code before any dispatch", async () => {
    const runtime = runtimeFor(
      fixtureFrom(heldOutSuite, "held-out-raw-host-denial"),
      heldOutSuite.discovery.agents,
    );
    const executed = await executeCall(runtime, {
      action: "execute",
      input: {
        workflowScript:
          'return await runs.host("tests", {kind:"command", command:"npm test", timeoutMs: 1000})',
      },
    });
    assert.equal(executed.result.isError, true);
    assert.match(executed.text, /unknown_resource_provenance/);
    assert.match(executed.text, /no command was dispatched/);
    const entry = runtime.trace.find((traceEntry) => traceEntry.kind === "host-effect");
    assert.ok(entry !== undefined && entry.kind === "host-effect");
    assert.equal(entry.code, "unknown_resource_provenance");
    assert.equal(entry.dispatched, false);
    assert.equal(
      runtime.trace.some(
        (entry2) => entry2.kind === "workflow-child" || entry2.kind === "direct-child",
      ),
      false,
    );
  });

  it("routes conditional structured workflows through the fake verdict table", async () => {
    const fixture = fixtureFrom(heldOutSuite, "held-out-conditional-structured-routing");
    const runtime = runtimeFor(fixture, fixture.discoveryAgents);
    const executed = await executeCall(runtime, {
      action: "execute",
      input: {
        workflowScript: [
          'const verdict = await runs.run("route", {agent:"router", task:"Is ticket T-17 urgent?", outputSchema: {type:"object", required:["urgent"], properties:{urgent:{type:"boolean"}}}})',
          'if (verdict.structuredOutput?.urgent) { return await runs.run("respond", {agent:"incident-responder", task:"Respond to T-17"}) }',
          'return await runs.run("file", {agent:"archivist", task:"File T-17"})',
        ].join("; "),
      },
    });
    const payload = JSON.parse(executed.text);
    assert.equal(payload.value.output, "PAGE-ONCALL");
    const launchedAgents = runtime.trace
      .filter((entry) => entry.kind === "workflow-child")
      .map((entry) => (entry.kind === "workflow-child" ? entry.agent : undefined));
    assert.deepEqual(launchedAgents, ["router", "incident-responder"]);
  });
});
