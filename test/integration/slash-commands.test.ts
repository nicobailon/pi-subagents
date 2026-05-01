import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

import { ASYNC_DIR } from "../../src/shared/types.ts";

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

let registerSlashCommands: RegisterSlashCommandsModule["registerSlashCommands"];
let clearSlashSnapshots: SlashLiveStateModule["clearSlashSnapshots"];
let getSlashRenderableSnapshot: SlashLiveStateModule["getSlashRenderableSnapshot"];
let resolveSlashMessageDetails: SlashLiveStateModule["resolveSlashMessageDetails"];
let available = true;
try {
	({ registerSlashCommands } = await import("../../src/slash/slash-commands.ts") as RegisterSlashCommandsModule);
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
		cwd: string;
		hasUI: boolean;
		custom: (...args: unknown[]) => Promise<unknown>;
		notify: (message: string, type?: string) => void;
		setStatus: (key: string, text: string | undefined) => void;
		sessionManager: unknown;
	}> = {},
) {
	return {
		cwd: overrides.cwd ?? process.cwd(),
		hasUI: overrides.hasUI ?? false,
		ui: {
			notify: overrides.notify ?? ((_message: string) => {}),
			setStatus: overrides.setStatus ?? ((_key: string, _text: string | undefined) => {}),
			onTerminalInput: () => () => {},
			custom: overrides.custom ?? (async () => undefined),
		},
		modelRegistry: { getAvailable: () => [] },
		sessionManager: overrides.sessionManager ?? {
			getSessionFile: () => null,
			getSessionId: () => "session-test",
		},
	};
}

async function withTempProject<T>(prefix: string, fn: (root: string) => Promise<T>): Promise<T> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
	try {
		return await fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function writeProjectChain(root: string, fileName: string, content: string): void {
	fs.writeFileSync(path.join(root, ".pi", "agents", fileName), content, "utf-8");
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
				const userAgentsDir = path.join(os.homedir(), ".agents");
				fs.mkdirSync(userAgentsDir, { recursive: true });
				fs.writeFileSync(path.join(userAgentsDir, "review-flow.chain.md"), `---
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

describe("subagents-doctor slash command", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("routes to the doctor tool action", async () => {
		const { params } = await captureSlashCommandParams("subagents-doctor", "", process.cwd());
		assert.deepEqual(params, { action: "doctor" });
	});

});

describe("subagents-status slash command", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("opens the async status overlay scoped to the current session", async () => {
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		const sessionFile = path.join(os.tmpdir(), `pi-status-session-${Date.now()}.jsonl`);
		const currentId = `slash-current-${Date.now()}`;
		const otherId = `slash-other-${Date.now()}`;
		const writeRun = (id: string, sessionId: string) => {
			const dir = path.join(ASYNC_DIR, id);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
				runId: id,
				sessionId,
				mode: "single",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
		};
		let rendered = "";
		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(_message: unknown) {},
		};

		try {
			writeRun(currentId, sessionFile);
			writeRun(otherId, "session-other");
			registerSlashCommands!(pi, createState(process.cwd()));
			assert.ok(commands.has("subagents-status"));

			await commands.get("subagents-status")!.handler("", createCommandContext({
				hasUI: true,
				sessionManager: {
					getSessionFile: () => sessionFile,
					getSessionId: () => "session-current-id",
				},
				custom: async (factory: unknown) => {
					const component = (factory as (tui: unknown, theme: unknown, kb: unknown, done: (value?: unknown) => void) => { render(width: number): string[]; dispose(): void })(
						{ requestRender() {} },
						{ fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
						undefined,
						() => {},
					);
					try {
						rendered = component.render(120).join("\n");
					} finally {
						component.dispose();
					}
					return undefined;
				},
			}));

			assert.match(rendered, new RegExp(currentId));
			assert.doesNotMatch(rendered, new RegExp(otherId));
		} finally {
			fs.rmSync(path.join(ASYNC_DIR, currentId), { recursive: true, force: true });
			fs.rmSync(path.join(ASYNC_DIR, otherId), { recursive: true, force: true });
		}
	});
});
