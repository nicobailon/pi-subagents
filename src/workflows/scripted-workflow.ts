import { Worker } from "node:worker_threads";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const vm = require("node:vm");
const { inspect } = require("node:util");
const { parse } = require("acorn");

let promiseHooks;
try {
  ({ promiseHooks } = require("node:v8"));
} catch {}

function createWorkflowPromiseHook(callbacks) {
  if (!promiseHooks || typeof promiseHooks.createHook !== "function") return () => {};
  try {
    return promiseHooks.createHook(callbacks);
  } catch (error) {
    if (error?.name !== "NotImplementedError") throw error;
    return () => {};
  }
}

let nextCallId = 0;
let topLevelWorkflowPromise;
let suppressNativePromiseConsumption = 0;
const activeNativePromises = [];
const pending = new Map();
const runKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const trackedPromiseTrackers = new WeakMap();
const trackedPromiseTargets = new WeakMap();
let nativePromiseTrackers = new WeakMap();
let nativePromiseParents = new WeakMap();
const observedRunCallIds = new Set();

function stableRunJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableRunJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableRunJson(value[key])).join(",") + "}";
  return JSON.stringify(value) ?? "undefined";
}

function isDirectWorkflowScriptPromiseHandlerCall() {
  const stack = new Error().stack;
  if (typeof stack !== "string") return false;
  return stack.split("\n").some((line) => line.includes("workflow-script.js") && !line.includes("at async "));
}

function nativePromiseTracker(promise) {
  if (!promise || (typeof promise !== "object" && typeof promise !== "function")) return undefined;
  let tracker = nativePromiseTrackers.get(promise);
  if (!tracker) {
    tracker = { observations: [], consumed: false, dependencies: [] };
    nativePromiseTrackers.set(promise, tracker);
  }
  return tracker;
}

function promiseObservationTracker(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  return trackedPromiseTrackers.get(value) ?? nativePromiseTrackers.get(value);
}

function addTrackerDependency(tracker, dependency) {
  if (!dependency) return;
  tracker.dependencies ??= [];
  if (!tracker.dependencies.includes(dependency)) tracker.dependencies.push(dependency);
  if (tracker.consumed) markTrackedObservationsConsumed(dependency);
}

function descendsFromTopLevelWorkflow(promise) {
  const seen = new Set();
  for (let current = promise; current && !seen.has(current); current = nativePromiseParents.get(current)) {
    if (current === topLevelWorkflowPromise) return true;
    seen.add(current);
  }
  return false;
}

function withSuppressedNativePromiseConsumption(callback) {
  suppressNativePromiseConsumption++;
  try {
    return callback();
  } finally {
    suppressNativePromiseConsumption--;
  }
}

function mergeObservations(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const observation of group) {
      if (!observation || typeof observation.callId !== "number" || typeof observation.key !== "string" || seen.has(observation.callId)) continue;
      seen.add(observation.callId);
      merged.push(observation);
    }
  }
  return merged;
}

function trackedObservationTracker(value) {
  return value && (typeof value === "object" || typeof value === "function") ? trackedPromiseTrackers.get(value) : undefined;
}

function trackedPromiseTarget(value) {
  return value && (typeof value === "object" || typeof value === "function") ? trackedPromiseTargets.get(value) ?? value : value;
}

function addTrackedObservations(tracker, observations) {
  tracker.observations = mergeObservations(tracker.observations, observations);
  if (!tracker.consumed) return;
  for (const observation of tracker.observations) {
    if (observedRunCallIds.has(observation.callId)) continue;
    observedRunCallIds.add(observation.callId);
    parentPort.postMessage({ type: "runObserved", callId: observation.callId, key: observation.key });
  }
}

function markTrackedObservationsConsumed(tracker, seen = new Set()) {
  if (seen.has(tracker)) return;
  seen.add(tracker);
  tracker.consumed = true;
  addTrackedObservations(tracker, []);
  for (const dependency of tracker.dependencies ?? []) markTrackedObservationsConsumed(dependency, seen);
}

