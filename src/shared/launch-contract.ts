import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { AgentConfig } from "../agents/agents.ts";
import type { ExtensionBindings } from "../runs/shared/extension-bindings.ts";

export const AGENT_DEFINITION_PROJECTION_VERSION = 1 as const;
export const LAUNCH_BINDING_PROJECTION_VERSION = 1 as const;

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function stableJsonDigest(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function fileDigest(filePath: string): string | undefined {
	try {
		return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
	} catch {
		return undefined;
	}
}

/** Public-safe, deterministic evidence for the parsed launch-affecting agent definition. */
export function projectAgentDefinition(agent: AgentConfig): Record<string, unknown> {
	return {
		version: AGENT_DEFINITION_PROJECTION_VERSION,
		name: agent.name,
		localName: agent.localName,
		packageName: agent.packageName,
		filePath: agent.filePath,
		fileContentDigest: fileDigest(agent.filePath),
		runner: agent.runner,
		systemPrompt: agent.systemPrompt,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		model: agent.model,
		modelProvider: agent.modelProvider,
		fallbackModels: agent.fallbackModels,
		fast: agent.fast,
		thinking: agent.thinking,
		tools: agent.tools,
		mcpDirectTools: agent.mcpDirectTools,
		extensions: agent.extensions,
		subagentOnlyExtensions: agent.subagentOnlyExtensions,
		skills: agent.skills,
		skillPath: agent.skillPath,
		output: agent.output,
		defaultReads: agent.defaultReads,
		defaultProgress: agent.defaultProgress,
		defaultContext: agent.defaultContext,
		defaultAsync: agent.defaultAsync,
		defaultTimeoutMs: agent.defaultTimeoutMs,
		defaultTurnBudget: agent.defaultTurnBudget,
		defaultAcceptance: agent.defaultAcceptance,
		acceptanceRole: agent.acceptanceRole,
		interactive: agent.interactive,
		maxSubagentDepth: agent.maxSubagentDepth,
		completionGuard: agent.completionGuard,
		toolBudget: agent.toolBudget,
		memory: agent.memory,
	};
}

export function agentDefinitionDigest(agent: AgentConfig): string {
	return stableJsonDigest(projectAgentDefinition(agent));
}

export interface LaunchBindingInput {
	definitionDigest: string;
	/** Caller task; runtime acceptance/output task annotations are explicitly outside the preflight-known subset. */
	task?: string;
	model?: string;
	modelCandidates?: string[];
	fast?: boolean;
	thinking?: string;
	systemPrompt?: string | null;
	systemPromptMode?: AgentConfig["systemPromptMode"];
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	skills?: string[];
	tools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	mcpDirectTools?: string[];
	outputPath?: string;
	outputMode?: string;
	structuredOutputSchema?: unknown;
	extensionBindings?: ExtensionBindings;
}

/** Canonical projection of the resolved inputs handed to the child. */
export function projectLaunchBinding(input: LaunchBindingInput): Record<string, unknown> {
	return {
		version: LAUNCH_BINDING_PROJECTION_VERSION,
		definitionDigest: input.definitionDigest,
		taskDigest: input.task === undefined ? undefined : stableJsonDigest(input.task),
		// The ordered candidate set already contains each attempted model; keeping only
		// this set makes retries correlate to the same preflight binding.
		modelCandidates: input.modelCandidates,
		fast: input.fast,
		thinking: input.thinking,
		systemPromptDigest: input.systemPrompt === undefined || input.systemPrompt === null ? undefined : stableJsonDigest(input.systemPrompt),
		systemPromptMode: input.systemPromptMode,
		inheritProjectContext: input.inheritProjectContext,
		inheritSkills: input.inheritSkills,
		skills: input.skills,
		tools: input.tools,
		extensions: input.extensions,
		subagentOnlyExtensions: input.subagentOnlyExtensions,
		mcpDirectTools: input.mcpDirectTools,
		outputPath: input.outputPath,
		outputMode: input.outputMode,
		structuredOutputSchema: input.structuredOutputSchema,
		extensionBindings: input.extensionBindings,
	};
}

export function launchBindingDigest(input: LaunchBindingInput): string {
	return stableJsonDigest(projectLaunchBinding(input));
}
