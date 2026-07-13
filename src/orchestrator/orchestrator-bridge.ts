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
import { createOrchestratorContext, OrchestratorAgentError, type OrchestratorContext, type OrchestratorRunAgentResult, type OrchestratorScript } from "./orchestrator-context.ts";

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
	flowSummary?: string;
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

			const flowStartTime = new Date().toISOString();

			// Owiń runAgent żeby auto-logować, pisać flow.json i wysyłać update'y
			const originalRunAgent = orchestratorCtx.runAgent.bind(orchestratorCtx);
			orchestratorCtx.runAgent = async (config) => {
				const stepIndex = results.length;

				// Auto-log startu (infrastruktura, nie skrypt)
				orchestratorCtx.log(`[step ${stepIndex}] Agent '${config.agent}'${config.label ? ` (${config.label})` : ""} starting`);

				options.events.emit(ORCHESTRATOR_UPDATE_EVENT, {
					requestId,
					step: stepIndex,
					agent: config.agent,
					status: "running",
				} as OrchestratorUpdate);

				const stepStart = Date.now();
				let failedError: OrchestratorAgentError | undefined;
				let result: OrchestratorRunAgentResult;
				try {
					result = await originalRunAgent(config);
				} catch (err) {
					if (err instanceof OrchestratorAgentError) {
						result = err.result;
						failedError = err;
					} else {
						throw err;
					}
				}
				const stepDuration = Date.now() - stepStart;
				results.push(result);

				options.events.emit(ORCHESTRATOR_UPDATE_EVENT, {
					requestId,
					step: stepIndex,
					agent: config.agent,
					status: result.exitCode === 0 ? "completed" : "failed",
				} as OrchestratorUpdate);

				// Zapis flow.json — przyrostowo po każdym kroku
				const flowPath = path.join(chainDir, "orchestrator-flow.json");
				const flowEntry = {
					index: stepIndex,
					agent: config.agent,
					as: config.as,
					label: config.label,
					task: config.task.slice(0, 200),
					exitCode: result.exitCode,
					usage: result.usage,
					model: result.model,
					durationMs: result.durationMs ?? stepDuration,
					toolCount: result.toolCount,
					outputPreview: result.output.slice(0, 200),
					error: result.error,
				};
				try {
					let flow: { runId: string; scriptPath: string; startTime: string; steps: unknown[] };
					if (fs.existsSync(flowPath)) {
						flow = JSON.parse(fs.readFileSync(flowPath, "utf-8"));
					} else {
						flow = { runId: requestId, scriptPath: resolvedPath, startTime: flowStartTime, steps: [] };
					}
					flow.steps.push(flowEntry);
					fs.writeFileSync(flowPath, JSON.stringify(flow, null, 2), "utf-8");
				} catch {
					// best-effort
				}

				if (failedError) {
					throw failedError;
				}

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

			const flowEndTime = new Date().toISOString();
			const finalResults = scriptResult.results || results;

			// Finalizuj flow.json
			const flowFp = path.join(chainDir, "orchestrator-flow.json");
			try {
				if (fs.existsSync(flowFp)) {
					const flow = JSON.parse(fs.readFileSync(flowFp, "utf-8"));
					flow.endTime = flowEndTime;
					flow.status = "success";
					flow.totalDurationMs = finalResults.reduce((sum: number, r: OrchestratorRunAgentResult) => sum + (r.durationMs ?? 0), 0);
					fs.writeFileSync(flowFp, JSON.stringify(flow, null, 2), "utf-8");
				}
			} catch {
				// best-effort
			}

			// Wygeneruj flow-summary.md
			let flowSummaryMd: string | undefined;
			const summaryPath = path.join(chainDir, "flow-summary.md");
			try {
				const totalDuration = finalResults.reduce((sum: number, r: OrchestratorRunAgentResult) => sum + (r.durationMs ?? 0), 0);
				const totalTokens = finalResults.reduce((sum: number, r: OrchestratorRunAgentResult) => sum + ((r.usage?.input ?? 0) + (r.usage?.output ?? 0)), 0);
				const totalCost = finalResults.reduce((sum: number, r: OrchestratorRunAgentResult) => sum + (r.usage?.cost ?? 0), 0);

				const mdLines = [
					`# Orchestrator Flow: ${path.basename(resolvedPath)}`,
					"",
					`**Run ID**: ${requestId}`,
					`**Status**: ✅ Success | **Duration**: ${(totalDuration / 1000).toFixed(1)}s | **Steps**: ${finalResults.length}`,
					`**Tokens**: ${totalTokens} | **Cost**: $${totalCost.toFixed(4)}`,
					"",
					"| # | Agent | Exit | Duration | Tokens | Cost | Model |",
					"|---|-------|------|----------|--------|------|-------|",
				];

				for (const r of finalResults) {
					const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : "-";
					const tok = (r.usage?.input ?? 0) + (r.usage?.output ?? 0) || "-";
					const cost = r.usage?.cost != null ? `$${r.usage.cost.toFixed(4)}` : "-";
					const status = r.exitCode === 0 ? "✅" : "❌";
					mdLines.push(`| ${finalResults.indexOf(r)} | ${r.agent} | ${status} ${r.exitCode} | ${dur} | ${tok} | ${cost} | ${r.model ?? "-"} |`);
				}

				mdLines.push("", `📁 **Chain dir**: ${chainDir}`);
				flowSummaryMd = mdLines.join("\n") + "\n";
				fs.writeFileSync(summaryPath, flowSummaryMd, "utf-8");
			} catch {
				// best-effort
			}

			const output = scriptResult.output || "Orchestrator completed.";
			const response: OrchestratorResponse = {
				requestId,
				output,
				results: finalResults,
				flowSummary: flowSummaryMd,
			};
			options.events.emit(ORCHESTRATOR_RESPONSE_EVENT, response);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : "";

			// Zapisz flow.json z errorem
			const flowFp2 = path.join(chainDir, "orchestrator-flow.json");
			try {
				if (fs.existsSync(flowFp2)) {
					const flow = JSON.parse(fs.readFileSync(flowFp2, "utf-8"));
					flow.endTime = new Date().toISOString();
					flow.status = "failed";
					flow.error = message;
					fs.writeFileSync(flowFp2, JSON.stringify(flow, null, 2), "utf-8");
				}
			} catch {
				// best-effort
			}

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