function consumeTrackedObservations(tracker) {
  if (isDirectWorkflowScriptPromiseHandlerCall()) return;
  const activePromise = activeNativePromises.at(-1);
  if (activePromise === topLevelWorkflowPromise || descendsFromTopLevelWorkflow(activePromise)) {
    markTrackedObservationsConsumed(tracker);
  } else if (activePromise) {
    addTrackerDependency(nativePromiseTracker(activePromise), tracker);
  } else {
    markTrackedObservationsConsumed(tracker);
  }
}

function trackObservationTracker(tracker, promise, allowFutureObservations = false) {
  const target = trackedPromiseTarget(promise);
  if ((!allowFutureObservations && tracker.observations.length === 0) || !target || typeof target.then !== "function") return promise;

  const tracked = new Proxy(target, {
    get(promiseTarget, prop) {
      if (prop === "then") return function promiseThen(onFulfilled, onRejected) {
        consumeTrackedObservations(tracker);
        return trackObservationTracker({ observations: tracker.observations, consumed: false, dependencies: [tracker] }, promiseTarget.then(onFulfilled, onRejected), true);
      };
      if (prop === "catch") return function promiseCatch(onRejected) {
        consumeTrackedObservations(tracker);
        return trackObservationTracker({ observations: tracker.observations, consumed: false, dependencies: [tracker] }, promiseTarget.catch(onRejected), true);
      };
      if (prop === "finally") return function promiseFinally(onFinally) {
        consumeTrackedObservations(tracker);
        return trackObservationTracker({ observations: tracker.observations, consumed: false, dependencies: [tracker] }, promiseTarget.finally(onFinally), true);
      };
      return Reflect.get(promiseTarget, prop, promiseTarget);
    },
  });
  trackedPromiseTrackers.set(tracked, tracker);
  trackedPromiseTargets.set(tracked, target);
  return tracked;
}

function trackRunObservation(observations, promise) {
  const tracker = trackedObservationTracker(promise) ?? { observations: [], consumed: false };
  addTrackedObservations(tracker, observations);
  return trackObservationTracker(tracker, promise);
}

function trackPromiseCombinator(items, createPromise) {
  const values = Array.from(items);
  const dependencies = [...new Set(values.map(promiseObservationTracker).filter(Boolean))];
  const promise = withSuppressedNativePromiseConsumption(() => createPromise(values.map(trackedPromiseTarget)));
  if (dependencies.length === 0) return promise;
  return trackObservationTracker({ observations: [], consumed: false, dependencies }, promise, true);
}

const workflowPromise = new Proxy(Promise, {
  construct(target, [executor]) {
    if (typeof executor !== "function") return new target(executor);
    const tracker = { observations: [], consumed: false };
    const promise = new target((resolve, reject) => {
      let settled = false;
      try {
        executor((value) => {
          if (settled) return;
          settled = true;
          addTrackerDependency(tracker, promiseObservationTracker(value));
          resolve(trackedPromiseTarget(value));
        }, (reason) => {
          if (settled) return;
          settled = true;
          reject(reason);
        });
      } catch (error) {
        settled = true;
        throw error;
      }
    });
    return trackObservationTracker(tracker, promise, true);
  },
  get(target, prop) {
    if (prop === "all") return (items) => trackPromiseCombinator(items, (values) => target.all(values));
    if (prop === "allSettled") return (items) => trackPromiseCombinator(items, (values) => target.allSettled(values));
    if (prop === "race") return (items) => trackPromiseCombinator(items, (values) => target.race(values));
    if (prop === "any") return (items) => trackPromiseCombinator(items, (values) => target.any(values));
    if (prop === "resolve") return (value) => {
      const dependency = promiseObservationTracker(value);
      const promise = withSuppressedNativePromiseConsumption(() => target.resolve(trackedPromiseTarget(value)));
      if (!dependency) return promise;
      return trackObservationTracker({ observations: [], consumed: false, dependencies: [dependency] }, promise, true);
    };
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
});

function hostCall(method, args, observation) {
  const callId = ++nextCallId;
  const promise = new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject });
    parentPort.postMessage({ type: "call", callId, method, args });
  });
  return observation && typeof observation.key === "string"
    ? trackRunObservation([{ key: observation.key, callId }], promise)
    : promise;
}

function runHostCall(key, params, collectFailure, batch) {
  const callId = ++nextCallId;
  const promise = new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject });
    parentPort.postMessage({ type: "call", callId, method: "run", args: { key, params, ...(collectFailure ? { collectFailure: true } : {}), ...(batch ? { batch } : {}) } });
  });
  return { key, callId, promise };
}

