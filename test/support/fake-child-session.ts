/**
 * Scripted in-process child sessions for tests.
 *
 * Foreground runs and the detached async runner create their children through
 * `ChildSessionFactory`. This factory replays the responses `createMockPi()`
 * queues, so one `mockPi.onCall(...)` feeds whichever launch path a test
 * exercises. A scripted `stdoutRaw` is parsed as JSON event lines so older
 * fixtures still replay; there is no stdout transport. `stderr` only names the
 * failure a non-zero `exitCode` raises.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChildSession, ChildSessionEvent, ChildSessionFactory, ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import { isChildWatchdogStatusEvent } from "../../src/watchdog/child-status.ts";

export interface FakeChildResponse {
	output?: string;
	stderr?: string;
	exitCode?: number;
	delay?: number;
	waitForPath?: string;
	keepAliveAfterFinalMessageMs?: number;
	jsonl?: unknown[];
	/** Raw JSON lines; parsed into events for the in-process child without acceptance-report injection. */
	stdoutRaw?: string;
	steps?: Array<{ delay?: number; waitForPath?: string; jsonl?: unknown[]; stdoutRaw?: string }>;
	/** Emits one assistant message with a JSON object of the listed names mapped to null; in-process children have no launch environment. */
	echoEnv?: string[];
	matchArgIncludes?: string | string[];
	/** Files the fake child writes before emitting output, standing in for its write-tool side effects. */
	writeFiles?: Array<{ path: string; content: string }>;
	/** Captures structured output through the runtime config without emitting a structured_output tool event. */
	structuredOutputCapture?: unknown;
	structuredOutputAcceptanceReport?: unknown;
	/** Captures structured output and emits the structured_output tool events. */
	structuredOutput?: unknown;
	runtimeAcknowledgedExtensions?: unknown;
	missingTools?: string[];
	/** Rejects the session creation itself (a startup failure). */
	createError?: string;
	/** Keeps the run open until the parent aborts it. */
	hangUntilAbort?: boolean;
}

export interface FakeChildSessionRecord {
	launch: ChildSessionLaunch;
	task: string | undefined;
	steers: Array<{ text: string; mode: "steer" | "followUp" }>;
	aborted: boolean;
	disposed: boolean;
	settled: boolean;
	session?: ChildSession;
}

export interface FakeChildSessions {
	readonly sessions: FakeChildSessionRecord[];
	readonly factory: ChildSessionFactory;
	readonly disposeCalls: number;
	reset(): void;
}

function listPendingFiles(dir: string): string[] {
	try {
		return fs.readdirSync(dir).filter((name) => name.startsWith("pending-") && name.endsWith(".json")).sort();
	} catch {
		return [];
	}
}

function readJson(filePath: string): FakeChildResponse | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as FakeChildResponse;
	} catch {
		return undefined;
	}
}

function responseMatches(response: FakeChildResponse, haystack: string): boolean {
	const matcher = response.matchArgIncludes;
	if (matcher === undefined) return true;
	const needles = Array.isArray(matcher) ? matcher : [matcher];
	return needles.every((needle) => typeof needle === "string" && haystack.includes(needle));
}

function claimResponse(dir: string, fileName: string): FakeChildResponse | undefined {
	const sourcePath = path.join(dir, fileName);
	const targetPath = path.join(dir, fileName.replace(/^pending-/, "consumed-"));
	try {
		fs.renameSync(sourcePath, targetPath);
		return JSON.parse(fs.readFileSync(targetPath, "utf-8")) as FakeChildResponse;
	} catch {
		return undefined;
	}
}

function claimNextResponse(dir: string, haystack: string): FakeChildResponse {
	for (const withMatcher of [true, false]) {
		for (const fileName of listPendingFiles(dir)) {
			const response = readJson(path.join(dir, fileName));
			if (!response || Object.prototype.hasOwnProperty.call(response, "matchArgIncludes") !== withMatcher) continue;
			if (!responseMatches(response, haystack)) continue;
			const claimed = claimResponse(dir, fileName);
			if (claimed) return claimed;
		}
	}
	const fallback = readJson(path.join(dir, "default-response.json"));
	if (fallback && responseMatches(fallback, haystack)) return fallback;
	return { output: "ok" };
}

