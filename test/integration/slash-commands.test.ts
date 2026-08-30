import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { registerAgent } from "../../src/api/agents.ts";
import { clearRuntimeAgentsForPi } from "../../src/agents/runtime-agent-registry.ts";
import { scheduledRunStorePath } from "../../src/runs/background/scheduled-runs.ts";
import { updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";
import { getArtifactPaths, getArtifactsDir } from "../../src/shared/artifacts.ts";
import { ASYNC_DIR, DIRS } from "../../src/shared/types.ts";
import type { WatchdogReviewFunction } from "../../src/watchdog/runtime.ts";

const SLASH_RESULT_TYPE = "subagent-slash-result";
const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";

interface EventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

interface RuntimeSlashPi {
	events: EventBus;
	on(event: string, handler: (data: unknown) => void): () => void;
	registerTool(tool: unknown): void;
	registerCommand(name: string, spec: RegisteredSlashCommand): void;
	registerShortcut(key: string, spec: { handler(ctx: unknown): Promise<void> }): void;
	sendMessage(message: unknown): void;
}

type RegisteredSlashCommand = { handler(args: string, ctx: unknown): Promise<void>; getArgumentCompletions?: (prefix: string) => unknown };

interface RegisterSlashCommandsModule {
	registerSlashCommands?: (
		pi: {
			events: EventBus;
			registerCommand(
				name: string,
				spec: RegisteredSlashCommand,
			): void;
			registerShortcut(key: string, spec: { handler(ctx: unknown): Promise<void> }): void;
			sendMessage(message: unknown): void;
			setModel?(model: unknown): Promise<boolean>;
		},
		state: {
			baseCwd: string;
			currentSessionId: string | null;
			asyncJobs: Map<string, unknown>;
			cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
			lastUiContext: unknown;
			poller: NodeJS.Timeout | null;
			completionSeen: Map<string, number>;
			watcher: unknown;
			watcherRestartTimer: ReturnType<typeof setTimeout> | null;
			resultFileCoalescer: { schedule(file: string, delayMs?: number): boolean; clear(): void };
		},
		options?: { foregroundDetachShortcut?: string },
	) => { dispose(): void };
}

interface SlashLiveStateModule {
	clearSlashSnapshots?: typeof import("../../src/slash/slash-live-state.ts").clearSlashSnapshots;
	getSlashRenderableSnapshot?: typeof import("../../src/slash/slash-live-state.ts").getSlashRenderableSnapshot;
	resolveSlashMessageDetails?: typeof import("../../src/slash/slash-live-state.ts").resolveSlashMessageDetails;
}

interface WatchdogRegisterModule {
	registerMainWatchdog?: typeof import("../../src/watchdog/register-main.ts").registerMainWatchdog;
}

let registerSlashCommands: RegisterSlashCommandsModule["registerSlashCommands"];
let registerMainWatchdog: WatchdogRegisterModule["registerMainWatchdog"];
let clearSlashSnapshots: SlashLiveStateModule["clearSlashSnapshots"];
let getSlashRenderableSnapshot: SlashLiveStateModule["getSlashRenderableSnapshot"];
let resolveSlashMessageDetails: SlashLiveStateModule["resolveSlashMessageDetails"];
let available = true;
try {
	({ registerSlashCommands } = await import("../../src/slash/slash-commands.ts") as RegisterSlashCommandsModule);
	({ registerMainWatchdog } = await import("../../src/watchdog/register-main.ts") as WatchdogRegisterModule);
	({ clearSlashSnapshots, getSlashRenderableSnapshot, resolveSlashMessageDetails } = await import("../../src/slash/slash-live-state.ts") as SlashLiveStateModule);
} catch {
	available = false;
}

function createEventBus(): EventBus {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	return {
		on(event, handler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
			return () => {
				const current = handlers.get(event) ?? [];
				handlers.set(event, current.filter((entry) => entry !== handler));
			};
		},
		emit(event, data) {
			for (const handler of handlers.get(event) ?? []) {
				handler(data);
			}
		},
	};
}

function createState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slash-home-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		return await fn();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		fs.rmSync(home, { recursive: true, force: true });
	}
}


function createCommandContext(
	overrides: Partial<{
		cwd: string;
		hasUI: boolean;
		custom: (...args: unknown[]) => Promise<unknown>;
		notify: (message: string, type?: string) => void;
		confirm: (title: string, message: string) => Promise<boolean>;
		select: (title: string, choices: string[]) => Promise<string | undefined>;
		editor: (title: string, prefill: string) => Promise<string | undefined>;
		setStatus: (key: string, text: string | undefined) => void;
		setToolsExpanded: (expanded: boolean) => void;
		sessionManager: unknown;
		modelRegistry: {
			refresh?: () => void;
			getAvailable: () => Array<{ provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }>;
			find?: (provider: string, id: string) => unknown;
			hasConfiguredAuth?: (model: unknown) => boolean;
		};
		model: { provider: string; id: string };
		thinkingLevel: string;
	}> = {},
) {
	return {
		cwd: overrides.cwd ?? process.cwd(),
		hasUI: overrides.hasUI ?? false,
		ui: {
			notify: overrides.notify ?? ((_message: string) => {}),
			confirm: overrides.confirm ?? (async () => false),
			select: overrides.select ?? (async () => undefined),
			editor: overrides.editor ?? (async () => undefined),
			setStatus: overrides.setStatus ?? ((_key: string, _text: string | undefined) => {}),
			setToolsExpanded: overrides.setToolsExpanded ?? ((_expanded: boolean) => {}),
			onTerminalInput: () => () => {},
			...(overrides.custom ? { custom: overrides.custom } : {}),
		},
		model: overrides.model,
		thinkingLevel: overrides.thinkingLevel,
		modelRegistry: overrides.modelRegistry ?? { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true },
		sessionManager: overrides.sessionManager ?? {
			getSessionFile: () => null,
			getSessionId: () => "session-test",
		},
	};
}

