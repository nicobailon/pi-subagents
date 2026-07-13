/**
 * orchestrator-context.ts
 *
 * Interfejs i implementacja OrchestratorContext — API które dostaje skrypt
 * uruchamiany przez /pi-orch. Pozwala programatycznie odpalać subagentów
 * i budować dynamiczne flowy z poziomu TypeScriptu.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { Details, SingleResult } from "../shared/types.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import { Compile } from "typebox/compile";
import {
	captureWorktreeDiff,
	cleanupWorktrees,
	createSingleWorktree,
	resolveRepoState,
	type WorktreeSetup,
} from "../runs/shared/worktree.ts";

// ── Structured output extension path ──────────────────────────────────

const FORCE_STRUCTURED_OUTPUT_EXTENSION_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"force-structured-output.ts",
);

const STRUCTURED_OUTPUT_ENV = "PI_ORCH_FORCE_STRUCTURED_OUTPUT";
const DEFAULT_MAX_STRUCTURED_OUTPUT_ATTEMPTS = 3;
const STRUCTURED_OUTPUT_TIMEOUT_MS = 30_000;

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

/** Błąd rzucany przez runAgent gdy agent zakończy się z exitCode !== 0 */
export class OrchestratorAgentError extends Error {
	result: OrchestratorRunAgentResult;
	constructor(message: string, result: OrchestratorRunAgentResult) {
		super(message);
		this.name = "OrchestratorAgentError";
		this.result = result;
	}
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
	/** Jeśli true, nie rzuca wyjątku przy exitCode !== 0 — zwraca wynik normalnie */
	doNotThrowOnError?: boolean;
	/**
	 * JSON Schema dla structured output — wymusza deterministyczną ekstrakcję
	 * przez osobne `pi --continue` z tool_choice: "required".
	 * Użyj z TypeBox: Type.Object({...}) — schemat jest JSON-serializowany.
	 */
	outputSchema?: Record<string, unknown>;
	/**
	 * Maksymalna liczba prób ekstrakcji structured output (domyślnie 3).
	 * Każda próba to osobne `pi --continue` z wymuszeniem tool_choice.
	 */
	maxStructuredOutputAttempts?: number;
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

/** Konfiguracja retry dla withRetry */
export interface RetryConfig {
	/** Maksymalna liczba prób (włącznie z pierwszą) */
	maxAttempts: number;
	/** Opóźnienie między próbami w ms (domyślnie 1000) */
	delayMs?: number;
	/** Strategia backoff: "fixed" (domyślnie) lub "exponential" */
	backoff?: "fixed" | "exponential";
}

/** Kontekst dostępny wewnątrz bloku withRetry */
export interface RetryContext {
	/** Numer aktualnej próby (0-indexed) */
	attempt: number;
	/** Błąd z poprzedniej próby (undefined przy pierwszej próbie) */
	lastError: OrchestratorAgentError | undefined;
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
	/** Odpal subagenta, czekaj na wynik. Domyślnie rzuca OrchestratorAgentError przy exitCode !== 0 (chyba że doNotThrowOnError: true). */
	runAgent(config: OrchestratorRunAgentConfig): Promise<OrchestratorRunAgentResult>;

	/**
	 * Wykonuje blok z automatycznym retry.
	 * Jeśli callback rzuci OrchestratorAgentError, blok jest ponawiany
	 * do maxAttempts razy z konfigurowalnym delay/backoff.
	 * Po wyczerpaniu prób rzuca ostatni błąd.
	 */
	withRetry<T>(config: RetryConfig, fn: (ctx: RetryContext) => Promise<T>): Promise<T>;

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

// ── Structured output extraction ──────────────────────────────────────

interface StructuredToolCall {
	toolName: string;
	params: unknown;
}

function parseStructuredOutputFromStdout(stdout: string): StructuredToolCall | null {
	// Pi --mode json wypisuje zdarzenia jako linie JSON. Szukamy tool_use dla structured_output.
	const lines = stdout.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const event = JSON.parse(trimmed);
			if (event?.type === "tool_use" && event?.tool === "structured_output") {
				return { toolName: "structured_output", params: event.input };
			}
		} catch {
			// Non-JSON lines are expected (progress, etc.)
		}
	}
	return null;
}

function validateStructuredOutput(
	schema: Record<string, unknown>,
	value: unknown,
): { valid: true; value: unknown } | { valid: false; error: string } {
	try {
		const validator = (Compile as (schema: unknown) => { Check(value: unknown): boolean; Errors(value: unknown): Iterable<{ instancePath?: string; message?: string }> })(schema);
		if (validator.Check(value)) return { valid: true, value };
		const errors = [...validator.Errors(value)]
			.slice(0, 8)
			.map((e) => `${e.instancePath || "root"}: ${e.message}`);
		return { valid: false, error: errors.join("; ") || "schema validation failed" };
	} catch (err) {
		return { valid: false, error: `Schema compile error: ${err instanceof Error ? err.message : String(err)}` };
	}
}