/** Synthetic argv in the shape existing call assertions read; a child session receives no argv. */
export function fakeChildArgs(launch: ChildSessionLaunch, task: string): string[] {
	const args: string[] = ["--mode", "json", "-p"];
	if (launch.storage.kind === "file") args.push("--session", launch.storage.sessionFile);
	else if (launch.storage.kind === "dir") args.push("--session-dir", launch.storage.sessionDir);
	else if (launch.storage.kind === "memory") args.push("--no-session");
	if (launch.model) args.push("--model", launch.model);
	if (launch.tools) {
		if (launch.tools.length > 0) args.push("--tools", launch.tools.join(","));
		else args.push("--no-tools");
	} else if (launch.excludeTools?.length) args.push("--exclude-tools", launch.excludeTools.join(","));
	if (!launch.ambientExtensions) args.push("--no-extensions");
	for (const extensionPath of launch.extensionPaths) args.push("--extension", extensionPath);
	if (launch.noContextFiles) args.push("--no-context-files");
	if (launch.noSkills) args.push("--no-skills");
	if (launch.systemPrompt !== undefined) args.push("--system-prompt", launch.systemPrompt);
	if (launch.appendSystemPrompt !== undefined) args.push("--append-system-prompt", launch.appendSystemPrompt);
	args.push(task);
	return args;
}

function defaultAssistantMessage(output: string, model: string | undefined): unknown {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: output }],
			model: model ?? "mock/test-model",
			stopReason: "stop",
			usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
		},
	};
}

function defaultAcceptanceReport(): string {
	return [
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: [
				{ id: "criterion-1", status: "satisfied", evidence: "mock acceptance evidence" },
				{ id: "criterion-2", status: "satisfied", evidence: "mock acceptance evidence" },
			],
			changedFiles: ["mock-file.ts"],
			testsAddedOrUpdated: ["mock-file.test.ts"],
			commandsRun: [{ command: "mock validation", result: "passed", summary: "passed" }],
			validationOutput: ["mock validation passed"],
			residualRisks: [],
			noStagedFiles: true,
			reviewFindings: [],
			manualNotes: "mock run completed",
			notes: "mock run completed",
		}),
		"```",
	].join("\n");
}

function withAcceptanceReport(output: string, prompt: string): string {
	if (!prompt.includes("## Acceptance Contract") || output.includes("```acceptance-report")) return output;
	return `${output}\n${defaultAcceptanceReport()}`;
}

function sleep(ms: number, until?: Promise<void>): Promise<void> {
	const wait = new Promise<void>((resolve) => setTimeout(resolve, ms));
	return until ? Promise.race([wait, until]) : wait;
}

function parseRawStdout(response: FakeChildResponse): unknown[] {
	const chunks: Buffer[] = [];
	if (typeof response.stdoutRaw === "string") chunks.push(Buffer.from(response.stdoutRaw, "utf-8"));
	const entries: unknown[] = [];
	for (const line of Buffer.concat(chunks).toString("utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// Non-JSON stdout is not an event for an in-process child.
		}
	}
	return entries;
}

/** Model id without a `:thinking` suffix, as the child would report it. */
function reportedModel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const colon = model.lastIndexOf(":");
	if (colon === -1) return model;
	const suffix = model.slice(colon + 1);
	return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(suffix) ? model.slice(0, colon) : model;
}

