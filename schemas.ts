/**
 * TypeBox schemas for subagent tool parameters
 */

import { Type } from "@sinclair/typebox";

// Note: Using Type.Any() for Google API compatibility (doesn't support anyOf)
const SkillOverride = Type.Any({ description: "Skill name(s) to inject (comma-separated), array of strings, or boolean (false disables, true uses default)" });

export const TaskItem = Type.Object({ 
	agent: Type.String(), 
	task: Type.String(), 
	cwd: Type.Optional(Type.String()),
	skill: Type.Optional(SkillOverride),
});

// Sequential chain step (single agent)
export const SequentialStepSchema = Type.Object({
	agent: Type.String(),
	task: Type.Optional(Type.String({ 
		description: "Task template with variables: {task}=original request, {previous}=prior step's text response, {chain_dir}=shared folder. Required for first step, defaults to '{previous}' for subsequent steps." 
	})),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(Type.Any({ description: "Output filename to write in {chain_dir} (string), or false to disable file output" })),
	reads: Type.Optional(Type.Any({ description: "Files to read from {chain_dir} before running (array of filenames), or false to disable" })),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for this step" })),
});

// Parallel task item (within a parallel step)
export const ParallelTaskSchema = Type.Object({
	agent: Type.String(),
	task: Type.Optional(Type.String({ description: "Task template with {task}, {previous}, {chain_dir} variables. Defaults to {previous}." })),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(Type.Any({ description: "Output filename to write in {chain_dir} (string), or false to disable file output" })),
	reads: Type.Optional(Type.Any({ description: "Files to read from {chain_dir} before running (array of filenames), or false to disable" })),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for this task" })),
});

// Parallel chain step (multiple agents running concurrently)
export const ParallelStepSchema = Type.Object({
	parallel: Type.Array(ParallelTaskSchema, { minItems: 1, description: "Tasks to run in parallel" }),
	concurrency: Type.Optional(Type.Number({ description: "Max concurrent tasks (default: 4)" })),
	failFast: Type.Optional(Type.Boolean({ description: "Stop on first failure (default: false)" })),
});

// Chain item can be either sequential or parallel
// Note: Using Type.Any() for Google API compatibility (doesn't support anyOf)
export const ChainItem = Type.Any({ description: "Chain step: either {agent, task?, ...} for sequential or {parallel: [...]} for concurrent execution" });

export const MaxOutputSchema = Type.Optional(
	Type.Object({
		bytes: Type.Optional(Type.Number({ description: "Max bytes (default: 204800)" })),
		lines: Type.Optional(Type.Number({ description: "Max lines (default: 5000)" })),
	}),
);

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (SINGLE mode) or target for management get/update/delete" })),
	task: Type.Optional(Type.String({ description: "Task (SINGLE mode)" })),
	// Management action (when present, tool operates in management mode)
	action: Type.Optional(Type.String({
		description: "Management action: 'list' (discover agents/chains), 'get' (full detail), 'create', 'update', 'delete'. Omit for execution mode."
	})),
	// Chain identifier for management (can't reuse 'chain' — that's the execution array)
	chainName: Type.Optional(Type.String({
		description: "Chain name for get/update/delete management actions"
	})),
	// Agent/chain configuration for create/update (nested to avoid conflicts with execution fields)
	config: Type.Optional(Type.Any({
		description: "Agent or chain config for create/update. Agent: name, description, scope ('user'|'project', default 'user'), systemPrompt, model, tools (comma-separated), skills (comma-separated), thinking, output, reads, progress. Chain: name, description, scope, steps (array of {agent, task?, output?, reads?, model?, skills?, progress?}). Presence of 'steps' creates a chain instead of an agent."
	})),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "PARALLEL mode: [{agent, task}, ...]" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "CHAIN mode: sequential pipeline where each step's response becomes {previous} for the next. Use {task}, {previous}, {chain_dir} in task templates." })),
	chainDir: Type.Optional(Type.String({ description: "Persistent directory for chain artifacts. Default: <tmpdir>/pi-chain-runs/ (auto-cleaned after 24h)" })),
	async: Type.Optional(Type.Boolean({ description: "Run in background (default: false, or per config)" })),
	agentScope: Type.Optional(Type.String({ description: "Agent discovery scope: 'user', 'project', or 'both' (default: 'user')" })),
	cwd: Type.Optional(Type.String()),
	maxOutput: MaxOutputSchema,
	artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts (default: true)" })),
	includeProgress: Type.Optional(Type.Boolean({ description: "Include full progress in result (default: false)" })),
	share: Type.Optional(Type.Boolean({ description: "Create shareable session log (default: true)", default: true })),
	sessionDir: Type.Optional(
		Type.String({ description: "Directory to store session logs (default: temp; enables sessions even if share=false)" }),
	),
	// Clarification TUI
	clarify: Type.Optional(Type.Boolean({ description: "Show TUI to preview/edit before execution (default: true for chains, false for single/parallel). Implies sync mode." })),
	// Solo agent overrides
	output: Type.Optional(Type.Any({ description: "Override output file for single agent (string), or false to disable (uses agent default if omitted)" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for single agent (e.g. 'anthropic/claude-sonnet-4')" })),
});

export const StatusParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Async run id or prefix" })),
	dir: Type.Optional(Type.String({ description: "Async run directory (overrides id search)" })),
});