async function withTempProject<T>(prefix: string, fn: (root: string) => Promise<T>): Promise<T> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
	fs.mkdirSync(path.join(root, ".pi", "chains"), { recursive: true });
	try {
		return await fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function writeProjectChain(root: string, fileName: string, content: string): void {
	fs.writeFileSync(path.join(root, ".pi", "chains", fileName), content, "utf-8");
}

function createWatchdogHarness(review?: WatchdogReviewFunction) {
	const commands = new Map<string, RegisteredSlashCommand>();
	const renderers = new Map<string, (message: { content: string; details?: unknown }, options: { expanded: boolean }, theme: { fg(name: string, value: string): string; bold(value: string): string }) => { render(width: number): string[] } | undefined>();
	const sent: unknown[] = [];
	const pi = {
		events: createEventBus(),
		on() {},
		registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
		registerShortcut() {},
		registerMessageRenderer(type: string, renderer: (message: { content: string; details?: unknown }, options: { expanded: boolean }, theme: { fg(name: string, value: string): string; bold(value: string): string }) => { render(width: number): string[] } | undefined) {
			renderers.set(type, renderer);
		},
		getThinkingLevel() { return "medium" as const; },
		sendMessage(message: unknown) { sent.push(message); },
	};
	const runtime = registerMainWatchdog!(pi as never, review ? { review } : undefined);
	return { commands, renderers, runtime, sent };
}

async function captureSlashCommandParams(
	commandName: string,
	args: string,
	cwd: string,
	setup?: (pi: RuntimeSlashPi) => void,
): Promise<{ params: unknown; notifications: string[] }> {
	return withIsolatedHome(async () => {
		const commands = new Map<string, RegisteredSlashCommand>();
		const events = createEventBus();
		let requestedParams: unknown;
		const notifications: string[] = [];
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown };
			requestedParams = payload.params;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: `${commandName} finished` }],
					details: { mode: "chain", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			on() { return () => {}; },
			registerTool() {},
			registerCommand(name: string, spec: RegisteredSlashCommand) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(_message: unknown) {},
		};

		try {
			setup?.(pi);
			registerSlashCommands!(pi, createState(cwd));
			await commands.get(commandName)!.handler(args, createCommandContext({
				cwd,
				notify: (message) => {
					notifications.push(message);
				},
			}));
			return { params: requestedParams, notifications };
		} finally {
			clearRuntimeAgentsForPi(pi as never);
		}
	});
}

