import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { applyThinkingSuffix, buildPiArgs } from "../../src/runs/shared/pi-args.ts";

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

	it("passes child intercom and orchestrator metadata through env", () => {
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: true,
			intercomSessionName: "subagent-worker-78f659a3",
			orchestratorIntercomTarget: "subagent-chat-parent",
			runId: "78f659a3",
			childAgentName: "worker",
			childIndex: 2,
		});

		assert.equal(env.PI_SUBAGENT_INTERCOM_SESSION_NAME, "subagent-worker-78f659a3");
		assert.equal(env.PI_SUBAGENT_ORCHESTRATOR_TARGET, "subagent-chat-parent");
		assert.equal(env.PI_SUBAGENT_RUN_ID, "78f659a3");
		assert.equal(env.PI_SUBAGENT_CHILD_AGENT, "worker");
		assert.equal(env.PI_SUBAGENT_CHILD_INDEX, "2");
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

	it("keeps tool extension paths when explicit extensions are allowlisted", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "./custom-tool.ts"],
			extensions: ["./allowed-ext.ts"],
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.ok(extensionArgs.includes("./custom-tool.ts"));
		assert.ok(extensionArgs.includes("./allowed-ext.ts"));
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

describe("buildPiArgs MCP direct tool allowlist", () => {
	let agentDir: string;
	let origEnv: string | undefined;

	function setup(cacheContent?: object, mcpConfig?: object) {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-mcp-"));
		origEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		if (cacheContent) {
			fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(cacheContent));
		}
		if (mcpConfig) {
			fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(mcpConfig));
		}
	}

	function teardown() {
		process.env.PI_CODING_AGENT_DIR = origEnv;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}

	const cacheWithChromeDevtools = {
		servers: {
			"chrome-devtools": {
				configHash: "abc",
				tools: [
					{ name: "take_screenshot", description: "Take a screenshot" },
					{ name: "navigate", description: "Navigate to URL" },
				],
				resources: [],
				cachedAt: new Date().toISOString(),
			},
		},
	};

	function getToolsList(args: string[]): string[] {
		const idx = args.indexOf("--tools");
		if (idx === -1) return [];
		return args[idx + 1]!.split(",");
	}

	it("includes prefixed MCP direct tool names in --tools (default server prefix)", () => {
		setup(cacheWithChromeDevtools);
		try {
			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				tools: ["read", "bash"],
				mcpDirectTools: ["chrome-devtools"],
			});

			const toolsList = getToolsList(args);
			assert.ok(toolsList.includes("read"));
			assert.ok(toolsList.includes("bash"));
			assert.ok(toolsList.includes("chrome_devtools_take_screenshot"),
				`expected chrome_devtools_take_screenshot, got: ${toolsList}`);
			assert.ok(toolsList.includes("chrome_devtools_navigate"),
				`expected chrome_devtools_navigate, got: ${toolsList}`);
		} finally {
			teardown();
		}
	});

	it("uses short prefix (strips -mcp suffix, replaces dashes)", () => {
		const cache = {
			servers: {
				"firebase-mcp": {
					configHash: "x",
					tools: [{ name: "deploy", description: "Deploy" }],
					resources: [],
					cachedAt: new Date().toISOString(),
				},
			},
		};
		setup(cache, { settings: { toolPrefix: "short" } });
		try {
			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				tools: ["read"],
				mcpDirectTools: ["firebase-mcp"],
			});

			const toolsList = getToolsList(args);
			assert.ok(toolsList.includes("firebase_deploy"),
				`expected firebase_deploy, got: ${toolsList}`);
		} finally {
			teardown();
		}
	});

	it("uses no prefix when toolPrefix is none", () => {
		setup(cacheWithChromeDevtools, { settings: { toolPrefix: "none" } });
		try {
			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				tools: ["read"],
				mcpDirectTools: ["chrome-devtools"],
			});

			const toolsList = getToolsList(args);
			assert.ok(toolsList.includes("take_screenshot"),
				`expected take_screenshot, got: ${toolsList}`);
			assert.ok(toolsList.includes("navigate"),
				`expected navigate, got: ${toolsList}`);
		} finally {
			teardown();
		}
	});

	it("includes MCP tools in --tools even without explicit builtin tools", () => {
		setup(cacheWithChromeDevtools);
		try {
			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				mcpDirectTools: ["chrome-devtools"],
			});

			const toolsList = getToolsList(args);
			assert.ok(toolsList.includes("chrome_devtools_take_screenshot"),
				`expected chrome_devtools_take_screenshot, got: ${toolsList}`);
			assert.ok(toolsList.includes("chrome_devtools_navigate"),
				`expected chrome_devtools_navigate, got: ${toolsList}`);
			// Should NOT include random builtins — only MCP tools
			assert.ok(!toolsList.includes("read"));
			assert.ok(!toolsList.includes("bash"));
		} finally {
			teardown();
		}
	});

	it("falls back gracefully when mcp-cache.json is missing", () => {
		setup(); // no cache file
		try {
			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				tools: ["read", "bash"],
				mcpDirectTools: ["chrome-devtools"],
			});

			const toolsList = getToolsList(args);
			// Only explicit tools, no MCP tools resolved
			assert.deepEqual(toolsList, ["read", "bash"]);
		} finally {
			teardown();
		}
	});

	it("ignores server not present in cache", () => {
		setup(cacheWithChromeDevtools);
		try {
			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				tools: ["read"],
				mcpDirectTools: ["nonexistent-server"],
			});

			const toolsList = getToolsList(args);
			// Only explicit tools, unknown server silently ignored
			assert.deepEqual(toolsList, ["read"]);
		} finally {
			teardown();
		}
	});
});
