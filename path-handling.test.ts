import assert from "node:assert/strict";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

/**
 * Tests for cross-platform path handling patterns used throughout the codebase.
 * These tests document the correct patterns after fixes were applied.
 *
 * Fixed locations:
 * - chain-execution.ts — uses path.isAbsolute() for absolute path detection
 * - settings.ts — uses path.join() for path construction
 */

describe("path.isAbsolute vs startsWith('/')", () => {
	// chain-execution.ts:496 uses startsWith("/") to detect absolute paths.
	// On Windows, absolute paths look like "C:\..." or "C:/..." — neither starts with "/".

	it("startsWith('/') misses Windows absolute paths", () => {
		const windowsAbsolute = "C:\\dev\\pi-subagents\\output.md";
		const windowsAbsoluteForward = "C:/dev/pi-subagents/output.md";

		// This is what the current code does (chain-execution.ts:496):
		assert.equal(windowsAbsolute.startsWith("/"), false,
			"Windows backslash absolute path not detected by startsWith('/')");
		assert.equal(windowsAbsoluteForward.startsWith("/"), false,
			"Windows forward-slash absolute path not detected by startsWith('/')");

		// This is what the code SHOULD do:
		assert.equal(path.isAbsolute(windowsAbsolute), process.platform === "win32",
			"path.isAbsolute correctly identifies Windows paths on Windows");
		assert.equal(path.isAbsolute(windowsAbsoluteForward), process.platform === "win32",
			"path.isAbsolute correctly identifies forward-slash Windows paths on Windows");

		// POSIX paths work with both approaches
		assert.equal("/home/user/output.md".startsWith("/"), true);
		assert.equal(path.isAbsolute("/home/user/output.md"), true);
	});

	it("path.isAbsolute is the correct cross-platform check", () => {
		// Relative paths — both approaches agree
		assert.equal(path.isAbsolute("output.md"), false);
		assert.equal(path.isAbsolute("subdir/output.md"), false);
		assert.equal("output.md".startsWith("/"), false);

		// The only platform-safe check for absolute paths is path.isAbsolute()
		if (process.platform === "win32") {
			// On Windows, these are absolute:
			assert.equal(path.isAbsolute("C:\\output.md"), true);
			assert.equal(path.isAbsolute("C:/output.md"), true);
			assert.equal(path.isAbsolute("\\\\server\\share"), true); // UNC
			// But startsWith("/") catches none of them
			assert.equal("C:\\output.md".startsWith("/"), false);
			assert.equal("C:/output.md".startsWith("/"), false);
		}
	});
});

describe("path.join vs template string concatenation", () => {
	// settings.ts uses `${chainDir}/${file}` in several places.
	// This works but produces inconsistent separators on Windows.

	it("template concatenation produces forward slashes regardless of platform", () => {
		const chainDir = "C:\\Users\\marc\\temp\\chain-abc";
		const file = "progress.md";

		// Template string: always forward slash (settings.ts:246 pattern)
		const templateResult = `${chainDir}/${file}`;
		assert.equal(templateResult, "C:\\Users\\marc\\temp\\chain-abc/progress.md",
			"template string produces mixed separators");

		// path.join: uses platform separator
		const joinResult = path.join(chainDir, file);
		if (process.platform === "win32") {
			assert.equal(joinResult, "C:\\Users\\marc\\temp\\chain-abc\\progress.md",
				"path.join uses consistent backslashes on Windows");
		}
	});

	it("resolveChainPath pattern should use path.join for relative paths", () => {
		// settings.ts:216: `${chainDir}/${filePath}` for relative paths
		const chainDir = "C:\\temp\\chain-runs\\abc123";
		const relative = "synthesis.md";

		// Current: string concat
		const current = `${chainDir}/${relative}`;
		// Fixed: path.join
		const fixed = path.join(chainDir, relative);

		// On Windows these differ:
		if (process.platform === "win32") {
			assert.notEqual(current, fixed, "concat and path.join produce different results on Windows");
			assert.ok(fixed.includes(path.sep), "path.join uses native separator");
		}
	});

	it("parallel subdir naming should use path.join", () => {
		// settings.ts:302,306 pattern: `${subdir}/${task.output}`
		const subdir = "parallel-0/0-_code-reviewer";
		const output = "review.md";

		const templateResult = `${subdir}/${output}`;
		const joinResult = path.join(subdir, output);

		// Both produce forward slashes here (subdir itself uses /).
		// But if subdir comes from path.join on Windows, it would have backslashes.
		const windowsSubdir = path.join("parallel-0", "0-_code-reviewer");
		const windowsJoin = path.join(windowsSubdir, output);
		// Consistent: all native separators
		assert.equal(windowsJoin, path.join("parallel-0", "0-_code-reviewer", output));
	});
});