describe("subagents watchdog slash command", { skip: !available ? "watchdog command not importable" : undefined }, () => {
	it("shows default-off status with runtime state, sources, and review seam", async () => {
		await withIsolatedHome(async () => {
			await withTempProject("pi-watchdog-status-", async (root) => {
				const { commands, sent } = createWatchdogHarness();
				await commands.get("subagents-watchdog")!.handler("", createCommandContext({ cwd: root }));

				const content = String((sent[0] as { content?: unknown }).content ?? "");
				assert.match(content, /Subagent watchdog/);
				assert.match(content, /Main: off \(default off\)/);
				assert.match(content, /Runtime: idle/);
				assert.match(content, /Review model call: real model review/);
				assert.match(content, /Sources:/);
			});
		});
	});

	it("recommends and saves a strong complementary watchdog model", async () => {
		await withIsolatedHome(async () => {
			await withTempProject("pi-watchdog-model-", async (root) => {
				const gpt = { provider: "openai-codex", id: "gpt-5.5", reasoning: true };
				const opus = { provider: "anthropic", id: "claude-opus-4-8", reasoning: true };
				const models = [gpt, opus];
				const modelRegistry = {
					getAvailable: () => models,
					find: (provider: string, id: string) => models.find((entry) => entry.provider === provider && entry.id === id),
					hasConfiguredAuth: (model: unknown) => Boolean(model),
				};
				const ctx = createCommandContext({ cwd: root, model: gpt, modelRegistry });
				const { commands, sent } = createWatchdogHarness();

				await commands.get("subagents-watchdog")!.handler("recommend-model", ctx);
				await commands.get("subagents-watchdog")!.handler("model recommended", ctx);

				const recommendation = String((sent[0] as { content?: unknown }).content ?? "");
				assert.match(recommendation, /Recommended: anthropic\/claude-opus-4-8:high/);
				const settingsPath = path.join(process.env.HOME!, ".pi", "agent", "settings.json");
				const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
				assert.equal(settings.subagents.watchdog.main.model, "anthropic/claude-opus-4-8");
				assert.equal(settings.subagents.watchdog.main.thinking, "high");
				assert.equal(settings.subagents.watchdog.enabled, undefined);
				assert.match(String((sent[1] as { content?: unknown }).content ?? ""), /Run \/subagents-watchdog on if the watchdog is still off/);
			});
		});
	});

	it("supports session-scoped recommended watchdog models without writing settings", async () => {
		await withIsolatedHome(async () => {
			await withTempProject("pi-watchdog-session-model-", async (root) => {
				const opus = { provider: "anthropic", id: "claude-opus-4-8", reasoning: true };
				const gpt = { provider: "openai-codex", id: "gpt-5.5", reasoning: true };
				const models = [opus, gpt];
				const modelRegistry = {
					getAvailable: () => models,
					find: (provider: string, id: string) => models.find((entry) => entry.provider === provider && entry.id === id),
					hasConfiguredAuth: (model: unknown) => Boolean(model),
				};
				const { commands, sent } = createWatchdogHarness();

				await commands.get("subagents-watchdog")!.handler("session model recommended", createCommandContext({ cwd: root, model: opus, modelRegistry }));

				assert.equal(fs.existsSync(path.join(process.env.HOME!, ".pi", "agent", "settings.json")), false);
				const content = String((sent[0] as { content?: unknown }).content ?? "");
				assert.match(content, /session model: openai-codex\/gpt-5\.5:high/);
				assert.match(content, /Main model: openai-codex\/gpt-5\.5 \(session override\)/);
				assert.match(content, /Main thinking: high/);
			});
		});
	});

	it("shows explicit watchdog model thinking accurately when no thinking is configured", async () => {
		await withIsolatedHome(async () => {
			await withTempProject("pi-watchdog-status-model-", async (root) => {
				const settingsPath = path.join(process.env.HOME!, ".pi", "agent", "settings.json");
				fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
				fs.writeFileSync(settingsPath, JSON.stringify({ subagents: { watchdog: { enabled: true, main: { model: "openai-codex/gpt-5.5" } } } }, null, 2), "utf-8");
				const gpt = { provider: "openai-codex", id: "gpt-5.5", reasoning: true };
				const opus = { provider: "anthropic", id: "claude-opus-4-8", reasoning: true };
				const models = [gpt, opus];
				const modelRegistry = {
					getAvailable: () => models,
					find: (provider: string, id: string) => models.find((entry) => entry.provider === provider && entry.id === id),
					hasConfiguredAuth: (model: unknown) => Boolean(model),
				};
				const { commands, sent } = createWatchdogHarness();

				await commands.get("subagents-watchdog")!.handler("status", createCommandContext({ cwd: root, model: gpt, modelRegistry }));

				const content = String((sent[0] as { content?: unknown }).content ?? "");
				assert.match(content, /Main model: openai-codex\/gpt-5\.5 \(configured\)/);
				assert.match(content, /Main thinking: off \(default for explicit watchdog model\)/);
			});
		});
	});

	it("writes only user watchdog enabled settings and preserves existing settings", async () => {
		await withIsolatedHome(async () => {
			await withTempProject("pi-watchdog-toggle-", async (root) => {
				const settingsPath = path.join(process.env.HOME!, ".pi", "agent", "settings.json");
				const projectSettingsPath = path.join(root, ".pi", "settings.json");
				fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
				fs.writeFileSync(settingsPath, JSON.stringify({
					other: true,
					subagents: {
						agentOverrides: { scout: { model: "openai/test" } },
						watchdog: { agentEndTimeoutMs: 1234, main: { enabled: false, model: "openai/watchdog" } },
					},
				}, null, 2), "utf-8");
				fs.writeFileSync(projectSettingsPath, JSON.stringify({ subagents: { defaultModel: "anthropic/project" } }, null, 2), "utf-8");
				const projectBefore = fs.readFileSync(projectSettingsPath, "utf-8");
				const { commands, sent } = createWatchdogHarness();

				await commands.get("subagents-watchdog")!.handler("on", createCommandContext({ cwd: root }));
				let settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
				assert.equal(settings.other, true);
				assert.equal(settings.subagents.agentOverrides.scout.model, "openai/test");
				assert.equal(settings.subagents.watchdog.agentEndTimeoutMs, 1234);
				assert.equal(settings.subagents.watchdog.enabled, true);
				assert.equal(settings.subagents.watchdog.main.enabled, true);
				assert.equal(settings.subagents.watchdog.main.model, "openai/watchdog");
				assert.equal(fs.readFileSync(projectSettingsPath, "utf-8"), projectBefore);

				await commands.get("subagents-watchdog")!.handler("off", createCommandContext({ cwd: root }));
				settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
				assert.equal(settings.subagents.watchdog.enabled, false);
				assert.equal(settings.subagents.watchdog.main.enabled, false);
				assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /saved to user settings/);
			});
		});
	});

	it("uses session on/off overrides without writing settings files", async () => {
		await withIsolatedHome(async () => {
			await withTempProject("pi-watchdog-session-", async (root) => {
				const settingsPath = path.join(process.env.HOME!, ".pi", "agent", "settings.json");
				const projectSettingsPath = path.join(root, ".pi", "settings.json");
				const { commands, sent } = createWatchdogHarness();

				await commands.get("subagents-watchdog")!.handler("session on", createCommandContext({ cwd: root }));
				await commands.get("subagents-watchdog")!.handler("session off", createCommandContext({ cwd: root }));

				assert.equal(fs.existsSync(settingsPath), false);
				assert.equal(fs.existsSync(projectSettingsPath), false);
				assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /session override: on/i);
				assert.match(String((sent[1] as { content?: unknown }).content ?? ""), /session override: off/i);
			});
		});
	});

	it("sends deterministic concern and blocker warning messages through the renderer path", async () => {
		await withIsolatedHome(async () => {
			const { commands, renderers, sent } = createWatchdogHarness();
			await commands.get("subagents-watchdog")!.handler("test concern check the concern", createCommandContext());
			await commands.get("subagents-watchdog")!.handler("test blocker check the blocker", createCommandContext());

			const concern = sent[0] as { customType?: string; content?: string; display?: boolean; details?: Record<string, unknown> };
			const blocker = sent[1] as { customType?: string; content?: string; display?: boolean; details?: Record<string, unknown> };
			assert.equal(concern.customType, "subagent_watchdog_warning");
			assert.equal(concern.display, true);
			assert.equal(concern.details?.severity, "concern");
			assert.equal(concern.details?.source, "main");
			assert.equal(concern.details?.state, "displayed");
			assert.match(concern.content ?? "", /source="main"/);
			assert.match(concern.content ?? "", /<state>displayed<\/state>/);
			assert.match(concern.content ?? "", /<recommended_action>/);
			assert.equal(blocker.details?.severity, "blocker");
			assert.match(blocker.content ?? "", /<blocker_guidance>/);

			const renderer = renderers.get("subagent_watchdog_warning")!;
			const rendered = renderer(blocker as never, { expanded: true }, { fg: (_name, value) => value, bold: (value) => value })!.render(100).join("\n");
			assert.match(rendered, /Subagent watchdog Blocker \(displayed\): check the blocker/);
			assert.match(rendered, /Manual \/subagents-watchdog test blocker message/);
		});
	});

	it("sends accepted review warnings as visible custom watchdog messages", async () => {
		await withIsolatedHome(async () => {
			await withTempProject("pi-watchdog-review-warning-", async (root) => {
				const review: WatchdogReviewFunction = (request) => {
					assert.equal(request.emitWarning({
						severity: "concern",
						category: "test-gap",
						confidence: "high",
						source: "main",
						summary: "Focused validation is missing",
						evidence: "The reviewed turn delta says changes were made but contains no test command.",
						recommendedAction: "Run the focused watchdog tests before accepting the turn.",
					}), true);
					return { stopReason: "stop" };
				};
				const { runtime, sent } = createWatchdogHarness(review);

				runtime.setSessionEnabled(true, root);
				runtime.handleBeforeAgentStart({ prompt: "Patch watchdog runtime." }, { cwd: root });
				runtime.handleTurnEnd({
					type: "turn_end",
					message: { role: "assistant", content: "Changed watchdog runtime without running tests." },
					toolResults: [{ role: "toolResult", toolName: "edit", content: "Edited src/watchdog/runtime.ts", isError: false }],
				}, { cwd: root });
				await runtime.handleAgentEnd({ type: "agent_end", messages: [] }, { cwd: root });

				const message = sent[0] as { customType?: string; content?: string; display?: boolean; details?: Record<string, unknown> };
				assert.equal(message.customType, "subagent_watchdog_warning");
				assert.equal(message.display, true);
				assert.equal(message.details?.state, "displayed");
				assert.equal(message.details?.summary, "Focused validation is missing");
				assert.match(message.content ?? "", /<subagent_watchdog/);
				assert.match(message.content ?? "", /<recommended_action>/);
			});
		});
	});
});

