import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	buildBuiltinOverrideConfig,
	discoverAgentsAll,
	frontmatterNameForConfig,
	removeBuiltinAgentOverride,
	saveBuiltinAgentOverride,
	type AgentConfig,
	type BuiltinAgentOverrideBase,
} from "../agents/agents.ts";
import { serializeAgent } from "../agents/agent-serializer.ts";

const ADMIN_MESSAGE_TYPE = "subagents-admin";
const INHERIT_MODEL_CHOICE = "Default / inherit session model";

type ModelInfo = { provider: string; id: string };

function sourceRank(source: AgentConfig["source"]): number {
	if (source === "project") return 0;
	if (source === "user") return 1;
	return 2;
}

function allVisibleAgents(cwd: string): AgentConfig[] {
	const d = discoverAgentsAll(cwd);
	return [...d.project, ...d.user, ...d.builtin]
		.filter((agent) => !agent.disabled)
		.sort((a, b) => a.name.localeCompare(b.name) || sourceRank(a.source) - sourceRank(b.source));
}

function agentLabel(agent: AgentConfig): string {
	const model = agent.model ? ` · ${agent.model}` : "";
	return `${agent.name} [${agent.source}]${model} — ${agent.description}`;
}

function agentMatches(agent: AgentConfig, rawName: string): boolean {
	const name = rawName.trim();
	return agent.name === name || frontmatterNameForConfig(agent) === name;
}

function sendAdminMessage(pi: ExtensionAPI, content: string): void {
	pi.sendMessage({
		customType: ADMIN_MESSAGE_TYPE,
		content,
		display: true,
	});
}

function modelFullId(model: ModelInfo): string {
	return `${model.provider}/${model.id}`;
}

function buildBuiltinBase(agent: AgentConfig): BuiltinAgentOverrideBase {
	return {
		model: agent.model,
		fallbackModels: agent.fallbackModels ? [...agent.fallbackModels] : undefined,
		thinking: agent.thinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		defaultContext: agent.defaultContext,
		disabled: agent.disabled,
		systemPrompt: agent.systemPrompt,
		skills: agent.skills ? [...agent.skills] : undefined,
		tools: agent.tools ? [...agent.tools] : undefined,
		mcpDirectTools: agent.mcpDirectTools ? [...agent.mcpDirectTools] : undefined,
	};
}

async function selectAgent(ctx: ExtensionContext, args: string): Promise<AgentConfig | undefined> {
	const agents = allVisibleAgents(ctx.cwd);
	if (agents.length === 0) return undefined;

	const requestedName = args.trim().split(/\s+/)[0] ?? "";
	if (requestedName) {
		const matches = agents.filter((agent) => agentMatches(agent, requestedName));
		if (matches.length === 1 || !ctx.hasUI) return matches[0];
		if (matches.length > 1) {
			const byLabel = new Map(matches.map((agent) => [agentLabel(agent), agent] as const));
			const choice = await ctx.ui.select(`Multiple subagents named '${requestedName}'`, [...byLabel.keys()]);
			return choice ? byLabel.get(choice) : undefined;
		}
		return undefined;
	}

	if (!ctx.hasUI) return undefined;
	const byLabel = new Map(agents.map((agent) => [agentLabel(agent), agent] as const));
	const choice = await ctx.ui.select("Select subagent", [...byLabel.keys()]);
	return choice ? byLabel.get(choice) : undefined;
}

