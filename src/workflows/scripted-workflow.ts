import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { Worker } from "node:worker_threads";
import { DEFAULT_GLOBAL_CONCURRENCY_LIMIT, Semaphore } from "../runs/shared/parallel-utils.ts";
import { HOST_STEP_MAX_COUNT } from "../runs/shared/host-step-status.ts";
import { describeGateAcceptanceConflict, parseGateInput } from "../runs/shared/acceptance.ts";
import type { AcceptanceRecoveryMetadata, HostStepNode, SingleResult, WorkflowScriptFailureKind } from "../shared/types.ts";
import { normalizeWorkflowHostCommandParams, type WorkflowHostCommandParams, type WorkflowHostCommandResult } from "./host-command.ts";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE_REF_VALIDATION_ERROR = "baseRef must be a valid Git ref: use HEAD or a supported named ref (for example, refs/heads/main). Full 40/64-character commit IDs and revision expressions are unsupported.";
function validGitRef(ref: unknown): ref is string {
	if (typeof ref !== "string" || !ref || ref === "@" || Buffer.byteLength(ref, "utf-8") > 1024 || ref.startsWith("/") || ref.endsWith("/") || ref.includes("//") || ref.includes("..") || ref.includes("@{")) return false;
	if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(ref)) return false;
	if (/[[\]\\~^:?*\u0000-\u0020\u007f]/u.test(ref) || ref.endsWith(".") || ref.endsWith(".lock")) return false;
	return ref.split("/").every((component) => component.length > 0 && component !== "." && component !== ".." && !component.startsWith(".") && !component.endsWith(".") && !component.endsWith(".lock"));
}
const requireFromPackage = createRequire(import.meta.url);
const WORKFLOW_ASSEMBLY_FLUSH_TIMEOUT_MS = 5_000;

export interface WorkflowScriptValidationError {
	message: string;
	line?: number;
	column?: number;
	kind?: "spawn-budget" | "agent";
}

export interface WorkflowScriptValidationWarning {
	message: string;
	kind: "dynamic-spawn-count";
}

export interface WorkflowScriptValidationResult {
	ok: boolean;
	errors: WorkflowScriptValidationError[];
	warnings?: WorkflowScriptValidationWarning[];
}

export interface WorkflowScriptValidationOptions {
	maxSubagentSpawnsPerRun?: number;
	/** Returns why launch-time resolution would reject this literal child agent name. */
	agentNameError?: (name: string) => string | undefined;
}

const WORKFLOW_WORKER_URL = new URL("../../workflow-script-worker.cjs", import.meta.url);
let nodeWorkerSource: string | undefined;

export interface WorkflowScriptChildResult {
	key: string;
	/** True only for successfully completed child work, never for a launch receipt. */
	ok: boolean;
	/** An explicit async launch returned before a final child result was available. */
	state?: "running";
	asyncDir?: string;
	lane?: import("../shared/types.ts").WorkflowLaneMetadata;
	terminalOutcome?: import("../shared/types.ts").WorkflowTerminalOutcome;
	stopped?: boolean;
	/** Canonical child agent name when launch resolution produced one. */
	agent?: string;
	runId?: string;
	output: string;
	error?: string;
	detached?: boolean;
	interrupted?: boolean;
	structuredOutput?: unknown;
	requestedContext?: "fresh" | "fork";
	resolvedContext?: "fresh" | "fork" | "mixed";
	outputReference?: string;
	/** A file produced by the child runtime (output or worktree handoff), not its job directory. */
	outputArtifactPath?: string;
	recovery?: AcceptanceRecoveryMetadata;
	outputPathMapping?: { requestedPath: string; savedPath: string };
	externalAdapter?: import("../shared/types.ts").ExternalCliReceiptMetadata;
	resumability?: { state: "resumable" } | { state: "not-resumable"; reason: string };
	continuation?: { runIds: string[] };
	artifactPaths: string[];
	results?: SingleResult[];
	/** Came from a runtime-replaced or owner-exited run of the same script (and args, unless named by options.reuseFrom): its saved result, or its still-running child re-attached; this run launched nothing. */
	reused?: boolean;
}

export interface WorkflowScriptTraceEntry {
	operation: "run" | "status" | "steer" | "host";
	key: string;
	state: "started" | "completed" | "failed" | "detached" | "stopped" | "reused" | "queued" | "delivered" | "missed";
	/** Canonical child agent name when resolved launch or result data is available. */
	agent?: string;
	runId?: string;
	durationMs?: number;
	phase?: string;
	label?: string;
	error?: string;
	/** Internal provenance for a generated runs.lanes child key. */
	generatedLaneKey?: string;
	lane?: import("../shared/types.ts").WorkflowLaneMetadata;
	warning?: string;
	/** The settled result came from a previous run of the same script and args; no child was launched. */
	reused?: boolean;
}

/** Bounded plan metadata emitted when a workflow materializes a runs.lanes graph. */
export interface WorkflowLanePlanStage {
	key: string;
	generatedKey: string;
	agent?: string;
	phase?: string;
	label?: string;
	outputName?: string;
	structured?: boolean;
}

export interface WorkflowLanePlan {
	key: string;
	stages: WorkflowLanePlanStage[];
}

export interface WorkflowSteerOptions {
	mode?: "steer" | "follow_up" | "auto";
	index?: number;
	ackTimeoutMs?: number;
}

export interface WorkflowSteerResult {
	key: string;
	state: "queued" | "delivered" | "missed" | "failed";
	requestId?: string;
	deliveryStatus?: "queued" | "delivered";
	targets?: Array<{ index: number; state: string; reason?: string }>;
	error?: string;
}

export interface WorkflowReceiptResumeReference {
	workflowRunId: string;
	key: string;
	latest: true;
}

export interface WorkflowResolvedResumeReference {
	runId: string;
	runIds?: string[];
}

export interface WorkflowScriptResult {
	value: unknown;
	emits: unknown[];
	console: Array<{ level: "log" | "info" | "warn" | "error"; text: string }>;
	trace: WorkflowScriptTraceEntry[];
	children: WorkflowScriptChildResult[];
}

function isWorkflowScriptFailureKind(value: unknown): value is WorkflowScriptFailureKind {
	return value === "validation" || value === "script" || value === "child" || value === "return-serialization" || value === "timeout" || value === "detached-child" || value === "runtime";
}

function taggedWorkflowError(message: string, kind: WorkflowScriptFailureKind): Error & { workflowErrorKind: WorkflowScriptFailureKind } {
	return Object.assign(new Error(message), { workflowErrorKind: kind });
}

export class WorkflowScriptError extends Error {
	readonly partial: Omit<WorkflowScriptResult, "value">;
	readonly errorKind?: WorkflowScriptFailureKind;

	constructor(message: string, partial: Omit<WorkflowScriptResult, "value">, errorKind?: WorkflowScriptFailureKind, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkflowScriptError";
		this.partial = partial;
		this.errorKind = errorKind;
	}
}

export type WorkflowChildSettledOutcome = "completed" | "failed" | "paused" | "stopped";

export interface WorkflowChildSettledNotification {
	workflowRunId: string;
	childKey: string;
	childRunId?: string;
	outcome: WorkflowChildSettledOutcome;
	outputReference?: string;
	error?: string;
	workflowRunning: boolean;
	/** The script-visible result, exactly as returned to the script. */
	result: WorkflowScriptChildResult;
}

export interface RunWorkflowScriptOptions {
	script: string;
	/** Normalized raw-script input exposed as the deeply frozen sandbox global `args`. */
	args?: Readonly<Record<string, unknown>>;
	/** Parent-session cwd used to recover a stale process cwd. */
	processCwd?: string;
	/** Workflow run ID for notifications. Required when onChildSettled is provided. */
	workflowRunId?: string;
	/** Host-only first-slice admission context. It is never sent to the workflow worker. */
	oneUsePermit?: { claim: (key: string) => string | undefined };
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Let an async workflow flush pure result assembly after reload once every child is terminal. */
	continueAfterAbortWhenChildrenSettled?: (abortError: Error) => boolean;
	/** Maximum children executing concurrently within this workflow. Defaults to 20. */
	globalConcurrencyLimit?: number;
	admit?: (calls: Array<{ key: string; params: Record<string, unknown> }>, signal: AbortSignal) => void | Promise<void>;
	launch: (key: string, params: Record<string, unknown>, signal: AbortSignal, admission: { admitted: boolean; batch: boolean }) => Promise<WorkflowScriptChildResult>;
	resolveResume?: (reference: WorkflowReceiptResumeReference | string, signal: AbortSignal, index?: number) => string | WorkflowResolvedResumeReference | Promise<string | WorkflowResolvedResumeReference>;
	status: (keyOrRunId: string, signal: AbortSignal) => Promise<WorkflowScriptChildResult>;
	steer?: (key: string, message: string, options: WorkflowSteerOptions, signal: AbortSignal) => Promise<WorkflowSteerResult>;
	host?: (key: string, params: WorkflowHostCommandParams, signal: AbortSignal) => Promise<WorkflowHostCommandResult>;
	onHostStep?: (hostStep: HostStepNode) => void;
	state?: {
		get: (key: string) => unknown | Promise<unknown>;
		set: (key: string, value: unknown) => void | Promise<void>;
	};
	registerStopChild?: (stop: ((key: string, message?: string) => boolean) | undefined) => void;
	onTrace?: (trace: WorkflowScriptTraceEntry[]) => void;
	onLanePlan?: (lanes: WorkflowLanePlan[]) => void;
	onEmit?: (emits: unknown[]) => void;
	onChildSettled?: (notification: WorkflowChildSettledNotification) => void;
}

