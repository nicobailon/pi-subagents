import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { Worker } from "node:worker_threads";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const requireFromPackage = createRequire(import.meta.url);

export interface WorkflowScriptValidationError {
	message: string;
	line?: number;
	column?: number;
}

export interface WorkflowScriptValidationResult {
	ok: boolean;
	errors: WorkflowScriptValidationError[];
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { inspect } = require("node:util");
const { parse } = require(workerData.acornPath);

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
const observedCallIds = new Set();

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
      if (!observation || typeof observation.callId !== "number" || typeof observation.key !== "string" || typeof observation.operation !== "string" || seen.has(observation.callId)) continue;
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
    if (observedCallIds.has(observation.callId)) continue;
    observedCallIds.add(observation.callId);
    parentPort.postMessage({ type: "callObserved", callId: observation.callId, key: observation.key, operation: observation.operation });
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
        const chainTracker = { observations: tracker.observations, consumed: false, dependencies: [tracker] };
        const wrapHandler = (handler) => typeof handler === "function"
          ? function trackedThenHandler(...args) {
            const value = handler.apply(this, args);
            addTrackerDependency(chainTracker, promiseObservationTracker(value));
            return trackedPromiseTarget(value);
          }
          : handler;
        return trackObservationTracker(chainTracker, promiseTarget.then(wrapHandler(onFulfilled), wrapHandler(onRejected)), true);
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
  return observation && typeof observation.key === "string" && typeof observation.operation === "string"
    ? trackRunObservation([{ key: observation.key, operation: observation.operation, callId }], promise)
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

function isArrayIndexProperty(prop) {
  if (!/^(0|[1-9]\d*)$/.test(prop)) return false;
  const index = Number(prop);
  return Number.isSafeInteger(index) && index >= 0 && index < 4294967295;
}

const runsAllResultTargets = new WeakMap();

function runsAllKeyAccessError(prop) {
  return new Error("Cannot read runs.all result property '" + prop + "'. runs.all resolves to an ordered array, not a key map. Use results[0], array destructuring, or results.map((result) => result.output), not results." + prop + ".");
}

function wrapRunsAllResults(results, keys) {
  const keySet = new Set(keys);
  const proxy = new Proxy(results, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      if (prop === "then" || prop === "toJSON") return undefined;
      if (prop in target || isArrayIndexProperty(prop)) return Reflect.get(target, prop, receiver);
      if (keySet.has(prop)) throw runsAllKeyAccessError(prop);
      throw runsAllKeyAccessError(prop);
    },
  });
  runsAllResultTargets.set(proxy, results);
  return proxy;
}

function formatRef(result) {
  if (!result || typeof result !== "object") throw new Error("runs.ref(result) requires a run result object.");
  const parts = ["run " + (result.key || "unknown")];
  if (result.runId) parts.push("id=" + String(result.runId).slice(0, 8));
  return "[" + parts.join("; ") + "]";
}

function formatChildResultString(result) {
  const output = typeof result?.output === "string" ? result.output.trim() : "";
  return output || formatRef(result);
}

function decorateWorkflowChildResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  Object.defineProperties(result, {
    toString: { value() { return formatChildResultString(this); }, enumerable: false, configurable: true },
  });
  return result;
}

let runFingerprints = new Map();

