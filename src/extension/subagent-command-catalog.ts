import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Compile } from "typebox/compile";
import type { Static } from "typebox";
import {
  isMutatingManagementAction,
  type SubagentParamsLike,
} from "../runs/foreground/subagent-executor.ts";
import { SUBAGENT_ACTIONS, type Details } from "../shared/types.ts";
import { normalizePublicSubagentExecution } from "./public-execution.ts";
import { SubagentCatalogParams, SubagentParams } from "./schemas.ts";

type SubagentParamKey = keyof typeof SubagentParams.properties;

interface SubagentCatalogOperation {
  readonly fields: readonly SubagentParamKey[];
  readonly required?: readonly SubagentParamKey[];
  readonly requiredAny?: readonly SubagentParamKey[];
  readonly summary: string;
}

const EXECUTE_FIELDS = [
  "agent",
  "task",
  "extensionBindings",
  "workflow",
  "args",
  "workflowScript",
  "workflowScriptPath",
  "globalConcurrencyLimit",
  "maxSubagentSpawnsPerRun",
  "preflight",
  "chatProgress",
  "isolation",
  "worktree",
  "baseRef",
  "lane",
  "context",
  "async",
  "timeoutMs",
  "maxRuntimeMs",
  "toolTimeoutMs",
  "toolBudget",
  "usageBudget",
  "agentScope",
  "cwd",
  "artifacts",
  "includeProgress",
  "share",
  "sessionDir",
  "control",
  "output",
  "outputMode",
  "skill",
  "model",
  "fast",
  "outputSchema",
  "agentContract",
  "acceptance",
  "gate",
  "missionId",
  "mission",
] as const satisfies readonly SubagentParamKey[];

const TARGET_FIELDS = [
  "id",
  "runId",
  "dir",
  "index",
] as const satisfies readonly SubagentParamKey[];
const AGENT_TARGET_FIELDS = [
  "agent",
  "agentScope",
  "cwd",
] as const satisfies readonly SubagentParamKey[];
const REQUIRED_RUN_TARGET = ["id", "runId", "dir"] as const satisfies readonly SubagentParamKey[];

