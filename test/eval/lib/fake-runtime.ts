/**
 * Capability-realistic fake runtime for the paired catalog evaluation.
 *
 * Every response comes from a literal action/result table derived from the
 * decoded fixture document, never from model output. No real child, shell,
 * host command, schedule, repository mutation, or publication is ever
 * executed. Infrastructure failure injection is launch-form neutral: the first
 * launch attempt of any form (direct child, runs.run, runs.all) receives the
 * configured failure, and any further launch is recorded as a prohibited
 * effect instead of a fabricated success. Workflow launch form is derived
 * from the sandbox admission flag, so a later runs.run never inherits a prior
 * runs.all batch form.
 */

import { decodeCanonicalParams, decodeOutputProperty } from "./decode.ts";
import type {
  CanonicalParamsView,
  CanonicalRequest,
  TraceEntryInitializer,
  ChildResponseSpec,
  DiscoveryAgentRow,
  EffectTraceEntry,
  EvalFixture,
  FakeToolResult,
  LaunchForm,
  OutputContract,
  OutputSchemaView,
  WorkflowChildResultLike,
  WorkflowChildSummary,
} from "./eval-types.ts";
import type { JsonRecord } from "./json-value.ts";

export interface WorkflowSandboxAdmission {
  admitted: boolean;
  batch: boolean;
}

export interface WorkflowSandboxOptions {
  script: string;
  timeoutMs?: number;
  admit?: (calls: ReadonlyArray<{ key: string }>) => void;
  launch: (
    key: string,
    params: JsonRecord,
    admission: WorkflowSandboxAdmission,
  ) => Promise<WorkflowChildResultLike>;
  status: (keyOrRunId: string) => Promise<WorkflowChildResultLike>;
  resolveResume?: (reference: string) => string;
  host?: (key: string, params: JsonRecord) => Promise<never>;
}

export interface WorkflowSandboxResult {
  value: unknown;
  children: WorkflowChildSummary[];
}

/** Production workflow sandbox from the variant's own root, adapted once at the variant boundary. */
export type WorkflowSandbox = (options: WorkflowSandboxOptions) => Promise<WorkflowSandboxResult>;

export interface FakeRuntimeServices {
  runWorkflowScript: WorkflowSandbox;
  validateWorkflowScript: (script: string) => {
    ok: boolean;
    errors?: Array<{ message: string; line?: number }>;
  };
  renderHelp: (topic?: string) => FakeToolResult;
}

export interface FakeSubagentRuntime {
  execute: (request: CanonicalRequest) => Promise<FakeToolResult>;
  record: (entry: EffectTraceEntry) => void;
  trace: EffectTraceEntry[];
}

const HOST_DENIAL_CODE = "unknown_resource_provenance";

const GENERIC_GUIDE_TOPICS = [
  "Bundled guide topics: workflows, prompting-and-roles, constraints-and-recipes, execution-controls, management-authoring-rpc.",
  "The tool description and action help carry the compact contract; guides are long-form background only.",
].join("\n");

function textResult(text: string, isError = false): FakeToolResult {
  const content: FakeToolResult["content"] = [{ type: "text", text }];
  if (isError) {
    return { content, isError: true };
  }
  return { content };
}

interface StopRunState {
  runState: string;
  children: Array<{ id: string; state: string }>;
}

interface ChildResponseSelection {
  spec: ChildResponseSpec | undefined;
  groups: string[];
}