function validateExtensionBindings(value, label) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " extensionBindings must be a plain JSON object.");
  const keys = Object.keys(value);
  if (keys.length > 16) throw new Error(label + " extensionBindings supports at most 16 namespaces.");
  for (const key of keys) if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})\/[1-9][0-9]{0,8}$/.test(key)) throw new Error(label + " extensionBindings namespace '" + key + "' must use a package-like name followed by '/<positive-version>'.");
  assertJsonValue(value, label + " extensionBindings");
  let propertyCount = 0;
  function visit(entry, depth) {
    if (!entry || typeof entry !== "object") return;
    if (depth > 16) throw new Error(label + " extensionBindings exceeds the maximum nesting depth of 16.");
    if (Array.isArray(entry)) { for (const item of entry) visit(item, depth + 1); return; }
    for (const child of Object.values(entry)) {
      propertyCount++;
      if (propertyCount > 256) throw new Error(label + " extensionBindings exceeds 256 total properties.");
      visit(child, depth + 1);
    }
  }
  visit(value, 0);
  if (new TextEncoder().encode(stableRunJson(value)).byteLength > 16384) throw new Error(label + " extensionBindings canonical JSON exceeds 16384 bytes.");
}

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
  if (params.extensionBindings !== undefined && params.resume !== undefined) throw new Error(label + " extensionBindings is not supported with retained resume; resume uses the original retained child binding.");
  if (params.resume !== undefined && typeof params.resume !== "string") {
    const reference = params.resume;
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw new Error(label + " resume must be a retained run id or keyed workflow receipt reference.");
    const fields = Object.keys(reference);
    if (fields.some((field) => field !== "workflowRunId" && field !== "key" && field !== "latest")) throw new Error(label + " keyed resume contains unsupported fields.");
    if (typeof reference.workflowRunId !== "string" || !reference.workflowRunId.trim()) throw new Error(label + " keyed resume workflowRunId must be non-empty.");
    if (typeof reference.key !== "string" || !runKeyPattern.test(reference.key)) throw new Error(label + " keyed resume key is invalid.");
    if (reference.latest !== true) throw new Error(label + " keyed resume requires latest: true.");
  }
  if (typeof params.resume === "string" && !params.resume.trim()) throw new Error(label + " resume must be a non-empty retained run id.");
  if (params.resume !== undefined && params.agent !== undefined) throw new Error(label + " resume and agent are mutually exclusive.");
  if (params.resume !== undefined && (typeof params.task !== "string" || !params.task.trim())) throw new Error(label + " resume requires a non-empty task follow-up.");
  validateExtensionBindings(params.extensionBindings, label);
  assertJsonValue(params, label + " params");
  const fingerprint = stableRunJson(params);
  const existing = fingerprints.get(key);
  if (existing !== undefined && existing !== fingerprint) throw new Error("Duplicate workflow key '" + key + "' used with incompatible launch params.");
  fingerprints.set(key, fingerprint);
}

