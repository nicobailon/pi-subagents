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
] as const;

export type SubagentGuideTopic = (typeof SUBAGENT_GUIDE_TOPICS)[number];

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function isGuideTopic(value: string): value is SubagentGuideTopic {
	return (SUBAGENT_GUIDE_TOPICS as readonly string[]).includes(value);
}

export function readSubagentGuide(topic = "overview", root = packageRoot): string {
	if (!isGuideTopic(topic)) {
		return `Unknown subagents guide topic '${topic}'. Valid topics: ${SUBAGENT_GUIDE_TOPICS.join(", ")}. No files were changed.`;
	}
	const filePath = topic === "overview"
		? path.join(root, "README.md")
		: path.join(root, "docs", `${topic}.md`);
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read packaged subagents guide '${topic}': ${message}`, { cause: error instanceof Error ? error : undefined });
	}
}