function combinedAbortSignal(signals: AbortSignal[]): AbortSignal {
	const controller = new AbortController();
	const abort = (signal: AbortSignal): void => {
		if (controller.signal.aborted) return;
		controller.abort(signal.reason);
	};
	for (const signal of signals) {
		if (signal.aborted) {
			abort(signal);
			break;
		}
		signal.addEventListener("abort", () => abort(signal), { once: true });
	}
	return controller.signal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAcceptanceMetadataRecovery(result: WorkflowScriptChildResult): boolean {
	return !result.ok
		&& result.recovery?.status === "available-for-review"
		&& result.recovery.reason === "acceptance-metadata-rejected";
}

const RECOVERY_REVIEW_MUTATION_VERB_PATTERN = /\b(?:add(?:ing)?|append(?:ing)?|apply(?:ing)?|cherry[ -]pick(?:ing)?|change|changing|clean(?:ing)?|commit(?:ting)?|cop(?:y|ying)|create|creating|delete|deleting|edit(?:ing)?|fix(?:ing)?|implement(?:ing)?|insert(?:ing)?|make|making|merge|merging|mov(?:e|ing)|modify(?:ing)?|mutate|mutating|open(?:ing)?|patch(?:ing)?|prepend(?:ing)?|push(?:ing)?|rebase|rebasing|refactor(?:ing)?|remove|removing|rename|renaming|replace|replacing|revert(?:ing)?|revise|revising|rewrite|rewriting|sav(?:e|ing)|stag(?:e|ing)|stash(?:ing)?|tag(?:ging)?|touch(?:ing)?|update|updating|write|writing)\b/i;
const RECOVERY_REVIEW_READ_ONLY_PATTERN = /\b(?:read[- ]only|review only|only return findings|return findings only|suggest fixes only|without\s+(?:editing|modifying|changing|writing|touching)|do not\s+(?:edit|modify|change|write|touch)|don't\s+(?:edit|modify|change|write|touch)|must not\s+(?:edit|modify|change|write|touch))\b/i;
const RECOVERY_REVIEW_NO_MUTATION_CLAUSE_PATTERN = /\b(?:do not|don't|must not)\s+(?:edit|modify|change|write|touch)(?:\s+files?)?(?:\s*,\s*(?:commit|push|comment|merge|launch(?:\s+subagents?)?)(?=\s*(?:,|\bor\b|[.;!?\n)]|$)))*(?:\s*,?\s*or\s+(?:commit|push|comment|merge|launch(?:\s+subagents?)?)(?=\s*(?:[.;!?\n)]|$)))?/gi;
const RECOVERY_REVIEW_DELIVERABLE_PATTERN = /\b(?:compose|create|draft|prepare|produce|write)\s+(?:(?:a|an|the|your)\s+)?(?:findings?|review|report|summary|analysis|recommendations?)(?:\s+(?:to|at|in)\s+\S+)?/gi;
const RECOVERY_REVIEW_CONTEXT_OBJECT_PATTERN = /\breview\s+(?:(?:the|this|that|saved)\s+)?(?:patch|diff|changes?|implementation|report)\b/gi;
const RECOVERY_REVIEW_MUTATION_NOUN_CONTEXT_PATTERN = /\b(?:later\s+real\s+)?update\s+imperatives?\b/gi;
const RECOVERY_REVIEW_PRIOR_FIX_CONTEXT_PATTERN = /\bthe\s+prior\s+fix\s+keeps\b/gi;
const RECOVERY_REVIEW_DETECTION_CONTEXT_PATTERN = /\b(?:mutation\s+detection\s+now\s+includes\s+move\/rename\/copy\s+file\s+mutation\s+imperatives|delegation\s+detection\s+now\s+blocks\s+get\/let\/have\/tell\/ask\s+follow-up\s+forms)(?=[,.;!?\n]|\b(?:and|but|then|however|nevertheless|nonetheless|yet)\b|$)/gi;
const RECOVERY_REVIEW_PATTERN_CHANGE_CONTEXT_PATTERN = /\bRECOVERY_REVIEW_MUTATION_VERB_PATTERN\s+now\s+includes\s+append,\s+prepend,\s+and\s+sav(?:e|ing)\b(?=\s*(?:[,.;!?\n)]|$))/gi;
const RECOVERY_REVIEW_GIT_PATTERN_CHANGE_CONTEXT_PATTERN = /\bfixed\s+mutating\s+git\s+follow-up\s+bypasses\b|\b(?:added|adding)\s+[a-z][a-z-]*(?:\/[a-z][a-z-]*)*(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)[a-z][a-z-]*(?:\/[a-z][a-z-]*)*)*\s+to\s+the\s+(?:mutation\s+imperative|mutating\s+git\s+command)\s+pattern\b|\band\s+[a-z][a-z-]*(?:\/[a-z][a-z-]*)*(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)[a-z][a-z-]*(?:\/[a-z][a-z-]*)*)*\s+to\s+the\s+mutating\s+git\s+command\s+pattern\b/gi;
const RECOVERY_REVIEW_VALIDATION_EVIDENCE_PATTERN = /\bvalidation(?:\s+after\s+fix)?\s*:/gi;
const RECOVERY_REVIEW_CONTRACT_PROHIBITION_PATTERN = /\b(?:do not|don't|must not)\s+(?:mutate\s+durable\s+state|launch\s+(?:mutating|destructive|mutating\/destructive)\s+work)(?:\s+or\s+(?:mutate\s+durable\s+state|launch\s+(?:mutating|destructive|mutating\/destructive)\s+work))*/gi;
const RECOVERY_REVIEW_ONLY_REVIEW_CONTRACT_PATTERN = /\bmay\s+only\s+launch\s+explicit\s+read-only\s+review\s+children\s+with\s+acceptance:false\b/gi;
const RECOVERY_REVIEW_BLOCKED_CONTEXT_FRAGMENT_PATTERN = /\bstate\.set, runs\.host, runs\.steer, ordinary\/mutating children, and destructive command wording are blocked(?=[,.;!?\n)\]}]|$)/gi;
const RECOVERY_REVIEW_REGRESSION_EVIDENCE_PATTERN = /\b(?:existing regressions cover plain rm and git clean\/reset\/restore|prior regressions covering rm\/git clean as evidence only)(?=[,.;!?\n)\]}]|$)/gi;
const RECOVERY_REVIEW_BLOCKED_QUOTED_EXAMPLE_PATTERN = /(?:`[^`\n]+`|'[^'\n]+'|"[^"\n]+")(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)(?:`[^`\n]+`|'[^'\n]+'|"[^"\n]+"))*\s+(?:is|are|remains?)\s+(?:blocked|(?:an?\s+)?blocked\s+examples?)(?=[,.;!?\n)\]}]|$)/gi;
const RECOVERY_REVIEW_CONTEXT_QUOTED_EXAMPLE_PATTERN = /\b(?:examples?|phrasing|forms|variants):\s*(?:`[^`\n]+`|'[^'\n]+'|"[^"\n]+")(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)(?:`[^`\n]+`|'[^'\n]+'|"[^"\n]+"))*/gi;
const RECOVERY_REVIEW_LISTED_BLOCKED_EXAMPLE_PATTERN = /(?:^|[.;!?\n]\s*)blocked\s+examples:\s*(?:\r?\n[ \t]*(?:[-*]|\d+[.)])\s+[^\r\n]+)+/gim;
const RECOVERY_REVIEW_BLOCKS_QUOTED_EXAMPLE_PATTERN = /\b(?:this\s+)?blocks?\s+examples?\s+like\s+(?:`[^`\n]+`|'[^'\n]+'|"[^"\n]+")(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)(?:`[^`\n]+`|'[^'\n]+'|"[^"\n]+"))*/gi;
const RECOVERY_REVIEW_EXAMPLES_LIKE_BLOCKED_PATTERN = /\bexamples?\s+like\s+(?:`[^`\n]+`|'[^'\n]+'|"[^"\n]+")(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)(?:`[^`\n]+`|'[^'\n]+'|"[^"\n]+"))*\s+(?:is|are|remains?)\s+blocked\b/gi;
const RECOVERY_REVIEW_QUOTED_VISIBLE_BLOCKED_PATTERN = /(?:\b(?:(?:the\s+)?examples?|commands?\s+hidden\s+in)\s+|(?:^|[\s([{]))(?:`[^`\n]+`|'[^'\n]+'|"[^"\n]+")(?:(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+)(?:`[^`\n]+`|'[^'\n]+'|"[^"\n]+"))*\s+(?:(?:is|are|remains?)\s+)?visible\s+and\s+blocked\b/gi;
const RECOVERY_REVIEW_PROMPTS_LIKE_BLOCKED_PATTERN = /\bdescribed\s+prompts?\s+like\s+Run\s+git\s+rebase\s+main,\s+git\s+rebase\s+main,\s+Run\s+git\s+cherry-pick\s+abc123,\s+cherry-pick\s+abc123,\s+and\s+Stage\s+the\s+changed\s+files\s+as\s+blocked\b/gi;
const RECOVERY_REVIEW_GIT_MUTATIONS_BROADER_CONTEXT_PATTERN = /\bpositive\s+git\s+mutations\s+are\s+broader:\s*git\s+branch\s+-D\s+old,\s+git\s+tag\s+-d\s+v1\.0,\s+git\s+stash,\s+git\s+revert\s+abc123,\s+and\s+natural\s+cherry\s+pick\s+abc123\s+now\s+trips?\s+the\s+recovery\s+barrier\b/gi;
const RECOVERY_REVIEW_GIT_COVERAGE_CONTEXT_PATTERN = /\bbroadened\s+positive\s+git\s+mutation\s+coverage\s+for\s+natural\s+`cherry\s+pick`,\s+`revert`,\s+`stash`,\s+`tag`,\s+plus\s+git\s+`branch\|revert\|stash\|tag`/gi;
const RECOVERY_REVIEW_REGRESSION_QUOTED_EXAMPLE_PATTERN = /\b(?:added\s+)?exact\s+regressions?\s+for\s+(?:`[^`\n]+`|'[^'\n]+'|"[^"\n]+")(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)(?:`[^`\n]+`|'[^'\n]+'|"[^"\n]+"))*/gi;
const RECOVERY_REVIEW_REGRESSION_ANAPHORIC_EXAMPLE_PATTERN = /\b(?:added\s+)?exact\s+regressions?\s+for\s+(?:do|run|execute|perform|apply)\s+(?:it|that|this|(?:the\s+)?(?:(?:previous(?:ly)?|prior|above|quoted|blocked)\s+){0,4}(?:command|example|operation|action|phrase|instruction|request))(?:[\s,]+(?:now|still|again|really|actually|immediately)){0,3}[\s,]+anyway(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)(?:do|run|execute|perform|apply)\s+(?:it|that|this|(?:the\s+)?(?:(?:previous(?:ly)?|prior|above|quoted|blocked)\s+){0,4}(?:command|example|operation|action|phrase|instruction|request))(?:[\s,]+(?:now|still|again|really|actually|immediately)){0,3}[\s,]+anyway)*/gi;
const RECOVERY_REVIEW_REGRESSION_FOLLOWED_BY_ANAPHORIC_PATTERN = /\badded\s+(?:exact\s+)?regressions?\s+for\s+quoted\s+rm\s+remaining\s+blocked\s+followed\s+by\s+execute\s+the\s+previous\s+command\b(?=\s*(?:[,.;!?\n)]|\bwhile\b|$))/gi;
const RECOVERY_REVIEW_REGRESSION_FOLLOWED_BY_NAMED_RM_PATTERN = /\b(?:added\s+)?(?:exact\s+)?regressions?\s+for\s+quoted\s+rm\s+remaining\s+blocked\s+followed\s+by\s+(?:do|run|execute|perform|apply)\s+(?:it|that|this|(?:the\s+)?(?:(?:previous(?:ly)?|prior|above|quoted|blocked)\s+){0,4}(?:command|example|operation|action|phrase|instruction|request))(?:[\s,]+(?:now|still|again|really|actually|immediately)){0,3}(?:[\s,]+anyway)?(?=\s*(?:[,.;!?\n)]|\bwhile\b|$))/gi;
const RECOVERY_REVIEW_BLOCKED_LIVE_VARIANT_CONTEXT_PATTERN = /\b(?:while\s+)?keeping\s+live-command\s+variants\s+such\s+as\s+followed\s+by\s+execute\s+the\s+previous\s+command\s+then\s+update\s+tests\s+blocked\b(?=\s*(?:[,.;!?\n)]|$))/gi;
const RECOVERY_REVIEW_ANAPHORIC_REFERENCES_CONTEXT_PATTERN = /\bdirect\s+anaphoric\s+references\s+now\s+include\s+numeric\s+and\s+word\s+ordinals\s+through\s+tenth\s+plus\s+one,\s+so\s+(?:do|run|execute|perform|apply)\s+(?:it|that|this|(?:the\s+)?(?:(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|next|previous(?:ly)?|prior|above|quoted|blocked)\s+){0,4}(?:command|example|operation|action|phrase|instruction|request|one))(?:[\s,]+(?:right|now|still|again|really|actually|immediately)){0,4}[\s,]+anyway(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)(?:do|run|execute|perform|apply)\s+(?:it|that|this|(?:the\s+)?(?:(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|next|previous(?:ly)?|prior|above|quoted|blocked)\s+){0,4}(?:command|example|operation|action|phrase|instruction|request|one))(?:[\s,]+(?:right|now|still|again|really|actually|immediately)){0,4}[\s,]+anyway)*\s+(?:is|are|remains?)\s+blocked\b(?:\s+after\s+quoted\s+destructive\s+examples\s+are\s+scrubbed)?/gi;
const RECOVERY_REVIEW_NO_ANAPHORIC_MUTATION_CLAUSE_PATTERN = /\b(?:do not|don't|must not)\s+(?:do|run|execute|perform|apply)\s+(?:it|that|this|(?:the\s+)?(?:(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|next|previous(?:ly)?|prior|above|quoted|blocked)\s+){0,4}(?:command|example|operation|action|phrase|instruction|request|one))(?:(?!\b(?:and|but|then|however|nevertheless|nonetheless|yet)\b)[^,.;!?\n—–-]){0,80}/gi;
const RECOVERY_REVIEW_NO_DELEGATION_CLAUSE_PATTERN = /\b(?:do not|don't|must not)\s+(?:(?:launch|start|spawn|run)\b(?:(?!\b(?:and|but|then|however|nevertheless|nonetheless|yet)\b)[^,.;!?\n])*(?:workers?|reviewers?|agents?|subagents?|children|child|runs?)|(?:get|let|request|hand\s+off|assign|use|have|tell)\b(?:(?!\b(?:and|but|then|however|nevertheless|nonetheless|yet)\b)[^,.;!?\n])*(?:workers?|reviewers?|agents?|subagents?|children|child)|(?:get|let|have|tell|request)\b(?:(?!\b(?:and|but|then|however|nevertheless|nonetheless|yet)\b)[^,.;!?\n])*(?:review|implementation|fix(?:es)?|changes?|follow-up)\b(?:(?!\b(?:and|but|then|however|nevertheless|nonetheless|yet)\b)[^,.;!?\n])*\b(?:from|with|via|by)\b(?:(?!\b(?:and|but|then|however|nevertheless|nonetheless|yet)\b)[^,.;!?\n])*(?:workers?|reviewers?|agents?|subagents?|children|child)|ask\b(?:(?!\b(?:and|but|then|however|nevertheless|nonetheless|yet)\b)[^,.;!?\n])*(?:(?:workers?|reviewers?|agents?|subagents?|children|child)\b(?:(?!\b(?:and|but|then|however|nevertheless|nonetheless|yet)\b)[^,.;!?\n])*\b(?:continue|implement|review|fix|edit|write|modify|change|patch|update|delete|remove|create|follow-up)|(?:review|implementation|fix(?:es)?|changes?|follow-up)\b(?:(?!\b(?:and|but|then|however|nevertheless|nonetheless|yet)\b)[^,.;!?\n])*\b(?:from|via)\b(?:(?!\b(?:and|but|then|however|nevertheless|nonetheless|yet)\b)[^,.;!?\n])*(?:workers?|reviewers?|agents?|subagents?|children|child)))\b/gi;
const RECOVERY_REVIEW_DELEGATION_PATTERN = /\b(?:launch|start|spawn|run)\b[^,.;!?\n]*(?:workers?|reviewers?|agents?|subagents?|children|child|runs?)\b|\b(?:delegate|hand\s+off|assign)\s+(?:remediation|implementation(?:\s+follow-up)?|changes?|fix(?:es)?|follow-up)\s+to\s+(?:(?:a|an|the)\s+)?(?:workers?|reviewers?|agents?|subagents?|children|child)\b|\b(?:get|let|have|tell|request)\b[^,.;!?\n]*(?:workers?|reviewers?|agents?|subagents?|children|child)\b[^,.;!?\n]*\b(?:continue|implement|review|fix|edit|write|modify|change|patch|update|delete|remove|create|follow-up)\b|\b(?:get|let|have|tell|request)\b[^,.;!?\n]*(?:review|implementation|fix(?:es)?|changes?|follow-up)\b[^,.;!?\n]*\b(?:from|with|via|by)\b[^,.;!?\n]*(?:workers?|reviewers?|agents?|subagents?|children|child)\b|\bask\b[^,.;!?\n]*(?:(?:workers?|reviewers?|agents?|subagents?|children|child)\b[^,.;!?\n]*\b(?:continue|implement|review|fix|edit|write|modify|change|patch|update|delete|remove|create|follow-up)|(?:review|implementation|fix(?:es)?|changes?|follow-up)\b[^,.;!?\n]*\b(?:from|via)\b[^,.;!?\n]*(?:workers?|reviewers?|agents?|subagents?|children|child))\b|\buse\b[^,.;!?\n]*(?:workers?|reviewers?|agents?|subagents?|children|child|runs?)\s+(?:for|to)\s+(?:implementation|follow-up|remediation|fix|edit|write|modify|change|patch|update|delete|remove|create)\b/i;
const RECOVERY_REVIEW_ANAPHORIC_MUTATION_PATTERN = /\b(?:do|run|execute|perform|apply)\s+(?:it|that|this|(?:the\s+)?(?:(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|next|previous(?:ly)?|prior|above|quoted|blocked)\s+){0,4}(?:command|example|operation|action|phrase|instruction|request|one))(?!(?:\s+(?:(?:now|still|also|already)\s+)*(?:is|are|remains?)\s+blocked\b))(?:(?:[\s,]+\w+){0,4}[\s,]+anyway|(?:(?!\b(?:and|but|then|however|nevertheless|nonetheless|yet)\b)[^,.;!?\n]){0,80})(?=\s*(?:[,.;!?\n)]|\b(?:and|but|then|however|nevertheless|nonetheless|yet)\b|$))/i;
const RECOVERY_REVIEW_DESTRUCTIVE_COMMAND_PATTERN = /(?:^|[\s;,.`'"([{])(?:\S*\/)?(?:rm|rmdir|unlink|truncate|mv|cp|chmod|chown)\b|\bgit\b(?:\s+(?:-[A-Za-z](?:\s+(?:"[^"\n]*"|'[^'\n]*'|\S+))?|--(?:git-dir|work-tree|namespace|exec-path|config-env)(?:=(?:"[^"\n]*"|'[^'\n]*'|\S+)|\s+(?:"[^"\n]*"|'[^'\n]*'|\S+))|--[A-Za-z0-9-]+(?:=(?:"[^"\n]*"|'[^'\n]*'|\S+))?))*\s+(?:add|branch|cherry-pick|clean|commit|merge|rebase|reset|restore|revert|stash|tag|checkout|switch)\b/i;
const RECOVERY_REVIEW_DASH_LIVE_ACTION_PATTERN = /(?:[—–]|--|\s-\s|:|\s\/\s)\s*(?:then\s+)?(?:(?:add|append|apply|change|cherry[ -]pick|clean|commit|copy|create|delete|edit|fix|implement|insert|make|merge|move|modify|mutate|open|patch|prepend|push|rebase|refactor|remove|rename|replace|revert|revise|rewrite|save|stage|stash|tag|touch|update|write)\b|(?:launch|start|spawn|run)\b[^,.;!?\n]*(?:workers?|reviewers?|agents?|subagents?|children|child|runs?)\b|(?:\S*\/)?(?:rm|rmdir|unlink|truncate|mv|cp|chmod|chown)\b|git\b[^,.;!?\n]*\b(?:add|branch|cherry-pick|clean|commit|merge|rebase|reset|restore|revert|stash|tag|checkout|switch)\b)/i;

function isExplicitReadOnlyRecoveryReview(params: Record<string, unknown>): boolean {
	const agent = typeof params.agent === "string" ? params.agent.trim() : "";
	const task = typeof params.task === "string" ? params.task.trim() : "";
	const taskDestructiveCommandText = task
		.replace(RECOVERY_REVIEW_BLOCKED_CONTEXT_FRAGMENT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_REGRESSION_EVIDENCE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_BLOCKED_QUOTED_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_CONTEXT_QUOTED_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_LISTED_BLOCKED_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_BLOCKS_QUOTED_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_EXAMPLES_LIKE_BLOCKED_PATTERN, " ")
		.replace(RECOVERY_REVIEW_QUOTED_VISIBLE_BLOCKED_PATTERN, " ")
		.replace(RECOVERY_REVIEW_PROMPTS_LIKE_BLOCKED_PATTERN, " ")
		.replace(RECOVERY_REVIEW_GIT_MUTATIONS_BROADER_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_GIT_COVERAGE_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_REGRESSION_FOLLOWED_BY_NAMED_RM_PATTERN, " ");
	const taskDashLiveActionText = task
		.replace(RECOVERY_REVIEW_DELIVERABLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_CONTEXT_OBJECT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_MUTATION_NOUN_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_PRIOR_FIX_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_DETECTION_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_PATTERN_CHANGE_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_GIT_PATTERN_CHANGE_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_VALIDATION_EVIDENCE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_CONTRACT_PROHIBITION_PATTERN, " ")
		.replace(RECOVERY_REVIEW_ONLY_REVIEW_CONTRACT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_BLOCKED_QUOTED_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_CONTEXT_QUOTED_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_LISTED_BLOCKED_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_BLOCKS_QUOTED_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_EXAMPLES_LIKE_BLOCKED_PATTERN, " ")
		.replace(RECOVERY_REVIEW_QUOTED_VISIBLE_BLOCKED_PATTERN, " ")
		.replace(RECOVERY_REVIEW_PROMPTS_LIKE_BLOCKED_PATTERN, " ")
		.replace(RECOVERY_REVIEW_GIT_MUTATIONS_BROADER_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_GIT_COVERAGE_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_REGRESSION_QUOTED_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_REGRESSION_ANAPHORIC_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_REGRESSION_FOLLOWED_BY_ANAPHORIC_PATTERN, " ")
		.replace(RECOVERY_REVIEW_BLOCKED_LIVE_VARIANT_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_ANAPHORIC_REFERENCES_CONTEXT_PATTERN, " ");
	const taskMutationText = task
		.replace(RECOVERY_REVIEW_DELIVERABLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_CONTEXT_OBJECT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_MUTATION_NOUN_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_PRIOR_FIX_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_DETECTION_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_PATTERN_CHANGE_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_GIT_PATTERN_CHANGE_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_VALIDATION_EVIDENCE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_CONTRACT_PROHIBITION_PATTERN, " ")
		.replace(RECOVERY_REVIEW_ONLY_REVIEW_CONTRACT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_BLOCKED_CONTEXT_FRAGMENT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_REGRESSION_EVIDENCE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_BLOCKED_QUOTED_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_CONTEXT_QUOTED_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_LISTED_BLOCKED_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_BLOCKS_QUOTED_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_EXAMPLES_LIKE_BLOCKED_PATTERN, " ")
		.replace(RECOVERY_REVIEW_QUOTED_VISIBLE_BLOCKED_PATTERN, " ")
		.replace(RECOVERY_REVIEW_PROMPTS_LIKE_BLOCKED_PATTERN, " ")
		.replace(RECOVERY_REVIEW_GIT_MUTATIONS_BROADER_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_GIT_COVERAGE_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_REGRESSION_QUOTED_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_REGRESSION_ANAPHORIC_EXAMPLE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_REGRESSION_FOLLOWED_BY_ANAPHORIC_PATTERN, " ")
		.replace(RECOVERY_REVIEW_BLOCKED_LIVE_VARIANT_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_ANAPHORIC_REFERENCES_CONTEXT_PATTERN, " ")
		.replace(RECOVERY_REVIEW_NO_ANAPHORIC_MUTATION_CLAUSE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_NO_DELEGATION_CLAUSE_PATTERN, " ")
		.replace(RECOVERY_REVIEW_NO_MUTATION_CLAUSE_PATTERN, " ")
		.replace(new RegExp(RECOVERY_REVIEW_READ_ONLY_PATTERN.source, "gi"), " ");
	return params.acceptance === false
		&& agent !== ""
		&& /\b(?:advisor|oracle|review|reviewer)\b/i.test(agent)
		&& RECOVERY_REVIEW_READ_ONLY_PATTERN.test(task)
		&& !RECOVERY_REVIEW_DESTRUCTIVE_COMMAND_PATTERN.test(taskDestructiveCommandText)
		&& !RECOVERY_REVIEW_MUTATION_VERB_PATTERN.test(taskMutationText)
		&& !RECOVERY_REVIEW_DELEGATION_PATTERN.test(taskMutationText)
		&& !RECOVERY_REVIEW_ANAPHORIC_MUTATION_PATTERN.test(taskMutationText)
		&& !RECOVERY_REVIEW_DESTRUCTIVE_COMMAND_PATTERN.test(taskMutationText)
		&& !RECOVERY_REVIEW_DASH_LIVE_ACTION_PATTERN.test(taskDashLiveActionText);
}

function recoveryBarrierMessage(sourceKey: string, target: string): string {
	return `Run '${target}' cannot launch after run '${sourceKey}' returned rejected acceptance recovery; only explicit read-only review children with acceptance:false may follow.`;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || prototype === Object.prototype;
}

function parseWorkflowResumeReference(value: unknown): WorkflowReceiptResumeReference | undefined {
	if (!isRecord(value)) return undefined;
	const fields = Object.keys(value);
	if (fields.some((field) => field !== "workflowRunId" && field !== "key" && field !== "latest")) throw new Error("keyed resume contains unsupported fields.");
	if (typeof value.workflowRunId !== "string" || !value.workflowRunId.trim()) throw new Error("keyed resume workflowRunId must be non-empty.");
	const key = validateKey(value.key, "keyed resume");
	if (value.latest !== true) throw new Error("keyed resume requires latest: true.");
	return { workflowRunId: value.workflowRunId.trim(), key, latest: true };
}

function omitUndefinedWorkflowValues(value: unknown, seen = new Set<object>()): unknown {
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return value;
	seen.add(value);
	const normalized = Array.isArray(value)
		? value.map((entry) => entry === undefined ? null : omitUndefinedWorkflowValues(entry, seen))
		: isPlainJsonObject(value)
			? Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => entry === undefined ? [] : [[key, omitUndefinedWorkflowValues(entry, seen)]]))
			: value;
	seen.delete(value);
	return normalized;
}

function omitNonJsonWorkflowResultMetadata(value: unknown): unknown {
	const normalized = omitUndefinedWorkflowValues(value);
	if (!isPlainJsonObject(normalized) || !Object.hasOwn(normalized, "results")) return normalized;
	try {
		assertWorkflowJsonValue(normalized.results, "runs.run result.results");
		return normalized;
	} catch {
		const { results: _results, ...safeResult } = normalized;
		return safeResult;
	}
}

export function assertWorkflowJsonValue(value: unknown, path = "value", seen = new Set<object>()): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers.`);
		return;
	}
	if (typeof value !== "object") throw new Error(`${path} must be a JSON value; received ${typeof value}.`);
	if (seen.has(value)) throw new Error(`${path} must not contain cycles.`);
	seen.add(value);
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			if (!Object.hasOwn(value, index)) throw new Error(`${path} must not contain sparse array entries.`);
			assertWorkflowJsonValue(value[index], `${path}[${index}]`, seen);
		}
	} else {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== null && prototype !== Object.prototype) throw new Error(`${path} must contain only plain JSON objects.`);
		if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${path} must not contain symbol keys.`);
		for (const [key, entry] of Object.entries(value)) assertWorkflowJsonValue(entry, `${path}.${key}`, seen);
	}
	seen.delete(value);
}

export function formatWorkflowJsonPreview(value: unknown, maxLength: number): string | undefined {
	try {
		assertWorkflowJsonValue(value);
		const serialized = JSON.stringify(value);
		if (typeof serialized !== "string") return undefined;
		// Serialized JSON never ends in "…", so the suffix always means the preview was cut.
		return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized;
	} catch {
		return undefined;
	}
}

function workflowReturnRecoveryHint(children: WorkflowScriptChildResult[]): string {
	if (children.length === 0) return " Return only plain JSON data. For a child result, select fields such as { runId: child.runId, ok: child.ok, outputReference: child.outputReference }.";
	const references = children.slice(0, 10).map((child) => {
		const fields = [child.runId ? `runId=${child.runId.slice(0, 500)}` : undefined, child.outputReference ? `outputReference=${child.outputReference.slice(0, 500)}` : undefined, child.artifactPaths[0] ? `artifact=${child.artifactPaths[0].slice(0, 500)}` : undefined].filter((field): field is string => field !== undefined);
		return `'${child.key}'${fields.length > 0 ? ` (${fields.join(", ")})` : ""}`;
	});
	return ` ${children.some((child) => child.state === "running") ? "Child calls returned before return serialization failed; launch receipts do not prove completion." : "Child work completed before return serialization failed."} Recover outputs from: ${references.join(", ")}${children.length > references.length ? `, and ${children.length - references.length} more` : ""}. Return a plain projection such as { runId: child.runId, ok: child.ok, outputReference: child.outputReference }.`;
}

export interface SimpleWorkflowRunPreview {
	agent?: string;
	task?: string;
}

/** Display-only preview for the exact simple `return runs.run(key, {...})` form. */
export function previewSimpleWorkflowRun(script: string | undefined): SimpleWorkflowRunPreview | undefined {
	const body = script?.match(/^\s*return\s+(?:await\s+)?runs\.run\s*\(\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`$\\]*`)\s*,\s*\{([\s\S]*)\}\s*\)\s*;?\s*$/)?.[1];
	if (body === undefined) return undefined;
	const readProperty = (name: "agent" | "task"): string | undefined => {
		const match = body.match(new RegExp(`(?:^|,)\\s*(?:${name}|["']${name}["'])\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\u0060[^\u0060$\\\\]*\u0060)`));
		if (!match?.[1]) return undefined;
		const literal = match[1];
		if (literal.startsWith('"')) {
			try { return JSON.parse(literal) as string; } catch { return undefined; }
		}
		if (literal.slice(1, -1).includes("\\")) return undefined;
		return literal.slice(1, -1);
	};
	const agent = readProperty("agent");
	const task = readProperty("task");
	return { ...(agent !== undefined ? { agent } : {}), ...(task !== undefined ? { task } : {}) };
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value) ?? "undefined";
}

