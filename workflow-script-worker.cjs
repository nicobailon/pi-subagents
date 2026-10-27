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
const workflowErrorKinds = new WeakMap();
const runKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function validGitRef(ref) {
  if (typeof ref !== "string" || !ref || ref === "@" || new TextEncoder().encode(ref).length > 1024 || ref.startsWith("/") || ref.endsWith("/") || ref.includes("//") || ref.includes("..") || ref.includes("@{")) return false;
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(ref)) return false;
  if (/[[\]\\~^:?*\u0000-\u0020\u007f]/u.test(ref) || ref.endsWith(".") || ref.endsWith(".lock")) return false;
  return ref.split("/").every((component) => component.length > 0 && component !== "." && component !== ".." && !component.startsWith(".") && !component.endsWith(".") && !component.endsWith(".lock"));
}
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

function canonicalRunParams(params) {
  if (params.gate === undefined || params.acceptance !== false) return params;
  const { acceptance: _acceptance, ...withoutAcceptance } = params;
  return withoutAcceptance;
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

// Hosts that freeze built-ins make Promise.all and friends non-writable and non-configurable, and a
// Proxy over Promise itself may not return wrappers for those. Proxy a plain constructor instead.
const workflowPromiseTarget = function Promise() {};
workflowPromiseTarget.prototype = Promise.prototype;
const workflowPromise = new Proxy(workflowPromiseTarget, {
  apply() {
    throw new TypeError("Promise constructor cannot be invoked without 'new'");
  },
  construct(_proxyTarget, [executor]) {
    const target = Promise;
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
  get(_proxyTarget, prop) {
    const target = Promise;
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

function runHostCall(key, params, collectFailure, batch, generatedLaneKey) {
  const callId = ++nextCallId;
  const promise = new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject });
    parentPort.postMessage({ type: "call", callId, method: "run", args: { key, params, ...(collectFailure ? { collectFailure: true } : {}), ...(batch ? { batch } : {}), ...(generatedLaneKey ? { generatedLaneKey } : {}) } });
  });
  return { key, callId, promise };
}

function isArrayIndexProperty(prop) {
  if (!/^(0|[1-9]\d*)$/.test(prop)) return false;
  const index = Number(prop);
  return Number.isSafeInteger(index) && index >= 0 && index < 4294967295;
}

const runsAllResultTargets = new WeakMap();

const MAX_LANES = 32;
const MAX_LANE_STAGES = 16;
const MAX_LANE_STAGE_COUNT = 64;
const MAX_LANE_SPEC_BYTES = 64 * 1024;
const MAX_LANE_TASK_BYTES = 1024 * 1024;
const MAX_LANE_PATH_BYTES = 32 * 1024;
const MAX_LANE_BOARD_TEXT_BYTES = 256;
const LANE_PATH_FIELDS = new Set(["cwd", "output", "sessionDir"]);

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

function laneByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function laneBoardText(value) {
  if (typeof value !== "string" || !value) return undefined;
  if (laneByteLength(value) <= MAX_LANE_BOARD_TEXT_BYTES) return value;
  const bytes = new TextEncoder().encode(value).subarray(0, MAX_LANE_BOARD_TEXT_BYTES - 3);
  return new TextDecoder().decode(bytes) + "...";
}

function laneBoardPath(value) {
  if (typeof value !== "string" || !value || laneByteLength(value) > MAX_LANE_BOARD_TEXT_BYTES) return undefined;
  return value;
}

function validateLaneStageBounds(params, label) {
  if (typeof params.task === "string" && laneByteLength(params.task) > MAX_LANE_TASK_BYTES) throw new Error(label + " task exceeds 1 MiB when UTF-8 encoded.");
  for (const field of LANE_PATH_FIELDS) if (typeof params[field] === "string" && laneByteLength(params[field]) > MAX_LANE_PATH_BYTES) throw new Error(label + " " + field + " exceeds 32 KiB when UTF-8 encoded.");
}

function validateLaneKey(value, owner) {
  if (typeof value !== "string" || !runKeyPattern.test(value)) throw new Error(owner + " key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.");
  return value;
}

function laneStageParams(stage, previous) {
  const resume = stage.resume;
  const params = { ...stage.params };
  if (resume !== "previous") return params;
  if (!previous || typeof previous.runId !== "string" || !previous.runId.trim()) return undefined;
  return { ...params, resume: previous.runId.trim() };
}

function laneStageVerdict(result) {
  const structured = result && typeof result === "object" && !Array.isArray(result) ? result.structuredOutput : undefined;
  const verdict = structured && typeof structured === "object" && !Array.isArray(structured) ? structured.verdict : undefined;
  return typeof verdict === "string" && verdict.trim() ? laneBoardText(verdict.trim()) : undefined;
}

function laneStageIsBlocked(result) {
  const structured = result && typeof result === "object" && !Array.isArray(result) ? result.structuredOutput : undefined;
  return structured && typeof structured === "object" && !Array.isArray(structured) && structured.verdict === "blocked";
}

function laneStageRecord(stageKey, child, forcedState) {
  const result = child && typeof child === "object" && !Array.isArray(child) ? child : undefined;
  const ok = result?.ok === true;
  const verdict = laneStageVerdict(result);
  const blocked = laneStageIsBlocked(result);
  const state = forcedState ?? (result?.state === "running" ? "running" : result?.stopped ? "stopped" : result?.detached ? "detached" : ok ? blocked ? "blocked" : "completed" : "failed");
  const error = state !== "completed" && state !== "running"
    ? state === "blocked" && blocked
      ? "Stage returned a blocked verdict."
      : typeof result?.error === "string"
        ? result.error
        : typeof result?.output === "string"
          ? result.output
          : "Stage did not complete successfully."
    : undefined;
  return {
    key: stageKey,
    ...(typeof result?.runId === "string" && result.runId.trim() ? { runId: laneBoardText(result.runId.trim()) } : {}),
    ...(result ? { ok } : {}),
    state,
    ...(typeof result?.outputReference === "string" ? (laneBoardPath(result.outputReference) ? { outputReference: laneBoardPath(result.outputReference) } : {}) : {}),
    ...(verdict ? { verdict } : {}),
    ...(error ? { error: laneBoardText(error) } : {}),
  };
}

function laneFailure(stageKey, error) {
  const text = error instanceof Error ? error.message : String(error);
  return { key: stageKey, ok: false, output: text, error: text, artifactPaths: [] };
}

function runCollected(key, params, observe, generatedLaneKey) {
  validateRunCall(key, params, "runs.lanes stage", runFingerprints);
  const launched = runHostCall(key, params, true, undefined, generatedLaneKey);
  observe([{ key, operation: "run", callId: launched.callId }]);
  return launched.promise.then(decorateWorkflowChildResult);
}

function validateLaneSpecs(laneSpecs) {
  if (!Array.isArray(laneSpecs)) throw new Error("runs.lanes(lanes) requires an array.");
  if (laneSpecs.length === 0) throw new Error("runs.lanes(lanes) requires at least one lane.");
  if (laneSpecs.length > MAX_LANES) throw new Error("runs.lanes supports at most " + MAX_LANES + " lanes.");
  assertJsonValue(laneSpecs, "runs.lanes lanes");
  if (laneByteLength(stableRunJson(laneSpecs)) > MAX_LANE_SPEC_BYTES) throw new Error("runs.lanes canonical JSON exceeds 64 KiB.");
  const generatedKeys = new Set();
  const validationFingerprints = new Map();
  let stageCount = 0;
  const normalized = [];
  for (let laneIndex = 0; laneIndex < laneSpecs.length; laneIndex++) {
    const lane = laneSpecs[laneIndex];
    const laneLabel = "runs.lanes lane " + laneIndex;
    if (!lane || typeof lane !== "object" || Array.isArray(lane)) throw new Error(laneLabel + " must be an object.");
    const laneFields = Object.keys(lane);
    if (laneFields.some((field) => field !== "key" && field !== "stages")) throw new Error(laneLabel + " contains unsupported fields.");
    const laneKey = validateLaneKey(lane.key, laneLabel);
    if (!Array.isArray(lane.stages) || lane.stages.length === 0) throw new Error(laneLabel + " stages must contain at least one stage.");
    if (lane.stages.length > MAX_LANE_STAGES) throw new Error(laneLabel + " supports at most " + MAX_LANE_STAGES + " stages.");
    const stageKeys = new Set();
    const stages = [];
    for (let stageIndex = 0; stageIndex < lane.stages.length; stageIndex++) {
      stageCount++;
      if (stageCount > MAX_LANE_STAGE_COUNT) throw new Error("runs.lanes supports at most " + MAX_LANE_STAGE_COUNT + " total stages.");
      const stage = lane.stages[stageIndex];
      const stageLabel = laneLabel + " stage " + stageIndex;
      if (!stage || typeof stage !== "object" || Array.isArray(stage)) throw new Error(stageLabel + " must be an object.");
      const stageKey = validateLaneKey(stage.key, stageLabel);
      if (stageKeys.has(stageKey)) throw new Error(laneLabel + " contains duplicate stage key '" + stageKey + "'.");
      stageKeys.add(stageKey);
      const generatedKey = laneKey + "." + stageKey;
      validateLaneKey(generatedKey, stageLabel + " generated");
      if (generatedKeys.has(generatedKey)) throw new Error("runs.lanes generated child key '" + generatedKey + "' is duplicated.");
      generatedKeys.add(generatedKey);
      const resume = stage.resume;
      if (resume !== undefined && resume !== "previous") {
        if (stageIndex === 0 && typeof resume === "string") {
          throw new Error(stageLabel + " cannot resume a retained run id in runs.lanes; use runs.run(key, { resume: id }) outside lanes, or start the lane with an agent stage and use resume: \"previous\" later.");
        }
        throw new Error(stageLabel + " resume must be 'previous'.");
      }
      if (stageIndex === 0 && resume === "previous") throw new Error(stageLabel + " cannot resume previous without a predecessor stage.");
      const { key: _stageKey, resume: _resume, ...params } = stage;
      const validationParams = resume === "previous" ? { ...params, resume: "retained-run-placeholder" } : params;
      validateLaneStageBounds(validationParams, stageLabel);
      validateRunCall(generatedKey, validationParams, stageLabel, validationFingerprints);
      const existingFingerprint = runFingerprints.get(generatedKey);
      if (existingFingerprint !== undefined && (resume === "previous" || existingFingerprint !== stableRunJson(canonicalRunParams(params)))) {
        throw new Error("runs.lanes generated child key '" + generatedKey + "' is already used with incompatible launch params.");
      }
      stages.push({ key: stageKey, generatedKey, resume, params });
    }
    normalized.push({ key: laneKey, stages });
  }
  return normalized;
}

function runLane(lane, firstResult, observe) {
  const records = [];
  const appendSkipped = (start) => {
    for (let index = start; index < lane.stages.length; index++) records.push({ key: lane.stages[index].key, state: "skipped" });
  };
  const finish = (state, failedStage) => ({ key: lane.key, state, ...(failedStage ? { failedStage } : {}), stages: records });
  const visit = (index, previous) => {
    if (index >= lane.stages.length) return Promise.resolve(finish("complete"));
    const stage = lane.stages[index];
    if (index === 0) {
      const record = laneStageRecord(stage.key, previous);
      records.push(record);
      if (record.state !== "completed") {
        appendSkipped(index + 1);
        return Promise.resolve(finish("blocked", stage.key));
      }
      return visit(index + 1, previous);
    }
    if (stage.resume === "previous" && (!previous || typeof previous.runId !== "string" || !previous.runId.trim())) {
      records.push({ key: stage.key, state: "blocked", error: "Previous stage did not return a retained run id." });
      appendSkipped(index + 1);
      return Promise.resolve(finish("blocked", stage.key));
    }
    if (!previous || previous.ok !== true || laneStageIsBlocked(previous)) {
      records.push({ key: stage.key, state: "blocked", error: "Previous stage did not complete successfully." });
      appendSkipped(index + 1);
      return Promise.resolve(finish("blocked", stage.key));
    }
    const params = laneStageParams(stage, previous);
    if (!params) {
      records.push({ key: stage.key, state: "blocked", error: "Previous stage did not return a retained run id." });
      appendSkipped(index + 1);
      return Promise.resolve(finish("blocked", stage.key));
    }
    let launched;
    try {
      launched = runCollected(stage.generatedKey, params, observe, lane.key);
    } catch (error) {
      const failed = laneFailure(stage.generatedKey, error);
      records.push(laneStageRecord(stage.key, failed));
      appendSkipped(index + 1);
      return Promise.resolve(finish("blocked", stage.key));
    }
    return launched.then((result) => {
      const record = laneStageRecord(stage.key, result);
      records.push(record);
      if (record.state === "completed") return visit(index + 1, result);
      appendSkipped(index + 1);
      return finish("blocked", stage.key);
    }, (error) => {
      const failed = laneFailure(stage.generatedKey, error);
      records.push(laneStageRecord(stage.key, failed));
      appendSkipped(index + 1);
      return finish("blocked", stage.key);
    });
  };
  return visit(0, firstResult);
}

function workflowPlanStringMetadata(params) {
  return {
    ...(typeof params.phase === "string" && params.phase.trim() ? { phase: params.phase.trim() } : {}),
    ...(typeof params.label === "string" && params.label.trim() ? { label: params.label.trim() } : {}),
    ...(typeof params.agent === "string" && params.agent.trim() ? { agent: params.agent.trim() } : {}),
  };
}

function runLanes(laneSpecs) {
  const lanes = validateLaneSpecs(laneSpecs);
  parentPort.postMessage({ type: "lanePlan", lanes: lanes.map((lane) => ({
    key: lane.key,
    stages: lane.stages.map((stage) => ({
      key: stage.key,
      generatedKey: stage.generatedKey,
      ...workflowPlanStringMetadata(stage.params),
      ...(typeof stage.params.as === "string" && stage.params.as.trim() ? { outputName: stage.params.as.trim() } : {}),
      ...(stage.params.outputSchema ? { structured: true } : {}),
    })),
  })) });
  const firstItems = lanes.map((lane) => {
    const first = lane.stages[0];
    return { key: first.generatedKey, ...first.params };
  });
  // Share the runs.all batch launcher while allowing each lane to advance independently.
  const firstBatch = launchRunsAll(firstItems, lanes.map((lane) => lane.key));
  const firstResults = firstBatch.launched.map(({ promise }) => promise.then(decorateWorkflowChildResult));
  let trackedAggregate;
  const observe = (observations) => trackRunObservation(observations, trackedAggregate);
  const laneAggregate = Promise.all(lanes.map((lane, index) => firstResults[index].then(
    (result) => runLane(lane, result, observe),
    (error) => runLane(lane, laneFailure(lane.stages[0].generatedKey, error), observe),
  )));
  trackedAggregate = trackRunObservation(firstBatch.launched.map(({ key, callId }) => ({ key, operation: "run", callId })), laneAggregate);
  return trackedAggregate;
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

function validateLaneMetadata(value, label, workflowKey) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be a plain JSON object.");
  const fields = Object.keys(value);
  const allowed = ["version", "key", "mode", "sourceRef", "claims", "outputPaths"];
  const unknown = fields.filter((field) => !allowed.includes(field));
  if (unknown.length > 0) throw new Error(label + " has unsupported fields: " + unknown.join(", ") + ".");
  if (value.version !== 1) throw new Error(label + ".version must be 1.");
  if (typeof value.key !== "string" || !value.key.trim() || !runKeyPattern.test(value.key.trim())) throw new Error(label + ".key is invalid.");
  if (workflowKey !== undefined && value.key.trim() !== workflowKey) throw new Error(label + ".key must match workflow key '" + workflowKey + "'.");
  if (value.mode !== undefined && !["mutation", "review", "scout", "gate"].includes(value.mode)) throw new Error(label + ".mode is invalid.");
  const bounded = (entry, maxBytes) => typeof entry === "string" && entry.trim() && new TextEncoder().encode(entry.trim()).byteLength <= maxBytes && !/[\r\n\u0000]/.test(entry);
  if (value.sourceRef !== undefined && !bounded(value.sourceRef, 128)) throw new Error(label + ".sourceRef is invalid.");
  for (const [name, maxItems, maxLength] of [["claims", 20, 160], ["outputPaths", 10, 256]]) {
    if (value[name] === undefined) continue;
    if (!Array.isArray(value[name]) || value[name].length > maxItems || value[name].some((entry) => !bounded(entry, maxLength))) throw new Error(label + "." + name + " is invalid.");
  }
}

// Mirrors parseGateInput in src/runs/shared/acceptance.ts; the sandbox cannot import it.
function describeGateShapeError(gate) {
  const shape = "gate must be a non-empty command string or { command, output?: \"json\", schema?, timeoutMs? }.";
  if (typeof gate === "string") return gate.trim() ? undefined : shape;
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) return shape;
  for (const key of Object.keys(gate)) {
    if (!["command", "output", "schema", "timeoutMs"].includes(key)) return "gate." + key + " is not supported.";
  }
  if (typeof gate.command !== "string" || !gate.command.trim()) return shape;
  if (gate.output !== undefined && gate.output !== "json") return "gate.output must be \"json\" when present.";
  if (gate.schema !== undefined) {
    if (gate.output !== "json") return "gate.schema requires gate.output: \"json\".";
    if (!gate.schema || typeof gate.schema !== "object" || Array.isArray(gate.schema)) return "gate.schema must be a JSON Schema object.";
  }
  if (gate.timeoutMs !== undefined && (!Number.isInteger(gate.timeoutMs) || gate.timeoutMs < 1)) return "gate.timeoutMs must be an integer >= 1.";
  return undefined;
}

