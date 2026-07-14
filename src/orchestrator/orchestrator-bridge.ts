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
	args?: string[];
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

// ── Helpers (exported for testing) ─────────────────────────────────────

export function loadStepResults(dir: string): OrchestratorRunAgentResult[] {
	const resultsDir = path.join(dir, "step-results");
	const results: OrchestratorRunAgentResult[] = [];
	try {
		if (!fs.existsSync(resultsDir)) return results;
		const files = fs.readdirSync(resultsDir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => parseInt(f.replace(".json", ""), 10))
			.filter((n) => !isNaN(n))
			.sort((a, b) => a - b);
		for (const idx of files) {
			try {
				const raw = fs.readFileSync(path.join(resultsDir, `${idx}.json`), "utf-8");
				results.push(JSON.parse(raw) as OrchestratorRunAgentResult);
			} catch {
				// best-effort per file
			}
		}
	} catch {
		// best-effort
	}
	return results;
}

export function generateFlowSummary(
	scriptPath: string,
	runId: string,
	rs: OrchestratorRunAgentResult[],
	dir: string,
	status: "success" | "failed",
	errorMsg?: string,
): string {
	try {
		const statusIcon = status === "success" ? "✅ Success" : "❌ Failed";

		const mdLines = [
			`# Orchestrator Flow: ${path.basename(scriptPath)}`,
			"",
			`**Run ID**: ${runId}`,
			`**Status**: ${statusIcon} | **Steps**: ${rs.length}`,
		];
		if (errorMsg) {
			mdLines.push(`**Error**: ${errorMsg}`);
		}

		if (rs.length > 0) {
			const totalDuration = rs.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
			const totalTokens = rs.reduce((sum, r) => sum + ((r.usage?.input ?? 0) + (r.usage?.output ?? 0)), 0);
			const totalCost = rs.reduce((sum, r) => sum + (r.usage?.cost ?? 0), 0);
			mdLines[3] = `**Status**: ${statusIcon} | **Duration**: ${(totalDuration / 1000).toFixed(1)}s | **Steps**: ${rs.length}`;
			mdLines.push(`**Tokens**: ${totalTokens} | **Cost**: $${totalCost.toFixed(4)}`);

			mdLines.push(
				"",
				"| # | Agent | Exit | Duration | Tokens | Cost | Model |",
				"|---|-------|------|----------|--------|------|-------|",
			);

			for (const r of rs) {
				const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : "-";
				const tok = (r.usage?.input ?? 0) + (r.usage?.output ?? 0) || "-";
				const cost = r.usage?.cost != null ? `$${r.usage.cost.toFixed(4)}` : "-";
				const icon = r.exitCode === 0 ? "✅" : "❌";
				mdLines.push(`| ${rs.indexOf(r)} | ${r.agent} | ${icon} ${r.exitCode} | ${dur} | ${tok} | ${cost} | ${r.model ?? "-"} |`);
			}
		}

		mdLines.push("", `📁 **Chain dir**: ${dir}`);
		return mdLines.join("\n") + "\n";
	} catch {
		return `# Orchestrator Flow: ${path.basename(scriptPath)}\n\n**Run ID**: ${runId}\n**Status**: ❌ Failed\n\n📁 **Chain dir**: ${dir}\n`;
	}
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
		const { requestId, scriptPath, args } = request as OrchestratorRequest;

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
		let chainDir: string | undefined;

		// Rozwiąż ścieżkę
		const resolvedPath = path.isAbsolute(scriptPath)
			? scriptPath
			: path.resolve(ctx.cwd, scriptPath);

		try {

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
			chainDir = path.join(path.dirname(resolvedPath), ".pi-orch-runs", requestId);
			fs.mkdirSync(chainDir, { recursive: true });

			// Załaduj skrypt — format: export default { flow, settings? }
			const jiti = createJiti(import.meta.url, { interopDefault: true, cache: false });
			// Cache-buster zapewnia rekompilację przy każdym wywołaniu
			const importPath = `${resolvedPath}?update=${Date.now()}`;
			const mod = await jiti.import(importPath, { default: true });
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
				args: args ?? [],
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
			const flowSummaryMd = generateFlowSummary(resolvedPath, requestId, finalResults, chainDir, "success");
			try { fs.writeFileSync(path.join(chainDir, "flow-summary.md"), flowSummaryMd, "utf-8"); } catch { /* best-effort */ }

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

			// Zapisz flow.json z errorem (utwórz jeśli nie istnieje)
			let flowSummaryMd: string | undefined;
			let effectiveResults = results;
			if (chainDir) {
				const flowFp2 = path.join(chainDir, "orchestrator-flow.json");
				try {
					let flow: { runId: string; scriptPath: string; startTime: string; steps: unknown[] };
					if (fs.existsSync(flowFp2)) {
						flow = JSON.parse(fs.readFileSync(flowFp2, "utf-8"));
					} else {
						flow = { runId: requestId, scriptPath: resolvedPath, startTime: new Date().toISOString(), steps: [] };
					}
					flow.endTime = new Date().toISOString();
					flow.status = "failed";
					flow.error = message;
					fs.writeFileSync(flowFp2, JSON.stringify(flow, null, 2), "utf-8");
				} catch {
					// best-effort
				}

				// Odtwórz results z plików step-results/ jeśli bridge ich nie zdążył zapisać
				const stepResults = loadStepResults(chainDir);
				effectiveResults = results.length > 0 ? results : stepResults;

				// Generuj flowSummary nawet przy failu
				flowSummaryMd = generateFlowSummary(resolvedPath, requestId, effectiveResults, chainDir, "failed", message);
				try { fs.writeFileSync(path.join(chainDir, "flow-summary.md"), flowSummaryMd, "utf-8"); } catch { /* best-effort */ }
			}

			const response: OrchestratorResponse = {
				requestId,
				output: `Orchestrator failed:\n${message}\n\n${stack}`,
				results: effectiveResults,
				error: message,
				flowSummary: flowSummaryMd,
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
