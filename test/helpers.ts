/**
 * Test helpers for integration tests.
 *
 * Provides:
 * - Mock pi CLI via createMockPi() from @marcfargas/pi-test-harness
 * - Dynamic module loading with graceful skip
 * - Temp directory management
 * - Minimal mock contexts for chain execution
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createMockPi as _createMockPi } from "@marcfargas/pi-test-harness";
import type { MockPi } from "@marcfargas/pi-test-harness";

export type { MockPi };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Mock Pi setup — wraps createMockPi() from @marcfargas/pi-test-harness
// ---------------------------------------------------------------------------

/**
 * Resolve the mock-pi-script.mjs path from the harness package.
 *
 * On Windows, pi-spawn.ts's resolveWindowsPiCliScript() checks process.argv[1]
 * for a runnable Node script and uses that path directly (bypassing PATH).
 * We redirect it here so pi-spawn picks up the harness mock instead of the
 * real pi CLI.
 *
 * Uses import.meta.resolve (available in Node 20+) to find the harness main
 * entry, then navigates to mock-pi-script.mjs. The harness is ESM-only so
 * createRequire cannot resolve it.
 */
function findHarnessMockPiScript(): string {
	// import.meta.resolve returns a file:// URL to the harness main entry
	// e.g. file:///C:/.../node_modules/@marcfargas/pi-test-harness/dist/index.js
	const mainUrl = import.meta.resolve("@marcfargas/pi-test-harness");
	const mainEntry = fileURLToPath(mainUrl);
	const distDir = path.dirname(mainEntry);
	const harnessDir = path.dirname(distDir);
	const candidates = [
		path.join(distDir, "mock-pi-script.mjs"),
		path.join(harnessDir, "src", "mock-pi-script.mjs"),
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	throw new Error(`mock-pi-script.mjs not found in harness. Searched:\n  ${candidates.join("\n  ")}`);
}

/**
 * Create a mock pi CLI instance for integration tests.
 *
 * Wraps createMockPi() from @marcfargas/pi-test-harness with Windows-specific
 * argv[1] and MOCK_PI_QUEUE_DIR patching.
 *
 * On Windows, pi-spawn.ts resolves pi via process.argv[1] (not PATH), so we
 * redirect it to the harness mock script and set MOCK_PI_QUEUE_DIR so the
 * script can find the queued responses.
 *
 * Usage:
 * ```typescript
 * let mockPi: MockPi;
 * before(() => { mockPi = createMockPi(); mockPi.install(); });
 * after(() => mockPi.uninstall());
 * beforeEach(() => { tempDir = createTempDir(); mockPi.reset(); });
 * afterEach(() => removeTempDir(tempDir));
 *
 * it("test", async () => {
 *   mockPi.onCall({ output: "Hello" });
 *   // ...spawn pi...
 * });
 * ```
 */
export function createMockPi(): MockPi {
	const inner = _createMockPi();
	let originalArgv1: string | undefined;

	return {
		get dir() {
			return inner.dir;
		},
		install() {
			inner.install();
			// Windows: resolveWindowsPiCliScript() checks process.argv[1] for a
			// runnable Node script. Point it to the harness mock script so pi-spawn
			// bypasses the real pi CLI. Also set MOCK_PI_QUEUE_DIR so the script
			// finds its queue (inherited via spawnEnv = { ...process.env }).
			if (process.platform === "win32") {
				originalArgv1 = process.argv[1];
				process.argv[1] = findHarnessMockPiScript();
				process.env.MOCK_PI_QUEUE_DIR = inner.dir;
			}
		},
		uninstall() {
			if (process.platform === "win32") {
				if (originalArgv1 !== undefined) {
					process.argv[1] = originalArgv1;
					originalArgv1 = undefined;
				}
				delete process.env.MOCK_PI_QUEUE_DIR;
			}
			inner.uninstall();
		},
		onCall(response) {
			return inner.onCall(response);
		},
		reset() {
			return inner.reset();
		},
		callCount() {
			return inner.callCount();
		},
	};
}

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory for test use.
 */
export function createTempDir(prefix = "pi-subagent-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Remove a directory tree, ignoring errors.
 */
export function removeTempDir(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {}
}

// ---------------------------------------------------------------------------
// Agent config factory
// ---------------------------------------------------------------------------

interface AgentConfig {
	name: string;
	description?: string;
	systemPrompt?: string;
	model?: string;
	tools?: string[];
	extensions?: string[];
	skills?: string[];
	thinking?: string;
	scope?: string;
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
	mcpDirectTools?: string[];
}

/**
 * Create minimal agent configs for testing.
 * Each name becomes an agent with no special config.
 */
export function makeAgentConfigs(names: string[]): AgentConfig[] {
	return names.map((name) => ({
		name,
		description: `Test agent: ${name}`,
	}));
}

/**
 * Create an agent config with specific settings.
 */
export function makeAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `Test agent: ${name}`,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Minimal mock context for chain execution
// ---------------------------------------------------------------------------

/**
 * Create a minimal ExtensionContext mock for chain execution.
 * Only provides what executeChain needs when clarify=false.
 */
export function makeMinimalCtx(cwd: string): any {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionManager: {
			getSessionFile: () => null,
		},
		modelRegistry: {
			getAvailable: () => [],
		},
	};
}

// ---------------------------------------------------------------------------
// Dynamic module loading with graceful skip
// ---------------------------------------------------------------------------

/**
 * Try to dynamically import a module.
 * - Bare specifiers (e.g., "@marcfargas/pi-test-harness") are imported as-is.
 * - Relative paths (e.g., "./utils.ts") are resolved from the project root.
 *
 * Only swallows MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND when the missing module
 * is exactly the requested bare specifier (expected optional dependency).
 * All other errors are rethrown to avoid hiding real breakage.
 */
export async function tryImport<T>(specifier: string): Promise<T | null> {
	const isBare = !(specifier.startsWith(".") || specifier.startsWith("/"));
	try {
		if (!isBare) {
			// Resolve relative to project root (parent of test/)
			const projectRoot = path.resolve(__dirname, "..");
			const abs = path.resolve(projectRoot, specifier);
			// Convert to file:// URL for Windows compatibility with dynamic import()
			const url = `file:///${abs.replace(/\\/g, "/")}`;
			return await import(url) as T;
		}
		// Bare specifier — import directly (node_modules resolution)
		return await import(specifier) as T;
	} catch (error: any) {
		const code = error?.code;
		const isModuleNotFound = code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
		if (isBare && isModuleNotFound) {
			const msg = String(error?.message ?? "");
			const missing = msg.match(/Cannot find (?:package|module) ['\"]([^'\"]+)['\"]/i)?.[1];
			if (missing === specifier || msg.includes(`'${specifier}'`) || msg.includes(`\"${specifier}\"`)) {
				return null;
			}
		}
		throw error;
	}
}

/**
 * JSONL event builders for mock pi configuration.
 */
export const events = {
	/** Build a message_end event with assistant text */
	assistantMessage(text: string, model = "mock/test-model"): object {
		return {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				model,
				usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
			},
		};
	},

	/** Build a tool_execution_start event */
	toolStart(toolName: string, args: Record<string, unknown> = {}): object {
		return { type: "tool_execution_start", toolName, args };
	},

	/** Build a tool_execution_end event */
	toolEnd(toolName: string): object {
		return { type: "tool_execution_end", toolName };
	},

	/** Build a tool_result_end event */
	toolResult(toolName: string, text: string, isError = false): object {
		return {
			type: "tool_result_end",
			message: {
				role: "toolResult",
				toolName,
				isError,
				content: [{ type: "text", text }],
			},
		};
	},
};