function metadataFor(agent: AgentConfig): string {
	const tools = [...(agent.tools ?? []), ...(agent.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`)];
	const lines = [
		`Agent: ${agent.name} (${agent.source})`,
		`Path: ${agent.filePath}`,
		`Description: ${agent.description}`,
	];
	if (agent.packageName) {
		lines.push(`Local name: ${frontmatterNameForConfig(agent)}`);
		lines.push(`Package: ${agent.packageName}`);
	}
	lines.push(`Model: ${agent.model ?? "default / inherit"}`);
	if (agent.fallbackModels?.length) lines.push(`Fallback models: ${agent.fallbackModels.join(", ")}`);
	if (agent.thinking) lines.push(`Thinking: ${agent.thinking}`);
	if (tools.length) lines.push(`Tools: ${tools.join(", ")}`);
	if (agent.skills?.length) lines.push(`Skills: ${agent.skills.join(", ")}`);
	lines.push(`System prompt mode: ${agent.systemPromptMode}`);
	lines.push(`Inherit project context: ${agent.inheritProjectContext ? "true" : "false"}`);
	lines.push(`Inherit skills: ${agent.inheritSkills ? "true" : "false"}`);
	if (agent.defaultContext) lines.push(`Default context: ${agent.defaultContext}`);
	if (agent.output) lines.push(`Output: ${agent.output}`);
	if (agent.defaultReads?.length) lines.push(`Reads: ${agent.defaultReads.join(", ")}`);
	if (agent.defaultProgress) lines.push("Progress: true");
	if (agent.maxSubagentDepth !== undefined) lines.push(`Max subagent depth: ${agent.maxSubagentDepth}`);
	if (agent.source === "builtin") lines.push(`Disabled: ${agent.disabled ? "true" : "false"}`);
	if (agent.override) lines.push(`Override: ${agent.override.scope} (${agent.override.path})`);
	if (agent.systemPrompt.trim()) lines.push("", "System Prompt:", agent.systemPrompt);
	return lines.join("\n");
}

async function chooseModel(ctx: ExtensionContext, agent: AgentConfig): Promise<string | undefined | null> {
	const models = ctx.modelRegistry.getAvailable().map((model) => modelFullId(model));
	const current = agent.model ?? INHERIT_MODEL_CHOICE;
	const choices = [INHERIT_MODEL_CHOICE, ...models.filter((model) => model !== agent.model)];
	if (agent.model && !choices.includes(agent.model)) choices.splice(1, 0, agent.model);
	const choice = await ctx.ui.select(`Select model for ${agent.name}\nCurrent: ${current}`, choices);
	if (!choice) return null;
	return choice === INHERIT_MODEL_CHOICE ? undefined : choice;
}

async function chooseBuiltinOverrideScope(ctx: ExtensionContext, agent: AgentConfig): Promise<"user" | "project" | undefined> {
	if (agent.override?.scope) return agent.override.scope;
	const d = discoverAgentsAll(ctx.cwd);
	if (!d.projectSettingsPath || !ctx.hasUI) return "user";
	const choice = await ctx.ui.select(`Save builtin override for ${agent.name}`, ["user", "project"]);
	return choice === "user" || choice === "project" ? choice : undefined;
}

async function saveAgentModel(ctx: ExtensionContext, agent: AgentConfig, selectedModel: string | undefined): Promise<string> {
	if (agent.source === "builtin") {
		const scope = await chooseBuiltinOverrideScope(ctx, agent);
		if (!scope) return "Cancelled.";
		const base = agent.override?.base ?? buildBuiltinBase(agent);
		const draft: AgentConfig = { ...agent, model: selectedModel };
		const override = buildBuiltinOverrideConfig(base, draft);
		const filePath = override
			? saveBuiltinAgentOverride(ctx.cwd, agent.name, scope, override)
			: removeBuiltinAgentOverride(ctx.cwd, agent.name, scope);
		return selectedModel
			? `Saved ${scope} override for builtin '${agent.name}' with model '${selectedModel}' in ${filePath}.`
			: `Cleared model override for builtin '${agent.name}' in ${filePath}.`;
	}

	const updated: AgentConfig = { ...agent, model: selectedModel };
	fs.writeFileSync(updated.filePath, serializeAgent(updated), "utf-8");
	return selectedModel
		? `Updated '${agent.name}' model to '${selectedModel}' in ${updated.filePath}.`
		: `Cleared '${agent.name}' model in ${updated.filePath}.`;
}

export async function openSubagentsAdmin(pi: ExtensionAPI, ctx: ExtensionContext, args = ""): Promise<void> {
	const agent = await selectAgent(ctx, args);
	if (!agent) {
		const agents = allVisibleAgents(ctx.cwd);
		const requestedName = args.trim().split(/\s+/)[0];
		const text = requestedName
			? `Subagent '${requestedName}' not found.\n\nAvailable subagents:\n${agents.map((a) => `- ${a.name} (${a.source})`).join("\n") || "- (none)"}`
			: `Available subagents:\n${agents.map((a) => `- ${a.name} (${a.source})`).join("\n") || "- (none)"}`;
		sendAdminMessage(pi, text);
		return;
	}

	sendAdminMessage(pi, metadataFor(agent));
	if (!ctx.hasUI) return;

	const requestedAction = args.trim().split(/\s+/)[1];
	let action = requestedAction === "model" ? "Change model" : undefined;
	if (!action) {
		action = await ctx.ui.select(`Administer ${agent.name}`, ["Change model", "Done"]);
	}
	if (action !== "Change model") return;

	const selectedModel = await chooseModel(ctx, agent);
	if (selectedModel === null) return;
	try {
		const message = await saveAgentModel(ctx, agent, selectedModel);
		ctx.ui.notify(message, "info");
		sendAdminMessage(pi, message);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(message, "error");
		sendAdminMessage(pi, `Failed to update '${agent.name}': ${message}`);
	}
}
