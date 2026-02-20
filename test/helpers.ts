/**
 * Test helpers for integration tests.
 *
 * Provides:
 * - Mock pi CLI redirection (cross-platform)
 * - Dynamic module loading with graceful skip
 * - Temp directory management
 * - Minimal mock contexts for chain execution
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PI_PATH = path.resolve(__dirname, "fixtures", "mock-pi.mjs");

// ---------------------------------------------------------------------------
// Mock Pi setup — redirects pi-spawn to use our mock script
// ---------------------------------------------------------------------------

let originalArgv1: string | undefined;
let tempBinDir: string | undefined;
let originalPath: string | undefined;

/**
 * Redirect the pi CLI resolution to use mock-pi.mjs.
 *
 * - Windows: overrides process.argv[1] so resolveWindowsPiCliScript() finds mock
 * - All platforms: creates a `pi` shim in a temp dir and prepends to PATH
 *   (fallback for Linux where getPiSpawnCommand returns { command: "pi", args })
 */
export function setupMockPi(): void {
	// Windows: override argv[1] — resolveWindowsPiCliScript checks this
	if (process.platform === "win32") {
		originalArgv1 = process.argv[1];
		process.argv[1] = MOCK_PI_PATH;
	}

	// All platforms: create a `pi` shim in PATH as fallback
	tempBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-pi-bin-"));
	originalPath = process.env.PATH;

	if (process.platform === "win32") {
		const cmd = `@echo off\r\n"${process.execPath}" "${MOCK_PI_PATH}" %*\r\n`;
		fs.writeFileSync(path.join(tempBinDir, "pi.cmd"), cmd);
	} else {
		const sh = `#!/bin/sh\nexec "${process.execPath}" "${MOCK_PI_PATH}" "$@"\n`;
		const piPath = path.join(tempBinDir, "pi");
		fs.writeFileSync(piPath, sh);
		fs.chmodSync(piPath, 0o755);
	}

	process.env.PATH = `${tempBinDir}${path.delimiter}${originalPath}`;
}

/**
 * Restore original pi CLI resolution.
 */
export function teardownMockPi(): void {
	if (originalArgv1 !== undefined) {
		process.argv[1] = originalArgv1;
		originalArgv1 = undefined;
	}
	if (originalPath !== undefined) {
		process.env.PATH = originalPath;
		originalPath = undefined;
	}
	if (tempBinDir) {
		try {
			fs.rmSync(tempBinDir, { recursive: true, force: true });
		} catch {}
		tempBinDir = undefined;
	}
}

// ---------------------------------------------------------------------------
// Environment variable helpers for mock-pi configuration
// ---------------------------------------------------------------------------

const MOCK_ENV_KEYS = [
	"MOCK_PI_OUTPUT",
	"MOCK_PI_EXIT_CODE",
	"MOCK_PI_STDERR",
	"MOCK_PI_DELAY_MS",
	"MOCK_PI_JSONL",
	"MOCK_PI_WRITE_FILE",
	"MOCK_PI_WRITE_FILES",
] as const;

/**
 * Clear all MOCK_PI_* environment variables.
 */
export function resetMockEnv(): void {
	for (const key of MOCK_ENV_KEYS) {
		delete process.env[key];
	}
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
 * Try to dynamically import a module from the project root.
 * Path is relative to the project root (e.g., "./utils.ts").
 * Returns null if import fails (e.g., because pi packages aren't installed).
 */
export async function tryImport<T>(relativePath: string): Promise<T | null> {
	try {
		// Resolve relative to project root (parent of test/)
		const projectRoot = path.resolve(__dirname, "..");
		const abs = path.resolve(projectRoot, relativePath);
		// Convert to file:// URL for Windows compatibility with dynamic import()
		const url = `file:///${abs.replace(/\\/g, "/")}`;
		return await import(url) as T;
	} catch {
		return null;
	}
}

/**
 * JSONL event builders for mock-pi configuration.
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
