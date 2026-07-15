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
		setStatus: (key: string, text: string | undefined) => void;
		setToolsExpanded: (expanded: boolean) => void;
		sessionManager: unknown;
		modelRegistry: { getAvailable: () => Array<{ provider: string; id: string }>; find?: (provider: string, id: string) => unknown; hasConfiguredAuth?: (model: unknown) => boolean };
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
			setStatus: overrides.setStatus ?? ((_key: string, _text: string | undefined) => {}),
			setToolsExpanded: overrides.setToolsExpanded ?? ((_expanded: boolean) => {}),
			onTerminalInput: () => () => {},
			custom: overrides.custom ?? (async () => undefined),
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

	it("/parallel forwards inline output behavior config", async () => {
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
					content: [{ type: "text", text: "parallel finished" }],
					details: { mode: "parallel", results: [] },
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
			sendMessage(_message: unknown) {},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("parallel")!.handler("scout[output=x.md,outputMode=file-only,reads=a.md+b.md,progress] -- Review", createCommandContext());

		assert.deepEqual(requestedParams, {
			tasks: [{ agent: "scout", task: "Review", output: "x.md", outputMode: "file-only", reads: ["a.md", "b.md"], progress: true }],
			clarify: false,
			agentScope: "both",
		});
	});

	it("/parallel no longer hard-blocks runs above the old 8-task limit before the executor responds", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let requestedTasks = 0;
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: { tasks?: unknown[] } };
			requestedTasks = payload.params?.tasks?.length ?? 0;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: "parallel finished" }],
					details: { mode: "parallel", results: [] },
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

		registerSlashCommands!(pi, createState(process.cwd()));
		const args = Array.from({ length: 9 }, (_, index) => `scout \"task ${index + 1}\"`).join(" -> ");
		await commands.get("parallel")!.handler(args, createCommandContext());

		assert.equal(requestedTasks, 9);
		assert.equal(sent.length, 2);
		assert.match((sent[1] as { content?: string }).content ?? "", /parallel finished/);
	});
});