export function createFakeChildSessions(queueDir: () => string): FakeChildSessions {
	const sessions: FakeChildSessionRecord[] = [];
	let disposeCalls = 0;
	const factory: ChildSessionFactory = {
		async create(launch) {
			const record: FakeChildSessionRecord = { launch, task: undefined, steers: [], aborted: false, disposed: false, settled: false };
			sessions.push(record);
			const listeners = new Set<(event: ChildSessionEvent) => void>();
			const messages: AgentMessage[] = [];
			const model = reportedModel(launch.model);
			let abortResolve: (() => void) | undefined;
			const abortedPromise = new Promise<void>((resolve) => { abortResolve = resolve; });
			const sessionId = randomUUID();
			let sessionFile: string | undefined;
			if (launch.storage.kind === "file") {
				sessionFile = launch.storage.sessionFile;
				fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
				fs.writeFileSync(sessionFile, "", { flag: "a" });
			} else if (launch.storage.kind === "dir") {
				// A real session writes its file on the first message; the scripted child leaves the directory empty.
				fs.mkdirSync(launch.storage.sessionDir, { recursive: true });
			}
			/** Steers are also appended to `steers.jsonl` in the queue dir so a test can observe a child hosted in another process. */
			const recordSteer = (text: string, mode: "steer" | "followUp"): void => {
				try {
					fs.appendFileSync(path.join(queueDir(), "steers.jsonl"), `${JSON.stringify({ sessionId, text, mode })}\n`, "utf-8");
				} catch {
					// Observability for tests only.
				}
			};
			const emit = (event: unknown): void => {
				const typed = event as ChildSessionEvent & { message?: AgentMessage };
				if ((typed.type === "message_end" || typed.type === "tool_result_end") && typed.message) messages.push(typed.message);
				for (const listener of [...listeners]) listener(typed);
			};
			let sawProviderError = false;
			const emitEntries = async (entries: unknown[], task: string, injectAcceptance = true): Promise<void> => {
				for (const entry of entries) {
					if (record.aborted) return;
					const typed = entry as { type?: string; message?: { content?: Array<{ type?: string; text?: string }>; errorMessage?: string; stopReason?: string } };
					if (typed?.type === "message_end" && injectAcceptance) {
						const textPart = typed.message?.content?.find?.((part) => part?.type === "text");
						const providerError = Boolean(typed.message?.errorMessage || typed.message?.stopReason === "error");
						if (providerError) sawProviderError = true;
						// Native acceptance lives in system resources, not the compactable task.
						if (!providerError && textPart && typeof textPart.text === "string" && (!sawProviderError || textPart.text.trim())) textPart.text = withAcceptanceReport(textPart.text, [launch.systemPrompt, launch.appendSystemPrompt, task].join("\n"));
					}
					// A real child's watchdog hook reports through the host's sink, not the session stream.
					if (isChildWatchdogStatusEvent(entry)) launch.runtime.watchdogStatus?.(entry);
					else emit(entry);
					await Promise.resolve();
				}
			};
			const waitForReleasePath = async (releasePath: string | undefined): Promise<void> => {
				if (typeof releasePath !== "string") return;
				const deadline = Date.now() + 30_000;
				while (!fs.existsSync(releasePath)) {
					if (record.aborted) return;
					if (Date.now() >= deadline) throw new Error(`Timed out waiting for mock release path: ${releasePath}`);
					await sleep(20, abortedPromise);
				}
			};
			const runScript = async (response: FakeChildResponse, task: string): Promise<void> => {
				if (typeof response.delay === "number" && response.delay > 0) await sleep(response.delay, abortedPromise);
				await waitForReleasePath(response.waitForPath);
				if (record.aborted) return;
				for (const file of response.writeFiles ?? []) {
					if (!file || typeof file.path !== "string" || typeof file.content !== "string") continue;
					const target = path.resolve(launch.cwd, file.path);
					fs.mkdirSync(path.dirname(target), { recursive: true });
					fs.writeFileSync(target, file.content, "utf-8");
				}
				if (Object.prototype.hasOwnProperty.call(response, "structuredOutputCapture")) {
					launch.runtime.structuredOutput?.capture(
						response.structuredOutputCapture,
						Object.prototype.hasOwnProperty.call(response, "structuredOutputAcceptanceReport") ? response.structuredOutputAcceptanceReport : undefined,
					);
				}
				if (Object.prototype.hasOwnProperty.call(response, "runtimeAcknowledgedExtensions")) {
					const raw = response.runtimeAcknowledgedExtensions as { ids?: unknown } | unknown[];
					const ids = Array.isArray(raw) ? raw : Array.isArray(raw?.ids) ? raw.ids : [];
					launch.runtime.runtimeAcknowledgements?.(ids.filter((id): id is string => typeof id === "string"));
				}
				if (Array.isArray(response.missingTools) && response.missingTools.length > 0) {
					const required = launch.runtime.requiredTools ?? [];
					const missing = response.missingTools.filter((name) => required.includes(name));
					if (missing.length > 0) {
						launch.runtime.toolDiagnostic?.({
							...(launch.runtime.agent ? { agent: launch.runtime.agent } : {}),
							required,
							available: required.filter((name) => !missing.includes(name)),
							missing,
						});
					}
				}
				emit({ type: "agent_start" });
				if (Array.isArray(response.steps) && response.steps.length > 0) {
					for (const step of response.steps) {
						if (typeof step?.delay === "number" && step.delay > 0) await sleep(step.delay, abortedPromise);
						await waitForReleasePath(step?.waitForPath);
						if (record.aborted) return;
						if (Array.isArray(step?.jsonl)) await emitEntries(step.jsonl, task);
						await emitEntries(parseRawStdout(step ?? {}), task, false);
					}
				} else if (Array.isArray(response.jsonl) && response.jsonl.length > 0) {
					await emitEntries(response.jsonl, task);
				} else if (response.stdoutRaw !== undefined) {
					await emitEntries(parseRawStdout(response), task, false);
				} else if (Array.isArray(response.echoEnv) && response.echoEnv.length > 0) {
					await emitEntries([defaultAssistantMessage(JSON.stringify(Object.fromEntries(response.echoEnv.map((key) => [key, null]))), model)], task);
				} else if (typeof response.output === "string") {
					await emitEntries([defaultAssistantMessage(response.output, model)], task);
				}
				if (Object.prototype.hasOwnProperty.call(response, "structuredOutput")) {
					launch.runtime.structuredOutput?.capture(response.structuredOutput, undefined);
					emit({ type: "tool_execution_start", toolName: "structured_output", args: { value: response.structuredOutput } });
					emit({ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } });
					emit({ type: "tool_execution_end", toolName: "structured_output" });
				}
				if (record.aborted) return;
				emit({ type: "agent_end", messages: [...messages], willRetry: false });
				emit({ type: "agent_settled" });
				if (typeof response.keepAliveAfterFinalMessageMs === "number" && response.keepAliveAfterFinalMessageMs > 0) {
					await Promise.race([sleep(response.keepAliveAfterFinalMessageMs), abortedPromise]);
				}
				if (response.hangUntilAbort) await abortedPromise;
				if (typeof response.exitCode === "number" && response.exitCode !== 0) {
					throw new Error(response.stderr?.trim() || `mock child exited with code ${response.exitCode}`);
				}
			};
			const session: ChildSession = {
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				async prompt(text) {
					record.task = text;
					const systemPrompt = launch.systemPrompt ?? launch.appendSystemPrompt ?? "";
					const args = fakeChildArgs(launch, text);
					const response = claimNextResponse(queueDir(), `${args.join("\n")}\n${systemPrompt}`);
					const dir = queueDir();
					fs.mkdirSync(dir, { recursive: true });
					const callPath = path.join(dir, `call-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
					fs.writeFileSync(callPath, JSON.stringify({
						args,
						effectiveArgs: args,
						cwd: launch.cwd,
						systemPrompts: launch.systemPrompt !== undefined
							? [{ mode: "--system-prompt", text: launch.systemPrompt }]
							: launch.appendSystemPrompt !== undefined
								? [{ mode: "--append-system-prompt", text: launch.appendSystemPrompt }]
								: [],
						requiredChildTools: launch.runtime.requiredTools ?? [],
						launch: {
							cwd: launch.cwd,
							storage: launch.storage,
							model: launch.model,
							tools: launch.tools,
							excludeTools: launch.excludeTools,
							extensionPaths: launch.extensionPaths,
							ambientExtensions: launch.ambientExtensions,
							hooks: launch.hooks.map((hook) => hook.name),
							noSkills: launch.noSkills,
							noContextFiles: launch.noContextFiles,
							processEnv: launch.processEnv,
						},
						runtime: { ...launch.runtime, structuredOutput: launch.runtime.structuredOutput ? { schema: launch.runtime.structuredOutput.schema, acceptanceReport: launch.runtime.structuredOutput.acceptanceReport } : undefined },
					}), "utf-8");
					if (response.createError) throw new Error(response.createError);
					try {
						await runScript(response, text);
					} finally {
						record.settled = true;
					}
				},
				async steer(text) {
					record.steers.push({ text, mode: "steer" });
					recordSteer(text, "steer");
				},
				async followUp(text) {
					record.steers.push({ text, mode: "followUp" });
					recordSteer(text, "followUp");
				},
				async abort() {
					record.aborted = true;
					abortResolve?.();
				},
				async dispose() {
					record.disposed = true;
				},
				get messages() { return messages; },
				get sessionFile() { return sessionFile; },
				get sessionId() { return sessionId; },
				get modelId() { return model; },
			};
			record.session = session;
			return session;
		},
		async dispose() {
			disposeCalls += 1;
			for (const record of sessions) {
				if (record.session?.detached) continue;
				if (record.session) record.session.shutDown = true;
				await record.session?.abort();
				record.aborted = true;
				record.disposed = true;
			}
		},
	};
	return {
		sessions,
		factory,
		get disposeCalls() { return disposeCalls; },
		reset() { sessions.length = 0; },
	};
}