function describeGateAcceptanceConflict(gate, acceptance) {
  const render = (value) => {
    let encoded;
    try {
      encoded = JSON.stringify(value) ?? String(value);
    } catch {
      encoded = String(value);
    }
    return encoded.length > 120 ? encoded.slice(0, 120) + "..." : encoded;
  };
  return " Both fields were present: gate=" + render(gate) + " acceptance=" + render(acceptance) + ".";
}

function validateRunCall(key, params, label, fingerprints) {
  if (typeof key !== "string" || !runKeyPattern.test(key)) throw new Error(label + " has an invalid key.");
  if (hostKeys.has(key)) throw new Error("Workflow key '" + key + "' is already used by runs.host.");
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error(label + " requires a params object.");
  if (Object.prototype.hasOwnProperty.call(params, "action") || Object.prototype.hasOwnProperty.call(params, "workflowScript") || Object.prototype.hasOwnProperty.call(params, "globalConcurrencyLimit") || Object.prototype.hasOwnProperty.call(params, "maxSubagentSpawnsPerRun") || Object.prototype.hasOwnProperty.call(params, "tasks") || Object.prototype.hasOwnProperty.call(params, "chain") || Object.prototype.hasOwnProperty.call(params, "parallel") || Object.prototype.hasOwnProperty.call(params, "concurrency") || Object.prototype.hasOwnProperty.call(params, "chainDir")) {
    const hint = label === "runs.run" ? "; use runs.all(...) and JavaScript control flow for orchestration." : ".";
    throw new Error(label + " accepts one child via { agent, task } and execution controls only" + hint);
  }
  if (Object.prototype.hasOwnProperty.call(params, "clarify")) throw new Error(label + " does not support clarify UI.");
  if (params.worktree !== undefined && typeof params.worktree !== "boolean") throw new Error(label + " worktree must be true or false.");
  if (params.baseRef !== undefined && (typeof params.baseRef !== "string" || !validGitRef(params.baseRef))) throw new Error(label + " baseRef must be a valid Git ref: use HEAD or a supported named ref (for example, refs/heads/main). Full 40/64-character commit IDs and revision expressions are unsupported.");
  validateLaneMetadata(params.lane, label + " lane", key);
  if (params.gate !== undefined) {
    const gateError = describeGateShapeError(params.gate);
    if (gateError) throw new Error(label + " " + gateError);
  }
  if (params.gate !== undefined && params.acceptance !== undefined && params.acceptance !== false) throw new Error(label + " gate cannot be combined with acceptance; use one gate command or acceptance.verify." + describeGateAcceptanceConflict(params.gate, params.acceptance));
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
  const fingerprint = stableRunJson(canonicalRunParams(params));
  const existing = fingerprints.get(key);
  if (existing !== undefined && existing !== fingerprint) throw new Error("Duplicate workflow key '" + key + "' used with incompatible launch params.");
  fingerprints.set(key, fingerprint);
}

