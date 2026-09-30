/**
 * Package-owned workflow scripts for the data-only `tasks` and `chain` inputs.
 * Callers supply only data; every caller string is embedded with JSON.stringify
 * and never becomes code. Scripts run on the ordinary workflow runtime.
 */

export type StructuredWorkflowKind = "tasks" | "chain";

const OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER_PATTERN = /\{(?:task|previous|outputs\.([A-Za-z_][A-Za-z0-9_]*))\}/g;

interface TemplateScope {
	path: string;
	/** Whether the script declares `originalTask` for {task}. */
	hasOriginalTask: boolean;
	/** Script variable holding the previous step's output, or the reason {previous} is unavailable. */
	previous: { variable: string } | { unavailable: string };
	/** Script variables for outputs named by earlier sequential steps; undefined when named outputs are unavailable. */
	outputs?: ReadonlyMap<string, string>;
	outputsUnavailable?: string;
}

interface StepChild {
	key: string;
	agent: string;
	taskExpression: string;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function nonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string.`);
	return value;
}

function exactFields(value: unknown, path: string, allowed: readonly string[], hint: string): Record<string, unknown> {
	if (!isPlainRecord(value)) throw new Error(`${path} must be an object.`);
	const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unsupported.length > 0) throw new Error(`${path} contains unsupported fields: ${unsupported.join(", ")}. ${hint}`);
	return value;
}

/** Single pass: text inserted for a placeholder is never scanned again. Unrecognized brace text stays literal. */
function compileTemplate(template: string, scope: TemplateScope): string {
	const parts: string[] = [];
	let cursor = 0;
	for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
		const literal = template.slice(cursor, match.index);
		cursor = match.index + match[0].length;
		let variable: string;
		if (match[0] === "{task}") {
			if (!scope.hasOriginalTask) throw new Error(`${scope.path} references {task}, but no top-level task was provided.`);
			variable = "originalTask";
		} else if (match[0] === "{previous}") {
			if ("unavailable" in scope.previous) throw new Error(`${scope.path} cannot use {previous}; ${scope.previous.unavailable}`);
			variable = scope.previous.variable;
		} else {
			const name = match[1]!;
			if (!scope.outputs) throw new Error(`${scope.path} cannot use {outputs.${name}}; ${scope.outputsUnavailable}`);
			const named = scope.outputs.get(name);
			if (!named) throw new Error(`${scope.path} references {outputs.${name}}, but no earlier sequential step sets as: "${name}".`);
			variable = named;
		}
		if (literal) parts.push(JSON.stringify(literal));
		parts.push(variable);
	}
	const literal = template.slice(cursor);
	if (literal || parts.length === 0) parts.push(JSON.stringify(literal));
	return parts.join(" + ");
}

function prelude(originalTask: string | undefined): string[] {
	return originalTask === undefined ? [SETTLE_HELPER] : [SETTLE_HELPER, `const originalTask = ${JSON.stringify(originalTask)};`];
}

function runsAllCall(children: readonly StepChild[]): string {
	return `await runs.all([${children.map((child) => `{ key: ${JSON.stringify(child.key)}, agent: ${JSON.stringify(child.agent)}, task: ${child.taskExpression} }`).join(", ")}])`;
}

const SETTLE_HELPER = [
	"function settle(results, agents) {",
	"  return results.map(function (result, index) {",
	"    const child = { key: result.key, agent: agents[index], ok: result.ok === true, output: typeof result.output === \"string\" ? result.output : \"\" };",
	"    if (!child.ok && typeof result.error === \"string\") child.error = result.error;",
	"    return child;",
	"  });",
	"}",
	// A failed child fails the workflow; the runtime keeps every settled child in the partial results.
	"function failure(label, children) {",
	"  return new Error(label + \": \" + children.filter(function (child) { return !child.ok; }).map(function (child) { return child.key + \" (\" + child.agent + \") failed\" + (child.error ? \": \" + child.error : \"\"); }).join(\"; \"));",
	"}",
].join("\n");

function buildTasksScript(steps: unknown, originalTask: string | undefined): string {
	if (!Array.isArray(steps) || steps.length === 0) throw new Error("tasks must be a non-empty array of { agent, task } items.");
	const children = steps.map((item, index): StepChild => {
		const path = `tasks[${index}]`;
		const record = exactFields(item, path, ["agent", "task"], "Each tasks item accepts only agent and task.");
		const agent = nonEmptyString(record.agent, `${path}.agent`);
		const task = nonEmptyString(record.task, `${path}.task`);
		const taskExpression = compileTemplate(task, {
			path: `${path}.task`,
			hasOriginalTask: originalTask !== undefined,
			previous: { unavailable: "tasks items may only use {task}." },
			outputsUnavailable: "tasks items may only use {task}.",
		});
		return { key: `task-${index + 1}`, agent, taskExpression };
	});
	return [
		...prelude(originalTask),
		`const run1 = ${runsAllCall(children)};`,
		`const children = settle(run1, ${JSON.stringify(children.map((child) => child.agent))});`,
		"if (!children.every(function (child) { return child.ok; })) throw failure(\"tasks failed\", children);",
		"return { ok: true, children };",
	].join("\n");
}

function buildChainScript(steps: unknown, originalTask: string | undefined): string {
	if (!Array.isArray(steps) || steps.length === 0) throw new Error("chain must be a non-empty array of steps.");
	const lines = [...prelude(originalTask), "const children = [];"];
	const hasOriginalTask = originalTask !== undefined;
	const outputs = new Map<string, string>();
	for (const [index, step] of steps.entries()) {
		const number = index + 1;
		const path = `chain[${index}]`;
		const previous: TemplateScope["previous"] = index === 0
			? { unavailable: "the first chain step has no previous output." }
			: { variable: `output${index}` };
		let stepChildren: StepChild[];
		let outputName: string | undefined;
		if (isPlainRecord(step) && Object.hasOwn(step, "parallel")) {
			const record = exactFields(step, path, ["parallel"], "A parallel step accepts only parallel; as is supported on sequential steps only.");
			const items = record.parallel;
			if (!Array.isArray(items) || items.length === 0) throw new Error(`${path}.parallel must be a non-empty array of { agent, task } items.`);
			stepChildren = items.map((item, itemIndex): StepChild => {
				const itemPath = `${path}.parallel[${itemIndex}]`;
				const itemRecord = exactFields(item, itemPath, ["agent", "task"], "Each parallel item accepts only agent and task.");
				const agent = nonEmptyString(itemRecord.agent, `${itemPath}.agent`);
				const task = nonEmptyString(itemRecord.task, `${itemPath}.task`);
				return { key: `step-${number}-${itemIndex + 1}`, agent, taskExpression: compileTemplate(task, { path: `${itemPath}.task`, hasOriginalTask, previous, outputs }) };
			});
		} else {
			const record = exactFields(step, path, ["agent", "task", "as"], "A sequential step accepts only agent, task and as; a parallel step accepts only parallel.");
			const agent = nonEmptyString(record.agent, `${path}.agent`);
			let task: string;
			if (record.task === undefined) {
				if (index === 0) throw new Error(`${path}.task is required; the first chain step has no previous output.`);
				task = "{previous}";
			} else task = nonEmptyString(record.task, `${path}.task`);
			if (record.as !== undefined) {
				if (typeof record.as !== "string" || !OUTPUT_NAME_PATTERN.test(record.as)) throw new Error(`${path}.as must be an identifier matching ${OUTPUT_NAME_PATTERN}.`);
				if (outputs.has(record.as)) throw new Error(`${path}.as '${record.as}' is already used by an earlier step.`);
				outputName = record.as;
			}
			stepChildren = [{ key: `step-${number}`, agent, taskExpression: compileTemplate(task, { path: `${path}.task`, hasOriginalTask, previous, outputs }) }];
		}
		lines.push(
			`const run${number} = ${runsAllCall(stepChildren)};`,
			`const step${number} = settle(run${number}, ${JSON.stringify(stepChildren.map((child) => child.agent))});`,
			`children.push(...step${number});`,
			`if (!step${number}.every(function (child) { return child.ok; })) throw failure(${JSON.stringify(`chain stopped at step ${number}`)}, step${number});`,
		);
		if (index < steps.length - 1) lines.push(`const output${number} = step${number}.map(function (child) { return child.output; }).join("\\n\\n");`);
		if (outputName !== undefined) outputs.set(outputName, `output${number}`);
	}
	lines.push("return { ok: true, children };");
	return lines.join("\n");
}

/** Validate exact data shapes and expand them into a package-owned workflow script. */
export function buildStructuredWorkflowScript(kind: StructuredWorkflowKind, steps: unknown, originalTask: string | undefined): string {
	return kind === "tasks" ? buildTasksScript(steps, originalTask) : buildChainScript(steps, originalTask);
}
