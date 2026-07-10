import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { computeMcpServerHash } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";
import { TOOL_BUDGET_ENV } from "../../src/runs/shared/tool-budget.ts";
import { CHILD_WATCHDOG_CONFIG_ENV } from "../../src/watchdog/child-status.ts";
import {
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_PARENT_SESSION_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
	SUBAGENT_RUN_ID_ENV,
	applyThinkingSuffix,
	buildPiArgs,
} from "../../src/runs/shared/pi-args.ts";

const originalEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_SUBAGENT_FANOUT_CHILD: process.env.PI_SUBAGENT_FANOUT_CHILD,
	PI_SUBAGENT_PARENT_EVENT_SINK: process.env.PI_SUBAGENT_PARENT_EVENT_SINK,
	PI_SUBAGENT_PARENT_CONTROL_INBOX: process.env.PI_SUBAGENT_PARENT_CONTROL_INBOX,
	PI_SUBAGENT_PARENT_ROOT_RUN_ID: process.env.PI_SUBAGENT_PARENT_ROOT_RUN_ID,
	PI_SUBAGENT_PARENT_RUN_ID: process.env.PI_SUBAGENT_PARENT_RUN_ID,
	PI_SUBAGENT_PARENT_CHILD_INDEX: process.env.PI_SUBAGENT_PARENT_CHILD_INDEX,
	PI_SUBAGENT_PARENT_DEPTH: process.env.PI_SUBAGENT_PARENT_DEPTH,
	PI_SUBAGENT_PARENT_PATH: process.env.PI_SUBAGENT_PARENT_PATH,
	PI_SUBAGENT_PARENT_CAPABILITY_TOKEN: process.env.PI_SUBAGENT_PARENT_CAPABILITY_TOKEN,
	PI_SUBAGENT_PARENT_SESSION: process.env.PI_SUBAGENT_PARENT_SESSION,
	PI_SUBAGENT_RUN_ID: process.env.PI_SUBAGENT_RUN_ID,
};
const originalCwd = process.cwd();
const tempRoots: string[] = [];

interface McpFixture {
	root: string;
	agentDir: string;
	projectDir: string;
}

function createMcpFixture(): McpFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-mcp-"));
	tempRoots.push(root);
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".pi", "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.chdir(projectDir);
	return { root, agentDir, projectDir };
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeMcpFixture(
	fixture: McpFixture,
	options: {
		serverName?: string;
		definition?: Record<string, unknown>;
		settings?: Record<string, unknown>;
		tools?: Array<{ name: string; description?: string }>;
		resources?: Array<{ name: string; uri: string; description?: string }>;
		configPath?: string;
		cachedAt?: number;
	} = {},
): void {
	const serverName = options.serverName ?? "chrome-devtools";
	const definition = { command: "npx", args: ["chrome-devtools-mcp"], ...(options.definition ?? {}) };
	writeJson(options.configPath ?? path.join(fixture.agentDir, "mcp.json"), {
		...(options.settings ? { settings: options.settings } : {}),
		mcpServers: {
			[serverName]: definition,
		},
	});
	writeJson(path.join(fixture.agentDir, "mcp-cache.json"), {
		version: 1,
		servers: {
			[serverName]: {
				configHash: computeMcpServerHash(definition),
				cachedAt: options.cachedAt ?? Date.now(),
				tools: options.tools ?? [
					{ name: "take_screenshot" },
					{ name: "click" },
				],
				resources: options.resources ?? [],
			},
		},
	});
}