const SUBAGENT_CATALOG_OPERATIONS = {
  execute: {
    fields: EXECUTE_FIELDS,
    summary: "Launch one child, run a workflow script/file, or invoke a named workflow resource.",
  },
  help: {
    fields: ["topic"],
    summary: "Show core guidance or one operation's exact input contract.",
  },
  list: {
    fields: ["capabilities", "agentScope", "cwd"],
    summary: "List configured agents; capabilities:true includes executable capability rows.",
  },
  get: { fields: AGENT_TARGET_FIELDS, required: ["agent"], summary: "Show one configured agent." },
  models: {
    fields: AGENT_TARGET_FIELDS,
    summary: "List model selectors, optionally for one agent.",
  },
  "children.list": { fields: [], summary: "List retained children and resumability." },
  guide: { fields: ["topic"], summary: "Read a bundled long-form guide topic." },
  validate: {
    fields: ["workflowScript", "workflowScriptPath", "preflight", "cwd"],
    summary: "Validate a workflow script without launching children.",
  },
  create: {
    fields: ["config", "cwd"],
    required: ["config"],
    summary: "Create an agent definition.",
  },
  update: {
    fields: ["agent", "agentScope", "config", "cwd"],
    required: ["agent", "config"],
    summary: "Update an agent definition.",
  },
  delete: {
    fields: AGENT_TARGET_FIELDS,
    required: ["agent"],
    summary: "Delete a custom agent definition.",
  },
  eject: {
    fields: AGENT_TARGET_FIELDS,
    required: ["agent"],
    summary: "Copy a bundled or package agent into a writable scope.",
  },
  disable: {
    fields: AGENT_TARGET_FIELDS,
    required: ["agent"],
    summary: "Disable an agent through a scoped override.",
  },
  enable: {
    fields: AGENT_TARGET_FIELDS,
    required: ["agent"],
    summary: "Remove a scoped disabled override.",
  },
  reset: {
    fields: AGENT_TARGET_FIELDS,
    required: ["agent"],
    summary: "Reset an agent to its bundled definition.",
  },
  "mission.create": {
    fields: ["mission", "missionStatus", "cwd"],
    required: ["mission"],
    summary: "Create a mission.",
  },
  "mission.list": {
    fields: ["missionScope", "cwd"],
    summary: "List project or globally indexed missions.",
  },
  "mission.show": {
    fields: ["missionId", "cwd"],
    required: ["missionId"],
    summary: "Show one mission.",
  },
  "mission.update": {
    fields: ["missionId", "missionUpdate", "cwd"],
    required: ["missionId", "missionUpdate"],
    summary: "Update mission metadata, evidence, decisions, or receipts.",
  },
  "mission.resolve-decision": {
    fields: ["missionId", "id", "summary", "cwd"],
    required: ["missionId", "id", "summary"],
    summary: "Resolve one mission decision.",
  },
  "mission.attach-run": {
    fields: ["missionId", "id", "runId", "dir", "runMode", "runStatus", "agent", "cwd"],
    required: ["missionId"],
    requiredAny: ["id", "runId"],
    summary: "Attach an existing run to a mission.",
  },
  "mission.close": {
    fields: ["missionId", "missionStatus", "summary", "cwd"],
    required: ["missionId"],
    summary: "Close a mission as completed, failed, or cancelled.",
  },
  "worktree.discard": {
    fields: ["handoffPath", "cwd"],
    required: ["handoffPath"],
    summary:
      "Discard preserved worktrees recorded in a handoff manifest, subject to authority policy.",
  },
  "worktree.cleanup": {
    fields: ["repo", "handoffPath", "mode", "cwd"],
    required: ["mode"],
    summary: "Plan worktree cleanup; apply/removal is not available.",
  },
  "lane.status": {
    fields: ["laneId", "handoffPath", "cwd"],
    required: ["laneId", "handoffPath"],
    summary: "Inspect stored lane evidence.",
  },
  "lane.recordMerge": {
    fields: ["laneId", "handoffPath", "merge", "cwd"],
    required: ["laneId", "handoffPath", "merge"],
    summary: "Record attested merge evidence for a lane.",
  },
  "lane.recordSupersession": {
    fields: ["laneId", "handoffPath", "supersession", "cwd"],
    required: ["laneId", "handoffPath", "supersession"],
    summary: "Record attested supersession evidence for a lane.",
  },
  refine: {
    fields: ["agent", "cwd"],
    required: ["agent"],
    summary: "Propose and write a bounded agent refinement overlay.",
  },
  "refine.show": {
    fields: ["agent", "cwd"],
    required: ["agent"],
    summary: "Show an agent refinement overlay.",
  },
  "refine.rollback": {
    fields: ["agent", "cwd"],
    required: ["agent"],
    summary: "Roll back an agent refinement overlay.",
  },
  "inspector.open": {
    fields: [...TARGET_FIELDS, "focus", "cwd"],
    requiredAny: REQUIRED_RUN_TARGET,
    summary: "Open a read-only Herdr inspector for an async run.",
  },
  "inspector.status": {
    fields: [...TARGET_FIELDS, "cwd"],
    requiredAny: REQUIRED_RUN_TARGET,
    summary: "Inspect a Herdr inspector binding.",
  },
  "inspector.close": {
    fields: [...TARGET_FIELDS, "cwd"],
    requiredAny: REQUIRED_RUN_TARGET,
    summary: "Close a Herdr inspector without stopping its run.",
  },
  "project.open": { fields: ["cwd", "message", "focus"], summary: "Open a Herdr project pane." },
  "project.status": { fields: ["cwd"], summary: "Inspect a Herdr project pane." },
  "project.close": { fields: ["cwd"], summary: "Close an idle Herdr project pane." },
  status: {
    fields: [...TARGET_FIELDS, "view", "lines", "cwd"],
    summary: "Inspect active or persisted run status, fleet, or transcript.",
  },
  "debug.run": {
    fields: [...TARGET_FIELDS, "cwd"],
    requiredAny: REQUIRED_RUN_TARGET,
    summary: "Inspect lifecycle diagnostics for one run.",
  },
  "grant-spawn-budget": {
    fields: ["additional"],
    required: ["additional"],
    summary: "Request an interactive root-session spawn budget grant.",
  },
  interrupt: { fields: ["id", "runId"], summary: "Interrupt a foreground or async run." },
  resume: {
    fields: [
      ...TARGET_FIELDS,
      "message",
      "baseRef",
      "worktree",
      "lane",
      "context",
      "agentScope",
      "cwd",
      "artifacts",
      "share",
      "skill",
      "fast",
      "output",
      "outputMode",
      "outputSchema",
      "agentContract",
      "acceptance",
      "timeoutMs",
      "maxRuntimeMs",
      "toolBudget",
      "control",
    ],
    required: ["message"],
    requiredAny: REQUIRED_RUN_TARGET,
    summary: "Resume a retained child while preserving its stored agent/model/tool contract.",
  },
  steer: {
    fields: [...TARGET_FIELDS, "message", "mode", "steeringRecovery", "cwd"],
    required: ["message"],
    requiredAny: REQUIRED_RUN_TARGET,
    summary: "Send live guidance, with optional pause-and-revive recovery.",
  },
  stop: {
    fields: ["id", "runId", "dir", "childId", "cwd"],
    requiredAny: REQUIRED_RUN_TARGET,
    summary: "Stop an async run or one stoppable workflow child.",
  },
  dismiss: {
    fields: ["id", "runId", "cwd"],
    requiredAny: ["id", "runId"],
    summary: "Dismiss a recovered terminal workflow from live state.",
  },
  doctor: {
    fields: ["context", "sessionDir", "cwd"],
    summary: "Report subagent runtime and configuration diagnostics.",
  },
  "watchdog.status": { fields: ["cwd"], summary: "Show watchdog runtime status." },
  "watchdog.check": {
    fields: ["cwd"],
    summary: "Check watchdog configuration and model availability.",
  },
  "watchdog.configure": {
    fields: ["scope", "target", "agent", "model", "thinking", "cwd"],
    summary: "Configure the watchdog model at session, user, or project scope.",
  },
  "watchdog.recommend-model": {
    fields: ["cwd"],
    summary: "Recommend a strong available watchdog model.",
  },
  "schedule.create": {
    fields: [
      "id",
      "name",
      "at",
      "every",
      "sessionOnly",
      "overlap",
      "catchUp",
      "workflowScript",
      "workflowScriptPath",
      "baseRef",
      "timeoutMs",
      "async",
      "acceptance",
      "cwd",
    ],
    summary: "Create a one-shot or fixed-interval workflow schedule.",
  },
  "schedule.list": { fields: ["cwd"], summary: "List schedules for a project." },
  "schedule.show": { fields: ["id", "cwd"], required: ["id"], summary: "Show one schedule." },
  "schedule.history": {
    fields: ["id", "cwd"],
    required: ["id"],
    summary: "Show one schedule's run history.",
  },
  "schedule.pause": { fields: ["id", "cwd"], required: ["id"], summary: "Pause a schedule." },
  "schedule.resume": {
    fields: ["id", "cwd"],
    required: ["id"],
    summary: "Resume a paused schedule.",
  },
  "schedule.run": { fields: ["id", "cwd"], required: ["id"], summary: "Run a schedule now." },
  "schedule.run-due": { fields: ["cwd"], summary: "Run due schedules for a project." },
  "schedule.delete": {
    fields: ["id", "cwd"],
    required: ["id"],
    summary: "Delete an idle schedule.",
  },
} as const satisfies Record<
  "execute" | "help" | (typeof SUBAGENT_ACTIONS)[number],
  SubagentCatalogOperation
