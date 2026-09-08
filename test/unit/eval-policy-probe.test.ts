import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { normalizePublicSubagentExecution } from "../../src/extension/public-execution.ts";
import { parseSubagentCatalogCall } from "../../src/extension/subagent-command-catalog.ts";
import {
  runWorkflowScript,
  validateWorkflowScript,
} from "../../src/workflows/scripted-workflow.ts";
import { decodeCanonicalParams, decodeSuiteDocument } from "../../test/eval/lib/decode.ts";
import { createFakeSubagentRuntime } from "../../test/eval/lib/fake-runtime.ts";
import type { FakeRuntimeServices } from "../../test/eval/lib/fake-runtime.ts";
import type {
  CanonicalRequest,
  CanonicalizeResult,
  EvalFixture,
  EvalSuiteDocument,
  VariantCall,
} from "../../test/eval/lib/eval-types.ts";
import {
  classifyExecutionAgainstFixturePolicy,
  lateMutationProbeCalls,
  policyProbeCalls,
  runPolicyProbeCall,
} from "../../test/eval/lib/policy-probe.ts";

const decodedSuite = decodeSuiteDocument(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../test/eval/fixtures/development-suite.json", import.meta.url)),
      "utf8",
    ),
  ),
);
if (!decodedSuite.ok) {
  throw new Error(decodedSuite.error);
}
const developmentSuite: EvalSuiteDocument = decodedSuite.document;

function namedWorkflowFixture(): EvalFixture {
  const fixture = developmentSuite.fixtures.find(
    (candidate) => candidate.id === "named-workflow-policy",
  );
  if (fixture === undefined) {
    throw new Error("missing named-workflow-policy fixture");
  }
  return fixture;
}

/** Flat-call canonicalizer mirroring the pinned baseline boundary. */
function flatCanonicalize(call: VariantCall): CanonicalizeResult {
  const normalized = normalizePublicSubagentExecution(call);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }
  const params = decodeCanonicalParams(normalized.params);
  if (params === null) {
    return { ok: false, error: "canonical params failed the boundary decoder" };
  }
  return {
    ok: true,
    request:
      params.action === undefined ? { kind: "execute", params } : { kind: "management", params },
  };
}

function services(): FakeRuntimeServices {
  return {
    runWorkflowScript: (options) => runWorkflowScript(options),
    validateWorkflowScript: (script) => validateWorkflowScript(script),
    renderHelp: () => ({ content: [{ type: "text", text: "help" }] }),
  };
}

async function probeAll(
  canonicalize: (call: VariantCall) => CanonicalizeResult,
  form: "catalog" | "flat",
) {
  const fixture = namedWorkflowFixture();
  if (fixture.policy === undefined) {
    throw new Error("fixture has no policy");
  }
  const outcomes = [];
  for (const probe of [...policyProbeCalls(form), ...lateMutationProbeCalls(form)]) {
    const runtime = createFakeSubagentRuntime(fixture, [], services());
    outcomes.push(
      await runPolicyProbeCall(
        probe,
        canonicalize,
        fixture,
        async (request: CanonicalRequest) => {
          await runtime.execute(request);
          return { effects: runtime.trace };
        },
        fixture.policy,
      ),
    );
  }
  return outcomes;
}

describe("fixture policy classification", () => {
  it("allows only the approved named workflow with its exact bounded command", () => {
    const policy = { allowNamedWorkflow: { name: "run-ci", args: { command: "npm test" } } };
    const allow = classifyExecutionAgainstFixturePolicy(
      {
        kind: "execute",
        params: { workflow: "run-ci", args: { command: "npm test" } },
      },
      policy,
    );
    assert.equal(allow.allow, true);

    const denied: CanonicalRequest[] = [
      { kind: "execute", params: { workflowScript: "return 1" } },
      { kind: "execute", params: { workflow: "run-ci", args: { command: "rm -rf /" } } },
      {
        kind: "execute",
        params: { workflow: "run-ci", args: { command: "npm test", timeoutMs: 1000 } },
      },
      { kind: "execute", params: { workflow: "deploy", args: { command: "npm test" } } },
      { kind: "execute", params: { agent: "scout", task: "t" } },
      { kind: "management", params: { action: "status", id: "r" } },
      { kind: "help" },
    ];
    for (const request of denied) {
      assert.equal(
        classifyExecutionAgainstFixturePolicy(request, policy).allow,
        false,
        JSON.stringify(request),
      );
    }
  });
});

describe("deterministic policy-chain probes block forged execution with zero effects", () => {
  it("catalog envelope probes are denied before any effect", async () => {
    const outcomes = await probeAll(parseSubagentCatalogCall, "catalog");
    assert.equal(outcomes.length, 5);
    for (const outcome of outcomes) {
      assert.equal(outcome.blocked, true, `${outcome.name}: ${outcome.reasons.join("; ")}`);
      assert.equal(outcome.effectCount, 0, outcome.name);
    }
    const forged = outcomes.find((outcome) => outcome.name === "forged-permit");
    assert.equal(forged?.parseOk, false);
    const rawScript = outcomes.find((outcome) => outcome.name === "raw-host-script");
    assert.equal(rawScript?.parseOk, true);
    assert.equal(rawScript?.policyDecision?.allow, false);
    const mutated = outcomes.find((outcome) => outcome.name === "late-mutation-replaced-args");
    assert.equal(mutated?.policyDecision?.allow, false);
  });

  it("flat baseline probes are denied before any effect", async () => {
    const outcomes = await probeAll(flatCanonicalize, "flat");
    assert.equal(outcomes.length, 5);
    for (const outcome of outcomes) {
      assert.equal(outcome.blocked, true, `${outcome.name}: ${outcome.reasons.join("; ")}`);
      assert.equal(outcome.effectCount, 0, outcome.name);
    }
  });

  it("the approved named workflow still reaches exactly one fake effect", async () => {
    const fixture = namedWorkflowFixture();
    const runtime = createFakeSubagentRuntime(fixture, [], services());
    const parsed = parseSubagentCatalogCall({
      action: "execute",
      input: { workflow: "run-ci", args: { command: "npm test" } },
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    const request: CanonicalRequest =
      parsed.request.kind === "help"
        ? { kind: "help" }
        : parsed.request.kind === "management"
          ? { kind: "management", params: decodeCanonicalParams(parsed.request.params) ?? {} }
          : { kind: "execute", params: decodeCanonicalParams(parsed.request.params) ?? {} };
    const result = await runtime.execute(request);
    const first = result.content[0];
    assert.ok(first !== undefined && first.type === "text");
    assert.match(first.text, /exit code 0/);
    const effectKinds = runtime.trace.map((entry) => entry.kind);
    assert.deepEqual(effectKinds, ["named-workflow-effect"]);
  });
});

describe("evidence wording stays honest about what the probes cover", () => {
  it("documents the three permission-evidence tiers in the probe module header", async () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../test/eval/lib/policy-probe.ts", import.meta.url)),
      "utf8",
    );
    assert.match(source, /NOT[\s*]+the real Pi `tool_call` hook path/);
    assert.match(source, /index-child-registration\.test\.ts/);
    assert.match(source, /live AgentSession/);
  });
});