afterEach(() => {
	process.chdir(originalCwd);
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("buildPiArgs session wiring", () => {
	it("uses --session when sessionFile is provided", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-session-"));
		try {
			const sessionFile = path.join(tempDir, "nested", "session.jsonl");
			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: true,
				sessionFile,
				sessionDir: "/tmp/should-not-be-used",
				inheritProjectContext: false,
				inheritSkills: false,
			});

			assert.ok(args.includes("--session"));
			assert.ok(args.includes(sessionFile));
			assert.ok(fs.existsSync(path.dirname(sessionFile)));
			assert.ok(!args.includes("--session-dir"), "--session-dir should not be emitted with --session");
			assert.ok(!args.includes("--no-session"), "--no-session should not be emitted with --session");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps fresh mode behavior (sessionDir + no session file)", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: true,
			sessionDir: "/tmp/subagent-sessions",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--session-dir"));
		assert.ok(args.includes("/tmp/subagent-sessions"));
		assert.ok(!args.includes("--session"));
	});

	it("emits explicit parent session env for permission forwarding", () => {
		process.env.PI_SUBAGENT_PARENT_SESSION = "inherited-parent";
		const { env } = buildPiArgs({
			parentSessionId: "direct-parent",
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(env[SUBAGENT_PARENT_SESSION_ENV], "direct-parent");
	});

	it("falls back to inherited parent session env for permission forwarding", () => {
		process.env.PI_SUBAGENT_PARENT_SESSION = "inherited-parent";
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(env[SUBAGENT_PARENT_SESSION_ENV], "inherited-parent");
	});

	it("passes child watchdog config only when explicitly provided", () => {
		const withoutWatchdog = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});
		assert.equal(withoutWatchdog.env[CHILD_WATCHDOG_CONFIG_ENV], undefined);

		const withWatchdog = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			childWatchdog: {
				enabled: true,
				runId: "run-1",
				agent: "worker",
				childIndex: 2,
				watchdogTailTimeoutMs: 1234,
				agentEndTimeoutMs: 500,
				maxWarnings: 1,
				lsp: { enabled: false, timeoutMs: 50, maxFiles: 2, maxDiagnostics: 3 },
				autoFollowBlockers: true,
				autoFollowMaxAttempts: 3,
				stalemateRepeats: 2,
			},
		});
		const encoded = withWatchdog.env[CHILD_WATCHDOG_CONFIG_ENV];
		assert.equal(typeof encoded, "string");
		assert.deepEqual(JSON.parse(encoded ?? "{}"), {
			enabled: true,
			runId: "run-1",
			agent: "worker",
			childIndex: 2,
			watchdogTailTimeoutMs: 1234,
			agentEndTimeoutMs: 500,
			maxWarnings: 1,
			lsp: { enabled: false, timeoutMs: 50, maxFiles: 2, maxDiagnostics: 3 },
			autoFollowBlockers: true,
			autoFollowMaxAttempts: 3,
			stalemateRepeats: 2,
		});
	});
});

describe("buildPiArgs model wiring", () => {
	it("uses --model for provider-qualified model ids", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "openai-codex/gpt-5.4-mini",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes("openai-codex/gpt-5.4-mini"));
		assert.ok(!args.includes("--models"));
	});

	it("uses --model for bare model ids too", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "kimi-k2.5",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes("kimi-k2.5"));
		assert.ok(!args.includes("--models"));
	});


	it("preserves thinking suffixes on model args", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "openai-codex/gpt-5.4-mini",
			thinking: "high",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(applyThinkingSuffix("openai-codex/gpt-5.4-mini", "high"), "openai-codex/gpt-5.4-mini:high");
		assert.ok(args.includes("--model"));
		assert.ok(args.includes("openai-codex/gpt-5.4-mini:high"));
	});

	it("passes max thinking through to the model argument", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			model: "openai/gpt-5",
			thinking: "max",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(applyThinkingSuffix("openai/gpt-5", "max"), "openai/gpt-5:max");
		assert.equal(applyThinkingSuffix("openai/gpt-5:max", "high"), "openai/gpt-5:max");
		assert.equal(applyThinkingSuffix("openai/gpt-5:max", "high", true), "openai/gpt-5:high");
		assert.ok(args.includes("--model"));
		assert.ok(args.includes("openai/gpt-5:max"));
	});

	it("passes explicit thinking off through to the model arg", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "anthropic/claude-haiku-4-5",
			thinking: "off",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(applyThinkingSuffix("anthropic/claude-haiku-4-5", "off"), "anthropic/claude-haiku-4-5:off");
		assert.equal(applyThinkingSuffix("anthropic/claude-haiku-4-5:high", "off", true), "anthropic/claude-haiku-4-5:off");
		assert.ok(args.includes("--model"));
		assert.ok(args.includes("anthropic/claude-haiku-4-5:off"));
	});

	it("does not append a thinking suffix for boolean false", () => {
		const model = "glm-5.2-short-fast";
		const once = applyThinkingSuffix(model, false);
		assert.equal(once, model);
		assert.equal(applyThinkingSuffix(once, false), model);

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model,
			thinking: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes(model));
		assert.ok(!args.some((arg) => arg.includes(":false")));
	});

	it("leaves provider-specific model suffixes untouched when thinking is disabled", () => {
		const model = "openai-compatible/qwen2.5-coder:7b";
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model,
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes(model));
		assert.ok(!args.includes(`${model}:high`));
	});
});

