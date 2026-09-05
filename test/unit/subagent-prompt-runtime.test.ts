import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { RUNTIME_EXTENSION_ACK_EVENT } from "../../src/runs/shared/runtime-acknowledged-extensions.ts";
import { clearStructuredOutputCaptures } from "../../src/runs/shared/structured-output.ts";
import { getAgentDir } from "../../src/shared/utils.ts";
import { formatChildToolDiagnostic, type ChildToolDiagnostic } from "../../src/runs/shared/tool-availability.ts";
import type { ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";
import type { ChildWatchdogConfig } from "../../src/watchdog/child-status.ts";
import { SUBAGENT_WATCHDOG_WARNING_TYPE } from "../../src/watchdog/types.ts";
import registerSubagentPromptRuntime, {
	CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	registerPermissionGate,
	rewriteSubagentPrompt,
	stripGlobalContext,
	stripInheritedSkills,
	stripParentOnlySubagentMessages,
	stripProjectContext,
	stripSubagentOrchestrationSkill,
} from "../../src/runs/shared/subagent-prompt-runtime.ts";

function childConfig(overrides: Partial<ChildRuntimeConfig> = {}): ChildRuntimeConfig {
	return { fanoutChild: false, depth: 1, waitTool: { enabled: true }, fast: false, ...overrides };
}

function supervisorConfig(overrides: Partial<ChildRuntimeConfig> = {}): ChildRuntimeConfig {
	return childConfig({
		orchestratorTarget: "subagent-chat-parent",
		orchestratorSessionId: "session-parent",
		supervisorChannelDir: path.join(os.tmpdir(), "subagent-supervisor-runtime-test"),
		runId: "run-123",
		agent: "worker",
		childIndex: 0,
		...overrides,
	});
}

const watchdogConfig: ChildWatchdogConfig = {
	enabled: true,
	runId: "run-1",
	agent: "worker",
	childIndex: 0,
	watchdogTailTimeoutMs: 1000,
	agentEndTimeoutMs: 500,
	maxWarnings: null,
	lsp: { enabled: false, timeoutMs: 3000, maxFiles: 20, maxDiagnostics: 50 },
	stalemateRepeats: 2,
	cadence: { everyNTools: null },
} as ChildWatchdogConfig;

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

describe("subagent prompt runtime", () => {
	it("ignores an unconfigured path-based load", () => {
		assert.doesNotThrow(() => registerSubagentPromptRuntime({} as never));
	});

	it("registers no permission hook by default and routes ask only to the watchdog arbiter", async () => {
		const handlers: Array<(event: { toolName?: string; input?: unknown }, ctx?: unknown) => unknown> = [];
		const pi = { on(event: string, handler: (event: { toolName?: string; input?: unknown }, ctx?: unknown) => unknown) { if (event === "tool_call") handlers.push(handler); } };
		registerPermissionGate(pi as never, undefined, undefined);
		assert.equal(handlers.length, 0);

		registerPermissionGate(pi as never, { rules: { write: "deny" } }, undefined);
		assert.equal(handlers.length, 1);
		assert.equal(await handlers[0]!({ toolName: "bash", input: { command: "rm -rf /" } }), undefined);
		assert.equal(await handlers[0]!({ toolName: "contact_supervisor", input: {} }), undefined);
		assert.deepEqual(await handlers[0]!({ toolName: "write", input: {} }), {
			block: true,
			reason: "Blocked by pi-subagents permission rule: 'write' is denied.",
		});

		const askHandlers: Array<(event: { toolName?: string; input?: unknown }, ctx: unknown) => unknown> = [];
		const requests: Array<{ toolName: string; args: unknown }> = [];
		registerPermissionGate({ on(event: string, handler: (event: { toolName?: string; input?: unknown }, ctx: unknown) => unknown) { if (event === "tool_call") askHandlers.push(handler); } } as never, { rules: { write: "ask" } }, undefined, async (request) => {
			requests.push({ toolName: request.toolName, args: request.args });
			return { approved: true, reason: "approved by watchdog", source: "watchdog" };
		});
		assert.equal(await askHandlers[0]!({ toolName: "write", input: { path: "out.txt" } }, { signal: undefined }), undefined);
		assert.deepEqual(requests, [{ toolName: "write", args: { path: "out.txt" } }]);
	});

	it("fails closed when an ask permission decision stalls", async () => {
		{
			const stallingWatchdog = { ...watchdogConfig, agentEndTimeoutMs: 5, lsp: { enabled: false, timeoutMs: 100, maxFiles: 1, maxDiagnostics: 1 } } as ChildWatchdogConfig;
			const handlers: Array<(event: { toolName?: string; input?: unknown }, ctx: { signal?: AbortSignal }) => unknown> = [];
			registerPermissionGate({ on(event: string, handler: (event: { toolName?: string; input?: unknown }, ctx: { signal?: AbortSignal }) => unknown) { if (event === "tool_call") handlers.push(handler); } } as never, { rules: { write: "ask" } }, stallingWatchdog, async () => new Promise(() => undefined));

			const result = await Promise.race([
				handlers[0]!({ toolName: "write", input: { path: "out.txt" } }, { signal: undefined }),
				new Promise((resolve) => setTimeout(() => resolve("hung"), 100)),
			]);

			assert.notEqual(result, "hung");
			assert.deepEqual(result, {
				block: true,
				reason: "Blocked by pi-subagents permission rule: Watchdog permission arbiter failed closed: Watchdog permission decision timed out after 5ms.",
			});
		}
	});
	it("collects runtime extension acknowledgements until terminal serialization", () => {
		{
			const acknowledged: string[][] = [];
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
			} as never, childConfig({ runtimeAcknowledgements: (ids) => acknowledged.push(ids) }));

			emitAll(extensionHandlers, RUNTIME_EXTENSION_ACK_EVENT, { id: "ext.one" });
			emitAll(extensionHandlers, RUNTIME_EXTENSION_ACK_EVENT, { id: "ext.one" });
			emitAll(extensionHandlers, RUNTIME_EXTENSION_ACK_EVENT, { id: "bad/path" });
			runtimeHandlers.get("agent_end")?.[0]?.({});
			emitAll(extensionHandlers, RUNTIME_EXTENSION_ACK_EVENT, { id: "late" });

			assert.deepEqual(acknowledged, [["ext.one", "ext.one"]]);
		}
	});

	it("nudges after the tool budget soft limit and blocks configured tools after hard", () => {
		const handlers = new Map<string, (payload: { toolName?: string }) => unknown>();
		const sent: string[] = [];

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { toolName?: string }) => unknown) {
				handlers.set(event, handler);
			},
			sendUserMessage(content: string) {
				sent.push(content);
			},
		} as { on(event: string, handler: (payload: { toolName?: string }) => unknown): void; sendUserMessage(content: string): void }, childConfig({ toolBudget: { soft: 2, hard: 2, block: ["read"] } }));

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

	it("registers child watchdog lifecycle handlers only when the config enables them", () => {
		const handlersWithout = new Map<string, unknown[]>();
		registerSubagentPromptRuntime({
			on(event: string, handler: unknown) {
				handlersWithout.set(event, [...(handlersWithout.get(event) ?? []), handler]);
			},
		} as { on(event: string, handler: unknown): void }, childConfig());
		assert.equal(handlersWithout.get("agent_end")?.length ?? 0, 1, "headless auto-drain is always registered");

		const handlersWith = new Map<string, unknown[]>();
		registerSubagentPromptRuntime({
			on(event: string, handler: unknown) {
				handlersWith.set(event, [...(handlersWith.get(event) ?? []), handler]);
			},
			getThinkingLevel() {
				return "off";
			},
			sendMessage() {},
		} as { on(event: string, handler: unknown): void; getThinkingLevel(): string; sendMessage(): void }, childConfig({ childWatchdog: watchdogConfig, watchdogStatus: () => {} }));

		assert.ok((handlersWith.get("before_agent_start")?.length ?? 0) >= 2);
		assert.ok((handlersWith.get("turn_end")?.length ?? 0) >= 1);
		assert.ok((handlersWith.get("agent_end")?.length ?? 0) >= 2, "watchdog and auto-drain both observe agent_end");
	});

	it("registered structured_output tool accepts valid schema output and captures it", async () => {
		{
			const captured: unknown[] = [];
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
			} as { registerTool(tool: { name: string; parameters: unknown; execute: (_id: string, params: { value: unknown }) => Promise<{ terminate?: boolean }> }): void; on(): void }, childConfig({
				structuredOutput: { schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, capture: (value) => captured.push(value) },
			}));

			assert.ok(execute, "structured_output tool should be registered");
			assert.deepEqual(parameters, {
				type: "object",
				properties: { value: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } },
				required: ["value"],
				additionalProperties: false,
			});
			const result = await execute("tool-1", { value: { ok: true } });
			assert.equal(result.terminate, true);
			assert.deepEqual(captured, [{ ok: true }]);
		}
	});

	it("requires and validates acceptanceReport when structured capture is required", async () => {
		{
			const captured: Array<{ value: unknown; acceptanceReport: unknown }> = [];
			let execute: ((_id: string, params: { value: unknown; acceptanceReport?: unknown }) => Promise<unknown>) | undefined;
			let parameters: { required?: string[] } | undefined;

			registerSubagentPromptRuntime({
				registerTool(tool: { name: string; parameters: unknown; execute: typeof execute }) {
					if (tool.name === "structured_output") {
						execute = tool.execute;
						parameters = tool.parameters as { required?: string[] };
					}
				},
				on() {},
			} as { registerTool(tool: { name: string; parameters: unknown; execute: typeof execute }): void; on(): void }, childConfig({
				structuredOutput: { schema: { type: "object" }, acceptanceReport: "required", capture: (value, acceptanceReport) => captured.push({ value, acceptanceReport }) },
			}));

			assert.deepEqual(parameters?.required, ["value", "acceptanceReport"]);
			await assert.rejects(execute!("missing", { value: {} }), /Missing acceptanceReport/);
			await assert.rejects(execute!("empty", { value: {}, acceptanceReport: {} }), /expected at least one acceptance report field/);
			await execute!("valid", { value: {}, acceptanceReport: { manualNotes: "validated evidence" } });
			assert.deepEqual(captured, [{ value: {}, acceptanceReport: { manualNotes: "validated evidence" } }]);
		}
	});

	it("captures an omitted optional acceptance report as undefined", async () => {
		{
			const captured: Array<{ value: unknown; acceptanceReport: unknown }> = [];
			let execute: ((_id: string, params: { value: unknown }) => Promise<unknown>) | undefined;

			registerSubagentPromptRuntime({
				registerTool(tool: { name: string; execute: typeof execute }) {
					if (tool.name === "structured_output") execute = tool.execute;
				},
				on() {},
			} as { registerTool(tool: { name: string; execute: typeof execute }): void; on(): void }, childConfig({
				structuredOutput: { schema: { type: "object" }, acceptanceReport: "optional", capture: (value, acceptanceReport) => captured.push({ value, acceptanceReport }) },
			}));

			await execute!("without-report", { value: {} });
			assert.deepEqual(captured, [{ value: {}, acceptanceReport: undefined }]);
		}
	});

	it("reports capture cleanup failures after clearing every stale file it can", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-structured-cleanup-"));
		try {
			const outputPath = path.join(dir, "output.json");
			const acceptancePath = path.join(dir, "acceptance.json");
			fs.mkdirSync(outputPath);
			fs.writeFileSync(acceptancePath, JSON.stringify({ manualNotes: "stale" }), "utf-8");

			const error = clearStructuredOutputCaptures({ schema: { type: "object" }, schemaPath: path.join(dir, "schema.json"), outputPath, acceptanceReportPath: acceptancePath });

			assert.match(error ?? "", /Failed to clear stale structured output capture/);
			assert.equal(fs.existsSync(outputPath), true);
			assert.equal(fs.existsSync(acceptancePath), false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("scopes local structured_output schema refs under the value parameter", () => {
		{
			const schema = {
				$defs: { item: { type: "string" } },
				type: "object",
				properties: {
					name: { $ref: "#/$defs/item" },
					nested: {
						type: "object",
						properties: { label: { $ref: "#/$defs/item" } },
					},
				},
			};
			let parameters = {} as { properties?: { value?: { properties?: { name?: { $ref?: string }; nested?: { properties?: { label?: { $ref?: string } } } } } } };

			registerSubagentPromptRuntime({
				registerTool(tool: { name: string; parameters: unknown }) {
					if (tool.name === "structured_output") parameters = tool.parameters as typeof parameters;
				},
				on() {},
			} as { registerTool(tool: { name: string; parameters: unknown }): void; on(): void }, childConfig({ structuredOutput: { schema, capture: () => {} } }));

			assert.equal(parameters.properties?.value?.properties?.name?.$ref, "#/properties/value/$defs/item");
			assert.equal(parameters.properties?.value?.properties?.nested?.properties?.label?.$ref, "#/properties/value/$defs/item");
		}
	});

	it("strips only the project context block", () => {
		const rewritten = stripProjectContext(BASE_PROMPT);
		assert.ok(!rewritten.includes("# Project Context"));
		assert.ok(rewritten.includes("The following skills provide specialized instructions for specific tasks."));
		assert.ok(rewritten.includes("Current date: 2026-04-16"));
	});

	it("strips an XML <project_context> block as full project context removal", () => {
		const globalDir = getAgentDir();
		const prompt = [
			"You are a subagent.",
			"\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n",
			`<project_instructions path="${globalDir}/AGENTS.md">\nGlobal rules\n</project_instructions>\n\n`,
			"<project_instructions path=\"/repo/AGENTS.md\">\nRepo rules\n</project_instructions>\n\n",
			"</project_context>\n\n",
			"Current working directory: /repo",
		].join("");
		const rewritten = stripProjectContext(prompt);
		assert.ok(!rewritten.includes("<project_context>"));
		assert.ok(!rewritten.includes("<project_instructions"));
		assert.ok(rewritten.includes("Current working directory: /repo"));
	});

	it("strips only global context files while preserving repository context", () => {
		const globalDir = getAgentDir();
		const prompt = [
			"You are a subagent.",
			"\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n",
			`<project_instructions path="${globalDir}/AGENTS.md">\nGlobal rules\n</project_instructions>\n\n`,
			"<project_instructions path=\"/repo/AGENTS.md\">\nRepo rules\n</project_instructions>\n\n",
			"</project_context>\n\n",
			"Current working directory: /repo",
		].join("");
		const rewritten = stripGlobalContext(prompt);
		assert.ok(!rewritten.includes("Global rules"));
		assert.ok(rewritten.includes("Repo rules"));
		assert.ok(rewritten.includes("</project_context>"));
	});

	it("strips only global context files from legacy Markdown while preserving repository context", () => {
		const globalDir = getAgentDir();
		const prompt = [
			"You are a subagent.",
			"\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n",
			`## ${globalDir}/AGENTS.md\n\nGlobal rules\n\n`,
			"## /repo/AGENTS.md\n\nRepo rules\n\n",
			SKILLS_SECTION,
			"\nCurrent date: 2026-04-16",
		].join("");
		const rewritten = rewriteSubagentPrompt(prompt, {
			inheritProjectContext: true,
			inheritGlobalContext: false,
			inheritSkills: true,
		});
		assert.ok(!rewritten.includes("Global rules"));
		assert.ok(rewritten.includes("## /repo/AGENTS.md"));
		assert.ok(rewritten.includes("Repo rules"));
	});

	it("recognizes Pi context filenames case-insensitively", () => {
		const globalDir = getAgentDir();
		const prompt = [
			"You are a subagent.",
			"\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n",
			`<project_instructions path="${globalDir}/AGENTS.MD">\nGlobal rules\n</project_instructions>\n\n`,
			"<project_instructions path=\"/repo/AGENTS.MD\">\nRepo rules\n</project_instructions>\n\n",
			"</project_context>\n\n",
			"Current working directory: /repo",
		].join("");
		const rewritten = stripGlobalContext(prompt);
		assert.ok(!rewritten.includes("Global rules"));
		assert.ok(rewritten.includes("Repo rules"));
	});

	for (const [label, prompt] of [
		["CRLF context", `<project_context>\r\n<project_instructions path="${getAgentDir()}/AGENTS.md">\r\nGlobal rules\r\n</project_instructions>\r\n<project_instructions path="/repo/AGENTS.md">\r\nRepo rules\r\n</project_instructions>\r\n</project_context>`],
		["content without a trailing newline", `<project_context><project_instructions path="${getAgentDir()}/AGENTS.md">Global rules</project_instructions><project_instructions path="/repo/AGENTS.md">Repo rules</project_instructions></project_context>`],
		["same-line content", `<project_context><project_instructions path="${getAgentDir()}/CLAUDE.md">Global rules</project_instructions><project_instructions path="/repo/CLAUDE.md">Repo rules</project_instructions></project_context>`],
	] as const) {
		it(`strips global instructions from ${label}`, () => {
			const rewritten = stripGlobalContext(prompt);
			assert.ok(!rewritten.includes("Global rules"));
			assert.ok(rewritten.includes("Repo rules"));
		});
	}

	it("does not strip matching examples outside project context", () => {
		const example = `<project_instructions path="${getAgentDir()}/AGENTS.md">Example only</project_instructions>`;
		assert.equal(stripGlobalContext(example), example);
	});

	it("inherits global context when inheritGlobalContext is true", () => {
		const globalDir = getAgentDir();
		const prompt = [
			"You are a subagent.",
			"\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n",
			`<project_instructions path="${globalDir}/AGENTS.md">\nGlobal rules\n</project_instructions>\n\n`,
			"</project_context>\n\n",
			"Current working directory: /repo",
		].join("");
		const rewritten = rewriteSubagentPrompt(prompt, {
			inheritProjectContext: true,
			inheritGlobalContext: true,
			inheritSkills: true,
		});
		assert.ok(rewritten.includes("Global rules"));
	});

	it("removes global context files while keeping repository context via rewriteSubagentPrompt", () => {
		const globalDir = getAgentDir();
		const prompt = [
			"You are a subagent.",
			"\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n",
			`<project_instructions path="${globalDir}/AGENTS.md">\nGlobal rules\n</project_instructions>\n\n`,
			"<project_instructions path=\"/repo/AGENTS.md\">\nRepo rules\n</project_instructions>\n\n",
			"</project_context>\n\n",
			"Current working directory: /repo",
		].join("");
		const rewritten = rewriteSubagentPrompt(prompt, {
			inheritProjectContext: true,
			inheritGlobalContext: false,
			inheritSkills: true,
		});
		assert.ok(!rewritten.includes("Global rules"));
		assert.ok(rewritten.includes("Repo rules"));
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
			inheritGlobalContext: false,
			inheritSkills: false,
		});
		assert.ok(!rewritten.includes("# Project Context"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(rewritten.includes("Current working directory: /repo"));
	});

	it("injects a child-only boundary that forbids proposing or running subagents", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: true,
			inheritGlobalContext: true,
			inheritSkills: true,
		});

		assert.ok(rewritten.startsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
		assert.ok(rewritten.includes("Do not propose or run subagents."));
		assert.ok(rewritten.includes("If you need to edit files, use the available editing tools."));
		assert.ok(!rewritten.includes("call the actual edit/write tools"));
		assert.ok(rewritten.includes("Do not print tool-call syntax, patches, or pseudo-tool calls as text."));
		assert.equal(rewriteSubagentPrompt(rewritten, { inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: true }).indexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
		assert.equal(rewriteSubagentPrompt(rewritten, { inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: true }).lastIndexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
	});

	it("replaces inherited child boundaries with the fanout boundary when authorized", () => {
		const strictPrompt = `${CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS}\n\n${BASE_PROMPT}`;
		const rewritten = rewriteSubagentPrompt(strictPrompt, {
			inheritProjectContext: true,
			inheritGlobalContext: true,
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
			inheritGlobalContext: true,
			inheritSkills: true,
		});

		assert.ok(rewritten.startsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
		assert.ok(!rewritten.includes("explicit fanout responsibility"));
		assert.equal(rewritten.lastIndexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
	});

	it("keeps explicitly injected skill content when inherited skills are stripped", () => {
		const rewritten = rewriteSubagentPrompt(PROMPT_WITH_EXPLICIT_SKILL, {
			inheritProjectContext: false,
			inheritGlobalContext: false,
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
			inheritGlobalContext: false,
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
			inheritGlobalContext: true,
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
		assert.deepEqual(stripParentOnlySubagentMessages([user, subagentCall, subagentResult, instruction], { preserveFanoutToolHistory: true }), [user, subagentCall, subagentResult]);
	});

	it("defers native supervisor registration until runtime events and respects installed pi-intercom tools", async () => {
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
		} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(tool: { name: string }): void }, supervisorConfig());

		assert.deepEqual(registered, ["bg_wait"]);
		handlers.get("session_start")?.({});
		await handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT });
		assert.deepEqual(registered, ["bg_wait"]);
	});

	it("does not satisfy strict allowlists with native generic intercom", () => {
		{
			const diagnostics: Array<ChildToolDiagnostic | undefined> = [];
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			const registered: string[] = [];

			registerSubagentPromptRuntime({
				on(event: string, handler: (payload?: unknown) => unknown) {
					handlers.set(event, handler);
				},
				getAllTools: () => registered.map((name) => ({ name })),
				registerTool(tool: { name: string }) {
					registered.push(tool.name);
				},
			} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(tool: { name: string }): void }, supervisorConfig({
				agent: "scout",
				requiredTools: ["read", "grep", "find", "ls", "bash", "edit", "write", "intercom"],
				toolDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			}));

			handlers.get("session_start")?.({});
			assert.deepEqual(registered, ["bg_wait", "contact_supervisor"]);
			assert.throws(() => handlers.get("agent_start")?.({}), /requested unavailable child tools: read, grep, find, ls, bash, edit, write, intercom/);
			assert.deepEqual(diagnostics, [{
				agent: "scout",
				required: ["read", "grep", "find", "ls", "bash", "edit", "write", "intercom"],
				available: ["bg_wait", "contact_supervisor"],
				missing: ["read", "grep", "find", "ls", "bash", "edit", "write", "intercom"],
			}]);
		}
	});

	it("records missing core write tools from the actual child registry", () => {
		{
			const diagnostics: Array<ChildToolDiagnostic | undefined> = [];
			const handlers = new Map<string, (payload?: unknown) => unknown>();

			registerSubagentPromptRuntime({
				on(event: string, handler: (payload?: unknown) => unknown) {
					handlers.set(event, handler);
				},
				getAllTools: () => ["read", "grep", "find", "ls", "contact_supervisor"].map((name) => ({ name })),
				registerTool() {},
			} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(): void }, childConfig({
				agent: "worker",
				requiredTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
				toolDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			}));

			assert.throws(() => handlers.get("agent_start")?.({}), /requested unavailable child tools: bash, edit, write/);
			assert.deepEqual(diagnostics, [{
				agent: "worker",
				required: ["read", "grep", "find", "ls", "bash", "edit", "write"],
				available: ["read", "grep", "find", "ls", "contact_supervisor"],
				missing: ["bash", "edit", "write"],
			}]);
		}
	});

	it("keeps installed pi-intercom while filling only a missing child contact_supervisor tool", async () => {
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
		} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(tool: { name: string }): void }, supervisorConfig());

		handlers.get("session_start")?.({});
		await handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT });

		assert.deepEqual(registered, ["bg_wait", "contact_supervisor"]);
	});

	it("registers only native supervisor tools at runtime when pi-intercom is absent", async () => {
		const handlers = new Map<string, (payload?: unknown) => unknown>();
		const registered: string[] = [];

		{
			registerSubagentPromptRuntime({
				on(event: string, handler: (payload?: unknown) => unknown) {
					handlers.set(event, handler);
				},
				getAllTools: () => registered.map((name) => ({ name })),
				registerTool(tool: { name: string }) {
					registered.push(tool.name);
				},
			} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(tool: { name: string }): void }, supervisorConfig());

			handlers.get("session_start")?.({});
			assert.deepEqual(registered, ["bg_wait", "contact_supervisor"]);

			await handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT });
			assert.deepEqual(registered, ["bg_wait", "contact_supervisor"]);
		}
	});

	it("records requested tools missing from the child registry after startup hooks settle", async () => {
		{
			const diagnostics: Array<ChildToolDiagnostic | undefined> = [];
			const handlers = new Map<string, (payload?: unknown) => unknown>();
			const available = ["read"];

			registerSubagentPromptRuntime({
				on(event: string, handler: (payload?: unknown) => unknown) {
					handlers.set(event, handler);
				},
				getAllTools: () => available.map((name) => ({ name })),
				registerTool() {},
			} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(): void }, childConfig({
				agent: "extension-worker",
				requiredTools: ["read", "fixture_search"],
				toolDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			}));

			const promptRewrite = await handlers.get("before_agent_start")?.({ systemPrompt: BASE_PROMPT }) as { systemPrompt?: string } | undefined;
			assert.deepEqual(diagnostics, []);
			assert.doesNotMatch(promptRewrite?.systemPrompt ?? "", /requested unavailable child tools/);

			assert.throws(() => handlers.get("agent_start")?.({}), /requested unavailable child tools: fixture_search/);
			assert.deepEqual(diagnostics, [{
				agent: "extension-worker",
				required: ["read", "fixture_search"],
				available: ["read"],
				missing: ["fixture_search"],
			}]);

			available.push("fixture_search");
			handlers.get("agent_start")?.({});
			assert.equal(diagnostics.at(-1), undefined);
		}
	});

	it("classifies missing resolved MCP direct tools without softening strict diagnostics", () => {
		{
			const diagnostics: Array<ChildToolDiagnostic | undefined> = [];
			const handlers = new Map<string, (payload?: unknown) => unknown>();

			registerSubagentPromptRuntime({
				on(event: string, handler: (payload?: unknown) => unknown) {
					handlers.set(event, handler);
				},
				getAllTools: () => [{ name: "read" }],
				registerTool() {},
			} as { on(event: string, handler: (payload?: unknown) => unknown): void; getAllTools(): Array<{ name: string }>; registerTool(): void }, childConfig({
				agent: "worker",
				requiredTools: ["read", "rust_symbols_workspace_symbols", "fixture_search"],
				mcpDirectTools: ["rust_symbols_workspace_symbols"],
				toolDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			}));

			assert.throws(() => handlers.get("agent_start")?.({}), /requested unavailable child tools: rust_symbols_workspace_symbols, fixture_search/);
			const diagnostic = diagnostics[0];
			assert.deepEqual(diagnostic, {
				agent: "worker",
				required: ["read", "rust_symbols_workspace_symbols", "fixture_search"],
				available: ["read"],
				missing: ["rust_symbols_workspace_symbols", "fixture_search"],
				missingMcpDirectTools: ["rust_symbols_workspace_symbols"],
			});
			assert.match(formatChildToolDiagnostic(diagnostic!), /host\/pi-mcp-adapter registration problem/);
			assert.match(formatChildToolDiagnostic(diagnostic!), /fixture_search/);
		}
	});

	it("sets the child intercom session name from the config during agent startup", async () => {
		let sessionName: string | undefined;
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;

		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
			getAllTools: () => [{ name: "intercom" }, { name: "contact_supervisor" }],
			setSessionName(name: string) {
				sessionName = name;
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void; getAllTools(): Array<{ name: string }>; setSessionName(name: string): void }, childConfig({ intercomSessionName: "subagent-worker-78f659a3", sessionName: "worker: display name" }));

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
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void; getAllTools(): Array<{ name: string }> }, childConfig({ inheritProjectContext: false, inheritGlobalContext: true, inheritSkills: false }));

		assert.ok(beforeAgentStart, "expected before_agent_start handler");

		const rewritten = await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });
		assert.ok(rewritten);
		assert.ok(!rewritten.systemPrompt.includes("# Project Context"));
		assert.ok(!rewritten.systemPrompt.includes("<available_skills>"));
		assert.ok(rewritten.systemPrompt.includes("Current date: 2026-04-16"));
	});

	it("uses the fanout boundary through before_agent_start for a fanout child", async () => {
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
			getAllTools: () => [{ name: "intercom" }, { name: "contact_supervisor" }],
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void; getAllTools(): Array<{ name: string }> }, childConfig({ fanoutChild: true, inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: true }));

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
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void }, childConfig());

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
		} as { on(event: string, handler: (payload: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined): void }, childConfig());

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
		} as { on(event: string, handler: (payload: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined): void }, childConfig());

		const toolCallId = "call_7XJjvAJfk07117JO8LgBCZjY|fc_0e92b09b28010bac016a756e9e79cc8197b01825a5dc3d9eaa";
		const messages = [
			{ role: "user", content: "Task" },
			{ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "read", input: { path: "README.md" } }] },
			{ role: "toolResult", toolName: "read", toolCallId, content: "file" },
		];

		assert.equal(contextHandler?.({ messages }, { model: { api: "openai-responses" } }), undefined);
	});

	it("preserves composite tool ids for cursor-native children", () => {
		let contextHandler: ((event: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined): void }, childConfig());

		const toolCallId = "call_7XJjvAJfk07117JO8LgBCZjY\nfc_0e92b09b28010bac016a756e9e79cc8197b01825a5dc3d9eaa";
		const messages = [
			{ role: "user", content: "Task" },
			{ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "read", input: { path: "README.md" } }] },
			{ role: "toolResult", toolName: "read", toolCallId, content: "file" },
		];

		assert.equal(contextHandler?.({ messages }, { model: { api: "cursor-native" } }), undefined);
		assert.equal((messages[1] as { content: Array<{ id?: unknown }> }).content[0]?.id, toolCallId);
		assert.equal((messages[2] as { toolCallId?: unknown }).toolCallId, toolCallId);
	});

	it("does not rewrite child context when no parent-only artifacts are present", () => {
		let contextHandler: ((event: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }, ctx: { model?: { api: string } }) => { messages: unknown[] } | undefined): void }, childConfig());

		const messages = [
			{ role: "user", content: "Task" },
			{ role: "toolResult", toolName: "read", content: "file" },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", input: { path: "README.md" } }] },
		];

		assert.equal(contextHandler?.({ messages }, {}), undefined);
	});
});
