/**
 * Core execution logic for running subagents
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig } from "./agents.js";
import {
	appendJsonl,
	ensureArtifactsDir,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "./artifacts.js";
import {
	type AgentProgress,
	type ArtifactPaths,
	type Details,
	type MaxOutputConfig,
	type RunSyncOptions,
	type SingleResult,
	DEFAULT_MAX_OUTPUT,
	truncateOutput,
} from "./types.js";
import {
	writePrompt,
	getFinalOutput,
	findLatestSessionFile,
	detectSubagentError,
	extractToolArgsPreview,
	extractTextFromContent,
} from "./utils.js";

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
	const { cwd, signal, onUpdate, maxOutput, artifactsDir, artifactConfig, runId, index } = options;
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			error: `Unknown agent: ${agentName}`,
		};
	}

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
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools?.length) {
		const builtinTools: string[] = [];
		const extensionPaths: string[] = [];
		for (const tool of agent.tools) {
			if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
				extensionPaths.push(tool);
			} else {
				builtinTools.push(tool);
			}
		}
		if (builtinTools.length > 0) {
			args.push("--tools", builtinTools.join(","));
		}
		for (const extPath of extensionPaths) {
			args.push("--extension", extPath);
		}
	}

	let tmpDir: string | null = null;
	if (agent.systemPrompt?.trim()) {
		const tmp = writePrompt(agent.name, agent.systemPrompt);
		tmpDir = tmp.dir;
		args.push("--append-system-prompt", tmp.path);
	}
	args.push(`Task: ${task}`);

	const result: SingleResult = {
		agent: agentName,
		task,
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	};

	const progress: AgentProgress = {
		index: index ?? 0,
		agent: agentName,
		status: "running",
		task,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
	};
	result.progress = progress;

	const startTime = Date.now();
	const jsonlLines: string[] = [];

	let artifactPathsResult: ArtifactPaths | undefined;
	if (artifactsDir && artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(artifactsDir, runId, agentName, index);
		ensureArtifactsDir(artifactsDir);
		if (artifactConfig?.includeInput !== false) {
			writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${task}`);
		}
	}

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn("pi", args, { cwd: cwd ?? runtimeCwd, stdio: ["ignore", "pipe", "pipe"] });
		let buf = "";

		// Throttled update mechanism - consolidates all updates
		let lastUpdateTime = 0;
		let updatePending = false;
		const UPDATE_THROTTLE_MS = 50; // Reduced from 75ms for faster responsiveness

		const scheduleUpdate = () => {
			if (!onUpdate) return;
			const now = Date.now();
			const elapsed = now - lastUpdateTime;

			if (elapsed >= UPDATE_THROTTLE_MS) {
				// Enough time passed, update immediately
				lastUpdateTime = now;
				updatePending = false;
				progress.durationMs = now - startTime;
				onUpdate({
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
					details: { mode: "single", results: [result], progress: [progress] },
				});
			} else if (!updatePending) {
				// Schedule update for later
				updatePending = true;
				setTimeout(() => {
					if (updatePending) {
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
			jsonlLines.push(line);
			try {
				const evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown };
				const now = Date.now();
				progress.durationMs = now - startTime;

				if (evt.type === "tool_execution_start") {
					progress.toolCount++;
					progress.currentTool = evt.toolName;
					progress.currentToolArgs = extractToolArgsPreview((evt.args || {}) as Record<string, unknown>);
					// Tool start is important - update immediately by forcing throttle reset
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
						if (progress.recentTools.length > 5) {
							progress.recentTools.pop();
						}
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
							const lines = text
								.split("\n")
								.filter((l) => l.trim())
								.slice(-10);
							// Append to existing recentOutput (keep last 50 total)
							progress.recentOutput = [...progress.recentOutput, ...lines].slice(-50);
						}
					}
					scheduleUpdate();
				}
				if (evt.type === "tool_result_end" && evt.message) {
					result.messages.push(evt.message);
					// Also capture tool result text in recentOutput for streaming display
					const toolText = extractTextFromContent(evt.message.content);
					if (toolText) {
						const toolLines = toolText
							.split("\n")
							.filter((l) => l.trim())
							.slice(-10);
						// Append to existing recentOutput (keep last 50 total)
						progress.recentOutput = [...progress.recentOutput, ...toolLines].slice(-50);
					}
					scheduleUpdate();
				}
			} catch {}
		};

		let stderrBuf = "";

		proc.stdout.on("data", (d) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);

			// Also schedule an update on data received (handles streaming output)
			scheduleUpdate();
		});
		proc.stderr.on("data", (d) => {
			stderrBuf += d.toString();
		});
		proc.on("close", (code) => {
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
		if (progress.currentTool) {
			progress.failedTool = progress.currentTool;
		}
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
		if (artifactConfig?.includeJsonl !== false) {
			for (const line of jsonlLines) {
				appendJsonl(artifactPathsResult.jsonlPath, line);
			}
		}
		if (artifactConfig?.includeMetadata !== false) {
			writeMetadata(artifactPathsResult.metadataPath, {
				runId,
				agent: agentName,
				task,
				exitCode: result.exitCode,
				usage: result.usage,
				model: result.model,
				durationMs: progress.durationMs,
				toolCount: progress.toolCount,
				error: result.error,
				timestamp: Date.now(),
			});
		}

		if (maxOutput) {
			const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
			const truncationResult = truncateOutput(fullOutput, config, artifactPathsResult.outputPath);
			if (truncationResult.truncated) {
				result.truncation = truncationResult;
			}
		}
	} else if (maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
		const fullOutput = getFinalOutput(result.messages);
		const truncationResult = truncateOutput(fullOutput, config);
		if (truncationResult.truncated) {
			result.truncation = truncationResult;
		}
	}

	if (shareEnabled && options.sessionDir) {
		const sessionFile = findLatestSessionFile(options.sessionDir);
		if (sessionFile) {
			result.sessionFile = sessionFile;
			// HTML export disabled - module resolution issues with global pi installation
			// Users can still access the session file directly
		}
	}

	return result;
}
