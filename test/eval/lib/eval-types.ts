/**
 * Named contracts for the paired catalog evaluation.
 *
 * The harness compares a pinned baseline root with the current candidate root
 * using each root's actual published tool description, schema, parser, and
 * production workflow sandbox, driven by fake effects only. Everything the
 * harness records is one of the named types below; untrusted JSON crosses a
 * decoder (decode.ts) before it reaches these contracts.
 */

import type { JsonRecord, JsonValue } from "./json-value.ts";

/** Decoded view of the canonical executor params the harness depends on. */
export interface CanonicalParamsView {
  action?: string;
  agent?: string;
  task?: string;
  topic?: string;
  workflow?: string;
  args?: JsonRecord;
  workflowScript?: string;
  workflowScriptPath?: string;
  resume?: string;
  async?: boolean;
  capabilities?: boolean;
  id?: string;
  runId?: string;
  dir?: string;
  index?: number;
  lines?: number;
  view?: string;
  childId?: string;
  message?: string;
  missionId?: string;
  at?: string;
  every?: string;
  name?: string;
  context?: string;
  worktree?: boolean;
  isolation?: string;
  model?: string;
  outputSchema?: OutputSchemaView;
}

/** Decoded view of a structured-output JSON schema. */
export interface OutputSchemaView {
  required?: string[];
  properties?: JsonRecord;
}

/** Canonical request shape produced by either variant's parser. */
export interface CanonicalExecuteRequest {
  kind: "execute";
  params: CanonicalParamsView;
}

export interface CanonicalManagementRequest {
  kind: "management";
  params: CanonicalParamsView;
}

export interface CanonicalHelpRequest {
  kind: "help";
  topic?: string;
}

export type CanonicalRequest =
  | CanonicalExecuteRequest
  | CanonicalManagementRequest
  | CanonicalHelpRequest;

export type CanonicalizeResult =
  | { ok: true; request: CanonicalRequest }
  | { ok: false; error: string };

/** Untrusted model tool call before any parsing. */
export type VariantCall = JsonRecord;

/** Parser boundary each variant exposes to the harness. */
export type VariantCanonicalize = (call: VariantCall) => CanonicalizeResult;

export interface FakeToolResult {
  content: ReadonlyArray<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: JsonValue;
}

/** Launch forms the fake runtime distinguishes for reporting and predicates. */
export type LaunchForm = "direct" | "workflow-run" | "workflow-all";

export interface WorkflowChildSummary {
  key: string;
  ok: boolean;
  agent?: string;
  runId?: string;
  resolvedContext?: string;
  structuredOutput?: JsonRecord;
  error?: string;
}

/** Ordered effect trace entries; every kind has a named shape. */
export interface TraceBase {
  readonly index: number;
}

export interface DiscoveryEntry extends TraceBase {
  kind: "discovery";
  capabilities: boolean;
}

export interface HelpEntry extends TraceBase {
  kind: "help";
  topic?: string;
}

export interface GetEntry extends TraceBase {
  kind: "get";
  agent?: string;
}

export interface ModelsEntry extends TraceBase {
  kind: "models";
  agent?: string;
}

export interface ChildrenListEntry extends TraceBase {
  kind: "children-list";
}

export interface ResumeEntry extends TraceBase {
  kind: "resume";
  id: string;
  message: string;
}

export interface SteerEntry extends TraceBase {
  kind: "steer";
  id: string;
  message: string;
}

export interface StopEntry extends TraceBase {
  kind: "stop";
  id: string;
  childId?: string;
  stoppedChildren: string[];
  runningChildren: string[];
  runState: string;
}

export interface StatusEntry extends TraceBase {
  kind: "status";
  id: string;
  view?: string;
  index?: number;
  lines?: number;
  returnedTail: string[];
}

export interface MissionAttachEntry extends TraceBase {
  kind: "mission-attach";
  missionId: string;
  runId: string;
}

export interface MissionShowEntry extends TraceBase {
  kind: "mission-show";
  missionId: string;
}