describe("slash command custom message delivery", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("/subagent-cost recovers async workflow usage from receipts and metadata", async () => {
		await withTempProject("pi-subagent-cost-async-", async (root) => {
			const workflowRunId = `workflow-cost-${process.pid}-${Date.now()}`;
			const earlierChildRunId = `child-cost-earlier-${process.pid}-${Date.now()}`;
			const childRunId = `child-cost-${process.pid}-${Date.now()}`;
			const asyncDir = path.join(DIRS.async, workflowRunId);
			const sessionFile = path.join(root, "sessions", "parent.jsonl");
			const artifactsDir = getArtifactsDir(sessionFile, root, "session");
			const earlierMetadataPath = getArtifactPaths(artifactsDir, earlierChildRunId, "reviewer", 0).metadataPath;
			const metadataPath = getArtifactPaths(artifactsDir, childRunId, "reviewer", 0).metadataPath;
			fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
			fs.writeFileSync(sessionFile, "", "utf-8");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.mkdirSync(path.dirname(earlierMetadataPath), { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "workflow-receipt.json"), JSON.stringify({
				version: 1,
				workflowRunId,
				state: "complete",
				createdAt: Date.now(),
				entries: {
					review: {
						key: "review",
						agent: "reviewer",
						latestRunId: childRunId,
						continuation: { runIds: [earlierChildRunId, childRunId] },
						resumability: { state: "resumable" },
					},
				},
				workflowChildren: {
					version: 1,
					parentToolCallId: "tool-1",
					workflowRunId,
					inventoryComplete: true,
					workflowState: "completed",
					children: [{ childId: "review", state: "completed", runId: childRunId, agent: "reviewer" }],
				},
			}, null, 2), "utf-8");
			fs.writeFileSync(earlierMetadataPath, JSON.stringify({
				runId: earlierChildRunId,
				agent: "reviewer",
				usage: { input: 8, output: 3, cacheRead: 5, cacheWrite: 0, cost: 0.25, turns: 1 },
			}, null, 2), "utf-8");
			fs.writeFileSync(metadataPath, JSON.stringify({
				runId: childRunId,
				agent: "reviewer",
				usage: { input: 20, output: 4, cacheRead: 80, cacheWrite: 0, cost: 0.5, turns: 2 },
			}, null, 2), "utf-8");

			const sent: unknown[] = [];
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
				registerShortcut() {},
				sendMessage(message: unknown) { sent.push(message); },
			};
			const branch = [
				{ type: "message", message: { role: "assistant", usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 0, cost: { total: 0.2 } } } },
				{ type: "compaction", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } } },
				{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { mode: "workflow", runId: workflowRunId, results: [] } } },
			];
			try {
				registerSlashCommands!(pi as never, createState(root));
				await commands.get("subagent-cost")!.handler("", createCommandContext({
					cwd: root,
					sessionManager: {
						getBranch: () => branch,
						getSessionFile: () => sessionFile,
						getSessionId: () => "session-parent",
					},
				}));
				const report = String((sent[0] as { content?: unknown }).content ?? "");
				assert.match(report, /Parent: ↑15 ↓3 \$0\.2500/);
				assert.match(report, /Child 1 \(reviewer\): ↑8 ↓3 \$0\.2500 \(cache read 5, 1 turn\)/);
				assert.match(report, /Child 2 \(reviewer\): ↑20 ↓4 \$0\.5000 \(cache read 80, 2 turns\)/);
				assert.equal((report.match(/Child \d+ \(reviewer\):/g) ?? []).length, 2);
				assert.match(report, /Children: ↑28 ↓7 \$0\.7500 \(cache read 85, 3 turns\)/);
				assert.match(report, /Total: ↑43 ↓10 \$1\.0000 \(cache read 115, 4 turns\)/);
				assert.doesNotMatch(report, /No subagent child usage/);
			} finally {
				fs.rmSync(asyncDir, { recursive: true, force: true });
			}
		});
	});

	it("registers a configured foreground detach shortcut", async () => {
		const shortcuts = new Map<string, { handler(ctx: unknown): Promise<void> }>();
		const sent: unknown[] = [];
		const state = createState(process.cwd());
		let detachCalls = 0;
		state.foregroundControls.set("run-123", {
			runId: "run-123",
			mode: "single",
			updatedAt: Date.now(),
			detach: () => {
				detachCalls += 1;
				return true;
			},
		});
		state.lastForegroundControlId = "run-123";

		registerSlashCommands!({
			events: createEventBus(),
			registerCommand() {},
			registerShortcut(key: string, spec: { handler(ctx: unknown): Promise<void> }) {
				shortcuts.set(key, spec);
			},
			sendMessage(message: unknown) { sent.push(message); },
		}, state, { foregroundDetachShortcut: "ctrl+b" });

		assert.ok(shortcuts.has("ctrl+b"));
		await shortcuts.get("ctrl+b")!.handler(createCommandContext());
		assert.equal(detachCalls, 1);
		assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /Detached foreground run run-123/);
	});

	it("does not reserve a foreground detach shortcut by default", () => {
		const shortcuts = new Map<string, unknown>();
		registerSlashCommands!({
			events: createEventBus(),
			registerCommand() {},
			registerShortcut(key: string, spec: unknown) { shortcuts.set(key, spec); },
			sendMessage() {},
		}, createState(process.cwd()));
		assert.equal(shortcuts.has("ctrl+b"), false);
	});

	it("/subagents-stop keeps the selector within its allocated width", async () => {
		await withTempProject("pi-stop-selector-width-", async (root) => {
			const id = "scheduled-width-check";
			const nextRunAt = "2099-01-01T00:00:00.000Z";
			const scheduleDir = path.join(scheduledRunStorePath(root), id);
			fs.mkdirSync(scheduleDir, { recursive: true });
			fs.writeFileSync(path.join(scheduleDir, "schedule.json"), JSON.stringify({
				schemaVersion: 1,
				id,
				name: "A very long scheduled run name with wide characters 中文🙂",
				cwd: root,
				trigger: { kind: "once", at: nextRunAt, nextRunAt },
				target: { agent: "scout", task: "Inspect" },
				overlap: "skip",
				catchUp: "latest",
				paused: false,
				createdAt: "2026-08-06T00:00:00.000Z",
				updatedAt: "2026-08-06T00:00:00.000Z",
			}), "utf-8");

			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
				registerShortcut() {},
				sendMessage() {},
			};
			const rendered = new Map<number, string[]>();
			registerSlashCommands!(pi as never, createState(root));
			await commands.get("subagents-stop")!.handler("", createCommandContext({
				cwd: root,
				hasUI: true,
				custom: async (factory) => {
					const component = (factory as (
						tui: { requestRender(): void },
						theme: { fg(name: string, text: string): string; bold(text: string): string },
						keybindings: unknown,
						done: (result: unknown) => void,
					) => { render(width: number): string[] })(
						{ requestRender() {} },
						{ fg: (_name, text) => text, bold: (text) => text },
						{},
						() => {},
					);
					for (const width of [0, 1, 2, 3, 32]) rendered.set(width, component.render(width));
					return undefined;
				},
			}));

			for (const [width, lines] of rendered) {
				assert.ok(lines.length > 0);
				for (const line of lines) {
					assert.ok(visibleWidth(line) <= width, `stop selector line exceeds render width: ${visibleWidth(line)} > ${width}`);
				}
			}
		});
	});

	it("/subagents-stop forwards a child id for child-scoped stops", async () => {
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let requestedParams: unknown;
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown };
			requestedParams = payload.params;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: "Stop requested for child step-0-agent-0 in async workflow run-123." }],
					details: { mode: "management", results: [] },
				},
				isError: false,
			});
		});
		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage() {},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("subagents-stop")!.handler("run-123 step-0-agent-0", createCommandContext());
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.deepEqual(requestedParams, { action: "stop", id: "run-123", childId: "step-0-agent-0" });
	});

	it("/subagents-stop rejects extra arguments with usage text", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const pi = {
			events: createEventBus(),
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) { sent.push(message); },
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("subagents-stop")!.handler("run-123 child-0 unexpected", createCommandContext());

		assert.equal(sent.length, 1);
		assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /Usage: \/subagents-stop \[run-id\] \[child-id\]/);
	});

	it("/subagents-steer forwards a run-level steer with host-style recovery disabled", async () => {
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let requestedParams: unknown;
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown };
			requestedParams = payload.params;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: "Steer delivered to run-123." }],
					details: { mode: "management", results: [] },
				},
				isError: false,
			});
		});
		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage() {},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("subagents-steer")!.handler("run-123 wrap up and report", createCommandContext());
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.deepEqual(requestedParams, { action: "steer", id: "run-123", message: "wrap up and report", steeringRecovery: false });
	});

	it("/subagents-steer --child resolves workflow and nested children to direct runs", async () => {
		const runId = "steer-itest-child-resolution";
		const childRunId = `${runId}-child`;
		const nestedChildRunId = `${runId}-nested`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId,
			sessionId: "session-test",
			mode: "workflow",
			state: "paused",
			activityState: "needs_attention",
			startedAt: 100,
			lastUpdate: 200,
			steps: [
				{
					agent: "worker",
					status: "complete",
					startedAt: 100,
					children: [{
						id: nestedChildRunId,
						parentRunId: runId,
						parentStepIndex: 0,
						depth: 1,
						path: [{ runId, stepIndex: 0 }],
						state: "running",
						asyncDir: path.join(ASYNC_DIR, nestedChildRunId),
					}],
				},
				{ agent: "scout", workflowKey: "detaches", status: "paused", runId: childRunId, startedAt: 110, activityState: "needs_attention" },
			],
		}, null, 2), "utf-8");
		updateActiveRunIndex(asyncDir, "paused");

		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let requestedParams: unknown;
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown };
			requestedParams = payload.params;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: "Steer delivered." }],
					details: { mode: "management", results: [] },
				},
				isError: false,
			});
		});
		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage() {},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("subagents-steer")!.handler(`${runId} --child detaches --verbose`, createCommandContext());
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.deepEqual(requestedParams, { action: "steer", id: childRunId, message: "--verbose", steeringRecovery: false });
		await commands.get("subagents-steer")!.handler(`${runId} --child ${nestedChildRunId} continue`, createCommandContext());
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.deepEqual(requestedParams, { action: "steer", id: nestedChildRunId, message: "continue", steeringRecovery: false });
	});

	it("/subagents-steer --child fails closed for an unknown child id", async () => {
		const runId = "steer-itest-child-resolution";
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let requested = false;
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, () => {
			requested = true;
		});
		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) { sent.push(message); },
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("subagents-steer")!.handler(`${runId} --child nope hurry up`, createCommandContext());

		assert.equal(requested, false);
		assert.equal(sent.length, 1);
		assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /was not found under async run/);
	});

	it("/subagents-steer requires a message", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let requested = false;
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, () => {
			requested = true;
		});
		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) { sent.push(message); },
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("subagents-steer")!.handler("run-123", createCommandContext());

		assert.equal(requested, false);
		assert.equal(sent.length, 1);
		assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /Usage: \/subagents-steer <run-id>/);
	});

	it("/subagents-steer treats leading -- tokens as message text", async () => {
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let requestedParams: unknown;
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown };
			requestedParams = payload.params;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: "Steer delivered." }],
					details: { mode: "management", results: [] },
				},
				isError: false,
			});
		});
		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage() {},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("subagents-steer")!.handler("run-123 --verbose", createCommandContext());
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.deepEqual(requestedParams, { action: "steer", id: "run-123", message: "--verbose", steeringRecovery: false });

		await commands.get("subagents-steer")!.handler("run-123 --child --verbose", createCommandContext());
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.deepEqual(requestedParams, { action: "steer", id: "run-123", message: "--child --verbose", steeringRecovery: false });
	});

	it("/run accepts an agent without a task", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let requestedParams: unknown;
		let requestedCtx: unknown;
		const sessionManager = {
			flushed: false,
			rewrites: 0,
			getSessionFile: () => "session.jsonl",
			_rewriteFile() {
				this.rewrites++;
			},
		};
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown; ctx?: unknown };
			requestedParams = payload.params;
			requestedCtx = payload.ctx;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: "Commit finished" }],
					details: { mode: "single", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};

		const ctx = createCommandContext({ sessionManager });
		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout", ctx);
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.deepEqual(requestedParams, { workflowScript: "return runs.run(\"run\", {\"agent\":\"scout\",\"task\":\"\",\"agentScope\":\"both\"})", async: false });
		assert.equal(requestedCtx, ctx);
		assert.equal(sent.length, 2);
		assert.equal((sent[0] as { display?: boolean }).display, true);
		assert.equal((sent[0] as { content?: string }).content, "Running subagent...");
		assert.equal((sent[1] as { display?: boolean }).display, true);
		assert.match((sent[1] as { content?: string }).content ?? "", /Commit finished/);
		assert.equal(sessionManager.rewrites, 2);
		assert.equal(sessionManager.flushed, true);
	});

	it("/run abandons captured context when commands are disposed during reload", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let deliverResponse: (() => void) | undefined;
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			deliverResponse = () => events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "late result" }],
					details: { mode: "single", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) { sent.push(message); },
		};
		const disposer = registerSlashCommands!(pi, createState(process.cwd()));
		let stale = false;
		const ctx = createCommandContext({ hasUI: true });
		Object.defineProperty(ctx, "hasUI", {
			get() {
				if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
				return true;
			},
		});

		await commands.get("run")!.handler("scout Inspect this", ctx);
		assert.equal(sent.length, 1);
		stale = true;
		disposer.dispose();
		deliverResponse?.();
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.equal(sent.length, 1, "disposed slash work must not use the stale context for a final message");
	});

	it("/run handles a start timeout without an uninitialized finish callback", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, RegisteredSlashCommand>();
		const pi = {
			events: createEventBus(),
			registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
			registerShortcut() {},
			sendMessage(message: unknown) { sent.push(message); },
		};
		const disposer = registerSlashCommands!(pi, createState(process.cwd()));
		const realSetTimeout = globalThis.setTimeout;
		let timeoutCalls = 0;
		const immediateTimeout = (...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> => {
			const [handler, delay, ...rest] = args;
			if (delay === 15_000) {
				timeoutCalls += 1;
				(handler as (...values: unknown[]) => void)(...rest);
				return 0 as ReturnType<typeof setTimeout>;
			}
			return realSetTimeout(...args);
		};
		globalThis.setTimeout = immediateTimeout;
		try {
			await commands.get("run")!.handler("scout Inspect this", createCommandContext());
			await new Promise<void>((resolve) => setImmediate(resolve));
		} finally {
			globalThis.setTimeout = realSetTimeout;
			disposer.dispose();
		}

		assert.equal(timeoutCalls, 1);
		assert.equal(sent.length, 2);
		assert.match((sent[1] as { content?: string }).content ?? "", /did not start within 15s/);
	});

	it("/run reports discovery evidence for a missing agent", async () => {
		await withTempProject("pi-slash-missing-agent-", async (root) => {
			fs.writeFileSync(path.join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: Worker\n---\n", "utf-8");
			const run = await captureSlashCommandParams("run", "missing", root);
			assert.equal(run.params, undefined);
			assert.match(run.notifications[0] ?? "", /^Unknown agent: missing\nEffective cwd: /);
			assert.match(run.notifications[0] ?? "", /Consulted agent-definition directories:[\s\S]*worker \(project\)/);
		});
	});

	it("/run reports malformed agent configuration", async () => {
		await withTempProject("pi-slash-invalid-agent-", async (root) => {
			fs.writeFileSync(path.join(root, ".pi", "agents", "broken.md"), "---\nname: broken\ndescription: Broken\nrunner:\n  type: unknown\n---\nBroken agent.\n");

			const run = await captureSlashCommandParams("run", "broken", root);
			assert.equal(run.params, undefined);
			assert.match(run.notifications[0] ?? "", /Agent 'broken' has invalid configuration: Agent 'broken' has invalid runner\.type/);
		});
	});

	it("/run blocks a malformed project agent from falling back to builtin", async () => {
		await withTempProject("pi-slash-invalid-agent-shadow-", async (root) => {
			fs.writeFileSync(path.join(root, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Broken reviewer\nrunner:\n  type: unknown\n---\nBroken agent.\n");

			const run = await captureSlashCommandParams("run", "reviewer", root);
			assert.equal(run.params, undefined);
			assert.match(run.notifications[0] ?? "", /Agent 'reviewer' has invalid configuration: Agent 'reviewer' has invalid runner\.type/);
		});
	});

	it("/run reports malformed packaged agent configuration by runtime name", async () => {
		await withTempProject("pi-slash-invalid-packaged-agent-", async (root) => {
			fs.writeFileSync(path.join(root, ".pi", "agents", "code-analysis.zeta-worker.md"), "---\nname: zeta-worker\npackage: code-analysis\ndescription: Broken packaged worker\nrunner:\n  type: unknown\n---\nBroken agent.\n");

			const run = await captureSlashCommandParams("run", "code-analysis.zeta-worker", root);
			assert.equal(run.params, undefined);
			assert.match(run.notifications[0] ?? "", /Agent 'code-analysis\.zeta-worker' has invalid configuration: Agent 'zeta-worker' has invalid runner\.type/);
		});
	});

	it("/run accepts runtime-registered agents", async () => {
		await withTempProject("pi-slash-runtime-agent-", async (root) => {
			const run = await captureSlashCommandParams("run", "runtime-helper Inspect", root, (pi) => {
				registerAgent({
					pi: pi as never,
					name: "runtime-helper",
					definition: { description: "Runtime helper", systemPrompt: "Help at runtime." },
				});
			});

			assert.deepEqual(run.params, {
				workflowScript: "return runs.run(\"run\", {\"agent\":\"runtime-helper\",\"task\":\"Inspect\",\"agentScope\":\"both\"})",
				async: false,
			});
		});
	});

	it("/subagents-models accepts discovered and runtime agent names", async () => {
		await withTempProject("pi-slash-models-agent-", async (root) => {
			fs.writeFileSync(path.join(root, ".pi", "agents", "project-helper.md"), "---\nname: project-helper\ndescription: Project helper\n---\nProject helper.\n", "utf-8");
			const runtimeRun = await captureSlashCommandParams("subagents-models", "runtime-helper", root, (pi) => {
				registerAgent({
					pi: pi as never,
					name: "runtime-helper",
					definition: { description: "Runtime helper", systemPrompt: "Help at runtime." },
				});
			});
			assert.deepEqual(runtimeRun.params, { action: "models", agent: "runtime-helper" });

			const projectRun = await captureSlashCommandParams("subagents-models", "project-helper", root);
			assert.deepEqual(projectRun.params, { action: "models", agent: "project-helper" });

			await withIsolatedHome(async () => {
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					on() { return () => {}; },
					registerTool() {},
					registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
					registerShortcut() {},
					sendMessage() {},
				};
				const registration = registerAgent({
					pi: pi as never,
					name: "runtime-helper",
					definition: { description: "Runtime helper", systemPrompt: "Help at runtime." },
				});
				try {
					const disposer = registerSlashCommands!(pi, createState(root));
					try {
						const completions = commands.get("subagents-models")!.getArgumentCompletions!("runtime-") as Array<{ value: string }>;
						assert.deepEqual(completions.map(({ value }) => value), ["runtime-helper"]);
					} finally {
						disposer.dispose();
					}
				} finally {
					registration.dispose();
				}
			});
		});
	});

	it("/run preserves existing relative reads and omits missing reads", async () => {
		await withTempProject("pi-slash-reads-", async (root) => {
			fs.writeFileSync(path.join(root, ".pi", "agents", "scout.md"), `---
name: scout
description: Scout
---

Inspect
`, "utf-8");
			fs.writeFileSync(path.join(root, "context.md"), "context");

			const run = await captureSlashCommandParams("run", "scout[reads=context.md+missing.md] Inspect", root);
			assert.deepEqual(run.params, {
				workflowScript: "return runs.run(\"run\", {\"agent\":\"scout\",\"task\":\"[Read from: context.md]\\n\\nInspect\",\"agentScope\":\"both\"})",
				async: false,
			});
		});
	});

	it("/run finalizes the slash snapshot before the last UI redraw on success", async () => {
		const sent: unknown[] = [];
		const log: string[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "Scout finished" }],
					details: { mode: "single", results: [{ sessionFile: "/tmp/child-session.jsonl" }] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
				log.push(`send:${(message as { display?: boolean }).display === false ? "hidden" : "visible"}`);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout inspect this", createCommandContext({
			hasUI: true,
			setStatus: (_key, text) => {
				log.push(`status:${text ?? "clear"}`);
			},
		}));
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.equal(sent.length, 2);
		assert.equal((sent[0] as { customType?: string; display?: boolean }).customType, SLASH_RESULT_TYPE);
		assert.equal((sent[0] as { display?: boolean }).display, true);
		assert.equal((sent[0] as { content?: string }).content, "inspect this");
		assert.equal((sent[1] as { customType?: string; display?: boolean }).customType, SLASH_RESULT_TYPE);
		assert.equal((sent[1] as { display?: boolean }).display, false);
		assert.match((sent[1] as { content?: string }).content ?? "", /Scout finished/);
		assert.match((sent[1] as { content?: string }).content ?? "", /Child session exports\n\n- `\/tmp\/child-session\.jsonl`/);
		assert.deepEqual(log, ["send:visible", "status:running...", "send:hidden", "status:clear"]);

		const visibleDetails = resolveSlashMessageDetails!((sent[0] as { details?: unknown }).details);
		assert.ok(visibleDetails);
		const visibleSnapshot = getSlashRenderableSnapshot!(visibleDetails!);
		assert.equal((visibleSnapshot.result.content[0] as { text?: string }).text, "Scout finished");
	});

	it("/run collapses tool detail before showing the initial live card", async () => {
		const log: string[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: { content: [{ type: "text", text: "done" }], details: { mode: "single", results: [] } },
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage() {
				log.push("send");
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout inspect this", createCommandContext({
			hasUI: true,
			setToolsExpanded: (expanded) => log.push(`expanded:${String(expanded)}`),
		}));

		assert.deepEqual(log.slice(0, 2), ["expanded:false", "send"]);
	});

	it("/run finalizes the slash snapshot before the last UI redraw on error", async () => {
		const sent: unknown[] = [];
		const log: string[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "Subagent failed" }],
					details: { mode: "single", results: [] },
				},
				isError: true,
				errorText: "Subagent failed",
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
				log.push(`send:${(message as { display?: boolean }).display === false ? "hidden" : "visible"}`);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout inspect this", createCommandContext({
			hasUI: true,
			setStatus: (_key, text) => {
				log.push(`status:${text ?? "clear"}`);
			},
		}));
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.equal(sent.length, 2);
		assert.equal((sent[0] as { customType?: string; display?: boolean }).customType, SLASH_RESULT_TYPE);
		assert.equal((sent[0] as { display?: boolean }).display, true);
		assert.equal((sent[0] as { content?: string }).content, "inspect this");
		assert.equal((sent[1] as { customType?: string; display?: boolean }).customType, SLASH_RESULT_TYPE);
		assert.equal((sent[1] as { display?: boolean }).display, false);
		assert.match((sent[1] as { content?: string }).content ?? "", /Subagent failed/);
		assert.deepEqual(log, ["send:visible", "status:running...", "send:hidden", "status:clear"]);

		const visibleDetails = resolveSlashMessageDetails!((sent[0] as { details?: unknown }).details);
		assert.ok(visibleDetails);
		const visibleSnapshot = getSlashRenderableSnapshot!(visibleDetails!);
		assert.equal((visibleSnapshot.result.content[0] as { text?: string }).text, "Subagent failed");
	});

	it("/run accepts dotted packaged runtime agent names", async () => {
		await withTempProject("pi-packaged-agent-slash-", async (root) => {
			fs.writeFileSync(path.join(root, ".pi", "agents", "code-analysis.scout.md"), `---
name: scout
package: code-analysis
description: Fast recon
---

Inspect
`, "utf-8");

			const run = await captureSlashCommandParams("run", "code-analysis.scout Investigate", root);
			assert.deepEqual(run.params, { workflowScript: "return runs.run(\"run\", {\"agent\":\"code-analysis.scout\",\"task\":\"Investigate\",\"agentScope\":\"both\"})", async: false });

			await withIsolatedHome(async () => {
				const commands = new Map<string, RegisteredSlashCommand>();
				registerSlashCommands!({
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
					registerShortcut() {},
					sendMessage() {},
				} as never, createState(root));
				const completions = commands.get("run")!.getArgumentCompletions!("code-") as Array<{ value: string }>;
				assert.deepEqual(completions.map(({ value }) => value), ["code-analysis.scout"]);
			});
		});
	});

	it("/run reports malformed packaged local-name fallback configuration", async () => {
		await withTempProject("pi-packaged-agent-local-slash-", async (root) => {
			const highPackage = path.join(root, "high-package");
			const lowPackage = path.join(root, "low-package");
			for (const packageRoot of [highPackage, lowPackage]) {
				fs.mkdirSync(path.join(packageRoot, "agents"), { recursive: true });
				fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ "pi-subagents": { agents: ["agents"] } }));
			}
			fs.writeFileSync(path.join(highPackage, "agents", "foo.md"), `---
name: foo
package: acme
description: Broken high package foo
runner:
  type: unknown
---
Broken foo.
`, "utf-8");
			fs.writeFileSync(path.join(lowPackage, "agents", "foo.md"), `---
name: foo
package: acme
description: Valid low package foo
---
Valid foo.
`, "utf-8");
			fs.writeFileSync(path.join(root, ".pi", "settings.json"), JSON.stringify({ packages: [highPackage, lowPackage] }));

			const run = await captureSlashCommandParams("run", "foo Investigate", root);
			assert.equal(run.params, undefined);
			assert.match(run.notifications[0] ?? "", /Agent 'foo' has invalid configuration: Agent 'foo' has invalid runner\.type/);
		});
	});

	it("does not register legacy orchestration commands", async () => {
		const commands = new Map<string, unknown>();
		registerSlashCommands!({
			registerCommand(name: string, command: unknown) { commands.set(name, command); },
			registerShortcut() {},
			events: createEventBus(),
		} as never, { baseCwd: process.cwd() } as never);
		assert.equal(commands.has("run"), true);
		assert.equal(commands.has("chain"), false);
		assert.equal(commands.has("parallel"), false);
		assert.equal(commands.has("run-chain"), false);
	});
});

