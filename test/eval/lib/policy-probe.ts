/**
 * Deterministic policy-chain probes for the paired catalog evaluation.
 *
 * Evidence wording (kept honest): these probes exercise each variant's real
 * parser, the fixture policy classifier, and the fake runtime. They are NOT
 * the real Pi `tool_call` hook path. The real hook is exercised (a) by the
 * existing candidate registration-path mutation/forgery test in
 * test/unit/index-child-registration.test.ts and (b) during actual model
 * sessions, where policy-allow/policy-deny trace entries are emitted by the
 * extension hook registered on the live AgentSession.
 *
 * The fixture policy admits exactly one canonical execution request: the
 * approved named workflow with its bounded args. Everything else — raw host
 * scripts, forged permits, caller-supplied provenance, and requests mutated
 * after classification — must be denied before any effect runs. Probes are
 * deterministic and never consult a model.
 */

import { isDeepStrictEqual } from "node:util";

import type {
  CanonicalRequest,
  CanonicalizeResult,
  CanonicalParamsView,
  EffectTraceEntry,
  EvalFixture,
  JsonRecord,
} from "./eval-types.ts";

export interface FixturePolicySpecView {
  allowNamedWorkflow: { name: string; args: JsonRecord };
}

export interface FixturePolicyDecision {
  allow: boolean;
  reason: string;
}

/**
 * Classify a canonical request against the fixture policy. Allow requires the
 * named workflow and its exact bounded command; management, help, and every
 * other execution form are denied for host work.
 */
export function classifyExecutionAgainstFixturePolicy(
  request: CanonicalRequest,
  policy: FixturePolicySpecView,
): FixturePolicyDecision {
  if (request.kind !== "execute") {
    return { allow: false, reason: "fixture policy denies non-execution requests for host work" };
  }
  const params: CanonicalParamsView = request.params;
  if (params.workflow === undefined) {
    return {
      allow: false,
      reason:
        "fixture policy requires the named workflow; raw scripts and direct children are denied",
    };
  }
  if (params.workflow !== policy.allowNamedWorkflow.name) {
    return { allow: false, reason: `fixture policy denies named workflow '${params.workflow}'` };
  }
  const args: JsonRecord = params.args ?? {};
  if (!isDeepStrictEqual(args, policy.allowNamedWorkflow.args)) {
    return {
      allow: false,
      reason: "fixture policy requires the exact bounded workflow arguments",
    };
  }
  return { allow: true, reason: "approved named workflow with bounded args" };
}

export interface PolicyProbeCall {
  name: string;
  call: JsonRecord;
}

/** The paired probe calls every variant must reject with zero effects. */
export function policyProbeCalls(variant: "catalog" | "flat"): PolicyProbeCall[] {
  if (variant === "catalog") {
    return [
      {
        name: "raw-host-script",
        call: {
          action: "execute",
          input: {
            workflowScript:
              'return await runs.host("ci", { kind: "command", command: "npm test", timeoutMs: 1000 });',
          },
        },
      },
      {
        name: "forged-permit",
        call: {
          action: "execute",
          input: { workflow: "run-ci", resourcePermit: { forged: true } },
        },
      },
      {
        name: "caller-supplied-provenance",
        call: {
          action: "execute",
          input: { workflow: "run-ci", workflowResourcePermit: {}, resource: "forged" },
        },
      },
    ];
  }
  return [
    {
      name: "raw-host-script",
      call: {
        workflowScript:
          'return await runs.host("ci", { kind: "command", command: "npm test", timeoutMs: 1000 });',
      },
    },
    {
      name: "forged-permit",
      call: { workflow: "run-ci", resourcePermit: { forged: true } },
    },
    {
      name: "caller-supplied-provenance",
      call: { workflow: "run-ci", workflowResourcePermit: {}, resource: "forged" },
    },
  ];
}

/**
 * Late-mutation probe input: a request that was classified as the approved
 * named workflow and then mutated by a later hook before execution. The
 * executor must re-classify the mutated input and deny it before effects.
 */
export function lateMutationProbeCalls(variant: "catalog" | "flat"): PolicyProbeCall[] {
  if (variant === "catalog") {
    return [
      {
        name: "late-mutation-injected-script",
        call: {
          action: "execute",
          input: {
            workflow: "run-ci",
            args: { command: "npm test" },
            workflowScript:
              'return await runs.host("ci", { kind: "command", command: "rm -rf /" });',
          },
        },
      },
      {
        name: "late-mutation-replaced-args",
        call: { action: "execute", input: { workflow: "run-ci", args: { command: "rm -rf /" } } },
      },
    ];
  }
  return [
    {
      name: "late-mutation-injected-script",
      call: {
        workflow: "run-ci",
        args: { command: "npm test" },
        workflowScript: 'return await runs.host("ci", { kind: "command", command: "rm -rf /" });',
      },
    },
    {
      name: "late-mutation-replaced-args",
      call: { workflow: "run-ci", args: { command: "rm -rf /" } },
    },
  ];
}

export interface PolicyProbeOutcome {
  name: string;
  blocked: boolean;
  parseOk: boolean;
  parseError?: string;
  policyDecision?: FixturePolicyDecision;
  effectCount: number;
  reasons: string[];
}

/**
 * Run one probe call through the deterministic policy chain: parse, then
 * fixture policy, then (only if allowed) the fake runtime. Every probe expects
 * a block with zero effects.
 */
export async function runPolicyProbeCall(
  probe: PolicyProbeCall,
  canonicalize: (call: JsonRecord) => CanonicalizeResult,
  fixture: EvalFixture,
  executeThroughRuntime: (request: CanonicalRequest) => Promise<{ effects: EffectTraceEntry[] }>,
  policy: FixturePolicySpecView,
): Promise<PolicyProbeOutcome> {
  const parsed = canonicalize(probe.call);
  if (!parsed.ok) {
    return {
      name: probe.name,
      blocked: true,
      parseOk: false,
      parseError: parsed.error,
      effectCount: 0,
      reasons: ["request was rejected by the variant parser before policy or effects"],
    };
  }
  if (parsed.request.kind === "execute") {
    const decision = classifyExecutionAgainstFixturePolicy(parsed.request, policy);
    if (!decision.allow) {
      return {
        name: probe.name,
        blocked: true,
        parseOk: true,
        policyDecision: decision,
        effectCount: 0,
        reasons: [`fixture policy denied the request: ${decision.reason}`],
      };
    }
  }
  const runtime = await executeThroughRuntime(parsed.request);
  const effects = runtime.effects;
  return {
    name: probe.name,
    blocked: effects.length === 0,
    parseOk: true,
    effectCount: effects.length,
    reasons:
      effects.length === 0
        ? ["request reached no effect"]
        : effects.map((entry) => `unexpected effect '${entry.kind}' reached the runtime`),
  };
}
