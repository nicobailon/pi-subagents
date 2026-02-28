/**
 * Subagent Tool
 *
 * Full-featured subagent with sync and async modes.
 * - Sync (default): Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Modes: single (agent + task), parallel (tasks[]), chain (chain[] with {previous})
 * Toggle: async parameter (default: false, configurable via config.json)
 *
 * Config file: ~/.pi/agent/extensions/subagent/config.json
 *   { "asyncByDefault": true }
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type AgentConfig, type AgentScope, discoverAgents, discoverAgentsAll } from "./agents.js";
import { resolveExecutionAgentScope } from "./agent-scope.js";
import { cleanupOldChainDirs, getStepAgents, isParallelStep, resolveStepBehavior, type ChainStep, type SequentialStep } from "./settings.js";
import { ChainClarifyComponent, type ChainClarifyResult, type ModelInfo } from "./chain-clarify.js";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "./artifacts.js";
import {
	type AgentProgress,
	type ArtifactConfig,
	type ArtifactPaths,
	type AsyncJobState,
	type Details,
	type ExtensionConfig,
	type SingleResult,
	ASYNC_DIR,
	DEFAULT_ARTIFACT_CONFIG,
	DEFAULT_MAX_OUTPUT,
	MAX_CONCURRENCY,
	MAX_PARALLEL,
	POLL_INTERVAL_MS,
	RESULTS_DIR,
	WIDGET_KEY,
	checkSubagentDepth,
} from "./types.js";
import { readStatus, findByPrefix, getFinalOutput, mapConcurrent } from "./utils.js";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.js";
import { createFileCoalescer } from "./file-coalescer.js";
import { runSync } from "./execution.js";
import { renderWidget, renderSubagentResult } from "./render.js";
import { SubagentParams, StatusParams } from "./schemas.js";
import { executeChain } from "./chain-execution.js";
import { isAsyncAvailable, executeAsyncChain, executeAsyncSingle } from "./async-execution.js";
import { discoverAvailableSkills, normalizeSkillInput } from "./skills.js";
import { finalizeSingleOutput, injectSingleOutputInstruction, resolveSingleOutputPath } from "./single-output.js";
import { AgentManagerComponent, type ManagerResult } from "./agent-manager.js";
import { recordRun } from "./run-history.js";
import { handleManagementAction } from "./agent-management.js";

// ExtensionConfig is now imported from ./types.js

function loadConfig(): ExtensionConfig {
	const configPath = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json");
	try {
		if (fs.existsSync(configPath)) {
			return JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExtensionConfig;
		}
	} catch {}
	return {};
}

/**
 * Create a directory and verify it is actually accessible.
 * On Windows with Azure AD/Entra ID, directories created shortly after
 * wake-from-sleep can end up with broken NTFS ACLs (null DACL) when the
 * cloud SID cannot be resolved without network connectivity. This leaves
 * the directory completely inaccessible to the creating user.
 */
