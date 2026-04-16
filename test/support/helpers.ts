import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMockPi as _createMockPi } from "./mock-pi.ts";
import type { MockPi } from "./mock-pi.ts";

export type { MockPi };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createMockPi(): MockPi {
	return _createMockPi();
}

export function createTempDir(prefix = "pi-subagent-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempDir(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {}
}

interface AgentConfig {
	name: string;
	description?: string;
	systemPrompt?: string;
	model?: string;
	fallbackModels?: string[];
	tools?: string[];
	extensions?: string[];
	skills?: string[];
	thinking?: string;
	systemPromptMode?: string;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	scope?: string;
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
	mcpDirectTools?: string[];
	maxSubagentDepth?: number;
}

export function makeAgentConfigs(names: string[]): AgentConfig[] {
	return names.map((name) => ({
		name,
		description: `Test agent: ${name}`,
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
	}));
}

export function makeAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `Test agent: ${name}`,
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}

export interface MinimalCtx {
	cwd: string;
	hasUI: boolean;
	ui: Record<string, never>;
	sessionManager: {
		getSessionId: () => string;
		getSessionFile: () => string | null;
	};
	modelRegistry: {
		getAvailable: () => Array<{ provider: string; id: string }>;
	};
	model?: { provider: string };
}

export function makeMinimalCtx(cwd: string): MinimalCtx {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionManager: {
			getSessionId: () => "session-123",
			getSessionFile: () => null,
		},
		modelRegistry: {
			getAvailable: () => [],
		},
	};
}

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
			const projectRoot = path.resolve(__dirname, "..", "..");
			const abs = path.resolve(projectRoot, specifier);
			const url = pathToFileURL(abs).href;
			return await import(url) as T;
		}
		return await import(specifier) as T;
	} catch (error: unknown) {
		const code = typeof error === "object" && error !== null && "code" in error
			? (error as { code?: unknown }).code
			: undefined;
		const isModuleNotFound = code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
		if (isBare && isModuleNotFound) {
			const msg = typeof error === "object" && error !== null && "message" in error
				? String((error as { message?: unknown }).message ?? "")
				: "";
			const missing = msg.match(/Cannot find (?:package|module) ['\"]([^'\"]+)['\"]/i)?.[1];
			if (missing === specifier || msg.includes(`'${specifier}'`) || msg.includes(`\"${specifier}\"`)) {
				return null;
			}
		}
		throw error;
	}
}

export const events = {
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

	toolStart(toolName: string, args: Record<string, unknown> = {}): object {
		return { type: "tool_execution_start", toolName, args };
	},

	toolEnd(toolName: string): object {
		return { type: "tool_execution_end", toolName };
	},

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
