import { parse } from "acorn";

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_SCRIPT_BYTES = 1_048_576;
const MAX_CHILDREN = 256;
const ALLOWED_CHILD_FIELDS = new Set([
	"key", "agent", "task", "resume", "model", "context", "cwd", "worktree", "output", "outputMode",
	"skill", "thinking", "fast", "timeoutMs", "maxRuntimeMs", "toolTimeoutMs", "turnBudget", "toolBudget",
	"usageBudget", "acceptance", "gate", "artifacts", "share", "sessionDir", "agentScope", "outputSchema",
	"extensionBindings", "mission", "missionId", "phase", "label", "control", "chatProgress",
]);

export interface StaticWorkflowCall {
	key: string;
	params: Record<string, unknown>;
}

type Node = Record<string, any>;

function propertyName(property: Node): string {
	if (property.computed || property.kind !== "init" || property.method || property.shorthand) throw new Error("Static runs.all objects require ordinary named properties.");
	if (property.key?.type === "Identifier") return property.key.name;
	if (property.key?.type === "Literal" && typeof property.key.value === "string") return property.key.value;
	throw new Error("Static runs.all object keys must be string literals or identifiers.");
}

function literal(node: Node, path: string): unknown {
	if (!node || typeof node !== "object") throw new Error(`${path} must be a strict JSON literal.`);
	if (node.type === "Literal") {
		if (node.regex || typeof node.value === "bigint" || (typeof node.value === "number" && !Number.isFinite(node.value))) throw new Error(`${path} must be a strict JSON literal.`);
		return node.value;
	}
	if (node.type === "ArrayExpression") {
		if (node.elements.length > 256 || node.elements.some((entry: unknown) => entry === null)) throw new Error(`${path} must be a dense bounded literal array.`);
		return node.elements.map((entry: Node, index: number) => literal(entry, `${path}[${index}]`));
	}
	if (node.type === "ObjectExpression") {
		if (node.properties.length > 256) throw new Error(`${path} has too many properties.`);
		const output: Record<string, unknown> = {};
		for (const property of node.properties as Node[]) {
			if (property.type !== "Property") throw new Error(`${path} must not contain spread properties.`);
			const key = propertyName(property);
			if (Object.hasOwn(output, key)) throw new Error(`${path} contains duplicate property '${key}'.`);
			output[key] = literal(property.value, `${path}.${key}`);
		}
		return output;
	}
	if (node.type === "UnaryExpression" && node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
		return -node.argument.value;
	}
	throw new Error(`${path} must be a strict JSON literal.`);
}

function isRunsAll(node: Node): boolean {
	return node?.type === "CallExpression"
		&& node.callee?.type === "MemberExpression"
		&& node.callee.computed === false
		&& node.callee.object?.type === "Identifier"
		&& node.callee.object.name === "runs"
		&& node.callee.property?.type === "Identifier"
		&& node.callee.property.name === "all";
}

export function parseStaticRunsAllWorkflow(script: string): StaticWorkflowCall[] {
	if (typeof script !== "string" || !script.trim()) throw new Error("Static workflowScript must be non-empty.");
	if (Buffer.byteLength(script, "utf8") > MAX_SCRIPT_BYTES) throw new Error("Static workflowScript exceeds the size limit.");
	let ast: Node;
	try {
		ast = parse(script, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }) as unknown as Node;
	} catch (error) {
		throw new Error(`Static workflowScript is invalid JavaScript: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(ast.body) || ast.body.length !== 1 || ast.body[0]?.type !== "ReturnStatement") {
		throw new Error("Static workflowScript must contain exactly one return statement.");
	}
	let expression = ast.body[0].argument as Node;
	if (expression?.type === "AwaitExpression") expression = expression.argument;
	if (!isRunsAll(expression) || expression.arguments.length !== 1 || expression.arguments[0]?.type !== "ArrayExpression") {
		throw new Error("Static workflowScript must return exactly one runs.all literal array.");
	}
	const items = expression.arguments[0].elements as Array<Node | null>;
	if (items.length < 1 || items.length > MAX_CHILDREN || items.some((item) => item === null)) {
		throw new Error(`Static runs.all must contain at least one and at most ${MAX_CHILDREN} children.`);
	}
	const calls = items.map((item, index) => {
		if (item?.type !== "ObjectExpression") throw new Error(`Static runs.all item ${index} must be a literal object.`);
		const value = literal(item, `runs.all[${index}]`) as Record<string, unknown>;
		for (const field of Object.keys(value)) if (!ALLOWED_CHILD_FIELDS.has(field)) throw new Error(`Static runs.all item ${index} contains unsupported child field '${field}'.`);
		const key = value.key;
		if (typeof key !== "string" || !KEY.test(key)) throw new Error(`Static runs.all item ${index} has an invalid key.`);
		const { key: _key, ...params } = value;
		if (typeof params.agent !== "string" || !params.agent.trim()) throw new Error(`Static runs.all item ${index} requires a literal agent.`);
		return { key, params };
	});
	if (new Set(calls.map(({ key }) => key)).size !== calls.length) throw new Error("Static runs.all contains a duplicate workflow key.");
	return calls;
}