function ensureAccessibleDir(dirPath: string): void {
	fs.mkdirSync(dirPath, { recursive: true });
	try {
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	} catch {
		// Directory exists but is inaccessible — remove and recreate
		try {
			fs.rmSync(dirPath, { recursive: true, force: true });
		} catch {}
		fs.mkdirSync(dirPath, { recursive: true });
		// Verify recovery succeeded
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	}
}

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	ensureAccessibleDir(RESULTS_DIR);
	ensureAccessibleDir(ASYNC_DIR);

	// Cleanup old chain directories on startup (after 24h)
	cleanupOldChainDirs();

	const config = loadConfig();
	const asyncByDefault = config.asyncByDefault === true;
	const streamByDefault = config.streamModeByDefault !== false;

	const tempArtifactsDir = getArtifactsDir(null);
	cleanupAllArtifactDirs(DEFAULT_ARTIFACT_CONFIG.cleanupDays);
	let baseCwd = process.cwd();
	let currentSessionId: string | null = null;
	const asyncJobs = new Map<string, AsyncJobState>();
	const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>(); // Track cleanup timeouts
	let lastUiContext: ExtensionContext | null = null;
	let poller: NodeJS.Timeout | null = null;

	const ensurePoller = () => {
		if (poller) return;
		poller = setInterval(() => {
			if (!lastUiContext || !lastUiContext.hasUI) return;
			if (asyncJobs.size === 0) {
				renderWidget(lastUiContext, []);
				clearInterval(poller);
				poller = null;
				return;
			}

			for (const job of asyncJobs.values()) {
				// Skip status reads for finished jobs - they won't change
				if (job.status === "complete" || job.status === "failed") {
					continue;
				}
				const status = readStatus(job.asyncDir);
				if (status) {
					job.status = status.state;
					job.mode = status.mode;
					job.currentStep = status.currentStep ?? job.currentStep;
					job.stepsTotal = status.steps?.length ?? job.stepsTotal;
					job.startedAt = status.startedAt ?? job.startedAt;
					job.updatedAt = status.lastUpdate ?? Date.now();
					if (status.steps?.length) {
						job.agents = status.steps.map((step) => step.agent);
					}
					job.sessionDir = status.sessionDir ?? job.sessionDir;
					job.outputFile = status.outputFile ?? job.outputFile;
					job.totalTokens = status.totalTokens ?? job.totalTokens;
					job.sessionFile = status.sessionFile ?? job.sessionFile;
					// job.shareUrl = status.shareUrl ?? job.shareUrl;
				} else {
					job.status = job.status === "queued" ? "running" : job.status;
					job.updatedAt = Date.now();
				}
			}

			renderWidget(lastUiContext, Array.from(asyncJobs.values()));
		}, POLL_INTERVAL_MS);
		poller.unref?.();
	};

	const completionSeen = new Map<string, number>();
	const completionTtlMs = 10 * 60 * 1000;
	const handleResult = (file: string) => {
		const p = path.join(RESULTS_DIR, file);
		if (!fs.existsSync(p)) return;
		try {
			const data = JSON.parse(fs.readFileSync(p, "utf-8"));
			if (data.sessionId && data.sessionId !== currentSessionId) return;
			if (!data.sessionId && data.cwd && data.cwd !== baseCwd) return;
			const now = Date.now();
			const completionKey = buildCompletionKey(data, `result:${file}`);
			if (markSeenWithTtl(completionSeen, completionKey, now, completionTtlMs)) {
				try {
					fs.unlinkSync(p);
				} catch {}
				return;
			}
			pi.events.emit("subagent:complete", data);
			fs.unlinkSync(p);
		} catch {}
	};

	const resultFileCoalescer = createFileCoalescer(handleResult, 50);
	let watcher: fs.FSWatcher | null = null;
	let watcherRestartTimer: ReturnType<typeof setTimeout> | null = null;

	function startResultWatcher(): void {
		watcherRestartTimer = null;
		try {
			watcher = fs.watch(RESULTS_DIR, (ev, file) => {
				if (ev !== "rename" || !file) return;
				const fileName = file.toString();
				if (!fileName.endsWith(".json")) return;
				resultFileCoalescer.schedule(fileName);
			});
			watcher.on("error", () => {
				// Watcher died (directory deleted, ACL change, etc.) — restart after delay
				watcher = null;
				watcherRestartTimer = setTimeout(() => {
					try {
						fs.mkdirSync(RESULTS_DIR, { recursive: true });
						startResultWatcher();
					} catch {}
				}, 3000);
			});
			watcher.unref?.();
		} catch {
			// fs.watch can throw if directory is inaccessible — retry after delay
			watcher = null;
			watcherRestartTimer = setTimeout(() => {
				try {
					fs.mkdirSync(RESULTS_DIR, { recursive: true });
					startResultWatcher();
				} catch {}
			}, 3000);
		}
	}

	startResultWatcher();
	fs.readdirSync(RESULTS_DIR)
		.filter((f) => f.endsWith(".json"))
		.forEach((file) => resultFileCoalescer.schedule(file, 0));

	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		name: "subagent",
		label: "Subagent",
		description: `Delegate to subagents or manage agent definitions.

EXECUTION (use exactly ONE mode):
• SINGLE: { agent, task } - one task
• CHAIN: { chain: [{agent:"scout"}, {agent:"planner"}] } - sequential pipeline
• PARALLEL: { tasks: [{agent,task}, ...] } - concurrent execution

CHAIN TEMPLATE VARIABLES (use in task strings):
• {task} - The original task/request from the user
• {previous} - Text response from the previous step (empty for first step)
• {chain_dir} - Shared directory for chain files (e.g., <tmpdir>/pi-chain-runs/abc123/)

CHAIN DATA FLOW:
1. Each step's text response automatically becomes {previous} for the next step
2. Steps can also write files to {chain_dir} (via agent's "output" config)
3. Later steps can read those files (via agent's "reads" config)

Example: { chain: [{agent:"scout", task:"Analyze {task}"}, {agent:"planner", task:"Plan based on {previous}"}] }

MANAGEMENT (use action field — omit agent/task/chain/tasks):
• { action: "list" } - discover available agents and chains
• { action: "get", agent: "name" } - full agent detail with system prompt
• { action: "create", config: { name, description, systemPrompt, ... } } - create agent/chain
• { action: "update", agent: "name", config: { ... } } - modify fields (merge)
• { action: "delete", agent: "name" } - remove definition
• Use chainName instead of agent for chain operations`,
		parameters: SubagentParams,

		async execute(_id, params, signal, onUpdate, ctx) {
			baseCwd = ctx.cwd;
			if (params.action) {
				const validActions = ["list", "get", "create", "update", "delete"];
				if (!validActions.includes(params.action)) {
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}. Valid: ${validActions.join(", ")}` }],
						isError: true,
						details: { mode: "management" as const, results: [] },
					};
				}
				return handleManagementAction(params.action, params, ctx);
			}

			const { blocked, depth, maxDepth } = checkSubagentDepth();
			if (blocked) {
				return {
					content: [
						{
							type: "text",
							text:
								`Nested subagent call blocked (depth=${depth}, max=${maxDepth}). ` +
								"You are running at the maximum subagent nesting depth. " +
								"Complete your current task directly without delegating to further subagents.",
						},
					],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}

			const scope: AgentScope = resolveExecutionAgentScope(params.agentScope);
			currentSessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const agents = discoverAgents(ctx.cwd, scope).agents;
			const runId = randomUUID().slice(0, 8);
			const shareEnabled = params.share === true;
			const sessionEnabled = shareEnabled || Boolean(params.sessionDir);
			const sessionRoot = sessionEnabled
				? params.sessionDir
					? path.resolve(params.sessionDir)
					: fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"))
				: undefined;
			if (sessionRoot) {
				try {
					fs.mkdirSync(sessionRoot, { recursive: true });
				} catch {}
			}
			const sessionDirForIndex = (idx?: number) =>
				sessionRoot ? path.join(sessionRoot, `run-${idx ?? 0}`) : undefined;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);

			const requestedAsync = params.async ?? asyncByDefault;
			const parallelDowngraded = hasTasks && requestedAsync;
			// clarify implies sync mode (TUI is blocking)
			// - Chains default to TUI (clarify: true), so async requires explicit clarify: false
			// - Single defaults to no TUI, so async is allowed unless clarify: true is passed
			const effectiveAsync = requestedAsync && !hasTasks && (
				hasChain 
					? params.clarify === false    // chains: only async if TUI explicitly disabled
					: params.clarify !== true     // single: async unless TUI explicitly enabled
			);

			const artifactConfig: ArtifactConfig = {
				...DEFAULT_ARTIFACT_CONFIG,
				enabled: params.artifacts !== false,
			};

			const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
			const artifactsDir = effectiveAsync ? tempArtifactsDir : getArtifactsDir(sessionFile);

			if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
						},
					],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}

			// Validate chain early (before async/sync branching)
			if (hasChain && params.chain) {
				if (params.chain.length === 0) {
					return {
						content: [{ type: "text", text: "Chain must have at least one step" }],
						isError: true,
						details: { mode: "chain" as const, results: [] },
					};
				}
				// First step must have a task
				const firstStep = params.chain[0] as ChainStep;
				if (isParallelStep(firstStep)) {
					// All tasks in the first parallel step must have tasks (no {previous} to reference)
					const missingTaskIndex = firstStep.parallel.findIndex((t) => !t.task);
					if (missingTaskIndex !== -1) {
						return {
							content: [{ type: "text", text: `First parallel step: task ${missingTaskIndex + 1} must have a task (no previous output to reference)` }],
							isError: true,
							details: { mode: "chain" as const, results: [] },
						};
					}
				} else if (!(firstStep as SequentialStep).task && !params.task) {
					return {
						content: [{ type: "text", text: "First step in chain must have a task" }],
						isError: true,
						details: { mode: "chain" as const, results: [] },
					};
				}
				// Validate all agents exist
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i] as ChainStep;
					const stepAgents = getStepAgents(step);
					for (const agentName of stepAgents) {
						if (!agents.find((a) => a.name === agentName)) {
							return {
								content: [{ type: "text", text: `Unknown agent: ${agentName} (step ${i + 1})` }],
								isError: true,
								details: { mode: "chain" as const, results: [] },
							};
						}
					}
					// Validate parallel steps have at least one task
					if (isParallelStep(step) && step.parallel.length === 0) {
						return {
							content: [{ type: "text", text: `Parallel step ${i + 1} must have at least one task` }],
							isError: true,
							details: { mode: "chain" as const, results: [] },
						};
					}
				}
			}

			if (effectiveAsync) {
				if (!isAsyncAvailable()) {
					return {
						content: [{ type: "text", text: "Async mode requires jiti for TypeScript execution but it could not be found. Install globally: npm install -g jiti" }],
						isError: true,
						details: { mode: "single" as const, results: [] },
					};
				}
				const id = randomUUID();
				const asyncCtx = { pi, cwd: ctx.cwd, currentSessionId: currentSessionId! };

				if (hasChain && params.chain) {
					const normalized = normalizeSkillInput(params.skill);
					const chainSkills = normalized === false ? [] : (normalized ?? []);
					return executeAsyncChain(id, {
						chain: params.chain as ChainStep[],
						agents,
						ctx: asyncCtx,
						cwd: params.cwd,
						maxOutput: params.maxOutput,
						artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
						artifactConfig,
						shareEnabled,
						sessionRoot,
						chainSkills,
					});
				}

				if (hasSingle) {
					const a = agents.find((x) => x.name === params.agent);
					if (!a) {
						return {
							content: [{ type: "text", text: `Unknown: ${params.agent}` }],
							isError: true,
							details: { mode: "single" as const, results: [] },
						};
					}
					const rawOutput = params.output !== undefined ? params.output : a.output;
					const effectiveOutput: string | false | undefined = rawOutput === true ? a.output : rawOutput;
					return executeAsyncSingle(id, {
						agent: params.agent!,
						task: params.task!,
						agentConfig: a,
						ctx: asyncCtx,
						cwd: params.cwd,
						maxOutput: params.maxOutput,
						artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
						artifactConfig,
						shareEnabled,
						sessionRoot,
						skills: (() => {
							const normalized = normalizeSkillInput(params.skill);
							if (normalized === false) return [];
							if (normalized === undefined) return undefined;
							return normalized;
						})(),
						output: effectiveOutput,
					});
				}
			}

			const allProgress: AgentProgress[] = [];
			const allArtifactPaths: ArtifactPaths[] = [];

			if (hasChain && params.chain) {
				const normalized = normalizeSkillInput(params.skill);
				const chainSkills = normalized === false ? [] : (normalized ?? []);
				// Use extracted chain execution module
				const chainResult = await executeChain({
					chain: params.chain as ChainStep[],
					task: params.task,
					agents,
					ctx,
					signal,
					runId,
					cwd: params.cwd,
					shareEnabled,
					sessionDirForIndex,
					artifactsDir,
					artifactConfig,
					includeProgress: params.includeProgress,
					clarify: params.clarify,
					onUpdate,
					chainSkills,
					chainDir: params.chainDir,
					stream: params.stream ?? streamByDefault,
				});

				// User requested async via TUI - dispatch to async executor
				if (chainResult.requestedAsync) {
					if (!isAsyncAvailable()) {
						return {
							content: [{ type: "text", text: "Background mode requires jiti for TypeScript execution but it could not be found." }],
							isError: true,
							details: { mode: "chain" as const, results: [] },
						};
					}
					const id = randomUUID();
					const asyncCtx = { pi, cwd: ctx.cwd, currentSessionId: currentSessionId! };
					return executeAsyncChain(id, {
						chain: chainResult.requestedAsync.chain,
						agents,
						ctx: asyncCtx,
						cwd: params.cwd,
						maxOutput: params.maxOutput,
						artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
						artifactConfig,
						shareEnabled,
						sessionRoot,
						chainSkills: chainResult.requestedAsync.chainSkills,
					});
				}

				return chainResult;
			}

			if (hasTasks && params.tasks) {
				// MAX_PARALLEL check first (fail fast before TUI)
				if (params.tasks.length > MAX_PARALLEL)
					return {
						content: [{ type: "text", text: `Max ${MAX_PARALLEL} tasks` }],
						isError: true,
						details: { mode: "parallel" as const, results: [] },
					};

				// Validate all agents exist
				const agentConfigs: AgentConfig[] = [];
				for (const t of params.tasks) {
					const config = agents.find(a => a.name === t.agent);
					if (!config) {
						return {
							content: [{ type: "text", text: `Unknown agent: ${t.agent}` }],
							isError: true,
							details: { mode: "parallel" as const, results: [] },
						};
					}
					agentConfigs.push(config);
				}

				// Mutable copies for TUI modifications
				let tasks = params.tasks.map(t => t.task);
				const modelOverrides: (string | undefined)[] = params.tasks.map(t => (t as { model?: string }).model);
				// Initialize skill overrides from task-level skill params (may be overridden by TUI)
				const skillOverrides: (string[] | false | undefined)[] = params.tasks.map(t => 
					normalizeSkillInput((t as { skill?: string | string[] | boolean }).skill)
				);

				// Show clarify TUI if requested
				if (params.clarify === true && ctx.hasUI) {
					// Get available models (same pattern as chain-execution.ts)
					const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map((m) => ({
						provider: m.provider,
						id: m.id,
						fullId: `${m.provider}/${m.id}`,
					}));

					// Resolve behaviors with task-level skill overrides for TUI display
					const behaviors = agentConfigs.map((c, i) => 
						resolveStepBehavior(c, { skills: skillOverrides[i] })
					);
					const availableSkills = discoverAvailableSkills(ctx.cwd);

					const result = await ctx.ui.custom<ChainClarifyResult>(
						(tui, theme, _kb, done) =>
							new ChainClarifyComponent(
								tui, theme,
								agentConfigs,
								tasks,
								'',          // no originalTask for parallel (each task is independent)
								undefined,   // no chainDir for parallel
								behaviors,
								availableModels,
								availableSkills,
								done,
								'parallel',  // mode
							),
						{ overlay: true, overlayOptions: { anchor: 'center', width: 84, maxHeight: '80%' } },
					);

					if (!result || !result.confirmed) {
						return { content: [{ type: 'text', text: 'Cancelled' }], details: { mode: 'parallel', results: [] } };
					}

					// Apply TUI overrides
					tasks = result.templates;
					for (let i = 0; i < result.behaviorOverrides.length; i++) {
						const override = result.behaviorOverrides[i];
						if (override?.model) modelOverrides[i] = override.model;
						if (override?.skills !== undefined) skillOverrides[i] = override.skills;
					}

					// User requested background execution
					if (result.runInBackground) {
						if (!isAsyncAvailable()) {
							return {
								content: [{ type: "text", text: "Background mode requires jiti for TypeScript execution but it could not be found." }],
								isError: true,
								details: { mode: "parallel" as const, results: [] },
							};
						}
						const id = randomUUID();
						const asyncCtx = { pi, cwd: ctx.cwd, currentSessionId: currentSessionId! };
						// Convert parallel tasks to a chain with a single parallel step
						const parallelTasks = params.tasks!.map((t, i) => ({
							agent: t.agent,
							task: tasks[i],
							cwd: t.cwd,
							...(modelOverrides[i] ? { model: modelOverrides[i] } : {}),
							...(skillOverrides[i] !== undefined ? { skill: skillOverrides[i] } : {}),
						}));
						return executeAsyncChain(id, {
							chain: [{ parallel: parallelTasks }],
							agents,
							ctx: asyncCtx,
							cwd: params.cwd,
							maxOutput: params.maxOutput,
							artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
							artifactConfig,
							shareEnabled,
							sessionRoot,
							chainSkills: [],
						});
					}
				}

				// Execute with overrides (tasks array has same length as params.tasks)
				const behaviors = agentConfigs.map(c => resolveStepBehavior(c, {}));
				const liveResults: (SingleResult | undefined)[] = new Array(params.tasks.length).fill(undefined);
				const liveProgress: (AgentProgress | undefined)[] = new Array(params.tasks.length).fill(undefined);
				const results = await mapConcurrent(params.tasks, MAX_CONCURRENCY, async (t, i) => {
					const overrideSkills = skillOverrides[i];
					const effectiveSkills = overrideSkills === undefined ? behaviors[i]?.skills : overrideSkills;
					return runSync(ctx.cwd, agents, t.agent, tasks[i]!, {
						cwd: t.cwd ?? params.cwd,
						signal,
						runId,
						index: i,
						sessionDir: sessionDirForIndex(i),
						share: shareEnabled,
						artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
						artifactConfig,
						maxOutput: params.maxOutput,
						modelOverride: modelOverrides[i],
						skills: effectiveSkills === false ? [] : effectiveSkills,
						onUpdate: onUpdate
							? (p) => {
									const stepResults = p.details?.results || [];
									const stepProgress = p.details?.progress || [];
									if (stepResults.length > 0) liveResults[i] = stepResults[0];
									if (stepProgress.length > 0) liveProgress[i] = stepProgress[0];
									const mergedResults = liveResults.filter((r): r is SingleResult => r !== undefined);
									const mergedProgress = liveProgress.filter((pg): pg is AgentProgress => pg !== undefined);
									onUpdate({
										content: p.content,
										details: {
											mode: "parallel",
											results: mergedResults,
											progress: mergedProgress,
											totalSteps: params.tasks!.length,
										},
									});
								}
							: undefined,
					});
				});
				for (let i = 0; i < results.length; i++) {
					const run = results[i]!;
					recordRun(run.agent, tasks[i]!, run.exitCode, run.progressSummary?.durationMs ?? 0);
				}

				for (const r of results) {
					if (r.progress) allProgress.push(r.progress);
					if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);
				}

				const ok = results.filter((r) => r.exitCode === 0).length;
				const downgradeNote = parallelDowngraded ? " (async not supported for parallel)" : "";

				// Aggregate outputs from all parallel tasks
				const aggregatedOutput = results
					.map((r, i) => {
						const header = `=== Task ${i + 1}: ${r.agent} ===`;
						const output = r.truncation?.text || getFinalOutput(r.messages);
						const hasOutput = Boolean(output?.trim());
						const status = r.exitCode !== 0
							? `⚠️ FAILED (exit code ${r.exitCode})${r.error ? `: ${r.error}` : ""}`
							: r.error
								? `⚠️ WARNING: ${r.error}`
								: !hasOutput
									? "⚠️ EMPTY OUTPUT"
									: "";
						const body = status
							? (hasOutput ? `${status}\n${output}` : status)
							: output;
						return `${header}\n${body}`;
					})
					.join("\n\n");

				const summary = `${ok}/${results.length} succeeded${downgradeNote}`;
				const fullContent = `${summary}\n\n${aggregatedOutput}`;

				return {
					content: [{ type: "text", text: fullContent }],
					details: {
						mode: "parallel",
						results,
						progress: params.includeProgress ? allProgress : undefined,
						artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
					},
				};
			}

			if (hasSingle) {
				// Look up agent config for output handling
				const agentConfig = agents.find((a) => a.name === params.agent);
				if (!agentConfig) {
					return {
						content: [{ type: 'text', text: `Unknown agent: ${params.agent}` }],
						isError: true,
						details: { mode: 'single', results: [] },
					};
				}

				let task = params.task!;
				let modelOverride: string | undefined = params.model as string | undefined;
				let skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
				// Normalize output: true means "use default" (same as undefined), false means disable
				const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
				let effectiveOutput: string | false | undefined = rawOutput === true ? agentConfig.output : rawOutput;

				// Show clarify TUI if requested
				if (params.clarify === true && ctx.hasUI) {
					// Get available models (same pattern as chain-execution.ts)
					const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map((m) => ({
						provider: m.provider,
						id: m.id,
						fullId: `${m.provider}/${m.id}`,
					}));

					const behavior = resolveStepBehavior(agentConfig, { output: effectiveOutput, skills: skillOverride });
					const availableSkills = discoverAvailableSkills(ctx.cwd);

					const result = await ctx.ui.custom<ChainClarifyResult>(
						(tui, theme, _kb, done) =>
							new ChainClarifyComponent(
								tui, theme,
								[agentConfig],
								[task],
								task,
								undefined,  // no chainDir for single
								[behavior],
								availableModels,
								availableSkills,
								done,
								'single',   // mode
							),
						{ overlay: true, overlayOptions: { anchor: 'center', width: 84, maxHeight: '80%' } },
					);

					if (!result || !result.confirmed) {
						return { content: [{ type: 'text', text: 'Cancelled' }], details: { mode: 'single', results: [] } };
					}

					// Apply TUI overrides
					task = result.templates[0]!;
					const override = result.behaviorOverrides[0];
					if (override?.model) modelOverride = override.model;
					if (override?.output !== undefined) effectiveOutput = override.output;
					if (override?.skills !== undefined) skillOverride = override.skills;

					// User requested background execution
					if (result.runInBackground) {
						if (!isAsyncAvailable()) {
							return {
								content: [{ type: "text", text: "Background mode requires jiti for TypeScript execution but it could not be found." }],
								isError: true,
								details: { mode: "single" as const, results: [] },
							};
						}
						const id = randomUUID();
						const asyncCtx = { pi, cwd: ctx.cwd, currentSessionId: currentSessionId! };
						return executeAsyncSingle(id, {
							agent: params.agent!,
							task,
							agentConfig,
							ctx: asyncCtx,
							cwd: params.cwd,
							maxOutput: params.maxOutput,
							artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
							artifactConfig,
							shareEnabled,
							sessionRoot,
							skills: skillOverride === false ? [] : skillOverride,
							output: effectiveOutput,
						});
					}
				}

				const cleanTask = task;
				const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, params.cwd);
				task = injectSingleOutputInstruction(task, outputPath);

				const effectiveSkills = skillOverride === false
					? []
					: skillOverride === undefined
						? undefined
						: skillOverride;

				const r = await runSync(ctx.cwd, agents, params.agent!, task, {
					cwd: params.cwd,
					signal,
					runId,
					sessionDir: sessionDirForIndex(0),
					share: shareEnabled,
					artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
					artifactConfig,
					maxOutput: params.maxOutput,
					onUpdate,
					modelOverride,
					skills: effectiveSkills,
				});
				recordRun(params.agent!, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0);

				if (r.progress) allProgress.push(r.progress);
				if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

				const fullOutput = getFinalOutput(r.messages);
				const finalizedOutput = finalizeSingleOutput({
					fullOutput,
					truncatedOutput: r.truncation?.text,
					outputPath,
					exitCode: r.exitCode,
				});

				if (r.exitCode !== 0)
					return {
						content: [{ type: "text", text: r.error || "Failed" }],
						details: {
							mode: "single",
							results: [r],
							progress: params.includeProgress ? allProgress : undefined,
							artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
							truncation: r.truncation,
						},
						isError: true,
					};
				return {
					content: [{ type: "text", text: finalizedOutput.displayOutput || "(no output)" }],
					details: {
						mode: "single",
						results: [r],
						progress: params.includeProgress ? allProgress : undefined,
						artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
						truncation: r.truncation,
					},
				};
			}

			return {
				content: [{ type: "text", text: "Invalid params" }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		},

		renderCall(args, theme) {
			if (args.action) {
				const target = args.agent || args.chainName || "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`,
					0, 0,
				);
			}
			const isParallel = (args.tasks?.length ?? 0) > 0;
			const asyncLabel = args.async === true && !isParallel ? theme.fg("warning", " [async]") : "";
			if (args.chain?.length)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}chain (${args.chain.length})${asyncLabel}`,
					0,
					0,
				);
			if (isParallel)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${args.tasks!.length})`,
					0,
					0,
				);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "?")}${asyncLabel}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme) {
			return renderSubagentResult(result, options, theme);
		},

	};

	const statusTool: ToolDefinition<typeof StatusParams, Details> = {
		name: "subagent_status",
		label: "Subagent Status",
		description: "Inspect async subagent run status and artifacts",
		parameters: StatusParams,

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			let asyncDir: string | null = null;
			let resolvedId = params.id;

			if (params.dir) {
				asyncDir = path.resolve(params.dir);
			} else if (params.id) {
				const direct = path.join(ASYNC_DIR, params.id);
				if (fs.existsSync(direct)) {
					asyncDir = direct;
				} else {
					const match = findByPrefix(ASYNC_DIR, params.id);
					if (match) {
						asyncDir = match;
						resolvedId = path.basename(match);
					}
				}
			}

			const resultPath =
				params.id && !asyncDir ? findByPrefix(RESULTS_DIR, params.id, ".json") : null;

			if (!asyncDir && !resultPath) {
				return {
					content: [{ type: "text", text: "Async run not found. Provide id or dir." }],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}

			if (asyncDir) {
				const status = readStatus(asyncDir);
				const logPath = path.join(asyncDir, `subagent-log-${resolvedId ?? "unknown"}.md`);
				const eventsPath = path.join(asyncDir, "events.jsonl");
				if (status) {
					const stepsTotal = status.steps?.length ?? 1;
					const current = status.currentStep !== undefined ? status.currentStep + 1 : undefined;
					const stepLine =
						current !== undefined ? `Step: ${current}/${stepsTotal}` : `Steps: ${stepsTotal}`;
					const started = new Date(status.startedAt).toISOString();
					const updated = status.lastUpdate ? new Date(status.lastUpdate).toISOString() : "n/a";

					const lines = [
						`Run: ${status.runId}`,
						`State: ${status.state}`,
						`Mode: ${status.mode}`,
						stepLine,
						`Started: ${started}`,
						`Updated: ${updated}`,
						`Dir: ${asyncDir}`,
					];
					if (status.sessionFile) lines.push(`Session: ${status.sessionFile}`);
					// Sharing disabled - session file path shown above
					if (fs.existsSync(logPath)) lines.push(`Log: ${logPath}`);
					if (fs.existsSync(eventsPath)) lines.push(`Events: ${eventsPath}`);

					return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
				}
			}

			if (resultPath) {
				try {
					const raw = fs.readFileSync(resultPath, "utf-8");
					const data = JSON.parse(raw) as { id?: string; success?: boolean; summary?: string };
					const status = data.success ? "complete" : "failed";
					const lines = [`Run: ${data.id ?? params.id}`, `State: ${status}`, `Result: ${resultPath}`];
					if (data.summary) lines.push("", data.summary);
					return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
				} catch {}
			}

			return {
				content: [{ type: "text", text: "Status file not found." }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		},
	};

	pi.registerTool(tool);
	pi.registerTool(statusTool);

	interface InlineConfig {
		output?: string | false;
		reads?: string[] | false;
		model?: string;
		skill?: string[] | false;
		progress?: boolean;
	}

	const parseInlineConfig = (raw: string): InlineConfig => {
		const config: InlineConfig = {};
		for (const part of raw.split(",")) {
			const trimmed = part.trim();
			if (!trimmed) continue;
			const eq = trimmed.indexOf("=");
			if (eq === -1) {
				if (trimmed === "progress") config.progress = true;
				continue;
			}
			const key = trimmed.slice(0, eq).trim();
			const val = trimmed.slice(eq + 1).trim();
			switch (key) {
				case "output": config.output = val === "false" ? false : val; break;
				case "reads": config.reads = val === "false" ? false : val.split("+").filter(Boolean); break;
				case "model": config.model = val || undefined; break;
				case "skill": case "skills": config.skill = val === "false" ? false : val.split("+").filter(Boolean); break;
				case "progress": config.progress = val !== "false"; break;
			}
		}
		return config;
	};

	const parseAgentToken = (token: string): { name: string; config: InlineConfig } => {
		const bracket = token.indexOf("[");
		if (bracket === -1) return { name: token, config: {} };
		const end = token.lastIndexOf("]");
		return { name: token.slice(0, bracket), config: parseInlineConfig(token.slice(bracket + 1, end !== -1 ? end : undefined)) };
	};

	/** Extract trailing flags from end of args */
	const extractFlags = (
		args: string,
		opts: { allowBg?: boolean; allowStream?: boolean } = {},
	): { args: string; bg: boolean; stream: boolean } => {
		const allowBg = opts.allowBg !== false;
		const allowStream = opts.allowStream === true;
		let bg = false;
		let stream = false;
		let cleaned = args.trimEnd();

		while (true) {
			if (allowBg && (cleaned.endsWith(" --bg") || cleaned === "--bg")) {
				cleaned = cleaned.slice(0, cleaned.length - (cleaned === "--bg" ? 4 : 5)).trimEnd();
				bg = true;
				continue;
			}
			if (allowStream && (cleaned.endsWith(" --stream") || cleaned === "--stream")) {
				cleaned = cleaned.slice(0, cleaned.length - (cleaned === "--stream" ? 8 : 9)).trimEnd();
				stream = true;
				continue;
			}
			break;
		}

		return { args: cleaned.trim(), bg, stream };
	};

	const setupDirectRun = (ctx: ExtensionContext) => {
		const runId = randomUUID().slice(0, 8);
		const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
		return {
			runId,
			shareEnabled: false,
			sessionDirForIndex: (idx?: number) => path.join(sessionRoot, `run-${idx ?? 0}`),
			artifactsDir: getArtifactsDir(ctx.sessionManager.getSessionFile() ?? null),
			artifactConfig: { ...DEFAULT_ARTIFACT_CONFIG } as ArtifactConfig,
		};
	};

	const makeAgentCompletions = (multiAgent: boolean) => (prefix: string) => {
		const agents = discoverAgents(baseCwd, "both").agents;
		if (!multiAgent) {
			if (prefix.includes(" ")) return null;
			return agents.filter((a) => a.name.startsWith(prefix)).map((a) => ({ value: a.name, label: a.name }));
		}

		const lastArrow = prefix.lastIndexOf(" -> ");
		const segment = lastArrow !== -1 ? prefix.slice(lastArrow + 4) : prefix;
		if (segment.includes(" -- ") || segment.includes('"') || segment.includes("'")) return null;

		const lastWord = (prefix.match(/(\S*)$/) || ["", ""])[1];
		const beforeLastWord = prefix.slice(0, prefix.length - lastWord.length);

		if (lastWord === "->") {
			return agents.map((a) => ({ value: `${prefix} ${a.name}`, label: a.name }));
		}

		return agents.filter((a) => a.name.startsWith(lastWord)).map((a) => ({ value: `${beforeLastWord}${a.name}`, label: a.name }));
	};

	const openAgentManager = async (ctx: ExtensionContext) => {
		const agentData = { ...discoverAgentsAll(ctx.cwd), cwd: ctx.cwd };
		const models = ctx.modelRegistry.getAvailable().map((m) => ({
			provider: m.provider,
			id: m.id,
			fullId: `${m.provider}/${m.id}`,
		}));
		const skills = discoverAvailableSkills(ctx.cwd);

		const result = await ctx.ui.custom<ManagerResult>(
			(tui, theme, _kb, done) => new AgentManagerComponent(tui, theme, agentData, models, skills, done),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);
		if (!result) return;

		// Ad-hoc chains from the overlay use direct execution for the chain-clarify TUI.
		// All other paths (single, saved-chain, parallel launches, slash commands)
		// route through sendToolCall → LLM → tool handler to get live progress.
		if (result.action === "chain") {
			const agents = discoverAgents(baseCwd, "both").agents;
			const exec = setupDirectRun(ctx);
			const chain: SequentialStep[] = result.agents.map((name, i) => ({
				agent: name,
				...(i === 0 ? { task: result.task } : {}),
			}));
			executeChain({ chain, task: result.task, agents, ctx, ...exec, clarify: true })
				.then((r) => {
					// User requested async via TUI - dispatch to async executor
					if (r.requestedAsync) {
						if (!isAsyncAvailable()) {
							pi.sendUserMessage("Background mode requires jiti for TypeScript execution but it could not be found.");
							return;
						}
						const id = randomUUID();
						const asyncCtx = { pi, cwd: ctx.cwd, currentSessionId: ctx.sessionManager.getSessionId() ?? id };
						const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
						executeAsyncChain(id, {
							chain: r.requestedAsync.chain,
							agents,
							ctx: asyncCtx,
							maxOutput: undefined,
							artifactsDir: exec.artifactsDir,
							artifactConfig: exec.artifactConfig,
							shareEnabled: false,
							sessionRoot,
							chainSkills: r.requestedAsync.chainSkills,
						}).then((asyncResult) => {
							pi.sendUserMessage(asyncResult.content[0]?.text || "(launched in background)");
						}).catch((err) => {
							pi.sendUserMessage(`Async launch failed: ${err instanceof Error ? err.message : String(err)}`);
						});
						return;
					}
					pi.sendUserMessage(r.content[0]?.text || "(no output)");
				})
				.catch((err) => pi.sendUserMessage(`Chain failed: ${err instanceof Error ? err.message : String(err)}`));
			return;
		}

		const sendToolCall = (params: Record<string, unknown>) => {
			pi.sendUserMessage(
				`Call the subagent tool with these exact parameters: ${JSON.stringify({ ...params, agentScope: "both" })}`,
			);
		};

		if (result.action === "launch") {
			sendToolCall({ agent: result.agent, task: result.task, clarify: !result.skipClarify });
		} else if (result.action === "launch-chain") {
			const chainParam = result.chain.steps.map((step) => ({
				agent: step.agent,
				task: step.task || undefined,
				output: step.output,
				reads: step.reads,
				progress: step.progress,
				skill: step.skills,
				model: step.model,
			}));
			sendToolCall({ chain: chainParam, task: result.task, clarify: !result.skipClarify });
		} else if (result.action === "parallel") {
			sendToolCall({ tasks: result.tasks, clarify: !result.skipClarify });
		}
	};

	pi.registerCommand("agents", {
		description: "Open the Agents Manager",
		handler: async (_args, ctx) => {
			await openAgentManager(ctx);
		},
	});

	pi.registerCommand("run", {
		description: "Run a subagent directly: /run agent[output=file] task [--bg]",
		getArgumentCompletions: makeAgentCompletions(false),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg } = extractFlags(args, { allowBg: true });
			const input = cleanedArgs.trim();
			const firstSpace = input.indexOf(" ");
			if (firstSpace === -1) { ctx.ui.notify("Usage: /run <agent> <task> [--bg]", "error"); return; }
			const { name: agentName, config: inline } = parseAgentToken(input.slice(0, firstSpace));
			const task = input.slice(firstSpace + 1).trim();
			if (!task) { ctx.ui.notify("Usage: /run <agent> <task> [--bg]", "error"); return; }

			const agents = discoverAgents(baseCwd, "both").agents;
			if (!agents.find((a) => a.name === agentName)) { ctx.ui.notify(`Unknown agent: ${agentName}`, "error"); return; }

			let finalTask = task;
			if (inline.reads && Array.isArray(inline.reads) && inline.reads.length > 0) {
				finalTask = `[Read from: ${inline.reads.join(", ")}]\n\n${finalTask}`;
			}
			const params: Record<string, unknown> = { agent: agentName, task: finalTask, clarify: false };
			if (inline.output !== undefined) params.output = inline.output;
			if (inline.skill !== undefined) params.skill = inline.skill;
			if (inline.model) params.model = inline.model;
			if (bg) params.async = true;
			pi.sendUserMessage(`Call the subagent tool with these exact parameters: ${JSON.stringify({ ...params, agentScope: "both" })}`);
		},
	});

	interface ParsedStep { name: string; config: InlineConfig; task?: string }

	const parseAgentArgs = (args: string, command: string, ctx: ExtensionContext): { steps: ParsedStep[]; task: string } | null => {
		const input = args.trim();
		const usage = `Usage: /${command} agent1 "task1" -> agent2 "task2"`;
		let steps: ParsedStep[];
		let sharedTask: string;
		let perStep = false;

		if (input.includes(" -> ")) {
			perStep = true;
			const segments = input.split(" -> ");
			steps = [];
			for (const seg of segments) {
				const trimmed = seg.trim();
				if (!trimmed) continue;
				let agentPart: string;
				let task: string | undefined;
				const qMatch = trimmed.match(/^(\S+(?:\[[^\]]*\])?)\s+(?:"([^"]*)"|'([^']*)')$/);
				if (qMatch) {
					agentPart = qMatch[1]!;
					task = (qMatch[2] ?? qMatch[3]) || undefined;
				} else {
					const dashIdx = trimmed.indexOf(" -- ");
					if (dashIdx !== -1) {
						agentPart = trimmed.slice(0, dashIdx).trim();
						task = trimmed.slice(dashIdx + 4).trim() || undefined;
					} else {
						agentPart = trimmed;
					}
				}
				const parsed = parseAgentToken(agentPart);
				steps.push({ ...parsed, task });
			}
			sharedTask = steps.find((s) => s.task)?.task ?? "";
		} else {
			const delimiterIndex = input.indexOf(" -- ");
			if (delimiterIndex === -1) {
				ctx.ui.notify(usage, "error");
				return null;
			}
			const agentsPart = input.slice(0, delimiterIndex).trim();
			sharedTask = input.slice(delimiterIndex + 4).trim();
			if (!agentsPart || !sharedTask) {
				ctx.ui.notify(usage, "error");
				return null;
			}
			steps = agentsPart.split(/\s+/).filter(Boolean).map((t) => parseAgentToken(t));
		}

		if (steps.length === 0) {
			ctx.ui.notify(usage, "error");
			return null;
		}
		const agents = discoverAgents(baseCwd, "both").agents;
		for (const step of steps) {
			if (!agents.find((a) => a.name === step.name)) {
				ctx.ui.notify(`Unknown agent: ${step.name}`, "error");
				return null;
			}
		}
		if (command === "chain" && !steps[0]?.task && (perStep || !sharedTask)) {
			ctx.ui.notify(`First step must have a task: /chain agent "task" -> agent2`, "error");
			return null;
		}
		if (command === "parallel" && !steps.some((s) => s.task) && !sharedTask) {
			ctx.ui.notify("At least one step must have a task", "error");
			return null;
		}
		return { steps, task: sharedTask };
	};

	pi.registerCommand("chain", {
		description: "Run agents in sequence: /chain scout \"task\" -> planner [--stream] [--bg]",
		getArgumentCompletions: makeAgentCompletions(true),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, stream } = extractFlags(args, { allowBg: true, allowStream: true });
			const parsed = parseAgentArgs(cleanedArgs, "chain", ctx);
			if (!parsed) return;
			const chain = parsed.steps.map(({ name, config, task: stepTask }, i) => ({
				agent: name,
				...(stepTask ? { task: stepTask } : i === 0 && parsed.task ? { task: parsed.task } : {}),
				...(config.output !== undefined ? { output: config.output } : {}),
				...(config.reads !== undefined ? { reads: config.reads } : {}),
				...(config.model ? { model: config.model } : {}),
				...(config.skill !== undefined ? { skill: config.skill } : {}),
				...(config.progress !== undefined ? { progress: config.progress } : {}),
			}));
			const params: Record<string, unknown> = { chain, task: parsed.task, clarify: false, agentScope: "both" };
			if (stream) params.stream = true;
			if (bg) params.async = true;
			pi.sendUserMessage(`Call the subagent tool with these exact parameters: ${JSON.stringify(params)}`);
		},
	});

	pi.registerCommand("parallel", {
		description: "Run agents in parallel: /parallel scout \"task1\" -> reviewer \"task2\" [--bg]",
		getArgumentCompletions: makeAgentCompletions(true),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg } = extractFlags(args, { allowBg: true });
			const parsed = parseAgentArgs(cleanedArgs, "parallel", ctx);
			if (!parsed) return;
			if (parsed.steps.length > MAX_PARALLEL) { ctx.ui.notify(`Max ${MAX_PARALLEL} parallel tasks`, "error"); return; }
			const tasks = parsed.steps.map(({ name, config, task: stepTask }) => ({
				agent: name,
				task: stepTask ?? parsed.task,
				...(config.output !== undefined ? { output: config.output } : {}),
				...(config.reads !== undefined ? { reads: config.reads } : {}),
				...(config.model ? { model: config.model } : {}),
				...(config.skill !== undefined ? { skill: config.skill } : {}),
				...(config.progress !== undefined ? { progress: config.progress } : {}),
			}));
			const params: Record<string, unknown> = { chain: [{ parallel: tasks }], task: parsed.task, clarify: false, agentScope: "both" };
			if (bg) params.async = true;
			pi.sendUserMessage(`Call the subagent tool with these exact parameters: ${JSON.stringify(params)}`);
		},
	});

	pi.registerShortcut("ctrl+shift+a", {
		handler: async (ctx) => {
			await openAgentManager(ctx);
		},
	});

	pi.events.on("subagent:started", (data) => {
		const info = data as {
			id?: string;
			asyncDir?: string;
			agent?: string;
			chain?: string[];
		};
		if (!info.id) return;
		const asyncDir = info.asyncDir ?? path.join(ASYNC_DIR, info.id);
		const agents = info.chain && info.chain.length > 0 ? info.chain : info.agent ? [info.agent] : undefined;
		const now = Date.now();
		asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir,
			status: "queued",
			mode: info.chain ? "chain" : "single",
			agents,
			stepsTotal: agents?.length,
			startedAt: now,
			updatedAt: now,
		});
		if (lastUiContext) {
			renderWidget(lastUiContext, Array.from(asyncJobs.values()));
			ensurePoller();
		}
	});

	pi.events.on("subagent:complete", (data) => {
		const result = data as { id?: string; success?: boolean; asyncDir?: string };
		const asyncId = result.id;
		if (!asyncId) return;
		const job = asyncJobs.get(asyncId);
		if (job) {
			job.status = result.success ? "complete" : "failed";
			job.updatedAt = Date.now();
			if (result.asyncDir) job.asyncDir = result.asyncDir;
		}
		if (lastUiContext) {
			renderWidget(lastUiContext, Array.from(asyncJobs.values()));
		}
		// Schedule cleanup after 10 seconds (track timer for cleanup on shutdown)
		const timer = setTimeout(() => {
			cleanupTimers.delete(asyncId);
			asyncJobs.delete(asyncId);
			if (lastUiContext) renderWidget(lastUiContext, Array.from(asyncJobs.values()));
		}, 10000);
		cleanupTimers.set(asyncId, timer);
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "subagent") return;
		if (!ctx.hasUI) return;
		lastUiContext = ctx;
		if (asyncJobs.size > 0) {
			renderWidget(ctx, Array.from(asyncJobs.values()));
			ensurePoller();
		}
	});

	const cleanupSessionArtifacts = (ctx: ExtensionContext) => {
		try {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile) {
				cleanupOldArtifacts(getArtifactsDir(sessionFile), DEFAULT_ARTIFACT_CONFIG.cleanupDays);
			}
		} catch {}
	};

	pi.on("session_start", (_event, ctx) => {
		baseCwd = ctx.cwd;
		currentSessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		cleanupSessionArtifacts(ctx);
		for (const timer of cleanupTimers.values()) clearTimeout(timer);
		cleanupTimers.clear();
		asyncJobs.clear();
		resultFileCoalescer.clear();
		if (ctx.hasUI) {
			lastUiContext = ctx;
			renderWidget(ctx, []);
		}
	});
	pi.on("session_switch", (_event, ctx) => {
		baseCwd = ctx.cwd;
		currentSessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		cleanupSessionArtifacts(ctx);
		for (const timer of cleanupTimers.values()) clearTimeout(timer);
		cleanupTimers.clear();
		asyncJobs.clear();
		resultFileCoalescer.clear();
		if (ctx.hasUI) {
			lastUiContext = ctx;
			renderWidget(ctx, []);
		}
	});
	pi.on("session_branch", (_event, ctx) => {
		baseCwd = ctx.cwd;
		currentSessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		cleanupSessionArtifacts(ctx);
		for (const timer of cleanupTimers.values()) clearTimeout(timer);
		cleanupTimers.clear();
		asyncJobs.clear();
		resultFileCoalescer.clear();
		if (ctx.hasUI) {
			lastUiContext = ctx;
			renderWidget(ctx, []);
		}
	});
	pi.on("session_shutdown", () => {
		watcher?.close();
		if (watcherRestartTimer) clearTimeout(watcherRestartTimer);
		watcherRestartTimer = null;
		if (poller) clearInterval(poller);
		poller = null;
		// Clear all pending cleanup timers
		for (const timer of cleanupTimers.values()) {
			clearTimeout(timer);
		}
		cleanupTimers.clear();
		asyncJobs.clear();
		resultFileCoalescer.clear();
		if (lastUiContext?.hasUI) {
			lastUiContext.ui.setWidget(WIDGET_KEY, undefined);
		}
	});
}