const hostKeys = new Set();

function validateHostCommand(key, params) {
  validateLaneKey(key, "runs.host");
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("runs.host('" + key + "') params must be an object.");
  const allowed = new Set(["kind", "command", "timeoutMs", "output", "role", "provider"]);
  const unknown = Object.keys(params).filter((field) => !allowed.has(field));
  if (unknown.length) {
    const cwdHint = unknown.includes("cwd")
      ? " The host step does not accept per-step cwd; commands and relative output paths use the workflow cwd. Set cwd on the outer subagent request, or put a trusted directory change in command (for example, 'cd /path/to/worktree && npm test')."
      : "";
    throw new Error("runs.host('" + key + "') params have unsupported fields: " + unknown.join(", ") + "." + cwdHint);
  }
  if (params.kind !== "command") throw new Error("runs.host('" + key + "') kind must be 'command'.");
  if (typeof params.command !== "string" || !params.command.trim() || params.command.includes("\u0000") || new TextEncoder().encode(params.command.trim()).byteLength > 16384) throw new Error("runs.host('" + key + "') command must be a non-empty string of at most 16384 bytes without NUL.");
  if (!Number.isInteger(params.timeoutMs) || params.timeoutMs < 1 || params.timeoutMs > 86400000) throw new Error("runs.host('" + key + "') timeoutMs must be an integer from 1 to 86400000.");
  if (params.output !== undefined && (typeof params.output !== "string" || !params.output.trim() || /^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(params.output) || /[\u0000-\u001f\u007f]/.test(params.output) || new TextEncoder().encode(params.output.trim()).byteLength > 240)) throw new Error("runs.host('" + key + "') output must be a bounded relative path without traversal or control characters.");
  if (params.role !== undefined && params.role !== "ci" && params.role !== "gate") throw new Error("runs.host('" + key + "') role must be 'ci' or 'gate'.");
  if (params.provider !== undefined && (typeof params.provider !== "string" || !params.provider.trim() || /[\r\n\u0000]/.test(params.provider) || new TextEncoder().encode(params.provider.trim()).byteLength > 64)) throw new Error("runs.host('" + key + "') provider must be a non-empty single-line string of at most 64 bytes.");
  assertJsonValue(params, "runs.host('" + key + "') params");
  if (hostKeys.has(key) || runFingerprints.has(key)) throw new Error("Workflow key '" + key + "' is already in use.");
  if (hostKeys.size >= 32) throw new Error("workflowScript supports at most 32 runs.host calls.");
  hostKeys.add(key);
}

