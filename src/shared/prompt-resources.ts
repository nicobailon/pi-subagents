import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../agents/frontmatter.ts";
import { getAgentDir, getProjectConfigDir } from "./utils.ts";

const PROMPT_REF_PATTERN = /^(package|user|project):([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const PROMPT_VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

type PromptVariable = string | number | boolean;

export function getPromptDirectories(cwd: string) {
	return {
		package: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts"),
		user: path.join(getAgentDir(), "prompts"),
		project: path.join(getProjectConfigDir(cwd), "prompts"),
	};
}

function promptVariables(vars: unknown): Record<string, PromptVariable> {
	if (vars === undefined) return {};
	if (!vars || typeof vars !== "object" || Array.isArray(vars)) throw new Error("prompts.render vars must be a plain object.");
	const prototype = Object.getPrototypeOf(vars);
	if (prototype !== null && prototype !== Object.prototype) throw new Error("prompts.render vars must be a plain object.");
	for (const [name, value] of Object.entries(vars)) {
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
			throw new Error(`prompts.render variable '${name}' must be a string, number, or boolean.`);
		}
	}
	return vars as Record<string, PromptVariable>;
}

export function renderWorkflowPrompt(ref: string, vars: unknown, cwd: string): string {
	const match = ref.match(PROMPT_REF_PATTERN);
	if (!match) throw new Error("prompts.render ref must use package:<name>, user:<name>, or project:<name>.");
	const scope = match[1] as keyof ReturnType<typeof getPromptDirectories>;
	const name = match[2]!;
	const filePath = path.join(getPromptDirectories(cwd)[scope], `${name}.md`);
	let content: string;
	try {
		if (!fs.lstatSync(filePath).isFile()) throw new Error("not a regular file");
		content = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read prompt fragment '${ref}': ${detail}`);
	}
	const variables = promptVariables(vars);
	return parseFrontmatter(content).body.trim().replace(PROMPT_VARIABLE_PATTERN, (placeholder, variable: string) => {
		return Object.hasOwn(variables, variable) ? String(variables[variable]) : placeholder;
	});
}
