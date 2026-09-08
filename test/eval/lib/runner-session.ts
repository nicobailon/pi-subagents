/**
 * One attempted model session for the paired catalog evaluation.
 *
 * A fresh in-memory AgentSession exposes only the variant's published subagent
 * tool. The session's extension hook classifies every tool call before the
 * fake runtime (this is the real AgentSession hook path: policy-allow and
 * policy-deny trace entries during model sessions come from it), the provider
 * payload is captured raw before each request, and turn-cap versus wall-clock
 * aborts are tracked as distinct flags. No real child, shell, host command,
 * schedule, repository mutation, or publication is ever executed.
 */

import { classifyEvalOutcome } from "./classify-outcome.ts";
import { classifyExecutionAgainstFixturePolicy } from "./policy-probe.ts";
import { createFakeSubagentRuntime } from "./fake-runtime.ts";
import { evaluateScenarioOutcome } from "./suite-predicates.ts";
import type {
  CanonicalRequest,
  CanonicalizeResult,
  DiscoveryAgentRow,
  FirstCallRecord,
  FirstLaunchRecord,
  EffectTraceEntry,
  EvalFixture,
  FakeToolResult,
  JsonRecord,
  JsonValue,
  PublishedToolDefinition,
  ProviderUsageTotals,
  SessionAttemptMetrics,
  ToolCallRecord,
  VariantKind,
} from "./eval-types.ts";
import type { LoadedVariant } from "./variant-modules.ts";

/** Structural view of the production Pi SDK entry the runner uses. */
export interface PiSdkHandle {
  createAgentSession: (options: JsonRecord) => Promise<AgentSessionResult>;
  DefaultResourceLoader: new (options: JsonRecord) => ResourceLoaderHandle;
  defineTool: (definition: JsonRecord) => JsonRecord;
  getAgentDir: () => string;
  SessionManager: { inMemory: (cwd: string) => JsonRecord };
  SettingsManager: { inMemory: (settings: JsonRecord) => JsonRecord };
  ModelRuntime: { create: (options: JsonRecord) => Promise<JsonRecord> };
  resolveCliModel: (options: JsonRecord) => ResolvedCliModel;
}

export interface ResolvedCliModel {
  error?: string;
  model?: ModelView;
  thinkingLevel?: string;
}

export interface ModelView {
  provider: string;
  id: string;
  maxTokens?: number;
}

export interface ResourceLoaderHandle {
  reload: () => Promise<void>;
}

export interface AgentSessionResult {
  session: AgentSessionHandle;
  extensionsResult: { errors: unknown[] };
}

export interface EvalSessionLifecycleHandle {
  dispose: () => void;
  readonly extensionRunner: {
    emit: (event: JsonRecord) => Promise<JsonValue | undefined>;
  };
}

export interface AgentSessionHandle extends EvalSessionLifecycleHandle {
  prompt: (text: string) => Promise<void>;
  abort: () => Promise<void> | void;
  subscribe: (listener: (event: SessionEventView) => void) => () => void;
  readonly messages: SessionMessageView[];
  readonly agent: { readonly state: { readonly systemPrompt: string } };
}