type CommandPayload = Record<string, unknown>;

let registerSubagentExtension: ((pi: any) => void) | null = null;
let extensionImportError: string | null = null;

try {
	const extensionModule = await import(new URL("./index.ts", import.meta.url));
	registerSubagentExtension = extensionModule.default;
} catch (error: unknown) {
	const err = error as { code?: string; message?: string };
	if (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "MODULE_NOT_FOUND") {
		extensionImportError = err.message ? `Dependency import unavailable: ${err.message}` : "Dependency import unavailable";
	} else {
		throw error;
	}
}

const TOOL_CALL_PREFIX = "Call the subagent tool with these exact parameters: ";

const parseToolCallPayload = (messages: string[]): CommandPayload => {
	const lastMessage = messages.at(-1);
	assert.ok(typeof lastMessage === "string", "slash command handlers should emit a tool-call message");
	const markerIndex = lastMessage!.indexOf(TOOL_CALL_PREFIX);
	assert.notEqual(markerIndex, -1, `message should contain expected tool-call prefix: ${lastMessage!.slice(0, 120)}...`);
	const rawPayload = lastMessage!.slice(markerIndex + TOOL_CALL_PREFIX.length);
	return JSON.parse(rawPayload) as CommandPayload;
};

const assertRunDirAliases = (payload: CommandPayload): void => {
	assert.equal(payload.dir, undefined);
	assert.equal(payload.chainDir, undefined);
	assert.equal(payload.sessionDir, undefined);
};