function formatRef(result) {
  if (!result || typeof result !== "object") throw new Error("runs.ref(result) requires a run result object.");
  const parts = ["run " + (result.key || "unknown")];
  if (result.runId) parts.push("id=" + String(result.runId).slice(0, 8));
  return "[" + parts.join("; ") + "]";
}

const runFingerprints = new Map();

function validateRunCall(key, params, label, fingerprints) {
  if (typeof key !== "string" || !runKeyPattern.test(key)) throw new Error(label + " has an invalid key.");
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error(label + " requires a params object.");
  if (Object.prototype.hasOwnProperty.call(params, "action") || Object.prototype.hasOwnProperty.call(params, "workflowScript") || Object.prototype.hasOwnProperty.call(params, "tasks") || Object.prototype.hasOwnProperty.call(params, "chain") || Object.prototype.hasOwnProperty.call(params, "parallel") || Object.prototype.hasOwnProperty.call(params, "concurrency") || Object.prototype.hasOwnProperty.call(params, "chainDir")) {
    const hint = label === "runs.run" ? "; use runs.all(...) and JavaScript control flow for orchestration." : ".";
    throw new Error(label + " accepts one child via { agent, task } and execution controls only" + hint);
  }
  if (Object.prototype.hasOwnProperty.call(params, "clarify")) throw new Error(label + " does not support clarify UI.");
  if (params.worktree !== undefined && typeof params.worktree !== "boolean") throw new Error(label + " worktree must be true or false.");
  if (params.gate !== undefined && (typeof params.gate !== "string" || !params.gate.trim())) throw new Error(label + " gate must be a non-empty command string.");
  if (params.gate !== undefined && params.acceptance !== undefined) throw new Error(label + " gate cannot be combined with acceptance; use one gate command or acceptance.verify.");
  if (params.gate !== undefined && params.resume !== undefined) throw new Error(label + " gate is not supported with retained resume.");
  if (params.resume !== undefined && (typeof params.resume !== "string" || !params.resume.trim())) throw new Error(label + " resume must be a non-empty retained run id.");
  if (params.resume !== undefined && params.agent !== undefined) throw new Error(label + " resume and agent are mutually exclusive.");
  if (params.resume !== undefined && (typeof params.task !== "string" || !params.task.trim())) throw new Error(label + " resume requires a non-empty task follow-up.");
  assertJsonValue(params, label + " params");
  const fingerprint = stableRunJson(params);
  const existing = fingerprints.get(key);
  if (existing !== undefined && existing !== fingerprint) throw new Error("Duplicate workflow key '" + key + "' used with incompatible launch params.");
  fingerprints.set(key, fingerprint);
}

const runs = Object.freeze({
  run(key, params) {
    validateRunCall(key, params, "runs.run", runFingerprints);
    return hostCall("run", { key, params }, { key });
  },
  all(items) {
    if (!Array.isArray(items)) throw new Error("runs.all(items) requires an array.");
    const fingerprints = new Map(runFingerprints);
    const calls = [];
    for (let index = 0; index < items.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(items, index)) throw new Error("runs.all items must not contain sparse entries.");
      const item = items[index];
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("runs.all item " + index + " must be an object.");
      const { key, ...params } = item;
      validateRunCall(key, params, "runs.all item " + index, fingerprints);
      calls.push({ key, params });
    }
    for (const { key, params } of calls) runFingerprints.set(key, stableRunJson(params));
    const batch = { id: "batch-" + (++nextCallId), calls };
    const launched = calls.map(({ key, params }) => runHostCall(key, params, true, batch));
    return trackRunObservation(launched.map(({ key, callId }) => ({ key, callId })), Promise.all(launched.map(({ promise }) => promise)));
  },
  status(keyOrRunId) { return hostCall("status", { keyOrRunId }); },
  ref: formatRef,
  refs(results) {
    if (!Array.isArray(results)) throw new Error("runs.refs(results) requires an array.");
    return results.map(formatRef).join("\n");
  },
});

function validateStateKey(key) {
  if (typeof key !== "string" || !runKeyPattern.test(key)) throw new Error("state key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.");
  return key;
}