describe("saved chain slash command", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("/run and /chain accept dotted packaged runtime agent names", async () => {
		await withTempProject("pi-packaged-agent-slash-", async (root) => {
			fs.writeFileSync(path.join(root, ".pi", "agents", "code-analysis.scout.md"), `---
name: scout
package: code-analysis
description: Fast recon
---

Inspect
`, "utf-8");
			fs.writeFileSync(path.join(root, ".pi", "agents", "documentation.writer.md"), `---
name: writer
package: documentation
description: Writer
---

Write
`, "utf-8");

			const run = await captureSlashCommandParams("run", "code-analysis.scout Investigate", root);
			assert.deepEqual(run.params, { agent: "code-analysis.scout", task: "Investigate", clarify: false, agentScope: "both" });

			const chain = await captureSlashCommandParams("chain", "code-analysis.scout \"Scan\" -> documentation.writer", root);
			assert.deepEqual((chain.params as { chain?: Array<{ agent?: string; task?: string }> }).chain?.map(({ agent, task }) => ({ agent, task })), [
				{ agent: "code-analysis.scout", task: "Scan" },
				{ agent: "documentation.writer", task: undefined },
			]);

			await withIsolatedHome(async () => {
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
					registerShortcut() {},
					sendMessage(_message: unknown) {},
				};
				registerSlashCommands!(pi, createState(root));
				const runCompletions = commands.get("run")!.getArgumentCompletions!("code-") as Array<{ value: string; label: string }>;
				assert.deepEqual(runCompletions.map((completion) => completion.value), ["code-analysis.scout"]);
				const chainCompletions = commands.get("chain")!.getArgumentCompletions!("code-analysis.scout \"Scan\" -> doc") as Array<{ value: string; label: string }>;
				assert.deepEqual(chainCompletions.map((completion) => completion.value), ["code-analysis.scout \"Scan\" -> documentation.writer"]);
				// Regression: bare group-ish syntax inside a `--` shared task is plain text, not
				// a group separator, so it must not resume agent completion past the task.
				const pipeInTask = commands.get("chain")!.getArgumentCompletions!("code-analysis.scout -- do x | doc");
				assert.equal(pipeInTask, null);
				const openParenInTask = commands.get("chain")!.getArgumentCompletions!("code-analysis.scout -- do (doc");
				assert.equal(openParenInTask, null);
				const closeParenInTask = commands.get("chain")!.getArgumentCompletions!("code-analysis.scout -- do ) doc");
				assert.equal(closeParenInTask, null);
				const balancedParenInTask = commands.get("chain")!.getArgumentCompletions!("code-analysis.scout -- do (x) doc");
				assert.equal(balancedParenInTask, null);
				// Inside an actual parallel group, `|` still separates tasks and completes agents.
				const groupCompletions = commands.get("chain")!.getArgumentCompletions!("code-analysis.scout \"Scan\" -> (documentation.writer \"w\" | code") as Array<{ value: string; label: string }>;
				assert.deepEqual(groupCompletions.map((completion) => completion.value), ["code-analysis.scout \"Scan\" -> (documentation.writer \"w\" | code-analysis.scout"]);
			});
		});
	});

	it("/run-chain launches a saved chain with a shared task", async () => {
		await withTempProject("pi-run-chain-success-", async (root) => {
			writeProjectChain(root, "review-flow.chain.md", `---
name: review-flow
description: Review flow
---

## scout

Scan {task}

## reviewer

Review {previous}
`);

			const { params } = await captureSlashCommandParams("run-chain", "review-flow -- Audit the auth flow", root);
			const runParams = params as {
				chain?: Array<{ agent?: string; task?: string }>;
				task?: string;
				clarify?: boolean;
				agentScope?: string;
				async?: unknown;
				context?: unknown;
			};

			assert.deepEqual(runParams.chain?.map(({ agent, task }) => ({ agent, task })), [
				{ agent: "scout", task: "Scan {task}" },
				{ agent: "reviewer", task: "Review {previous}" },
			]);
			assert.equal(runParams.task, "Audit the auth flow");
			assert.equal(runParams.clarify, false);
			assert.equal(runParams.agentScope, "both");
			assert.equal(runParams.async, undefined);
			assert.equal(runParams.context, undefined);
		});
	});

	it("/run-chain launches a saved JSON chain with dynamic fanout", async () => {
		await withTempProject("pi-run-chain-json-dynamic-", async (root) => {
			writeProjectChain(root, "dynamic-review.chain.json", JSON.stringify({
				name: "dynamic-review",
				description: "Dynamic review flow",
				chain: [
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews" },
					},
				],
			}));

			const { params } = await captureSlashCommandParams("run-chain", "dynamic-review -- Audit", root);
			const runParams = params as { chain?: Array<Record<string, unknown>>; task?: string; clarify?: boolean; agentScope?: string };

			assert.equal(runParams.task, "Audit");
			assert.equal(runParams.clarify, false);
			assert.equal(runParams.agentScope, "both");
			assert.equal(runParams.chain?.[0]?.agent, "scout");
			assert.deepEqual(runParams.chain?.[1]?.expand, { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 });
			assert.deepEqual(runParams.chain?.[1]?.collect, { as: "reviews" });
		});
	});

	it("/run-chain preserves saved JSON chain acceptance contracts", async () => {
		await withTempProject("pi-run-chain-json-acceptance-", async (root) => {
			writeProjectChain(root, "verified-flow.chain.json", JSON.stringify({
				name: "verified-flow",
				description: "Verified flow",
				chain: [
					{
						agent: "worker",
						task: "Implement fix",
						acceptance: {
							level: "verified",
							verify: [{ id: "tests", command: "npm test" }],
						},
					},
				],
			}));

			const { params } = await captureSlashCommandParams("run-chain", "verified-flow -- Audit", root);
			assert.deepEqual((params as { chain?: Array<{ acceptance?: unknown }> }).chain?.[0]?.acceptance, {
				level: "verified",
				verify: [{ id: "tests", command: "npm test" }],
			});
		});
	});

	it("/run-chain launches and completes packaged saved chains by dotted runtime name", async () => {
		await withTempProject("pi-run-chain-packaged-", async (root) => {
			writeProjectChain(root, "code-analysis.review-flow.chain.md", `---
name: review-flow
package: code-analysis
description: Review flow
---

## code-analysis.scout

Scan {task}
`);

			const { params } = await captureSlashCommandParams("run-chain", "code-analysis.review-flow -- Audit", root);
			assert.equal((params as { task?: string }).task, "Audit");
			assert.deepEqual((params as { chain?: Array<{ agent?: string; task?: string }> }).chain?.map(({ agent, task }) => ({ agent, task })), [
				{ agent: "code-analysis.scout", task: "Scan {task}" },
			]);

			await withIsolatedHome(async () => {
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
					registerShortcut() {},
					sendMessage(_message: unknown) {},
				};
				registerSlashCommands!(pi, createState(root));
				const completions = commands.get("run-chain")!.getArgumentCompletions!("code-") as Array<{ value: string; label: string }>;
				assert.deepEqual(completions.map((completion) => completion.value), ["code-analysis.review-flow"]);
			});
		});
	});

	it("/run-chain reports an unknown saved chain without launching", async () => {
		await withTempProject("pi-run-chain-unknown-", async (root) => {
			const { params, notifications } = await captureSlashCommandParams("run-chain", "missing -- Do work", root);

			assert.equal(params, undefined);
			assert.deepEqual(notifications, ["Unknown chain: missing"]);
		});
	});

	it("/run-chain suggests saved chain names", async () => {
		await withTempProject("pi-run-chain-completions-", async (root) => {
			writeProjectChain(root, "review-flow.chain.md", `---
name: review-flow
description: Review flow
---

## scout

Scan
`);
			writeProjectChain(root, "release-flow.chain.md", `---
name: release-flow
description: Release flow
---

## planner

Plan
`);
			writeProjectChain(root, "triage.chain.md", `---
name: triage
description: Triage flow
---

## scout

Triage
`);

			await withIsolatedHome(async () => {
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) {
						commands.set(name, spec);
					},
					registerShortcut() {},
					sendMessage(_message: unknown) {},
				};

				registerSlashCommands!(pi, createState(root));
				const completions = commands.get("run-chain")!.getArgumentCompletions!("re") as Array<{ value: string; label: string }>;
				assert.deepEqual(completions.map((completion) => completion.value).sort(), ["release-flow", "review-flow"]);
				assert.deepEqual(completions.map((completion) => completion.label).sort(), ["release-flow", "review-flow"]);
				assert.equal(commands.get("run-chain")!.getArgumentCompletions!("review-flow -- "), null);
			});
		});
	});

	it("/run-chain maps --bg to async execution", async () => {
		await withTempProject("pi-run-chain-bg-", async (root) => {
			writeProjectChain(root, "review-flow.chain.md", `---
name: review-flow
description: Review flow
---

## scout

Scan
`);

			const { params } = await captureSlashCommandParams("run-chain", "review-flow -- Audit --bg", root);

			assert.equal((params as { async?: unknown }).async, true);
			assert.equal((params as { context?: unknown }).context, undefined);
		});
	});

	it("/run-chain maps --fork to forked context", async () => {
		await withTempProject("pi-run-chain-fork-", async (root) => {
			writeProjectChain(root, "review-flow.chain.md", `---
name: review-flow
description: Review flow
---

## scout

Scan
`);

			const { params } = await captureSlashCommandParams("run-chain", "review-flow -- Audit --fork", root);

			assert.equal((params as { context?: unknown }).context, "fork");
			assert.equal((params as { async?: unknown }).async, undefined);
		});
	});

	it("/run-chain prefers a project saved chain over a same-named user chain", async () => {
		await withTempProject("pi-run-chain-priority-", async (root) => {
			writeProjectChain(root, "review-flow.chain.md", `---
name: review-flow
description: Project review flow
---

## scout

Project chain task
`);

			const { params } = await captureSlashCommandParams("run-chain", "review-flow -- Shared task", root, () => {
				const userChainsDir = path.join(os.homedir(), ".pi", "agent", "chains");
				fs.mkdirSync(userChainsDir, { recursive: true });
				fs.writeFileSync(path.join(userChainsDir, "review-flow.chain.md"), `---
name: review-flow
description: User review flow
---

## scout

User chain task
`, "utf-8");
			});

			assert.equal((params as { chain?: Array<{ task?: string }> }).chain?.[0]?.task, "Project chain task");
		});
	});

	it("/run-chain resolves saved outputSchema files at the command boundary", async () => {
		await withTempProject("pi-run-chain-schema-", async (root) => {
			const schemasDir = path.join(root, ".pi", "chains", "schemas");
			fs.mkdirSync(schemasDir, { recursive: true });
			fs.writeFileSync(path.join(schemasDir, "finding.schema.json"), JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } } }), "utf-8");
			writeProjectChain(root, "schema-flow.chain.md", `---
name: schema-flow
description: Schema flow
---

## scout
outputSchema: ./schemas/finding.schema.json

Gather context
`);

			const { params } = await captureSlashCommandParams("run-chain", "schema-flow -- Shared task", root);

			assert.deepEqual((params as { chain?: Array<{ outputSchema?: unknown }> }).chain?.[0]?.outputSchema, {
				type: "object",
				properties: { ok: { type: "boolean" } },
			});
		});
	});

	it("/run-chain preserves saved step behavior fields", async () => {
		await withTempProject("pi-run-chain-fields-", async (root) => {
			writeProjectChain(root, "field-flow.chain.md", `---
name: field-flow
description: Field flow
---

## scout
output: context.md
outputMode: file-only
reads: input.md, notes.md
model: openai/gpt-5.5
skills: research, audit
progress: true

Gather context
`);

			const { params } = await captureSlashCommandParams("run-chain", "field-flow -- Shared task", root);

			assert.deepEqual((params as { chain?: unknown[] }).chain?.[0], {
				agent: "scout",
				task: "Gather context",
				output: "context.md",
				outputMode: "file-only",
				reads: ["input.md", "notes.md"],
				progress: true,
				skill: ["research", "audit"],
				model: "openai/gpt-5.5",
			});
		});
	});

	it("/chain parses a parenthesized parallel group into a { parallel: [...] } step", async () => {
		await withTempProject("pi-chain-group-slash-", async (root) => {
			for (const name of ["scout", "reviewer", "writer"]) {
				fs.writeFileSync(path.join(root, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n---\n\nBody\n`, "utf-8");
			}

			const { params, notifications } = await captureSlashCommandParams("chain", 'scout "scan" -> (reviewer "A" | reviewer "B") -> writer "fix"', root);
			assert.deepEqual(notifications, []);
			const built = params as { chain?: Array<Record<string, unknown>>; task?: string };
			assert.equal(built.task, "scan");
			assert.equal(built.chain?.length, 3);
			assert.equal(built.chain?.[0]?.agent, "scout");
			const parallel = built.chain?.[1]?.parallel as Array<{ agent: string; task: string }>;
			assert.ok(Array.isArray(parallel), "second step should be a parallel group");
			assert.deepEqual(parallel.map(({ agent, task }) => ({ agent, task })), [
				{ agent: "reviewer", task: "A" },
				{ agent: "reviewer", task: "B" },
			]);
			assert.equal(built.chain?.[2]?.agent, "writer");
		});
	});

	it("/chain reports parallel-group errors as notifications and does not launch", async () => {
		await withTempProject("pi-chain-group-error-", async (root) => {
			for (const name of ["scout", "reviewer"]) {
				fs.writeFileSync(path.join(root, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n---\n\nBody\n`, "utf-8");
			}

			const { params, notifications } = await captureSlashCommandParams("chain", 'scout "scan" -> (reviewer "A")', root);
			assert.equal(params, undefined);
			assert.equal(notifications.length, 1);
			assert.match(notifications[0] ?? "", /at least two/i);
		});
	});

	it("/chain carries inline metadata and group options through to params", async () => {
		await withTempProject("pi-chain-group-meta-", async (root) => {
			for (const name of ["scout", "reviewer", "writer"]) {
				fs.writeFileSync(path.join(root, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n---\n\nBody\n`, "utf-8");
			}

			const { params, notifications } = await captureSlashCommandParams(
				"chain",
				'scout[as=ctx,phase=recon] "scan" -> (reviewer "A" | writer "B")[concurrency=2,failFast]',
				root,
			);
			assert.deepEqual(notifications, []);
			const built = params as { chain?: Array<Record<string, unknown>> };
			assert.equal(built.chain?.[0]?.as, "ctx");
			assert.equal(built.chain?.[0]?.phase, "recon");
			const group = built.chain?.[1] as Record<string, unknown>;
			assert.equal((group.parallel as unknown[]).length, 2);
			assert.equal(group.concurrency, 2);
			assert.equal(group.failFast, true);
		});
	});

	it("/chain tab-completion works inside parallel groups", async () => {
		await withTempProject("pi-chain-group-complete-", async (root) => {
			for (const name of ["scout", "reviewer", "writer"]) {
				fs.writeFileSync(path.join(root, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n---\n\nBody\n`, "utf-8");
			}
			await withIsolatedHome(async () => {
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
					registerShortcut() {},
					sendMessage(_message: unknown) {},
				};
				registerSlashCommands!(pi, createState(root));
				const complete = (prefix: string) =>
					(commands.get("chain")!.getArgumentCompletions!(prefix) as Array<{ value: string }> | null)?.map((c) => c.value) ?? null;

				// after `(`
				assert.deepEqual(complete('scout "scan" -> (rev'), ['scout "scan" -> (reviewer']);
				// after `|`
				assert.deepEqual(complete('scout "scan" -> (reviewer "A" | wr'), ['scout "scan" -> (reviewer "A" | writer']);
				// after a bare `|` a space is inserted before every suggested agent
				const barePipe = complete('scout "scan" -> (reviewer "A" |');
				assert.ok(barePipe && barePipe.length > 0);
				assert.ok(barePipe.every((v) => v.startsWith('scout "scan" -> (reviewer "A" | ')));
				assert.ok(barePipe.includes('scout "scan" -> (reviewer "A" | writer'));
				// inside an open quote: no agent completion
				assert.equal(complete('scout "scan'), null);
			});
		});
	});
});