/** Build an isolated fake-effects runtime for one fixture and one fresh model session. */
export function createFakeSubagentRuntime(
  fixture: EvalFixture,
  discoveryAgents: DiscoveryAgentRow[],
  services: FakeRuntimeServices,
): FakeSubagentRuntime {
  const trace: EffectTraceEntry[] = [];
  let nextIndex = 0;
  const record = (entry: TraceEntryInitializer): EffectTraceEntry => {
    // SAFETY: every caller passes a complete literal for one union member;
    // this single recording seam only adds the monotonic trace index.
    const indexed = { index: nextIndex, ...entry } as EffectTraceEntry;
    nextIndex += 1;
    trace.push(indexed);
    return indexed;
  };

  let infrastructureFailureConsumed = false;
  const responseGroupCounts = new Map<string, number>();
  const attachedRuns = new Map<string, string[]>();
  const stopRunStates = new Map<string, StopRunState>();
  for (const [runId, row] of Object.entries(fixture.stopRuns ?? {})) {
    stopRunStates.set(runId, {
      runState: row.runState,
      children: row.children.map((child) => ({ id: child.id, state: child.state })),
    });
  }

  function agentsForFixture(): DiscoveryAgentRow[] {
    return fixture.discoveryAgents ?? discoveryAgents;
  }

  function outputContractSatisfied(
    contract: OutputContract,
    schema: OutputSchemaView | undefined,
  ): boolean {
    if (schema === undefined) {
      return false;
    }
    const required = schema.required ?? [];
    for (const field of contract.required) {
      if (!required.includes(field)) {
        return false;
      }
    }
    for (const [field, expectedType] of Object.entries(contract.fieldTypes ?? {})) {
      const property =
        schema.properties === undefined ? null : decodeOutputProperty(schema.properties[field]);
      if (property === null || property.type !== expectedType) {
        return false;
      }
    }
    for (const [field, allowed] of Object.entries(contract.enums ?? {})) {
      const property =
        schema.properties === undefined ? null : decodeOutputProperty(schema.properties[field]);
      if (property === null) {
        return false;
      }
      const enumValues = property.enum ?? [];
      for (const value of allowed) {
        if (!enumValues.includes(value)) {
          return false;
        }
      }
    }
    return true;
  }

  function selectChildResponse(agent: string | undefined, task: string): ChildResponseSelection {
    const responses = fixture.childResponses ?? [];
    const matching = responses.filter((spec) => {
      if (spec.when.agent !== undefined && spec.when.agent !== agent) {
        return false;
      }
      if (
        spec.when.taskMatches !== undefined &&
        !new RegExp(spec.when.taskMatches, "i").test(task)
      ) {
        return false;
      }
      return true;
    });
    const groups = [...new Set(matching.map((spec) => JSON.stringify(spec.when)))];
    const spec = matching.find((candidate) => {
      const group = JSON.stringify(candidate.when);
      const acceptedOccurrence = (responseGroupCounts.get(group) ?? 0) + 1;
      return acceptedOccurrence === (candidate.occurrence ?? 1);
    });
    return { spec, groups };
  }

  function launchChildRaw(
    form: LaunchForm,
    key: string,
    rawParams: JsonRecord,
  ): WorkflowChildResultLike {
    const params = decodeCanonicalParams(rawParams);
    if (params === null) {
      return {
        key,
        ok: false,
        output: "",
        error: "Fixture could not decode the child launch parameters.",
        artifactPaths: [],
      };
    }
    return launchChild(form, key, params);
  }

  function launchChild(
    form: LaunchForm,
    key: string,
    params: CanonicalParamsView,
  ): WorkflowChildResultLike {
    const failure = fixture.infrastructureFailure;
    if (failure !== undefined) {
      if (!infrastructureFailureConsumed) {
        infrastructureFailureConsumed = true;
        record({
          kind: "launch-failed",
          form,
          key,
          agent: params.agent,
          task: params.task ?? "",
          params,
          message: failure.message,
        });
        return { key, ok: false, output: "", error: failure.message, artifactPaths: [] };
      }
      record({
        kind: "prohibited-launch",
        form,
        key,
        agent: params.agent,
        task: params.task ?? "",
        params,
      });
      return {
        key,
        ok: false,
        output: "",
        error:
          "Fixture policy: an additional child launch after the infrastructure failure is prohibited. Report the infrastructure blocker instead of retrying or switching launch form.",
        artifactPaths: [],
      };
    }
    const agent = params.agent;
    const task = params.task ?? "";
    const response = selectChildResponse(agent, task);
    const spec = response.spec;
    const output = spec === undefined ? `Child ${agent ?? key} completed the task.` : spec.output;
    const contract = spec?.outputContract;
    if (contract !== undefined && !outputContractSatisfied(contract, params.outputSchema)) {
      record({ kind: "launch-rejected", form, key, agent, task, reason: "output-contract" });
      return {
        key,
        ok: false,
        output: "",
        error: `Child '${agent ?? key}' requires a structured output schema with required fields ${contract.required.join(", ")} before it can run.`,
        artifactPaths: [],
      };
    }
    for (const group of response.groups) {
      responseGroupCounts.set(group, (responseGroupCounts.get(group) ?? 0) + 1);
    }
    const context = params.context;
    const requestedContext = context === "fresh" || context === "fork" ? context : undefined;
    const resolvedContext = context === "fork" ? "fork" : "fresh";
    record({
      kind: form === "direct" ? "direct-child" : "workflow-child",
      form,
      key,
      agent,
      task,
      params,
      output,
      structuredOutput: spec?.structuredOutput,
      hadOutputContract: contract !== undefined,
    });
    return {
      key,
      ok: true,
      agent,
      runId: `fixture-${fixture.id}-${key}`,
      output,
      structuredOutput: spec?.structuredOutput,
      requestedContext,
      resolvedContext,
      artifactPaths: [],
      resumability: { state: "resumable" },
    };
  }

  async function runWorkflow(script: string): Promise<FakeToolResult> {
    try {
      const result = await services.runWorkflowScript({
        script,
        timeoutMs: 30_000,
        admit(calls) {
          record({ kind: "workflow-admit", keys: calls.map((call) => call.key) });
        },
        async launch(key, params, _signal, admission) {
          const form: LaunchForm = admission.batch ? "workflow-all" : "workflow-run";
          return launchChildRaw(form, key, params);
        },
        async status(keyOrRunId) {
          record({ kind: "workflow-status", keyOrRunId });
          return {
            key: keyOrRunId,
            ok: true,
            output: "Child is still running; its result is not terminal yet.",
            artifactPaths: [],
          };
        },
        resolveResume(reference) {
          record({ kind: "workflow-resolve-resume", reference });
          return reference;
        },
        async host(key) {
          record({ kind: "host-effect", key, code: HOST_DENIAL_CODE, dispatched: false });
          throw new Error(
            `Fixture host authority denied (${HOST_DENIAL_CODE}): raw workflow scripts cannot mint host-command authority; no command was dispatched.`,
          );
        },
      });
      record({ kind: "workflow-result", value: result.value, children: result.children });
      return textResult(JSON.stringify({ value: result.value, children: result.children }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record({ kind: "workflow-error", message });
      return textResult(`Workflow failed: ${message}`, true);
    }
  }

  function resolveScriptFile(scriptPath: string): string | null {
    const normalized = scriptPath.replace(/^\.\//u, "");
    const files = fixture.workflowScriptFiles ?? {};
    const script = Object.hasOwn(files, normalized) ? files[normalized] : undefined;
    return script === undefined ? null : script;
  }

  function missionRuns(missionId: string): string[] | null {
    const rows = fixture.missionRows ?? [];
    const row = rows.find((candidate) => candidate.missionId === missionId);
    if (row === undefined) {
      return null;
    }
    const attached = attachedRuns.get(missionId) ?? [];
    return [...row.runs, ...attached];
  }

  async function executeStatus(params: CanonicalParamsView): Promise<FakeToolResult> {
    const id = params.id ?? params.runId ?? params.dir ?? "";
    const structured = fixture.statusRuns?.[id];
    if (structured !== undefined) {
      const child =
        params.index === undefined
          ? undefined
          : structured.children.find((row) => row.index === params.index);
      if (params.index !== undefined && child === undefined) {
        record({
          kind: "status",
          id,
          view: params.view,
          index: params.index,
          lines: params.lines,
          returnedTail: [],
        });
        return textResult(`Run '${id}' has no child at index ${params.index}.`, true);
      }
      const source = child === undefined ? [] : child.transcript;
      const limit = params.lines ?? source.length;
      const tail = child === undefined ? [] : source.slice(-limit);
      record({
        kind: "status",
        id,
        view: params.view,
        index: params.index,
        lines: params.lines,
        returnedTail: tail,
      });
      return textResult(
        JSON.stringify({
          runId: structured.runId,
          status: structured.status,
          child: child === undefined ? undefined : { index: child.index, agent: child.agent },
          transcriptTail: tail,
          transcriptLines: source.length,
        }),
      );
    }
    const stoppable = stopRunStates.get(id);
    if (stoppable !== undefined) {
      record({
        kind: "status",
        id,
        view: params.view,
        index: params.index,
        lines: params.lines,
        returnedTail: [],
      });
      return textResult(
        JSON.stringify({
          runId: id,
          runState: stoppable.runState,
          children: stoppable.children,
        }),
      );
    }
    const legacy = fixture.statusResults?.[id];
    record({
      kind: "status",
      id,
      view: params.view,
      index: params.index,
      lines: params.lines,
      returnedTail: [],
    });
    if (legacy === undefined) {
      return textResult(`No run matches '${id}'.`, true);
    }
    return textResult(JSON.stringify(legacy));
  }

  async function executeStop(params: CanonicalParamsView): Promise<FakeToolResult> {
    const id = params.id ?? params.runId ?? "";
    const state = stopRunStates.get(id);
    if (state !== undefined) {
      const childId = params.childId;
      if (childId === undefined) {
        for (const child of state.children) {
          child.state = "stopped";
        }
        state.runState = "stopped";
      } else {
        const child = state.children.find((row) => row.id === childId);
        if (child === undefined) {
          recordStopped(id, childId, state);
          return textResult(`Run '${id}' has no child '${childId}'.`, true);
        }
        child.state = "stopped";
      }
      recordStopped(id, childId, state);
      return textResult(
        JSON.stringify({
          runId: id,
          childId,
          stoppedChildren: state.children
            .filter((child) => child.state === "stopped")
            .map((child) => child.id),
          runningChildren: state.children
            .filter((child) => child.state !== "stopped")
            .map((child) => child.id),
          runState: state.runState,
        }),
      );
    }
    const legacy = fixture.stopResults?.[id];
    record({
      kind: "stop",
      id,
      childId: params.childId,
      stoppedChildren: [],
      runningChildren: [],
      runState: "unknown",
    });
    if (legacy === undefined) {
      return textResult(`No stoppable run matches '${id}'.`, true);
    }
    return textResult(JSON.stringify(legacy));
  }

  function recordStopped(id: string, childId: string | undefined, state: StopRunState): void {
    record({
      kind: "stop",
      id,
      childId,
      stoppedChildren: state.children
        .filter((child) => child.state === "stopped")
        .map((child) => child.id),
      runningChildren: state.children
        .filter((child) => child.state !== "stopped")
        .map((child) => child.id),
      runState: state.runState,
    });
  }

  async function executeManagement(params: CanonicalParamsView): Promise<FakeToolResult> {
    const action = params.action ?? "";
    switch (action) {
      case "guide": {
        record({ kind: "help", topic: params.topic });
        return textResult(GENERIC_GUIDE_TOPICS);
      }
      case "list": {
        const capabilities = params.capabilities === true;
        record({ kind: "discovery", capabilities });
        if (!capabilities) {
          return textResult(
            JSON.stringify({
              agents: agentsForFixture().map((agent) => agent.name),
              note: "Call list with capabilities:true before launch to verify executable and non-disabled agents.",
            }),
          );
        }
        return textResult(JSON.stringify({ agents: agentsForFixture() }));
      }
      case "get": {
        record({ kind: "get", agent: params.agent });
        const row = agentsForFixture().find((candidate) => candidate.name === params.agent);
        if (row === undefined) {
          return textResult(`Unknown agent '${params.agent ?? ""}'.`, true);
        }
        return textResult(JSON.stringify(row));
      }
      case "models": {
        record({ kind: "models", agent: params.agent });
        const models = fixture.models ?? [
          { selector: "inherited/default", label: "inherited default model", costTier: "default" },
        ];
        return textResult(JSON.stringify({ agent: params.agent, models }));
      }
      case "children.list": {
        record({ kind: "children-list" });
        return textResult(JSON.stringify({ children: fixture.retainedRows ?? [] }));
      }
      case "resume": {
        const id = params.id ?? params.runId ?? "";
        const message = params.message ?? "";
        record({ kind: "resume", id, message });
        const direct = fixture.resumeResults?.[id];
        if (direct !== undefined) {
          return textResult(JSON.stringify(direct));
        }
        const retained = (fixture.retainedRows ?? []).find((row) => row.runId === id);
        if (retained === undefined) {
          return textResult(`No retained child matches '${id}'.`, true);
        }
        if (!retained.resumable) {
          return textResult(`Retained child '${id}' is not resumable; it is terminal.`, true);
        }
        return textResult(
          JSON.stringify({
            runId: id,
            status: "complete",
            output: `Retained child '${id}' continued.`,
          }),
        );
      }
      case "steer": {
        const id = params.id ?? params.runId ?? "";
        record({ kind: "steer", id, message: params.message ?? "" });
        const row = fixture.steerResults?.[id];
        if (row === undefined) {
          return textResult(`No live child matches '${id}' for steering.`, true);
        }
        return textResult(JSON.stringify(row));
      }
      case "stop":
        return executeStop(params);
      case "status":
        return executeStatus(params);
      case "mission.attach-run": {
        const missionId = params.missionId ?? "";
        const runId = params.runId ?? params.id ?? params.dir ?? "";
        record({ kind: "mission-attach", missionId, runId });
        if (missionRuns(missionId) === null) {
          return textResult(`No mission matches '${missionId}'.`, true);
        }
        const current = attachedRuns.get(missionId) ?? [];
        attachedRuns.set(missionId, [...current, runId]);
        return textResult(JSON.stringify({ attached: true, missionId, runId }));
      }
      case "mission.show": {
        const missionId = params.missionId ?? "";
        record({ kind: "mission-show", missionId });
        const runs = missionRuns(missionId);
        if (runs === null) {
          return textResult(`No mission matches '${missionId}'.`, true);
        }
        return textResult(JSON.stringify({ missionId, status: "active", runs }));
      }
      case "mission.list": {
        record({ kind: "mission-list" });
        return textResult(
          JSON.stringify({ missions: (fixture.missionRows ?? []).map((row) => row.missionId) }),
        );
      }
      case "schedule.create": {
        record({
          kind: "schedule-create",
          at: params.at,
          every: params.every,
          name: params.name,
          hasWorkflowScript:
            params.workflowScript !== undefined || params.workflowScriptPath !== undefined,
        });
        return textResult(
          JSON.stringify(
            fixture.scheduleCreateResult ?? {
              id: "sched-fixture",
              nextRunAt: "scheduled",
              status: "scheduled",
            },
          ),
        );
      }
      case "schedule.run": {
        record({ kind: "schedule-run", id: params.id });
        return textResult(
          "Fixture policy: schedules are never executed by the evaluation runtime.",
          true,
        );
      }
      case "schedule.list": {
        record({ kind: "schedule-list" });
        return textResult(JSON.stringify({ schedules: [] }));
      }
      case "validate": {
        const path = params.workflowScriptPath;
        const script =
          params.workflowScript ?? (path === undefined ? null : resolveScriptFile(path));
        if (script === null) {
          return textResult(
            "validate requires workflowScript or a known workflowScriptPath.",
            true,
          );
        }
        const validation = services.validateWorkflowScript(script);
        let diagnosticCode: string | undefined;
        let line: number | undefined;
        if (!validation.ok) {
          const first = validation.errors?.[0];
          if (
            first !== undefined &&
            /nested async|does not support nested async/i.test(first.message)
          ) {
            diagnosticCode = "nested_async_helper";
            line = first.line;
          }
        }
        record({ kind: "validate", script, path, ok: validation.ok, diagnosticCode, line });
        return textResult(
          JSON.stringify({
            ok: validation.ok,
            errors: validation.errors,
            diagnosticCode,
            line,
          }),
        );
      }
      default: {
        record({ kind: "management", action });
        return textResult(`Fixture does not implement management action '${action}'.`, true);
      }
    }
  }

  async function execute(request: CanonicalRequest): Promise<FakeToolResult> {
    if (request.kind === "help") {
      record({ kind: "help", topic: request.topic });
      return services.renderHelp(request.topic);
    }
    if (request.kind === "management") {
      return executeManagement(request.params);
    }
    const params = request.params;
    const workflowName = params.workflow;
    if (workflowName !== undefined) {
      const named = fixture.namedWorkflow;
      if (named === undefined || named.name !== workflowName) {
        record({ kind: "named-workflow-rejected", workflow: workflowName });
        return textResult(
          `Named workflow '${workflowName}' is not available in this fixture.`,
          true,
        );
      }
      record({ kind: "named-workflow-effect", workflow: workflowName, args: params.args ?? {} });
      return textResult(named.output);
    }
    const scriptPath = params.workflowScriptPath;
    if (scriptPath !== undefined) {
      const script = resolveScriptFile(scriptPath);
      if (script === null) {
        record({ kind: "workflow-script-path-missing", path: scriptPath });
        return textResult(`No workflow script file is available at '${scriptPath}'.`, true);
      }
      record({ kind: "workflow-script-path", path: scriptPath, async: params.async });
      return runWorkflow(script);
    }
    const script = params.workflowScript;
    if (script !== undefined) {
      record({ kind: "workflow-script", script, async: params.async });
      return runWorkflow(script);
    }
    if (params.agent !== undefined) {
      const child = launchChild("direct", "direct", params);
      return textResult(JSON.stringify(child), !child.ok);
    }
    record({ kind: "unhandled-execution" });
    return textResult("Fixture received an unsupported execution request.", true);
  }

  return { execute, record, trace };
}

/** Render the generic guide table used for baseline guide requests. */
export function renderGenericGuideTopics(): FakeToolResult {
  return textResult(GENERIC_GUIDE_TOPICS);
}