export interface MissionListEntry extends TraceBase {
  kind: "mission-list";
}

export interface ScheduleCreateEntry extends TraceBase {
  kind: "schedule-create";
  at?: string;
  every?: string;
  name?: string;
  hasWorkflowScript: boolean;
}

export interface ScheduleRunEntry extends TraceBase {
  kind: "schedule-run";
  id?: string;
}

export interface ScheduleListEntry extends TraceBase {
  kind: "schedule-list";
}

export interface ValidateEntry extends TraceBase {
  kind: "validate";
  script: string;
  path?: string;
  ok: boolean;
  diagnosticCode?: string;
  line?: number;
}

export interface ManagementFallbackEntry extends TraceBase {
  kind: "management";
  action: string;
}

export interface LaunchEntry extends TraceBase {
  kind: "direct-child" | "workflow-child";
  form: LaunchForm;
  key: string;
  agent?: string;
  task: string;
  params: CanonicalParamsView;
  output: string;
  structuredOutput?: JsonRecord;
  hadOutputContract: boolean;
}

export interface LaunchFailedEntry extends TraceBase {
  kind: "launch-failed";
  form: LaunchForm;
  key: string;
  agent?: string;
  task: string;
  params: CanonicalParamsView;
  message: string;
}

export interface ProhibitedLaunchEntry extends TraceBase {
  kind: "prohibited-launch";
  form: LaunchForm;
  key: string;
  agent?: string;
  task: string;
  params: CanonicalParamsView;
}

export interface LaunchRejectedEntry extends TraceBase {
  kind: "launch-rejected";
  form: LaunchForm;
  key: string;
  agent?: string;
  task: string;
  reason: string;
}

export interface NamedWorkflowEffectEntry extends TraceBase {
  kind: "named-workflow-effect";
  workflow: string;
  args: JsonRecord;
}

export interface NamedWorkflowRejectedEntry extends TraceBase {
  kind: "named-workflow-rejected";
  workflow: string;
}

export interface WorkflowScriptEntry extends TraceBase {
  kind: "workflow-script";
  script: string;
  async?: boolean;
}

export interface WorkflowScriptPathEntry extends TraceBase {
  kind: "workflow-script-path";
  path: string;
  async?: boolean;
}

export interface WorkflowScriptPathMissingEntry extends TraceBase {
  kind: "workflow-script-path-missing";
  path: string;
}

export interface WorkflowAdmitEntry extends TraceBase {
  kind: "workflow-admit";
  keys: string[];
}

export interface WorkflowStatusEntry extends TraceBase {
  kind: "workflow-status";
  keyOrRunId: string;
}

export interface WorkflowResolveResumeEntry extends TraceBase {
  kind: "workflow-resolve-resume";
  reference: string;
}

export interface WorkflowResultEntry extends TraceBase {
  kind: "workflow-result";
  value: JsonValue;
  children: WorkflowChildSummary[];
}

export interface WorkflowErrorEntry extends TraceBase {
  kind: "workflow-error";
  message: string;
}

export interface HostEffectEntry extends TraceBase {
  kind: "host-effect";
  key: string;
  command?: string;
  code: string;
  dispatched: boolean;
}

export interface PolicyAllowEntry extends TraceBase {
  kind: "policy-allow";
}

export interface PolicyDenyEntry extends TraceBase {
  kind: "policy-deny";
  reason: string;
}

export interface ParseDeniedEntry extends TraceBase {
  kind: "parse-denied";
  error: string;
}

export interface UnhandledExecutionEntry extends TraceBase {
  kind: "unhandled-execution";
}

