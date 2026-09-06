import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listBackgroundWorkProviders } from "../../api/background-work.ts";
import { ReadonlyDrainObservation } from "./readonly-drain-observation.ts";
import registerFanoutChildSubagentExtension from "../../extension/fanout-child.ts";
import registerSubagentFastModeExtension from "./fast-mode-extension.ts";
import registerSubagentPromptRuntime from "./subagent-prompt-runtime.ts";
import type { ChildRuntimeConfig } from "./child-runtime-config.ts";
import type { ChildToolDiagnostic } from "./tool-availability.ts";
import type { ChildSessionLaunch } from "./child-session.ts";
import type { ChildTranscriptWriter } from "../../shared/child-transcript.ts";
import { projectRuntimeAcknowledgedExtensions } from "./runtime-acknowledged-extensions.ts";

/** Inline extension shape accepted by pi's resource loader (`extensionFactories`). */
export interface ChildHookExtension {
	name: string;
	factory: (pi: ExtensionAPI) => void;
}

type OwnedCapture = Required<Pick<ChildRuntimeConfig, "toolDiagnostic" | "runtimeAcknowledgements">>;
type PromptProof = { config: ChildRuntimeConfig; snapshot: string; factories?: ChildHookExtension["factory"][]; observeNext?: ReadonlyDrainObservation; observation?: ReadonlyDrainObservation; capture?: OwnedCapture; reporting?: { launch: ChildSessionLaunch; callback: ChildSessionLaunch["onExtensionError"] } };
const promptProofs = new WeakMap<ChildHookExtension["factory"], PromptProof>();

function ownedProof(hooks: ChildHookExtension[]): PromptProof | undefined {
	const proof = hooks[0] && promptProofs.get(hooks[0].factory);
	return proof?.factories?.length === hooks.length && proof.factories.every((factory, index) => hooks[index]?.factory === factory) ? proof : undefined;
}

/** The host's mandatory transcript reporting, owned by the existing hook certificate. */
export function withChildSessionErrorReporting(session: Omit<ChildSessionLaunch, "onExtensionError">, transcriptWriter: ChildTranscriptWriter | undefined): ChildSessionLaunch {
	const launch: ChildSessionLaunch = { ...session, onExtensionError: (error) => {
		transcriptWriter?.writeStderrLine(`Extension error (${error.extensionPath}, ${error.event}): ${error.error instanceof Error ? error.error.message : String(error.error)}`);
	} };
	const proof = ownedProof(launch.hooks);
	if (proof?.capture && proof.config === launch.runtime) proof.reporting = { launch, callback: launch.onExtensionError };
	return launch;
}

export function isReadonlyChildSessionReporting(launch: ChildSessionLaunch): boolean {
	const proof = ownedProof(launch.hooks);
	const descriptor = Object.getOwnPropertyDescriptor(launch, "onExtensionError");
	if (descriptor && (!descriptor.enumerable || !("value" in descriptor))) return false;
	return proof?.reporting ? proof.reporting.launch === launch && proof.reporting.callback === descriptor?.value : !descriptor && !("onExtensionError" in launch);
}

/** Admit only own enumerable data: inspecting descriptors must not invoke getters. */
function dataKeys(value: unknown): string[] | undefined {
	if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
	const keys = Reflect.ownKeys(value);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
		if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) return undefined;
	}
	return keys as string[];
}

/** Only reviewed data and the capture callbacks constructed below; no caller callback opt-in. */
function readonlyConfig(config: ChildRuntimeConfig, capture?: OwnedCapture): string | undefined {
	const strings = ["runId", "agent", "sessionName", "forkCacheKey", "parentSessionId", "orchestratorSessionId"];
	const numbers = ["childIndex", "depth", "maxDepth"];
	const booleans = ["inheritProjectContext", "inheritGlobalContext", "inheritSkills"];
	const keys = dataKeys(config);
	if (!keys) return undefined;
	if (capture && (config.toolDiagnostic !== capture.toolDiagnostic || config.runtimeAcknowledgements !== capture.runtimeAcknowledgements)) return undefined;
	const waitKeys = dataKeys(config.waitTool);
	if (!waitKeys || waitKeys.some((key) => key !== "enabled")) return undefined;
	if (config.fast !== false || config.fanoutChild !== false || config.waitTool.enabled !== false) return undefined;
	for (const key of keys) {
		const value = Object.getOwnPropertyDescriptor(config, key)!.value;
		if (["fast", "fanoutChild", "waitTool"].includes(key)) continue;
		if (capture && (key === "toolDiagnostic" || key === "runtimeAcknowledgements")) continue;
		if (capture && key === "requiredTools" && Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) {
			const descriptors = Object.getOwnPropertyDescriptors(value);
			if (Reflect.ownKeys(descriptors).length !== value.length + 1) return undefined;
			for (let i = 0; i < value.length; i++) {
				const descriptor = descriptors[String(i)];
				if (!descriptor?.enumerable || !("value" in descriptor) || !["read", "ls"].includes(descriptor.value)) return undefined;
			}
			continue;
		}
		if (strings.includes(key) && (value === undefined || typeof value === "string")) continue;
		if (numbers.includes(key) && (value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 0))) continue;
		if (booleans.includes(key) && (value === undefined || typeof value === "boolean")) continue;
		return undefined;
	}
	return JSON.stringify(config);
}

