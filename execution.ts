/**
 * Core execution logic for running subagents
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig } from "./agents.ts";
import {
	ensureArtifactsDir,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "./artifacts.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type RunSyncOptions,
	type SingleResult,
	type Usage,
	DEFAULT_MAX_OUTPUT,
	truncateOutput,
	getSubagentDepthEnv,
} from "./types.ts";
import {
	writePrompt,
	getFinalOutput,
	findLatestSessionFile,
	detectSubagentError,
	extractToolArgsPreview,
	extractTextFromContent,
} from "./utils.ts";
import { buildSkillInjection, resolveSkills } from "./skills.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import { createJsonlWriter } from "./jsonl-writer.ts";
import {
	executeWithRuntimeModelFallback,
	type ModelAttemptExecutionResult,
} from "./runtime-model-fallback.ts";

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function mergeUsage(results: SingleResult[]): Usage {
	return results.reduce<Usage>((totals, result) => ({
		input: totals.input + result.usage.input,
		output: totals.output + result.usage.output,
		cacheRead: totals.cacheRead + result.usage.cacheRead,
		cacheWrite: totals.cacheWrite + result.usage.cacheWrite,
		cost: totals.cost + result.usage.cost,
		turns: totals.turns + result.usage.turns,
	}), emptyUsage());
}

function emitFallbackUpdate(
	onUpdate: RunSyncOptions["onUpdate"],
	result: SingleResult,
	message: string,
): void {
	if (!onUpdate) return;
	const progress = result.progress;
	if (progress) {
		progress.recentOutput.push(message);
		if (progress.recentOutput.length > 50) {
			progress.recentOutput.splice(0, progress.recentOutput.length - 50);
		}
	}
	onUpdate({
		content: [{ type: "text", text: message }],
		details: { mode: "single", results: [result], progress: progress ? [progress] : undefined },
	});
}

function buildFailureResult(agentName: string, task: string, error: string): SingleResult {
	return {
		agent: agentName,
		task,
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
		error,
	};
}

async function runSyncAttempt(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	options: RunSyncOptions,
	attemptModel?: string,
): Promise<ModelAttemptExecutionResult<SingleResult>> {
	const { cwd, signal, onUpdate, maxOutput, artifactsDir, artifactConfig, runId, index } = options;
	const args = ["--mode", "json", "-p"];
	const shareEnabled = options.share === true;
	const sessionEnabled = Boolean(options.sessionDir) || shareEnabled;
	if (!sessionEnabled) {
		args.push("--no-session");
	}
	if (options.sessionDir) {
		try {
			fs.mkdirSync(options.sessionDir, { recursive: true });
		} catch {}
		args.push("--session-dir", options.sessionDir);
	}
	if (attemptModel) args.push("--models", attemptModel);

	const toolExtensionPaths: string[] = [];
	if (agent.tools?.length) {
		const builtinTools: string[] = [];
		for (const tool of agent.tools) {
			if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
				toolExtensionPaths.push(tool);
			} else {
				builtinTools.push(tool);
			}
		}
		if (builtinTools.length > 0) {
			args.push("--tools", builtinTools.join(","));
		}
	}
	if (agent.extensions !== undefined) {
		args.push("--no-extensions");
		for (const extPath of agent.extensions) {
			args.push("--extension", extPath);
		}
	} else {
		for (const extPath of toolExtensionPaths) {
			args.push("--extension", extPath);
		}
	}

	const skillNames = options.skills ?? agent.skills ?? [];
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkills(skillNames, runtimeCwd);

	// When explicit skills are specified (via options or agent config), disable
	// pi's own skill discovery so the spawned process doesn't inject the full
	// <available_skills> catalog.  This mirrors how extensions are scoped above.
	if (skillNames.length > 0) {
		args.push("--no-skills");
	}

	let systemPrompt = agent.systemPrompt?.trim() || "";
	if (resolvedSkills.length > 0) {
		const skillInjection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${skillInjection}` : skillInjection;
	}

	let tmpDir: string | null = null;
	if (systemPrompt) {
		const tmp = writePrompt(agent.name, systemPrompt);
		tmpDir = tmp.dir;
		args.push("--append-system-prompt", tmp.path);
	}

	const TASK_ARG_LIMIT = 8000;
	if (task.length > TASK_ARG_LIMIT) {
		if (!tmpDir) {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		}
		const taskFilePath = path.join(tmpDir, "task.md");
		fs.writeFileSync(taskFilePath, `Task: ${task}`, { mode: 0o600 });
		args.push(`@${taskFilePath}`);
	} else {
		args.push(`Task: ${task}`);
	}

	const result: SingleResult = {
		agent: agent.name,
		task,
		exitCode: 0,
		messages: [],
		usage: emptyUsage(),
		model: attemptModel,
		skills: resolvedSkills.length > 0 ? resolvedSkills.map((s) => s.name) : undefined,
		skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
	};

	const progress: AgentProgress = {
		index: index ?? 0,
		agent: agent.name,
		status: "running",
		task,
		skills: resolvedSkills.length > 0 ? resolvedSkills.map((s) => s.name) : undefined,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
	};
	result.progress = progress;

	const startTime = Date.now();
	let artifactPathsResult: ArtifactPaths | undefined;
	let jsonlPath: string | undefined;
	if (artifactsDir && artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(artifactsDir, runId, agent.name, index);
		ensureArtifactsDir(artifactsDir);
		if (artifactConfig?.includeInput !== false) {
			writeArtifact(artifactPathsResult.inputPath, `# Task for ${agent.name}\n\n${task}`);
		}
		if (artifactConfig?.includeJsonl !== false) {
			jsonlPath = artifactPathsResult.jsonlPath;
		}
	}

	const spawnEnv = { ...process.env, ...getSubagentDepthEnv() };
	const mcpDirect = agent.mcpDirectTools;
	if (mcpDirect?.length) {
		spawnEnv.MCP_DIRECT_TOOLS = mcpDirect.join(",");
	} else {
		spawnEnv.MCP_DIRECT_TOOLS = "__none__";
	}

	let closeJsonlWriter: (() => Promise<void>) | undefined;
	let stderrBuf = "";
	const exitCode = await new Promise<number>((resolve) => {
		const spawnSpec = getPiSpawnCommand(args);
		const proc = spawn(spawnSpec.command, spawnSpec.args, {
			cwd: cwd ?? runtimeCwd,
			env: spawnEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const jsonlWriter = createJsonlWriter(jsonlPath, proc.stdout);
		closeJsonlWriter = () => jsonlWriter.close();
		let buf = "";

		let lastUpdateTime = 0;
		let updatePending = false;
		let pendingTimer: ReturnType<typeof setTimeout> | null = null;
		let processClosed = false;
		const UPDATE_THROTTLE_MS = 50;

		const scheduleUpdate = () => {
			if (!onUpdate || processClosed) return;
			const now = Date.now();
			const elapsed = now - lastUpdateTime;

			if (elapsed >= UPDATE_THROTTLE_MS) {
				if (pendingTimer) {
					clearTimeout(pendingTimer);
					pendingTimer = null;
				}
				lastUpdateTime = now;
				updatePending = false;
				progress.durationMs = now - startTime;
				onUpdate({
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
					details: { mode: "single", results: [result], progress: [progress] },
				});
			} else if (!updatePending) {
				updatePending = true;
				pendingTimer = setTimeout(() => {
					pendingTimer = null;
					if (updatePending && !processClosed) {
						updatePending = false;
						lastUpdateTime = Date.now();
						progress.durationMs = Date.now() - startTime;
						onUpdate({
							content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
							details: { mode: "single", results: [result], progress: [progress] },
						});
					}
				}, UPDATE_THROTTLE_MS - elapsed);
			}
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			jsonlWriter.writeLine(line);
			try {
				const evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown };
				const now = Date.now();
				progress.durationMs = now - startTime;

				if (evt.type === "tool_execution_start") {
					progress.toolCount++;
					progress.currentTool = evt.toolName;
					progress.currentToolArgs = extractToolArgsPreview((evt.args || {}) as Record<string, unknown>);
					lastUpdateTime = 0;
					scheduleUpdate();
				}

				if (evt.type === "tool_execution_end") {
					if (progress.currentTool) {
						progress.recentTools.unshift({
							tool: progress.currentTool,
							args: progress.currentToolArgs || "",
							endMs: now,
						});
						if (progress.recentTools.length > 5) progress.recentTools.pop();
					}
					progress.currentTool = undefined;
					progress.currentToolArgs = undefined;
					scheduleUpdate();
				}

				if (evt.type === "message_end" && evt.message) {
					result.messages.push(evt.message);
					if (evt.message.role === "assistant") {
						result.usage.turns++;
						const u = evt.message.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							result.usage.cost += u.cost?.total || 0;
							progress.tokens = result.usage.input + result.usage.output;
						}
						if (!result.model && evt.message.model) result.model = evt.message.model;
						if (evt.message.errorMessage) result.error = evt.message.errorMessage;

						const text = extractTextFromContent(evt.message.content);
						if (text) {
							const lines = text.split("\n").filter((l) => l.trim()).slice(-10);
							progress.recentOutput.push(...lines);
							if (progress.recentOutput.length > 50) {
								progress.recentOutput.splice(0, progress.recentOutput.length - 50);
							}
						}
					}
					scheduleUpdate();
				}
				if (evt.type === "tool_result_end" && evt.message) {
					result.messages.push(evt.message);
					const toolText = extractTextFromContent(evt.message.content);
					if (toolText) {
						const toolLines = toolText.split("\n").filter((l) => l.trim()).slice(-10);
						progress.recentOutput.push(...toolLines);
						if (progress.recentOutput.length > 50) {
							progress.recentOutput.splice(0, progress.recentOutput.length - 50);
						}
					}
					scheduleUpdate();
				}
			} catch {}
		};

		proc.stdout.on("data", (d) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);
			scheduleUpdate();
		});
		proc.stderr.on("data", (d) => {
			stderrBuf += d.toString();
		});
		proc.on("close", (code) => {
			processClosed = true;
			if (pendingTimer) {
				clearTimeout(pendingTimer);
				pendingTimer = null;
			}
			if (buf.trim()) processLine(buf);
			if (code !== 0 && stderrBuf.trim() && !result.error) {
				result.error = stderrBuf.trim();
			}
			resolve(code ?? 0);
		});
		proc.on("error", () => resolve(1));

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});

	if (closeJsonlWriter) {
		try {
			await closeJsonlWriter();
		} catch {}
	}

	if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	result.exitCode = exitCode;

	if (exitCode === 0 && !result.error) {
		const errInfo = detectSubagentError(result.messages);
		if (errInfo.hasError) {
			result.exitCode = errInfo.exitCode ?? 1;
			result.error = errInfo.details
				? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
				: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
		}
	}

	progress.status = result.exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
	if (result.error) {
		progress.error = result.error;
		if (progress.currentTool) progress.failedTool = progress.currentTool;
	}

	result.progress = progress;
	result.progressSummary = {
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
	};

	if (artifactPathsResult && artifactConfig?.enabled !== false) {
		result.artifactPaths = artifactPathsResult;
		const fullOutput = getFinalOutput(result.messages);
		if (artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, fullOutput);
		}
		if (artifactConfig?.includeMetadata !== false) {
			writeMetadata(artifactPathsResult.metadataPath, {
				runId,
				agent: agent.name,
				task,
				exitCode: result.exitCode,
				usage: result.usage,
				model: result.model,
				durationMs: progress.durationMs,
				toolCount: progress.toolCount,
				error: result.error,
				skills: result.skills,
				skillsWarning: result.skillsWarning,
				timestamp: Date.now(),
			});
		}

		if (maxOutput) {
			const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
			const truncationResult = truncateOutput(getFinalOutput(result.messages), config, artifactPathsResult.outputPath);
			if (truncationResult.truncated) result.truncation = truncationResult;
		}
	} else if (maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
		const truncationResult = truncateOutput(getFinalOutput(result.messages), config);
		if (truncationResult.truncated) result.truncation = truncationResult;
	}

	if (shareEnabled && options.sessionDir) {
		const sessionFile = findLatestSessionFile(options.sessionDir);
		if (sessionFile) result.sessionFile = sessionFile;
	}

	return {
		ok: result.exitCode === 0,
		result,
		exitCode: result.exitCode,
		error: result.error,
		stderr: stderrBuf.trim() || undefined,
		output: getFinalOutput(result.messages),
	};
}

/**
 * Run a subagent synchronously (blocking until complete)
 */
