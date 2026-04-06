import type { AgentConfig } from "./agents.ts";

export interface AgentTemplate {
	name: string;
	config: Partial<AgentConfig>;
}

export type TemplateItem =
	| { type: "agent"; name: string; config: Partial<AgentConfig> }
	| { type: "chain"; name: string; description: string }
	| { type: "separator"; label: string };

export const TEMPLATE_ITEMS: TemplateItem[] = [
	{ type: "separator", label: "Agents" },
	{
		type: "agent",
		name: "Blank",
		config: { description: "Describe this agent", systemPrompt: "" },
	},
	{
		type: "agent",
		name: "Scout",
		config: {
			description: "Analyzes codebases and reports findings",
			systemPrompt: "You are a code analysis agent. Given a codebase and a question, thoroughly investigate the relevant files and report your findings. Focus on accuracy — read the actual code rather than guessing.",
			tools: ["read", "bash"],
			output: "analysis.md",
		},
	},
	{
		type: "agent",
		name: "Code Reviewer",
		config: {
			description: "Reviews code for bugs, style, and correctness",
			systemPrompt: "You are a code review agent. Examine the code changes or files provided and identify bugs, style issues, performance concerns, and correctness problems. Be specific — cite line numbers and explain why each issue matters.",
			tools: ["read", "bash"],
		},
	},
	{
		type: "agent",
		name: "Planner",
		config: {
			description: "Creates implementation plans from requirements",
			systemPrompt: "You are a planning agent. Given a task or requirements, create a detailed implementation plan. Break the work into concrete steps, identify which files need changes, and note any risks or dependencies.",
			tools: ["read", "bash"],
			output: "plan.md",
		},
	},
	{
		type: "agent",
		name: "Implementer",
		config: {
			description: "Implements code changes from a plan",
			systemPrompt: "You are an implementation agent. Given a plan or task, make the necessary code changes. Write clean, tested code that follows existing patterns. Run tests after making changes.",
			defaultProgress: true,
		},
	},
	{ type: "separator", label: "Chains" },
	{ type: "chain", name: "Blank Chain", description: "Empty chain to configure" },
];
