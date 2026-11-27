import { isDeepStrictEqual } from "node:util";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { DisabledFeatureSurface } from "../shared/disabled-features.ts";
import { closestMatch } from "../shared/edit-distance.ts";
import { isWorkflowScriptText, removedModelWorkflowFieldError } from "./public-execution.ts";
import { SUBAGENT_OPTION_KEYS, SubagentFlatParams, SubagentOptionParams, SubagentParams, createSubagentParamsSchema } from "./schemas.ts";

const optionKeys = new Set(SUBAGENT_OPTION_KEYS);
const ALIAS_HINTS: Record<string, string> = { runId: "id (top-level)", maxRuntimeMs: "options.timeoutMs", isolation: "worktree (top-level)" };
const optionsValidator = Compile(SubagentOptionParams);
const FLAT_FIELDS: Record<string, TSchema> = SubagentFlatParams.properties;
const MODEL_FIELDS: Record<string, TSchema> = { ...FLAT_FIELDS, ...SubagentParams.properties };
const LAUNCH_FIELDS = "agent, task, cwd, context, model, output, label, worktree";
const fieldValidators = new Map<TSchema, ReturnType<typeof Compile>>();
const fieldValidator = (schema: TSchema) => {
	let validator = fieldValidators.get(schema);
	if (!validator) fieldValidators.set(schema, validator = Compile(schema));
	return validator;
};

/** Some models fill every unset optional parameter with the string "null" (#3285); it means the field was left out. */
export function isUnsetPlaceholder(value: unknown): boolean {
	return value === "null";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isBlankValue(value: unknown): boolean {
	return value === true || value === "true" || value === null || value === "null" || (isPlainObject(value) && Object.keys(value).length === 0);
}

const isWorkflowCall = (workflow: unknown) => workflow !== undefined && !isUnsetPlaceholder(workflow) && workflow !== false && workflow !== "false";

function liftableArgs(params: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!isPlainObject(params.args) || isWorkflowCall(params.workflow) || (isPlainObject(params.options) && params.options.script !== undefined)) return undefined;
	return params.args;
}

function dropBlankArgsDuplicates(params: Record<string, unknown>): Record<string, unknown> {
	const args = liftableArgs(params);
	if (!args) return params;
	const blank = Object.keys(params).filter((key) => key !== "args" && Object.hasOwn(args, key) && isBlankValue(params[key]));
	return blank.length ? Object.fromEntries(Object.entries(params).filter(([key]) => !blank.includes(key))) : params;
}

export function liftArgsFields(params: Record<string, unknown>): Record<string, unknown> {
	const args = liftableArgs(params);
	if (!args) return params;
	const { args: _args, ...rest } = dropBlankArgsDuplicates(params);
	return { ...args, ...rest };
}

