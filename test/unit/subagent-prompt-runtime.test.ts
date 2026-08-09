import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { consumeSteerAcks, writeSteerRequestToDir } from "../../src/runs/background/control-channel.ts";
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_ORCHESTRATOR_TARGET_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_STEER_ACK_DIR_ENV,
	SUBAGENT_STEER_CAPABILITY_ENV,
	SUBAGENT_STEER_INBOX_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { RUNTIME_EXTENSION_ACK_EVENT, RUNTIME_EXTENSION_ACK_PATH_ENV } from "../../src/runs/shared/runtime-acknowledged-extensions.ts";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from "../../src/runs/shared/structured-output.ts";
import { TOOL_BUDGET_ENV } from "../../src/runs/shared/tool-budget.ts";
import { PERMISSION_POLICY_ENV } from "../../src/runs/shared/permissions.ts";
import { CHILD_TOOL_DIAGNOSTIC_PATH_ENV, formatChildToolDiagnostic, MCP_DIRECT_CHILD_TOOLS_ENV, readChildToolDiagnostic, REQUIRED_CHILD_TOOLS_ENV } from "../../src/runs/shared/tool-availability.ts";
import { CHILD_WATCHDOG_CONFIG_ENV } from "../../src/watchdog/child-status.ts";
import { SUBAGENT_WATCHDOG_WARNING_TYPE } from "../../src/watchdog/types.ts";
import registerSubagentPromptRuntime, {
	CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	SUBAGENT_INTERCOM_SESSION_NAME_ENV,
	registerPermissionGate,
	registerSteeringInbox,
	rewriteSubagentPrompt,
	stripInheritedSkills,
	stripParentOnlySubagentMessages,
	stripProjectContext,
	stripSubagentOrchestrationSkill,
} from "../../src/runs/shared/subagent-prompt-runtime.ts";

const envSnapshot = {
	PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT,
	PI_SUBAGENT_INHERIT_SKILLS: process.env.PI_SUBAGENT_INHERIT_SKILLS,
	PI_SUBAGENT_INTERCOM_SESSION_NAME: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
	PI_SUBAGENT_FANOUT_CHILD: process.env.PI_SUBAGENT_FANOUT_CHILD,
	PI_SUBAGENT_STEER_INBOX: process.env.PI_SUBAGENT_STEER_INBOX,
	PI_SUBAGENT_STEER_CAPABILITY: process.env.PI_SUBAGENT_STEER_CAPABILITY,
	PI_SUBAGENT_STEER_ACK_DIR: process.env.PI_SUBAGENT_STEER_ACK_DIR,
	PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE: process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE,
	PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA: process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA,
	PI_SUBAGENT_RUNTIME_ACKNOWLEDGED_EXTENSIONS: process.env.PI_SUBAGENT_RUNTIME_ACKNOWLEDGED_EXTENSIONS,
	PI_SUBAGENT_TOOL_BUDGET: process.env.PI_SUBAGENT_TOOL_BUDGET,
	PI_SUBAGENT_PERMISSION_POLICY: process.env.PI_SUBAGENT_PERMISSION_POLICY,
	PI_SUBAGENT_REQUIRED_TOOLS: process.env.PI_SUBAGENT_REQUIRED_TOOLS,
	PI_SUBAGENT_MCP_DIRECT_TOOLS: process.env.PI_SUBAGENT_MCP_DIRECT_TOOLS,
	PI_SUBAGENT_TOOL_DIAGNOSTIC_PATH: process.env.PI_SUBAGENT_TOOL_DIAGNOSTIC_PATH,
	PI_SUBAGENT_ORCHESTRATOR_TARGET: process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET,
	PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID,
	PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR: process.env.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR,
	PI_SUBAGENT_RUN_ID: process.env.PI_SUBAGENT_RUN_ID,
	PI_SUBAGENT_CHILD_AGENT: process.env.PI_SUBAGENT_CHILD_AGENT,
	PI_SUBAGENT_CHILD_INDEX: process.env.PI_SUBAGENT_CHILD_INDEX,
	PI_SUBAGENT_WATCHDOG_CHILD_CONFIG: process.env.PI_SUBAGENT_WATCHDOG_CHILD_CONFIG,
};

const SKILLS_SECTION = "\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>safe-bash</name>\n    <description>desc</description>\n    <location>/tmp/SKILL.md</location>\n  </skill>\n  <skill>\n    <name>pi-subagents</name>\n    <description>delegate to subagents</description>\n    <location>/tmp/pi-subagents/SKILL.md</location>\n  </skill>\n</available_skills>";

const BASE_PROMPT = [
	"You are a subagent.",
	"\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
	SKILLS_SECTION,
	"\nCurrent date: 2026-04-16",
	"\nCurrent working directory: /repo",
].join("");

const PROMPT_WITH_EXPLICIT_SKILL = [
	"You are a subagent.\n\n<skill name=\"explicit\">\nKeep this section\n</skill>",
	"\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
	SKILLS_SECTION,
	"\nCurrent date: 2026-04-16",
].join("");

const CONFIGURED_SKILLS_SECTION = "\n\nThe following configured skills are available to this subagent.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>configured-skill</name>\n    <description>explicit agent skill</description>\n    <location>/tmp/configured-skill/SKILL.md</location>\n  </skill>\n</available_skills>";

