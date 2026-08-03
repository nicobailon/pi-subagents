import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

import { scheduledRunStorePath } from "../../src/runs/background/scheduled-runs.ts";
import { SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";
import { ASYNC_DIR } from "../../src/shared/types.ts";
import type { WatchdogReviewFunction } from "../../src/watchdog/runtime.ts";

const SLASH_RESULT_TYPE = "subagent-slash-result";
const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";

interface EventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
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
	) => void;
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
	setup?: () => void,
): Promise<{ params: unknown; notifications: string[] }> {
	return withIsolatedHome(async () => {
		setup?.();
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
			registerCommand(name: string, spec: RegisteredSlashCommand) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(_message: unknown) {},
		};

		registerSlashCommands!(pi, createState(cwd));
		await commands.get(commandName)!.handler(args, createCommandContext({
			cwd,
			notify: (message) => {
				notifications.push(message);
			},
		}));
		return { params: requestedParams, notifications };
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

		assert.deepEqual(requestedParams, { agent: "scout", task: "", clarify: false, agentScope: "both" });
		assert.equal(requestedCtx, ctx);
		assert.equal(sent.length, 2);
		assert.equal((sent[0] as { display?: boolean }).display, true);
		assert.equal((sent[0] as { content?: string }).content, "Running subagent...");
		assert.equal((sent[1] as { display?: boolean }).display, true);
		assert.match((sent[1] as { content?: string }).content ?? "", /Commit finished/);
		assert.equal(sessionManager.rewrites, 2);
		assert.equal(sessionManager.flushed, true);
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
			assert.deepEqual(run.params, { agent: "code-analysis.scout", task: "Investigate", clarify: false, agentScope: "both" });

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
