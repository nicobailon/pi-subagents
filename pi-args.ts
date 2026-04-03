import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const TASK_ARG_LIMIT = 8000;
const MULTI_PASS_BASE_PROVIDERS = new Set([
	"anthropic",
	"openai-codex",
	"github-copilot",
	"google-gemini-cli",
	"google-antigravity",
]);

export interface BuildPiArgsInput {
	baseArgs: string[];
	task: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	extensions?: string[];
	skills?: string[];
	systemPrompt?: string | null;
	mcpDirectTools?: string[];
	promptFileStem?: string;
}

export interface BuildPiArgsResult {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir?: string;
}

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model;
	return `${model}:${thinking}`;
}

function getRequiredProviderExtensions(modelArg: string | undefined): string[] {
	if (!modelArg) return [];
	const slashIdx = modelArg.indexOf("/");
	if (slashIdx === -1) return [];
	const provider = modelArg.substring(0, slashIdx);
	const match = provider.match(/^(.*)-(\d+)$/);
	if (!match) return [];
	const baseProvider = match[1];
	if (!baseProvider || !MULTI_PASS_BASE_PROVIDERS.has(baseProvider)) return [];
	return ["npm:pi-multi-pass"];
}

export function buildPiArgs(input: BuildPiArgsInput): BuildPiArgsResult {
	const args = [...input.baseArgs];

	if (input.sessionFile) {
		args.push("--session", input.sessionFile);
	} else {
		if (!input.sessionEnabled) {
			args.push("--no-session");
		}
		if (input.sessionDir) {
			fs.mkdirSync(input.sessionDir, { recursive: true });
			args.push("--session-dir", input.sessionDir);
		}
	}

	const modelArg = applyThinkingSuffix(input.model, input.thinking);
	if (modelArg) {
		if (modelArg.includes("/")) {
			// Full provider/model IDs are accepted directly by pi's --model flag.
			args.push("--model", modelArg);
		} else {
			// Last-resort fallback when no provider is available.
			// In normal subagent execution we prefer resolving to provider/model first.
			args.push("--models", modelArg);
		}
	}

	const requiredProviderExtensions = getRequiredProviderExtensions(modelArg);
	const toolExtensionPaths: string[] = [];
	if (input.tools?.length) {
		const builtinTools: string[] = [];
		for (const tool of input.tools) {
			if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
				toolExtensionPaths.push(tool);
			} else {
				builtinTools.push(tool);
			}
		}
		if (builtinTools.length > 0) {
			args.push("--tools", builtinTools.join(","));
		}
	}

	if (input.extensions !== undefined) {
		args.push("--no-extensions");
		const extensionSpecs = [...input.extensions];
		for (const extPath of requiredProviderExtensions) {
			if (!extensionSpecs.includes(extPath)) extensionSpecs.push(extPath);
		}
		for (const extPath of extensionSpecs) {
			args.push("--extension", extPath);
		}
	} else {
		for (const extPath of toolExtensionPaths) {
			args.push("--extension", extPath);
		}
	}

	if ((input.skills?.length ?? 0) > 0) {
		args.push("--no-skills");
	}

	let tempDir: string | undefined;
	if (input.systemPrompt) {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		const stem = (input.promptFileStem ?? "prompt").replace(/[^\w.-]/g, "_");
		const promptPath = path.join(tempDir, `${stem}.md`);
		fs.writeFileSync(promptPath, input.systemPrompt, { mode: 0o600 });
		args.push("--append-system-prompt", promptPath);
	}

	if (input.task.length > TASK_ARG_LIMIT) {
		if (!tempDir) {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		}
		const taskFilePath = path.join(tempDir, "task.md");
		fs.writeFileSync(taskFilePath, `Task: ${input.task}`, { mode: 0o600 });
		args.push(`@${taskFilePath}`);
	} else {
		args.push(`Task: ${input.task}`);
	}

	const env: Record<string, string | undefined> = {};
	if (input.mcpDirectTools?.length) {
		env.MCP_DIRECT_TOOLS = input.mcpDirectTools.join(",");
	} else {
		env.MCP_DIRECT_TOOLS = "__none__";
	}

	return { args, env, tempDir };
}

export function cleanupTempDir(tempDir: string | null | undefined): void {
	if (!tempDir) return;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Temp cleanup is best effort.
	}
}
