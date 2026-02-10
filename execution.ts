/**
 * Core execution logic for running subagents
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig } from "./agents.js";
import {
	ensureArtifactsDir,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "./artifacts.js";
import {
	type AgentProgress,
	type ArtifactPaths,
	type RunSyncOptions,
	type SingleResult,
	DEFAULT_MAX_OUTPUT,
	truncateOutput,
} from "./types.js";
import {
	writePrompt,
	getFinalOutput,
	findLatestSessionFile,
	extractToolArgsPreview,
	extractTextFromContent,
} from "./utils.js";
import { buildSkillInjection, resolveSkills } from "./skills.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model;
	return `${model}:${thinking}`;
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
	const { cwd, signal, onUpdate, maxOutput, artifactsDir, artifactConfig, runId, index, modelOverride } = options;
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
	const effectiveModel = modelOverride ?? agent.model;
	const modelArg = applyThinkingSuffix(effectiveModel, agent.thinking);
	if (modelArg) args.push("--model", modelArg);
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

	const skillNames = options.skills ?? agent.skills ?? [];
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkills(skillNames, runtimeCwd);

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
	args.push(`Task: ${task}`);

	const result: SingleResult = {
		agent: agentName,
		task,
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		model: modelArg,
		skills: resolvedSkills.length > 0 ? resolvedSkills.map((s) => s.name) : undefined,
		skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
	};

	const progress: AgentProgress = {
		index: index ?? 0,
		agent: agentName,
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

	// Keep memory bounded: only retain what we need for streaming UI + final output + error reporting.
	let finalOutputText = "";
	let lastToolError: { toolName: string; exitCode?: number; details?: string } | null = null;
	const MAX_STORED_MESSAGES = 200;
	const MAX_TAIL_CHARS = 20_000;
	const MAX_STDERR_CHARS = 200_000;

	const pushMessage = (msg: Message) => {
		result.messages.push(msg);
		if (result.messages.length > MAX_STORED_MESSAGES) {
			result.messages.splice(0, result.messages.length - MAX_STORED_MESSAGES);
		}
	};

	const parseExitCode = (text: string | undefined): number | undefined => {
		if (!text) return undefined;
		const m = text.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
		if (!m) return undefined;
		const code = parseInt(m[1], 10);
		return Number.isFinite(code) ? code : undefined;
	};

	// Tail helper that avoids allocating large arrays via `split("\n")`.
	const tailLines = (text: string, maxLines: number, maxChars: number = MAX_TAIL_CHARS): string[] => {
		if (!text) return [];
		let s = text;
		if (s.length > maxChars) s = s.slice(-maxChars);
		const out: string[] = [];
		let end = s.length;
		for (let i = s.length - 1; i >= 0 && out.length < maxLines; i--) {
			if (s.charCodeAt(i) === 10 /* \n */) {
				const seg = s.slice(i + 1, end).trim();
				if (seg) out.push(seg);
				end = i;
			}
		}
		if (out.length < maxLines) {
			const first = s.slice(0, end).trim();
			if (first) out.push(first);
		}
		out.reverse();
		return out.length > maxLines ? out.slice(-maxLines) : out;
	};

	let artifactPathsResult: ArtifactPaths | undefined;
	let jsonlStream: fs.WriteStream | null = null;
	if (artifactsDir && artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(artifactsDir, runId, agentName, index);
		ensureArtifactsDir(artifactsDir);
		if (artifactConfig?.includeInput !== false) {
			writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${task}`);
		}
		if (artifactConfig?.includeJsonl !== false) {
			try {
				jsonlStream = fs.createWriteStream(artifactPathsResult.jsonlPath, { flags: "a" });
			} catch {}
		}
	}

	const spawnEnv = { ...process.env };
	const mcpDirect = agent.mcpDirectTools;
	if (mcpDirect?.length) {
		spawnEnv.MCP_DIRECT_TOOLS = mcpDirect.join(",");
	} else {
		spawnEnv.MCP_DIRECT_TOOLS = "__none__";
	}

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn("pi", args, { cwd: cwd ?? runtimeCwd, env: spawnEnv, stdio: ["ignore", "pipe", "pipe"] });
		let buf = "";

		// Throttled update mechanism - consolidates all updates
		let lastUpdateTime = 0;
		let updatePending = false;
		let pendingTimer: ReturnType<typeof setTimeout> | null = null;
		let processClosed = false;
		let jsonlBackpressure = false;
		const UPDATE_THROTTLE_MS = 50; // Reduced from 75ms for faster responsiveness

		const scheduleUpdate = () => {
			if (!onUpdate || processClosed) return;
			const now = Date.now();
			const elapsed = now - lastUpdateTime;

			if (elapsed >= UPDATE_THROTTLE_MS) {
				// Enough time passed, update immediately
				// Clear any pending timer to avoid double-updates
				if (pendingTimer) {
					clearTimeout(pendingTimer);
					pendingTimer = null;
				}
				lastUpdateTime = now;
				updatePending = false;
				progress.durationMs = now - startTime;
				onUpdate({
					content: [{ type: "text", text: finalOutputText || "(running...)" }],
					details: { mode: "single", results: [result], progress: [progress] },
				});
			} else if (!updatePending) {
				// Schedule update for later
				updatePending = true;
				pendingTimer = setTimeout(() => {
					pendingTimer = null;
					if (updatePending && !processClosed) {
						updatePending = false;
						lastUpdateTime = Date.now();
						progress.durationMs = Date.now() - startTime;
						onUpdate({
							content: [{ type: "text", text: finalOutputText || "(running...)" }],
							details: { mode: "single", results: [result], progress: [progress] },
						});
					}
				}, UPDATE_THROTTLE_MS - elapsed);
			}
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			if (jsonlStream) {
				try {
					const ok = jsonlStream.write(`${line}\n`);
					if (!ok && !jsonlBackpressure) {
						jsonlBackpressure = true;
						proc.stdout.pause();
						jsonlStream.once("drain", () => {
							jsonlBackpressure = false;
							proc.stdout.resume();
						});
					}
				} catch {}
			}
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
					// Only retain assistant messages (tool results are handled separately) to avoid unbounded memory growth.
					if (evt.message.role === "assistant") {
						pushMessage(evt.message);
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
							finalOutputText = text;
							const lines = tailLines(text, 10);
							// Append to existing recentOutput (keep last 50 total) - mutate in place for efficiency
							progress.recentOutput.push(...lines);
							if (progress.recentOutput.length > 50) {
								progress.recentOutput.splice(0, progress.recentOutput.length - 50);
							}
						}
					} else if (evt.message.errorMessage) {
						// Preserve error information even if we don't store the whole message.
						result.error = evt.message.errorMessage;
					}
					scheduleUpdate();
				}
				if (evt.type === "tool_result_end" && evt.message) {
					const msg = evt.message;
					const toolName = ((msg as any).toolName as string | undefined) || evt.toolName || "tool";
					const isError = Boolean((msg as any).isError);

					// Capture a small tail of tool output for streaming display.
					const toolText = extractTextFromContent(msg.content);
					if (toolText) {
						const toolLines = tailLines(toolText, 10);
						progress.recentOutput.push(...toolLines);
						if (progress.recentOutput.length > 50) {
							progress.recentOutput.splice(0, progress.recentOutput.length - 50);
						}
					}

					const exitCode = toolName === "bash" ? parseExitCode(toolText) : undefined;
					if (isError || (toolName === "bash" && exitCode !== undefined && exitCode !== 0)) {
						lastToolError = {
							toolName,
							exitCode: exitCode ?? 1,
							details: toolText ? toolText.slice(0, 200) : undefined,
						};
						pushMessage(msg);
					} else {
						// Any successful tool result after an error clears the error.
						lastToolError = null;
					}

					scheduleUpdate();
				}
			} catch {}
		};

		let stderrBuf = "";

		proc.stdout.on("data", (d) => {
			buf += d.toString();
			let idx = buf.indexOf("\n");
			while (idx !== -1) {
				const line = buf.slice(0, idx);
				buf = buf.slice(idx + 1);
				processLine(line);
				idx = buf.indexOf("\n");
			}

			// Also schedule an update on data received (handles streaming output)
			scheduleUpdate();
		});
		proc.stderr.on("data", (d) => {
			stderrBuf += d.toString();
			if (stderrBuf.length > MAX_STDERR_CHARS) stderrBuf = stderrBuf.slice(-MAX_STDERR_CHARS);
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

	if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	result.exitCode = exitCode;

	if (jsonlStream) {
		try {
			await new Promise<void>((resolve) => jsonlStream.end(() => resolve()));
		} catch {}
	}

	if (exitCode === 0 && !result.error && lastToolError) {
		result.exitCode = lastToolError.exitCode ?? 1;
		result.error = lastToolError.details
			? `${lastToolError.toolName} failed (exit ${result.exitCode}): ${lastToolError.details}`
			: `${lastToolError.toolName} failed with exit code ${result.exitCode}`;
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
		const fullOutput = finalOutputText || getFinalOutput(result.messages);

		if (artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, fullOutput);
		}
		// JSONL event stream (if enabled) is written incrementally during execution to avoid unbounded memory growth.
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
				skills: result.skills,
				skillsWarning: result.skillsWarning,
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
		const fullOutput = finalOutputText || getFinalOutput(result.messages);
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
