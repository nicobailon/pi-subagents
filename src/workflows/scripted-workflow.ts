import { Worker } from "node:worker_threads";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const vm = require("node:vm");
const { inspect } = require("node:util");

let nextCallId = 0;
const pending = new Map();

function hostCall(method, args) {
  return new Promise((resolve, reject) => {
    const callId = ++nextCallId;
    pending.set(callId, { resolve, reject });
    parentPort.postMessage({ type: "call", callId, method, args });
  });
}

function formatRef(result) {
  if (!result || typeof result !== "object") throw new Error("runs.ref(result) requires a run result object.");
  const parts = ["run " + (result.key || "unknown")];
  if (result.runId) parts.push("id=" + result.runId);
  const paths = Array.isArray(result.artifactPaths) ? result.artifactPaths.filter((value) => typeof value === "string") : [];
  if (paths.length) parts.push("artifacts=" + paths.join(","));
  return "[" + parts.join("; ") + "]";
}

const runs = Object.freeze({
  run(key, params) { return hostCall("run", { key, params }); },
  all(items) {
    if (!Array.isArray(items)) throw new Error("runs.all(items) requires an array.");
    return Promise.all(items.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("runs.all item " + index + " must be an object.");
      const { key, ...params } = item;
      return hostCall("run", { key, params });
    }));
  },
  status(keyOrRunId) { return hostCall("status", { keyOrRunId }); },
  ref: formatRef,
  refs(results) {
    if (!Array.isArray(results)) throw new Error("runs.refs(results) requires an array.");
    return results.map(formatRef).join("\n");
  },
});

const capturedConsole = Object.freeze(Object.fromEntries(
  ["log", "info", "warn", "error"].map((level) => [level, (...args) => {
    parentPort.postMessage({ type: "console", level, text: args.map((value) => typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: 120 })).join(" ") });
  }]),
));