describe("subagents-models slash command", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("routes to the models tool action", async () => {
		const { params } = await captureSlashCommandParams("subagents-models", "", process.cwd());
		assert.deepEqual(params, { action: "models" });
	});

	it("passes an optional builtin filter", async () => {
		const { params } = await captureSlashCommandParams("subagents-models", "scout", process.cwd());
		assert.deepEqual(params, { action: "models", agent: "scout" });
	});

	it("rejects invalid builtin filters without launching", async () => {
		const { params, notifications } = await captureSlashCommandParams("subagents-models", "not-a-builtin", process.cwd());
		assert.equal(params, undefined);
		assert.deepEqual(notifications, ["Unknown builtin agent: not-a-builtin"]);
	});

	it("suggests builtin agent names", async () => {
		await withIsolatedHome(async () => {
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				registerCommand(name: string, spec: RegisteredSlashCommand) {
					commands.set(name, spec);
				},
				registerShortcut() {},
				sendMessage(_message: unknown) {},
			};

			registerSlashCommands!(pi, createState(process.cwd()));
			const completions = commands.get("subagents-models")!.getArgumentCompletions!("sc") as Array<{ value: string; label: string }>;
			assert.deepEqual(completions.map((completion) => completion.value), ["scout"]);
		});
	});
});

