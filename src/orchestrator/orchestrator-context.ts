/**
 * orchestrator-context.ts
 *
 * Interfejs i implementacja OrchestratorContext — API które dostaje skrypt
 * uruchamiany przez /pi-orch. Pozwala programatycznie odpalać subagentów
 * i budować dynamiczne flowy z poziomu TypeScriptu.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { Details, SingleResult } from "../shared/types.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import {
	captureWorktreeDiff,
	cleanupWorktrees,
	createSingleWorktree,
	resolveRepoState,
	type WorktreeSetup,
} from "../runs/shared/worktree.ts";

// ── Interfejs dla skryptów użytkownika ──────────────────────────────────

/** Ustawienia flowu — skrypt może je wyeksportować jako settings */
export interface OrchestratorSettings {
	/** Timeout całego flow w ms (domyślnie 300_000 = 5 min) */
	timeout?: number;
}

/** Kształt eksportu skryptu orchestratora */
export interface OrchestratorScript {
	/** Główna funkcja flowu */
	flow: (ctx: OrchestratorContext) => Promise<{ output: string; results?: OrchestratorRunAgentResult[] }>;
	/** Opcjonalne ustawienia */
	settings?: OrchestratorSettings;
}

export interface OrchestratorRunAgentConfig {
	/** Nazwa agenta (scout, worker, reviewer, oracle...) */
	agent: string;
	/** Zadanie */
	task: string;
	/** Opcjonalna nazwa do późniejszego odwołania */
	as?: string;
	/** Override modelu */
	model?: string;
	/** Kontekst wykonania — domyślnie zgodnie z defaultContext agenta (worker/planner/oracle = fork, reszta = fresh) */
	context?: "fresh" | "fork";
	/** JSON Schema dla structured output */
	outputSchema?: Record<string, unknown>;
	/** Override working directory (używane wewnętrznie przez runInWorktree) */
	cwd?: string;
}

export interface OrchestratorRunAgentResult {
	exitCode: number;
	output: string;
	structuredOutput?: unknown;
	error?: string;
	agent: string;
}

/** Rezultat bloku worktree zwracany przez runInWorktree */
export interface WorktreeBlockResult {
	/** Diff stat (git diff --stat) */
	diffStat: string;
	/** Liczba zmienionych plików */
	filesChanged: number;
	/** Liczba dodanych linii */
	insertions: number;
	/** Liczba usuniętych linii */
	deletions: number;
	/** Ścieżka do pliku .patch */
	patchPath: string;
	/** Pełna treść patcha */
	patch: string;
}

/** Kontekst dostępny wewnątrz bloku runInWorktree */
export interface WorktreeOrchestratorContext {
	/** Odpal subagenta w worktree (cwd automatycznie ustawione na ścieżkę worktree) */
	runAgent(config: OrchestratorRunAgentConfig): Promise<OrchestratorRunAgentResult>;
	/** Ścieżka do katalogu worktree */
	worktreePath: string;
	/** Log do debugu */
	log(message: string): void;
}

export interface OrchestratorContext {
	/** Odpal subagenta, czekaj na wynik */
	runAgent(config: OrchestratorRunAgentConfig): Promise<OrchestratorRunAgentResult>;

	/**
	 * Wykonuje blok agentów wewnątrz jednego git worktree.
	 * Wszystkie wywołania runAgent() wewnątrz callbacku działają na
	 * wspólnym worktree. Po zakończeniu callbacku tworzony jest patch
	 * ze wszystkimi zmianami, a worktree jest usuwany.
	 *
	 * Zwraca wynik callbacku połączony z WorktreeBlockResult.
	 * Jeśli callback rzuci wyjątek, worktree i tak jest sprzątany.
	 */
	runInWorktree<T>(
		fn: (ctx: WorktreeOrchestratorContext) => Promise<T>,
	): Promise<T & WorktreeBlockResult>;

	/** Wspólny katalog chaina (na artifacty, contexty, progress) */
	chainDir: string;
	/** ID runu */
	runId: string;
	/** Working directory */
	cwd: string;
	/** Timeout całego flow w ms */
	timeoutMs: number;
	/** Log do debugu */
	log(message: string): void;
}

// ── Implementacja ───────────────────────────────────────────────────────

export interface OrchestratorContextDeps {
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
	ctx: ExtensionContext;
	chainDir: string;
	runId: string;
	cwd: string;
	timeoutMs: number;
}