export type EffectTraceEntry =
  | DiscoveryEntry
  | HelpEntry
  | GetEntry
  | ModelsEntry
  | ChildrenListEntry
  | ResumeEntry
  | SteerEntry
  | StopEntry
  | StatusEntry
  | MissionAttachEntry
  | MissionShowEntry
  | MissionListEntry
  | ScheduleCreateEntry
  | ScheduleRunEntry
  | ScheduleListEntry
  | ValidateEntry
  | ManagementFallbackEntry
  | LaunchEntry
  | LaunchFailedEntry
  | ProhibitedLaunchEntry
  | LaunchRejectedEntry
  | NamedWorkflowEffectEntry
  | NamedWorkflowRejectedEntry
  | WorkflowScriptEntry
  | WorkflowScriptPathEntry
  | WorkflowScriptPathMissingEntry
  | WorkflowAdmitEntry
  | WorkflowStatusEntry
  | WorkflowResolveResumeEntry
  | WorkflowResultEntry
  | WorkflowErrorEntry
  | HostEffectEntry
  | PolicyAllowEntry
  | PolicyDenyEntry
  | ParseDeniedEntry
  | UnhandledExecutionEntry;

/** Any trace entry without its index; the recorder assigns the monotonic index. */
export type TraceEntryInitializer = EffectTraceEntry extends infer Entry
  ? Entry extends EffectTraceEntry
    ? Omit<Entry, "index">
    : never
  : never;

/** Fake child result handed back to the production workflow sandbox. */
export interface WorkflowChildResultLike {
  key: string;
  ok: boolean;
  output: string;
  error?: string;
  agent?: string;
  runId?: string;
  structuredOutput?: JsonRecord;
  requestedContext?: "fresh" | "fork";
  resolvedContext?: "fresh" | "fork" | "mixed";
  artifactPaths: string[];
  resumability?: { state: "resumable" } | { state: "not-resumable"; reason: string };
}

/** Final classification of one attempted session. */
export type EvalOutcome =
  | "semantic-pass"
  | "semantic-fail"
  | "provider-error"
  | "setup-error"
  | "turn-limit"
  | "wall-timeout";

/** Everything classification needs, already reduced from the raw session. */
export interface OutcomeObservations {
  sessionCreated: boolean;
  promptError?: string;
  lastAssistantStopReason?: string;
  lastAssistantErrorMessage?: string;
  turnLimitHit: boolean;
  wallTimeoutHit: boolean;
  semanticEvaluated: boolean;
  semanticPass: boolean;
  prohibitedEffects: EffectTraceEntry[];
}

export interface OutcomeClassification {
  outcome: EvalOutcome;
  reason: string;
}

export interface ProviderUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface FirstCallRecord {
  index: number;
  valid: boolean;
  action?: string;
  error?: string;
}

export interface FirstLaunchRecord {
  index: number;
  turn: number;
  valid: boolean;
  form?: string;
}

export interface ToolCallRecord {
  index: number;
  turn: number;
  call: JsonValue;
  parsed: boolean;
  error?: string;
  policyDenied: boolean;
  action?: string;
  form?: string;
}

export type VariantKind = "baseline" | "candidate";

export interface SessionAttemptMetrics {
  fixtureId: string;
  suite: string;
  variant: VariantKind;
  variantOrder: VariantKind[];
  model: string;
  repetition: number;
  attemptIndex: number;
  startedAt: string;
  elapsedMs: number;
  turns: number;
  turnLimitHit: boolean;
  wallTimeoutHit: boolean;
  promptError?: string;
  lastAssistantStopReason?: string;
  outcome: EvalOutcome;
  outcomeReason: string;
  semanticPass: boolean;
  semanticReasons: string[];
  firstCall: FirstCallRecord | null;
  firstLaunch: FirstLaunchRecord | null;
  invalidCalls: number;
  helpCalls: number;
  discoveryCalls: number;
  toolCalls: ToolCallRecord[];
  usage: ProviderUsageTotals;
  effectTrace: EffectTraceEntry[];
  prohibitedEffects: EffectTraceEntry[];
  finalText: string;
  assembledSystemPrompt: string;
  publishedToolDefinition: PublishedToolDefinition;
  providerPayloads: JsonValue[];
}

export interface PublishedToolDefinition {
  name: string;
  description: string;
  parameters: JsonValue;
}