describe("subagent cost slash command", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	it("reports parent and child usage from the current session branch", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, RegisteredSlashCommand>();
		const pi = {
			events: createEventBus(),
			registerCommand(name: string, spec: RegisteredSlashCommand) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) { sent.push(message); },
		};
		const parentUsage = {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		};
		const childUsage = { input: 20, output: 10, cacheRead: 2, cacheWrite: 1, cost: 0.004, turns: 1 };
		const slashChildUsage = { input: 30, output: 15, cacheRead: 0, cacheWrite: 0, cost: 0.005, turns: 2 };
		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("subagent-cost")!.handler("", createCommandContext({
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: { role: "assistant", usage: parentUsage } },
					{
						type: "message",
						message: {
							role: "toolResult",
							toolName: "subagent",
							details: {
								mode: "single",
								results: [{ agent: "worker", task: "fix", exitCode: 0, messages: [], usage: childUsage, sessionFile: "/tmp/worker.jsonl" }],
							},
						},
					},
					{
						type: "custom_message",
						customType: SLASH_RESULT_TYPE,
						details: {
							requestId: "slash-1",
							result: {
								content: [{ type: "text", text: "done" }],
								details: {
									mode: "single",
									results: [{ agent: "reviewer", task: "review", exitCode: 0, messages: [], usage: slashChildUsage }],
								},
							},
						},
					},
				],
			},
		}));

		const output = String((sent[0] as { content?: unknown }).content ?? "");
		assert.match(output, /Parent: ↑100 ↓50 \$0\.0030/);
		assert.match(output, /Child 1 \(worker\): ↑20 ↓10 \$0\.0040/);
		assert.match(output, /Session: \/tmp\/worker\.jsonl/);
		assert.match(output, /Child 2 \(reviewer\): ↑30 ↓15 \$0\.0050/);
		assert.match(output, /Children: ↑50 ↓25 \$0\.0090/);
		assert.match(output, /Total: ↑150 ↓75 \$0\.0120/);
	});
});

