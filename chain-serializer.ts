import type { ChainConfig, ChainStepConfig } from "./agents.ts";

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const frontmatter: Record<string, string> = {};
	const normalized = content.replace(/\r\n/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, body: normalized };
	}

	const frontmatterBlock = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	for (const line of frontmatterBlock.split("\n")) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (match) {
			let value = match[2].trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			frontmatter[match[1]] = value;
		}
	}

	return { frontmatter, body };
}

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

	const extraFields: Record<string, string> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (key === "name" || key === "description") continue;
		extraFields[key] = value;
	}

	return {
		name: frontmatter.name,
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
	lines.push(`name: ${config.name}`);
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
		if (step.reads === false) lines.push("reads: false");
		else if (Array.isArray(step.reads) && step.reads.length > 0) lines.push(`reads: ${step.reads.join(", ")}`);
		if (step.model) lines.push(`model: ${step.model}`);
		if (step.skills === false) lines.push("skills: false");
		else if (Array.isArray(step.skills) && step.skills.length > 0) lines.push(`skills: ${step.skills.join(", ")}`);
		if (step.progress !== undefined) lines.push(`progress: ${step.progress ? "true" : "false"}`);
		lines.push("");
		lines.push(step.task ?? "");
		if (i < config.steps.length - 1) lines.push("");
	}

	return `${lines.join("\n")}\n`;
}
