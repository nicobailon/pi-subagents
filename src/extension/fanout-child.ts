import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../agents/agents.ts";
import { getArtifactsDir } from "../shared/artifacts.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { resolveWaitToolConfig } from "../runs/background/wait-config.ts";
import type { ChildRuntimeConfig } from "../runs/shared/child-runtime-config.ts";
import { readNestedControlRequests, resolveInheritedNestedRoute, type NestedRoute, writeNestedControlResult } from "../runs/shared/nested-events.ts";
import { deliverSubagentIntercomMessageEvent } from "../intercom/result-intercom.ts";
import { createNativeSupervisorChannel, NATIVE_SUPERVISOR_TOOL_NAME, resolveSupervisorChannelDir } from "../intercom/native-supervisor-channel.ts";
import { readStatus } from "../shared/utils.ts";
import { resolveSubagentIntercomTarget } from "../intercom/intercom-bridge.ts";
import { createSubagentParamsSchema } from "./schemas.ts";
import { finalizeToolResult } from "./tool-result.ts";
import { loadConfig, resolveAsyncByDefault } from "./config.ts";
import { SUBAGENT_ASYNC_STARTED_EVENT, type AsyncStartedEvent, type Details, type SubagentState } from "../shared/types.ts";

function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}

function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function createChildSafeState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		subagentInProgress: false,
		subagentSpawns: { sessionId: null, count: 0 },
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

function resolveNestedControlRoute(config: ChildRuntimeConfig): NestedRoute | undefined {
	return config.nestedRoute ? resolveInheritedNestedRoute(config.nestedRoute) : undefined;
}

function nestedControlRouteKey(route: NestedRoute): string {
	return route.controlInbox;
}

interface NestedControlInboxState {
	seen: Set<string>;
	inFlight: Set<string>;
	pendingResults: Map<string, Parameters<typeof writeNestedControlResult>[1]>;
}

interface NestedControlListenerEntry {
	cleanup: () => void;
	state: NestedControlInboxState;
}

function createNestedControlInboxState(): NestedControlInboxState {
	return { seen: new Set(), inFlight: new Set(), pendingResults: new Map() };
}

function startNestedControlInboxListener(pi: ExtensionAPI, state: SubagentState, route: NestedRoute, inboxState: NestedControlInboxState): () => void {
	const timer = setInterval(() => {
		try {
			for (const request of readNestedControlRequests(route)) {
				if (inboxState.seen.has(request.requestId) || inboxState.inFlight.has(request.requestId)) continue;
				inboxState.inFlight.add(request.requestId);
				void (async () => {
					try {
						let result = inboxState.pendingResults.get(request.requestId);
						if (!result) {
							let ok = false;
							let message = "Control request failed.";
							try {
								const control = state.foregroundControls.get(request.targetRunId);
								if (!control) {
									message = `Nested run ${request.targetRunId} is not active in this fanout child.`;
								} else if (request.action === "interrupt") {
									ok = control.interrupt?.() === true;
									message = ok
										? `Interrupt requested for nested run ${request.targetRunId}.`
										: `Nested run ${request.targetRunId} has no active child step to interrupt.`;
								} else if (!request.message?.trim()) {
									message = "Nested resume requires message.";
								} else if (!control.currentAgent) {
									message = `Nested run ${request.targetRunId} has no active child message route.`;
								} else {
									const index = control.currentIndex ?? 0;
									const target = resolveSubagentIntercomTarget(request.targetRunId, control.currentAgent, index);
									ok = await deliverSubagentIntercomMessageEvent(
										pi.events,
										target,
										`Follow-up for nested run ${request.targetRunId} (${control.currentAgent}):\n\n${request.message.trim()}`,
										500,
										{ source: "nested-resume", runId: request.targetRunId, agent: control.currentAgent, index },
									);
									message = ok
										? `Delivered follow-up to live nested run ${request.targetRunId}.`
										: `Nested child intercom target is not registered: ${target}`;
								}
							} catch (error) {
								message = error instanceof Error ? error.message : String(error);
							}
							result = { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok, message };
						}
						try {
							writeNestedControlResult(route, result);
						} catch (error) {
							inboxState.pendingResults.set(request.requestId, result);
							console.error(`Failed to write nested control result for request '${request.requestId}' targeting '${request.targetRunId}' via inbox '${route.controlInbox}'; keeping request for retry:`, error);
							return;
						}
						inboxState.pendingResults.delete(request.requestId);
						inboxState.seen.add(request.requestId);
						try { fs.unlinkSync(request.filePath); } catch {}
					} finally {
						inboxState.inFlight.delete(request.requestId);
					}
				})();
			}
		} catch (error) {
			console.error(`Failed to poll nested control inbox '${route.controlInbox}' for root '${route.rootRunId}':`, error);
		}
	}, 200);
	timer.unref?.();
	return () => clearInterval(timer);
}