const RUNS_ALL_PERMISSIVE_WARNING = "runs.all received runs.run(...) launch promise(s) or thenable(s). Those children were already launched individually, so runs.all cannot apply batch fingerprint validation, batch grouping in the fleet view, or collectFailure semantics; a failed child will throw at the runs.all boundary instead of returning as { ok: false }. To get full runs.all semantics, pass config objects: runs.all(items.map((item) => ({ key: item.key, agent: item.agent, task: item.task }))).";

function runsAllItemThenableInfo(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  if (typeof item.then !== "function") return null;
  const tracker = promiseObservationTracker(item);
  const observation = tracker && Array.isArray(tracker.observations) ? tracker.observations.find((entry) => entry && entry.operation === "run") : undefined;
  return {
    key: observation && typeof observation.key === "string" ? observation.key : ("runs.all[" + index + "]"),
    callId: observation && typeof observation.callId === "number" ? observation.callId : null,
    promise: item,
  };
}

let warnedPermissiveRunsAll = false;

function launchRunsAll(items, generatedLaneKeys) {
  if (!Array.isArray(items)) throw new Error("runs.all(items) requires an array.");
  const anyThenable = items.some((item, index) => runsAllItemThenableInfo(item, index) !== null);
  if (anyThenable) return launchRunsAllPermissive(items);
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
  const launched = calls.map(({ key, params }, index) => runHostCall(key, params, true, batch, generatedLaneKeys?.[index]));
  return { calls, launched };
}

