/**
 * Ordered-trace fact collection shared by every suite predicate.
 *
 * Facts are reduced from the named trace-entry union by kind narrowing, so
 * they stay deterministic and unit-testable against synthetic traces.
 */

import type { LaunchForm } from "./eval-types.ts";
import type {
  EffectTraceEntry,
  EvalFixture,
  LaunchEntry,
  LaunchFailedEntry,
  ProhibitedLaunchEntry,
  StatusEntry,
  StopEntry,
  WorkflowAdmitEntry,
  WorkflowChildSummary,
  WorkflowResultEntry,
  WorkflowScriptEntry,
  WorkflowScriptPathEntry,
} from "./eval-types.ts";

export interface LaunchFact {
  index: number;
  form: LaunchForm;
  key: string;
  agent?: string;
  task: string;
  params: {
    async?: boolean;
    context?: string;
    resume?: string;
    model?: string;
    worktree?: boolean;
    isolation?: string;
  };
  output: string;
  structuredOutput?: import("./eval-types.ts").JsonRecord;
  hadOutputContract: boolean;
}

export interface SessionFacts {
  discovered: boolean;
  firstDiscoveryIndex: number | null;
  launches: Array<{ index: number; form: LaunchForm; kind: string }>;
  launchFacts: LaunchFact[];
  workflowChildren: LaunchFact[];
  directChildren: LaunchFact[];
  listedChildrenIndex: number | null;
  resumes: Array<{ index: number; id: string; message: string }>;
  steers: Array<{ index: number; id: string; message: string }>;
  stops: StopEntry[];
  statusCalls: StatusEntry[];
  modelsCalls: Array<{ index: number }>;
  getCalls: Array<{ index: number; agent?: string }>;
  validateCalls: Array<{ index: number; script: string; ok: boolean; diagnosticCode?: string }>;
  missionAttaches: Array<{ index: number; missionId: string; runId: string }>;
  missionShows: Array<{ index: number; missionId: string }>;
  scheduleCreates: Array<{ index: number; at?: string; hasWorkflowScript: boolean }>;
  namedEffects: Array<{
    index: number;
    workflow: string;
    args: import("./eval-types.ts").JsonRecord;
  }>;
  policyAllows: number[];
  policyDenies: number[];
  parseDenied: number[];
  workflowScriptExecutes: WorkflowScriptEntry[];
  workflowScriptPaths: WorkflowScriptPathEntry[];
  admittedBatches: WorkflowAdmitEntry[];
  workflowResults: WorkflowResultEntry[];
  hostEffects: Array<{ index: number; code: string; dispatched: boolean }>;
  helpCalls: number;
  discoveryCalls: number;
  finalText: string;
}

function launchFact(entry: LaunchEntry | LaunchFailedEntry | ProhibitedLaunchEntry): LaunchFact {
  const base = {
    index: entry.index,
    form: entry.form,
    key: entry.key,
    agent: entry.agent,
    task: entry.task,
    params: {
      async: entry.params.async,
      context: entry.params.context,
      resume: entry.params.resume,
      model: entry.params.model,
      worktree: entry.params.worktree,
      isolation: entry.params.isolation,
    },
  };
  if (entry.kind === "launch-failed" || entry.kind === "prohibited-launch") {
    return { ...base, output: "", hadOutputContract: false };
  }
  return {
    ...base,
    output: entry.output,
    structuredOutput: entry.structuredOutput,
    hadOutputContract: entry.hadOutputContract,
  };
}