afterEach(() => {
	if (envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT === undefined) delete process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
	else process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
	if (envSnapshot.PI_SUBAGENT_INHERIT_SKILLS === undefined) delete process.env.PI_SUBAGENT_INHERIT_SKILLS;
	else process.env.PI_SUBAGENT_INHERIT_SKILLS = envSnapshot.PI_SUBAGENT_INHERIT_SKILLS;
	if (envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME === undefined) delete process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME;
	else process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME = envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME;
	if (envSnapshot.PI_SUBAGENT_FANOUT_CHILD === undefined) delete process.env.PI_SUBAGENT_FANOUT_CHILD;
	else process.env.PI_SUBAGENT_FANOUT_CHILD = envSnapshot.PI_SUBAGENT_FANOUT_CHILD;
	if (envSnapshot.PI_SUBAGENT_STEER_INBOX === undefined) delete process.env[SUBAGENT_STEER_INBOX_ENV];
	else process.env[SUBAGENT_STEER_INBOX_ENV] = envSnapshot.PI_SUBAGENT_STEER_INBOX;
	if (envSnapshot.PI_SUBAGENT_STEER_CAPABILITY === undefined) delete process.env[SUBAGENT_STEER_CAPABILITY_ENV];
	else process.env[SUBAGENT_STEER_CAPABILITY_ENV] = envSnapshot.PI_SUBAGENT_STEER_CAPABILITY;
	if (envSnapshot.PI_SUBAGENT_STEER_ACK_DIR === undefined) delete process.env[SUBAGENT_STEER_ACK_DIR_ENV];
	else process.env[SUBAGENT_STEER_ACK_DIR_ENV] = envSnapshot.PI_SUBAGENT_STEER_ACK_DIR;
	if (envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE === undefined) delete process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
	else process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
	if (envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA === undefined) delete process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
	else process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA;
	if (envSnapshot.PI_SUBAGENT_RUNTIME_ACKNOWLEDGED_EXTENSIONS === undefined) delete process.env[RUNTIME_EXTENSION_ACK_PATH_ENV];
	else process.env[RUNTIME_EXTENSION_ACK_PATH_ENV] = envSnapshot.PI_SUBAGENT_RUNTIME_ACKNOWLEDGED_EXTENSIONS;
	if (envSnapshot.PI_SUBAGENT_TOOL_BUDGET === undefined) delete process.env[TOOL_BUDGET_ENV];
	else process.env[TOOL_BUDGET_ENV] = envSnapshot.PI_SUBAGENT_TOOL_BUDGET;
	if (envSnapshot.PI_SUBAGENT_PERMISSION_POLICY === undefined) delete process.env[PERMISSION_POLICY_ENV];
	else process.env[PERMISSION_POLICY_ENV] = envSnapshot.PI_SUBAGENT_PERMISSION_POLICY;
	if (envSnapshot.PI_SUBAGENT_REQUIRED_TOOLS === undefined) delete process.env[REQUIRED_CHILD_TOOLS_ENV];
	else process.env[REQUIRED_CHILD_TOOLS_ENV] = envSnapshot.PI_SUBAGENT_REQUIRED_TOOLS;
	if (envSnapshot.PI_SUBAGENT_MCP_DIRECT_TOOLS === undefined) delete process.env[MCP_DIRECT_CHILD_TOOLS_ENV];
	else process.env[MCP_DIRECT_CHILD_TOOLS_ENV] = envSnapshot.PI_SUBAGENT_MCP_DIRECT_TOOLS;
	if (envSnapshot.PI_SUBAGENT_TOOL_DIAGNOSTIC_PATH === undefined) delete process.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV];
	else process.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV] = envSnapshot.PI_SUBAGENT_TOOL_DIAGNOSTIC_PATH;
	if (envSnapshot.PI_SUBAGENT_ORCHESTRATOR_TARGET === undefined) delete process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV];
	else process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = envSnapshot.PI_SUBAGENT_ORCHESTRATOR_TARGET;
	if (envSnapshot.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID === undefined) delete process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV];
	else process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = envSnapshot.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID;
	if (envSnapshot.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR === undefined) delete process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV];
	else process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = envSnapshot.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR;
	if (envSnapshot.PI_SUBAGENT_RUN_ID === undefined) delete process.env[SUBAGENT_RUN_ID_ENV];
	else process.env[SUBAGENT_RUN_ID_ENV] = envSnapshot.PI_SUBAGENT_RUN_ID;
	if (envSnapshot.PI_SUBAGENT_CHILD_AGENT === undefined) delete process.env[SUBAGENT_CHILD_AGENT_ENV];
	else process.env[SUBAGENT_CHILD_AGENT_ENV] = envSnapshot.PI_SUBAGENT_CHILD_AGENT;
	if (envSnapshot.PI_SUBAGENT_CHILD_INDEX === undefined) delete process.env[SUBAGENT_CHILD_INDEX_ENV];
	else process.env[SUBAGENT_CHILD_INDEX_ENV] = envSnapshot.PI_SUBAGENT_CHILD_INDEX;
	if (envSnapshot.PI_SUBAGENT_WATCHDOG_CHILD_CONFIG === undefined) delete process.env[CHILD_WATCHDOG_CONFIG_ENV];
	else process.env[CHILD_WATCHDOG_CONFIG_ENV] = envSnapshot.PI_SUBAGENT_WATCHDOG_CHILD_CONFIG;
});

function setSupervisorEnv(): void {
	process.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = "subagent-chat-parent";
	process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = "session-parent";
	process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = path.join(os.tmpdir(), "subagent-supervisor-runtime-test");
	process.env[SUBAGENT_RUN_ID_ENV] = "run-123";
	process.env[SUBAGENT_CHILD_AGENT_ENV] = "worker";
	process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
}