>;

/** Untrusted host-boundary envelope candidate narrowed by the compiled catalog validator. */
export interface SubagentCatalogCallCandidate {
  readonly action?: unknown;
  readonly input?: unknown;
}

/** Model-facing compact subagent call parsed at the extension boundary. */
export type SubagentCatalogCall = Static<typeof SubagentCatalogParams>;

/** A parsed execute request ready for the canonical public executor. */
export interface SubagentCatalogExecuteRequest {
  kind: "execute";
  params: SubagentParamsLike;
}

/** A parsed management request ready for the canonical public executor. */
export interface SubagentCatalogManagementRequest {
  kind: "management";
  params: SubagentParamsLike;
}

/** A parsed informational request that never enters the executor. */
export interface SubagentCatalogHelpRequest {
  kind: "help";
  topic?: string;
}

/** Result of strict catalog parsing before any execution effect. */
export type SubagentCatalogParseResult =
  | {
      ok: true;
      request:
        | SubagentCatalogExecuteRequest
        | SubagentCatalogManagementRequest
        | SubagentCatalogHelpRequest;
    }
  | { ok: false; error: string };

const catalogCallValidator = Compile(SubagentCatalogParams);
const canonicalParamsValidator = Compile(SubagentParams);

function validationMessages(errors: Iterable<{ message: string }>): string {
  return (
    [...errors]
      .slice(0, 4)
      .map((error) => error.message)
      .join("; ") || "invalid input"
  );
}