describe("subagent profiles slash commands", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	it("lists saved profiles", async () => {
		await withIsolatedHome(async () => {
			const profilesDir = path.join(process.env.HOME!, ".pi", "agent", "profiles", "pi-subagents");
			fs.mkdirSync(profilesDir, { recursive: true });
			fs.writeFileSync(path.join(profilesDir, "openai-codex.quota.json"), JSON.stringify({ subagents: { agentOverrides: {} } }));
			fs.writeFileSync(path.join(profilesDir, "openai-codex.quality.json"), JSON.stringify({ subagents: { agentOverrides: {} } }));
			const sent: unknown[] = [];
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				registerCommand(name: string, spec: RegisteredSlashCommand) {
					commands.set(name, spec);
				},
				registerShortcut() {},
				sendMessage(message: unknown) { sent.push(message); },
			};
			registerSlashCommands!(pi, createState(process.cwd()));
			await commands.get("subagents-profiles")!.handler("", createCommandContext());
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /openai-codex\.quota/);
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /openai-codex\.quality/);
		});
	});

	it("loads a saved profile into user settings", async () => {
		await withIsolatedHome(async () => {
			const profilesDir = path.join(process.env.HOME!, ".pi", "agent", "profiles", "pi-subagents");
			fs.mkdirSync(profilesDir, { recursive: true });
			fs.writeFileSync(path.join(profilesDir, "openai-codex.quota.json"), JSON.stringify({
				subagents: { agentOverrides: {
					scout: { model: "openai-codex/gpt-5.3-codex-spark" },
					worker: { model: "openai-codex/gpt-5.4" },
				} },
			}, null, 2));
			const sent: unknown[] = [];
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
				registerShortcut() {},
				sendMessage(message: unknown) { sent.push(message); },
			};
			registerSlashCommands!(pi, createState(process.cwd()));
			await commands.get("subagents-load-profile")!.handler("openai-codex.quota", createCommandContext());
			const settings = JSON.parse(fs.readFileSync(path.join(process.env.HOME!, ".pi", "agent", "settings.json"), "utf-8"));
			assert.equal(settings.subagents.agentOverrides.scout.model, "openai-codex/gpt-5.3-codex-spark");
			assert.equal(settings.subagents.agentOverrides.worker.model, "openai-codex/gpt-5.4");
			assert.doesNotMatch(String((sent[0] as { content?: unknown }).content ?? ""), /run \/reload/);
		});
	});

	it("can switch the current session model to the loaded profile worker model", async () => {
		await withIsolatedHome(async () => {
			const profilesDir = path.join(process.env.HOME!, ".pi", "agent", "profiles", "pi-subagents");
			fs.mkdirSync(profilesDir, { recursive: true });
			fs.writeFileSync(path.join(profilesDir, "openai-codex.quota.json"), JSON.stringify({
				subagents: { agentOverrides: { worker: { model: "gpt-5.4:high" } } },
			}, null, 2));
			const sent: unknown[] = [];
			const commands = new Map<string, RegisteredSlashCommand>();
			let setModelArg: unknown;
			const resolvedModel = { provider: "openai-codex", id: "gpt-5.4" };
			const pi = {
				events: createEventBus(),
				async setModel(model: unknown) { setModelArg = model; return true; },
				registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
				registerShortcut() {},
				sendMessage(message: unknown) { sent.push(message); },
			};
			registerSlashCommands!(pi as never, createState(process.cwd()));
			await commands.get("subagents-load-profile")!.handler("openai-codex.quota", createCommandContext({
				confirm: async () => true,
				modelRegistry: {
					getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.4" }],
					find: (provider, id) => provider === "openai-codex" && id === "gpt-5.4" ? resolvedModel : undefined,
				},
			}) as never);
			assert.equal(setModelArg, resolvedModel);
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /Current session model switched to: openai-codex\/gpt-5.4/);
		});
	});

	it("refreshes a provider model catalog", async () => {
		await withIsolatedHome(async () => {
			const sent: unknown[] = [];
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				exec: async () => ({ stdout: "OK\n", stderr: "", code: 0, killed: false }),
				registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
				registerShortcut() {},
				sendMessage(message: unknown) { sent.push(message); },
			};
			registerSlashCommands!(pi, createState(process.cwd()));
			await commands.get("subagents-refresh-provider-models")!.handler("openai-codex", createCommandContext({
				cwd: process.cwd(),
				modelRegistry: {
					getAvailable: () => [
						{ provider: "openai-codex", id: "gpt-5.3-codex-spark", reasoning: true },
						{ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true },
					],
				},
			}) as never);
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /Provider: openai-codex/);
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /Warning: 2 models were classified with name heuristics fallback\./);
			assert.equal(fs.existsSync(path.join(process.env.HOME!, ".pi", "agent", "profiles", "pi-subagents", "providers", "openai-codex.models.json")), true);
		});
	});

	it("generates provider profiles", async () => {
		await withIsolatedHome(async () => {
			const sent: unknown[] = [];
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				exec: async () => ({ stdout: "OK\n", stderr: "", code: 0, killed: false }),
				registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
				registerShortcut() {},
				sendMessage(message: unknown) { sent.push(message); },
			};
			registerSlashCommands!(pi, createState(process.cwd()));
			await commands.get("subagents-generate-profiles")!.handler("openai-codex", createCommandContext({
				modelRegistry: {
					getAvailable: () => [
						{ provider: "openai-codex", id: "gpt-5.3-codex-spark", reasoning: true },
						{ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true },
						{ provider: "openai-codex", id: "gpt-5.4", reasoning: true },
						{ provider: "openai-codex", id: "gpt-5.5", reasoning: true },
					],
				},
			}) as never);
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /Generated subagent profiles/);
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /Warning: generated profiles depend on heuristic-only classification for 4 selected models\./);
			assert.equal(fs.existsSync(path.join(process.env.HOME!, ".pi", "agent", "profiles", "pi-subagents", "openai-codex.quota.json")), true);
			assert.equal(fs.existsSync(path.join(process.env.HOME!, ".pi", "agent", "profiles", "pi-subagents", "openai-codex.quality.json")), true);
		});
	});

	it("checks a profile", async () => {
		await withIsolatedHome(async () => {
			const profilesDir = path.join(process.env.HOME!, ".pi", "agent", "profiles", "pi-subagents");
			fs.mkdirSync(profilesDir, { recursive: true });
			fs.writeFileSync(path.join(profilesDir, "demo.json"), JSON.stringify({
				subagents: { agentOverrides: { scout: { model: "openai-codex/gpt-5.3-codex-spark" } } },
			}, null, 2));
			const sent: unknown[] = [];
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				exec: async () => ({ stdout: "OK\n", stderr: "", code: 0, killed: false }),
				registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
				registerShortcut() {},
				sendMessage(message: unknown) { sent.push(message); },
			};
			registerSlashCommands!(pi, createState(process.cwd()));
			await commands.get("subagents-check-profile")!.handler("demo", createCommandContext({
				modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.3-codex-spark" }] },
			}) as never);
			assert.match(String((sent[0] as { content?: unknown }).content ?? ""), /probe ok/);
		});
	});

	it("suggests provider names for refresh and generate commands", async () => {
		await withIsolatedHome(async () => {
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
				registerShortcut() {},
				sendMessage(_message: unknown) {},
			};
			const state = createState(process.cwd());
			state.lastUiContext = createCommandContext({
				modelRegistry: {
					getAvailable: () => [
						{ provider: "openai-codex", id: "gpt-5.4" },
						{ provider: "openai", id: "gpt-5" },
						{ provider: "anthropic", id: "claude-sonnet-4" },
					],
				},
			}) as never;
			registerSlashCommands!(pi, state);
			const refresh = commands.get("subagents-refresh-provider-models")!.getArgumentCompletions!("open") as Array<{ value: string; label: string }>;
			const generate = commands.get("subagents-generate-profiles")!.getArgumentCompletions!("an") as Array<{ value: string; label: string }>;
			assert.deepEqual(refresh.map((entry) => entry.value), ["openai", "openai-codex"]);
			assert.deepEqual(generate.map((entry) => entry.value), ["anthropic"]);
		});
	});
});