describe("subagent prompt runtime", () => {
	it("registers no permission hook by default and routes ask only to the watchdog arbiter", async () => {
		const handlers: Array<(event: { toolName?: string; input?: unknown }, ctx?: unknown) => unknown> = [];
		const pi = { on(event: string, handler: (event: { toolName?: string; input?: unknown }, ctx?: unknown) => unknown) { if (event === "tool_call") handlers.push(handler); } };
		delete process.env[PERMISSION_POLICY_ENV];
		registerPermissionGate(pi as never);
		assert.equal(handlers.length, 0);

		process.env[PERMISSION_POLICY_ENV] = JSON.stringify({ write: "deny" });
		registerPermissionGate(pi as never);
		assert.equal(handlers.length, 1);
		assert.equal(await handlers[0]!({ toolName: "bash", input: { command: "rm -rf /" } }), undefined);
		assert.equal(await handlers[0]!({ toolName: "contact_supervisor", input: {} }), undefined);
		assert.deepEqual(await handlers[0]!({ toolName: "write", input: {} }), {
			block: true,
			reason: "Blocked by pi-subagents permission rule: 'write' is denied.",
		});

		process.env[PERMISSION_POLICY_ENV] = JSON.stringify({ write: "ask" });
		const askHandlers: Array<(event: { toolName?: string; input?: unknown }, ctx: unknown) => unknown> = [];
		const requests: Array<{ toolName: string; args: unknown }> = [];
		registerPermissionGate({ on(event: string, handler: (event: { toolName?: string; input?: unknown }, ctx: unknown) => unknown) { if (event === "tool_call") askHandlers.push(handler); } } as never, async (request) => {
			requests.push({ toolName: request.toolName, args: request.args });
			return { approved: true, reason: "approved by watchdog", source: "watchdog" };
		});
		assert.equal(await askHandlers[0]!({ toolName: "write", input: { path: "out.txt" } }, { signal: undefined }), undefined);
		assert.deepEqual(requests, [{ toolName: "write", args: { path: "out.txt" } }]);
	});
	it("collects runtime extension acknowledgements until terminal serialization", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-runtime-ack-"));
		try {
			const outputPath = path.join(dir, "acks.json");
			process.env[RUNTIME_EXTENSION_ACK_PATH_ENV] = outputPath;
			const runtimeHandlers = new Map<string, Array<(payload?: unknown) => unknown>>();
			const extensionHandlers = new Map<string, Array<(payload?: unknown) => unknown>>();
			const pushHandler = (target: Map<string, Array<(payload?: unknown) => unknown>>, event: string, handler: (payload?: unknown) => unknown): void => {
				target.set(event, [...(target.get(event) ?? []), handler]);
			};
			const emitAll = (target: Map<string, Array<(payload?: unknown) => unknown>>, event: string, payload?: unknown): void => {
				for (const handler of target.get(event) ?? []) handler(payload);
			};

			registerSubagentPromptRuntime({
				events: { on(event: string, handler: (payload?: unknown) => unknown) { pushHandler(extensionHandlers, event, handler); } },
				on(event: string, handler: (payload?: unknown) => unknown) { pushHandler(runtimeHandlers, event, handler); },
			} as never);

			emitAll(extensionHandlers, RUNTIME_EXTENSION_ACK_EVENT, { id: "ext.one" });
			emitAll(extensionHandlers, RUNTIME_EXTENSION_ACK_EVENT, { id: "ext.one" });
			emitAll(extensionHandlers, RUNTIME_EXTENSION_ACK_EVENT, { id: "bad/path" });
			runtimeHandlers.get("agent_end")?.[0]?.({});
			emitAll(extensionHandlers, RUNTIME_EXTENSION_ACK_EVENT, { id: "late" });

			assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf-8")), {
				version: 1,
				source: "child-runtime",
				ids: ["ext.one"],
				omitted: 0,
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("nudges after the tool budget soft limit and blocks configured tools after hard", () => {
		const handlers = new Map<string, (payload: { toolName?: string }) => unknown>();
		const sent: string[] = [];
		process.env[TOOL_BUDGET_ENV] = JSON.stringify({ soft: 2, hard: 2, block: ["read"] });

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { toolName?: string }) => unknown) {
				handlers.set(event, handler);
			},
			sendUserMessage(content: string) {
				sent.push(content);
			},
		} as { on(event: string, handler: (payload: { toolName?: string }) => unknown): void; sendUserMessage(content: string): void });

		const toolCall = handlers.get("tool_call");
		assert.ok(toolCall, "tool_call handler should be registered");
		assert.equal(toolCall({ toolName: "grep" }), undefined);
		assert.equal(toolCall({ toolName: "grep" }), undefined);
		assert.equal(sent.length, 1);
		assert.match(sent[0] ?? "", /soft limit reached/);
		assert.deepEqual(toolCall({ toolName: "read" }), {
			block: true,
			reason: "Tool budget hard limit reached after 3 tool calls (hard 2). The 'read' tool is blocked so you can finalize from the context you already have.",
		});
		assert.equal(toolCall({ toolName: "write" }), undefined);
	});

	it("registers the native canonical steering inbox path", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-steering-watch-runtime-"));
		try {
			const inbox = path.join(dir, "steer");
			const nativeInbox = path.join(dir, "native-steer");
			process.env[SUBAGENT_STEER_INBOX_ENV] = inbox;
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			let watchedDir: fs.PathLike | undefined;
			const fakeWatcher = { on() { return fakeWatcher; }, close() {} } as fs.FSWatcher;

			registerSteeringInbox({
				on(event: string, handler: (payload?: unknown) => unknown) {
					handlers.set(event, handler);
				},
				sendUserMessage() {},
			} as { on(event: string, handler: (payload?: unknown) => unknown): void; sendUserMessage(): void }, {
				nativeRealpath(target) {
					assert.equal(target, inbox);
					return nativeInbox;
				},
				watch: ((target: fs.PathLike) => {
					watchedDir = target;
					return fakeWatcher;
				}) as typeof fs.watch,
			});

			handlers.get("session_start")?.({});
			assert.equal(watchedDir, nativeInbox);
			handlers.get("session_shutdown")?.({});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("delivers steering inbox requests as mid-run user messages", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-steering-runtime-"));
		try {
			const inbox = path.join(dir, "steer");
			process.env[SUBAGENT_STEER_INBOX_ENV] = inbox;
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			const sent: Array<{ content: string; options: { deliverAs: string } }> = [];

			registerSubagentPromptRuntime({
				on(event: string, handler: (payload?: unknown) => unknown) {
					handlers.set(event, handler);
				},
				sendUserMessage(content: string, options: { deliverAs: string }) {
					sent.push({ content, options });
				},
			} as { on(event: string, handler: (payload?: unknown) => unknown): void; sendUserMessage(content: string, options: { deliverAs: string }): void });

			writeSteerRequestToDir(inbox, { type: "steer", id: "steer-1", ts: 1, message: "Focus on tests." });
			handlers.get("message_start")?.({});
			handlers.get("session_shutdown")?.({});

			assert.equal(sent.length, 1);
			assert.equal(sent[0]?.options.deliverAs, "steer");
			assert.match(sent[0]?.content ?? "", /Mid-run steering/);
			assert.match(sent[0]?.content ?? "", /Focus on tests\./);
			assert.deepEqual(fs.readdirSync(inbox).filter((entry) => entry.endsWith(".json")), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("queues follow-ups and acknowledges delivery at the next turn boundary", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-follow-up-runtime-"));
		try {
			const inbox = path.join(dir, "inbox");
			process.env[SUBAGENT_STEER_INBOX_ENV] = inbox;
			process.env[SUBAGENT_STEER_CAPABILITY_ENV] = path.join(dir, "capability.json");
			process.env[SUBAGENT_STEER_ACK_DIR_ENV] = path.join(dir, "control", "steer-acks", "0");
			process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			const sent: Array<{ content: string; deliverAs?: string }> = [];
			registerSteeringInbox({
				on(event: string, handler: (payload?: unknown) => unknown) { handlers.set(event, handler); },
				sendUserMessage(content: string, options?: { deliverAs?: string }) { sent.push({ content, deliverAs: options?.deliverAs }); },
			} as never);
			handlers.get("session_start")?.({});
			handlers.get("agent_start")?.({});
			handlers.get("turn_start")?.({});
			writeSteerRequestToDir(inbox, { type: "steer", id: "follow", ts: 1, message: "Check docs.", mode: "follow_up" });
			handlers.get("message_start")?.({});
			assert.equal(sent[0]?.deliverAs, "followUp");
			handlers.get("input")?.({ source: "extension", streamingBehavior: "followUp", text: sent[0]?.content });
			assert.equal(consumeSteerAcks(dir)[0]?.state, "queued");
			handlers.get("turn_end")?.({});
			handlers.get("turn_start")?.({});
			const delivered = consumeSteerAcks(dir)[0];
			assert.equal(delivered?.state, "delivered");
			assert.equal(delivered?.deliveryStatus, "delivered");

			writeSteerRequestToDir(inbox, { type: "steer", id: "auto-mid", ts: 2, message: "Mid-turn auto.", mode: "auto" });
			handlers.get("message_start")?.({});
			assert.equal(sent[1]?.deliverAs, "followUp");
			handlers.get("input")?.({ source: "extension", streamingBehavior: "followUp", text: sent[1]?.content });
			assert.equal(consumeSteerAcks(dir)[0]?.state, "queued");
			handlers.get("turn_end")?.({});
			handlers.get("turn_start")?.({});
			assert.equal(consumeSteerAcks(dir)[0]?.state, "delivered");

			handlers.get("turn_end")?.({});
			writeSteerRequestToDir(inbox, { type: "steer", id: "auto-idle", ts: 3, message: "Between-turn auto.", mode: "auto" });
			handlers.get("message_start")?.({});
			assert.equal(sent[2]?.deliverAs, "steer");
			handlers.get("input")?.({ source: "extension", streamingBehavior: "steer", text: sent[2]?.content });
			assert.equal(consumeSteerAcks(dir)[0]?.deliveryStatus, "delivered");

			writeSteerRequestToDir(inbox, { type: "steer", id: "undelivered", ts: 4, message: "Never reached.", mode: "follow_up" });
			handlers.get("message_start")?.({});
			handlers.get("input")?.({ source: "extension", streamingBehavior: "followUp", text: sent[3]?.content });
			assert.equal(consumeSteerAcks(dir)[0]?.state, "queued");
			handlers.get("session_shutdown")?.({});
			const failed = consumeSteerAcks(dir)[0];
			assert.equal(failed?.state, "failed");
			assert.match(failed?.message ?? "", /ended before queued follow-up/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("queues auto steering after agent_end until agent_settled", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-settled-steering-runtime-"));
		try {
			const inbox = path.join(dir, "inbox");
			process.env[SUBAGENT_STEER_INBOX_ENV] = inbox;
			process.env[SUBAGENT_STEER_ACK_DIR_ENV] = path.join(dir, "control", "steer-acks", "0");
			process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			const sent: Array<{ content: string; deliverAs?: string }> = [];
			registerSteeringInbox({
				on(event: string, handler: (payload?: unknown) => unknown) { handlers.set(event, handler); },
				sendUserMessage(content: string, options?: { deliverAs?: string }) { sent.push({ content, deliverAs: options?.deliverAs }); },
			} as never);
			handlers.get("session_start")?.({});
			handlers.get("agent_start")?.({});
			handlers.get("turn_start")?.({});
			handlers.get("turn_end")?.({});
			handlers.get("agent_end")?.({ willRetry: false });

			writeSteerRequestToDir(inbox, { type: "steer", id: "settling-auto", ts: 1, message: "Wait for settled.", mode: "auto" });
			handlers.get("message_start")?.({});
			assert.equal(sent[0]?.deliverAs, "followUp");
			handlers.get("input")?.({ source: "extension", streamingBehavior: "followUp", text: sent[0]?.content });
			assert.equal(consumeSteerAcks(dir)[0]?.state, "queued");

			handlers.get("agent_settled")?.({});
			writeSteerRequestToDir(inbox, { type: "steer", id: "settled-auto", ts: 2, message: "Now idle.", mode: "auto" });
			handlers.get("message_start")?.({});
			assert.equal(sent[1]?.deliverAs, undefined);
			handlers.get("input")?.({ source: "extension", text: sent[1]?.content });
			assert.equal(consumeSteerAcks(dir)[0]?.deliveryStatus, "delivered");
			handlers.get("session_shutdown")?.({});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps auto steering queued while agent_end will retry", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-retry-steering-runtime-"));
		try {
			const inbox = path.join(dir, "inbox");
			process.env[SUBAGENT_STEER_INBOX_ENV] = inbox;
			process.env[SUBAGENT_STEER_ACK_DIR_ENV] = path.join(dir, "control", "steer-acks", "0");
			process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			const sent: Array<{ content: string; deliverAs?: string }> = [];
			registerSteeringInbox({
				on(event: string, handler: (payload?: unknown) => unknown) { handlers.set(event, handler); },
				sendUserMessage(content: string, options?: { deliverAs?: string }) { sent.push({ content, deliverAs: options?.deliverAs }); },
			} as never);
			handlers.get("session_start")?.({});
			handlers.get("agent_start")?.({});
			handlers.get("turn_start")?.({});
			handlers.get("turn_end")?.({});
			handlers.get("agent_end")?.({ willRetry: true });

			writeSteerRequestToDir(inbox, { type: "steer", id: "retry-auto", ts: 1, message: "Keep this guidance.", mode: "auto" });
			handlers.get("message_start")?.({});
			assert.equal(sent[0]?.deliverAs, "followUp");
			handlers.get("input")?.({ source: "extension", streamingBehavior: "followUp", text: sent[0]?.content });
			assert.equal(consumeSteerAcks(dir)[0]?.state, "queued");

			handlers.get("turn_start")?.({});
			const delivered = consumeSteerAcks(dir)[0];
			assert.equal(delivered?.requestId, "retry-auto");
			assert.equal(delivered?.deliveryStatus, "delivered");
			handlers.get("session_shutdown")?.({});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to idle delivery for runtimes without agent_settled", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-legacy-steering-runtime-"));
		try {
			const inbox = path.join(dir, "inbox");
			process.env[SUBAGENT_STEER_INBOX_ENV] = inbox;
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			const sent: Array<{ content: string; deliverAs?: string }> = [];
			registerSteeringInbox({
				on(event: string, handler: (payload?: unknown) => unknown) { handlers.set(event, handler); },
				sendUserMessage(content: string, options?: { deliverAs?: string }) { sent.push({ content, deliverAs: options?.deliverAs }); },
			} as never, { legacySettleFallbackMs: 5 });
			handlers.get("session_start")?.({});
			handlers.get("agent_start")?.({});
			handlers.get("turn_start")?.({});
			handlers.get("turn_end")?.({});
			handlers.get("agent_end")?.({ willRetry: false });
			await new Promise((resolve) => setTimeout(resolve, 20));

			writeSteerRequestToDir(inbox, { type: "steer", id: "legacy-auto", ts: 1, message: "Legacy idle.", mode: "auto" });
			handlers.get("message_start")?.({});
			assert.equal(sent[0]?.deliverAs, undefined);
			handlers.get("session_shutdown")?.({});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not acknowledge sendUserMessage until the correlated Pi input event arrives", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-steering-ack-runtime-"));
		try {
			const inbox = path.join(dir, "inbox");
			const capability = path.join(dir, "capability.json");
			const ackDir = path.join(dir, "control", "steer-acks", "0");
			process.env[SUBAGENT_STEER_INBOX_ENV] = inbox;
			process.env[SUBAGENT_STEER_CAPABILITY_ENV] = capability;
			process.env[SUBAGENT_STEER_ACK_DIR_ENV] = ackDir;
			process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			const sent: string[] = [];
			registerSteeringInbox({
				on(event: string, handler: (payload?: unknown) => unknown) { handlers.set(event, handler); },
				sendUserMessage(content: string) { sent.push(content); },
			} as never);
			handlers.get("session_start")?.({});
			writeSteerRequestToDir(inbox, { type: "steer", id: "first", ts: 1, message: "Focus on tests." });
			handlers.get("message_start")?.({});
			assert.equal(sent.length, 1);
			assert.deepEqual(fs.existsSync(ackDir) ? fs.readdirSync(ackDir) : [], []);
			handlers.get("input")?.({ source: "extension", streamingBehavior: "steer", text: sent[0] });
			const acks = consumeSteerAcks(dir);
			assert.equal(acks.length, 1);
			assert.equal(acks[0]?.requestId, "first");
			assert.equal(acks[0]?.state, "delivered");
			assert.equal(acks[0]?.message, "Pi accepted the correlated steering input.");
			handlers.get("session_shutdown")?.({});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retries pending correlation once as a follow-up after compaction", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-steering-compaction-runtime-"));
		try {
			const inbox = path.join(dir, "inbox");
			process.env[SUBAGENT_STEER_INBOX_ENV] = inbox;
			process.env[SUBAGENT_STEER_CAPABILITY_ENV] = path.join(dir, "capability.json");
			process.env[SUBAGENT_STEER_ACK_DIR_ENV] = path.join(dir, "control", "steer-acks", "0");
			process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			const sent: Array<{ content: string; deliverAs?: string }> = [];
			registerSteeringInbox({
				on(event: string, handler: (payload?: unknown) => unknown) { handlers.set(event, handler); },
				sendUserMessage(content: string, options?: { deliverAs?: string }) { sent.push({ content, deliverAs: options?.deliverAs }); },
			} as never);
			handlers.get("session_start")?.({});
			writeSteerRequestToDir(inbox, { type: "steer", id: "compact", ts: 1, message: "Keep this guidance." });
			handlers.get("message_start")?.({});
			assert.equal(sent.length, 1);
			assert.deepEqual(consumeSteerAcks(dir), []);

			handlers.get("session_compact")?.({ reason: "manual" });
			assert.equal(sent.length, 2);
			assert.equal(sent[1]?.deliverAs, "followUp");
			handlers.get("input")?.({ source: "extension", text: sent[1]?.content });
			assert.equal(consumeSteerAcks(dir)[0]?.state, "queued");
			handlers.get("turn_start")?.({});
			assert.equal(consumeSteerAcks(dir)[0]?.state, "delivered");
			handlers.get("session_compact")?.({ reason: "manual" });
			assert.equal(sent.length, 2);
			handlers.get("session_shutdown")?.({});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails pending correlation when the session shuts down", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-steering-pending-shutdown-runtime-"));
		try {
			const inbox = path.join(dir, "inbox");
			process.env[SUBAGENT_STEER_INBOX_ENV] = inbox;
			process.env[SUBAGENT_STEER_CAPABILITY_ENV] = path.join(dir, "capability.json");
			process.env[SUBAGENT_STEER_ACK_DIR_ENV] = path.join(dir, "control", "steer-acks", "0");
			process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			registerSteeringInbox({ on(event: string, handler: (payload?: unknown) => unknown) { handlers.set(event, handler); }, sendUserMessage() {} } as never);
			handlers.get("session_start")?.({});
			writeSteerRequestToDir(inbox, { type: "steer", id: "pending", ts: 1, message: "Unconfirmed guidance." });
			handlers.get("message_start")?.({});
			handlers.get("session_shutdown")?.({});
			const ack = consumeSteerAcks(dir)[0];
			assert.equal(ack?.requestId, "pending");
			assert.equal(ack?.state, "failed");
			assert.match(ack?.message ?? "", /before Pi confirmed steering input delivery/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("correlates duplicate guidance FIFO without a visible marker", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-steering-fifo-runtime-"));
		try {
			const inbox = path.join(dir, "inbox");
			process.env[SUBAGENT_STEER_INBOX_ENV] = inbox;
			process.env[SUBAGENT_STEER_CAPABILITY_ENV] = path.join(dir, "capability.json");
			process.env[SUBAGENT_STEER_ACK_DIR_ENV] = path.join(dir, "control", "steer-acks", "0");
			process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			const sent: string[] = [];
			registerSteeringInbox({ on(event: string, handler: (payload?: unknown) => unknown) { handlers.set(event, handler); }, sendUserMessage(content: string) { sent.push(content); } } as never);
			handlers.get("session_start")?.({});
			writeSteerRequestToDir(inbox, { type: "steer", id: "one", ts: 1, message: "same guidance" });
			writeSteerRequestToDir(inbox, { type: "steer", id: "two", ts: 2, message: "same guidance" });
			handlers.get("message_start")?.({});
			handlers.get("input")?.({ source: "extension", streamingBehavior: "steer", text: sent[0] });
			handlers.get("input")?.({ source: "extension", streamingBehavior: "steer", text: sent[1] });
			assert.deepEqual(consumeSteerAcks(dir).map((ack) => ack.requestId), ["one", "two"]);
			handlers.get("session_shutdown")?.({});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("publishes an unsupported capability and failed acknowledgments without sendUserMessage", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-steering-unsupported-runtime-"));
		try {
			const inbox = path.join(dir, "inbox");
			process.env[SUBAGENT_STEER_INBOX_ENV] = inbox;
			process.env[SUBAGENT_STEER_CAPABILITY_ENV] = path.join(dir, "capability.json");
			process.env[SUBAGENT_STEER_ACK_DIR_ENV] = path.join(dir, "control", "steer-acks", "0");
			process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			registerSteeringInbox({ on(event: string, handler: (payload?: unknown) => unknown) { handlers.set(event, handler); } } as never);
			handlers.get("session_start")?.({});
			assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "capability.json"), "utf-8")).supported, false);
			writeSteerRequestToDir(inbox, { type: "steer", id: "unsupported", ts: 1, message: "guidance" });
			handlers.get("message_start")?.({});
			assert.equal(consumeSteerAcks(dir)[0]?.state, "failed");
			handlers.get("session_shutdown")?.({});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers child watchdog lifecycle handlers only when enabled by env", () => {
		delete process.env[CHILD_WATCHDOG_CONFIG_ENV];
		// Clear the ack capture env explicitly: when this test suite itself runs inside a
		// pi-subagents child, the runner sets it and an extra agent_end handler registers.
		delete process.env[RUNTIME_EXTENSION_ACK_PATH_ENV];
		const handlersWithout = new Map<string, unknown[]>();
		registerSubagentPromptRuntime({
			on(event: string, handler: unknown) {
				handlersWithout.set(event, [...(handlersWithout.get(event) ?? []), handler]);
			},
		} as { on(event: string, handler: unknown): void });
		assert.equal(handlersWithout.get("agent_end")?.length ?? 0, 1, "headless auto-drain is always registered");

		process.env[CHILD_WATCHDOG_CONFIG_ENV] = JSON.stringify({
			enabled: true,
			runId: "run-1",
			agent: "worker",
			childIndex: 0,
			watchdogTailTimeoutMs: 1000,
			agentEndTimeoutMs: 500,
			maxWarnings: null,
			lsp: { enabled: false, timeoutMs: 3000, maxFiles: 20, maxDiagnostics: 50 },
			autoFollowBlockers: false,
			autoFollowMaxAttempts: 3,
			stalemateRepeats: 2,
		});
		const handlersWith = new Map<string, unknown[]>();
		registerSubagentPromptRuntime({
			on(event: string, handler: unknown) {
				handlersWith.set(event, [...(handlersWith.get(event) ?? []), handler]);
			},
			getThinkingLevel() {
				return "off";
			},
			sendMessage() {},
		} as { on(event: string, handler: unknown): void; getThinkingLevel(): string; sendMessage(): void });

		assert.ok((handlersWith.get("before_agent_start")?.length ?? 0) >= 2);
		assert.ok((handlersWith.get("turn_end")?.length ?? 0) >= 1);
		assert.ok((handlersWith.get("agent_end")?.length ?? 0) >= 2, "watchdog and auto-drain both observe agent_end");
	});

	it("registered structured_output tool accepts valid schema output and writes the capture file", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-structured-runtime-"));
		try {
			const schemaPath = path.join(dir, "schema.json");
			const outputPath = path.join(dir, "output.json");
			fs.writeFileSync(schemaPath, JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }), "utf-8");
			process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = schemaPath;
			process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = outputPath;
			let execute: ((_id: string, params: { value: unknown }) => Promise<{ terminate?: boolean }>) | undefined;
			let parameters: unknown;

			registerSubagentPromptRuntime({
				registerTool(tool: { name: string; parameters: unknown; execute: (_id: string, params: { value: unknown }) => Promise<{ terminate?: boolean }> }) {
					if (tool.name === "structured_output") {
						execute = tool.execute;
						parameters = tool.parameters;
					}
				},
				on() {},
			} as { registerTool(tool: { name: string; parameters: unknown; execute: (_id: string, params: { value: unknown }) => Promise<{ terminate?: boolean }> }): void; on(): void });

			assert.ok(execute, "structured_output tool should be registered");
			assert.deepEqual(parameters, {
				type: "object",
				properties: { value: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } },
				required: ["value"],
				additionalProperties: false,
			});
			const result = await execute("tool-1", { value: { ok: true } });
			assert.equal(result.terminate, true);
			assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf-8")), { ok: true });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("scopes local structured_output schema refs under the value parameter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-structured-refs-"));
		try {
			const schemaPath = path.join(dir, "schema.json");
			const outputPath = path.join(dir, "output.json");
			fs.writeFileSync(schemaPath, JSON.stringify({
				$defs: { item: { type: "string" } },
				type: "object",
				properties: {
					name: { $ref: "#/$defs/item" },
					nested: {
						type: "object",
						properties: { label: { $ref: "#/$defs/item" } },
					},
				},
			}), "utf-8");
			process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = schemaPath;
			process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = outputPath;
			let parameters = {} as { properties?: { value?: { properties?: { name?: { $ref?: string }; nested?: { properties?: { label?: { $ref?: string } } } } } } };

			registerSubagentPromptRuntime({
				registerTool(tool: { name: string; parameters: unknown }) {
					if (tool.name === "structured_output") parameters = tool.parameters as typeof parameters;
				},
				on() {},
			} as { registerTool(tool: { name: string; parameters: unknown }): void; on(): void });

			assert.equal(parameters.properties?.value?.properties?.name?.$ref, "#/properties/value/$defs/item");
			assert.equal(parameters.properties?.value?.properties?.nested?.properties?.label?.$ref, "#/properties/value/$defs/item");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("strips only the project context block", () => {
		const rewritten = stripProjectContext(BASE_PROMPT);
		assert.ok(!rewritten.includes("# Project Context"));
		assert.ok(rewritten.includes("The following skills provide specialized instructions for specific tasks."));
		assert.ok(rewritten.includes("Current date: 2026-04-16"));
	});

	it("strips only the inherited skills block", () => {
		const rewritten = stripInheritedSkills(BASE_PROMPT);
		assert.ok(rewritten.includes("# Project Context"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(rewritten.includes("Current date: 2026-04-16"));
	});

	it("can strip both inherited sections together", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: false,
			inheritSkills: false,
		});
		assert.ok(!rewritten.includes("# Project Context"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(rewritten.includes("Current working directory: /repo"));
	});

	it("injects a child-only boundary that forbids proposing or running subagents", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: true,
			inheritSkills: true,
		});

		assert.ok(rewritten.startsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
		assert.ok(rewritten.includes("Do not propose or run subagents."));
		assert.ok(rewritten.includes("If you need to edit files, use the available editing tools."));
		assert.ok(!rewritten.includes("call the actual edit/write tools"));
		assert.ok(rewritten.includes("Do not print tool-call syntax, patches, or pseudo-tool calls as text."));
		assert.equal(rewriteSubagentPrompt(rewritten, { inheritProjectContext: true, inheritSkills: true }).indexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
		assert.equal(rewriteSubagentPrompt(rewritten, { inheritProjectContext: true, inheritSkills: true }).lastIndexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
	});

	it("replaces inherited child boundaries with the fanout boundary when authorized", () => {
		const strictPrompt = `${CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS}\n\n${BASE_PROMPT}`;
		const rewritten = rewriteSubagentPrompt(strictPrompt, {
			inheritProjectContext: true,
			inheritSkills: true,
			fanoutChild: true,
		});

		assert.ok(rewritten.startsWith(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS));
		assert.ok(rewritten.includes("You may use the `subagent` tool only for the fanout work explicitly requested in this task."));
		assert.ok(rewritten.includes("If you need to edit files, use the available editing tools."));
		assert.ok(!rewritten.includes("call the actual edit/write tools"));
		assert.ok(!rewritten.includes("Do not propose or run subagents."));
		assert.equal(rewritten.lastIndexOf(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS), 0);
	});

	it("replaces inherited fanout boundaries with the strict boundary when fanout is not authorized", () => {
		const fanoutPrompt = `${CHILD_FANOUT_BOUNDARY_INSTRUCTIONS}\n\n${BASE_PROMPT}`;
		const rewritten = rewriteSubagentPrompt(fanoutPrompt, {
			inheritProjectContext: true,
			inheritSkills: true,
		});

		assert.ok(rewritten.startsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
		assert.ok(!rewritten.includes("explicit fanout responsibility"));
		assert.equal(rewritten.lastIndexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
	});

	it("keeps explicitly injected skill content when inherited skills are stripped", () => {
		const rewritten = rewriteSubagentPrompt(PROMPT_WITH_EXPLICIT_SKILL, {
			inheritProjectContext: false,
			inheritSkills: false,
		});
		assert.ok(rewritten.includes("<skill name=\"explicit\">"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(!rewritten.includes("# Project Context"));
	});

	it("keeps configured lazy skill references when inherited skills are stripped", () => {
		const prompt = [
			"You are a subagent.",
			CONFIGURED_SKILLS_SECTION,
			"\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
			SKILLS_SECTION,
			"\nCurrent date: 2026-04-16",
		].join("");
		const rewritten = rewriteSubagentPrompt(prompt, {
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(rewritten.includes("<name>configured-skill</name>"));
		assert.ok(rewritten.includes("/tmp/configured-skill/SKILL.md"));
		assert.ok(!rewritten.includes("<name>safe-bash</name>"));
		assert.ok(!rewritten.includes("# Project Context"));
	});

	it("strips the subagent orchestration skill even when inherited skills remain", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: true,
			inheritSkills: true,
		});

		assert.ok(rewritten.includes("<name>safe-bash</name>"));
		assert.ok(!rewritten.includes("<name>pi-subagents</name>"));
		assert.ok(!rewritten.includes("delegate to subagents"));
	});

	it("strips explicit pi-subagents skill injection from child prompts", () => {
		const prompt = "Before\n\n<skill name=\"pi-subagents\">\nDo not keep this.\n</skill>\n\n<skill name=\"safe-bash\">\nKeep this.\n</skill>\nAfter";
		const rewritten = stripSubagentOrchestrationSkill(prompt);

		assert.ok(!rewritten.includes("Do not keep this"));
		assert.ok(rewritten.includes("<skill name=\"safe-bash\">"));
	});

	it("strips parent-only subagent custom messages from forked child context", () => {
		const user = { role: "user", content: "Task" };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		const slashResult = { role: "custom", customType: "subagent-slash-result", content: "## Orchestration" };
		const slashTextResult = { role: "custom", customType: "subagent-slash-text-result", content: "Subagent profiles" };
		const notify = { role: "custom", customType: "subagent-notify", content: "Background task completed" };
		const control = { role: "custom", customType: "subagent_control_notice", content: "needs attention" };
		const watchdogWarning = { role: "custom", customType: SUBAGENT_WATCHDOG_WARNING_TYPE, content: "<subagent_watchdog>parent-only</subagent_watchdog>" };
		const childWatchdogWarning = { role: "custom", customType: SUBAGENT_WATCHDOG_WARNING_TYPE, content: "<subagent_watchdog>child-visible</subagent_watchdog>", details: { source: "child" } };
		const otherCustom = { role: "custom", customType: "other", content: "keep" };

		assert.deepEqual(stripParentOnlySubagentMessages([user, instruction, slashResult, slashTextResult, notify, control, watchdogWarning, childWatchdogWarning, otherCustom]), [user, otherCustom]);
	});

	it("strips prior parent subagent tool calls and results from forked child context", () => {
		const user = { role: "user", content: "Task" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "subagent results" };
		const readResult = { role: "toolResult", toolName: "read", content: "file contents" };
		const mixedAssistant = {
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect the repo." },
				{ type: "toolCall", name: "subagent", input: { agent: "worker" } },
				{ type: "toolCall", name: "read", input: { path: "README.md" } },
			],
		};
		const pureSubagentCall = {
			role: "assistant",
			content: [{ type: "toolCall", name: "subagent", input: { agent: "reviewer" } }],
		};

		assert.deepEqual(
			stripParentOnlySubagentMessages([user, subagentResult, readResult, mixedAssistant, pureSubagentCall]),
			[
				user,
				readResult,
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will inspect the repo." },
						{ type: "toolCall", name: "read", input: { path: "README.md" } },
					],
				},
			],
		);
	});

	it("sanitizes non-portable tool ids in forked child context", () => {
		const assistant = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call_read|fc_123", name: "read", input: { path: "README.md" } },
				{ type: "toolCall", id: "call_bash-ok", name: "bash", input: { command: "pwd" } },
			],
		};
		const readResult = { role: "toolResult", toolName: "read", toolCallId: "call_read|fc_123", content: "file contents" };
		const bashResult = { role: "toolResult", toolName: "bash", toolCallId: "call_bash-ok", content: "cwd" };

		assert.deepEqual(stripParentOnlySubagentMessages([assistant, readResult, bashResult]), [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "tool_Y2FsbF9yZWFkfGZjXzEyMw", name: "read", input: { path: "README.md" } },
					{ type: "toolCall", id: "call_bash-ok", name: "bash", input: { command: "pwd" } },
				],
			},
			{ role: "toolResult", toolName: "read", toolCallId: "tool_Y2FsbF9yZWFkfGZjXzEyMw", content: "file contents" },
			bashResult,
		]);
	});

	it("preserves live nested subagent calls and results in fanout child context", () => {
		const user = { role: "user", content: "Task" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "OK" };
		const subagentCall = { role: "assistant", content: [{ type: "toolCall", name: "subagent", input: { agent: "delegate" } }] };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

		assert.deepEqual(stripParentOnlySubagentMessages([user, subagentCall, subagentResult, instruction]), [user, subagentCall, subagentResult]);
	});

	it("defers native supervisor registration until runtime events and respects installed pi-intercom tools", async () => {
		setSupervisorEnv();
		const handlers = new Map<string, (payload?: unknown) => unknown>();
		const registered: string[] = [];

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload?: unknown) => unknown) {
				handlers.set(event, handler);
			},
			getAllTools: () => [{ name: "intercom" }, { name: "contact_supervisor" }],
			registerTool(tool: { name: string }) {
				registered.push(tool.name);
			},
		} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(tool: { name: string }): void });

		assert.deepEqual(registered, ["subagent_wait"]);
		handlers.get("session_start")?.({});
		await handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT });
		assert.deepEqual(registered, ["subagent_wait"]);
	});

	it("registers native intercom before the final strict allowlist check", () => {
		setSupervisorEnv();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-intercom-diagnostic-"));
		try {
			const diagnosticPath = path.join(dir, "tools.json");
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			const registered: string[] = [];
			process.env[REQUIRED_CHILD_TOOLS_ENV] = JSON.stringify(["read", "grep", "find", "ls", "bash", "edit", "write", "intercom"]);
			process.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV] = diagnosticPath;
			process.env[SUBAGENT_CHILD_AGENT_ENV] = "scout";

			registerSubagentPromptRuntime({
				on(event: string, handler: (payload?: unknown) => unknown) {
					handlers.set(event, handler);
				},
				getAllTools: () => registered.map((name) => ({ name })),
				registerTool(tool: { name: string }) {
					registered.push(tool.name);
				},
			} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(tool: { name: string }): void });

			handlers.get("session_start")?.({});
			assert.deepEqual(registered, ["subagent_wait", "contact_supervisor", "intercom"]);
			handlers.get("agent_start")?.({});
			assert.equal(fs.existsSync(diagnosticPath), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps installed pi-intercom while filling only a missing child contact_supervisor tool", async () => {
		setSupervisorEnv();
		const handlers = new Map<string, (payload?: unknown) => unknown>();
		const registered: string[] = [];

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload?: unknown) => unknown) {
				handlers.set(event, handler);
			},
			getAllTools: () => [{ name: "intercom" }, ...registered.map((name) => ({ name }))],
			registerTool(tool: { name: string }) {
				registered.push(tool.name);
			},
		} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(tool: { name: string }): void });

		handlers.get("session_start")?.({});
		await handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT });

		assert.deepEqual(registered, ["subagent_wait", "contact_supervisor"]);
	});

	it("registers native supervisor tools at runtime when pi-intercom is absent", async () => {
		setSupervisorEnv();
		const previousRequiredTools = process.env[REQUIRED_CHILD_TOOLS_ENV];
		delete process.env[REQUIRED_CHILD_TOOLS_ENV];
		const handlers = new Map<string, (payload?: unknown) => unknown>();
		const registered: string[] = [];

		try {
			registerSubagentPromptRuntime({
				on(event: string, handler: (payload?: unknown) => unknown) {
					handlers.set(event, handler);
				},
				getAllTools: () => registered.map((name) => ({ name })),
				registerTool(tool: { name: string }) {
					registered.push(tool.name);
				},
			} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(tool: { name: string }): void });

			handlers.get("session_start")?.({});
			assert.deepEqual(registered, ["subagent_wait", "contact_supervisor"]);

			await handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT });
			assert.deepEqual(registered, ["subagent_wait", "contact_supervisor", "intercom"]);
		} finally {
			if (previousRequiredTools === undefined) delete process.env[REQUIRED_CHILD_TOOLS_ENV];
			else process.env[REQUIRED_CHILD_TOOLS_ENV] = previousRequiredTools;
		}
	});

	it("records requested tools missing from the child registry after startup hooks settle", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-tool-diagnostic-"));
		try {
			const diagnosticPath = path.join(dir, "tools.json");
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			const available = ["read"];
			process.env[REQUIRED_CHILD_TOOLS_ENV] = JSON.stringify(["read", "fixture_search"]);
			process.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV] = diagnosticPath;
			process.env[SUBAGENT_CHILD_AGENT_ENV] = "extension-worker";

			registerSubagentPromptRuntime({
				on(event: string, handler: (payload?: unknown) => unknown) {
					handlers.set(event, handler);
				},
				getAllTools: () => available.map((name) => ({ name })),
				registerTool() {},
			} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(): void });

			const promptRewrite = await handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT }) as { systemPrompt?: string } | undefined;
			assert.equal(fs.existsSync(diagnosticPath), false);
			assert.doesNotMatch(promptRewrite?.systemPrompt ?? "", /requested unavailable child tools/);

			handlers.get("agent_start")?.({});
			assert.deepEqual(readChildToolDiagnostic(diagnosticPath), {
				agent: "extension-worker",
				required: ["read", "fixture_search"],
				available: ["read"],
				missing: ["fixture_search"],
			});

			available.push("fixture_search");
			handlers.get("agent_start")?.({});
			assert.equal(fs.existsSync(diagnosticPath), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores malformed inherited MCP metadata before strict availability diagnostics", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-stale-mcp-tool-diagnostic-"));
		try {
			const diagnosticPath = path.join(dir, "tools.json");
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			process.env[REQUIRED_CHILD_TOOLS_ENV] = JSON.stringify(["read", "fixture_search"]);
			process.env[MCP_DIRECT_CHILD_TOOLS_ENV] = "not-json";
			process.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV] = diagnosticPath;
			process.env[SUBAGENT_CHILD_AGENT_ENV] = "worker";

			registerSubagentPromptRuntime({
				on(event: string, handler: (payload?: unknown) => unknown) {
					handlers.set(event, handler);
				},
				getAllTools: () => [{ name: "read" }],
				registerTool() {},
			} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(): void });

			assert.doesNotThrow(() => handlers.get("agent_start")?.({}));
			assert.deepEqual(readChildToolDiagnostic(diagnosticPath), {
				agent: "worker",
				required: ["read", "fixture_search"],
				available: ["read"],
				missing: ["fixture_search"],
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("classifies missing resolved MCP direct tools without softening strict diagnostics", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-mcp-tool-diagnostic-"));
		try {
			const diagnosticPath = path.join(dir, "tools.json");
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			process.env[REQUIRED_CHILD_TOOLS_ENV] = JSON.stringify(["read", "rust_symbols_workspace_symbols", "fixture_search"]);
			process.env[MCP_DIRECT_CHILD_TOOLS_ENV] = JSON.stringify(["rust_symbols_workspace_symbols"]);
			process.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV] = diagnosticPath;
			process.env[SUBAGENT_CHILD_AGENT_ENV] = "worker";

			registerSubagentPromptRuntime({
				on(event: string, handler: (payload?: unknown) => unknown) {
					handlers.set(event, handler);
				},
				getAllTools: () => [{ name: "read" }],
				registerTool() {},
			} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(): void });

			handlers.get("agent_start")?.({});
			const diagnostic = readChildToolDiagnostic(diagnosticPath);
			assert.deepEqual(diagnostic, {
				agent: "worker",
				required: ["read", "rust_symbols_workspace_symbols", "fixture_search"],
				available: ["read"],
				missing: ["rust_symbols_workspace_symbols", "fixture_search"],
				missingMcpDirectTools: ["rust_symbols_workspace_symbols"],
			});
			assert.match(formatChildToolDiagnostic(diagnostic!), /host\/pi-mcp-adapter registration problem/);
			assert.match(formatChildToolDiagnostic(diagnostic!), /fixture_search/);
			assert.equal(fs.existsSync(diagnosticPath), true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sets the child intercom session name from env during agent startup", async () => {
		let sessionName: string | undefined;
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = "subagent-worker-78f659a3";

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
			getAllTools: () => [{ name: "intercom" }, { name: "contact_supervisor" }],
			setSessionName(name: string) {
				sessionName = name;
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void; getAllTools(): Array<{ name: string }>; setSessionName(name: string): void });

		await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });

		assert.equal(sessionName, "subagent-worker-78f659a3");
	});

	it("rewrites the final child-visible prompt through before_agent_start", async () => {
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
			getAllTools: () => [{ name: "intercom" }, { name: "contact_supervisor" }],
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void; getAllTools(): Array<{ name: string }> });

		assert.ok(beforeAgentStart, "expected before_agent_start handler");
		process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "0";
		process.env.PI_SUBAGENT_INHERIT_SKILLS = "0";

		const rewritten = await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });
		assert.ok(rewritten);
		assert.ok(!rewritten.systemPrompt.includes("# Project Context"));
		assert.ok(!rewritten.systemPrompt.includes("<available_skills>"));
		assert.ok(rewritten.systemPrompt.includes("Current date: 2026-04-16"));
	});

	it("uses the fanout boundary through before_agent_start when fanout env is set", async () => {
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
			getAllTools: () => [{ name: "intercom" }, { name: "contact_supervisor" }],
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void; getAllTools(): Array<{ name: string }> });

		process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "1";
		process.env.PI_SUBAGENT_INHERIT_SKILLS = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

		const rewritten = await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });
		assert.ok(rewritten);
		assert.ok(rewritten.systemPrompt.startsWith(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS));
	});

	it("filters parent-only artifacts from polluted fork context while preserving ordinary history", () => {
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void });

		const priorParentTurn = { role: "user", content: "Earlier we said planner → worker → reviewers → worker." };
		const currentTask = { role: "user", content: "Now implement only the assigned fix." };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		const slashResult = { role: "custom", customType: "subagent-slash-result", content: "## Orchestration" };
		const subagentResult = { role: "toolResult", toolName: "subagent", content: "subagent results" };
		const subagentCall = { role: "assistant", content: [{ type: "toolCall", name: "subagent", input: { agent: "worker" } }] };
		const watchdogWarning = { role: "custom", customType: SUBAGENT_WATCHDOG_WARNING_TYPE, content: "<subagent_watchdog>parent-only</subagent_watchdog>" };
		const childWatchdogWarning = { role: "custom", customType: SUBAGENT_WATCHDOG_WARNING_TYPE, content: "<subagent_watchdog>child-visible</subagent_watchdog>", details: { source: "child" } };
		const otherCustom = { role: "custom", customType: "other", content: "keep" };

		assert.deepEqual(contextHandler?.({ messages: [priorParentTurn, instruction, slashResult, subagentCall, subagentResult, watchdogWarning, childWatchdogWarning, otherCustom, currentTask] }), {
			messages: [priorParentTurn, otherCustom, currentTask],
		});
	});

	it("bounds composite tool ids for Codex child context", () => {
		let contextHandler: ((event: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined): void });

		const toolCallId = "call_N7iYNRPXLl9czpXh3bDyMpIL|fc_0e76718634eca88f016a76fdc89aec81919763fa7858f67a0d";
		const messages = [
			{ role: "user", content: "Task" },
			{ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "read", input: { path: "README.md" } }] },
			{ role: "toolResult", toolName: "read", toolCallId, content: "file" },
		];

		const context = contextHandler?.({ messages }, { model: { api: "openai-codex-responses" } });
		assert.ok(context);
		const mappedCallId = (context.messages[1] as { content: Array<{ id?: unknown }> }).content[0]?.id;
		const mappedResultId = (context.messages[2] as { toolCallId?: unknown }).toolCallId;
		assert.equal(typeof mappedCallId, "string");
		assert.match(mappedCallId, /^[a-zA-Z0-9_-]+$/);
		assert.ok(mappedCallId.length <= 64);
		assert.equal(mappedResultId, mappedCallId);
	});

	it("preserves composite tool ids for non-Codex APIs that normalize them", () => {
		let contextHandler: ((event: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined): void });

		const toolCallId = "call_7XJjvAJfk07117JO8LgBCZjY|fc_0e92b09b28010bac016a756e9e79cc8197b01825a5dc3d9eaa";
		const messages = [
			{ role: "user", content: "Task" },
			{ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "read", input: { path: "README.md" } }] },
			{ role: "toolResult", toolName: "read", toolCallId, content: "file" },
		];

		assert.equal(contextHandler?.({ messages }, { model: { api: "openai-responses" } }), undefined);
	});

	it("does not rewrite child context when no parent-only artifacts are present", () => {
		let contextHandler: ((event: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined): void });

		const messages = [
			{ role: "user", content: "Task" },
			{ role: "toolResult", toolName: "read", content: "file" },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", input: { path: "README.md" } }] },
		];

		assert.equal(contextHandler?.({ messages }, {}), undefined);
	});
});