/** Emit extension cleanup before releasing an SDK session. */
export async function shutdownEvalAgentSession(
  session: EvalSessionLifecycleHandle,
): Promise<string | undefined> {
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    return undefined;
  } catch (error) {
    return `session shutdown failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    session.dispose();
  }
}

export interface SessionEventView {
  readonly type: string;
}

export interface SessionMessageView {
  role: string;
  content: ReadonlyArray<{ type: string; text?: string }>;
  usage?: UsageView;
  stopReason?: string;
  errorMessage?: string;
}

export interface UsageView {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export interface SessionAttemptContext {
  fixture: EvalFixture;
  discoveryAgents: DiscoveryAgentRow[];
  variant: LoadedVariant;
  variantOrder: VariantKind[];
  model: ModelView;
  modelLabel: string;
  thinkingLevel: string;
  repetition: number;
  attemptIndex: number;
  suite: string;
  piSdk: PiSdkHandle;
  modelRuntime: JsonRecord;
  providerExtensionPaths: string[];
  options: {
    maxTurns: number;
    timeoutMs: number;
    systemPrompt: string;
    recordMessages: boolean;
  };
  sessionDir: string;
}

function assistantText(messages: ReadonlyArray<SessionMessageView>): string {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function usageTotals(messages: ReadonlyArray<SessionMessageView>): ProviderUsageTotals {
  const totals: ProviderUsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const usage = message.usage;
    if (usage === undefined) {
      continue;
    }
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.totalTokens += usage.totalTokens ?? 0;
  }
  return totals;
}

function launchFormOf(request: CanonicalRequest): string | undefined {
  if (request.kind !== "execute") {
    return undefined;
  }
  const params = request.params;
  if (params.agent !== undefined) {
    return "direct";
  }
  if (params.workflowScript !== undefined) {
    return "workflow-script";
  }
  if (params.workflowScriptPath !== undefined) {
    return "workflow-script-path";
  }
  if (params.workflow !== undefined) {
    return "named-workflow";
  }
  return undefined;
}

interface CallClassification {
  parsed: CanonicalizeResult;
  denied: boolean;
}

function textResult(text: string, isError = false): FakeToolResult {
  const content: FakeToolResult["content"] = [{ type: "text", text }];
  if (isError) {
    return { content, isError: true };
  }
  return { content };
}

function setupFailureMetrics(
  context: SessionAttemptContext,
  promptError: string,
  published: PublishedToolDefinition,
): SessionAttemptMetrics {
  const classification = classifyEvalOutcome({
    sessionCreated: false,
    promptError,
    turnLimitHit: false,
    wallTimeoutHit: false,
    semanticEvaluated: false,
    semanticPass: false,
    prohibitedEffects: [],
  });
  return {
    fixtureId: context.fixture.id,
    suite: context.suite,
    variant: context.variant.kind === "catalog" ? "candidate" : "baseline",
    variantOrder: context.variantOrder,
    model: context.modelLabel,
    repetition: context.repetition,
    attemptIndex: context.attemptIndex,
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
    turns: 0,
    turnLimitHit: false,
    wallTimeoutHit: false,
    promptError,
    outcome: classification.outcome,
    outcomeReason: classification.reason,
    semanticPass: false,
    semanticReasons: ["session never started"],
    firstCall: null,
    firstLaunch: null,
    invalidCalls: 0,
    helpCalls: 0,
    discoveryCalls: 0,
    toolCalls: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    effectTrace: [],
    prohibitedEffects: [],
    finalText: "",
    assembledSystemPrompt: "",
    publishedToolDefinition: published,
    providerPayloads: [],
  };
}

/** Run one session attempt and reduce it to metrics plus raw payloads. */
export async function runSessionAttempt(
  context: SessionAttemptContext,
): Promise<SessionAttemptMetrics> {
  const { fixture, variant, piSdk } = context;
  const runtime = createFakeSubagentRuntime(fixture, context.discoveryAgents, {
    runWorkflowScript: variant.runWorkflowScript,
    validateWorkflowScript: variant.validateWorkflowScript,
    renderHelp: variant.renderHelp,
  });
  const toolCalls: ToolCallRecord[] = [];
  const providerPayloads: JsonValue[] = [];
  let currentTurn = 0;
  let turnLimitHit = false;
  let wallTimeoutHit = false;
  let promptError: string | undefined;
  let session: AgentSessionHandle | null = null;

  const callClassification = (call: JsonRecord): CallClassification => {
    const parsed = variant.canonicalize(call);
    if (!parsed.ok) {
      return { parsed, denied: true };
    }
    if (fixture.policy !== undefined && parsed.request.kind === "execute") {
      const decision = classifyExecutionAgainstFixturePolicy(parsed.request, fixture.policy);
      if (!decision.allow) {
        return { parsed, denied: true };
      }
    }
    return { parsed, denied: false };
  };

  const subagentTool = piSdk.defineTool({
    name: "subagent",
    label: "Subagent fixture",
    description: variant.description,
    parameters: variant.publishedDefinition.parameters,
    async execute(_id: string, call: JsonRecord): Promise<FakeToolResult> {
      const { parsed, denied } = callClassification(call);
      if (!parsed.ok) {
        return textResult(parsed.error, true);
      }
      if (denied) {
        return textResult("Fixture policy denied this request before any effect.", true);
      }
      return runtime.execute(parsed.request);
    },
  });

  const captureExtension = {
    name: `catalog-eval-policy-${variant.kind}`,
    factory(pi: ExtensionApiView): void {
      pi.on("before_provider_request", (event: ProviderRequestEventView) => {
        providerPayloads.push(event.payload);
      });
      pi.on("tool_call", (event: ToolCallEventView): HookResultView | undefined => {
        if (event.toolName !== "subagent") {
          return undefined;
        }
        const { parsed, denied } = callClassification(event.input);
        const action =
          parsed.ok && parsed.request.kind !== "help"
            ? parsed.request.params.action
            : parsed.ok
              ? "help"
              : undefined;
        toolCalls.push({
          index: toolCalls.length,
          turn: currentTurn,
          call: event.input,
          parsed: parsed.ok,
          error: parsed.ok ? undefined : parsed.error,
          policyDenied: parsed.ok && denied,
          action,
          form: parsed.ok ? launchFormOf(parsed.request) : undefined,
        });
        if (!parsed.ok) {
          runtime.record({ kind: "parse-denied", error: parsed.error });
          return { block: true, reason: parsed.error };
        }
        if (parsed.request.kind === "execute" && fixture.policy !== undefined) {
          const decision = classifyExecutionAgainstFixturePolicy(parsed.request, fixture.policy);
          if (!decision.allow) {
            runtime.record({ kind: "policy-deny", reason: decision.reason });
            return { block: true, reason: decision.reason };
          }
          runtime.record({ kind: "policy-allow" });
        }
        return undefined;
      });
    },
  };

  const settingsManager = piSdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  try {
    const loader = new piSdk.DefaultResourceLoader({
      cwd: context.sessionDir,
      agentDir: piSdk.getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: context.providerExtensionPaths,
      systemPrompt: context.options.systemPrompt,
      appendSystemPrompt: [],
      extensionFactories: [captureExtension],
    });
    await loader.reload();
    const created = await piSdk.createAgentSession({
      cwd: context.sessionDir,
      model: context.model,
      thinkingLevel: context.thinkingLevel,
      modelRuntime: context.modelRuntime,
      resourceLoader: loader,
      sessionManager: piSdk.SessionManager.inMemory(context.sessionDir),
      settingsManager,
      customTools: [subagentTool],
      tools: ["subagent"],
      noTools: "builtin",
    });
    session = created.session;
    if (created.extensionsResult.errors.length > 0) {
      const setupError = `session setup failed: ${JSON.stringify(created.extensionsResult.errors)}`;
      const shutdownError = await shutdownEvalAgentSession(session);
      promptError = shutdownError === undefined ? setupError : `${setupError}; ${shutdownError}`;
      session = null;
    }
  } catch (error) {
    promptError = `session setup failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (session === null) {
    return setupFailureMetrics(
      context,
      promptError ?? "session setup failed",
      variant.publishedDefinition,
    );
  }

  const startedAtMs = Date.now();
  const assembledSystemPrompt = session.agent.state.systemPrompt;
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "turn_start") {
      return;
    }
    currentTurn += 1;
    if (currentTurn > context.options.maxTurns) {
      turnLimitHit = true;
      void session?.abort();
    }
  });
  const timer = setTimeout(() => {
    wallTimeoutHit = true;
    void session?.abort();
  }, context.options.timeoutMs);
  try {
    await session.prompt(fixture.prompt);
  } catch (error) {
    promptError = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
  const messages = session.messages;
  unsubscribe();
  promptError ??= await shutdownEvalAgentSession(session);

  const finalText = assistantText(messages);
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  const semantic = evaluateScenarioOutcome(fixture, runtime.trace, finalText);
  const prohibitedEffects: EffectTraceEntry[] = semantic.prohibitedEffects;
  const classification = classifyEvalOutcome({
    sessionCreated: true,
    promptError,
    lastAssistantStopReason: lastAssistant?.stopReason,
    lastAssistantErrorMessage: lastAssistant?.errorMessage,
    turnLimitHit,
    wallTimeoutHit,
    semanticEvaluated: semantic.evaluated,
    semanticPass: semantic.pass,
    prohibitedEffects,
  });
  const firstCallRecord: FirstCallRecord | null = firstCallRecordFrom(toolCalls);
  const firstLaunchRecord: FirstLaunchRecord | null = firstLaunchRecordFrom(toolCalls);
  return {
    fixtureId: fixture.id,
    suite: context.suite,
    variant: variant.kind === "catalog" ? "candidate" : "baseline",
    variantOrder: context.variantOrder,
    model: context.modelLabel,
    repetition: context.repetition,
    attemptIndex: context.attemptIndex,
    startedAt: new Date(startedAtMs).toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    turns: assistantMessages.length,
    turnLimitHit,
    wallTimeoutHit,
    promptError,
    lastAssistantStopReason: lastAssistant?.stopReason,
    outcome: classification.outcome,
    outcomeReason: classification.reason,
    semanticPass: semantic.evaluated && semantic.pass,
    semanticReasons: semantic.reasons,
    firstCall: firstCallRecord,
    firstLaunch: firstLaunchRecord,
    invalidCalls: toolCalls.filter((call) => !call.parsed || call.policyDenied).length,
    helpCalls: runtime.trace.filter((entry) => entry.kind === "help").length,
    discoveryCalls: runtime.trace.filter((entry) => entry.kind === "discovery").length,
    toolCalls,
    usage: usageTotals(messages),
    effectTrace: runtime.trace,
    prohibitedEffects,
    finalText,
    assembledSystemPrompt,
    publishedToolDefinition: variant.publishedDefinition,
    providerPayloads,
  };
}