function canonicalRunParams(params: Record<string, unknown>): Record<string, unknown> {
	if (params.gate === undefined || params.acceptance !== false) return params;
	const { acceptance: _acceptance, ...withoutAcceptance } = params;
	return withoutAcceptance;
}

/** Canonical launch-params identity; matches the worker's stableRunJson(canonicalRunParams(params)). */
export function workflowRunParamsFingerprint(params: Record<string, unknown>): string {
	return stableJson(canonicalRunParams(params));
}

function validateKey(value: unknown, owner = "runs.run"): string {
	if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
		throw new Error(`${owner} key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.`);
	}
	return value;
}

type AstNode = {
	type: string;
	loc?: { start: { line: number; column: number } };
	[key: string]: unknown;
};

const AST_LOCATION_KEYS = new Set(["type", "start", "end", "loc", "range"]);

function astNode(value: unknown): value is AstNode {
	return Boolean(value) && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

function literalString(node: unknown): string | undefined {
	if (!astNode(node)) return undefined;
	if (node.type === "Literal" && typeof node.value === "string") return node.value;
	if (node.type === "TemplateLiteral" && Array.isArray(node.expressions) && node.expressions.length === 0 && Array.isArray(node.quasis)) {
		const first = node.quasis[0] as { value?: { cooked?: unknown } } | undefined;
		if (typeof first?.value?.cooked === "string") return first.value.cooked;
	}
	return undefined;
}

function directRunsCall(node: unknown, method: "run" | "all" | "host" | "lanes"): boolean {
	if (!astNode(node) || node.type !== "CallExpression" || !astNode(node.callee) || node.callee.type !== "MemberExpression") return false;
	const property = node.callee.computed === true ? literalString(node.callee.property) : astNode(node.callee.property) && node.callee.property.type === "Identifier" ? node.callee.property.name : undefined;
	return property === method && astNode(node.callee.object) && node.callee.object.type === "Identifier" && node.callee.object.name === "runs";
}

function validateStaticHostCall(call: AstNode): WorkflowScriptValidationError[] {
	const args = Array.isArray(call.arguments) ? call.arguments : [];
	const keyNode = astNode(args[0]) ? args[0] : undefined;
	const params = astNode(args[1]) ? args[1] : undefined;
	const errors: WorkflowScriptValidationError[] = [];
	const key = literalString(keyNode);
	if (keyNode && key !== undefined && !KEY_PATTERN.test(key)) errors.push({ message: "runs.host key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.", ...nodeLocation(keyNode) });
	if (!params || params.type !== "ObjectExpression" || !Array.isArray(params.properties) || params.properties.some((property) => !astNode(property) || property.type !== "Property")) return errors;
	const allowed = new Set(["kind", "command", "timeoutMs", "output", "role", "provider"]);
	for (const property of params.properties) {
		if (!astNode(property)) continue;
		const name = staticPropertyKey(property);
		if (name !== undefined && !allowed.has(name)) errors.push({ message: name === "cwd" ? "runs.host params contain unsupported field 'cwd'. The host step does not accept per-step cwd; commands and relative output paths use the workflow cwd. Set cwd on the outer subagent request, or put a trusted directory change in command (for example, 'cd /path/to/worktree && npm test')." : `runs.host params contain unsupported field '${name}'.`, ...nodeLocation(property) });
	}
	const kindNode = directObjectPropertyValue(params, "kind");
	const commandNode = directObjectPropertyValue(params, "command");
	const timeoutNode = directObjectPropertyValue(params, "timeoutMs");
	const kind = literalString(kindNode);
	const command = literalString(commandNode);
	const timeout = astNode(timeoutNode) && timeoutNode.type === "Literal" ? timeoutNode.value : undefined;
	if (!kindNode) errors.push({ message: "runs.host params require kind: 'command'.", ...nodeLocation(params) });
	else if (kind !== undefined && kind !== "command") errors.push({ message: "runs.host params kind must be 'command'.", ...nodeLocation(kindNode) });
	if (!commandNode) errors.push({ message: "runs.host params require command.", ...nodeLocation(params) });
	else if (command !== undefined && !command.trim()) errors.push({ message: "runs.host params command must be non-empty.", ...nodeLocation(commandNode) });
	if (!timeoutNode) errors.push({ message: "runs.host params require timeoutMs.", ...nodeLocation(params) });
	else if (typeof timeout === "number" && (!Number.isInteger(timeout) || timeout < 1)) errors.push({ message: "runs.host params timeoutMs must be a positive integer.", ...nodeLocation(timeoutNode) });
	const outputNode = directObjectPropertyValue(params, "output");
	const output = literalString(outputNode);
	if (outputNode && output !== undefined && (!output.trim() || /^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(output))) errors.push({ message: "runs.host params output must be a non-empty relative path without traversal.", ...nodeLocation(outputNode) });
	const roleNode = directObjectPropertyValue(params, "role");
	const role = literalString(roleNode);
	if (roleNode && role !== undefined && role !== "ci" && role !== "gate") errors.push({ message: "runs.host params role must be 'ci' or 'gate'.", ...nodeLocation(roleNode) });
	return errors;
}

function nodeLocation(node: AstNode): Pick<WorkflowScriptValidationError, "line" | "column"> {
	return node.loc ? { line: Math.max(1, node.loc.start.line - 1), column: node.loc.start.column + 1 } : {};
}

function walkAst(node: unknown, visit: (node: AstNode) => void, includeNestedFunctions = true): void {
	if (Array.isArray(node)) {
		for (const item of node) walkAst(item, visit, includeNestedFunctions);
		return;
	}
	if (!astNode(node)) return;
	visit(node);
	if (!includeNestedFunctions && (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression")) return;
	for (const [key, child] of Object.entries(node)) {
		if (!AST_LOCATION_KEYS.has(key)) walkAst(child, visit, includeNestedFunctions);
	}
}

function bindingPatternContainsName(node: unknown, name: string): boolean {
	if (!astNode(node)) return false;
	if (node.type === "Identifier") return node.name === name;
	if (node.type === "RestElement") return bindingPatternContainsName(node.argument, name);
	if (node.type === "AssignmentPattern") return bindingPatternContainsName(node.left, name);
	if (node.type === "ArrayPattern" && Array.isArray(node.elements)) return node.elements.some((element) => bindingPatternContainsName(element, name));
	if (node.type === "ObjectPattern" && Array.isArray(node.properties)) return node.properties.some((property) => {
		if (!astNode(property)) return false;
		return property.type === "RestElement"
			? bindingPatternContainsName(property.argument, name)
			: property.type === "Property" && bindingPatternContainsName(property.value, name);
	});
	return false;
}

function definitelyReassignsBinding(node: unknown, name: string): boolean {
	let assignment = node;
	while (astNode(assignment) && assignment.type === "AssignmentExpression" && assignment.operator !== "&&=" && assignment.operator !== "||=" && assignment.operator !== "??=") {
		if (bindingPatternContainsName(assignment.left, name)) return true;
		assignment = assignment.right;
	}
	return false;
}

function lexicalDeclarationContainsName(node: unknown, name: string): boolean {
	if (!astNode(node)) return false;
	if (node.type === "VariableDeclaration" && node.kind !== "var" && Array.isArray(node.declarations)) {
		return node.declarations.some((declaration) => astNode(declaration) && bindingPatternContainsName(declaration.id, name));
	}
	return (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && bindingPatternContainsName(node.id, name);
}

function scopeShadowsIdentifier(node: AstNode, name: string): boolean {
	if (node.type === "BlockStatement" && Array.isArray(node.body)) return node.body.some((statement) => lexicalDeclarationContainsName(statement, name));
	if (node.type === "CatchClause") return bindingPatternContainsName(node.param, name);
	if (node.type === "ForStatement") return lexicalDeclarationContainsName(node.init, name);
	if (node.type === "ForInStatement" || node.type === "ForOfStatement") return lexicalDeclarationContainsName(node.left, name);
	if (node.type === "SwitchStatement" && Array.isArray(node.cases)) {
		return node.cases.some((entry) => astNode(entry) && Array.isArray(entry.consequent) && entry.consequent.some((statement) => lexicalDeclarationContainsName(statement, name)));
	}
	return false;
}

function walkAstWithoutShadowedIdentifier(node: unknown, name: string, visit: (node: AstNode) => void): void {
	if (Array.isArray(node)) {
		for (const item of node) walkAstWithoutShadowedIdentifier(item, name, visit);
		return;
	}
	if (!astNode(node) || scopeShadowsIdentifier(node, name)) return;
	visit(node);
	if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return;
	for (const [key, child] of Object.entries(node)) {
		if (!AST_LOCATION_KEYS.has(key)) walkAstWithoutShadowedIdentifier(child, name, visit);
	}
}

function definitelyNonJson(node: AstNode, normalizeUndefined = false): string | undefined {
	if (node.type === "Literal") {
		if (typeof node.bigint === "string") return "BigInt values are not JSON-representable";
		if (node.regex !== undefined) return "regular expressions are not JSON-representable";
		return undefined;
	}
	if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return "functions are not JSON-representable";
	if (node.type === "Identifier" && node.name === "undefined") return normalizeUndefined ? undefined : "undefined is not JSON-representable";
	if (node.type === "UnaryExpression" && node.operator === "void") return normalizeUndefined ? undefined : "undefined is not JSON-representable";
	if (node.type === "ArrayExpression" && Array.isArray(node.elements)) {
		if (node.elements.some((entry) => entry === null)) return "sparse arrays are not JSON-representable";
		for (const entry of node.elements) if (astNode(entry)) {
			const error = definitelyNonJson(entry, normalizeUndefined);
			if (error) return error;
		}
	}
	if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
		const values = new Map<string, AstNode>();
		for (const property of node.properties) {
			if (!astNode(property) || property.type !== "Property" || !astNode(property.value) || property.kind !== "init") return undefined;
			const key = staticPropertyKey(property);
			if (key === undefined) return undefined;
			values.set(key, property.value);
		}
		for (const value of values.values()) {
			const error = definitelyNonJson(value, normalizeUndefined);
			if (error) return error;
		}
	}
	return undefined;
}

function staticPropertyKey(property: AstNode): string | undefined {
	return property.computed === true
		? literalString(property.key)
		: literalString(property.key) ?? (astNode(property.key) && property.key.type === "Identifier" ? property.key.name as string : undefined);
}

function directObjectPropertyValue(node: AstNode, name: string): AstNode | undefined {
	if (node.type !== "ObjectExpression" || !Array.isArray(node.properties)) return undefined;
	let value: AstNode | undefined;
	for (const property of node.properties) {
		if (!astNode(property) || property.type !== "Property" || !astNode(property.value)) continue;
		if (staticPropertyKey(property) === name) value = property.value;
	}
	return value;
}

function validateStaticBaseRef(params: AstNode, owner: string): WorkflowScriptValidationError[] {
	if (params.type !== "ObjectExpression" || !Array.isArray(params.properties)) return [];
	// Inspect the final definition only. A later spread or unknown key may overwrite it.
	for (let index = params.properties.length - 1; index >= 0; index--) {
		const property = params.properties[index];
		if (!astNode(property) || property.type !== "Property") return [];
		const key = staticPropertyKey(property);
		if (key === undefined) return [];
		if (key !== "baseRef") continue;
		if (property.kind !== "init" || !astNode(property.value)) return [];
		const valueNode = property.value;
		const value = literalString(valueNode);
		if ((value !== undefined || valueNode.type === "Literal") && !validGitRef(value)) {
			return [{ message: `${owner} ${BASE_REF_VALIDATION_ERROR}`, ...nodeLocation(valueNode) }];
		}
		return [];
	}
	return [];
}

// Children with their own cwd, agentScope, or resume resolve agents elsewhere, and a
// spread or computed key can replace `agent`; leave those to launch-time resolution.
function staticChildAgentNode(params: unknown): AstNode | undefined {
	if (!astNode(params) || params.type !== "ObjectExpression" || !Array.isArray(params.properties)) return undefined;
	let agent: AstNode | undefined;
	for (const property of params.properties) {
		if (!astNode(property) || property.type !== "Property") return undefined;
		const key = staticPropertyKey(property);
		if (key === undefined || key === "cwd" || key === "agentScope" || key === "resume") return undefined;
		if (key === "agent") agent = property.kind === "init" && astNode(property.value) ? property.value : undefined;
	}
	return literalString(agent) === undefined ? undefined : agent;
}

function validateStaticChildAgents(call: AstNode, agentNameError: (name: string) => string | undefined): WorkflowScriptValidationError[] {
	const args = Array.isArray(call.arguments) ? call.arguments : [];
	const elements = (node: unknown): unknown[] => astNode(node) && node.type === "ArrayExpression" && Array.isArray(node.elements) ? node.elements : [];
	// A spread or unknown computed key on the lane can replace `stages`.
	const staticLane = (lane: unknown): lane is AstNode => astNode(lane) && lane.type === "ObjectExpression" && Array.isArray(lane.properties)
		&& lane.properties.every((property) => astNode(property) && property.type === "Property" && staticPropertyKey(property) !== undefined);
	const children: Array<{ owner: string; params: unknown }> = directRunsCall(call, "run")
		? [{ owner: "runs.run", params: args[1] }]
		: directRunsCall(call, "all")
			? elements(args[0]).map((params) => ({ owner: "runs.all item", params }))
			: directRunsCall(call, "lanes")
				? elements(args[0]).flatMap((lane) => staticLane(lane) ? elements(directObjectPropertyValue(lane, "stages")).map((params) => ({ owner: "runs.lanes stage", params })) : [])
				: [];
	const errors: WorkflowScriptValidationError[] = [];
	for (const child of children) {
		const agentNode = staticChildAgentNode(child.params);
		const agentName = literalString(agentNode);
		const error = agentName === undefined ? undefined : agentNameError(agentName);
		if (agentNode && error) errors.push({ kind: "agent", message: `${child.owner}: ${error}`, ...nodeLocation(agentNode) });
	}
	return errors;
}

function directRunsAllKeys(call: AstNode): Array<{ key: string; node: AstNode }> {
	const args = Array.isArray(call.arguments) ? call.arguments : [];
	const items = astNode(args[0]) && args[0].type === "ArrayExpression" && Array.isArray(args[0].elements) ? args[0].elements : [];
	return items.flatMap((item) => {
		if (!astNode(item)) return [];
		const keyNode = directObjectPropertyValue(item, "key");
		const key = literalString(keyNode);
		return keyNode && key !== undefined ? [{ key, node: keyNode }] : [];
	});
}

function containsWorkflowLaunch(node: unknown): boolean {
	let found = false;
	walkAst(node, (candidate) => {
		if (directRunsCall(candidate, "run") || directRunsCall(candidate, "all") || directRunsCall(candidate, "lanes")) found = true;
	});
	return found;
}

function containsRunsIdentifier(node: unknown): boolean {
	let found = false;
	walkAst(node, (candidate) => {
		if (candidate.type === "Identifier" && candidate.name === "runs") found = true;
	});
	return found;
}

function invalidatesRunsBinding(workflowBody: AstNode): boolean {
	let invalidated = false;
	walkAst(workflowBody, (node) => {
		if ((node.type === "VariableDeclarator" || node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ClassDeclaration" || node.type === "ClassExpression")
			&& containsRunsIdentifier(node.id)) invalidated = true;
		if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") && Array.isArray(node.params)
			&& node.params.some(containsRunsIdentifier)) invalidated = true;
		if (node.type === "CatchClause" && containsRunsIdentifier(node.param)) invalidated = true;
		if ((node.type === "AssignmentExpression" || node.type === "UpdateExpression") && containsRunsIdentifier(node.left ?? node.argument)) invalidated = true;
	});
	return invalidated;
}

function containsAbruptControl(node: AstNode): boolean {
	let found = false;
	walkAst(node, (candidate) => {
		if (candidate !== node && (candidate.type === "ReturnStatement" || candidate.type === "ThrowStatement" || candidate.type === "BreakStatement" || candidate.type === "ContinueStatement")) found = true;
	}, false);
	return found;
}

function directLaunchCall(expression: unknown): AstNode | undefined {
	if (!astNode(expression)) return undefined;
	const candidate = expression.type === "AwaitExpression" && astNode(expression.argument) ? expression.argument : expression;
	return directRunsCall(candidate, "run") || directRunsCall(candidate, "all") ? candidate : undefined;
}

function staticWorkflowLaunchPlan(workflowBody: AstNode): { keys: string[]; dynamic: boolean } {
	if (workflowBody.type !== "BlockStatement" || !Array.isArray(workflowBody.body) || invalidatesRunsBinding(workflowBody)) {
		return { keys: [], dynamic: containsWorkflowLaunch(workflowBody) };
	}
	const keys = new Set<string>();
	let dynamic = false;
	let remainderUncertain = false;
	const addCall = (call: AstNode): void => {
		const args = Array.isArray(call.arguments) ? call.arguments : [];
		let nestedLaunch = false;
		for (const argument of args) walkAst(argument, (node) => {
			if (node !== call && (directRunsCall(node, "run") || directRunsCall(node, "all") || directRunsCall(node, "lanes"))) nestedLaunch = true;
		});
		if (nestedLaunch) {
			dynamic = true;
			return;
		}
		if (directRunsCall(call, "run")) {
			const key = literalString(args[0]);
			if (key === undefined) dynamic = true;
			else keys.add(key);
			return;
		}
		const array = astNode(args[0]) && args[0].type === "ArrayExpression" && Array.isArray(args[0].elements) ? args[0] : undefined;
		if (!array) {
			dynamic = true;
			return;
		}
		const batchKeys: string[] = [];
		for (const item of array.elements as unknown[]) {
			if (!astNode(item) || item.type !== "ObjectExpression" || !Array.isArray(item.properties)
				|| item.properties.some((property) => !astNode(property) || property.type !== "Property" || staticPropertyKey(property) === undefined)) {
				dynamic = true;
				return;
			}
			const key = literalString(directObjectPropertyValue(item, "key"));
			if (key === undefined) {
				dynamic = true;
				return;
			}
			batchKeys.push(key);
		}
		for (const key of batchKeys) keys.add(key);
	};
	for (const statement of workflowBody.body) {
		if (!astNode(statement)) continue;
		if (remainderUncertain) {
			if (containsWorkflowLaunch(statement)) dynamic = true;
			continue;
		}
		const expressions: unknown[] = [];
		if (statement.type === "VariableDeclaration" && Array.isArray(statement.declarations)) {
			for (const declaration of statement.declarations) if (astNode(declaration)) expressions.push(declaration.init);
		} else if (statement.type === "ExpressionStatement") expressions.push(statement.expression);
		else if (statement.type === "ReturnStatement" || statement.type === "ThrowStatement") expressions.push(statement.argument);
		let handledLaunch = false;
		for (const expression of expressions) {
			const call = directLaunchCall(expression);
			if (call) {
				addCall(call);
				handledLaunch = true;
			} else if (containsWorkflowLaunch(expression)) dynamic = true;
		}
		if (!handledLaunch && expressions.length === 0 && containsWorkflowLaunch(statement)) dynamic = true;
		if (statement.type === "ReturnStatement" || statement.type === "ThrowStatement") remainderUncertain = true;
		else if (containsAbruptControl(statement)) remainderUncertain = true;
	}
	return { keys: [...keys], dynamic };
}

/** Parse a workflowScript and apply only rules that are decidable from its local syntax. */
export function validateWorkflowScript(script: string, options: WorkflowScriptValidationOptions = {}): WorkflowScriptValidationResult {
	const errors: WorkflowScriptValidationError[] = [];
	if (!script.trim()) return { ok: false, errors: [{ message: "workflowScript must not be empty." }] };
	let root: AstNode;
	try {
		const parser = requireFromPackage(resolveWorkflowParserEntry()) as { parse(source: string, options: Record<string, unknown>): unknown };
		root = parser.parse(`(async () => {\n${script}\n})()`, { ecmaVersion: "latest", sourceType: "script", locations: true }) as AstNode;
	} catch (error) {
		const location = error && typeof error === "object" && "loc" in error && error.loc && typeof error.loc === "object"
			? error.loc as { line?: unknown; column?: unknown }
			: undefined;
		const message = (error instanceof Error ? error.message : String(error)).replace(/\s+\(\d+:\d+\)$/, "");
		return { ok: false, errors: [{ message, ...(typeof location?.line === "number" ? { line: Math.max(1, location.line - 1) } : {}), ...(typeof location?.column === "number" ? { column: location.column + 1 } : {}) }] };
	}

	const wrapper = astNode(root.body) ? undefined : Array.isArray(root.body) && astNode(root.body[0]) && astNode(root.body[0].expression) && astNode(root.body[0].expression.callee)
		? root.body[0].expression.callee
		: undefined;
	const workflowBody = wrapper && astNode(wrapper.body) ? wrapper.body : root;
	// A rebound `runs` may not be the workflow API, so its calls prove nothing about child launches.
	const runsRebound = invalidatesRunsBinding(workflowBody);
	const agentNameError = options.agentNameError && !runsRebound ? options.agentNameError : undefined;
	walkAst(workflowBody, (node) => {
		if (node !== wrapper && node.async === true && (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression")) {
			errors.push({ message: "workflowScript does not support nested async functions. Use top-level await, plain helper functions that return runs.run(...), or explicit Promise chains.", ...nodeLocation(node) });
		}
		if (directRunsCall(node, "run")) {
			const args = Array.isArray(node.arguments) ? node.arguments : [];
			const keyNode = astNode(args[0]) ? args[0] : undefined;
			const key = literalString(keyNode);
			if (keyNode && key !== undefined && !KEY_PATTERN.test(key)) errors.push({ message: "runs.run key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.", ...nodeLocation(keyNode) });
			if (keyNode?.type === "ObjectExpression" && !runsRebound) errors.push({ message: `runs.run expects (key, params); got an object as the first argument. Use runs.run("plan", { agent, task }) or runs.all([{ key, agent, task }]).`, ...nodeLocation(keyNode) });
			if (astNode(args[1])) {
				errors.push(...validateStaticBaseRef(args[1], "runs.run"));
				const message = definitelyNonJson(args[1]);
				if (message) errors.push({ message: `runs.run params are invalid: ${message}.`, ...nodeLocation(args[1]) });
			}
		}
		if (directRunsCall(node, "all")) {
			for (const entry of directRunsAllKeys(node)) if (!KEY_PATTERN.test(entry.key)) errors.push({ message: "runs.all item key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.", ...nodeLocation(entry.node) });
			const args = Array.isArray(node.arguments) ? node.arguments : [];
			if (astNode(args[0]) && args[0].type === "ArrayExpression" && Array.isArray(args[0].elements)) {
				for (const item of args[0].elements) if (astNode(item)) {
					errors.push(...validateStaticBaseRef(item, "runs.all item"));
					const message = definitelyNonJson(item);
					if (message) errors.push({ message: `runs.all item params are invalid: ${message}.`, ...nodeLocation(item) });
				}
			}
		}
		if (directRunsCall(node, "host")) errors.push(...validateStaticHostCall(node));
		if (agentNameError) errors.push(...validateStaticChildAgents(node, agentNameError));
		const boundaryValue = node.type === "CallExpression" && astNode(node.callee) && node.callee.type === "Identifier" && node.callee.name === "emit" && Array.isArray(node.arguments) && astNode(node.arguments[0])
			? node.arguments[0]
			: node.type === "CallExpression" && astNode(node.callee) && node.callee.type === "MemberExpression" && astNode(node.callee.object) && node.callee.object.type === "Identifier" && node.callee.object.name === "state" && astNode(node.callee.property) && node.callee.property.type === "Identifier" && node.callee.property.name === "set" && Array.isArray(node.arguments) && astNode(node.arguments[1])
				? node.arguments[1]
				: undefined;
		if (boundaryValue) {
			// emit normalizes undefined like return; state.set values must already be JSON.
			const message = definitelyNonJson(boundaryValue, Array.isArray(node.arguments) && boundaryValue === node.arguments[0]);
			if (message) errors.push({ message: `workflowScript boundary value is invalid: ${message}.`, ...nodeLocation(boundaryValue) });
		}
	});
	walkAst(workflowBody, (node) => {
		if (node.type !== "ReturnStatement" || !astNode(node.argument)) return;
		const message = definitelyNonJson(node.argument, true);
		if (message) errors.push({ message: `workflowScript boundary value is invalid: ${message}.`, ...nodeLocation(node.argument) });
	}, false);

	if (workflowBody.type === "BlockStatement" && Array.isArray(workflowBody.body)) {
		for (let statementIndex = 0; statementIndex < workflowBody.body.length; statementIndex++) {
			const statement = workflowBody.body[statementIndex];
			if (!astNode(statement) || statement.type !== "VariableDeclaration" || !Array.isArray(statement.declarations)) continue;
			for (const declaration of statement.declarations) {
				if (!astNode(declaration) || !astNode(declaration.id) || declaration.id.type !== "Identifier" || !astNode(declaration.init) || declaration.init.type !== "AwaitExpression" || !astNode(declaration.init.argument) || !directRunsCall(declaration.init.argument, "all")) continue;
				const name = declaration.id.name as string;
				const laterStatements = workflowBody.body.slice(statementIndex + 1);
				const keys = new Set(directRunsAllKeys(declaration.init.argument).map((entry) => entry.key));
				if (keys.size === 0) continue;
				const args = Array.isArray(declaration.init.argument.arguments) ? declaration.init.argument.arguments : [];
				const itemCount = astNode(args[0]) && args[0].type === "ArrayExpression" && Array.isArray(args[0].elements) ? args[0].elements.length : 0;
				const arrayResultShape = Array.from({ length: itemCount });
				for (const later of laterStatements) {
					walkAstWithoutShadowedIdentifier(later, name, (node) => {
						if (node.type !== "MemberExpression" || !astNode(node.object) || node.object.type !== "Identifier" || node.object.name !== name) return;
						const property = node.computed === true ? literalString(node.property) : astNode(node.property) && node.property.type === "Identifier" ? node.property.name as string : undefined;
						if (property && keys.has(property) && !(property in arrayResultShape)) errors.push({ message: `runs.all returns an ordered array; '${name}.${property}' is keyed access. Use an index, destructuring, or map(...).`, ...nodeLocation(node) });
					});
					if (statement.kind !== "const" && astNode(later) && later.type === "ExpressionStatement" && definitelyReassignsBinding(later.expression, name)) break;
				}
			}
		}
	}

	const warnings: WorkflowScriptValidationWarning[] = [];
	if (options.maxSubagentSpawnsPerRun !== undefined) {
		const plan = staticWorkflowLaunchPlan(workflowBody);
		if (plan.keys.length > options.maxSubagentSpawnsPerRun) {
			errors.push({
				kind: "spawn-budget",
				message: `workflowScript statically requires child launches ${plan.keys.map((key) => `'${key}'`).join(", ")}; minimum required: ${plan.keys.length}; configured: ${options.maxSubagentSpawnsPerRun}.`,
			});
		}
		if (plan.dynamic) {
			warnings.push({
				kind: "dynamic-spawn-count",
				message: `workflowScript contains dynamic child launches; static validation proved ${plan.keys.length} launch(es), so runtime fan-out enforcement remains authoritative for the configured budget of ${options.maxSubagentSpawnsPerRun}.`,
			});
		}
	}
	const unique = errors.filter((error, index) => errors.findIndex((candidate) => candidate.message === error.message && candidate.line === error.line && candidate.column === error.column) === index);
	return { ok: unique.length === 0, errors: unique, ...(warnings.length > 0 ? { warnings } : {}) };
}
function workflowStringMetadata(params: Record<string, unknown>): Pick<WorkflowScriptTraceEntry, "phase" | "label" | "agent"> {
	return {
		...(typeof params.phase === "string" && params.phase.trim() ? { phase: params.phase.trim() } : {}),
		...(typeof params.label === "string" && params.label.trim() ? { label: params.label.trim() } : {}),
		// Requested agent name, so a child is identifiable while it runs. Launch
		// resolution overwrites this with the canonical name on the terminal entry.
		...(typeof params.agent === "string" && params.agent.trim() ? { agent: params.agent.trim() } : {}),
	};
}

function resolveWorkflowParserEntry(): string {
	try {
		return requireFromPackage.resolve("acorn");
	} catch (primaryError) {
		// Some runtimes (e.g. Bun-compiled single-file binaries) fail bare
		// package-specifier resolution through createRequire while subpath
		// resolution still works. Resolve the manifest and derive the
		// CommonJS entry from its "main" field instead.
		try {
			const manifestPath = requireFromPackage.resolve("acorn/package.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { main?: unknown };
			const entry = typeof manifest.main === "string" && manifest.main ? manifest.main : "./dist/acorn.js";
			return resolvePath(dirname(manifestPath), entry);
		} catch {
			throw primaryError;
		}
	}
}

const AUTO_RESUME_PARAM_KEYS = ["acceptance", "agentContract", "baseRef", "index", "intercomBridge", "label", "lane", "maxRuntimeMs", "output", "outputMode", "outputSchema", "phase", "skill", "skills", "task", "timeoutMs", "toolBudget", "worktree"] as const;

function isZeroUsage(usage: unknown): boolean {
	if (!isRecord(usage)) return false;
	const cost = usage.cost;
	return (usage.input ?? 0) === 0
		&& (usage.output ?? 0) === 0
		&& (usage.cacheRead ?? 0) === 0
		&& (usage.cacheWrite ?? 0) === 0
		&& (!isRecord(cost) || (cost.total ?? 0) === 0);
}

function setupAbortResumeParams(params: Record<string, unknown>, result: WorkflowScriptChildResult, signal: AbortSignal): Record<string, unknown> | undefined {
	if (signal.aborted || result.state === "running" || result.ok || result.stopped || result.interrupted || !result.runId) return undefined;
	const childResult = Array.isArray(result.results) && result.results.length === 1 && isRecord(result.results[0]) ? result.results[0] : undefined;
	const error = typeof childResult?.error === "string" ? childResult.error : result.error;
	if (error !== "This operation was aborted" || !isZeroUsage(childResult?.usage)) return undefined;
	const messages: unknown[] = Array.isArray(childResult?.messages) ? childResult.messages : [];
	const message = messages.findLast((entry) => isRecord(entry) && entry.role === "assistant");
	if (message !== undefined) {
		if (!isRecord(message)) return undefined;
		if (message.stopReason !== "error" || message.errorMessage !== error) return undefined;
		if (!Array.isArray(message.content) || message.content.length > 0 || !isZeroUsage(message.usage)) return undefined;
		if (Object.hasOwn(message, "diagnostics") || Object.hasOwn(message, "responseId")) return undefined;
	}
	const task = typeof params.task === "string" && params.task.trim() ? params.task.trim() : "Continue after the setup abort.";
	const resumeParams: Record<string, unknown> = { resume: result.runId, task };
	for (const key of AUTO_RESUME_PARAM_KEYS) {
		if (Object.hasOwn(params, key)) resumeParams[key] = params[key];
	}
	resumeParams.resume = result.runId;
	resumeParams.task = task;
	return resumeParams;
}

export async function runWorkflowScript(options: RunWorkflowScriptOptions): Promise<WorkflowScriptResult> {
	const emptyPartial = (): Omit<WorkflowScriptResult, "value"> => ({ emits: [], console: [], trace: [], children: [] });
	if (!options.script.trim()) throw new WorkflowScriptError("workflowScript must not be empty.", emptyPartial(), "validation");
	if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)) throw new WorkflowScriptError("workflow script timeout must be a positive integer.", emptyPartial(), "runtime");
	if (options.globalConcurrencyLimit !== undefined && (!Number.isSafeInteger(options.globalConcurrencyLimit) || options.globalConcurrencyLimit < 1)) {
		throw new WorkflowScriptError("workflow script global concurrency limit must be a positive integer.", emptyPartial(), "runtime");
	}
	const launchSemaphore = new Semaphore(options.globalConcurrencyLimit ?? DEFAULT_GLOBAL_CONCURRENCY_LIMIT);

	if (options.processCwd !== undefined) {
		let staleCwd = false;
		try {
			realpathSync(process.cwd());
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
			if (code !== "ENOENT") throw new WorkflowScriptError("Workflow current cwd could not be validated.", emptyPartial(), "runtime", { cause: error });
			staleCwd = true;
		}
		try {
			if (staleCwd) process.chdir(options.processCwd);
			else {
				const target = realpathSync(options.processCwd);
				if (!statSync(target).isDirectory()) {
					const error = new Error(`ENOTDIR: not a directory, access '${target}'`) as NodeJS.ErrnoException;
					error.code = "ENOTDIR";
					throw error;
				}
				accessSync(target, constants.X_OK);
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new WorkflowScriptError(`Workflow process cwd is unavailable: ${options.processCwd}: ${detail}`, emptyPartial(), "runtime", { cause: error });
		}
	}

	let acornPath: string;
	try {
		acornPath = resolveWorkflowParserEntry();
	} catch (error) {
		throw new WorkflowScriptError("Workflow parser dependency 'acorn' is unavailable from pi-subagents. Reinstall pi-subagents dependencies before launching workflowScript.", emptyPartial(), "runtime", { cause: error });
	}
	let worker: Worker;
	try {
		const bun = typeof process.versions.bun === "string";
		// Bun needs a real file as its resolver base on warm transpiler-cache hits, and no eval key at all: with one,
		// its Worker finalizer passes the URL to URL.revokeObjectURL and throws. Node keeps eval source because its
		// eval worker does not re-resolve inherited --import preloads after a cwd change.
		worker = bun
			? new Worker(WORKFLOW_WORKER_URL, { workerData: { acornPath } })
			: new Worker(nodeWorkerSource ??= readFileSync(WORKFLOW_WORKER_URL, "utf8"), { eval: true, workerData: { acornPath } });
	} catch (error) {
		throw new WorkflowScriptError(`Workflow worker could not start: ${error instanceof Error ? error.message : String(error)}`, emptyPartial(), "runtime", { cause: error });
	}
	const emits: unknown[] = [];
	const consoleEntries: WorkflowScriptResult["console"] = [];
	const trace: WorkflowScriptTraceEntry[] = [];
	const children = new Map<string, WorkflowScriptChildResult>();
	const childOrder: string[] = [];
	const launches = new Map<string, { fingerprint: string; promise: Promise<WorkflowScriptChildResult>; observed: boolean; generatedLaneKey?: string }>();
	const steers = new Map<number, { key: string; promise: Promise<WorkflowSteerResult>; observed: boolean }>();
	const hostCalls = new Map<number, { key: string; promise: Promise<WorkflowHostCommandResult>; observed: boolean }>();
	const stoppedLaunches = new Set<string>();
	const childStopControllers = new Map<string, AbortController>();
	const batchAdmissions = new Map<string, Promise<void>>();
	const observedRunCalls = new Set<number>();
	const observedSteerCalls = new Set<number>();
	const observedHostCalls = new Set<number>();
	const childController = new AbortController();
	let acceptanceRecoveryBarrier: { key: string } | undefined;
	let settled = false;
	let finishing = false;
	let assemblyAbortRequested = false;
	let assemblyFlushTimer: ReturnType<typeof setTimeout> | undefined;
	let abortError: Error | undefined;

	const partial = (): Omit<WorkflowScriptResult, "value"> => ({ emits, console: consoleEntries, trace, children: childOrder.flatMap((key) => {
		const child = children.get(key);
		return child ? [child] : [];
	}) });
	// Hosts use onTrace to persist a progress journal, and it is invoked from inside
	// the run-promise handlers below. A throw here would reject the child promise the
	// script is awaiting, so a single failed status write could mark a completed child
	// failed and abort its siblings through Promise.all. Telemetry must not decide
	// workflow outcomes, so a failing callback is reported and the run continues.
	const traceChanged = () => {
		try {
			options.onTrace?.([...trace]);
		} catch (error) {
			console.error("Workflow onTrace callback failed:", error);
		}
	};
	const lanePlanChanged = (lanes: WorkflowLanePlan[]) => {
		try {
			options.onLanePlan?.(lanes);
		} catch (error) {
			console.error("Workflow onLanePlan callback failed:", error);
		}
	};
	const hostStepChanged = (hostStep: HostStepNode) => {
		try {
			options.onHostStep?.(hostStep);
		} catch (error) {
			console.error("Workflow onHostStep callback failed:", error);
		}
	};
	const stoppedChildResult = (key: string, message: string): WorkflowScriptChildResult => ({ key, ok: false, stopped: true, output: message, error: message, artifactPaths: [] });
	const responseBoundaryFailure = (key: string, error: unknown): WorkflowScriptChildResult => {
		const text = error instanceof Error ? error.message : String(error);
		return { key, ok: false, output: text, error: text, artifactPaths: [] };
	};
	const assertRecoveryBarrierAllowsRun = (key: string, params: Record<string, unknown>): void => {
		if (!acceptanceRecoveryBarrier || isExplicitReadOnlyRecoveryReview(params)) return;
		throw new Error(recoveryBarrierMessage(acceptanceRecoveryBarrier.key, key));
	};
	const recordAcceptanceRecoveryBarrier = (key: string, result: WorkflowScriptChildResult): void => {
		if (isAcceptanceMetadataRecovery(result)) acceptanceRecoveryBarrier = { key };
	};
	const stopChild = (key: string, message = `Workflow child '${key}' stopped.`): boolean => {
		if (!launches.has(key) || children.has(key)) return false;
		stoppedLaunches.add(key);
		children.set(key, stoppedChildResult(key, message));
		childStopControllers.get(key)?.abort(new Error(message));
		const started = trace.findLast((entry) => entry.operation === "run" && entry.key === key && entry.state === "started");
		trace.push({
			operation: "run",
			key,
			state: "stopped",
			...(started?.agent ? { agent: started.agent } : {}),
			...(started?.phase ? { phase: started.phase } : {}),
			...(started?.label ? { label: started.label } : {}),
			...(started?.generatedLaneKey ? { generatedLaneKey: started.generatedLaneKey } : {}),
			error: message,
		});
		traceChanged();
		return true;
	};
	const notifyChildSettled = (key: string, result: WorkflowScriptChildResult): void => {
		if (result.state === "running" || !options.onChildSettled || !options.workflowRunId) return;
		const outcome: WorkflowChildSettledOutcome = result.ok
			? "completed"
			: result.stopped
				? "stopped"
				: result.detached
					? "paused"
					: "failed";
		const outputReference = result.outputReference ?? result.outputArtifactPath;
		try {
			options.onChildSettled({
				workflowRunId: options.workflowRunId,
				childKey: key,
				...(result.runId ? { childRunId: result.runId } : {}),
				outcome,
				...(outputReference ? { outputReference } : {}),
				...(!result.ok && result.error ? { error: result.error } : {}),
				workflowRunning: !settled && !finishing,
				result,
			});
		} catch (error) {
			console.error("Workflow onChildSettled callback failed:", error);
		}
	};
	options.registerStopChild?.(stopChild);

	return await new Promise<WorkflowScriptResult>((resolve, reject) => {
		const finish = (outcome: { value: unknown } | { error: Error & { workflowErrorKind?: unknown } }) => {
			if (settled || finishing) return;
			finishing = true;
			if (assemblyFlushTimer !== undefined) {
				clearTimeout(assemblyFlushTimer);
				assemblyFlushTimer = undefined;
			}
			childController.abort("error" in outcome ? outcome.error : new Error("Workflow script completed."));
			void Promise.allSettled([...steers.values(), ...hostCalls.values()].map(({ promise }) => promise)).then(() => {
				if (settled) return;
				settled = true;
				options.registerStopChild?.(undefined);
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				void worker.terminate();
				const unobservedKeys = "value" in outcome ? [...launches].filter(([, launch]) => !launch.observed).map(([key]) => key) : [];
				const completionError = unobservedKeys.length > 0
					? new Error(`workflowScript completed with unawaited runs.run launch(es): ${unobservedKeys.map((key) => `'${key}'`).join(", ")}. For ordinary parallel fanout use await runs.all([{key, agent, task}, ...]); do not read .output from unawaited launches.`)
					: "value" in outcome
						? (() => {
							const unobservedSteers = [...steers.values()].filter((steer) => !steer.observed).map((steer) => steer.key);
							if (unobservedSteers.length > 0) return new Error(`workflowScript completed with unawaited runs.steer call(s): ${unobservedSteers.map((key) => `'${key}'`).join(", ")}. Await or return each call.`);
							const unobservedHosts = [...hostCalls.values()].filter((host) => !host.observed).map((host) => host.key);
							return unobservedHosts.length > 0 ? new Error(`workflowScript completed with unawaited runs.host call(s): ${unobservedHosts.map((key) => `'${key}'`).join(", ")}. Await or return each call.`) : undefined;
						})()
						: undefined;
				// Stops and reloads end through the abort paths untagged: they are not failures.
				if ("error" in outcome) reject(new WorkflowScriptError(outcome.error.message, partial(), isWorkflowScriptFailureKind(outcome.error.workflowErrorKind) ? outcome.error.workflowErrorKind : undefined));
				else if (completionError) reject(new WorkflowScriptError(completionError.message, partial(), "validation"));
				else resolve({ value: outcome.value, ...partial() });
			});
		};
		const onAbort = () => {
			const signalReason = options.signal?.reason;
			const error = signalReason instanceof Error
				? signalReason
				: typeof signalReason === "string"
					? new Error(signalReason)
					: new Error("Workflow script aborted.");
			if (finishing) return;
			abortError = error;
			const allChildrenSettled = launches.size > 0
				&& [...launches.keys()].every((key) => children.has(key));
			let mayFlushAssembly = false;
			try {
				mayFlushAssembly = options.continueAfterAbortWhenChildrenSettled?.(error) === true;
			} catch (callbackError) {
				const callbackMessage = callbackError instanceof Error ? callbackError.message : String(callbackError);
				return finish({ error: taggedWorkflowError(`Workflow assembly flush eligibility failed: ${callbackMessage}`, "runtime") });
			}
			if (mayFlushAssembly && allChildrenSettled) {
				// A reloaded async workflow may already be past its last child launch.
				// Keep the worker alive for pure result assembly, but abort the child
				// signal so any later launch or side effect cannot use stale context.
				assemblyAbortRequested = true;
				childController.abort(error);
				assemblyFlushTimer = setTimeout(() => finish({ error }), WORKFLOW_ASSEMBLY_FLUSH_TIMEOUT_MS);
				return;
			}
			for (const key of launches.keys()) {
				if (children.has(key)) continue;
				stoppedLaunches.add(key);
				const started = trace.findLast((entry) => entry.operation === "run" && entry.key === key && entry.state === "started");
				trace.push({
					operation: "run",
					key,
					state: "stopped",
					...(started?.agent ? { agent: started.agent } : {}),
					...(started?.phase ? { phase: started.phase } : {}),
					...(started?.label ? { label: started.label } : {}),
					...(started?.generatedLaneKey ? { generatedLaneKey: started.generatedLaneKey } : {}),
					error: error.message,
				});
			}
			traceChanged();
			finish({ error });
		};
		const timer = options.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
				finish({ error: taggedWorkflowError(`Workflow script timed out after ${options.timeoutMs}ms.`, "timeout") });
			}, options.timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) return onAbort();

		worker.on("error", (error) => finish({ error: taggedWorkflowError(`Workflow worker failed: ${error instanceof Error ? error.message : String(error)}`, "runtime") }));
		worker.on("exit", (code) => {
			if (!settled && code !== 0) finish({ error: taggedWorkflowError(`Workflow worker exited with code ${code}.`, "runtime") });
		});
		worker.on("message", (message: Record<string, unknown>) => {
			if (settled) return;
			if (message.type === "lanePlan" && Array.isArray(message.lanes)) {
				lanePlanChanged(message.lanes as WorkflowLanePlan[]);
				return;
			}
			if (message.type === "emit") {
				try {
					assertWorkflowJsonValue(message.value, "emit");
				} catch (error) {
					finish({ error: taggedWorkflowError(`Workflow emit could not be persisted: ${error instanceof Error ? error.message : String(error)}`, "runtime") });
					return;
				}
				emits.push(message.value);
				try {
					options.onEmit?.([...emits]);
				} catch (error) {
					emits.pop();
					finish({ error: taggedWorkflowError(`Workflow emit could not be persisted: ${error instanceof Error ? error.message : String(error)}`, "runtime") });
				}
				return;
			}
			if (message.type === "console") {
				const level = message.level;
				if ((level === "log" || level === "info" || level === "warn" || level === "error") && typeof message.text === "string") consoleEntries.push({ level, text: message.text });
				return;
			}
			if (message.type === "complete") {
				try {
					assertWorkflowJsonValue(message.value, "return");
				} catch (error) {
					return finish({ error: taggedWorkflowError(`Workflow return could not be persisted: ${error instanceof Error ? error.message : String(error)}`, "return-serialization") });
				}
				return finish({ value: message.value });
			}
			if (message.type === "error") {
				const rawError = typeof message.error === "string" ? message.error : "Workflow script failed.";
				const text = message.errorPhase === "return-serialization" ? `${rawError}${workflowReturnRecoveryHint(partial().children)}` : rawError;
				return finish({ error: isWorkflowScriptFailureKind(message.errorKind) ? taggedWorkflowError(text, message.errorKind) : new Error(text) });
			}
			if (message.type === "callObserved" && typeof message.callId === "number") {
				const key = typeof message.key === "string" ? message.key : undefined;
				if (message.operation === "run") {
					const launch = key ? launches.get(key) : undefined;
					if (launch) launch.observed = true;
					else observedRunCalls.add(message.callId);
				} else if (message.operation === "steer") {
					const steer = steers.get(message.callId);
					if (steer) steer.observed = true;
					else observedSteerCalls.add(message.callId);
				} else if (message.operation === "host") {
					const host = hostCalls.get(message.callId);
					if (host) host.observed = true;
					else observedHostCalls.add(message.callId);
				}
				return;
			}
			if (message.type !== "call" || typeof message.callId !== "number" || typeof message.method !== "string" || !isRecord(message.args)) return;
			if (assemblyAbortRequested) return finish({ error: abortError ?? new Error("Workflow context was replaced or reloaded.") });

			const respond = (promise: Promise<unknown>, responsePath?: string, onBoundaryError?: (error: unknown) => void) => {
				void promise.then(
					(value) => {
						if (settled) return;
						const normalized = responsePath ? omitNonJsonWorkflowResultMetadata(value) : omitUndefinedWorkflowValues(value);
						if (!responsePath) {
							worker.postMessage({ type: "response", callId: message.callId, ok: true, value: normalized });
							return;
						}
						try {
							assertWorkflowJsonValue(normalized, responsePath);
							worker.postMessage({ type: "response", callId: message.callId, ok: true, value: normalized });
						} catch (error) {
							onBoundaryError?.(error);
							worker.postMessage({ type: "response", callId: message.callId, ok: false, error: `${responsePath} must contain only JSON data before it can be returned from workflowScript. Return a plain projection such as { runId, ok, output }. ${error instanceof Error ? error.message : String(error)}` });
						}
					},
					(error: unknown) => {
						if (!settled) {
							const errorKind = error instanceof Error ? (error as { workflowErrorKind?: unknown }).workflowErrorKind : undefined;
							worker.postMessage({ type: "response", callId: message.callId, ok: false, error: error instanceof Error ? error.message : String(error), ...(isWorkflowScriptFailureKind(errorKind) ? { errorKind } : {}) });
						}
					},
				);
			};
			if (message.method === "state.get" || message.method === "state.set") {
				if (!options.state) return respond(Promise.reject(new Error("Workflow state is unavailable without a mission.")));
				let key: string;
				try {
					key = validateKey(message.args.key, "state");
				} catch (error) {
					return respond(Promise.reject(error));
				}
				if (message.method === "state.get") return respond(Promise.resolve().then(() => options.state!.get(key)));
				if (acceptanceRecoveryBarrier) return respond(Promise.reject(new Error(recoveryBarrierMessage(acceptanceRecoveryBarrier.key, `state.set('${key}')`))));
				const value = message.args.value;
				try {
					assertWorkflowJsonValue(value, `state.set('${key}') value`);
				} catch (error) {
					return respond(Promise.reject(error));
				}
				return respond(Promise.resolve().then(() => options.state!.set(key, value)));
			}

			if (message.method === "status") {
				const keyOrRunId = message.args.keyOrRunId;
				if (typeof keyOrRunId !== "string" || !keyOrRunId.trim()) return respond(Promise.reject(new Error("runs.status(keyOrRunId) requires a non-empty string.")));
				const known = children.get(keyOrRunId);
				const target = known?.runId ?? keyOrRunId;
				trace.push({ operation: "status", key: keyOrRunId, state: "started", ...(known?.runId ? { runId: known.runId } : {}) });
				traceChanged();
				if (settled || finishing) return;
				respond(options.status(target, childController.signal).then((result) => {
					if (settled || finishing) return result;
					trace.push({ operation: "status", key: keyOrRunId, state: result.ok ? "completed" : "failed", ...(result.runId ? { runId: result.runId } : {}), ...(!result.ok ? { error: result.output } : {}) });
					traceChanged();
					if (!result.ok) throw new Error(`Status '${keyOrRunId}' failed: ${result.output}`);
					return result;
				}));
				return;
			}
			if (message.method === "steer") {
				let key: string;
				try {
					key = validateKey(message.args.key, "runs.steer");
				} catch (error) {
					return respond(Promise.reject(error));
				}
				const steerMessage = message.args.message;
				if (typeof steerMessage !== "string" || !steerMessage.trim()) return respond(Promise.reject(new Error(`runs.steer('${key}') requires a non-empty message.`)));
				const steerOptions = isRecord(message.args.options) ? message.args.options as WorkflowSteerOptions : {};
				if (acceptanceRecoveryBarrier) return respond(Promise.reject(new Error(recoveryBarrierMessage(acceptanceRecoveryBarrier.key, `runs.steer('${key}')`))));
				const startedAt = Date.now();
				trace.push({ operation: "steer", key, state: "started" });
				traceChanged();
				const promise = Promise.resolve().then(() => {
					if (!launches.has(key)) throw new Error(`runs.steer('${key}') requires a prior runs.run/runs.all launch with that key.`);
					if (!options.steer) throw new Error("Workflow steering is unavailable in this host.");
					return options.steer(key, steerMessage.trim(), steerOptions, childController.signal);
				}).then((receipt) => {
					trace.push({ operation: "steer", key, state: receipt.state, durationMs: Date.now() - startedAt, ...(receipt.error ? { error: receipt.error } : {}) });
					traceChanged();
					return receipt;
				}, (error: unknown) => {
					const text = error instanceof Error ? error.message : String(error);
					trace.push({ operation: "steer", key, state: "failed", durationMs: Date.now() - startedAt, error: text });
					traceChanged();
					throw error;
				});
				steers.set(message.callId, { key, promise, observed: observedSteerCalls.delete(message.callId) });
				respond(promise);
				return;
			}
			if (message.method === "host") {
				let key: string;
				let params: WorkflowHostCommandParams;
				try {
					key = validateKey(message.args.key, "runs.host");
					params = normalizeWorkflowHostCommandParams(message.args.params, `runs.host('${key}') params`);
				} catch (error) {
					return respond(Promise.reject(error));
				}
				if (acceptanceRecoveryBarrier) return respond(Promise.reject(new Error(recoveryBarrierMessage(acceptanceRecoveryBarrier.key, `runs.host('${key}')`))));
				if (!options.host) return respond(Promise.reject(new Error("runs.host is unavailable in this host context.")));
				if (hostCalls.size >= HOST_STEP_MAX_COUNT) return respond(Promise.reject(new Error(`workflowScript supports at most ${HOST_STEP_MAX_COUNT} runs.host calls.`)));
				const startedAt = Date.now();
				const startedStep: HostStepNode = {
					version: 1,
					kind: "host-step",
					monitorKind: "command",
					id: key,
					label: key,
					...(params.role ? { role: params.role } : {}),
					...(params.provider ? { provider: params.provider } : {}),
					state: "running",
					updatedAt: startedAt,
					deadlineAt: startedAt + params.timeoutMs,
				};
				hostStepChanged(startedStep);
				trace.push({ operation: "host", key, state: "started" });
				traceChanged();
				const promise = Promise.resolve().then(() => options.host!(key, params, childController.signal)).then((result) => {
					const state = result.state === "stopped" ? "cancelled" : result.ok ? "done" : "error";
					const detail = [result.error, result.stderr.trim() || result.stdout.trim()].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
					hostStepChanged({ ...startedStep, state, ...(state === "done" ? { verdict: "pass" as const } : {}), ...(!result.ok ? { reasonCode: result.state === "timed-out" ? "timed_out" : result.state === "stopped" ? "aborted" : "command_failed" } : {}), ...(detail ? { detail } : {}), reportPath: params.output ?? result.outputPath.split(/[\\/]/).at(-1), exitCode: result.exitCode, updatedAt: Date.now() });
					trace.push({ operation: "host", key, state: result.ok ? "completed" : result.state === "stopped" ? "stopped" : "failed", durationMs: result.durationMs, ...(!result.ok ? { error: result.error ?? "Host command failed." } : {}) });
					traceChanged();
					if (!result.ok) throw new Error(`Host command '${key}' failed: ${detail || result.error || `exit code ${result.exitCode ?? "unknown"}`}`);
					return result;
				}, (error: unknown) => {
					const text = error instanceof Error ? error.message : String(error);
					hostStepChanged({ ...startedStep, state: "error", reasonCode: "execution_failed", detail: text.replace(/\s+/g, " ").slice(0, 200), updatedAt: Date.now() });
					trace.push({ operation: "host", key, state: "failed", durationMs: Date.now() - startedAt, error: text });
					traceChanged();
					throw error;
				});
				hostCalls.set(message.callId, { key, promise, observed: observedHostCalls.delete(message.callId) });
				respond(promise, `runs.host('${key}') result`);
				return;
			}
			if (message.method !== "run") return respond(Promise.reject(new Error(`Unknown runs API method '${message.method}'.`)));

			let key: string;
			try {
				key = validateKey(message.args.key);
			} catch (error) {
				return respond(Promise.reject(error));
			}
			const params = message.args.params;
			if (!isRecord(params)) return respond(Promise.reject(new Error(`runs.run('${key}', params) requires a params object.`)));
			const generatedLaneKey = typeof message.args.generatedLaneKey === "string" && KEY_PATTERN.test(message.args.generatedLaneKey) && key.startsWith(`${message.args.generatedLaneKey}.`)
				? message.args.generatedLaneKey
				: undefined;
			const collectFailure = message.args.collectFailure === true;
			const callObserved = observedRunCalls.delete(message.callId);
			const deliver = (promise: Promise<WorkflowScriptChildResult>) => collectFailure
				? promise
				: promise.then((result) => {
					const recoverableAcceptanceMetadata = result.recovery?.status === "available-for-review"
						&& result.recovery.reason === "acceptance-metadata-rejected";
					if (!result.ok && result.state !== "running" && !result.stopped && !recoverableAcceptanceMetadata) {
						throw taggedWorkflowError(`Run '${key}' ${result.detached ? "detached" : "failed"}: ${result.error ?? result.output}`, result.detached ? "detached-child" : "child");
					}
					return result;
				});
			const fingerprint = workflowRunParamsFingerprint(params);
			const existing = launches.get(key);
			if (existing) {
				if (existing.fingerprint !== fingerprint) return respond(Promise.reject(new Error(`Duplicate workflow key '${key}' used with incompatible launch params.`)));
				if (callObserved) existing.observed = true;
				trace.push({ operation: "run", key, state: "reused", ...workflowStringMetadata(params), ...(existing.generatedLaneKey ? { generatedLaneKey: existing.generatedLaneKey } : {}) });
				traceChanged();
				return respond(deliver(existing.promise), `runs.run('${key}') result`, (error) => children.set(key, responseBoundaryFailure(key, error)));
			}
			const permitError = options.oneUsePermit?.claim(key);
			if (permitError) return respond(Promise.reject(new Error(permitError)));
			if (options.oneUsePermit && message.args.batch !== undefined) return respond(Promise.reject(new Error("Workflow child permit does not support runs.all.")));
			if (options.oneUsePermit && params.resume !== undefined) return respond(Promise.reject(new Error("Workflow child permit does not support retained resume.")));
			if (params.action !== undefined) return respond(Promise.reject(new Error(`runs.run('${key}') accepts execution params only; management action is not allowed.`)));
			if (params.workflowScript !== undefined) return respond(Promise.reject(new Error(`runs.run('${key}') cannot start a nested workflow script.`)));
			if (params.tasks !== undefined || params.chain !== undefined || params.parallel !== undefined || params.concurrency !== undefined || params.chainDir !== undefined) {
				return respond(Promise.reject(new Error(`runs.run('${key}') accepts one child via { agent, task }; use runs.all(...) and JavaScript control flow for orchestration.`)));
			}
			if (params.worktree !== undefined && typeof params.worktree !== "boolean") {
				return respond(Promise.reject(new Error(`runs.run('${key}') worktree must be true or false.`)));
			}
			if (params.baseRef !== undefined && (typeof params.baseRef !== "string" || !validGitRef(params.baseRef))) {
				return respond(Promise.reject(new Error(`runs.run('${key}') ${BASE_REF_VALIDATION_ERROR}`)));
			}
			if (params.gate !== undefined) {
				const parsedGate = parseGateInput(params.gate);
				if (!parsedGate.ok) return respond(Promise.reject(new Error(`runs.run('${key}') ${parsedGate.error}`)));
			}
			if (params.gate !== undefined && params.acceptance !== undefined && params.acceptance !== false) {
				return respond(Promise.reject(new Error(`runs.run('${key}') gate cannot be combined with acceptance; use one gate command or acceptance.verify.` + describeGateAcceptanceConflict(params.gate, params.acceptance))));
			}
			if (params.gate !== undefined && params.resume !== undefined) {
				return respond(Promise.reject(new Error(`runs.run('${key}') gate is not supported with retained resume.`)));
			}
			let resumeReference: WorkflowReceiptResumeReference | undefined;
			try {
				if (params.resume !== undefined && typeof params.resume !== "string") resumeReference = parseWorkflowResumeReference(params.resume);
			} catch (error) {
				return respond(Promise.reject(new Error(`runs.run('${key}') ${error instanceof Error ? error.message : String(error)}`)));
			}
			if (typeof params.resume === "string" && !params.resume.trim()) return respond(Promise.reject(new Error(`runs.run('${key}') resume must be a non-empty retained run id.`)));
			if (params.resume !== undefined && params.agent !== undefined) {
				return respond(Promise.reject(new Error(`runs.run('${key}') resume and agent are mutually exclusive.`)));
			}
			if (params.resume !== undefined && (typeof params.task !== "string" || !params.task.trim())) {
				return respond(Promise.reject(new Error(`runs.run('${key}') resume requires a non-empty task follow-up.`)));
			}
			const startedAt = Date.now();
			const batch = isRecord(message.args.batch) && typeof message.args.batch.id === "string" && Array.isArray(message.args.batch.calls)
				? { id: message.args.batch.id, calls: message.args.batch.calls.filter((call): call is { key: string; params: Record<string, unknown> } => isRecord(call) && typeof call.key === "string" && isRecord(call.params)) }
				: undefined;
			let admission = batch ? batchAdmissions.get(batch.id) : undefined;
			if (!admission) {
				const seenKeys = new Set<string>();
				const calls = (batch?.calls ?? [{ key, params }]).filter((call) => {
					if (seenKeys.has(call.key) || launches.has(call.key)) return false;
					seenKeys.add(call.key);
					return true;
				});
				admission = Promise.resolve().then(() => {
					if (settled || finishing) return;
					for (const call of calls) assertRecoveryBarrierAllowsRun(call.key, call.params);
					return options.admit?.(calls, childController.signal);
				});
				if (batch) batchAdmissions.set(batch.id, admission);
			}
			let resolvedResumeLineage: string[] | undefined;
			const promise = admission.then(async () => {
				if (settled || finishing || stoppedLaunches.has(key)) {
					const reason = childController.signal.reason;
					const text = children.get(key)?.error ?? (reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Workflow script aborted.");
					return stoppedChildResult(key, text);
				}
				const childStopController = new AbortController();
				childStopControllers.set(key, childStopController);
				const childSignal = combinedAbortSignal([childController.signal, childStopController.signal]);
				const resumeInput = resumeReference ?? (typeof params.resume === "string" && options.resolveResume ? params.resume : undefined);
				const resolvedResumeValue = resumeInput
					? await Promise.resolve().then(() => {
						if (!options.resolveResume) throw new Error("Keyed workflow receipt resume is unavailable in this host.");
						return options.resolveResume(resumeInput, childSignal, typeof params.index === "number" ? params.index : undefined);
					})
					: undefined;
				const resolvedResume = typeof resolvedResumeValue === "string"
					? resolvedResumeValue
					: isRecord(resolvedResumeValue) && typeof resolvedResumeValue.runId === "string"
						? resolvedResumeValue.runId
						: undefined;
				if (resumeReference && (typeof resolvedResume !== "string" || !resolvedResume.trim())) throw new Error("Keyed workflow receipt resume resolved without a retained run id.");
				const resolvedResumeId = resolvedResume?.trim();
				if (isRecord(resolvedResumeValue)) {
					const lineage = Array.isArray(resolvedResumeValue.runIds)
						? resolvedResumeValue.runIds.filter((runId): runId is string => typeof runId === "string" && Boolean(runId.trim())).map((runId) => runId.trim())
						: [];
					resolvedResumeLineage = [...new Set(lineage.length ? lineage : [resolvedResumeId!])];
					if (resolvedResumeLineage.at(-1) !== resolvedResumeId) resolvedResumeLineage.push(resolvedResumeId!);
					if (typeof resumeInput === "string") {
						const predecessor = [...children.values()].find((child) => child.runId === resolvedResumeId);
						if (predecessor?.continuation && predecessor.continuation.runIds.at(-1) === resolvedResumeId) resolvedResumeLineage = predecessor.continuation.runIds;
					}
				}
				const launchParams = resolvedResumeId ? { ...params, resume: resolvedResumeId } : params;
				await launchSemaphore.acquire();
				try {
					if (settled || finishing || stoppedLaunches.has(key) || childSignal.aborted) {
						const reason = childSignal.reason;
						const text = children.get(key)?.error ?? (reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Workflow script aborted.");
						return stoppedChildResult(key, text);
					}
					const result = await options.launch(key, launchParams, childSignal, { admitted: true, batch: batch !== undefined });
					const autoResumeParams = setupAbortResumeParams(params, result, childSignal);
					if (!autoResumeParams) return result;
					resolvedResumeLineage = [...new Set([...(resolvedResumeLineage ?? []), result.runId!])];
					trace.push({ operation: "run", key, state: "started", ...workflowStringMetadata(autoResumeParams), ...(generatedLaneKey ? { generatedLaneKey } : {}), phase: "auto-resume", runId: result.runId });
					traceChanged();
					return options.launch(key, autoResumeParams, childSignal, { admitted: true, batch: batch !== undefined });
				} finally {
					launchSemaphore.release();
				}
			}, (error: unknown) => {
				if (!childController.signal.aborted) throw error;
				const reason = childController.signal.reason;
				return stoppedChildResult(key, reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Workflow script aborted.");
			}).then((result) => {
				let normalized = !result.ok && result.state !== "running" && !result.error ? { ...result, error: result.output } : result;
				if (resolvedResumeLineage?.length && normalized.runId) {
					normalized = { ...normalized, continuation: { runIds: [...new Set([...resolvedResumeLineage, normalized.runId])] } };
				}
				childStopControllers.delete(key);
				if (stoppedLaunches.has(key)) return children.get(key) ?? normalized;
				children.set(key, normalized);
				recordAcceptanceRecoveryBarrier(key, normalized);
				const state = normalized.state === "running" ? "started" : normalized.ok ? "completed" : normalized.stopped ? "stopped" : normalized.detached ? "detached" : "failed";
				const settledEntry: WorkflowScriptTraceEntry = { operation: "run", key, state, durationMs: Date.now() - startedAt, ...workflowStringMetadata(params), ...(generatedLaneKey ? { generatedLaneKey } : {}), ...(normalized.agent ? { agent: normalized.agent } : {}), ...(normalized.runId ? { runId: normalized.runId } : {}), ...(!normalized.ok && normalized.state !== "running" ? { error: normalized.error ?? normalized.output } : {}) };
				if (normalized.reused) settledEntry.reused = true;
				trace.push(settledEntry);
				traceChanged();
				notifyChildSettled(key, normalized);
				return normalized;
			}, (error: unknown) => {
				const text = error instanceof Error ? error.message : String(error);
				const failure: WorkflowScriptChildResult = { key, ok: false, output: text, error: text, artifactPaths: [] };
				childStopControllers.delete(key);
				if (stoppedLaunches.has(key)) return children.get(key) ?? { ...failure, stopped: true };
				children.set(key, failure);
				trace.push({ operation: "run", key, state: "failed", durationMs: Date.now() - startedAt, ...workflowStringMetadata(params), ...(generatedLaneKey ? { generatedLaneKey } : {}), error: text });
				traceChanged();
				notifyChildSettled(key, failure);
				return failure;
			});
			launches.set(key, { fingerprint, promise, observed: callObserved, ...(generatedLaneKey ? { generatedLaneKey } : {}) });
			childOrder.push(key);
			trace.push({ operation: "run", key, state: "started", ...workflowStringMetadata(params), ...(generatedLaneKey ? { generatedLaneKey } : {}) });
			traceChanged();
			respond(deliver(promise), `runs.run('${key}') result`, (error) => children.set(key, responseBoundaryFailure(key, error)));
		});

		worker.postMessage({ type: "start", script: options.script, ...(options.args ? { args: options.args } : {}), stateEnabled: options.state !== undefined });
	});
}