function isSubagentCatalogAction(
  action: string,
): action is keyof typeof SUBAGENT_CATALOG_OPERATIONS {
  return Object.hasOwn(SUBAGENT_CATALOG_OPERATIONS, action);
}

/** Decode a host-boundary model call into the canonical executor request without granting authority. */
export function parseSubagentCatalogCall(
  call: SubagentCatalogCallCandidate,
): SubagentCatalogParseResult {
  if (!catalogCallValidator.Check(call)) {
    return {
      ok: false,
      error: `Invalid subagent command: ${validationMessages(catalogCallValidator.Errors(call))}`,
    };
  }
  if (!isSubagentCatalogAction(call.action)) {
    return {
      ok: false,
      error: `Unknown subagent action '${call.action}'. Use {action:'help'} to list actions.`,
    };
  }
  const operation: SubagentCatalogOperation = SUBAGENT_CATALOG_OPERATIONS[call.action];
  const input = call.input ?? {};
  const allowedFields = new Set<string>(operation.fields);
  const inappropriateFields = Object.keys(input).filter((field) => !allowedFields.has(field));
  if (inappropriateFields.length > 0) {
    return {
      ok: false,
      error: `Action '${call.action}' does not accept input field(s): ${inappropriateFields.join(", ")}.`,
    };
  }
  const missingFields = (operation.required ?? []).filter((field) => !Object.hasOwn(input, field));
  if (missingFields.length > 0) {
    return {
      ok: false,
      error: `Action '${call.action}' requires input field(s): ${missingFields.join(", ")}.`,
    };
  }
  const requiredAny = operation.requiredAny ?? [];
  if (
    requiredAny.length > 0 &&
    !requiredAny.some(
      (field) => Object.hasOwn(input, field) && input[field] !== undefined && input[field] !== "",
    )
  ) {
    return {
      ok: false,
      error: `Action '${call.action}' requires at least one input field from: ${requiredAny.join(", ")}.`,
    };
  }
  if (call.action === "help") {
    const helpCandidate = { action: "guide", ...input };
    if (!canonicalParamsValidator.Check(helpCandidate)) {
      return {
        ok: false,
        error: `Invalid input for action 'help': ${validationMessages(canonicalParamsValidator.Errors(helpCandidate))}`,
      };
    }
    if (helpCandidate.topic === undefined) {
      return { ok: true, request: { kind: "help" } };
    }
    return { ok: true, request: { kind: "help", topic: helpCandidate.topic } };
  }
  const candidate = call.action === "execute" ? { ...input } : { ...input, action: call.action };
  if (!canonicalParamsValidator.Check(candidate)) {
    return {
      ok: false,
      error: `Invalid input for action '${call.action}': ${validationMessages(canonicalParamsValidator.Errors(candidate))}`,
    };
  }
  // SAFETY: TypeBox checked the complete canonical schema immediately above.
  const params = candidate as SubagentParamsLike;
  const normalized = normalizePublicSubagentExecution(params);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }
  return call.action === "execute"
    ? { ok: true, request: { kind: "execute", params: normalized.params } }
    : { ok: true, request: { kind: "management", params: normalized.params } };
}

function operationInputHelp(action: keyof typeof SUBAGENT_CATALOG_OPERATIONS): string {
  const operation: SubagentCatalogOperation = SUBAGENT_CATALOG_OPERATIONS[action];
  const required = new Set<SubagentParamKey>(operation.required ?? []);
  const requiredAny = new Set<SubagentParamKey>(operation.requiredAny ?? []);
  const lines = [
    `subagent action: ${action}`,
    operation.summary,
    operation.fields.length === 0 ? "Input: omit input or pass {}." : "Input fields:",
  ];
  for (const field of operation.fields) {
    // SAFETY: operation fields are constrained to canonical parameter keys at their declarations.
    const property = SubagentParams.properties[field];
    const descriptionProperty = Object.getOwnPropertyDescriptor(property, "description");
    const description = descriptionProperty
      ? String(descriptionProperty.value)
      : "See the canonical runtime contract.";
    lines.push(
      `- ${String(field)}${required.has(field) ? " (required)" : requiredAny.has(field) ? " (one required target)" : " (optional)"}: ${description}`,
    );
  }
  if (operation.requiredAny?.length) {
    lines.push(`At least one target field is required: ${operation.requiredAny.join(", ")}.`);
  }
  lines.push("Unknown fields and fields belonging to other actions are rejected before execution.");
  return lines.join("\n");
}