/** Reduce the first recorded call to its validity record. */
function firstCallRecordFrom(toolCalls: ReadonlyArray<ToolCallRecord>): FirstCallRecord | null {
  const first = toolCalls[0];
  if (first === undefined) {
    return null;
  }
  return {
    index: first.index,
    valid: first.parsed && !first.policyDenied,
    action: first.action,
    error: first.error,
  };
}

/** Reduce the first launch-form call to its validity and turn record. */
function firstLaunchRecordFrom(toolCalls: ReadonlyArray<ToolCallRecord>): FirstLaunchRecord | null {
  const first = toolCalls.find(
    (call) => call.form !== undefined && call.parsed && !call.policyDenied,
  );
  if (first === undefined) {
    return null;
  }
  return {
    index: first.index,
    turn: first.turn,
    valid: first.parsed && !first.policyDenied,
    form: first.form,
  };
}

/** Minimal extension API view the capture extension registers against. */
export interface ExtensionApiView {
  on: (
    event: "before_provider_request" | "tool_call",
    handler: (event: ProviderRequestEventView | ToolCallEventView) => HookResultView | void,
  ) => void;
}

export interface ProviderRequestEventView {
  type: "before_provider_request";
  payload: JsonValue;
}

export interface ToolCallEventView {
  type: "tool_call";
  toolName: string;
  input: JsonRecord;
}

export interface HookResultView {
  block: boolean;
  reason: string;
}