describe("subagents-inspect-rpc command", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	function writeInspectableRun(runId: string, sessionId: string) {
		const asyncDir = path.join(ASYNC_DIR, runId);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.mkdirSync(DIRS.results, { recursive: true });
		const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspect-itest-session-"));
		const sessionFile = path.join(sessionRoot, "session.jsonl");
		fs.writeFileSync(sessionFile, [
			JSON.stringify({ message: { role: "user", content: "inspect me" } }),
			JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "inspected" }] } }),
		].join("\n") + "\n", "utf-8");
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId,
			sessionId,
			mode: "single",
			state: "complete",
			startedAt: 100,
			endedAt: 200,
			lastUpdate: 200,
			sessionFile,
			sessionRoot,
			steps: [{ agent: "worker", status: "complete", startedAt: 100, endedAt: 150, sessionFile }],
		}, null, 2), "utf-8");
		return { asyncDir, sessionRoot };
	}

	function makeInspectCtx(mode: string) {
		const widgetCalls: Array<{ key: string; value: unknown }> = [];
		const notifications: string[] = [];
		const ctx = {
			mode,
			hasUI: true,
			cwd: process.cwd(),
			ui: {
				setWidget: (key: string, value: unknown) => { widgetCalls.push({ key, value }); },
				notify: (message: string) => { notifications.push(message); },
				setStatus: () => {},
				setToolsExpanded: () => {},
			},
			sessionManager: { getSessionFile: () => null, getSessionId: () => "session-itest" },
		};
		return { ctx, widgetCalls, notifications };
	}

	function registerWithState(sessionId: string | null, trustedSessionRoots: string[] = []) {
		const commands = new Map<string, RegisteredSlashCommand>();
		const pi = {
			events: createEventBus(),
			registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
			registerShortcut() {},
			sendMessage() {},
		};
		const state = { ...createState(process.cwd()), currentSessionId: sessionId, trustedSessionRoots };
		registerSlashCommands!(pi as never, state as never);
		return commands;
	}

	it("emits a correlated payload widget then retracts it on RPC surfaces", async () => {
		writeInspectableRun("run-itest", "session-itest");
		const commands = registerWithState("session-itest");
		const { ctx, widgetCalls, notifications } = makeInspectCtx("rpc");
		await commands.get("subagents-inspect-rpc")!.handler("req-itest run-itest", ctx);

		assert.deepEqual(widgetCalls.map((call) => call.key), ["subagent-inspect", "subagent-inspect"]);
		const [set, clear] = widgetCalls;
		assert.equal(clear!.value, undefined);
		const lines = set!.value as string[];
		assert.equal(lines.length, 1);
		assert.ok(lines[0]!.startsWith("PI_SUBAGENT_INSPECT_JSON:"));
		const reply = JSON.parse(lines[0]!.slice("PI_SUBAGENT_INSPECT_JSON:".length));
		assert.equal(reply.kind, "pi-subagents.inspect-reply");
		assert.equal(reply.version, 1);
		assert.equal(reply.requestId, "req-itest");
		assert.equal(reply.status, "complete");
		assert.equal(reply.task, "inspect me");
		assert.equal(reply.error, undefined);
		assert.equal(JSON.stringify(reply).includes("session.jsonl"), false);
		assert.equal(notifications.length, 0);
	});

	it("answers foreign_session for runs owned by another session", async () => {
		writeInspectableRun("run-itest-foreign", "session-other");
		const commands = registerWithState("session-itest");
		const { ctx, widgetCalls } = makeInspectCtx("rpc");
		await commands.get("subagents-inspect-rpc")!.handler("req-foreign run-itest-foreign", ctx);
		const lines = widgetCalls[0]!.value as string[];
		const reply = JSON.parse(lines[0]!.slice("PI_SUBAGENT_INSPECT_JSON:".length));
		assert.equal(reply.error?.code, "foreign_session");
		assert.equal(reply.messages, undefined);
	});

	it("answers invalid_request with the echoed requestId for malformed args", async () => {
		const commands = registerWithState("session-itest");
		const { ctx, widgetCalls } = makeInspectCtx("rpc");
		await commands.get("subagents-inspect-rpc")!.handler("req-bad", ctx);
		const lines = widgetCalls[0]!.value as string[];
		const reply = JSON.parse(lines[0]!.slice("PI_SUBAGENT_INSPECT_JSON:".length));
		assert.equal(reply.error?.code, "invalid_request");
		assert.equal(reply.requestId, "req-bad");
	});

	it("degrades to a notification in TUI mode without emitting widgets", async () => {
		writeInspectableRun("run-itest-tui", "session-itest");
		const commands = registerWithState("session-itest");
		const { ctx, widgetCalls, notifications } = makeInspectCtx("tui");
		await commands.get("subagents-inspect-rpc")!.handler("req-tui run-itest-tui", ctx);
		assert.equal(widgetCalls.length, 0);
		assert.match(notifications[0] ?? "", /RPC surfaces/);
	});
});