describe("buildPiArgs system prompt mode wiring", () => {
	it("uses --append-system-prompt by default", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			systemPrompt: "You are a worker",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--append-system-prompt"));
		assert.ok(!args.includes("--system-prompt"));
	});

	it("uses --system-prompt when systemPromptMode=replace", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			systemPrompt: "You are a worker",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--system-prompt"));
		assert.ok(!args.includes("--append-system-prompt"));
	});

	it("injects the subagent prompt runtime extension and env flags", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: true,
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.equal(env.PI_SUBAGENT_CHILD, "1");
		assert.equal(env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT, "0");
		assert.equal(env.PI_SUBAGENT_INHERIT_SKILLS, "1");
	});

	it("passes tool budget through env", () => {
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			toolBudget: { soft: 2, hard: 3, block: ["read"] },
		});

		assert.deepEqual(JSON.parse(env[TOOL_BUDGET_ENV] ?? "{}"), { soft: 2, hard: 3, block: ["read"] });
	});

	it("passes child intercom and orchestrator metadata through env", () => {
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: true,
			intercomSessionName: "subagent-worker-78f659a3",
			orchestratorIntercomTarget: "subagent-chat-parent",
			parentSessionId: "session-parent-123",
			runId: "78f659a3",
			childAgentName: "worker",
			childIndex: 2,
		});

		assert.equal(env.PI_SUBAGENT_INTERCOM_SESSION_NAME, "subagent-worker-78f659a3");
		assert.equal(env.PI_SUBAGENT_ORCHESTRATOR_TARGET, "subagent-chat-parent");
		assert.equal(env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV], "session-parent-123");
		assert.equal(env.PI_SUBAGENT_RUN_ID, "78f659a3");
		assert.equal(env.PI_SUBAGENT_CHILD_AGENT, "worker");
		assert.equal(env.PI_SUBAGENT_CHILD_INDEX, "2");
		assert.equal(typeof env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV], "string");
		assert.match(env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] ?? "", /supervisor-channels/);
	});

	it("does not create a supervisor channel without an exact parent session id", () => {
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: true,
			orchestratorIntercomTarget: "subagent-chat-parent",
			runId: "78f659a3",
			childAgentName: "worker",
			childIndex: 2,
		});

		assert.equal(env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV], undefined);
		assert.equal(env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV], undefined);
	});

	it("emits explicit builtin tool allowlists", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
		});

		const toolsArg = args[args.indexOf("--tools") + 1];
		assert.equal(toolsArg, "read,grep,find,ls,bash,edit,write,contact_supervisor");
	});

	it("adds read to explicit tool allowlists when skills must be loaded lazily", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			requireReadTool: true,
			tools: ["bash"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
	});

	it("does not duplicate read in explicit tool allowlists for lazy skills", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			requireReadTool: true,
			tools: ["read", "bash"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
	});

	it("augments explicit builtin allowlists with selected direct MCP tool names", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture);

		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			mcpDirectTools: ["chrome-devtools"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,bash,chrome_devtools_take_screenshot,chrome_devtools_click");
		assert.equal(env.MCP_DIRECT_TOOLS, "chrome-devtools");
	});

	it("preserves no --tools for MCP-only agents", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture);

		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			mcpDirectTools: ["chrome-devtools"],
		});

		assert.equal(args.includes("--tools"), false);
		assert.equal(env.MCP_DIRECT_TOOLS, "chrome-devtools");
	});

	it("supports direct MCP server/tool filters", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, {
			serverName: "github",
			definition: { command: "github-mcp" },
			tools: [{ name: "search_repositories" }, { name: "create_issue" }],
		});

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["github/search_repositories"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,github_search_repositories");
	});

	it("matches adapter prefix modes for direct MCP names", () => {
		for (const [prefix, expected] of [
			["server", "read,linear_mcp_list_issues"],
			["short", "read,linear_list_issues"],
			["none", "read,list_issues"],
		] as const) {
			const fixture = createMcpFixture();
			writeMcpFixture(fixture, {
				serverName: "linear-mcp",
				settings: { toolPrefix: prefix },
				tools: [{ name: "list_issues" }],
			});

			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				tools: ["read"],
				mcpDirectTools: ["linear-mcp"],
			});

			assert.equal(args[args.indexOf("--tools") + 1], expected);
		}
	});

	it("includes resource tools and respects excludeTools", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, {
			serverName: "browser-mcp",
			definition: { excludeTools: ["browser_click"] },
			tools: [{ name: "click" }, { name: "navigate" }],
			resources: [{ name: "Console Logs", uri: "resource://console" }],
		});

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["browser-mcp"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,browser_mcp_navigate,browser_mcp_get_console_logs");
	});

	it("falls back to explicit builtins when direct MCP cache or config is missing or invalid", () => {
		const missingFixture = createMcpFixture();
		writeJson(path.join(missingFixture.agentDir, "mcp.json"), {
			mcpServers: { "chrome-devtools": { command: "npx", args: ["chrome-devtools-mcp"] } },
		});
		const missingCache = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			mcpDirectTools: ["chrome-devtools"],
		});
		assert.equal(missingCache.args[missingCache.args.indexOf("--tools") + 1], "read,bash");

		const invalidFixture = createMcpFixture();
		writeMcpFixture(invalidFixture, { cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 });
		const staleCache = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			mcpDirectTools: ["chrome-devtools"],
		});
		assert.equal(staleCache.args[staleCache.args.indexOf("--tools") + 1], "read,bash");
	});

	it("resolves project MCP config from the child cwd and expands PI_CODING_AGENT_DIR", () => {
		const fixture = createMcpFixture();
		process.env.PI_CODING_AGENT_DIR = "~/.pi/agent";
		process.chdir(fixture.root);
		writeMcpFixture(fixture, {
			serverName: "project-mcp",
			configPath: path.join(fixture.projectDir, ".mcp.json"),
			tools: [{ name: "inspect" }],
		});

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["project-mcp"],
			cwd: fixture.projectDir,
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,project_mcp_inspect");
	});

	it("keeps tool extension paths when explicit extensions are allowlisted", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, { tools: [{ name: "take_screenshot" }] });

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "./custom-tool.ts"],
			extensions: ["./allowed-ext.ts"],
			mcpDirectTools: ["chrome-devtools"],
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.equal(args[args.indexOf("--tools") + 1], "read,chrome_devtools_take_screenshot");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.ok(extensionArgs.includes("./custom-tool.ts"));
		assert.ok(extensionArgs.includes("./allowed-ext.ts"));
	});

	it("loads subagent-only extension paths only through child process extension args", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			extensions: ["./main-allowed-ext.ts"],
			subagentOnlyExtensions: ["./child-tool.ts"],
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(args.includes("--no-extensions"));
		assert.equal(args[args.indexOf("--tools") + 1], "read");
		assert.ok(extensionArgs.includes("./main-allowed-ext.ts"));
		assert.ok(extensionArgs.includes("./child-tool.ts"));
	});

	it("authorizes child fanout only from exact declared builtin subagent", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "subagent"],
			runId: "parent-run",
			childIndex: 1,
			parentEventSink: "/tmp/root/events",
			parentControlInbox: "/tmp/root/control",
			parentRootRunId: "root-run",
			parentCapabilityToken: "token-1",
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.equal(args[args.indexOf("--tools") + 1], "read,subagent");
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "1");
		assert.equal(env[SUBAGENT_PARENT_EVENT_SINK_ENV], "/tmp/root/events");
		assert.equal(env[SUBAGENT_PARENT_CONTROL_INBOX_ENV], "/tmp/root/control");
		assert.equal(env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "root-run");
		assert.equal(env[SUBAGENT_PARENT_RUN_ID_ENV], "parent-run");
		assert.equal(env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "1");
		assert.equal(env[SUBAGENT_PARENT_DEPTH_ENV], "1");
		assert.deepEqual(JSON.parse(env[SUBAGENT_PARENT_PATH_ENV] ?? "[]"), [{ runId: "parent-run", stepIndex: 1 }]);
		assert.equal(env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV], "token-1");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "extension", "fanout-child.ts"))));
	});

	it("clears all fanout routing env values for non-fanout children", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "mcp:server/subagent"],
			parentEventSink: "/tmp/should-not-leak/events",
			parentControlInbox: "/tmp/should-not-leak/control",
			parentRootRunId: "root-should-not-leak",
			parentRunId: "should-not-leak",
			parentChildIndex: 9,
			parentCapabilityToken: "token-should-not-leak",
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "0");
		assert.equal(env[SUBAGENT_PARENT_EVENT_SINK_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_CONTROL_INBOX_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_RUN_ID_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_DEPTH_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_PATH_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV], "");
		assert.ok(!extensionArgs.some((arg) => arg.endsWith(path.join("src", "extension", "fanout-child.ts"))));
	});

	it("inherits routing env only for authorized fanout children", () => {
		process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = "/tmp/inherited/events";
		process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = "/tmp/inherited/control";
		process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = "inherited-root";
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "inherited-run";
		process.env[SUBAGENT_RUN_ID_ENV] = "owner-run";
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "4";
		process.env[SUBAGENT_PARENT_DEPTH_ENV] = "2";
		process.env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify([{ runId: "root-run", stepIndex: 0 }, { runId: "../unsafe", stepIndex: 1 }, { runId: "owner-run", stepIndex: 1 }]);
		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = "inherited-token";

		const fanout = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["subagent"],
		});
		assert.equal(fanout.env[SUBAGENT_PARENT_EVENT_SINK_ENV], "/tmp/inherited/events");
		assert.equal(fanout.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV], "/tmp/inherited/control");
		assert.equal(fanout.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "inherited-root");
		assert.equal(fanout.env[SUBAGENT_PARENT_RUN_ID_ENV], "owner-run");
		assert.equal(fanout.env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "4");
		assert.equal(fanout.env[SUBAGENT_PARENT_DEPTH_ENV], "3");
		assert.deepEqual(JSON.parse(fanout.env[SUBAGENT_PARENT_PATH_ENV] ?? "[]"), [{ runId: "root-run", stepIndex: 0 }, { runId: "owner-run", stepIndex: 1 }, { runId: "owner-run", stepIndex: 4 }]);
		assert.equal(fanout.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV], "inherited-token");

		const nonFanout = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
		});
		assert.equal(nonFanout.env[SUBAGENT_FANOUT_CHILD_ENV], "0");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_EVENT_SINK_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_RUN_ID_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_DEPTH_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_PATH_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV], "");
	});

	it("prefers the current subagent run id over inherited ancestor ids for nested fanout routing", () => {
		process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = "/tmp/inherited/events";
		process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = "/tmp/inherited/control";
		process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = "root-run";
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "older-parent";
		process.env[SUBAGENT_RUN_ID_ENV] = "ancestor-run";
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "4";
		process.env[SUBAGENT_PARENT_DEPTH_ENV] = "1";
		process.env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify([{ runId: "root-run", stepIndex: 0 }]);
		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = "inherited-token";

		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["subagent"],
			runId: "current-nested-run",
			childIndex: 2,
		});

		assert.equal(env[SUBAGENT_PARENT_RUN_ID_ENV], "current-nested-run");
		assert.equal(env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "2");
		assert.equal(env[SUBAGENT_PARENT_DEPTH_ENV], "2");
		assert.deepEqual(JSON.parse(env[SUBAGENT_PARENT_PATH_ENV] ?? "[]"), [{ runId: "root-run", stepIndex: 0 }, { runId: "current-nested-run", stepIndex: 2 }]);
	});

	it("does not let direct MCP tools authorize child fanout", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, {
			serverName: "delegator",
			definition: { command: "delegator-mcp" },
			tools: [{ name: "subagent" }],
		});

		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["delegator"],
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.equal(args[args.indexOf("--tools") + 1], "read,delegator_subagent");
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "0");
		assert.ok(!extensionArgs.some((arg) => arg.endsWith(path.join("src", "extension", "fanout-child.ts"))));
	});

	it("keeps child-safe fanout registration in explicit extensions mode", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["subagent"],
			extensions: ["./agent-allowed-ext.ts"],
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(args.includes("--no-extensions"));
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "1");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "extension", "fanout-child.ts"))));
		assert.ok(extensionArgs.includes("./agent-allowed-ext.ts"));
	});

	it("emits an empty prompt file when replace mode is used with an empty prompt", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			systemPrompt: "",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--system-prompt"));
	});
});