export interface PairAttemptRecord {
  pairId: string;
  attempts: SessionAttemptMetrics[];
  comparable: boolean;
  chosen: SelectedComparableAttempts | null;
}

export interface SelectedComparableAttempts {
  baseline: SessionAttemptMetrics;
  candidate: SessionAttemptMetrics;
}

export interface VariantOutcomeTally {
  semanticPass: number;
  semanticFail: number;
  providerErrors: number;
  setupErrors: number;
  turnLimits: number;
  wallTimeouts: number;
  comparablePairs: number;
}

export interface VariantOutcomeTallies {
  baseline: VariantOutcomeTally;
  candidate: VariantOutcomeTally;
}

/**
 * A scenario document decoded from a suite JSON file. Fixture documents are
 * authored data; they are decoded once at load and never re-parsed.
 */

export interface DiscoveryAgentRow {
  name: string;
  executable?: boolean;
  disabled?: boolean;
  access?: string;
  runner?: string;
}

export interface ChildResponseSpec {
  when: { agent?: string; taskMatches?: string };
  occurrence?: number;
  output: string;
  structuredOutput?: JsonRecord;
  outputContract?: OutputContract;
}

export interface OutputContract {
  required: string[];
  fieldTypes?: Record<string, string>;
  enums?: Record<string, string[]>;
}

export interface InfrastructureFailureSpec {
  failureKind: string;
  message: string;
}

export interface RetainedChildRow {
  runId: string;
  agent: string;
  task: string;
  resumable: boolean;
}

export interface ResumeResultSpec {
  runId: string;
  status: string;
  output: string;
}

export interface ModelRow {
  selector: string;
  label: string;
  costTier: string;
}

export interface StatusChildRow {
  index: number;
  agent: string;
  transcript: string[];
}

export interface StatusRunRow {
  runId: string;
  status: string;
  children: StatusChildRow[];
}

export interface StopChildRow {
  id: string;
  state: string;
}

export interface StopRunRow {
  runId: string;
  runState: string;
  children: StopChildRow[];
}

export interface MissionRow {
  missionId: string;
  status: string;
  runs: string[];
}

export interface SteerResultSpec {
  runId: string;
  state: string;
  deliveryStatus?: string;
}

export interface StopResultSpec {
  runId: string;
  stopped: boolean;
}

export interface StatusResultSpec {
  runId: string;
  status: string;
  output: string;
  transcript?: string[];
}

export interface NamedWorkflowSpec {
  name: string;
  args: JsonRecord;
  output: string;
}

export interface ScheduleCreateResultSpec {
  id: string;
  nextRunAt: string;
  status: string;
}

export interface FixturePolicySpec {
  allowNamedWorkflow: { name: string; args: JsonRecord };
}

export interface EvalFixture {
  id: string;
  prompt: string;
  discoveryAgents?: DiscoveryAgentRow[];
  childResponses?: ChildResponseSpec[];
  infrastructureFailure?: InfrastructureFailureSpec;
  retainedRows?: RetainedChildRow[];
  resumeResults?: Record<string, ResumeResultSpec>;
  models?: ModelRow[];
  statusResults?: Record<string, StatusResultSpec>;
  statusRuns?: Record<string, StatusRunRow>;
  steerResults?: Record<string, SteerResultSpec>;
  stopResults?: Record<string, StopResultSpec>;
  stopRuns?: Record<string, StopRunRow>;
  missionRows?: MissionRow[];
  namedWorkflow?: NamedWorkflowSpec;
  workflowScriptFiles?: Record<string, string>;
  scheduleCreateResult?: ScheduleCreateResultSpec;
  policy?: FixturePolicySpec;
  prohibitedKinds?: string[];
}

export interface SuiteSourceReport {
  path: string;
  sha256: string;
  note?: string;
}

export interface EvalSuiteDocument {
  version: number;
  suite: string;
  status: string;
  sourceReport?: SuiteSourceReport;
  discovery: { agents: DiscoveryAgentRow[] };
  fixtures: EvalFixture[];
}