describe("slash command parsing for --dir and quoted task text", {
	skip: extensionImportError ? extensionImportError : undefined,
}, () => {
	let commandHandlers: Record<string, { handler: (args: string, ctx: { ui: { notify: (message: string) => void } }) => void | Promise<void> }>;
	let messages: string[];

	beforeEach(() => {
		messages = [];
		const handlers: Record<string, any> = {};
		const pi: any = {
			registerTool: () => {},
			registerCommand: (name: string, def: any) => {
				handlers[name] = def;
			},
			registerShortcut: () => {},
			on: () => {},
			events: {
				on: () => {},
			},
			sendUserMessage: (text: string) => {
				messages.push(text);
			},
		};
		registerSubagentExtension!(pi);
		commandHandlers = handlers;
	});

	const ctx = {
		ui: {
			notify: () => {},
		},
	};

	it("/run parses --dir <path> without disturbing task text", async () => {
		await commandHandlers.run.handler("scout \"collect architecture notes\" --dir .agents/plans/dir-space", ctx);
		const payload = parseToolCallPayload(messages);

		assert.equal(payload.agent, "scout");
		assert.equal(payload.task, "collect architecture notes");
		assert.equal(payload.clarify, false);
		assert.equal(payload.async, undefined);
		assert.equal(payload.agentScope, "both");
		assert.equal(payload.cwd, path.resolve(process.cwd(), ".agents/plans/dir-space"));
		assertRunDirAliases(payload);
	});

	it("/run parses --dir=<path> without disturbing task text", async () => {
		await commandHandlers.run.handler("scout \"collect architecture notes\" --dir=.agents/plans/dir-eq", ctx);
		const payload = parseToolCallPayload(messages);

		assert.equal(payload.agent, "scout");
		assert.equal(payload.task, "collect architecture notes");
		assert.equal(payload.async, undefined);
		assert.equal(payload.cwd, path.resolve(process.cwd(), ".agents/plans/dir-eq"));
		assertRunDirAliases(payload);
	});

	it("/run preserves legacy /bg behavior when --dir is absent", async () => {
		await commandHandlers.run.handler('scout "legacy mode run" --bg', ctx);
		const payload = parseToolCallPayload(messages);

		assert.equal(payload.agent, "scout");
		assert.equal(payload.task, "legacy mode run");
		assert.equal(payload.async, true);
		assert.equal(payload.agentScope, "both");
		assert.equal(payload.cwd, undefined);
		assertRunDirAliases(payload);
	});

	it("/run preserves quoted task text that includes --dir while supporting --bg", async () => {
		await commandHandlers.run.handler('scout "mention --dir inside quote and keep --bg text" --bg', ctx);
		const payload = parseToolCallPayload(messages);

		assert.equal(payload.agent, "scout");
		assert.equal(payload.task, "mention --dir inside quote and keep --bg text");
		assert.equal(payload.async, true);
		assert.equal(payload.cwd, undefined);
		assertRunDirAliases(payload);
	});

	it("/run handles /run with both --bg and --dir while preserving quoted flag-like substrings", async () => {
		await commandHandlers.run.handler('scout "mention --dir and --bg in quoted task" --bg --dir .agents/plans/run-dir-bg', ctx);
		const payload = parseToolCallPayload(messages);

		assert.equal(payload.agent, "scout");
		assert.equal(payload.task, "mention --dir and --bg in quoted task");
		assert.equal(payload.async, true);
		assert.equal(payload.agentScope, "both");
		assert.equal(payload.cwd, path.resolve(process.cwd(), ".agents/plans/run-dir-bg"));
		assert.equal(payload.chainDir, undefined);
		assertRunDirAliases(payload);
	});

	it("/chain preserves quoted per-step task text when --bg is present", async () => {
		await commandHandlers.chain.handler('scout "inspect --dir token in quote" -> planner "summarize with --bg text" --bg', ctx);
		const payload = parseToolCallPayload(messages);

		const chain = payload.chain as Array<{ agent: string; task?: string }>; 
		assert.equal(Array.isArray(chain), true);
		assert.equal(chain.length, 2);
		assert.equal(chain[0]?.agent, "scout");
		assert.equal(chain[0]?.task, "inspect --dir token in quote");
		assert.equal(chain[1]?.agent, "planner");
		assert.equal(chain[1]?.task, "summarize with --bg text");
		assert.equal(payload.async, true);
		assert.equal(payload.task, "inspect --dir token in quote");
		assert.equal(payload.chainDir, undefined);
		assert.equal(payload.cwd, undefined);
		assert.equal(payload.dir, undefined);
		assert.equal(payload.sessionDir, undefined);
	});

	it("/chain parses combined --bg + --dir and preserves quoted flag-like task text", async () => {
		await commandHandlers.chain.handler('scout "inspect --dir token in quote" -> planner "summarize with --bg text" --bg --dir .agents/plans/chain-dir-bg', ctx);
		const payload = parseToolCallPayload(messages);

		const chain = payload.chain as Array<{ agent: string; task?: string }>;
		assert.equal(Array.isArray(chain), true);
		assert.equal(chain.length, 2);
		assert.equal(chain[0]?.agent, "scout");
		assert.equal(chain[0]?.task, "inspect --dir token in quote");
		assert.equal(chain[1]?.agent, "planner");
		assert.equal(chain[1]?.task, "summarize with --bg text");
		assert.equal(payload.async, true);
		assert.equal(payload.task, "inspect --dir token in quote");
		assert.equal(payload.chainDir, path.resolve(process.cwd(), ".agents/plans/chain-dir-bg"));
		assert.equal(payload.cwd, undefined);
		assert.equal(payload.dir, undefined);
		assert.equal(payload.sessionDir, undefined);
	});

	it("/chain injects chainDir when --dir is provided", async () => {
		await commandHandlers.chain.handler('scout "draft structure" -> planner "finalize" --dir .agents/plans/chain-dir', ctx);
		const payload = parseToolCallPayload(messages);

		assert.equal(payload.chainDir, path.resolve(process.cwd(), ".agents/plans/chain-dir"));
		assert.equal(payload.cwd, undefined);
		assert.equal(payload.dir, undefined);
		assert.equal(payload.sessionDir, undefined);
		assert.equal(payload.async, undefined);
	});

	it("/parallel preserves legacy parse when --dir is absent", async () => {
		await commandHandlers.parallel.handler('scout "scan API surface" -> reviewer "spot --bg text"', ctx);
		const payload = parseToolCallPayload(messages);

		assert.equal(Array.isArray(payload.chain), true);
		const parallelStep = payload.chain as Array<{ parallel: Array<{ agent: string; task?: string }> }>;
		assert.equal(Array.isArray(parallelStep[0]?.parallel), true);
		assert.equal(parallelStep[0]?.parallel[0]?.agent, "scout");
		assert.equal(parallelStep[0]?.parallel[0]?.task, "scan API surface");
		assert.equal(parallelStep[0]?.parallel[1]?.agent, "reviewer");
		assert.equal(parallelStep[0]?.parallel[1]?.task, "spot --bg text");
		assert.equal(payload.async, undefined);
		assert.equal(payload.task, "scan API surface");
		assert.equal(payload.cwd, undefined);
		assert.equal(payload.dir, undefined);
		assert.equal(payload.sessionDir, undefined);
		assert.equal(payload.chainDir, undefined);
	});

	it("/parallel parses --dir and keeps quoted task text intact", async () => {
		await commandHandlers.parallel.handler('scout "scan API surface" -> reviewer "spot --dir mentions" --dir .agents/plans/parallel-dir', ctx);
		const payload = parseToolCallPayload(messages);

		assert.equal(Array.isArray(payload.chain), true);
		const parallelStep = payload.chain as Array<{ parallel: Array<{ agent: string; task?: string }> }>;
		assert.equal(Array.isArray(parallelStep[0]?.parallel), true);
		assert.equal(parallelStep[0]?.parallel[0]?.agent, "scout");
		assert.equal(parallelStep[0]?.parallel[0]?.task, "scan API surface");
		assert.equal(parallelStep[0]?.parallel[1]?.agent, "reviewer");
		assert.equal(parallelStep[0]?.parallel[1]?.task, "spot --dir mentions");
		assert.equal(payload.async, undefined);
		assert.equal(payload.task, "scan API surface");
		assert.equal(payload.cwd, undefined);
		assert.equal(payload.dir, undefined);
		assert.equal(payload.sessionDir, undefined);
		assert.equal(payload.chainDir, path.resolve(process.cwd(), ".agents/plans/parallel-dir"));
	});

	it("/parallel parses combined --bg + --dir while preserving quoted flag-like subtasks", async () => {
		await commandHandlers.parallel.handler('scout "scan --dir token in quote" -> reviewer "summarize --bg token" --bg --dir .agents/plans/parallel-dir-bg', ctx);
		const payload = parseToolCallPayload(messages);

		assert.equal(Array.isArray(payload.chain), true);
		const parallelStep = payload.chain as Array<{ parallel: Array<{ agent: string; task?: string }> }>;
		assert.equal(Array.isArray(parallelStep[0]?.parallel), true);
		assert.equal(parallelStep[0]?.parallel[0]?.agent, "scout");
		assert.equal(parallelStep[0]?.parallel[0]?.task, "scan --dir token in quote");
		assert.equal(parallelStep[0]?.parallel[1]?.agent, "reviewer");
		assert.equal(parallelStep[0]?.parallel[1]?.task, "summarize --bg token");
		assert.equal(payload.async, true);
		assert.equal(payload.task, "scan --dir token in quote");
		assert.equal(payload.cwd, undefined);
		assert.equal(payload.dir, undefined);
		assert.equal(payload.sessionDir, undefined);
		assert.equal(payload.chainDir, path.resolve(process.cwd(), ".agents/plans/parallel-dir-bg"));
	});
});