export function createOrchestratorContext(deps: OrchestratorContextDeps): OrchestratorContext {
	const logPath = path.join(deps.chainDir, "orchestrator.log");
	let stepIndex = 0;

	const log = (message: string) => {
		const line = `[${new Date().toISOString()}] ${message}\n`;
		try {
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			fs.appendFileSync(logPath, line, "utf-8");
		} catch {
			// best-effort
		}
	};

	const runAgent = async (config: OrchestratorRunAgentConfig): Promise<OrchestratorRunAgentResult> => {
		const currentIndex = stepIndex++;
		const requestId = `${deps.runId}-step-${currentIndex}`;
		const effectiveCwd = config.cwd ?? deps.cwd;
		log(`[step ${currentIndex}] Running agent '${config.agent}'${config.cwd ? ` (cwd: ${config.cwd})` : ""}: ${config.task.slice(0, 100)}`);

		const params: SubagentParamsLike = {
			agent: config.agent,
			task: config.task,
			...(config.context ? { context: config.context } : {}),
			...(config.model ? { model: config.model } : {}),
			...(effectiveCwd !== deps.cwd ? { cwd: effectiveCwd } : {}),
		};

		const result = await deps.execute(
			requestId,
			params,
			new AbortController().signal,
			undefined,
			deps.ctx,
		);

		const details = result.details as Details | undefined;
		const singleResult: SingleResult | undefined = details?.results?.[0];
		const exitCode = singleResult?.exitCode ?? (result.isError ? 1 : 0);
		const output = singleResult
			? getSingleResultOutput(singleResult)
			: result.content.find((c) => c.type === "text")?.text ?? "";
		const error = singleResult?.error ?? (result.isError ? output : undefined);
		const structuredOutput = singleResult?.structuredOutput;

		log(`[step ${currentIndex}] Done. exitCode=${exitCode}${error ? ` error=${error.slice(0, 100)}` : ""}`);

		return {
			exitCode,
			output,
			structuredOutput,
			error,
			agent: config.agent,
		};
	};

	const runInWorktree = async <T>(
		fn: (ctx: WorktreeOrchestratorContext) => Promise<T>,
	): Promise<T & WorktreeBlockResult> => {
		let setup: WorktreeSetup | undefined;

		try {
			const repo = resolveRepoState(deps.cwd);
			const worktree = createSingleWorktree(
				repo.toplevel,
				repo.cwdRelative,
				deps.runId,
				0,
				repo.baseCommit,
				undefined,
				"orchestrator",
			);

			setup = {
				cwd: repo.toplevel,
				worktrees: [worktree],
				baseCommit: repo.baseCommit,
			};

			const worktreeCwd = worktree.agentCwd;
			log(`Worktree created at ${worktree.path} (agent cwd: ${worktreeCwd})`);

			const wtCtx: WorktreeOrchestratorContext = {
				runAgent: async (config: OrchestratorRunAgentConfig) => {
					return runAgent({ ...config, cwd: config.cwd ?? worktreeCwd });
				},
				worktreePath: worktreeCwd,
				log,
			};

			const userResult = await fn(wtCtx);

			// Capture diff
			const patchesDir = path.join(deps.chainDir, "worktree-patches");
			const patchPath = path.join(patchesDir, `orch-${deps.runId}.patch`);
			try {
				fs.mkdirSync(patchesDir, { recursive: true });
			} catch {
				// best-effort
			}

			const diff = captureWorktreeDiff(setup, worktree, "orchestrator", patchPath);
			const patch = (() => {
				try {
					return fs.readFileSync(patchPath, "utf-8");
				} catch {
					return "";
				}
			})();

			log(`Worktree diff: ${diff.filesChanged} files, +${diff.insertions} -${diff.deletions}`);

			return {
				...userResult,
				diffStat: diff.diffStat,
				filesChanged: diff.filesChanged,
				insertions: diff.insertions,
				deletions: diff.deletions,
				patchPath,
				patch,
			};
		} finally {
			if (setup) {
				try {
					cleanupWorktrees(setup);
					log("Worktree cleaned up");
				} catch (error) {
					log(`Worktree cleanup error: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	};

	return {
		runAgent,
		runInWorktree,
		chainDir: deps.chainDir,
		runId: deps.runId,
		cwd: deps.cwd,
		timeoutMs: deps.timeoutMs,
		log,
	};
}
