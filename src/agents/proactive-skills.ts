import type { AgentConfig, ChainConfig, ChainStepConfig } from "./agents.ts";
import type { ProactiveSkillSubagentsConfig } from "../shared/types.ts";

const SUBAGENT_ORCHESTRATION_SKILL = "pi-subagents";
const DEFAULT_MIN_REFERENCES = 2;
const DEFAULT_MAX_RECOMMENDATIONS = 3;
const DEFAULT_PREFERRED_AGENT = "reviewer";
const FALLBACK_AGENT_ORDER = ["reviewer", "delegate"];
const MAX_RECOMMENDATION_CAP = 5;

export interface ResolvedProactiveSkillSubagentsConfig {
	enabled: boolean;
	minReferences: number;
	maxRecommendations: number;
	preferredAgent: string;
}

export interface ProactiveSkillSubagentRecommendation {
	skill: string;
	agent: string;
	references: number;
	sources: string[];
	description?: string;
	reason: string;
}

export interface AvailableSkill {
	name: string;
	description?: string;
}

function positiveInteger(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	if (!Number.isInteger(value) || !Number.isFinite(value) || value < 1) return undefined;
	return value;
}

export function resolveProactiveSkillSubagentsConfig(
	config?: ProactiveSkillSubagentsConfig | false,
): ResolvedProactiveSkillSubagentsConfig {
	if (config === false) {
		return {
			enabled: false,
			minReferences: DEFAULT_MIN_REFERENCES,
			maxRecommendations: DEFAULT_MAX_RECOMMENDATIONS,
			preferredAgent: DEFAULT_PREFERRED_AGENT,
		};
	}

	const maxRecommendations = positiveInteger(config?.maxRecommendations) ?? DEFAULT_MAX_RECOMMENDATIONS;
	return {
		enabled: config?.enabled ?? true,
		minReferences: positiveInteger(config?.minReferences) ?? DEFAULT_MIN_REFERENCES,
		maxRecommendations: Math.min(maxRecommendations, MAX_RECOMMENDATION_CAP),
		preferredAgent: typeof config?.preferredAgent === "string" && config.preferredAgent.trim()
			? config.preferredAgent.trim()
			: DEFAULT_PREFERRED_AGENT,
	};
}

function normalizeSkillNames(value: unknown): string[] {
	if (value === false || value === true || value === undefined || value === null) return [];
	if (Array.isArray(value)) {
		return [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))];
	}
	if (typeof value === "string") {
		return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
	}
	return [];
}

function collectStepSkills(step: ChainStepConfig, out: Set<string>): void {
	for (const skill of normalizeSkillNames(step.skills ?? (step as { skill?: unknown }).skill)) {
		out.add(skill);
	}

	const parallel = step.parallel;
	if (!parallel) return;
	if (Array.isArray(parallel)) {
		for (const child of parallel) {
			if (child && typeof child === "object" && !Array.isArray(child)) {
				collectStepSkills(child as ChainStepConfig, out);
			}
		}
		return;
	}
	if (typeof parallel === "object") {
		collectStepSkills(parallel as ChainStepConfig, out);
	}
}

function chooseRecommendationAgent(agents: AgentConfig[], preferredAgent: string): string | undefined {
	const enabled = agents.filter((agent) => !agent.disabled);
	if (enabled.some((agent) => agent.name === preferredAgent)) return preferredAgent;
	for (const name of FALLBACK_AGENT_ORDER) {
		if (enabled.some((agent) => agent.name === name)) return name;
	}
	return enabled[0]?.name;
}

function addSource(counts: Map<string, Set<string>>, skill: string, source: string): void {
	if (skill === SUBAGENT_ORCHESTRATION_SKILL) return;
	const sources = counts.get(skill) ?? new Set<string>();
	sources.add(source);
	counts.set(skill, sources);
}

export function recommendProactiveSkillSubagents(input: {
	agents: AgentConfig[];
	chains?: ChainConfig[];
	availableSkills?: AvailableSkill[];
	config?: ProactiveSkillSubagentsConfig | false;
}): ProactiveSkillSubagentRecommendation[] {
	const config = resolveProactiveSkillSubagentsConfig(input.config);
	if (!config.enabled) return [];

	const agent = chooseRecommendationAgent(input.agents, config.preferredAgent);
	if (!agent) return [];

	const availableByName = input.availableSkills
		? new Map(input.availableSkills.map((skill) => [skill.name, skill]))
		: undefined;
	const counts = new Map<string, Set<string>>();

	for (const candidate of input.agents) {
		if (candidate.disabled) continue;
		for (const skill of candidate.skills ?? []) {
			addSource(counts, skill, `agent:${candidate.name}`);
		}
	}

	for (const chain of input.chains ?? []) {
		const chainSkills = new Set<string>();
		for (const step of chain.steps) {
			collectStepSkills(step, chainSkills);
		}
		for (const skill of chainSkills) {
			addSource(counts, skill, `chain:${chain.name}`);
		}
	}

	return [...counts.entries()]
		.filter(([skill, sources]) => sources.size >= config.minReferences && (!availableByName || availableByName.has(skill)))
		.map(([skill, sources]) => {
			const description = availableByName?.get(skill)?.description;
			return {
				skill,
				agent,
				references: sources.size,
				sources: [...sources].sort((a, b) => a.localeCompare(b)),
				...(description !== undefined ? { description } : {}),
				reason: `referenced by ${sources.size} configured agents/chains`,
			};
		})
		.sort((a, b) => b.references - a.references || a.skill.localeCompare(b.skill))
		.slice(0, config.maxRecommendations);
}

export function formatProactiveSkillSubagentRecommendations(
	recommendations: ProactiveSkillSubagentRecommendation[],
): string[] {
	if (recommendations.length === 0) return [];
	return [
		"Proactive skill subagent suggestions:",
		...recommendations.map((recommendation) => {
			const sampleSources = recommendation.sources.slice(0, 3).join(", ");
			const extra = recommendation.sources.length > 3 ? `, +${recommendation.sources.length - 3} more` : "";
			const description = recommendation.description ? ` - ${recommendation.description}` : "";
			return `- ${recommendation.skill} via ${recommendation.agent} (${recommendation.reason}; ${sampleSources}${extra})${description}`;
		}),
		"Guardrails: use these for broad tasks where a skill-specialist pass is useful; keep fanout small, use fresh context unless private/session context is explicitly needed, and skip when the user asks for a direct answer.",
	];
}

export function buildProactiveSkillSubagentRecommendationLines(input: {
	agents: AgentConfig[];
	chains?: ChainConfig[];
	config?: ProactiveSkillSubagentsConfig | false;
	discoverAvailableSkills: () => AvailableSkill[];
}): string[] {
	if (!resolveProactiveSkillSubagentsConfig(input.config).enabled) return [];
	let availableSkills: AvailableSkill[];
	try {
		availableSkills = input.discoverAvailableSkills();
	} catch {
		availableSkills = [];
	}
	return formatProactiveSkillSubagentRecommendations(recommendProactiveSkillSubagents({
		agents: input.agents,
		...(input.chains !== undefined ? { chains: input.chains } : {}),
		availableSkills,
		...(input.config !== undefined ? { config: input.config } : {}),
	}));
}