function noBackgroundProviders(): boolean {
	try {
		return listBackgroundWorkProviders().length === 0;
	} catch { return false; }
}

/** Internal proof of the captured closure/config, not its caller-controlled display name. */
export function isReadonlyChildHookProfile(hooks: ChildHookExtension[], config: ChildRuntimeConfig): boolean {
	const proof = ownedProof(hooks);
	if (!proof) return false;
	const valid = proof.config === config && readonlyConfig(config, proof.capture) === proof.snapshot && noBackgroundProviders();
	if (!valid) proof.observation?.deny();
	return valid && (proof.observation?.check() ?? true);
}

/** Arm just the next installation; ordinary installations retain the original API/handlers. */
export function observeReadonlyChildHookDrain(hooks: ChildHookExtension[], enabled: boolean, sessionFile: string): void {
	const proof = ownedProof(hooks);
	if (!proof) return;
	if (enabled) {
		proof.observation?.deny();
		proof.observation = undefined;
	}
	proof.observeNext = enabled ? new ReadonlyDrainObservation(sessionFile, () => readonlyConfig(proof.config, proof.capture) === proof.snapshot && noBackgroundProviders()) : undefined;
}

export function captureReadonlyChildDrain(hooks: ChildHookExtension[]): (() => boolean) {
	const proof = ownedProof(hooks);
	const observation = proof?.observation;
	return () => !!observation && proof?.observation === observation && observation.settled();
}

/**
 * The child-side hooks pi-subagents installs in every child, keyed off the
 * launch config. The registrations live in `subagent-prompt-runtime.ts`,
 * `fast-mode-extension.ts`, and `fanout-child.ts`.
 */
export function createChildHooks(config: ChildRuntimeConfig): ChildHookExtension[] {
	return childHooks(config);
}

/** Launch-owned bookkeeping, paired with the same private hook certificate (no callback registration API). */
export function createCapturedChildHooks(config: ChildRuntimeConfig, runner = false) {
	let diagnostic: ChildToolDiagnostic | undefined;
	let acknowledgedIds: string[] | undefined;
	let completionIntentContext: Pick<ExtensionContext, "model" | "modelRegistry"> | undefined;
	const capture: OwnedCapture = {
		toolDiagnostic: (value) => { diagnostic = value; },
		runtimeAcknowledgements: (ids) => { acknowledgedIds = ids; },
	};
	Object.assign(config, capture);
	const hooks = childHooks(config, capture);
	if (runner) {
		hooks.push({ name: "pi-subagents:completion-intent", factory: (pi) => pi.on("session_start", (_event, childCtx) => {
			// Retain only attempt model services, not the live child session.
			completionIntentContext = { model: childCtx.model, modelRegistry: childCtx.modelRegistry };
		}) });
		const proof = promptProofs.get(hooks[0]!.factory);
		if (proof) proof.factories = hooks.map((hook) => hook.factory);
	}
	return {
		hooks,
		completionIntentContext: () => completionIntentContext,
		toolDiagnostic: () => diagnostic,
		runtimeAcknowledgedExtensions: () => acknowledgedIds ? projectRuntimeAcknowledgedExtensions(acknowledgedIds) : undefined,
	};
}

function childHooks(config: ChildRuntimeConfig, capture?: OwnedCapture): ChildHookExtension[] {
	const snapshot = readonlyConfig(config, capture);
	const proof: PromptProof | undefined = snapshot === undefined ? undefined : { config, snapshot, capture };
	const hooks: ChildHookExtension[] = [
		{ name: "pi-subagents:prompt-runtime", factory: function promptRuntime(pi) {
			if (!proof?.observeNext) return registerSubagentPromptRuntime(pi, config);
			proof.observation = proof.observeNext;
			proof.observeNext = undefined;
			registerSubagentPromptRuntime(pi, config, proof.observation);
		} },
	];
	if (proof) {
		proof.factories = hooks.map((hook) => hook.factory);
		promptProofs.set(hooks[0]!.factory, proof);
	}
	if (config.fast) hooks.push({ name: "pi-subagents:fast-mode", factory: (pi) => registerSubagentFastModeExtension(pi) });
	if (config.fanoutChild) hooks.push({ name: "pi-subagents:fanout-child", factory: (pi) => registerFanoutChildSubagentExtension(pi, config) });
	return hooks;
}
