import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

const SLASH_RESULT_TYPE = "subagent-slash-result";
const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";

interface EventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

interface RegisterSlashCommandsModule {
	registerSlashCommands?: (
		pi: {
			events: EventBus;
			registerCommand(
				name: string,
				spec: { handler(args: string, ctx: unknown): Promise<void>; getArgumentCompletions?: (prefix: string) => unknown },
			): void;
			registerShortcut(key: string, spec: { handler(ctx: unknown): Promise<void> }): void;
			sendMessage(message: unknown): void;
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
	clearSlashSnapshots?: typeof import("../../slash-live-state.ts").clearSlashSnapshots;
	getSlashRenderableSnapshot?: typeof import("../../slash-live-state.ts").getSlashRenderableSnapshot;
	resolveSlashMessageDetails?: typeof import("../../slash-live-state.ts").resolveSlashMessageDetails;
}

let registerSlashCommands: RegisterSlashCommandsModule["registerSlashCommands"];
let clearSlashSnapshots: SlashLiveStateModule["clearSlashSnapshots"];
let getSlashRenderableSnapshot: SlashLiveStateModule["getSlashRenderableSnapshot"];
let resolveSlashMessageDetails: SlashLiveStateModule["resolveSlashMessageDetails"];
let available = true;
try {
	({ registerSlashCommands } = await import("../../slash-commands.ts") as RegisterSlashCommandsModule);
	({ clearSlashSnapshots, getSlashRenderableSnapshot, resolveSlashMessageDetails } = await import("../../slash-live-state.ts") as SlashLiveStateModule);
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
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

async function captureAgentManagerParams(result: unknown): Promise<unknown> {
	return withIsolatedHome(async () => {
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
					content: [{ type: "text", text: "manager finished" }],
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
			sendMessage(_message: unknown) {},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("agents")!.handler("", createCommandContext({ custom: async () => result }));
		return requestedParams;
	});
}

function createCommandContext(
	overrides: Partial<{
		hasUI: boolean;
		custom: (...args: unknown[]) => Promise<unknown>;
		setStatus: (key: string, text: string | undefined) => void;
		sessionManager: unknown;
	}> = {},
) {
	return {
		cwd: process.cwd(),
		hasUI: overrides.hasUI ?? false,
		ui: {
			notify: (_message: string) => {},
			setStatus: overrides.setStatus ?? ((_key: string, _text: string | undefined) => {}),
			onTerminalInput: () => () => {},
			custom: overrides.custom ?? (async () => undefined),
		},
		modelRegistry: { getAvailable: () => [] },
		sessionManager: overrides.sessionManager,
	};
}

describe("slash command custom message delivery", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("/run accepts an agent without a task", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let requestedParams: unknown;
		const sessionManager = {
			flushed: false,
			rewrites: 0,
			getSessionFile: () => "session.jsonl",
			_rewriteFile() {
				this.rewrites++;
			},
		};
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown };
			requestedParams = payload.params;
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

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout", createCommandContext({ sessionManager }));

		assert.deepEqual(requestedParams, { agent: "scout", task: "", clarify: false, agentScope: "both" });
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
		assert.equal((sent[1] as { display?: boolean }).display, true);
		assert.match((sent[1] as { content?: string }).content ?? "", /Scout finished/);
		assert.match((sent[1] as { content?: string }).content ?? "", /Child session exports\n\n- `\/tmp\/child-session\.jsonl`/);
		assert.deepEqual(log, ["send:visible", "status:running...", "send:visible", "status:clear"]);

		const visibleDetails = resolveSlashMessageDetails!((sent[0] as { details?: unknown }).details);
		assert.ok(visibleDetails);
		const visibleSnapshot = getSlashRenderableSnapshot!(visibleDetails!);
		assert.equal((visibleSnapshot.result.content[0] as { text?: string }).text, "Scout finished");
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
		assert.equal((sent[1] as { display?: boolean }).display, true);
		assert.match((sent[1] as { content?: string }).content ?? "", /Subagent failed/);
		assert.deepEqual(log, ["send:visible", "status:running...", "send:visible", "status:clear"]);

		const visibleDetails = resolveSlashMessageDetails!((sent[0] as { details?: unknown }).details);
		assert.ok(visibleDetails);
		const visibleSnapshot = getSlashRenderableSnapshot!(visibleDetails!);
		assert.equal((visibleSnapshot.result.content[0] as { text?: string }).text, "Subagent failed");
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

describe("agent manager slash routing", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("maps fork and background manager toggles to context and async without clarify", async () => {
		const params = await captureAgentManagerParams({
			action: "launch",
			agent: "scout",
			task: "Investigate",
			skipClarify: false,
			fork: true,
			background: true,
		});

		assert.deepEqual(params, {
			agent: "scout",
			task: "Investigate",
			clarify: false,
			agentScope: "both",
			context: "fork",
			async: true,
		});
	});

	it("keeps clarify enabled for foreground non-quick manager launches", async () => {
		const params = await captureAgentManagerParams({
			action: "launch",
			agent: "scout",
			task: "Investigate",
			skipClarify: false,
		});

		assert.deepEqual(params, {
			agent: "scout",
			task: "Investigate",
			clarify: true,
			agentScope: "both",
		});
	});

	it("maps worktree to top-level parallel manager launches", async () => {
		const params = await captureAgentManagerParams({
			action: "parallel",
			tasks: [
				{ agent: "scout", task: "Review A" },
				{ agent: "reviewer", task: "Review B" },
			],
			skipClarify: true,
			fork: true,
			background: true,
			worktree: true,
		});

		assert.deepEqual(params, {
			tasks: [
				{ agent: "scout", task: "Review A" },
				{ agent: "reviewer", task: "Review B" },
			],
			clarify: false,
			agentScope: "both",
			context: "fork",
			async: true,
			worktree: true,
		});
	});

	it("sets worktree only on existing saved-chain parallel steps", async () => {
		const params = await captureAgentManagerParams({
			action: "launch-chain",
			chain: {
				name: "mixed",
				description: "Mixed chain",
				source: "user",
				filePath: "/tmp/mixed.chain.md",
				steps: [
					{ agent: "scout", task: "Scout" },
					{ parallel: [{ agent: "reviewer", task: "Review" }, { agent: "worker", task: "Build" }] },
				],
			},
			task: "Shared",
			skipClarify: true,
			worktree: true,
		});

		assert.ok(params && typeof params === "object");
		const routed = params as { chain?: unknown; task?: unknown; clarify?: unknown; agentScope?: unknown };
		assert.equal(routed.task, "Shared");
		assert.equal(routed.clarify, false);
		assert.equal(routed.agentScope, "both");
		assert.ok(Array.isArray(routed.chain));
		const [sequentialStep, parallelStep] = routed.chain;
		assert.ok(sequentialStep && typeof sequentialStep === "object");
		assert.equal((sequentialStep as { agent?: unknown }).agent, "scout");
		assert.equal((sequentialStep as { task?: unknown }).task, "Scout");
		assert.equal("worktree" in sequentialStep, false);
		assert.deepEqual(parallelStep, {
			parallel: [{ agent: "reviewer", task: "Review" }, { agent: "worker", task: "Build" }],
			worktree: true,
		});
	});
});

describe("subagents-status slash command", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("opens the async status overlay", async () => {
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let customCalls = 0;
		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(_message: unknown) {},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		assert.ok(commands.has("subagents-status"));

		await commands.get("subagents-status")!.handler("", createCommandContext({
			hasUI: true,
			custom: async () => {
				customCalls++;
				return undefined;
			},
		}));

		assert.equal(customCalls, 1);
	});
});