function parseJsonText(text: string): unknown {
	if (!/^\s*[[{]/.test(text)) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function convertField(key: string, value: unknown, schema: TSchema, workflowCall: boolean): unknown {
	const validator = fieldValidator(schema);
	const type = (schema as { type?: unknown }).type;
	if (typeof value === "string" && validator.Check(value)) {
		const spelled = value === "true" ? true : value === "false" ? false : parseJsonText(value);
		return spelled !== undefined && validator.Check(spelled) ? spelled : value;
	}
	if (validator.Check(value)) return value;
	if ((type === "integer" || type === "number") && (typeof value === "boolean" || value === "true" || value === "false")) {
		const hint = workflowCall
			? `For a workflow call, set ${key} on each child in a workflow: true script.`
			: `If your fields arrive missing or changed, pass them inside args: subagent({..., args:{${key}: <number>}}).`;
		throw new Error(`subagent: '${key}' must be a number, not ${JSON.stringify(value)}. ${hint}`);
	}
	const converted = Value.Convert(schema, structuredClone(value));
	if (validator.Check(converted)) return converted;
	if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return value;
	const parsed = parseJsonText(value);
	if (parsed === undefined) {
		const expected = type === "array" ? "a list" : "an object";
		throw new Error(`subagent: '${key}' must be ${expected}, and its text is not valid JSON. Pass the value itself, e.g. ${key}: ${expected === "a list" ? "[...]" : "{...}"}, not a string.`);
	}
	return parsed;
}

function convertFields(fields: Record<string, unknown>, schemas: Record<string, TSchema>, workflowCall: boolean): Record<string, unknown> {
	let converted: Record<string, unknown> | undefined;
	for (const [key, value] of Object.entries(fields)) {
		const schema = schemas[key];
		if (!schema || isUnsetPlaceholder(value)) continue;
		const next = convertField(key, value, schema, workflowCall);
		if (next !== value) (converted ??= { ...fields })[key] = next;
	}
	return converted ?? fields;
}

export function prepareSubagentToolArguments(input: unknown): unknown {
	if (!isPlainObject(input)) return input;
	let args = dropBlankArgsDuplicates(input);
	if (isUnsetPlaceholder(args.args)) {
		const { args: _unset, ...rest } = args;
		args = rest;
	}
	const workflowCall = isWorkflowCall(args.workflow);
	const converted = convertFields(args, MODEL_FIELDS, workflowCall);
	if (!isPlainObject(converted.options)) return converted;
	const options = convertFields(converted.options, SubagentOptionParams.properties, workflowCall);
	return options === converted.options ? converted : { ...converted, options };
}

function checkTopLevelFields(params: Record<string, unknown>, disabled: DisabledFeatureSurface | undefined): void {
	const modelFields: Record<string, TSchema> = createSubagentParamsSchema(disabled).properties;
	const known = (key: string) => Object.hasOwn(modelFields, key) || Object.hasOwn(FLAT_FIELDS, key);
	const unknown = Object.keys(params).filter((key) => !known(key));
	if (unknown.length > 0) {
		const hints = unknown.map((key) => {
			const suggestion = closestMatch(key, [...new Set([...Object.keys(modelFields), ...Object.keys(FLAT_FIELDS)])]);
			return `unknown field '${key}'.${suggestion ? ` Did you mean '${suggestion}'?` : ""}`;
		});
		throw new Error(`subagent: ${hints.join(" ")} Launch fields: ${LAUNCH_FIELDS}. Every field: subagent({action:"guide", topic:"tool-reference/parameter-reference"}).`);
	}
	const errors = Object.entries(params).filter(([key]) => key !== "action").flatMap(([key, value]) => {
		const validator = fieldValidator(modelFields[key] ?? FLAT_FIELDS[key]!);
		if (validator.Check(value)) return [];
		const error = [...validator.Errors(value)][0];
		return [`'${key}${error?.instancePath.replaceAll("/", ".") ?? ""}' ${error?.message ?? "is invalid"} (got ${JSON.stringify(value)?.slice(0, 80)})`];
	});
	if (errors.length > 0) throw new Error(`subagent: ${errors.slice(0, 4).join("; ")}.`);
}

/**
 * Lowers a model tool call's `options` into the flat params the executor reads.
 * Management fields given at the top level keep working, as in the flat shape older sessions declared.
 */
export function flattenSubagentToolOptions(params: Record<string, unknown>, disabled?: DisabledFeatureSurface): SubagentParamsLike {
	// Some models fill every unset optional parameter with the string "null", and the workflow union with "false" (#3285).
	params = Object.fromEntries(Object.entries(params).filter(([key, value]) => !isUnsetPlaceholder(value) && !(key === "workflow" && (value === "false" || value === false))));
	if (params.options && typeof params.options === "object" && !Array.isArray(params.options)) {
		params.options = Object.fromEntries(Object.entries(params.options).filter(([, value]) => !isUnsetPlaceholder(value)));
	}
	const removedTopLevel = removedModelWorkflowFieldError(params);
	if (removedTopLevel) throw new Error(removedTopLevel);
	const { options, ...topLevel } = params;
	checkTopLevelFields(topLevel, disabled);
	if (!disabled?.params.has("workflow") && typeof topLevel.workflow === "string" && isWorkflowScriptText(topLevel.workflow)) throw new Error("subagent: workflow has line breaks, so it is script text; pass it as options.script (or a ```js workflow block with workflow: true).");
	if (options === undefined) return topLevel;
	if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("subagent: options must be an object.");
	const removedField = removedModelWorkflowFieldError(options);
	if (removedField) throw new Error(removedField);
	// options.script carries script text as a tool argument for hosts that drop the reply's ```js block (SUMMARY_NOTE).
	const { script, ...rest } = options as Record<string, unknown>;
	if (script !== undefined) {
		if (typeof script !== "string" || !script.trim()) throw new Error("subagent: options.script must be the workflow script's source text.");
		// workflow: true also means "the script is inline", so it adds nothing next to options.script (#3320).
		const { workflow, ...withoutWorkflow } = topLevel;
		if (workflow !== undefined && workflow !== true && workflow !== "true") throw new Error("subagent: options.script replaces workflow; pass only one of them.");
		return { ...flattenSubagentToolOptions({ ...withoutWorkflow, options: rest }, disabled), workflowScript: script };
	}
	const entries = Object.entries(options);
	const enabledKeys = SUBAGENT_OPTION_KEYS.filter((key) => !disabled?.params.has(key));
	const unknown = entries.map(([key]) => key).filter((key) => !optionKeys.has(key));
	if (unknown.length > 0) {
		const fields = Object.keys(createSubagentParamsSchema(disabled).properties);
		const hints = unknown.map((key) => {
			if (Object.hasOwn(ALIAS_HINTS, key)) return `unknown options key '${key}'; use ${ALIAS_HINTS[key]}.`;
			if (fields.includes(key)) return `'${key}' is a top-level field, not an option.`;
			const suggestion = closestMatch(key, enabledKeys);
			return `unknown options key '${key}'.${suggestion ? ` Did you mean '${suggestion}'?` : ""}`;
		});
		throw new Error(`subagent: ${hints.join(" ")} Valid options: ${enabledKeys.sort().join(", ")}.`);
	}
	const disabledKey = entries.find(([key]) => disabled?.params.has(key))?.[0];
	if (disabledKey) throw new Error(`subagent option 'options.${disabledKey}' is disabled by config ${disabled!.params.get(disabledKey)}.`);
	// Some providers send nested scalars as strings.
	const converted = Value.Convert(SubagentOptionParams, structuredClone(options));
	if (!optionsValidator.Check(converted)) {
		const errors = [...optionsValidator.Errors(converted)].slice(0, 4).map((error) => `options${error.instancePath.replaceAll("/", ".")} ${error.message}`);
		throw new Error(`subagent: ${errors.join("; ")}.`);
	}
	const conflicts = Object.entries(converted).filter(([key, value]) => topLevel[key] !== undefined && !isDeepStrictEqual(topLevel[key], value)).map(([key]) => `'${key}'`);
	if (conflicts.length > 0) throw new Error(`subagent: ${conflicts.join(", ")} given both at the top level and in options with different values; give each once.`);
	return { ...topLevel, ...converted } as SubagentParamsLike;
}
