import type { ChainConfig, ChainStepConfig } from "./agents.ts";
import { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { ChainOutputValidationError, validateChainOutputBindings } from "../runs/shared/chain-outputs.ts";
import { validateAcceptanceInput } from "../runs/shared/acceptance.ts";
import { validateToolBudgetConfig } from "../runs/shared/tool-budget.ts";
import type { ChainStep } from "../shared/settings.ts";
import type { AgentSource } from "./agents.ts";

function parseStepBody(agent: string, sectionBody: string): ChainStepConfig {
	const lines = sectionBody.split("\n");
	const blankIndex = lines.findIndex((line) => line.trim() === "");
	const configLines = blankIndex === -1 ? lines : lines.slice(0, blankIndex);
	const task = (blankIndex === -1 ? "" : lines.slice(blankIndex + 1).join("\n")).trim();

	const step: ChainStepConfig = { agent, task };
	for (const line of configLines) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (!match) continue;
		const key = match[1].trim().toLowerCase();
		const rawValue = match[2].trim();

		if (key === "output") {
			if (rawValue === "false") step.output = false;
			else if (rawValue) step.output = rawValue;
			continue;
		}
		if (key === "phase") {
			if (rawValue) step.phase = rawValue;
			continue;
		}
		if (key === "label") {
			if (rawValue) step.label = rawValue;
			continue;
		}
		if (key === "as") {
			if (rawValue) step.as = rawValue;
			continue;
		}
		if (key === "outputschema") {
			if (rawValue.startsWith("{") || rawValue.startsWith("[")) {
				throw new Error("Inline outputSchema values are not supported in .chain.md files; use a schema file path.");
			}
			if (rawValue) step.outputSchema = rawValue;
			continue;
		}
		if (key === "outputmode") {
			if (rawValue === "inline" || rawValue === "file-only") step.outputMode = rawValue;
			continue;
		}
		if (key === "reads") {
			if (rawValue === "false") {
				step.reads = false;
			} else {
				const reads = rawValue
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean);
				step.reads = reads.length > 0 ? reads : false;
			}
			continue;
		}
		if (key === "model") {
			if (rawValue) step.model = rawValue;
			continue;
		}
		if (key === "skills") {
			if (rawValue === "false") {
				step.skills = false;
			} else {
				const skills = rawValue
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean);
				step.skills = skills.length > 0 ? skills : false;
			}
			continue;
		}
		if (key === "progress") {
			if (rawValue === "true") step.progress = true;
			else if (rawValue === "false") step.progress = false;
			continue;
		}
		if (key === "toolbudget") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(rawValue);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Invalid toolBudget in .chain.md step '${agent}': ${message}`);
			}
			const validation = validateToolBudgetConfig(parsed, `toolBudget for step '${agent}'`);
			if (validation.error) throw new Error(validation.error);
			step.toolBudget = parsed as ChainStepConfig["toolBudget"];
		}
	}

	return step;
}

export function parseChain(content: string, source: AgentSource, filePath: string): ChainConfig {
	const { frontmatter, body } = parseFrontmatter(content);
	if (!frontmatter.name || !frontmatter.description) {
		throw new Error("Chain frontmatter must include name and description");
	}

	const matches = [...body.matchAll(/^##\s+(.+)[^\S\n]*$/gm)];
	const steps: ChainStepConfig[] = [];

	for (let i = 0; i < matches.length; i++) {
		const match = matches[i]!;
		const agent = match[1]!.trim();
		const lineEndOffset = body[match.index! + match[0].length] === "\n" ? 1 : 0;
		const sectionStart = match.index! + match[0].length + lineEndOffset;
		const sectionEnd = i + 1 < matches.length ? matches[i + 1]!.index! : body.length;
		const sectionBody = body.slice(sectionStart, sectionEnd).trimEnd();
		steps.push(parseStepBody(agent, sectionBody));
	}

	const localName = frontmatter.name;
	const parsedPackage = parsePackageName(frontmatter.package, `Chain '${localName}' package`);
	if (parsedPackage.error) throw new Error(parsedPackage.error);
	const packageName = parsedPackage.packageName;
	const extraFields: Record<string, string> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (key === "name" || key === "package" || key === "description") continue;
		extraFields[key] = value;
	}

	return {
		name: buildRuntimeName(localName, packageName),
		localName,
		packageName,
		description: frontmatter.description,
		source,
		filePath,
		steps,
		extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
	};
}

function validateJsonChainToolBudget(value: unknown, label: string): void {
	const validation = validateToolBudgetConfig(value, label);
	if (validation.error) throw new Error(validation.error);
}

export function parseJsonChain(content: string, source: AgentSource, filePath: string): ChainConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON chain '${filePath}': ${message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`JSON chain '${filePath}' must contain an object root.`);
	}
	const input = parsed as Record<string, unknown>;
	if (typeof input.name !== "string" || !input.name.trim()) {
		throw new Error(`JSON chain '${filePath}' must include string name.`);
	}
	if (typeof input.description !== "string" || !input.description.trim()) {
		throw new Error(`JSON chain '${filePath}' must include string description.`);
	}
	if (!Array.isArray(input.chain)) {
		throw new Error(`JSON chain '${filePath}' must include array chain.`);
	}
	for (let i = 0; i < input.chain.length; i++) {
		const step = input.chain[i];
		if (!step || typeof step !== "object" || Array.isArray(step)) {
			throw new Error(`JSON chain '${filePath}' step ${i + 1} must be an object.`);
		}
		const stepRecord = step as Record<string, unknown>;
		if (stepRecord.toolBudget !== undefined) validateJsonChainToolBudget(stepRecord.toolBudget, `step ${i + 1} toolBudget`);
		const acceptanceErrors = validateAcceptanceInput(stepRecord.acceptance, `step ${i + 1} acceptance`);
		if (acceptanceErrors.length > 0) {
			throw new Error(`Invalid JSON chain '${filePath}': ${acceptanceErrors.join(" ")}`);
		}
		const parallel = stepRecord.parallel;
		if (Array.isArray(parallel)) {
			for (let taskIndex = 0; taskIndex < parallel.length; taskIndex++) {
				const task = parallel[taskIndex];
				if (!task || typeof task !== "object" || Array.isArray(task)) continue;
				const taskRecord = task as Record<string, unknown>;
				if (taskRecord.toolBudget !== undefined) validateJsonChainToolBudget(taskRecord.toolBudget, `step ${i + 1} parallel task ${taskIndex + 1} toolBudget`);
				const taskErrors = validateAcceptanceInput(taskRecord.acceptance, `step ${i + 1} parallel task ${taskIndex + 1} acceptance`);
				if (taskErrors.length > 0) {
					throw new Error(`Invalid JSON chain '${filePath}': ${taskErrors.join(" ")}`);
				}
			}
		} else if (parallel && typeof parallel === "object") {
			const parallelRecord = parallel as Record<string, unknown>;
			if (parallelRecord.toolBudget !== undefined) validateJsonChainToolBudget(parallelRecord.toolBudget, `step ${i + 1} dynamic template toolBudget`);
			const templateErrors = validateAcceptanceInput(parallelRecord.acceptance, `step ${i + 1} dynamic template acceptance`);
			if (templateErrors.length > 0) {
				throw new Error(`Invalid JSON chain '${filePath}': ${templateErrors.join(" ")}`);
			}
		}
	}
	try {
		validateChainOutputBindings(input.chain as ChainStep[], { maxItems: Number.MAX_SAFE_INTEGER });
	} catch (error) {
		if (error instanceof ChainOutputValidationError) throw new Error(`Invalid JSON chain '${filePath}': ${error.message}`);
		throw error;
	}
	const parsedPackage = parsePackageName(typeof input.package === "string" ? input.package : undefined, `Chain '${input.name}' package`);
	if (parsedPackage.error) throw new Error(parsedPackage.error);
	const extraFields: Record<string, string> = {};
	for (const [key, value] of Object.entries(input)) {
		if (key === "name" || key === "package" || key === "description" || key === "chain") continue;
		if (typeof value === "string") extraFields[key] = value;
	}
	return {
		name: buildRuntimeName(input.name.trim(), parsedPackage.packageName),
		localName: input.name.trim(),
		packageName: parsedPackage.packageName,
		description: input.description.trim(),
		source,
		filePath,
		steps: input.chain as ChainStepConfig[],
		extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
	};
}

export function serializeJsonChain(config: ChainConfig): string {
	const root: Record<string, unknown> = {
		name: frontmatterNameForConfig(config),
		description: config.description,
		chain: config.steps,
	};
	if (config.packageName) root.package = config.packageName;
	if (config.extraFields) {
		for (const [key, value] of Object.entries(config.extraFields)) {
			if (key !== "name" && key !== "description" && key !== "package" && key !== "chain") root[key] = value;
		}
	}
	return `${JSON.stringify(root, null, 2)}\n`;
}

export function serializeChain(config: ChainConfig): string {
	const lines: string[] = [];
	lines.push("---");
	lines.push(`name: ${frontmatterNameForConfig(config)}`);
	if (config.packageName) lines.push(`package: ${config.packageName}`);
	lines.push(`description: ${config.description}`);
	if (config.extraFields) {
		for (const [key, value] of Object.entries(config.extraFields)) {
			lines.push(`${key}: ${value}`);
		}
	}
	lines.push("---");
	lines.push("");

	for (let i = 0; i < config.steps.length; i++) {
		const step = config.steps[i]!;
		lines.push(`## ${step.agent}`);
		if (step.output === false) lines.push("output: false");
		else if (step.output) lines.push(`output: ${step.output}`);
		if (step.phase) lines.push(`phase: ${step.phase}`);
		if (step.label) lines.push(`label: ${step.label}`);
		if (step.as) lines.push(`as: ${step.as}`);
		if (step.outputSchema) lines.push(`outputSchema: ${step.outputSchema}`);
		if (step.outputMode) lines.push(`outputMode: ${step.outputMode}`);
		if (step.reads === false) lines.push("reads: false");
		else if (Array.isArray(step.reads) && step.reads.length > 0) lines.push(`reads: ${step.reads.join(", ")}`);
		if (step.model) lines.push(`model: ${step.model}`);
		if (step.skills === false) lines.push("skills: false");
		else if (Array.isArray(step.skills) && step.skills.length > 0) lines.push(`skills: ${step.skills.join(", ")}`);
		if (step.progress !== undefined) lines.push(`progress: ${step.progress ? "true" : "false"}`);
		if (step.toolBudget !== undefined) lines.push(`toolBudget: ${JSON.stringify(step.toolBudget)}`);
		lines.push("");
		lines.push(step.task ?? "");
		if (i < config.steps.length - 1) lines.push("");
	}

	return `${lines.join("\n")}\n`;
}