export function collectSessionFacts(trace: EffectTraceEntry[], finalText: string): SessionFacts {
  const facts: SessionFacts = {
    discovered: false,
    firstDiscoveryIndex: null,
    launches: [],
    launchFacts: [],
    workflowChildren: [],
    directChildren: [],
    listedChildrenIndex: null,
    resumes: [],
    steers: [],
    stops: [],
    statusCalls: [],
    modelsCalls: [],
    getCalls: [],
    validateCalls: [],
    missionAttaches: [],
    missionShows: [],
    scheduleCreates: [],
    namedEffects: [],
    policyAllows: [],
    policyDenies: [],
    parseDenied: [],
    workflowScriptExecutes: [],
    workflowScriptPaths: [],
    admittedBatches: [],
    workflowResults: [],
    hostEffects: [],
    helpCalls: 0,
    discoveryCalls: 0,
    finalText,
  };
  for (const entry of trace) {
    switch (entry.kind) {
      case "discovery": {
        facts.discoveryCalls += 1;
        if (entry.capabilities) {
          facts.discovered = true;
          if (facts.firstDiscoveryIndex === null) {
            facts.firstDiscoveryIndex = entry.index;
          }
        }
        break;
      }
      case "help": {
        facts.helpCalls += 1;
        break;
      }
      case "direct-child":
      case "workflow-child": {
        const fact = launchFact(entry);
        facts.launches.push({ index: entry.index, form: entry.form, kind: entry.kind });
        facts.launchFacts.push(fact);
        if (entry.kind === "workflow-child") {
          facts.workflowChildren.push(fact);
        } else {
          facts.directChildren.push(fact);
        }
        break;
      }
      case "launch-failed":
      case "prohibited-launch": {
        facts.launches.push({ index: entry.index, form: entry.form, kind: entry.kind });
        facts.launchFacts.push(launchFact(entry));
        break;
      }
      case "children-list": {
        if (facts.listedChildrenIndex === null) {
          facts.listedChildrenIndex = entry.index;
        }
        break;
      }
      case "resume": {
        facts.resumes.push({ index: entry.index, id: entry.id, message: entry.message });
        break;
      }
      case "steer": {
        facts.steers.push({ index: entry.index, id: entry.id, message: entry.message });
        break;
      }
      case "stop": {
        facts.stops.push(entry);
        break;
      }
      case "status": {
        facts.statusCalls.push(entry);
        break;
      }
      case "models": {
        facts.modelsCalls.push({ index: entry.index });
        break;
      }
      case "get": {
        facts.getCalls.push({ index: entry.index, agent: entry.agent });
        break;
      }
      case "validate": {
        facts.validateCalls.push({
          index: entry.index,
          script: entry.script,
          ok: entry.ok,
          diagnosticCode: entry.diagnosticCode,
        });
        break;
      }
      case "mission-attach": {
        facts.missionAttaches.push({
          index: entry.index,
          missionId: entry.missionId,
          runId: entry.runId,
        });
        break;
      }
      case "mission-show": {
        facts.missionShows.push({ index: entry.index, missionId: entry.missionId });
        break;
      }
      case "schedule-create": {
        facts.scheduleCreates.push({
          index: entry.index,
          at: entry.at,
          hasWorkflowScript: entry.hasWorkflowScript,
        });
        break;
      }
      case "named-workflow-effect": {
        facts.namedEffects.push({ index: entry.index, workflow: entry.workflow, args: entry.args });
        break;
      }
      case "policy-allow": {
        facts.policyAllows.push(entry.index);
        break;
      }
      case "policy-deny": {
        facts.policyDenies.push(entry.index);
        break;
      }
      case "parse-denied": {
        facts.parseDenied.push(entry.index);
        break;
      }
      case "workflow-script": {
        facts.workflowScriptExecutes.push(entry);
        break;
      }
      case "workflow-script-path": {
        facts.workflowScriptPaths.push(entry);
        break;
      }
      case "workflow-admit": {
        facts.admittedBatches.push(entry);
        break;
      }
      case "workflow-result": {
        facts.workflowResults.push(entry);
        break;
      }
      case "host-effect": {
        facts.hostEffects.push({
          index: entry.index,
          code: entry.code,
          dispatched: entry.dispatched,
        });
        break;
      }
      default:
        break;
    }
  }
  return facts;
}

const PROHIBITED_KIND_ALIASES = {
  launch: ["direct-child", "workflow-child", "launch-failed"],
  steer: ["steer"],
  stop: ["stop"],
  resume: ["resume"],
  "schedule-run": ["schedule-run"],
  "workflow-script": ["workflow-script"],
  host: ["host-effect"],
} satisfies Record<string, readonly string[]>;

const GLOBALLY_PROHIBITED_KINDS: ReadonlySet<string> = new Set([
  "prohibited-launch",
  "unhandled-execution",
]);

/** Prohibited effects: global invariants plus the fixture's explicit list. */
export function collectProhibitedEffects(
  trace: EffectTraceEntry[],
  fixture: EvalFixture,
): EffectTraceEntry[] {
  const banned = new Set<string>(GLOBALLY_PROHIBITED_KINDS);
  for (const alias of fixture.prohibitedKinds ?? []) {
    for (const kind of PROHIBITED_KIND_ALIASES[alias] ?? [alias]) {
      banned.add(kind);
    }
  }
  return trace.filter((entry) => banned.has(entry.kind));
}

/** Children observed in workflow results, for fresh-context verification. */
export function workflowResultChildren(facts: SessionFacts): WorkflowChildSummary[] {
  return facts.workflowResults.flatMap((entry) => entry.children);
}