const EXECUTE_HELP = `Execute
Choose exactly one launch form in input: {agent,task?}, {workflowScript}, {workflowScriptPath}, or {workflow,args?}. Native child options are checked against the selected runner before launch. Discovery is advisory; launch rechecks the executable agent, model, context, capability ceiling, budgets, acceptance, output, and worktree contract. Omitted async keeps the configured default; set async:true when background execution matters. Named workflow args are data, never permits. Use help topic workflows before advanced orchestration and help topic contract:execute for every accepted field.`;

const WORKFLOW_HELP = `Workflows
workflowScript is a JavaScript statement body with explicit return and top-level await. Choose the primitive by effect: await runs.run(key,{agent,task,...}) for one child; await runs.all([{key,agent,task,...},...]) for parallel children; await runs.host(key,{kind:'command',command:'...'}) for explicitly requested host execution. Only a named extension-owned workflow can receive a private host permit. A caller-authored runs.host call is denied before dispatch; never delegate a substitute host command through runs.run. runs.all returns an ordered array, so inspect each result before dependent work. Sequence dependent steps by awaiting each result before the next launch and branch on awaited contents such as a reviewer's structuredOutput verdict instead of launching ahead. To read structuredOutput, set outputSchema on that runs.run child before launch. Successful returned results/output are terminal; summarize them without status polling. Use one stable key per result lane; a changed call under the same key fails. Set output on children for durable files and return outputReference, outputPathMapping, or artifactPaths; task filename prose is not an output declaration. Use worktree:true for concurrent writers. Raw scripts have no filesystem, shell, Pi tools, or host authority. Help grants nothing. Retained resume uses runs.run(newKey,{resume:runId,task:followUp}) without agent or gate.`;

const CONTROL_HELP = `Control
status accepts optional id/runId/dir, view fleet|transcript, index, and lines 1..500. steer requires message plus id/runId/dir and optionally index or mode. resume requires message plus a retained target and keeps the stored child contract. stop targets an async run and optionally childId; interrupt targets foreground or async work. children.list reports resumability before resume. Stop cancels; it does not pause. External runner controls are rechecked. Control and help calls never grant workflow resource authority.`;

/** Parse the catalog exposed to fanout-authorized children using the executor's mutation policy. */
export function parseFanoutChildSubagentCatalogCall(
  call: SubagentCatalogCallCandidate,
): SubagentCatalogParseResult {
  const parsed = parseSubagentCatalogCall(call);
  if (!parsed.ok || parsed.request.kind !== "management") {
    return parsed;
  }
  const action = parsed.request.params.action;
  if (!isMutatingManagementAction(action)) {
    return parsed;
  }
  return {
    ok: false,
    error: `Action '${action ?? "unknown"}' is not available from child-safe subagent fanout mode.`,
  };
}

/** Render compact core help or a detailed operation contract from the same catalog definitions used for parsing. */
export function renderSubagentCatalogHelp(topic?: string): AgentToolResult<Details> {
  const normalizedTopic = topic?.trim();
  let text: string;
  if (!normalizedTopic || normalizedTopic === "overview") {
    text = [
      "Subagent command catalog",
      "Core topics: execute, workflows, control. Pass contract:<action> for exact input fields.",
      `Actions: ${Object.keys(SUBAGENT_CATALOG_OPERATIONS).join(", ")}`,
    ].join("\n");
  } else if (normalizedTopic === "execute") {
    text = EXECUTE_HELP;
  } else if (normalizedTopic === "workflows") {
    text = WORKFLOW_HELP;
  } else if (normalizedTopic === "control") {
    text = CONTROL_HELP;
  } else if (normalizedTopic.startsWith("contract:")) {
    const action = normalizedTopic.slice("contract:".length);
    if (!isSubagentCatalogAction(action)) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown subagent help topic '${normalizedTopic}'. Use {action:'help'} to list topics and actions.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    text = operationInputHelp(action);
  } else if (isSubagentCatalogAction(normalizedTopic)) {
    text = operationInputHelp(normalizedTopic);
  } else {
    return {
      content: [
        {
          type: "text",
          text: `Unknown subagent help topic '${normalizedTopic}'. Use {action:'help'} to list topics and actions.`,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  return { content: [{ type: "text", text }], details: { mode: "management", results: [] } };
}

/** Catalog actions, including execute and help, in their published order. */
export const SUBAGENT_COMMAND_CATALOG_ACTIONS = Object.freeze(
  Object.keys(SUBAGENT_CATALOG_OPERATIONS),
);
