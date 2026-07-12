/**
 * orchestrator-bridge.ts
 *
 * Mostek między slash commandem /pi-orch a subagent executorem.
 * Wzorzec identyczny z slash-bridge.ts.
 *
 * Nasłuchuje ORCHESTRATOR_REQUEST_EVENT, ładuje skrypt .ts przez jiti,
 * tworzy OrchestratorContext z dostępem do executora, uruchamia skrypt,
 * wysyła wynik przez ORCHESTRATOR_RESPONSE_EVENT.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createJiti } from "jiti/static";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { persistOrchSessionSnapshot } from "./orchestrator-session.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import {
	ORCHESTRATOR_REQUEST_EVENT,
	ORCHESTRATOR_RESPONSE_EVENT,
	ORCHESTRATOR_UPDATE_EVENT,
	type Details,
} from "../shared/types.ts";
import { createOrchestratorContext, type OrchestratorContext, type OrchestratorRunAgentResult, type OrchestratorScript } from "./orchestrator-context.ts";

// ── Typy ────────────────────────────────────────────────────────────────

interface OrchestratorRequest {
	requestId: string;
	scriptPath: string;
}

interface OrchestratorResponse {
	requestId: string;
	output: string;
	results: OrchestratorRunAgentResult[];
	error?: string;
}

interface OrchestratorUpdate {
	requestId: string;
	step: number;
	agent: string;
	status: "running" | "completed" | "failed";
}

interface EventBus {
	on(event: string, handler: (data: unknown) => void): (() => void) | void;
	emit(event: string, data: unknown): void;
}

interface OrchestratorBridgeOptions {
	events: EventBus;
	getContext: () => ExtensionContext | null;
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
}

// ── Bridge ──────────────────────────────────────────────────────────────

export function registerOrchestratorBridge(options: OrchestratorBridgeOptions): {
	dispose: () => void;
} {
	const subscriptions: Array<() => void> = [];

	const subscribe = (event: string, handler: (data: unknown) => void): void => {
		const unsubscribe = options.events.on(event, handler);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	};

	subscribe(ORCHESTRATOR_REQUEST_EVENT, async (data) => {
		if (!data || typeof data !== "object") return;
		const request = data as Partial<OrchestratorRequest>;
		if (typeof request.requestId !== "string" || typeof request.scriptPath !== "string") return;
		const { requestId, scriptPath } = request as OrchestratorRequest;

		const ctx = options.getContext();
		if (!ctx) {
			const response: OrchestratorResponse = {
				requestId,
				output: "No active extension context for orchestrator execution.",
				results: [],
				error: "No active extension context.",
			};
			options.events.emit(ORCHESTRATOR_RESPONSE_EVENT, response);
			return;
		}

		// Persist session snapshot so agents can fork the parent session
		persistOrchSessionSnapshot(ctx);

		const results: OrchestratorRunAgentResult[] = [];

		try {
			// Rozwiąż ścieżkę
			const resolvedPath = path.isAbsolute(scriptPath)
				? scriptPath
				: path.resolve(ctx.cwd, scriptPath);

			if (!fs.existsSync(resolvedPath)) {
				const response: OrchestratorResponse = {
					requestId,
					output: `Script not found: ${resolvedPath}`,
					results: [],
					error: `Script not found: ${resolvedPath}`,
				};
				options.events.emit(ORCHESTRATOR_RESPONSE_EVENT, response);
				return;
			}

			// Stwórz chainDir
			const chainDir = path.join(path.dirname(resolvedPath), ".pi-orch-runs", requestId);
			fs.mkdirSync(chainDir, { recursive: true });

			// Załaduj skrypt — format: export default { flow, settings? }
			const jiti = createJiti(import.meta.url, { interopDefault: true, cache: false });
			const mod = await jiti.import(resolvedPath, { default: true });
			let script: OrchestratorScript;
			if (mod && typeof mod === "object" && typeof (mod as Record<string, unknown>).flow === "function") {
				script = mod as OrchestratorScript;
			} else {
				throw new Error(`Script ${resolvedPath} did not export a valid flow function.`);
			}

			const timeoutMs = script.settings?.timeout ?? 300_000;
			const orchestratorCtx = createOrchestratorContext({
				execute: options.execute,
				ctx,
				chainDir,
				runId: requestId,
				cwd: ctx.cwd,
				timeoutMs,
			});

			// Owiń runAgent żeby śledzić wyniki i wysyłać update'y
			const originalRunAgent = orchestratorCtx.runAgent.bind(orchestratorCtx);
			orchestratorCtx.runAgent = async (config) => {
				options.events.emit(ORCHESTRATOR_UPDATE_EVENT, {
					requestId,
					step: results.length,
					agent: config.agent,
					status: "running",
				} as OrchestratorUpdate);

				const result = await originalRunAgent(config);
				results.push(result);

				options.events.emit(ORCHESTRATOR_UPDATE_EVENT, {
					requestId,
					step: results.length - 1,
					agent: config.agent,
					status: result.exitCode === 0 ? "completed" : "failed",
				} as OrchestratorUpdate);

				return result;
			};

			orchestratorCtx.log("Script loaded, executing...");

			// Odpal flow z timeoutem
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`Orchestrator timed out after ${timeoutMs / 1000}s`)), timeoutMs),
			);
			const scriptResult = await Promise.race([
				script.flow(orchestratorCtx),
				timeoutPromise,
			]);

			const output = scriptResult.output || "Orchestrator completed.";
			const response: OrchestratorResponse = {
				requestId,
				output,
				results: scriptResult.results || results,
			};
			options.events.emit(ORCHESTRATOR_RESPONSE_EVENT, response);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : "";
			const response: OrchestratorResponse = {
				requestId,
				output: `Orchestrator failed:\n${message}\n\n${stack}`,
				results,
				error: message,
			};
			options.events.emit(ORCHESTRATOR_RESPONSE_EVENT, response);
		}
	});

	return {
		dispose: () => {
			for (const unsubscribe of subscriptions) unsubscribe();
			subscriptions.length = 0;
		},
	};
}
