import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const SUBAGENT_GUIDE_TOPICS = [
	"overview",
	"workflows",
	"agents",
	"missions",
	"observability",
	"tool-reference",
	"configuration",
	"models",
	"watchdog",
	"extension-api",
	"council",
] as const;

export type SubagentGuideTopic = (typeof SUBAGENT_GUIDE_TOPICS)[number];

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// /council must work under `pi --no-skills`, which drops the package skills from context,
// so this topic serves the council skill together with the references it tells the model to read.
const COUNCIL_FILES = [
	"skills/council-mode/SKILL.md",
	"skills/council-mode/references/pass-contracts.md",
	"skills/pi-subagents/references/execution-controls.md",
];

function isGuideTopic(value: string): value is SubagentGuideTopic {
	return (SUBAGENT_GUIDE_TOPICS as readonly string[]).includes(value);
}

export function readSubagentGuide(topic = "overview", root = packageRoot): string {
	if (!isGuideTopic(topic)) {
		return `Unknown subagents guide topic '${topic}'. Valid topics: ${SUBAGENT_GUIDE_TOPICS.join(", ")}. No files were changed.`;
	}
	const files = topic === "overview" ? ["README.md"] : topic === "council" ? COUNCIL_FILES : [path.join("docs", `${topic}.md`)];
	try {
		const contents = files.map((file) => fs.readFileSync(path.join(root, file), "utf-8"));
		return files.length === 1 ? contents[0]! : contents.map((content, index) => `<!-- ${files[index]} -->\n\n${content}`).join("\n\n");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read packaged subagents guide '${topic}': ${message}`, { cause: error instanceof Error ? error : undefined });
	}
}
