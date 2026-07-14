/**
 * Friendly chain parameter validation.
 *
 * The runtime (pi-ai) validates tool arguments against the TypeBox schema before
 * the tool's `execute` runs. When a chain step has an extra property, the model
 * receives a raw TypeBox message such as `chain.1: must not have additional
 * properties` — which does not name the offending property, list the allowed
 * ones, or show the expected shape. Agents then iteratively guess the format and
 * waste several turns before getting it right.
 *
 * `validateChainInput` runs from the tool's `prepareArguments` shim (and the RPC
 * bridge) *before* schema validation. It throws a rich, actionable error for the
 * common chain-shape failures, so the model sees which property is disallowed,
 * what is allowed, and a valid example — instead of a raw TypeBox diagnostic.
 *
 * Allowed property names and additional-property strictness are derived directly
 * from the schema objects in `schemas.ts` so this stays aligned with TypeBox.
 */

import {
	ChainItem,
	ParallelTaskSchema,
	DynamicParallelTemplateSchema,
	DynamicExpandSchema,
	DynamicCollectSchema,
} from "./schemas.ts";

type ObjectSchema = {
	properties?: Record<string, unknown>;
	additionalProperties?: unknown;
};

function allowedKeysOf(schema: ObjectSchema | undefined): string[] {
	return schema?.properties ? Object.keys(schema.properties) : [];
}

const ExpandFromSchema = (DynamicExpandSchema.properties?.from ?? {}) as ObjectSchema;

export const CHAIN_STEP_KEYS = allowedKeysOf(ChainItem);
export const PARALLEL_TASK_KEYS = allowedKeysOf(ParallelTaskSchema);
export const DYNAMIC_TEMPLATE_KEYS = allowedKeysOf(DynamicParallelTemplateSchema);
export const EXPAND_KEYS = allowedKeysOf(DynamicExpandSchema);
export const EXPAND_FROM_KEYS = allowedKeysOf(ExpandFromSchema);
export const COLLECT_KEYS = allowedKeysOf(DynamicCollectSchema);

const CHAIN_STEP_EXAMPLE = '{"agent": "worker", "task": "do X"}';
const PARALLEL_TASK_EXAMPLE = '{"agent": "worker", "task": "do X"}';
const DYNAMIC_TEMPLATE_EXAMPLE = '{"agent": "worker", "task": "Review {item.path}"}';
const EXPAND_EXAMPLE = '{"from": {"output": "targets", "path": "/items"}, "maxItems": 4}';
const EXPAND_FROM_EXAMPLE = '{"output": "targets", "path": "/items"}';
const COLLECT_EXAMPLE = '{"as": "reviews"}';

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function disallowedKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
	return Object.keys(value).filter((key) => !allowed.includes(key));
}

function typeName(value: unknown): string {
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function quoteList(keys: string[]): string {
	return keys.map((key) => `"${key}"`).join(", ");
}

function disallowedMessage(
	path: string,
	keys: string[],
	allowed: readonly string[],
	example?: string,
): string {
	const subject = keys.length === 1
		? `property "${keys[0]}" is not allowed`
		: `properties ${quoteList(keys)} are not allowed`;
	const examplePart = example ? `\n\nExample: ${example}` : "";
	return `subagent ${path}: ${subject}.\nAllowed properties: ${allowed.join(", ")}.${examplePart}`;
}

function expectObject(value: unknown, path: string, allowed: readonly string[], example?: string): asserts value is Record<string, unknown> {
	if (!isPlainObject(value)) {
		const examplePart = example ? `\n\nExample: ${example}` : "";
		throw new Error(
			`subagent ${path}: expected an object, received ${typeName(value)}.\nAllowed properties: ${allowed.join(", ")}.${examplePart}`,
		);
	}
}

function checkNoExtraKeys(
	value: Record<string, unknown>,
	path: string,
	schema: ObjectSchema,
	allowed: readonly string[],
	example?: string,
): void {
	if (schema.additionalProperties !== false) return;
	const extra = disallowedKeys(value, allowed);
	if (extra.length > 0) {
		throw new Error(disallowedMessage(path, extra, allowed, example));
	}
}

/**
 * Validates the `chain` array on a raw subagent tool-call argument object and
 * throws a friendly, actionable error when a chain step (or a nested
 * `parallel`/`expand`/`collect` object) has a disallowed property or wrong shape.
 *
 * No-op when `chain` is absent or not an array, so management/control/single/
 * parallel calls are unaffected.
 */
export function validateChainInput(args: unknown): void {
	if (!isPlainObject(args)) return;
	const chain = (args as Record<string, unknown>).chain;
	if (!Array.isArray(chain)) return;

	chain.forEach((step, index) => {
		const stepPath = `chain step validation failed at chain[${index}]`;
		expectObject(step, stepPath, CHAIN_STEP_KEYS, CHAIN_STEP_EXAMPLE);
		checkNoExtraKeys(step, stepPath, ChainItem, CHAIN_STEP_KEYS, CHAIN_STEP_EXAMPLE);

		if (step.expand !== undefined) {
			const expandPath = `${stepPath}.expand`;
			expectObject(step.expand, expandPath, EXPAND_KEYS, EXPAND_EXAMPLE);
			checkNoExtraKeys(step.expand, expandPath, DynamicExpandSchema, EXPAND_KEYS, EXPAND_EXAMPLE);

			const from = (step.expand as Record<string, unknown>).from;
			if (from !== undefined) {
				const fromPath = `${expandPath}.from`;
				expectObject(from, fromPath, EXPAND_FROM_KEYS, EXPAND_FROM_EXAMPLE);
				checkNoExtraKeys(from, fromPath, ExpandFromSchema, EXPAND_FROM_KEYS, EXPAND_FROM_EXAMPLE);
			}
		}

		if (step.collect !== undefined) {
			const collectPath = `${stepPath}.collect`;
			expectObject(step.collect, collectPath, COLLECT_KEYS, COLLECT_EXAMPLE);
			checkNoExtraKeys(step.collect, collectPath, DynamicCollectSchema, COLLECT_KEYS, COLLECT_EXAMPLE);
		}

		const parallel = step.parallel;
		if (parallel === undefined) return;

		if (Array.isArray(parallel)) {
			parallel.forEach((task, pIndex) => {
				const taskPath = `${stepPath}.parallel[${pIndex}]`;
				expectObject(task, taskPath, PARALLEL_TASK_KEYS, PARALLEL_TASK_EXAMPLE);
				checkNoExtraKeys(task, taskPath, ParallelTaskSchema, PARALLEL_TASK_KEYS, PARALLEL_TASK_EXAMPLE);
			});
			return;
		}

		if (isPlainObject(parallel)) {
			const templatePath = `${stepPath}.parallel (dynamic fanout template)`;
			checkNoExtraKeys(parallel, templatePath, DynamicParallelTemplateSchema, DYNAMIC_TEMPLATE_KEYS, DYNAMIC_TEMPLATE_EXAMPLE);
			return;
		}

		throw new Error(
			`subagent ${stepPath}.parallel: expected an array of task objects or a dynamic fanout template object, received ${typeName(parallel)}.\n\nExample static: [${PARALLEL_TASK_EXAMPLE}]\nExample dynamic: ${DYNAMIC_TEMPLATE_EXAMPLE}`,
		);
	});
}