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

export interface OrchestratorRunAgentConfig extends SubagentParamsLike {
	/** Nazwa agenta (zawężone do required) */
	agent: string;
	/** Zadanie (zawężone do required) */
	task: string;
	/** Opcjonalny identyfikator kroku (np. "scan", "plan") — zapisywany w flow.json */
	as?: string;
	/** Czytelna etykieta kroku (np. "Skanowanie kodu") — używana w logach i podsumowaniu */
	label?: string;
	/** Pliki do przeczytania przed wykonaniem — wstrzykiwane jako prefix [Read from: ...] */
	reads?: string[];
}

export interface OrchestratorRunAgentResult {
	exitCode: number;
	output: string;
	structuredOutput?: unknown;
	error?: string;
	agent: string;
	/** Token usage z wykonania agenta */
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	/** Czas wykonania w ms */
	durationMs?: number;
	/** Model użyty przez agenta */
	model?: string;
	/** Liczba wywołań narzędzi */
	toolCount?: number;
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
	/** Ścieżka do pliku .patch (przekazana jawnie przez użytkownika przy wywołaniu runInWorktree) */
	patchPath: string;
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
	 * @param patchPath - jawna ścieżka do pliku .patch (absolutna lub względem cwd)
	 * @param fn - callback wykonujący agentów w worktree
	 *
	 * Zwraca wynik callbacku połączony z WorktreeBlockResult.
	 * Jeśli callback rzuci wyjątek, worktree i tak jest sprzątany.
	 */
	runInWorktree<T>(
		patchPath: string,
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

		// Wyciągnij orchestrator-specific pola, reszta to SubagentParamsLike
		const { label, as: _as, reads, ...agentParams } = config;

		// Wstrzyknij prefixy [Read from: ...] / [Write to: ...] — dokładnie jak chain
		let taskWithInstructions = config.task;
		if (reads && Array.isArray(reads) && reads.length > 0) {
			const files = reads.map((r: string) =>
				path.isAbsolute(r) ? r : path.join(deps.chainDir, r),
			);
			taskWithInstructions = `[Read from: ${files.join(", ")}]\n\n${taskWithInstructions}`;
		}
		if (config.output && typeof config.output === "string") {
			const outputPath = path.isAbsolute(config.output)
				? config.output
				: path.join(deps.chainDir, config.output);
			taskWithInstructions = `[Write to: ${outputPath}]\n\n${taskWithInstructions}`;
		}

		log(`[step ${currentIndex}] Running agent '${config.agent}'${label ? ` (${label})` : ""}${config.cwd ? ` cwd=${config.cwd}` : ""}`);

		const params: SubagentParamsLike = {
			...agentParams,
			task: taskWithInstructions,
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

		// Bogaty log z metrykami
		const usage = singleResult?.usage;
		const totalTokens = usage ? usage.input + usage.output : 0;
		const cost = usage?.cost;
		const durationMs = singleResult?.progressSummary?.durationMs;
		const model = singleResult?.model;
		const toolCount = singleResult?.progressSummary?.toolCount;

		log(`[step ${currentIndex}] Done. exitCode=${exitCode}` +
			(durationMs ? ` duration=${(durationMs / 1000).toFixed(1)}s` : "") +
			(totalTokens ? ` tokens=${totalTokens}` : "") +
			(cost !== undefined && cost !== null ? ` cost=$${cost.toFixed(4)}` : "") +
			(model ? ` model=${model}` : "") +
			(toolCount ? ` tools=${toolCount}` : "") +
			(error ? ` error=${error.slice(0, 100)}` : ""));

		return {
			exitCode,
			output,
			structuredOutput,
			error,
			agent: config.agent,
			usage: usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost } : undefined,
			durationMs,
			model,
			toolCount,
		};
	};

	const runInWorktree = async <T>(
		patchPath: string,
		fn: (ctx: WorktreeOrchestratorContext) => Promise<T>,
	): Promise<T & WorktreeBlockResult> => {
		let setup: WorktreeSetup | undefined;
		const resolvedPatchPath = path.isAbsolute(patchPath) ? patchPath : path.resolve(deps.cwd, patchPath);

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
			log(`Worktree created at ${worktree.path} (agent cwd: ${worktreeCwd}, patch: ${resolvedPatchPath})`);

			// Ensure parent dir exists
			try {
				fs.mkdirSync(path.dirname(resolvedPatchPath), { recursive: true });
			} catch {
				// best-effort
			}

			const wtCtx: WorktreeOrchestratorContext = {
				runAgent: async (config: OrchestratorRunAgentConfig) => {
					return runAgent({ ...config, cwd: config.cwd ?? worktreeCwd });
				},
				worktreePath: worktreeCwd,
				patchPath: resolvedPatchPath,
				log,
			};

			const userResult = await fn(wtCtx);

			// Capture diff to the user-specified patchPath
			const diff = captureWorktreeDiff(setup, worktree, "orchestrator", resolvedPatchPath);
			const patch = (() => {
				try {
					return fs.readFileSync(resolvedPatchPath, "utf-8");
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
				patchPath: resolvedPatchPath,
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