describe("subagents-doctor slash command", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("routes to the doctor tool action", async () => {
		const { params } = await captureSlashCommandParams("subagents-doctor", "", process.cwd());
		assert.deepEqual(params, { action: "doctor" });
	});

	it("keeps the textual fleet status fallback when no UI is available", async () => {
		const { params } = await captureSlashCommandParams("subagents-fleet", "", process.cwd());
		assert.deepEqual(params, { action: "status", view: "fleet" });
	});

	it("opens the native fleet from both the slash command and direct shortcut", async () => {
		const commands = new Map<string, RegisteredSlashCommand>();
		const shortcuts = new Map<string, { description: string; handler(ctx: unknown): Promise<void> }>();
		let opened = 0;
		let rendered = "";
		const custom = async (factory: unknown, options: unknown) => {
			opened++;
			const component = (factory as (tui: unknown, theme: unknown, keybindings: unknown, done: (value: undefined) => void) => { render(width: number): string[]; dispose(): void })(
				{ terminal: { rows: 30, columns: 100 }, requestRender() {} },
				{ fg: (_name: string, text: string) => text, bold: (text: string) => text },
				undefined,
				() => {},
			);
			rendered = component.render(100).join("\n");
			component.dispose();
			assert.deepEqual(options, { overlay: true, overlayOptions: { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 } });
			return undefined;
		};
		const pi = {
			events: createEventBus(),
			registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
			registerShortcut(key: string, spec: { description: string; handler(ctx: unknown): Promise<void> }) { shortcuts.set(key, spec); },
			sendMessage(_message: unknown) {},
		};
		const state = createState(process.cwd());
		const ctx = createCommandContext({ hasUI: true, custom });
		registerSlashCommands!(pi, state);

		await commands.get("subagents-fleet")!.handler("", ctx);
		assert.equal(shortcuts.size, 1);
		const shortcut = [...shortcuts.values()][0]!;
		assert.equal(shortcut.description, "Open subagent fleet inspector");
		await shortcut.handler(ctx);

		assert.equal(opened, 2);
		assert.match(rendered, /Subagent fleet/);
		assert.match(rendered, /inspection only/);
	});

	it("routes subagents-stop with an id directly to the stop action", async () => {
		const { params } = await captureSlashCommandParams("subagents-stop", "run-123", process.cwd());
		assert.deepEqual(params, { action: "stop", id: "run-123" });
	});

	it("prints exact stop commands when subagents-stop has no UI", async () => {
		await withIsolatedHome(async () => {
			const runId = `slash-stop-${Date.now().toString(36)}`;
			const asyncDir = path.join(ASYNC_DIR, runId);
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				sessionId: "session-test",
				mode: "single",
				state: "running",
				pid: process.pid,
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running", startedAt: Date.now() }],
			}, null, 2));
			try {
				const sent: unknown[] = [];
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
					registerShortcut() {},
					sendMessage(message: unknown) { sent.push(message); },
				};
				const state = createState(process.cwd());
				state.currentSessionId = "session-test";
				registerSlashCommands!(pi, state);
				await commands.get("subagents-stop")!.handler("", createCommandContext({ hasUI: false }));

				const content = String((sent[0] as { content?: unknown }).content ?? "");
				assert.match(content, new RegExp(`subagent\\({ action: "stop", id: "${runId}" }\\)`));
				assert.match(content, new RegExp(`/subagents-stop ${runId}`));
			} finally {
				fs.rmSync(asyncDir, { recursive: true, force: true });
			}
		});
	});

	it("prints cancel commands for scheduled subagent runs when subagents-stop has no UI", async () => {
		await withIsolatedHome(async () => {
			await withTempProject("pi-slash-stop-scheduled-", async (root) => {
				const storePath = scheduledRunStorePath(root, "session-test");
				fs.mkdirSync(path.dirname(storePath), { recursive: true });
				fs.writeFileSync(storePath, JSON.stringify({
					version: 1,
					cwd: root,
					sessionId: "session-test",
					jobs: [{
						id: "job-1",
						name: "nightly scout",
						schedule: "+10m",
						runAt: Date.now() + 600_000,
						state: "scheduled",
						createdAt: Date.now(),
						updatedAt: Date.now(),
						cwd: root,
						sessionId: "session-test",
						params: { agent: "scout", task: "later", async: true },
					}],
				}, null, 2));
				const sent: unknown[] = [];
				const commands = new Map<string, RegisteredSlashCommand>();
				const state = createState(root);
				state.currentSessionId = "session-test";
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
					registerShortcut() {},
					sendMessage(message: unknown) { sent.push(message); },
				};
				registerSlashCommands!(pi, state);
				await commands.get("subagents-stop")!.handler("", createCommandContext({ cwd: root, hasUI: false }));

				const content = String((sent[0] as { content?: unknown }).content ?? "");
				assert.match(content, /job-1 · nightly scout/);
				assert.match(content, /cancel scheduled run: subagent\({ action: "schedule-cancel", id: "job-1" }\)/);
				assert.doesNotMatch(content, /\/subagents-stop job-1/);
			});
		});
	});

	it("routes selected scheduled subagents-stop targets through schedule-cancel", async () => {
		await withIsolatedHome(async () => {
			await withTempProject("pi-slash-stop-selected-scheduled-", async (root) => {
				const storePath = scheduledRunStorePath(root, "session-test");
				fs.mkdirSync(path.dirname(storePath), { recursive: true });
				fs.writeFileSync(storePath, JSON.stringify({
					version: 1,
					cwd: root,
					sessionId: "session-test",
					jobs: [{
						id: "job-2",
						name: "delayed worker",
						schedule: "+10m",
						runAt: Date.now() + 600_000,
						state: "scheduled",
						createdAt: Date.now(),
						updatedAt: Date.now(),
						cwd: root,
						sessionId: "session-test",
						params: { agent: "worker", task: "later", async: true },
					}],
				}, null, 2));

				const commands = new Map<string, RegisteredSlashCommand>();
				const events = createEventBus();
				let requestedParams: unknown;
				events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
					const payload = data as { requestId: string; params?: unknown };
					requestedParams = payload.params;
					events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
					events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
						requestId: payload.requestId,
						result: { content: [{ type: "text", text: "cancelled" }], details: { mode: "management", results: [] } },
						isError: false,
					});
				});
				const state = createState(root);
				state.currentSessionId = "session-test";
				const pi = {
					events,
					registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
					registerShortcut() {},
					sendMessage(_message: unknown) {},
				};
				registerSlashCommands!(pi, state);
				await commands.get("subagents-stop")!.handler("", createCommandContext({
					cwd: root,
					hasUI: true,
					custom: async () => ({
						confirmed: true,
						target: { kind: "scheduled", id: "job-2", label: "job-2", detail: "scheduled", actionLabel: "cancel scheduled run" },
					}),
				}));

				assert.deepEqual(requestedParams, { action: "schedule-cancel", id: "job-2" });
			});
		});
	});

	it("prints fallback text instead of opening or enumerating the selector in child-safe fanout mode", async () => {
		await withIsolatedHome(async () => {
			const previous = process.env[SUBAGENT_FANOUT_CHILD_ENV];
			const runId = `slash-stop-child-safe-${Date.now().toString(36)}`;
			const asyncDir = path.join(ASYNC_DIR, runId);
			process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				sessionId: "session-test",
				mode: "single",
				state: "running",
				pid: process.pid,
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running", startedAt: Date.now() }],
			}, null, 2));
			try {
				const sent: unknown[] = [];
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
					registerShortcut() {},
					sendMessage(message: unknown) { sent.push(message); },
				};
				const state = createState(process.cwd());
				state.currentSessionId = "session-test";
				registerSlashCommands!(pi, state);
				await commands.get("subagents-stop")!.handler("", createCommandContext({ hasUI: true }));

				const content = String((sent[0] as { content?: unknown }).content ?? "");
				assert.match(content, /Selector unavailable in child-safe fanout mode\./);
				assert.doesNotMatch(content, new RegExp(runId));
			} finally {
				fs.rmSync(asyncDir, { recursive: true, force: true });
				if (previous === undefined) delete process.env[SUBAGENT_FANOUT_CHILD_ENV];
				else process.env[SUBAGENT_FANOUT_CHILD_ENV] = previous;
			}
		});
	});

	it("does not register the removed subagents-status overlay command", async () => {
		await withIsolatedHome(async () => {
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				registerCommand(name: string, spec: RegisteredSlashCommand) {
					commands.set(name, spec);
				},
				registerShortcut() {},
				sendMessage(_message: unknown) {},
			};

			registerSlashCommands!(pi, createState(process.cwd()));
			assert.equal(commands.has("subagents-status"), false);
		});
	});

});
