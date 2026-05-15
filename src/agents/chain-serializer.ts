import type { ChainConfig, ChainStepConfig } from "./agents.ts";
import { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.ts";
import { parseFrontmatter } from "./frontmatter.ts";

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
		}
		if (key === "thinking") {
			if (rawValue === "false") step.thinking = false;
			else if (rawValue) step.thinking = rawValue;
		}
	}

	return step;
}

export function parseChain(content: string, source: "user" | "project", filePath: string): ChainConfig {
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
		if (step.outputMode) lines.push(`outputMode: ${step.outputMode}`);
		if (step.reads === false) lines.push("reads: false");
		else if (Array.isArray(step.reads) && step.reads.length > 0) lines.push(`reads: ${step.reads.join(", ")}`);
		if (step.model) lines.push(`model: ${step.model}`);
		if (step.skills === false) lines.push("skills: false");
		else if (Array.isArray(step.skills) && step.skills.length > 0) lines.push(`skills: ${step.skills.join(", ")}`);
		if (step.progress !== undefined) lines.push(`progress: ${step.progress ? "true" : "false"}`);
		if (step.thinking === false) lines.push("thinking: false");
		else if (step.thinking) lines.push(`thinking: ${step.thinking}`);
		lines.push("");
		lines.push(step.task ?? "");
		if (i < config.steps.length - 1) lines.push("");
	}

	return `${lines.join("\n")}\n`;
}