export async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) return buildFailureResult(agentName, task, `Unknown agent: ${agentName}`);

	const attemptResults: SingleResult[] = [];
	const execution = await executeWithRuntimeModelFallback<SingleResult>({
		context: options.runtimeModelContext,
		modelOverride: options.modelOverride,
		agentModel: agent.model,
		agentThinking: agent.thinking,
		makeFailureResult: (message) => buildFailureResult(agent.name, task, message),
		executeAttempt: async (candidate) => {
			const attempt = await runSyncAttempt(runtimeCwd, agent, task, options, candidate?.normalizedModel ?? candidate?.model);
			attemptResults.push(attempt.result);
			return attempt;
		},
		onAttemptEvent: (event) => {
			const latestResult = attemptResults.at(-1);
			if (!latestResult) return;
			if (event.type === "retry") {
				const nextModel = event.nextCandidate?.model ?? "next candidate";
				emitFallbackUpdate(options.onUpdate, latestResult, `fallback: ${event.attempt.classification} (${event.attempt.reason}), trying ${nextModel}`);
			} else if (event.type === "skipped") {
				emitFallbackUpdate(options.onUpdate, latestResult, `fallback: skipped ${event.candidate.model} (${event.attempt.cooldownScope} cooldown)`);
			} else if (event.type === "stop") {
				emitFallbackUpdate(options.onUpdate, latestResult, `fallback: stopped on ${event.candidate.model} (${event.attempt.classification})`);
			} else if (event.type === "exhausted") {
				emitFallbackUpdate(options.onUpdate, latestResult, `fallback: exhausted ${event.attempts.length} candidates`);
			}
		},
	});

	const finalResult = execution.result;
	finalResult.usage = mergeUsage(attemptResults);
	finalResult.requestedModel = execution.requestedModel;
	finalResult.finalModel = finalResult.model ?? execution.finalModel;
	finalResult.modelAttempts = execution.modelAttempts;
	finalResult.fallbackSummary = execution.fallbackSummary;
	if (finalResult.progressSummary) {
		finalResult.progressSummary.durationMs = attemptResults.reduce(
			(total, result) => total + (result.progressSummary?.durationMs ?? 0),
			0,
		);
		finalResult.progressSummary.toolCount = attemptResults.reduce(
			(total, result) => total + (result.progressSummary?.toolCount ?? 0),
			0,
		);
		finalResult.progressSummary.tokens = attemptResults.reduce(
			(total, result) => total + (result.progressSummary?.tokens ?? 0),
			0,
		);
	}
	if (finalResult.progress) {
		finalResult.progress.durationMs = attemptResults.reduce(
			(total, result) => total + (result.progress?.durationMs ?? 0),
			0,
		);
		finalResult.progress.toolCount = attemptResults.reduce(
			(total, result) => total + (result.progress?.toolCount ?? 0),
			0,
		);
		finalResult.progress.tokens = finalResult.usage.input + finalResult.usage.output;
		finalResult.progress.status = finalResult.exitCode === 0 ? "completed" : "failed";
		if (finalResult.fallbackSummary) {
			finalResult.progress.recentOutput.push(finalResult.fallbackSummary);
			if (finalResult.progress.recentOutput.length > 50) {
				finalResult.progress.recentOutput.splice(0, finalResult.progress.recentOutput.length - 50);
			}
		}
	}
	return finalResult;
}