const state = Object.freeze({
  get(key) { return hostCall("state.get", { key: validateStateKey(key) }); },
  set(key, value) {
    const validKey = validateStateKey(key);
    assertJsonValue(value, "state.set('" + validKey + "') value");
    return hostCall("state.set", { key: validKey, value });
  },
});

let contextObjectPrototype;

const capturedConsole = Object.freeze(Object.fromEntries(
  ["log", "info", "warn", "error"].map((level) => [level, (...args) => {
    parentPort.postMessage({ type: "console", level, text: args.map((value) => typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: 120 })).join(" ") });
  }]),
));

function formatWorkflowScriptSyntaxError(error) {
  const details = formatWorkflowScriptError(error);
  return [
    "workflowScript must be valid JavaScript.",
    "If task text contains Markdown fences or backticks, use an array joined with \"\\n\" or escaped strings instead of a raw backtick template literal.",
    "",
    "Original SyntaxError:",
    details,
  ].join("\n");
}

function formatWorkflowScriptError(error) {
  const message = error && typeof error.message === "string" ? error.message : String(error);
  const stack = error && typeof error.stack === "string" ? error.stack : "";
  if (!stack) return message;
  return stack.includes(message) ? stack : message + "\n" + stack;
}

function isSyntaxError(error) {
  return error instanceof SyntaxError || error?.name === "SyntaxError";
}

const NESTED_ASYNC_WORKFLOW_ERROR = "workflowScript does not support nested async functions. Use top-level await, plain helper functions that return runs.run(...), or explicit Promise chains so workflows stay portable across Node and Bun.";
const AST_SCALAR_KEYS = new Set(["type", "start", "end"]);

function assertPortableWorkflowScript(source) {
  const wrapped = "(async () => {\n" + source + "\n})()";
  const ast = parse(wrapped, { ecmaVersion: "latest", sourceType: "script" });
  const wrapper = workflowWrapperFunction(ast);
  walkWorkflowAst(wrapper.body, wrapper);
}

function workflowWrapperFunction(ast) {
  const wrapper = ast.body?.[0]?.expression?.callee;
  if (!wrapper || wrapper.type !== "ArrowFunctionExpression") throw new Error("workflowScript wrapper parse invariant failed.");
  return wrapper;
}

function isAsyncFunctionNode(node) {
  return node.async === true && (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression");
}

function walkWorkflowAst(node, allowedAsyncFunction) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkWorkflowAst(item, allowedAsyncFunction);
    return;
  }
  if (node !== allowedAsyncFunction && isAsyncFunctionNode(node)) {
    throw new Error(NESTED_ASYNC_WORKFLOW_ERROR);
  }
  for (const [key, child] of Object.entries(node)) {
    if (AST_SCALAR_KEYS.has(key)) continue;
    walkWorkflowAst(child, allowedAsyncFunction);
  }
}

function assertJsonValue(value, path = "emit", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(path + " must contain only finite JSON numbers.");
    return;
  }
  if (typeof value !== "object") throw new Error(path + " must be a JSON value; received " + typeof value + ".");
  if (seen.has(value)) throw new Error(path + " must not contain cycles.");
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(path + " must not contain sparse array entries.");
      assertJsonValue(value[index], path + "[" + index + "]", seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype && prototype !== contextObjectPrototype) throw new Error(path + " must contain only plain JSON objects.");
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(path + " must not contain symbol keys.");
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, path + "." + key, seen);
  }
  seen.delete(value);
}

function isPlainWorkflowObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype || prototype === contextObjectPrototype;
}

function omitUndefinedWorkflowValues(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  const normalized = Array.isArray(value)
    ? value.map((entry) => entry === undefined ? null : omitUndefinedWorkflowValues(entry, seen))
    : isPlainWorkflowObject(value) && Object.getOwnPropertySymbols(value).length === 0
      ? Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => entry === undefined ? [] : [[key, omitUndefinedWorkflowValues(entry, seen)]]))
      : value;
  seen.delete(value);
  return normalized;
}