async function extractForcedStructuredOutput(
	sessionFile: string,
	schema: Record<string, unknown>,
	maxAttempts: number,
	log: (message: string) => void,
): Promise<unknown> {
	const schemaJson = JSON.stringify(schema);

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const attemptLabel = maxAttempts > 1 ? ` [attempt ${attempt + 1}/${maxAttempts}]` : "";
		log(`[structured-output] Extracting${attemptLabel}...`);

		try {
			const env = {
				...process.env,
				[STRUCTURED_OUTPUT_ENV]: schemaJson,
			};

			const stdout = execSync(
				`pi --continue --session "${sessionFile}" --extension "${FORCE_STRUCTURED_OUTPUT_EXTENSION_PATH}" --no-extensions --mode json -p "Extract the required structured data from this conversation according to the specified format."`,
				{
					env,
					timeout: STRUCTURED_OUTPUT_TIMEOUT_MS,
					maxBuffer: 10 * 1024 * 1024,
					encoding: "utf-8",
				},
			);

			const toolCall = parseStructuredOutputFromStdout(stdout);
			if (!toolCall) {
				log(`[structured-output] No structured_output tool call found in output${attemptLabel}`);
				if (attempt < maxAttempts - 1) {
					await new Promise((r) => setTimeout(r, 1000));
					continue;
				}
				return undefined;
			}

			const validation = validateStructuredOutput(schema, toolCall.params);
			if (!validation.valid) {
				log(`[structured-output] Validation failed${attemptLabel}: ${validation.error}`);
				if (attempt < maxAttempts - 1) {
					await new Promise((r) => setTimeout(r, 1000));
					continue;
				}
				return undefined;
			}

			log(`[structured-output] Extracted successfully${attemptLabel}`);
			return validation.value;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log(`[structured-output] Extraction failed${attemptLabel}: ${message.slice(0, 200)}`);
			if (attempt < maxAttempts - 1) {
				await new Promise((r) => setTimeout(r, 1000));
				continue;
			}
			return undefined;
		}
	}

	return undefined;
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
		const { label, as: _as, reads, doNotThrowOnError, outputSchema, maxStructuredOutputAttempts, ...agentParams } = config;

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
		let structuredOutput = singleResult?.structuredOutput;

		// ── Orchestrator-level forced structured output extraction ──
		if (outputSchema && exitCode === 0) {
			const sessionFile = singleResult?.sessionFile;
			if (sessionFile && fs.existsSync(sessionFile)) {
				const attempts = maxStructuredOutputAttempts ?? DEFAULT_MAX_STRUCTURED_OUTPUT_ATTEMPTS;
				log(`[step ${currentIndex}] Extracting structured output (max ${attempts} attempts)...`);
				const forced = await extractForcedStructuredOutput(
					sessionFile,
					outputSchema,
					attempts,
					log,
				);
				if (forced !== undefined) {
					structuredOutput = forced;
					log(`[step ${currentIndex}] Structured output extracted: ${JSON.stringify(forced).slice(0, 300)}`);
				} else {
					log(`[step ${currentIndex}] Structured output extraction failed after ${attempts} attempts`);
				}
			} else {
				log(`[step ${currentIndex}] Cannot extract structured output: no session file available`);
			}
		}

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

		const orchResult: OrchestratorRunAgentResult = {
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

		if (exitCode !== 0 && !doNotThrowOnError) {
			throw new OrchestratorAgentError(
				error ? `Agent '${config.agent}' failed: ${error.slice(0, 200)}` : `Agent '${config.agent}' failed with exit code ${exitCode}`,
				orchResult,
			);
		}

		return orchResult;
	};

	const withRetry = async <T>(
		config: RetryConfig,
		fn: (ctx: RetryContext) => Promise<T>,
	): Promise<T> => {
		const maxAttempts = config.maxAttempts;
		const delayMs = config.delayMs ?? 1000;
		const backoff = config.backoff ?? "fixed";

		let lastError: OrchestratorAgentError | undefined;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				const result = await fn({ attempt, lastError });
				return result;
			} catch (err) {
				if (err instanceof OrchestratorAgentError) {
					lastError = err;
					if (attempt < maxAttempts - 1) {
						const waitMs = backoff === "exponential"
							? delayMs * Math.pow(2, attempt)
							: delayMs;
						log(`[retry] Attempt ${attempt + 1}/${maxAttempts} failed: ${err.message.slice(0, 100)}. Retrying in ${waitMs}ms...`);
						await new Promise((resolve) => setTimeout(resolve, waitMs));
					}
				} else {
					// Nie-agentowe błędy (timeout, sieć, itp.) propagujemy od razu
					throw err;
				}
			}
		}

		// Wyczerpane próby — rzuć ostatni błąd
		throw lastError!;
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
		withRetry,
		runInWorktree,
		chainDir: deps.chainDir,
		runId: deps.runId,
		cwd: deps.cwd,
		timeoutMs: deps.timeoutMs,
		log,
	};
}