/** Register delegation and supervisor replies for fanout-authorized children. */
export default function registerFanoutChildSubagentExtension(pi: ExtensionAPI, childConfig: ChildRuntimeConfig): void {
	if (!childConfig.fanoutChild) return;

	const globalStore = globalThis as Record<string, unknown>;
	const registeredKey = "__piSubagentFanoutChildRegisteredApis";
	const registeredApis = globalStore[registeredKey] instanceof WeakSet
		? globalStore[registeredKey] as WeakSet<ExtensionAPI>
		: new WeakSet<ExtensionAPI>();
	globalStore[registeredKey] = registeredApis;
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);

	const config = loadConfig();
	const waitToolConfig = resolveWaitToolConfig(config.waitTool);
	const state = childConfig.runtimeState ?? createChildSafeState();
	const asyncChildren = new Map<string, { dir: string; agents: string[] }>();
	const foregroundChannels = new Set<string>();
	const supervisorChannel = createNativeSupervisorChannel(pi, state, {
		getChannelDirs: () => {
			const dirs = new Set<string>();
			for (const run of state.foregroundControls.values()) {
				for (const child of run.activeChildren?.values() ?? []) dirs.add(resolveSupervisorChannelDir(run.runId, child.agent, child.index));
			}
			for (const run of state.foregroundRuns?.values() ?? []) {
				for (const child of run.children) {
					if (child.status === "detached") dirs.add(resolveSupervisorChannelDir(run.runId, child.agent, child.index));
				}
			}
			const retiringForeground = [...foregroundChannels].filter(dir => !dirs.has(dir));
			for (const dir of dirs) foregroundChannels.add(dir);
			for (const dir of retiringForeground) dirs.add(dir);
			const retiringAsync: string[] = [];
			for (const [id, child] of asyncChildren) {
				const status = readStatus(child.dir);
				if (status && status.state !== "queued" && status.state !== "running") retiringAsync.push(id);
				for (const [index, agent] of child.agents.entries()) dirs.add(resolveSupervisorChannelDir(id, agent, index));
			}
			return {
				dirs: [...dirs],
				retire: () => {
					for (const dir of retiringForeground) foregroundChannels.delete(dir);
					for (const id of retiringAsync) asyncChildren.delete(id);
				},
			};
		},
	});
	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		asyncByDefault: resolveAsyncByDefault(config),
		waitToolEnabled: waitToolConfig.enabled,
		waitToolDefaultTimeoutMs: waitToolConfig.defaultTimeoutMs,
		tempArtifactsDir: getArtifactsDir(null),
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents,
		allowMutatingManagementActions: false,
		childRuntime: childConfig,
		activateSupervisorTransport: supervisorChannel.activateTransport,
		findPendingAsks: supervisorChannel.findPendingAsks,
	});

	const params = createSubagentParamsSchema();
	const tool: ToolDefinition<typeof params, Details> = {
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate to subagents from child-safe fanout mode.",
			"Allowed management/control actions: list, get, status, lane.status, interrupt, resume, steer, doctor.",
			"Mutating management actions (create, update, delete, eject, disable, enable, reset, grant-spawn-budget, lane.recordMerge, lane.recordSupersession) are blocked in this mode.",
		].join("\n"),
		parameters: params,
		async execute(id, params, signal, onUpdate, ctx) {
			return finalizeToolResult(await executor.executePublic(id, params as SubagentParamsLike, signal ?? new AbortController().signal, onUpdate, ctx));
		},
	};

	pi.registerTool(tool);
	let unsubscribeAsyncStarted: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		supervisorChannel.registerTools();
		// The host applies the explicit allowlist to dynamic registration too.
		if (!pi.getAllTools().some(tool => tool.name === NATIVE_SUPERVISOR_TOOL_NAME)) return;
		// Downward asks belong to this coordinator, not its parent or persisted session file.
		state.supervisorOwnerSessionId = ctx.sessionManager.getSessionId() || null;
		unsubscribeAsyncStarted = pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (payload: unknown) => {
			const info = payload as AsyncStartedEvent;
			if (!info.id || !info.asyncDir || info.sessionId !== state.currentSessionId) return;
			const agents = info.agents ?? (info.agent ? [info.agent] : []);
			asyncChildren.set(info.id, { dir: info.asyncDir, agents });
			supervisorChannel.activateTransport();
		});
		supervisorChannel.start();
		supervisorChannel.activateTransport();
	});
	pi.on("session_shutdown", () => {
		unsubscribeAsyncStarted?.();
		asyncChildren.clear();
		foregroundChannels.clear();
		supervisorChannel.dispose();
		state.supervisorOwnerSessionId = null;
	});
	const route = resolveNestedControlRoute(childConfig);
	if (!route) return;
	const listenerCleanupKey = "__piSubagentFanoutChildNestedControlInboxCleanups";
	const listenerCleanups = globalStore[listenerCleanupKey] instanceof Map
		? globalStore[listenerCleanupKey] as Map<string, NestedControlListenerEntry>
		: new Map<string, NestedControlListenerEntry>();
	globalStore[listenerCleanupKey] = listenerCleanups;
	const routeKey = nestedControlRouteKey(route);
	const previous = listenerCleanups.get(routeKey);
	previous?.cleanup();
	const inboxState = previous?.state ?? createNestedControlInboxState();
	listenerCleanups.set(routeKey, { state: inboxState, cleanup: startNestedControlInboxListener(pi, state, route, inboxState) });
}
