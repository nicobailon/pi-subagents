import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { discoverAgents, discoverAgentsAll } from "./agents.js";
import { executeAsyncChain, isAsyncAvailable } from "./async-execution.js";
import { executeChain } from "./chain-execution.js";
import { AgentManagerComponent, type ManagerResult } from "./agent-manager.js";
import { normalizeListKeybindings } from "./agent-manager-keybindings.js";
import { loadExtensionConfig } from "./config.js";
import { discoverAvailableSkills } from "./skills.js";
import { getArtifactsDir } from "./artifacts.js";
import { DEFAULT_ARTIFACT_CONFIG, MAX_PARALLEL, type SubagentState, type ArtifactConfig } from "./types.js";
import type { SequentialStep } from "./settings.js";

interface InlineConfig {
	output?: string | false;
	reads?: string[] | false;
	model?: string;
	skill?: string[] | false;
	progress?: boolean;
}

const parseInlineConfig = (raw: string): InlineConfig => {
	const config: InlineConfig = {};
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) {
			if (trimmed === "progress") config.progress = true;
			continue;
		}
		const key = trimmed.slice(0, eq).trim();
		const val = trimmed.slice(eq + 1).trim();
		switch (key) {
			case "output": config.output = val === "false" ? false : val; break;
			case "reads": config.reads = val === "false" ? false : val.split("+").filter(Boolean); break;
			case "model": config.model = val || undefined; break;
			case "skill": case "skills": config.skill = val === "false" ? false : val.split("+").filter(Boolean); break;
			case "progress": config.progress = val !== "false"; break;
		}
	}
	return config;
};

const parseAgentToken = (token: string): { name: string; config: InlineConfig } => {
	const bracket = token.indexOf("[");
	if (bracket === -1) return { name: token, config: {} };
	const end = token.lastIndexOf("]");
	return { name: token.slice(0, bracket), config: parseInlineConfig(token.slice(bracket + 1, end !== -1 ? end : undefined)) };
};

const extractBgFlag = (args: string): { args: string; bg: boolean } => {
	if (args.endsWith(" --bg") || args === "--bg") {
		return { args: args.slice(0, args.length - (args === "--bg" ? 4 : 5)).trim(), bg: true };
	}
	return { args, bg: false };
};

function setupDirectRun(ctx: ExtensionContext, getSubagentSessionRoot: (parentSessionFile: string | null) => string) {
	const runId = randomUUID().slice(0, 8);
	const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
	const sessionRoot = path.join(getSubagentSessionRoot(parentSessionFile), runId);
	try {
		fs.mkdirSync(sessionRoot, { recursive: true });
	} catch {}
	return {
		runId,
		shareEnabled: false,
		sessionDirForIndex: (idx?: number) => path.join(sessionRoot, `run-${idx ?? 0}`),
		artifactsDir: getArtifactsDir(parentSessionFile),
		artifactConfig: { ...DEFAULT_ARTIFACT_CONFIG } as ArtifactConfig,
	};
}

const makeAgentCompletions = (state: SubagentState, multiAgent: boolean) => (prefix: string) => {
	const agents = discoverAgents(state.baseCwd, "both").agents;
	if (!multiAgent) {
		if (prefix.includes(" ")) return null;
		return agents.filter((a) => a.name.startsWith(prefix)).map((a) => ({ value: a.name, label: a.name }));
	}

	const lastArrow = prefix.lastIndexOf(" -> ");
	const segment = lastArrow !== -1 ? prefix.slice(lastArrow + 4) : prefix;
	if (segment.includes(" -- ") || segment.includes('"') || segment.includes("'")) return null;

	const lastWord = (prefix.match(/(\S*)$/) || ["", ""])[1];
	const beforeLastWord = prefix.slice(0, prefix.length - lastWord.length);

	if (lastWord === "->") {
		return agents.map((a) => ({ value: `${prefix} ${a.name}`, label: a.name }));
	}

	return agents.filter((a) => a.name.startsWith(lastWord)).map((a) => ({ value: `${beforeLastWord}${a.name}`, label: a.name }));
};

