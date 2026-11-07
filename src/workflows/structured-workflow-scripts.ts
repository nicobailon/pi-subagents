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

/** Optional per-child launch fields copied verbatim onto the generated runs.all item. */
const CHILD_FIELDS = ["cwd", "model"] as const;
// Outer subagent-call controls that default onto every workflow child (docs/workflows.md); output gets its own advice.
const SHARED_CHILD_CONTROLS = new Set(["worktree", "baseRef", "context", "skill", "fast", "agentScope", "outputMode", "outputSchema", "agentContract", "acceptance", "gate", "toolBudget", "toolTimeoutMs", "control"]);
// runs.run/runs.all child fields whose outer-call form is missing or means something else (async and timeoutMs apply to the workflow).
const SCRIPT_CHILD_FIELDS = new Set(["key", "label", "phase", "resume", "async", "timeoutMs"]);

/** Recovery advice per rejected field, so a retry keeps the caller's intent instead of dropping the field. */
export function unsupportedChildFieldAdvice(fields: readonly string[], scripts: boolean): string {
	const perChild = scripts ? "use workflow: true with runs.all items" : "you need workflow scripts, which disabledFeatures has turned off";
	const advice: string[] = [];
	const itemFields = fields.filter((field) => (CHILD_FIELDS as readonly string[]).includes(field));
	if (itemFields.length > 0) advice.push(`Set ${itemFields.join(", ")} on each item, or on the subagent call itself to give every child the same value.`);
	if (fields.includes("output")) advice.push(`For one shared output, set output on the subagent call itself: the workflow result is written there and each child gets its own file beside it. For exact or different per-child paths, ${perChild}. Do not drop output if you need durable child files.`);
	const shared = fields.filter((field) => SHARED_CHILD_CONTROLS.has(field));
	if (shared.length > 0) advice.push(`Set ${shared.join(", ")} on the subagent call itself to give every child the same value; for different values per child, ${perChild}.`);
	const scriptOnly = fields.filter((field) => SCRIPT_CHILD_FIELDS.has(field));
	if (scriptOnly.length > 0) advice.push(`For per-child ${scriptOnly.join(", ")}, ${perChild}.`);
	advice.push("No child was launched.");
	return advice.join(" ");
}

interface StepChild {
	key: string;
	agent: string;
	taskExpression: string;
	fields: Partial<Record<(typeof CHILD_FIELDS)[number], string>>;
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

function exactFields(value: unknown, path: string, allowed: readonly string[], hint: string, scripts: boolean): Record<string, unknown> {
	if (!isPlainRecord(value)) throw new Error(`${path} must be an object.`);
	const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unsupported.length > 0) throw new Error(`${path} contains unsupported fields: ${unsupported.join(", ")}. ${hint} ${unsupportedChildFieldAdvice(unsupported, scripts)}`);
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

function childFields(record: Record<string, unknown>, path: string): StepChild["fields"] {
	const fields: StepChild["fields"] = {};
	for (const field of CHILD_FIELDS) {
		if (record[field] !== undefined) fields[field] = nonEmptyString(record[field], `${path}.${field}`);
	}
	return fields;
}

function runsAllCall(children: readonly StepChild[]): string {
	return `await runs.all([${children.map((child) => {
		const fields = Object.entries(child.fields).map(([field, value]) => `, ${field}: ${JSON.stringify(value)}`).join("");
		return `{ key: ${JSON.stringify(child.key)}, agent: ${JSON.stringify(child.agent)}, task: ${child.taskExpression}${fields} }`;
	}).join(", ")}])`;
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

function buildTasksScript(steps: unknown, originalTask: string | undefined, scripts: boolean): string {
	if (!Array.isArray(steps) || steps.length === 0) throw new Error("tasks must be a non-empty array of { agent, task } items.");
	const children = steps.map((item, index): StepChild => {
		const path = `tasks[${index}]`;
		const record = exactFields(item, path, ["agent", "task", ...CHILD_FIELDS], "Each tasks item accepts agent and task, plus optional cwd and model.", scripts);
		const agent = nonEmptyString(record.agent, `${path}.agent`);
		const task = nonEmptyString(record.task, `${path}.task`);
		const taskExpression = compileTemplate(task, {
			path: `${path}.task`,
			hasOriginalTask: originalTask !== undefined,
			previous: { unavailable: "tasks items may only use {task}." },
			outputsUnavailable: "tasks items may only use {task}.",
		});
		return { key: `task-${index + 1}`, agent, taskExpression, fields: childFields(record, path) };
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
			const record = exactFields(step, path, ["parallel"], "A parallel step accepts only parallel; as is supported on sequential steps only.", false);
			const items = record.parallel;
			if (!Array.isArray(items) || items.length === 0) throw new Error(`${path}.parallel must be a non-empty array of { agent, task } items.`);
			stepChildren = items.map((item, itemIndex): StepChild => {
				const itemPath = `${path}.parallel[${itemIndex}]`;
				const itemRecord = exactFields(item, itemPath, ["agent", "task", ...CHILD_FIELDS], "Each parallel item accepts agent and task, plus optional cwd and model.", false);
				const agent = nonEmptyString(itemRecord.agent, `${itemPath}.agent`);
				const task = nonEmptyString(itemRecord.task, `${itemPath}.task`);
				return { key: `step-${number}-${itemIndex + 1}`, agent, fields: childFields(itemRecord, itemPath), taskExpression: compileTemplate(task, { path: `${itemPath}.task`, hasOriginalTask, previous, outputs }) };
			});
		} else {
			const record = exactFields(step, path, ["agent", "task", "as", ...CHILD_FIELDS], "A sequential step accepts agent, task, as, cwd and model; a parallel step accepts only parallel.", false);
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
			stepChildren = [{ key: `step-${number}`, agent, fields: childFields(record, path), taskExpression: compileTemplate(task, { path: `${path}.task`, hasOriginalTask, previous, outputs }) }];
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

/** Validate exact data shapes and expand them into a package-owned workflow script. `scripts` is true only for the named `parallel` workflow; top-level tasks and chain exist only when workflow scripts are disabled. */
export function buildStructuredWorkflowScript(kind: StructuredWorkflowKind, steps: unknown, originalTask: string | undefined, scripts: boolean): string {
	return kind === "tasks" ? buildTasksScript(steps, originalTask, scripts) : buildChainScript(steps, originalTask);
}