function launchRunsAllPermissive(items) {
  if (!warnedPermissiveRunsAll) {
    warnedPermissiveRunsAll = true;
    try { capturedConsole.warn(RUNS_ALL_PERMISSIVE_WARNING); } catch { /* console emission is best-effort */ }
  }
  const fingerprints = new Map(runFingerprints);
  const calls = [];
  const launched = [];
  for (let index = 0; index < items.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(items, index)) throw new Error("runs.all items must not contain sparse entries.");
    const item = items[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("runs.all item " + index + " must be an object or a runs.run(...) launch promise.");
    const thenable = runsAllItemThenableInfo(item, index);
    if (thenable) {
      calls.push({ key: thenable.key, params: {} });
      launched.push(thenable);
      continue;
    }
    const { key, ...params } = item;
    validateRunCall(key, params, "runs.all item " + index, fingerprints);
    calls.push({ key, params });
    launched.push(null);
  }
  runFingerprints = fingerprints;
  return { calls, launched: launched.map((entry, index) => entry ?? runHostCall(calls[index].key, calls[index].params, false, undefined)) };
}

const runs = Object.freeze({
  run(key, params) {
    if (key && typeof key === "object" && !Array.isArray(key)) throw new Error('runs.run expects (key, params); got an object as the first argument. Use runs.run("plan", { agent, task }) or runs.all([{ key, agent, task }]).');
    validateRunCall(key, params, "runs.run", runFingerprints);
    const launched = runHostCall(key, params, false);
    return trackRunObservation([{ key, operation: "run", callId: launched.callId }], launched.promise.then(decorateWorkflowChildResult));
  },
  all(items) {
    const { calls, launched } = launchRunsAll(items);
    return trackRunObservation(launched.map(({ key, callId }) => ({ key, operation: "run", callId })), trackPromiseCombinator(launched.map(({ promise }) => promise), (values) => Promise.all(values).then((results) => wrapRunsAllResults(results.map(decorateWorkflowChildResult), calls.map(({ key }) => key)))));
  },
  lanes(laneSpecs) {
    return runLanes(laneSpecs);
  },
  host(key, params) {
    validateHostCommand(key, params);
    return hostCall("host", { key, params }, { key, operation: "host" });
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

function postWorkflowError(error) {
  // Pre-run syntax and portability errors are tagged "validation" where the script is compiled;
  // anything reaching here was thrown while the script ran, including a runtime SyntaxError.
  const taggedKind = error && (typeof error === "object" || typeof error === "function") ? workflowErrorKinds.get(error) : undefined;
  parentPort.postMessage({ type: "error", error: isSyntaxError(error) ? formatWorkflowScriptSyntaxError(error) : formatWorkflowScriptError(error), errorKind: taggedKind ?? "script" });
}

process.on("unhandledRejection", postWorkflowError);

const NESTED_ASYNC_WORKFLOW_ERROR = "workflowScript validation failed before child launch; no children launched. workflowScript does not support nested async functions. Use top-level await, plain helper functions that return runs.run(...), or explicit Promise chains so workflows stay portable across Node and Bun. Parallel plus sequential rewrite: const a = runs.run(\"a\", { agent: \"worker\", task: \"A\" }); const writer = await runs.run(\"writer\", { agent: \"worker\", task: \"Write\" }); const review = await runs.run(\"review\", { agent: \"reviewer\", task: writer.output }); const [aResult] = await Promise.all([a]); return { a: aResult.output, issue: { writerRunId: writer.runId, reviewRunId: review.runId } };";
const AST_SCALAR_KEYS = new Set(["type", "start", "end"]);

function assertPortableWorkflowScript(source) {
  const wrapped = "(async () => {\n" + source + "\n})()";
  let ast;
  try {
    ast = parse(wrapped, { ecmaVersion: "latest", sourceType: "script" });
  } catch (error) {
    // The wrapper adds one line before the script; report the script's own line.
    if (isSyntaxError(error) && typeof error.message === "string") {
      const message = error.message.replace(/\((\d+):(\d+)\)$/, (_match, line, column) => "(" + Math.max(1, Number(line) - 1) + ":" + column + ")");
      if (typeof error.stack === "string") error.stack = error.stack.replace(error.message, message);
      error.message = message;
    }
    throw error;
  }
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

function deepFreezeWorkflowArgs(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreezeWorkflowArgs(entry);
  return Object.freeze(value);
}

parentPort.on("message", async (message) => {
  if (message.type === "response") {
    const entry = pending.get(message.callId);
    if (!entry) return;
    pending.delete(message.callId);
    if (message.ok) entry.resolve(message.value);
    else {
      const error = new Error(message.error);
      if (message.errorKind === "child" || message.errorKind === "detached-child") workflowErrorKinds.set(error, message.errorKind);
      entry.reject(error);
    }
    return;
  }
  if (message.type !== "start") return;
  try {
    const sandbox = { runs, Promise: workflowPromise, emit(value) { const unwrapped = unwrapRunsAllResults(value); const emittedValue = unwrapped === undefined ? null : omitUndefinedWorkflowValues(unwrapped); assertJsonValue(emittedValue); parentPort.postMessage({ type: "emit", value: emittedValue }); }, console: capturedConsole };
    if (message.stateEnabled) sandbox.state = state;
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    contextObjectPrototype = vm.runInContext("Object.prototype", context);
    // Rebuild args inside the VM realm: a worker-realm object would expose the worker's unrestricted
    // Function through args.constructor.constructor, bypassing codeGeneration.strings: false.
    sandbox.args = deepFreezeWorkflowArgs(vm.runInContext("JSON.parse", context)(JSON.stringify(message.args ?? {})));
    let compiled;
    try {
      assertPortableWorkflowScript(message.script);
      compiled = new vm.Script("(async () => {\n" + message.script + "\n})()", { filename: "workflow-script.js", lineOffset: -1 });
    } catch (error) {
      parentPort.postMessage({ type: "error", errorKind: "validation", error: isSyntaxError(error) ? formatWorkflowScriptSyntaxError(error) : formatWorkflowScriptError(error) });
      return;
    }
    const nativePromisePrototype = vm.runInContext("(async () => {})().constructor.prototype", context);
    const nativeThenDescriptor = Object.getOwnPropertyDescriptor(nativePromisePrototype, "then");
    if (!nativeThenDescriptor || typeof nativeThenDescriptor.value !== "function") throw new Error("workflowScript could not inspect the VM Promise.prototype.then method.");
    const nativeThen = nativeThenDescriptor.value;
    let stopWorkflowPromiseHook;
    let value;
    try {
      // Some hosts freeze built-ins in every realm, which makes then read-only. The promise hooks
      // below still track observation, so skip the wrapper rather than fail every workflow.
      if (nativeThenDescriptor.configurable) Object.defineProperty(nativePromisePrototype, "then", {
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
          if (nativeThenDescriptor.configurable) Object.defineProperty(nativePromisePrototype, "then", nativeThenDescriptor);
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
      parentPort.postMessage({ type: "error", errorKind: "return-serialization", errorPhase: "return-serialization", error: formatWorkflowScriptError(error) });
      return;
    }
    parentPort.postMessage({ type: "complete", value: persistedValue });
  } catch (error) {
    postWorkflowError(error);
  }
});