async function openAgentManager(
	pi: ExtensionAPI,
	state: SubagentState,
	ctx: ExtensionContext,
	getSubagentSessionRoot: (parentSessionFile: string | null) => string,
): Promise<void> {
	const agentData = { ...discoverAgentsAll(ctx.cwd), cwd: ctx.cwd };
	const models = ctx.modelRegistry.getAvailable().map((m) => ({
		provider: m.provider,
		id: m.id,
		fullId: `${m.provider}/${m.id}`,
	}));
	const skills = discoverAvailableSkills(ctx.cwd);
	const config = loadExtensionConfig(ctx.cwd);
	const listKeybindings = normalizeListKeybindings(config.keybindings);

	const result = await ctx.ui.custom<ManagerResult>(
		(tui, theme, _kb, done) => new AgentManagerComponent(
			tui,
			theme,
			agentData,
			models,
			skills,
			listKeybindings,
			done,
		),
		{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
	);
	if (!result) return;

	if (result.action === "chain") {
		const agents = discoverAgents(state.baseCwd, "both").agents;
		const exec = setupDirectRun(ctx, getSubagentSessionRoot);
		const chain: SequentialStep[] = result.agents.map((name, i) => ({
			agent: name,
			...(i === 0 ? { task: result.task } : {}),
		}));
		executeChain({ chain, task: result.task, agents, ctx, ...exec, clarify: true })
			.then((r) => {
				if (r.requestedAsync) {
					if (!isAsyncAvailable()) {
						pi.sendUserMessage("Background mode requires jiti for TypeScript execution but it could not be found.");
						return;
					}
					const id = randomUUID();
					const asyncCtx = { pi, cwd: ctx.cwd, currentSessionId: ctx.sessionManager.getSessionId() ?? id };
					const asyncSessionRoot = getSubagentSessionRoot(ctx.sessionManager.getSessionFile() ?? null);
					try { fs.mkdirSync(asyncSessionRoot, { recursive: true }); } catch {}
					executeAsyncChain(id, {
						chain: r.requestedAsync.chain,
						agents,
						ctx: asyncCtx,
						maxOutput: undefined,
						artifactsDir: exec.artifactsDir,
						artifactConfig: exec.artifactConfig,
						shareEnabled: false,
						sessionRoot: asyncSessionRoot,
						chainSkills: r.requestedAsync.chainSkills,
					}).then((asyncResult) => {
						pi.sendUserMessage(asyncResult.content[0]?.text || "(launched in background)");
					}).catch((err) => {
						pi.sendUserMessage(`Async launch failed: ${err instanceof Error ? err.message : String(err)}`);
					});
					return;
				}
				pi.sendUserMessage(r.content[0]?.text || "(no output)");
			})
			.catch((err) => pi.sendUserMessage(`Chain failed: ${err instanceof Error ? err.message : String(err)}`));
		return;
	}

	const sendToolCall = (params: Record<string, unknown>) => {
		pi.sendUserMessage(
			`Call the subagent tool with these exact parameters: ${JSON.stringify({ ...params, agentScope: "both" })}`,
		);
	};

	if (result.action === "launch") {
		sendToolCall({ agent: result.agent, task: result.task, clarify: !result.skipClarify });
	} else if (result.action === "launch-chain") {
		const chainParam = result.chain.steps.map((step) => ({
			agent: step.agent,
			task: step.task || undefined,
			output: step.output,
			reads: step.reads,
			progress: step.progress,
			skill: step.skills,
			model: step.model,
		}));
		sendToolCall({ chain: chainParam, task: result.task, clarify: !result.skipClarify });
	} else if (result.action === "parallel") {
		sendToolCall({ tasks: result.tasks, clarify: !result.skipClarify });
	}
}

interface ParsedStep { name: string; config: InlineConfig; task?: string }

const parseAgentArgs = (
	state: SubagentState,
	args: string,
	command: string,
	ctx: ExtensionContext,
): { steps: ParsedStep[]; task: string } | null => {
	const input = args.trim();
	const usage = `Usage: /${command} agent1 "task1" -> agent2 "task2"`;
	let steps: ParsedStep[];
	let sharedTask: string;
	let perStep = false;

	if (input.includes(" -> ")) {
		perStep = true;
		const segments = input.split(" -> ");
		steps = [];
		for (const seg of segments) {
			const trimmed = seg.trim();
			if (!trimmed) continue;
			let agentPart: string;
			let task: string | undefined;
			const qMatch = trimmed.match(/^(\S+(?:\[[^\]]*\])?)\s+(?:"([^"]*)"|'([^']*)')$/);
			if (qMatch) {
				agentPart = qMatch[1]!;
				task = (qMatch[2] ?? qMatch[3]) || undefined;
			} else {
				const dashIdx = trimmed.indexOf(" -- ");
				if (dashIdx !== -1) {
					agentPart = trimmed.slice(0, dashIdx).trim();
					task = trimmed.slice(dashIdx + 4).trim() || undefined;
				} else {
					agentPart = trimmed;
				}
			}
			const parsed = parseAgentToken(agentPart);
			steps.push({ ...parsed, task });
		}
		sharedTask = steps.find((s) => s.task)?.task ?? "";
	} else {
		const delimiterIndex = input.indexOf(" -- ");
		if (delimiterIndex === -1) {
			ctx.ui.notify(usage, "error");
			return null;
		}
		const agentsPart = input.slice(0, delimiterIndex).trim();
		sharedTask = input.slice(delimiterIndex + 4).trim();
		if (!agentsPart || !sharedTask) {
			ctx.ui.notify(usage, "error");
			return null;
		}
		steps = agentsPart.split(/\s+/).filter(Boolean).map((t) => parseAgentToken(t));
	}

	if (steps.length === 0) {
		ctx.ui.notify(usage, "error");
		return null;
	}
	const agents = discoverAgents(state.baseCwd, "both").agents;
	for (const step of steps) {
		if (!agents.find((a) => a.name === step.name)) {
			ctx.ui.notify(`Unknown agent: ${step.name}`, "error");
			return null;
		}
	}
	if (command === "chain" && !steps[0]?.task && (perStep || !sharedTask)) {
		ctx.ui.notify(`First step must have a task: /chain agent "task" -> agent2`, "error");
		return null;
	}
	if (command === "parallel" && !steps.some((s) => s.task) && !sharedTask) {
		ctx.ui.notify("At least one step must have a task", "error");
		return null;
	}
	return { steps, task: sharedTask };
};

