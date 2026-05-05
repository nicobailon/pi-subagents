import assert from "node:assert/strict";
import { describe, it } from "node:test";

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

let registerSlashCommands: RegisterSlashCommandsModule["registerSlashCommands"];
let available = true;
try {
	({ registerSlashCommands } = await import("./slash-commands.ts") as RegisterSlashCommandsModule);
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

function createCommandContext(hasUI = false, statusEvents?: Array<string | undefined>) {
	return {
		cwd: process.cwd(),
		hasUI,
		ui: {
			notify: (_message: string) => {},
			setStatus: (_key: string, text: string | undefined) => { statusEvents?.push(text); },
			onTerminalInput: () => () => {},
			custom: async () => undefined,
		},
		modelRegistry: { getAvailable: () => [] },
	};
}

function assertSlashMessage(
	message: unknown,
	{
		content,
		display,
		expectedResultDetails,
	}: { content: string; display: boolean; expectedResultDetails?: unknown },
) {
	const m = message as {
		customType?: string;
		content?: string;
		display?: boolean;
		details?: { requestId?: string; result?: { content?: Array<{ type?: string; text?: string }>; details?: unknown } };
	};
	assert.equal(m.customType, SLASH_RESULT_TYPE);
	assert.equal(m.content, content);
	assert.equal(m.display, display);
	assert.equal(typeof m.details?.requestId, "string");
	assert.equal(m.details?.result?.content?.[0]?.text, content);
	if (expectedResultDetails !== undefined) {
		assert.deepEqual(m.details?.result?.details, expectedResultDetails);
	}
}

describe("slash command custom message delivery", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	it("registers /subagents as the administration command", () => {
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const pi = {
			events: createEventBus(),
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage() {},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		assert.equal(commands.has("subagents"), true);
		assert.equal(commands.has("agents"), true);
	});

	it("/run sends an inline slash result message after a successful bridge response", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "Scout finished" }],
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
		await commands.get("run")!.handler("scout inspect this", createCommandContext());

		assert.equal(sent.length, 1);
		assertSlashMessage(sent[0], {
			content: "Scout finished",
			display: true,
			expectedResultDetails: { mode: "single", results: [] },
		});
	});

	it("/run sends a visible live message and hidden final snapshot when UI rendering is available", async () => {
		const sent: unknown[] = [];
		const statusEvents: Array<string | undefined> = [];
		const timeline: string[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "Scout finished" }],
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
				timeline.push((message as { display?: boolean }).display === false ? "hidden-message" : "visible-message");
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		const ctx = createCommandContext(true, statusEvents);
		const originalSetStatus = ctx.ui.setStatus;
		ctx.ui.setStatus = (key: string, text: string | undefined) => {
			originalSetStatus(key, text);
			timeline.push(text === undefined ? "status-clear" : "status-set");
		};
		await commands.get("run")!.handler("scout inspect this", ctx);

		assert.equal(sent.length, 2);
		assertSlashMessage(sent[0], { content: "inspect this", display: true, expectedResultDetails: undefined });
		assertSlashMessage(sent[1], {
			content: "Scout finished",
			display: false,
			expectedResultDetails: { mode: "single", results: [] },
		});
		assert.deepEqual(statusEvents, ["running...", undefined]);
		assert.deepEqual(timeline, ["visible-message", "status-set", "hidden-message", "status-clear"]);
	});

	it("/run still sends an inline slash result message when the bridge returns an error", async () => {
		const sent: unknown[] = [];
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
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout inspect this", createCommandContext());

		assert.equal(sent.length, 1);
		assertSlashMessage(sent[0], {
			content: "Subagent failed",
			display: true,
			expectedResultDetails: { mode: "single", results: [] },
		});
	});
});