parentPort.on("message", async (message) => {
  if (message.type === "response") {
    const entry = pending.get(message.callId);
    if (!entry) return;
    pending.delete(message.callId);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new Error(message.error));
    return;
  }
  if (message.type !== "start") return;
  try {
    const sandbox = { runs, emit(value) { parentPort.postMessage({ type: "emit", value }); }, console: capturedConsole };
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    const compiled = new vm.Script("(async () => {\n" + message.script + "\n})()", { filename: "workflow-script.js" });
    const value = await compiled.runInContext(context);
    parentPort.postMessage({ type: "complete", value });
  } catch (error) {
    parentPort.postMessage({ type: "error", error: error && error.stack ? error.stack : String(error) });
  }
});
`;

export interface WorkflowScriptChildResult {
	key: string;
	ok: boolean;
	runId?: string;
	output: string;
	structuredOutput?: unknown;
	artifactPaths: string[];
	results?: unknown[];
}

export interface WorkflowScriptTraceEntry {
	operation: "run" | "status";
	key: string;
	state: "started" | "completed" | "failed" | "reused";
	runId?: string;
	durationMs?: number;
	error?: string;
}

export interface WorkflowScriptResult {
	value: unknown;
	emits: unknown[];
	console: Array<{ level: "log" | "info" | "warn" | "error"; text: string }>;
	trace: WorkflowScriptTraceEntry[];
	children: WorkflowScriptChildResult[];
}

export class WorkflowScriptError extends Error {
	readonly partial: Omit<WorkflowScriptResult, "value">;

	constructor(message: string, partial: Omit<WorkflowScriptResult, "value">) {
		super(message);
		this.name = "WorkflowScriptError";
		this.partial = partial;
	}
}

export interface RunWorkflowScriptOptions {
	script: string;
	timeoutMs: number;
	signal?: AbortSignal;
	launch: (key: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<WorkflowScriptChildResult>;
	status: (keyOrRunId: string, signal: AbortSignal) => Promise<WorkflowScriptChildResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value) ?? "undefined";
}

function validateKey(value: unknown): string {
	if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
		throw new Error("runs.run key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.");
	}
	return value;
}

export async function runWorkflowScript(options: RunWorkflowScriptOptions): Promise<WorkflowScriptResult> {
	if (!options.script.trim()) throw new Error("workflowScript must not be empty.");
	if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("workflow script timeout must be a positive integer.");

	const worker = new Worker(WORKER_SOURCE, { eval: true });
	const emits: unknown[] = [];
	const consoleEntries: WorkflowScriptResult["console"] = [];
	const trace: WorkflowScriptTraceEntry[] = [];
	const children = new Map<string, WorkflowScriptChildResult>();
	const launches = new Map<string, { fingerprint: string; promise: Promise<WorkflowScriptChildResult> }>();
	const childController = new AbortController();
	let settled = false;

	const partial = (): Omit<WorkflowScriptResult, "value"> => ({ emits, console: consoleEntries, trace, children: [...children.values()] });

	return await new Promise<WorkflowScriptResult>((resolve, reject) => {
		const finish = (outcome: { value: unknown } | { error: Error }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			void worker.terminate();
			childController.abort("error" in outcome ? outcome.error : new Error("Workflow script completed; unawaited child launches are aborted."));
			if ("error" in outcome) reject(new WorkflowScriptError(outcome.error.message, partial()));
			else resolve({ value: outcome.value, ...partial() });
		};
		const onAbort = () => finish({ error: new Error("Workflow script aborted.") });
		const timer = setTimeout(() => finish({ error: new Error(`Workflow script timed out after ${options.timeoutMs}ms.`) }), options.timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) return onAbort();

		worker.on("error", (error) => finish({ error: new Error(`Workflow worker failed: ${error.message}`) }));
		worker.on("exit", (code) => {
			if (!settled && code !== 0) finish({ error: new Error(`Workflow worker exited with code ${code}.`) });
		});
		worker.on("message", (message: Record<string, unknown>) => {
			if (message.type === "emit") {
				emits.push(message.value);
				return;
			}
			if (message.type === "console") {
				const level = message.level;
				if ((level === "log" || level === "info" || level === "warn" || level === "error") && typeof message.text === "string") consoleEntries.push({ level, text: message.text });
				return;
			}
			if (message.type === "complete") return finish({ value: message.value });
			if (message.type === "error") return finish({ error: new Error(typeof message.error === "string" ? message.error : "Workflow script failed.") });
			if (message.type !== "call" || typeof message.callId !== "number" || typeof message.method !== "string" || !isRecord(message.args)) return;

			const respond = (promise: Promise<WorkflowScriptChildResult>) => {
				void promise.then(
					(value) => worker.postMessage({ type: "response", callId: message.callId, ok: true, value }),
					(error: unknown) => worker.postMessage({ type: "response", callId: message.callId, ok: false, error: error instanceof Error ? error.message : String(error) }),
				);
			};

			if (message.method === "status") {
				const keyOrRunId = message.args.keyOrRunId;
				if (typeof keyOrRunId !== "string" || !keyOrRunId.trim()) return respond(Promise.reject(new Error("runs.status(keyOrRunId) requires a non-empty string.")));
				const known = children.get(keyOrRunId);
				const target = known?.runId ?? keyOrRunId;
				trace.push({ operation: "status", key: keyOrRunId, state: "started", ...(known?.runId ? { runId: known.runId } : {}) });
				respond(options.status(target, childController.signal).then((result) => {
					trace.push({ operation: "status", key: keyOrRunId, state: result.ok ? "completed" : "failed", ...(result.runId ? { runId: result.runId } : {}), ...(!result.ok ? { error: result.output } : {}) });
					if (!result.ok) throw new Error(`Status '${keyOrRunId}' failed: ${result.output}`);
					return result;
				}));
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
			if (params.action !== undefined) return respond(Promise.reject(new Error(`runs.run('${key}') accepts execution params only; management action is not allowed.`)));
			if (params.workflowScript !== undefined) return respond(Promise.reject(new Error(`runs.run('${key}') cannot start a nested workflow script.`)));
			const fingerprint = stableJson(params);
			const existing = launches.get(key);
			if (existing) {
				if (existing.fingerprint !== fingerprint) return respond(Promise.reject(new Error(`Duplicate workflow key '${key}' used with incompatible launch params.`)));
				trace.push({ operation: "run", key, state: "reused" });
				return respond(existing.promise);
			}

			const startedAt = Date.now();
			trace.push({ operation: "run", key, state: "started" });
			const promise = options.launch(key, { ...params, async: params.async ?? false }, childController.signal).then((result) => {
				children.set(key, result);
				trace.push({ operation: "run", key, state: result.ok ? "completed" : "failed", durationMs: Date.now() - startedAt, ...(result.runId ? { runId: result.runId } : {}), ...(!result.ok ? { error: result.output } : {}) });
				if (!result.ok) throw new Error(`Run '${key}' failed: ${result.output}`);
				return result;
			}, (error: unknown) => {
				const text = error instanceof Error ? error.message : String(error);
				trace.push({ operation: "run", key, state: "failed", durationMs: Date.now() - startedAt, error: text });
				throw new Error(`Run '${key}' failed: ${text}`);
			});
			launches.set(key, { fingerprint, promise });
			respond(promise);
		});

		worker.postMessage({ type: "start", script: options.script });
	});
}