export function registerSlashCommands(
	pi: ExtensionAPI,
	state: SubagentState,
	getSubagentSessionRoot: (parentSessionFile: string | null) => string,
): void {
	pi.registerCommand("agents", {
		description: "Open the Agents Manager",
		handler: async (_args, ctx) => {
			await openAgentManager(pi, state, ctx, getSubagentSessionRoot);
		},
	});

	pi.registerCommand("run", {
		description: "Run a subagent directly: /run agent[output=file] task [--bg]",
		getArgumentCompletions: makeAgentCompletions(state, false),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg } = extractBgFlag(args);
			const input = cleanedArgs.trim();
			const firstSpace = input.indexOf(" ");
			if (firstSpace === -1) { ctx.ui.notify("Usage: /run <agent> <task> [--bg]", "error"); return; }
			const { name: agentName, config: inline } = parseAgentToken(input.slice(0, firstSpace));
			const task = input.slice(firstSpace + 1).trim();
			if (!task) { ctx.ui.notify("Usage: /run <agent> <task> [--bg]", "error"); return; }

			const agents = discoverAgents(state.baseCwd, "both").agents;
			if (!agents.find((a) => a.name === agentName)) { ctx.ui.notify(`Unknown agent: ${agentName}`, "error"); return; }

			let finalTask = task;
			if (inline.reads && Array.isArray(inline.reads) && inline.reads.length > 0) {
				finalTask = `[Read from: ${inline.reads.join(", ")}]\n\n${finalTask}`;
			}
			const params: Record<string, unknown> = { agent: agentName, task: finalTask, clarify: false };
			if (inline.output !== undefined) params.output = inline.output;
			if (inline.skill !== undefined) params.skill = inline.skill;
			if (inline.model) params.model = inline.model;
			if (bg) params.async = true;
			pi.sendUserMessage(`Call the subagent tool with these exact parameters: ${JSON.stringify({ ...params, agentScope: "both" })}`);
		},
	});

	pi.registerCommand("chain", {
		description: "Run agents in sequence: /chain scout \"task\" -> planner [--bg]",
		getArgumentCompletions: makeAgentCompletions(state, true),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg } = extractBgFlag(args);
			const parsed = parseAgentArgs(state, cleanedArgs, "chain", ctx);
			if (!parsed) return;
			const chain = parsed.steps.map(({ name, config, task: stepTask }, i) => ({
				agent: name,
				...(stepTask ? { task: stepTask } : i === 0 && parsed.task ? { task: parsed.task } : {}),
				...(config.output !== undefined ? { output: config.output } : {}),
				...(config.reads !== undefined ? { reads: config.reads } : {}),
				...(config.model ? { model: config.model } : {}),
				...(config.skill !== undefined ? { skill: config.skill } : {}),
				...(config.progress !== undefined ? { progress: config.progress } : {}),
			}));
			const params: Record<string, unknown> = { chain, task: parsed.task, clarify: false, agentScope: "both" };
			if (bg) params.async = true;
			pi.sendUserMessage(`Call the subagent tool with these exact parameters: ${JSON.stringify(params)}`);
		},
	});

	pi.registerCommand("parallel", {
		description: "Run agents in parallel: /parallel scout \"task1\" -> reviewer \"task2\" [--bg]",
		getArgumentCompletions: makeAgentCompletions(state, true),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg } = extractBgFlag(args);
			const parsed = parseAgentArgs(state, cleanedArgs, "parallel", ctx);
			if (!parsed) return;
			if (parsed.steps.length > MAX_PARALLEL) { ctx.ui.notify(`Max ${MAX_PARALLEL} parallel tasks`, "error"); return; }
			const tasks = parsed.steps.map(({ name, config, task: stepTask }) => ({
				agent: name,
				task: stepTask ?? parsed.task,
				...(config.output !== undefined ? { output: config.output } : {}),
				...(config.reads !== undefined ? { reads: config.reads } : {}),
				...(config.model ? { model: config.model } : {}),
				...(config.skill !== undefined ? { skill: config.skill } : {}),
				...(config.progress !== undefined ? { progress: config.progress } : {}),
			}));
			const params: Record<string, unknown> = { chain: [{ parallel: tasks }], task: parsed.task, clarify: false, agentScope: "both" };
			if (bg) params.async = true;
			pi.sendUserMessage(`Call the subagent tool with these exact parameters: ${JSON.stringify(params)}`);
		},
	});

	pi.registerShortcut("ctrl+shift+a", {
		handler: async (ctx) => {
			await openAgentManager(pi, state, ctx, getSubagentSessionRoot);
		},
	});
}
