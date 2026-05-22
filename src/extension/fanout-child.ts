import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../agents/agents.ts";
import { getArtifactsDir } from "../shared/artifacts.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import { readNestedControlRequests, resolveNestedRouteFromEnv, writeNestedControlResult } from "../runs/shared/nested-events.ts";
import { deliverSubagentIntercomMessageEvent } from "../intercom/result-intercom.ts";
import { resolveSubagentIntercomTarget } from "../intercom/intercom-bridge.ts";
import { SubagentParams } from "./schemas.ts";
import { loadConfig } from "./config.ts";
import { type Details, type SubagentState } from "../shared/types.ts";

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

function createChildSafeState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
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

function startNestedControlInboxListener(pi: ExtensionAPI, state: SubagentState): NodeJS.Timeout | undefined {
	let route;
	try {
		route = resolveNestedRouteFromEnv();
	} catch {
		return undefined;
	}
	if (!route) return undefined;
	const seen = new Set<string>();
	const inFlight = new Set<string>();
	const pendingResults = new Map<string, Parameters<typeof writeNestedControlResult>[1]>();
	const timer = setInterval(() => {
		try {
			for (const request of readNestedControlRequests(route)) {
				if (seen.has(request.requestId) || inFlight.has(request.requestId)) continue;
				inFlight.add(request.requestId);
				void (async () => {
					try {
						let result = pendingResults.get(request.requestId);
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
							pendingResults.set(request.requestId, result);
							console.error(`Failed to write nested control result for request '${request.requestId}' targeting '${request.targetRunId}' via inbox '${route.controlInbox}'; keeping request for retry:`, error);
							return;
						}
						pendingResults.delete(request.requestId);
						seen.add(request.requestId);
						try { fs.unlinkSync(request.filePath); } catch {}
					} finally {
						inFlight.delete(request.requestId);
					}
				})();
			}
		} catch (error) {
			console.error(`Failed to poll nested control inbox '${route.controlInbox}' for root '${route.rootRunId}':`, error);
		}
	}, 200);
	timer.unref?.();
	return timer;
}

export default function registerFanoutChildSubagentExtension(pi: ExtensionAPI): void {
	if (process.env[SUBAGENT_CHILD_ENV] !== "1" || process.env[SUBAGENT_FANOUT_CHILD_ENV] !== "1") return;

	const globalStore = globalThis as Record<string, unknown>;
	const registeredKey = "__piSubagentFanoutChildRegisteredApis";
	const registeredApis = globalStore[registeredKey] instanceof WeakSet
		? globalStore[registeredKey] as WeakSet<ExtensionAPI>
		: new WeakSet<ExtensionAPI>();
	globalStore[registeredKey] = registeredApis;
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);

	const config = loadConfig();
	const state = createChildSafeState();
	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		asyncByDefault: config.asyncByDefault === true,
		tempArtifactsDir: getArtifactsDir(null),
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents,
		allowMutatingManagementActions: false,
	});

	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate to subagents from child-safe fanout mode.",
			"Allowed management/control actions: list, get, status, interrupt, resume, doctor.",
			"Agent config mutation actions create, update, and delete are blocked in this mode.",
		].join("\n"),
		parameters: SubagentParams,
		execute(id, params, signal, onUpdate, ctx) {
			return executor.execute(id, params as SubagentParamsLike, signal, onUpdate, ctx);
		},
	};

	pi.registerTool(tool);
	startNestedControlInboxListener(pi, state);
}