parentPort.on("message", async (message) => {
  if (message.type === "response") {
    const entry = pending.get(message.callId);
    if (!entry) return;
    pending.delete(message.callId);
    if (message.ok) entry.resolve(message.value);
    else {
      const error = new Error(message.error);
      if (message.errorKind === "detached-child") error.workflowErrorKind = "detached-child";
      entry.reject(error);
    }
    return;
  }
  if (message.type !== "start") return;
  try {
    const sandbox = { runs, Promise: workflowPromise, emit(value) { assertJsonValue(value); parentPort.postMessage({ type: "emit", value }); }, console: capturedConsole };
    if (message.stateEnabled) sandbox.state = state;
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    contextObjectPrototype = vm.runInContext("Object.prototype", context);
    let compiled;
    try {
      assertPortableWorkflowScript(message.script);
      compiled = new vm.Script("(async () => {\n" + message.script + "\n})()", { filename: "workflow-script.js" });
    } catch (error) {
      parentPort.postMessage({ type: "error", error: isSyntaxError(error) ? formatWorkflowScriptSyntaxError(error) : formatWorkflowScriptError(error) });
      return;
    }
    const nativePromisePrototype = vm.runInContext("(async () => {})().constructor.prototype", context);
    const nativeThenDescriptor = Object.getOwnPropertyDescriptor(nativePromisePrototype, "then");
    if (!nativeThenDescriptor || typeof nativeThenDescriptor.value !== "function") throw new Error("workflowScript could not inspect the VM Promise.prototype.then method.");
    const nativeThen = nativeThenDescriptor.value;
    let stopWorkflowPromiseHook;
    let value;
    try {
      Object.defineProperty(nativePromisePrototype, "then", {
        ...nativeThenDescriptor,
        value: function workflowPromiseThen(...args) {
          if (isDirectWorkflowScriptPromiseHandlerCall() || suppressNativePromiseConsumption > 0) {
            return withSuppressedNativePromiseConsumption(() => Reflect.apply(nativeThen, this, args));
          }
          return Reflect.apply(nativeThen, this, args);
        },
      });
      stopWorkflowPromiseHook = createWorkflowPromiseHook({
        before(promise) {
          activeNativePromises.push(promise);
        },
        after(promise) {
          const index = activeNativePromises.lastIndexOf(promise);
          if (index !== -1) activeNativePromises.splice(index, 1);
        },
        init(promise, parent) {
          const childTracker = nativePromiseTracker(promise);
          if (!parent) return;
          nativePromiseParents.set(promise, parent);
          const parentTracker = nativePromiseTracker(parent);
          addTrackerDependency(childTracker, parentTracker);
          const activePromise = activeNativePromises.at(-1);
          if (activePromise && activePromise !== parent) {
            addTrackerDependency(nativePromiseTracker(activePromise), parentTracker);
          } else if (!activePromise && suppressNativePromiseConsumption === 0) {
            markTrackedObservationsConsumed(parentTracker);
          }
        },
      });
      const workflowResultPromise = compiled.runInContext(context);
      topLevelWorkflowPromise = workflowResultPromise;
      markTrackedObservationsConsumed(nativePromiseTracker(workflowResultPromise));
      value = await workflowResultPromise;
    } finally {
      try {
        stopWorkflowPromiseHook?.();
      } finally {
        try {
          Object.defineProperty(nativePromisePrototype, "then", nativeThenDescriptor);
        } finally {
          topLevelWorkflowPromise = undefined;
          activeNativePromises.length = 0;
          suppressNativePromiseConsumption = 0;
          nativePromiseTrackers = new WeakMap();
          nativePromiseParents = new WeakMap();
        }
      }
    }
    const persistedValue = value === undefined ? null : omitUndefinedWorkflowValues(value);
    assertJsonValue(persistedValue, "return");
    parentPort.postMessage({ type: "complete", value: persistedValue });
  } catch (error) {
    parentPort.postMessage({ type: "error", error: isSyntaxError(error) ? formatWorkflowScriptSyntaxError(error) : formatWorkflowScriptError(error), ...(error && error.workflowErrorKind === "detached-child" ? { errorKind: "detached-child" } : {}) });
  }
});
`;

export interface WorkflowScriptChildResult {
	key: string;
	ok: boolean;
	/** Canonical child agent name when launch resolution produced one. */
	agent?: string;
	runId?: string;
	output: string;
	error?: string;
	detached?: boolean;
	structuredOutput?: unknown;
	artifactPaths: string[];
	results?: unknown[];
}

export interface WorkflowScriptTraceEntry {
	operation: "run" | "status";
	key: string;
	state: "started" | "completed" | "failed" | "detached" | "stopped" | "reused";
	/** Canonical child agent name when resolved launch or result data is available. */
	agent?: string;
	runId?: string;
	durationMs?: number;
	phase?: string;
	label?: string;
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
	readonly errorKind?: "detached-child";

	constructor(message: string, partial: Omit<WorkflowScriptResult, "value">, errorKind?: "detached-child") {
		super(message);
		this.name = "WorkflowScriptError";
		this.partial = partial;
		this.errorKind = errorKind;
	}
}

export interface RunWorkflowScriptOptions {
	script: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	admit?: (calls: Array<{ key: string; params: Record<string, unknown> }>) => void | Promise<void>;
	launch: (key: string, params: Record<string, unknown>, signal: AbortSignal, admission: { admitted: boolean }) => Promise<WorkflowScriptChildResult>;
	status: (keyOrRunId: string, signal: AbortSignal) => Promise<WorkflowScriptChildResult>;
	state?: {
		get: (key: string) => unknown | Promise<unknown>;
		set: (key: string, value: unknown) => void | Promise<void>;
	};
	onTrace?: (trace: WorkflowScriptTraceEntry[]) => void;
	onEmit?: (emits: unknown[]) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || prototype === Object.prototype;
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
		return typeof serialized === "string" ? serialized.slice(0, maxLength) : undefined;
	} catch {
		return undefined;
	}
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

function validateKey(value: unknown, owner = "runs.run"): string {
	if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
		throw new Error(`${owner} key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.`);
	}
	return value;
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

export async function runWorkflowScript(options: RunWorkflowScriptOptions): Promise<WorkflowScriptResult> {
	if (!options.script.trim()) throw new Error("workflowScript must not be empty.");
	if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)) throw new Error("workflow script timeout must be a positive integer.");

	const worker = new Worker(WORKER_SOURCE, { eval: true });
	const emits: unknown[] = [];
	const consoleEntries: WorkflowScriptResult["console"] = [];
	const trace: WorkflowScriptTraceEntry[] = [];
	const children = new Map<string, WorkflowScriptChildResult>();
	const childOrder: string[] = [];
	const launches = new Map<string, { fingerprint: string; promise: Promise<WorkflowScriptChildResult>; observed: boolean }>();
	const stoppedLaunches = new Set<string>();
	const batchAdmissions = new Map<string, Promise<void>>();
	const observedRunCalls = new Set<number>();
	const childController = new AbortController();
	let settled = false;

	const partial = (): Omit<WorkflowScriptResult, "value"> => ({ emits, console: consoleEntries, trace, children: childOrder.flatMap((key) => {
		const child = children.get(key);
		return child ? [child] : [];
	}) });
	const traceChanged = () => options.onTrace?.([...trace]);

	return await new Promise<WorkflowScriptResult>((resolve, reject) => {
		const finish = (outcome: { value: unknown } | { error: Error & { workflowErrorKind?: unknown } }) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			void worker.terminate();
			const unobservedKeys = "value" in outcome ? [...launches].filter(([, launch]) => !launch.observed).map(([key]) => key) : [];
			const completionError = unobservedKeys.length > 0
				? new Error(`workflowScript completed with unawaited runs.run launch(es): ${unobservedKeys.map((key) => `'${key}'`).join(", ")}. Await or return each launch.`)
				: undefined;
			childController.abort("error" in outcome ? outcome.error : completionError ?? new Error("Workflow script completed."));
			if ("error" in outcome) reject(new WorkflowScriptError(outcome.error.message, partial(), outcome.error.workflowErrorKind === "detached-child" ? "detached-child" : undefined));
			else if (completionError) reject(new WorkflowScriptError(completionError.message, partial()));
			else resolve({ value: outcome.value, ...partial() });
		};
		const onAbort = () => {
			const signalReason = options.signal?.reason;
			const error = signalReason instanceof Error
				? signalReason
				: typeof signalReason === "string"
					? new Error(signalReason)
					: new Error("Workflow script aborted.");
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
					error: error.message,
				});
			}
			traceChanged();
			finish({ error });
		};
		const timer = options.timeoutMs === undefined
			? undefined
			: setTimeout(() => finish({ error: new Error(`Workflow script timed out after ${options.timeoutMs}ms.`) }), options.timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) return onAbort();

		worker.on("error", (error) => finish({ error: new Error(`Workflow worker failed: ${error instanceof Error ? error.message : String(error)}`) }));
		worker.on("exit", (code) => {
			if (!settled && code !== 0) finish({ error: new Error(`Workflow worker exited with code ${code}.`) });
		});
		worker.on("message", (message: Record<string, unknown>) => {
			if (settled) return;
			if (message.type === "emit") {
				try {
					assertWorkflowJsonValue(message.value, "emit");
				} catch (error) {
					finish({ error: new Error(`Workflow emit could not be persisted: ${error instanceof Error ? error.message : String(error)}`) });
					return;
				}
				emits.push(message.value);
				try {
					options.onEmit?.([...emits]);
				} catch (error) {
					emits.pop();
					finish({ error: new Error(`Workflow emit could not be persisted: ${error instanceof Error ? error.message : String(error)}`) });
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
					return finish({ error: new Error(`Workflow return could not be persisted: ${error instanceof Error ? error.message : String(error)}`) });
				}
				return finish({ value: message.value });
			}
			if (message.type === "error") {
				const workflowError = new Error(typeof message.error === "string" ? message.error : "Workflow script failed.") as Error & { workflowErrorKind?: "detached-child" };
				if (message.errorKind === "detached-child") workflowError.workflowErrorKind = "detached-child";
				return finish({ error: workflowError });
			}
			if (message.type === "runObserved" && typeof message.callId === "number") {
				const key = typeof message.key === "string" ? message.key : undefined;
				const launch = key ? launches.get(key) : undefined;
				if (launch) launch.observed = true;
				else observedRunCalls.add(message.callId);
				return;
			}
			if (message.type !== "call" || typeof message.callId !== "number" || typeof message.method !== "string" || !isRecord(message.args)) return;

			const respond = (promise: Promise<unknown>) => {
				void promise.then(
					(value) => {
						if (!settled) worker.postMessage({ type: "response", callId: message.callId, ok: true, value: omitUndefinedWorkflowValues(value) });
					},
					(error: unknown) => {
						if (!settled) worker.postMessage({ type: "response", callId: message.callId, ok: false, error: error instanceof Error ? error.message : String(error), ...(error instanceof Error && (error as { workflowErrorKind?: unknown }).workflowErrorKind === "detached-child" ? { errorKind: "detached-child" } : {}) });
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
				if (settled) return;
				respond(options.status(target, childController.signal).then((result) => {
					if (settled) return result;
					trace.push({ operation: "status", key: keyOrRunId, state: result.ok ? "completed" : "failed", ...(result.runId ? { runId: result.runId } : {}), ...(!result.ok ? { error: result.output } : {}) });
					traceChanged();
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
			if (params.tasks !== undefined || params.chain !== undefined || params.parallel !== undefined || params.concurrency !== undefined || params.chainDir !== undefined) {
				return respond(Promise.reject(new Error(`runs.run('${key}') accepts one child via { agent, task }; use runs.all(...) and JavaScript control flow for orchestration.`)));
			}
			if (params.worktree !== undefined && typeof params.worktree !== "boolean") {
				return respond(Promise.reject(new Error(`runs.run('${key}') worktree must be true or false.`)));
			}
			if (params.gate !== undefined && (typeof params.gate !== "string" || !params.gate.trim())) {
				return respond(Promise.reject(new Error(`runs.run('${key}') gate must be a non-empty command string.`)));
			}
			if (params.gate !== undefined && params.acceptance !== undefined) {
				return respond(Promise.reject(new Error(`runs.run('${key}') gate cannot be combined with acceptance; use one gate command or acceptance.verify.`)));
			}
			if (params.gate !== undefined && params.resume !== undefined) {
				return respond(Promise.reject(new Error(`runs.run('${key}') gate is not supported with retained resume.`)));
			}
			if (params.resume !== undefined && (typeof params.resume !== "string" || !params.resume.trim())) {
				return respond(Promise.reject(new Error(`runs.run('${key}') resume must be a non-empty retained run id.`)));
			}
			if (params.resume !== undefined && params.agent !== undefined) {
				return respond(Promise.reject(new Error(`runs.run('${key}') resume and agent are mutually exclusive.`)));
			}
			if (params.resume !== undefined && (typeof params.task !== "string" || !params.task.trim())) {
				return respond(Promise.reject(new Error(`runs.run('${key}') resume requires a non-empty task follow-up.`)));
			}
			const collectFailure = message.args.collectFailure === true;
			const callObserved = observedRunCalls.delete(message.callId);
			const deliver = (promise: Promise<WorkflowScriptChildResult>) => collectFailure
				? promise
				: promise.then((result) => {
					if (!result.ok) {
						const childError = new Error(result.detached ? `Run '${key}' detached: ${result.error ?? result.output}` : `Run '${key}' failed: ${result.error ?? result.output}`) as Error & { workflowErrorKind?: "detached-child" };
						if (result.detached) childError.workflowErrorKind = "detached-child";
						throw childError;
					}
					return result;
				});
			const fingerprint = stableJson(params);
			const existing = launches.get(key);
			if (existing) {
				if (existing.fingerprint !== fingerprint) return respond(Promise.reject(new Error(`Duplicate workflow key '${key}' used with incompatible launch params.`)));
				if (callObserved) existing.observed = true;
				trace.push({ operation: "run", key, state: "reused", ...workflowStringMetadata(params) });
				traceChanged();
				return respond(deliver(existing.promise));
			}

			const startedAt = Date.now();
			const batch = isRecord(message.args.batch) && typeof message.args.batch.id === "string" && Array.isArray(message.args.batch.calls)
				? { id: message.args.batch.id, calls: message.args.batch.calls.filter((call): call is { key: string; params: Record<string, unknown> } => isRecord(call) && typeof call.key === "string" && isRecord(call.params)) }
				: undefined;
			let admission = batch ? batchAdmissions.get(batch.id) : undefined;
			if (!admission) {
				const seenKeys = new Set<string>();
				const calls = (batch?.calls ?? [{ key, params }]).filter((call) => {
					if (seenKeys.has(call.key) || launches.has(call.key) || call.params.resume !== undefined) return false;
					seenKeys.add(call.key);
					return true;
				});
				admission = Promise.resolve().then(() => {
					if (settled) return;
					return options.admit?.(calls);
				});
				if (batch) batchAdmissions.set(batch.id, admission);
			}
			const promise = admission.then(() => {
				if (settled || stoppedLaunches.has(key)) {
					const reason = childController.signal.reason;
					const text = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Workflow script aborted.";
					return { key, ok: false, output: text, error: text, artifactPaths: [] };
				}
				return options.launch(key, { ...params, async: params.async ?? false }, childController.signal, { admitted: true });
			}).then((result) => {
				const normalized = !result.ok && !result.error ? { ...result, error: result.output } : result;
				if (stoppedLaunches.has(key)) return normalized;
				children.set(key, normalized);
				const state = normalized.ok ? "completed" : normalized.detached ? "detached" : "failed";
				trace.push({ operation: "run", key, state, durationMs: Date.now() - startedAt, ...workflowStringMetadata(params), ...(normalized.agent ? { agent: normalized.agent } : {}), ...(normalized.runId ? { runId: normalized.runId } : {}), ...(!normalized.ok ? { error: normalized.error ?? normalized.output } : {}) });
				traceChanged();
				return normalized;
			}, (error: unknown) => {
				const text = error instanceof Error ? error.message : String(error);
				const failure: WorkflowScriptChildResult = { key, ok: false, output: text, error: text, artifactPaths: [] };
				if (stoppedLaunches.has(key)) return failure;
				children.set(key, failure);
				trace.push({ operation: "run", key, state: "failed", durationMs: Date.now() - startedAt, ...workflowStringMetadata(params), error: text });
				traceChanged();
				return failure;
			});
			launches.set(key, { fingerprint, promise, observed: callObserved });
			childOrder.push(key);
			trace.push({ operation: "run", key, state: "started", ...workflowStringMetadata(params) });
			traceChanged();
			respond(deliver(promise));
		});

		worker.postMessage({ type: "start", script: options.script, stateEnabled: options.state !== undefined });
	});
}