const runs = Object.freeze({
  run(key, params) {
    validateRunCall(key, params, "runs.run", runFingerprints);
    const launched = runHostCall(key, params, false);
    return trackRunObservation([{ key, operation: "run", callId: launched.callId }], launched.promise.then(decorateWorkflowChildResult));
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
    runFingerprints = fingerprints;
    const batch = { id: "batch-" + (++nextCallId), calls };
    const launched = calls.map(({ key, params }) => runHostCall(key, params, true, batch));
    return trackRunObservation(launched.map(({ key, callId }) => ({ key, operation: "run", callId })), Promise.all(launched.map(({ promise }) => promise)).then((results) => wrapRunsAllResults(results.map(decorateWorkflowChildResult), calls.map(({ key }) => key))));
  },
  steer(key, message, options = {}) {
    if (typeof key !== "string" || !runKeyPattern.test(key)) throw new Error("runs.steer has an invalid key.");
    if (typeof message !== "string" || !message.trim()) throw new Error("runs.steer message must be a non-empty string.");
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("runs.steer options must be an object.");
    const allowed = new Set(["mode", "index", "ackTimeoutMs"]);
    for (const option of Object.keys(options)) if (!allowed.has(option)) throw new Error("runs.steer options contain unsupported field '" + option + "'.");
    if (options.mode !== undefined && options.mode !== "steer" && options.mode !== "follow_up" && options.mode !== "auto") throw new Error("runs.steer mode must be 'steer', 'follow_up', or 'auto'.");
    if (options.index !== undefined && (!Number.isInteger(options.index) || options.index < 0 || options.index > 1000000)) throw new Error("runs.steer index must be an integer between 0 and 1000000.");
    if (options.ackTimeoutMs !== undefined && (!Number.isInteger(options.ackTimeoutMs) || options.ackTimeoutMs < 1)) throw new Error("runs.steer ackTimeoutMs must be a positive integer.");
    return hostCall("steer", { key, message: message.trim(), options }, { key, operation: "steer" });
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

const NESTED_ASYNC_WORKFLOW_ERROR = "workflowScript validation failed before child launch; no children launched. workflowScript does not support nested async functions. Use top-level await, plain helper functions that return runs.run(...), or explicit Promise chains so workflows stay portable across Node and Bun. Parallel plus sequential rewrite: const a = runs.run(\"a\", { agent: \"worker\", task: \"A\" }); const writer = await runs.run(\"writer\", { agent: \"worker\", task: \"Write\" }); const review = await runs.run(\"review\", { agent: \"reviewer\", task: writer.output }); const [aResult] = await Promise.all([a]); return { a: aResult.output, issue: { writerRunId: writer.runId, reviewRunId: review.runId } };";
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

function unwrapRunsAllResults(value, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  const runsAllTarget = runsAllResultTargets.get(value);
  const target = runsAllTarget || value;
  if (seen.has(target)) return seen.get(target);
  if (Array.isArray(target)) {
    const copy = [];
    seen.set(target, copy);
    let changed = !!runsAllTarget;
    for (let index = 0; index < target.length; index++) {
      copy[index] = unwrapRunsAllResults(target[index], seen);
      changed ||= copy[index] !== target[index];
    }
    return changed ? copy : target;
  }
  if (!isPlainWorkflowObject(target) || Object.getOwnPropertySymbols(target).length > 0) return target;
  let changed = false;
  const entries = Object.entries(target).map(([key, entry]) => {
    const unwrapped = unwrapRunsAllResults(entry, seen);
    changed ||= unwrapped !== entry;
    return [key, unwrapped];
  });
  return changed ? Object.fromEntries(entries) : target;
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
    const sandbox = { runs, Promise: workflowPromise, emit(value) { const emittedValue = unwrapRunsAllResults(value); assertJsonValue(emittedValue); parentPort.postMessage({ type: "emit", value: emittedValue }); }, console: capturedConsole };
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
    try {
      assertJsonValue(persistedValue, "return");
    } catch (error) {
      parentPort.postMessage({ type: "error", errorPhase: "return-serialization", error: formatWorkflowScriptError(error) });
      return;
    }
    parentPort.postMessage({ type: "complete", value: persistedValue });
  } catch (error) {
    parentPort.postMessage({ type: "error", error: isSyntaxError(error) ? formatWorkflowScriptSyntaxError(error) : formatWorkflowScriptError(error), ...(error && error.workflowErrorKind === "detached-child" ? { errorKind: "detached-child" } : {}) });
  }
});
`;

export interface WorkflowScriptChildResult {
	key: string;
	ok: boolean;
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
	outputPathMapping?: { requestedPath: string; savedPath: string };
	externalAdapter?: import("../shared/types.ts").ExternalCliReceiptMetadata;
	resumability?: { state: "resumable" } | { state: "not-resumable"; reason: string };
	continuation?: { runIds: string[] };
	artifactPaths: string[];
	results?: unknown[];
}

export interface WorkflowScriptTraceEntry {
	operation: "run" | "status" | "steer";
	key: string;
	state: "started" | "completed" | "failed" | "detached" | "stopped" | "reused" | "queued" | "delivered" | "missed";
	/** Canonical child agent name when resolved launch or result data is available. */
	agent?: string;
	runId?: string;
	durationMs?: number;
	phase?: string;
	label?: string;
	error?: string;
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

export class WorkflowScriptError extends Error {
	readonly partial: Omit<WorkflowScriptResult, "value">;
	readonly errorKind?: "detached-child" | "timeout";

	constructor(message: string, partial: Omit<WorkflowScriptResult, "value">, errorKind?: "detached-child" | "timeout") {
		super(message);
		this.name = "WorkflowScriptError";
		this.partial = partial;
		this.errorKind = errorKind;
	}
}

export interface RunWorkflowScriptOptions {
	script: string;
	/** Host-only first-slice admission context. It is never sent to the workflow worker. */
	oneUsePermit?: { claim: (key: string) => string | undefined };
	timeoutMs?: number;
	signal?: AbortSignal;
	admit?: (calls: Array<{ key: string; params: Record<string, unknown> }>) => void | Promise<void>;
	launch: (key: string, params: Record<string, unknown>, signal: AbortSignal, admission: { admitted: boolean; batch: boolean }) => Promise<WorkflowScriptChildResult>;
	resolveResume?: (reference: WorkflowReceiptResumeReference, signal: AbortSignal) => string | WorkflowResolvedResumeReference | Promise<string | WorkflowResolvedResumeReference>;
	status: (keyOrRunId: string, signal: AbortSignal) => Promise<WorkflowScriptChildResult>;
	steer?: (key: string, message: string, options: WorkflowSteerOptions, signal: AbortSignal) => Promise<WorkflowSteerResult>;
	state?: {
		get: (key: string) => unknown | Promise<unknown>;
		set: (key: string, value: unknown) => void | Promise<void>;
	};
	registerStopChild?: (stop: ((key: string, message?: string) => boolean) | undefined) => void;
	onTrace?: (trace: WorkflowScriptTraceEntry[]) => void;
	onEmit?: (emits: unknown[]) => void;
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
		return typeof serialized === "string" ? serialized.slice(0, maxLength) : undefined;
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
	return ` Child work completed before return serialization failed. Recover outputs from: ${references.join(", ")}${children.length > references.length ? `, and ${children.length - references.length} more` : ""}. Return a plain projection such as { runId: child.runId, ok: child.ok, outputReference: child.outputReference }.`;
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

function directRunsCall(node: unknown, method: "run" | "all"): node is AstNode {
	if (!astNode(node) || node.type !== "CallExpression" || !astNode(node.callee) || node.callee.type !== "MemberExpression") return false;
	const property = node.callee.computed === true ? literalString(node.callee.property) : astNode(node.callee.property) && node.callee.property.type === "Identifier" ? node.callee.property.name : undefined;
	return property === method && astNode(node.callee.object) && node.callee.object.type === "Identifier" && node.callee.object.name === "runs";
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
			if (!astNode(property) || property.type !== "Property" || !astNode(property.value)) return undefined;
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

/** Parse a workflowScript and apply only rules that are decidable from its local syntax. */
export function validateWorkflowScript(script: string): WorkflowScriptValidationResult {
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
	walkAst(workflowBody, (node) => {
		if (node !== wrapper && node.async === true && (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression")) {
			errors.push({ message: "workflowScript does not support nested async functions. Use top-level await, plain helper functions that return runs.run(...), or explicit Promise chains.", ...nodeLocation(node) });
		}
		if (directRunsCall(node, "run")) {
			const args = Array.isArray(node.arguments) ? node.arguments : [];
			const keyNode = astNode(args[0]) ? args[0] : undefined;
			const key = literalString(keyNode);
			if (keyNode && key !== undefined && !KEY_PATTERN.test(key)) errors.push({ message: "runs.run key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.", ...nodeLocation(keyNode) });
			if (astNode(args[1])) {
				const message = definitelyNonJson(args[1]);
				if (message) errors.push({ message: `runs.run params are invalid: ${message}.`, ...nodeLocation(args[1]) });
			}
		}
		if (directRunsCall(node, "all")) {
			for (const entry of directRunsAllKeys(node)) if (!KEY_PATTERN.test(entry.key)) errors.push({ message: "runs.all item key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.", ...nodeLocation(entry.node) });
			const args = Array.isArray(node.arguments) ? node.arguments : [];
			if (astNode(args[0]) && args[0].type === "ArrayExpression" && Array.isArray(args[0].elements)) {
				for (const item of args[0].elements) if (astNode(item)) {
					const message = definitelyNonJson(item);
					if (message) errors.push({ message: `runs.all item params are invalid: ${message}.`, ...nodeLocation(item) });
				}
			}
		}
		const boundaryValue = node.type === "CallExpression" && astNode(node.callee) && node.callee.type === "Identifier" && node.callee.name === "emit" && Array.isArray(node.arguments) && astNode(node.arguments[0])
			? node.arguments[0]
			: node.type === "CallExpression" && astNode(node.callee) && node.callee.type === "MemberExpression" && astNode(node.callee.object) && node.callee.object.type === "Identifier" && node.callee.object.name === "state" && astNode(node.callee.property) && node.callee.property.type === "Identifier" && node.callee.property.name === "set" && Array.isArray(node.arguments) && astNode(node.arguments[1])
				? node.arguments[1]
				: undefined;
		if (boundaryValue) {
			const message = definitelyNonJson(boundaryValue);
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
				if (!astNode(declaration) || !astNode(declaration.id) || declaration.id.type !== "Identifier" || !astNode(declaration.init) || declaration.init.type !== "AwaitExpression" || !directRunsCall(declaration.init.argument, "all")) continue;
				const name = declaration.id.name as string;
				const keys = new Set(directRunsAllKeys(declaration.init.argument).map((entry) => entry.key));
				if (keys.size === 0) continue;
				const args = Array.isArray(declaration.init.argument.arguments) ? declaration.init.argument.arguments : [];
				const itemCount = astNode(args[0]) && args[0].type === "ArrayExpression" && Array.isArray(args[0].elements) ? args[0].elements.length : 0;
				const arrayResultShape = Array.from({ length: itemCount });
				for (const later of workflowBody.body.slice(statementIndex + 1)) walkAst(later, (node) => {
					if (node.type !== "MemberExpression" || !astNode(node.object) || node.object.type !== "Identifier" || node.object.name !== name) return;
					const property = node.computed === true ? literalString(node.property) : astNode(node.property) && node.property.type === "Identifier" ? node.property.name as string : undefined;
					if (property && keys.has(property) && !(property in arrayResultShape)) errors.push({ message: `runs.all returns an ordered array; '${name}.${property}' is keyed access. Use an index, destructuring, or map(...).`, ...nodeLocation(node) });
				}, false);
			}
		}
	}

	const unique = errors.filter((error, index) => errors.findIndex((candidate) => candidate.message === error.message && candidate.line === error.line && candidate.column === error.column) === index);
	return { ok: unique.length === 0, errors: unique };
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

const AUTO_RESUME_PARAM_KEYS = ["acceptance", "agentContract", "index", "intercomBridge", "label", "maxRuntimeMs", "output", "outputMode", "outputSchema", "phase", "skill", "skills", "task", "timeoutMs", "toolBudget", "turnBudget", "worktree"] as const;

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
	if (signal.aborted || result.ok || result.stopped || result.interrupted || !result.runId) return undefined;
	const childResult = Array.isArray(result.results) && result.results.length === 1 && isRecord(result.results[0]) ? result.results[0] : undefined;
	const error = typeof childResult?.error === "string" ? childResult.error : result.error;
	if (error !== "This operation was aborted" || !isZeroUsage(childResult?.usage)) return undefined;
	const messages = Array.isArray(childResult?.messages) ? childResult.messages : [];
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
	if (!options.script.trim()) throw new Error("workflowScript must not be empty.");
	if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)) throw new Error("workflow script timeout must be a positive integer.");

	let acornPath: string;
	try {
		acornPath = resolveWorkflowParserEntry();
	} catch (error) {
		throw new Error("Workflow parser dependency 'acorn' is unavailable from pi-subagents. Reinstall pi-subagents dependencies before launching workflowScript.", { cause: error });
	}
	const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { acornPath } });
	const emits: unknown[] = [];
	const consoleEntries: WorkflowScriptResult["console"] = [];
	const trace: WorkflowScriptTraceEntry[] = [];
	const children = new Map<string, WorkflowScriptChildResult>();
	const childOrder: string[] = [];
	const launches = new Map<string, { fingerprint: string; promise: Promise<WorkflowScriptChildResult>; observed: boolean }>();
	const steers = new Map<number, { key: string; promise: Promise<WorkflowSteerResult>; observed: boolean }>();
	const stoppedLaunches = new Set<string>();
	const childStopControllers = new Map<string, AbortController>();
	const batchAdmissions = new Map<string, Promise<void>>();
	const observedRunCalls = new Set<number>();
	const observedSteerCalls = new Set<number>();
	const childController = new AbortController();
	let settled = false;
	let finishing = false;

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
	const stoppedChildResult = (key: string, message: string): WorkflowScriptChildResult => ({ key, ok: false, stopped: true, output: message, error: message, artifactPaths: [] });
	const stopChild = (key: string, message = `Workflow child '${key}' stopped by user.`): boolean => {
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
			error: message,
		});
		traceChanged();
		return true;
	};
	options.registerStopChild?.(stopChild);

	return await new Promise<WorkflowScriptResult>((resolve, reject) => {
		const finish = (outcome: { value: unknown } | { error: Error & { workflowErrorKind?: unknown } }) => {
			if (settled || finishing) return;
			finishing = true;
			childController.abort("error" in outcome ? outcome.error : new Error("Workflow script completed."));
			void Promise.allSettled([...steers.values()].map(({ promise }) => promise)).then(() => {
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
							return unobservedSteers.length > 0 ? new Error(`workflowScript completed with unawaited runs.steer call(s): ${unobservedSteers.map((key) => `'${key}'`).join(", ")}. Await or return each call.`) : undefined;
						})()
						: undefined;
				if ("error" in outcome) reject(new WorkflowScriptError(outcome.error.message, partial(), outcome.error.workflowErrorKind === "detached-child" || outcome.error.workflowErrorKind === "timeout" ? outcome.error.workflowErrorKind : undefined));
				else if (completionError) reject(new WorkflowScriptError(completionError.message, partial()));
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
			: setTimeout(() => {
				const error = new Error(`Workflow script timed out after ${options.timeoutMs}ms.`) as Error & { workflowErrorKind: "timeout" };
				error.workflowErrorKind = "timeout";
				finish({ error });
			}, options.timeoutMs);
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
				const rawError = typeof message.error === "string" ? message.error : "Workflow script failed.";
				const text = message.errorPhase === "return-serialization" ? `${rawError}${workflowReturnRecoveryHint(partial().children)}` : rawError;
				const workflowError = new Error(text) as Error & { workflowErrorKind?: "detached-child" };
				if (message.errorKind === "detached-child") workflowError.workflowErrorKind = "detached-child";
				return finish({ error: workflowError });
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
				}
				return;
			}
			if (message.type !== "call" || typeof message.callId !== "number" || typeof message.method !== "string" || !isRecord(message.args)) return;

			const respond = (promise: Promise<unknown>, responsePath?: string) => {
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
							worker.postMessage({ type: "response", callId: message.callId, ok: false, error: `${responsePath} must contain only JSON data before it can be returned from workflowScript. Return a plain projection such as { runId, ok, output }. ${error instanceof Error ? error.message : String(error)}` });
						}
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
			if (message.method !== "run") return respond(Promise.reject(new Error(`Unknown runs API method '${message.method}'.`)));

			let key: string;
			try {
				key = validateKey(message.args.key);
			} catch (error) {
				return respond(Promise.reject(error));
			}
			const params = message.args.params;
			if (!isRecord(params)) return respond(Promise.reject(new Error(`runs.run('${key}', params) requires a params object.`)));
			const collectFailure = message.args.collectFailure === true;
			const callObserved = observedRunCalls.delete(message.callId);
			const deliver = (promise: Promise<WorkflowScriptChildResult>) => collectFailure
				? promise
				: promise.then((result) => {
					if (!result.ok && !result.stopped) {
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
				return respond(deliver(existing.promise), `runs.run('${key}') result`);
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
			if (params.gate !== undefined && (typeof params.gate !== "string" || !params.gate.trim())) {
				return respond(Promise.reject(new Error(`runs.run('${key}') gate must be a non-empty command string.`)));
			}
			if (params.gate !== undefined && params.acceptance !== undefined) {
				return respond(Promise.reject(new Error(`runs.run('${key}') gate cannot be combined with acceptance; use one gate command or acceptance.verify.`)));
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
					return options.admit?.(calls);
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
				const resolvedResumeValue = resumeReference
					? await Promise.resolve().then(() => {
						if (!options.resolveResume) throw new Error("Keyed workflow receipt resume is unavailable in this host.");
						return options.resolveResume(resumeReference, childSignal);
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
				}
				const launchParams = resolvedResumeId ? { ...params, resume: resolvedResumeId } : params;
				const result = await options.launch(key, launchParams, childSignal, { admitted: true, batch: batch !== undefined });
				const autoResumeParams = setupAbortResumeParams(params, result, childSignal);
				if (!autoResumeParams) return result;
				resolvedResumeLineage = [...new Set([...(resolvedResumeLineage ?? []), result.runId!])];
				trace.push({ operation: "run", key, state: "started", ...workflowStringMetadata(autoResumeParams), phase: "auto-resume", runId: result.runId });
				traceChanged();
				return options.launch(key, autoResumeParams, childSignal, { admitted: true, batch: batch !== undefined });
			}).then((result) => {
				let normalized = !result.ok && !result.error ? { ...result, error: result.output } : result;
				if (resolvedResumeLineage?.length && normalized.runId) {
					normalized = { ...normalized, continuation: { runIds: [...new Set([...resolvedResumeLineage, normalized.runId])] } };
				}
				childStopControllers.delete(key);
				if (stoppedLaunches.has(key)) return children.get(key) ?? normalized;
				children.set(key, normalized);
				const state = normalized.ok ? "completed" : normalized.stopped ? "stopped" : normalized.detached ? "detached" : "failed";
				trace.push({ operation: "run", key, state, durationMs: Date.now() - startedAt, ...workflowStringMetadata(params), ...(normalized.agent ? { agent: normalized.agent } : {}), ...(normalized.runId ? { runId: normalized.runId } : {}), ...(!normalized.ok ? { error: normalized.error ?? normalized.output } : {}) });
				traceChanged();
				return normalized;
			}, (error: unknown) => {
				const text = error instanceof Error ? error.message : String(error);
				const failure: WorkflowScriptChildResult = { key, ok: false, output: text, error: text, artifactPaths: [] };
				childStopControllers.delete(key);
				if (stoppedLaunches.has(key)) return children.get(key) ?? { ...failure, stopped: true };
				children.set(key, failure);
				trace.push({ operation: "run", key, state: "failed", durationMs: Date.now() - startedAt, ...workflowStringMetadata(params), error: text });
				traceChanged();
				return failure;
			});
			launches.set(key, { fingerprint, promise, observed: callObserved });
			childOrder.push(key);
			trace.push({ operation: "run", key, state: "started", ...workflowStringMetadata(params) });
			traceChanged();
			respond(deliver(promise), `runs.run('${key}') result`);
		});

		worker.postMessage({ type: "start", script: options.script, stateEnabled: options.state !== undefined });
	});
}
