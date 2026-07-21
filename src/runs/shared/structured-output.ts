import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";
import type { JsonSchemaObject } from "../../shared/types.ts";

export const STRUCTURED_OUTPUT_SCHEMA_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA";
export const STRUCTURED_OUTPUT_CAPTURE_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE";

export interface StructuredOutputRuntime {
	schema: JsonSchemaObject;
	schemaPath: string;
	outputPath: string;
}

const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;
const SCHEMA_SINGLE_KEYWORDS = ["additionalItems", "additionalProperties", "contains", "not", "propertyNames", "if", "then", "else", "unevaluatedItems", "unevaluatedProperties", "contentSchema"] as const;
const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

function rewriteLocalJsonPointerRefs(schema: unknown, pointerPrefix: string, inheritsWrapperResource = true): unknown {
	if (typeof schema === "boolean" || !schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	const source = schema as Record<string, unknown>;
	const rewritten: Record<string, unknown> = { ...source };
	const sharesWrapperResource = inheritsWrapperResource && typeof source.$id !== "string";
	if (sharesWrapperResource) {
		for (const keyword of ["$ref", "$dynamicRef", "$recursiveRef"] as const) {
			const ref = source[keyword];
			if (ref === "#") rewritten[keyword] = pointerPrefix;
			else if (typeof ref === "string" && ref.startsWith("#/")) rewritten[keyword] = `${pointerPrefix}${ref.slice(1)}`;
		}
	}
	for (const keyword of SCHEMA_MAP_KEYWORDS) {
		const entries = source[keyword];
		if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
		rewritten[keyword] = Object.fromEntries(Object.entries(entries).map(([name, nested]) => [
			name,
			rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource),
		]));
	}
	const items = source.items;
	if (Array.isArray(items)) rewritten.items = items.map((nested) => rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource));
	else if (items !== undefined) rewritten.items = rewriteLocalJsonPointerRefs(items, pointerPrefix, sharesWrapperResource);
	for (const keyword of SCHEMA_SINGLE_KEYWORDS) {
		if (source[keyword] !== undefined) rewritten[keyword] = rewriteLocalJsonPointerRefs(source[keyword], pointerPrefix, sharesWrapperResource);
	}
	for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
		if (Array.isArray(source[keyword])) rewritten[keyword] = source[keyword].map((nested) => rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource));
	}
	const dependencies = source.dependencies;
	if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
		rewritten.dependencies = Object.fromEntries(Object.entries(dependencies).map(([name, nested]) => [
			name,
			Array.isArray(nested) ? nested : rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource),
		]));
	}
	return rewritten;
}

export function createStructuredOutputToolParameters(schema: JsonSchemaObject): JsonSchemaObject {
	return {
		type: "object",
		properties: { value: rewriteLocalJsonPointerRefs(schema, "#/properties/value") },
		required: ["value"],
		additionalProperties: false,
	};
}

interface CompiledJsonSchema {
	Check(value: unknown): boolean;
	Errors(value: unknown): Iterable<{ instancePath?: string; message?: string }>;
}

type CompileJsonSchema = (schema: unknown) => CompiledJsonSchema;

let cachedCompile: Promise<CompileJsonSchema> | undefined;

export async function resolveCompileFromPackageRoot(packageRoot: string): Promise<CompileJsonSchema | undefined> {
	const requireFromRoot = createRequire(path.join(packageRoot, "package.json"));
	const resolved = requireFromRoot.resolve("typebox/compile");
	const mod = (await import(pathToFileURL(resolved).href)) as { Compile?: unknown };
	return typeof mod.Compile === "function" ? (mod.Compile as CompileJsonSchema) : undefined;
}

async function importCompile(): Promise<CompileJsonSchema> {
	const failures: string[] = [];
	try {
		const mod = (await import("typebox/compile")) as { Compile?: unknown };
		if (typeof mod.Compile === "function") return mod.Compile as CompileJsonSchema;
		failures.push("typebox/compile did not export a Compile function");
	} catch (error) {
		failures.push(`direct import failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const packageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	if (packageRoot) {
		try {
			const compile = await resolveCompileFromPackageRoot(packageRoot);
			if (compile) return compile;
			failures.push("Pi package root typebox/compile did not export a Compile function");
		} catch (error) {
			failures.push(`Pi package root import failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		failures.push(`${PI_CODING_AGENT_PACKAGE_ROOT_ENV} is not set`);
	}
	throw new Error(`Cannot load typebox/compile for structured output validation (${failures.join("; ")})`);
}

function loadCompile(): Promise<CompileJsonSchema> {
	if (!cachedCompile) {
		cachedCompile = importCompile().catch((error) => {
			cachedCompile = undefined;
			throw error;
		});
	}
	return cachedCompile;
}

export function assertJsonSchemaObject(schema: unknown, label = "outputSchema"): asserts schema is JsonSchemaObject {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		throw new Error(`${label} must be a JSON Schema object.`);
	}
}

export function validateStructuredOutputSchema(schema: unknown, label = "outputSchema"): { status: "valid" } | { status: "invalid"; message: string } {
	try {
		assertJsonSchemaObject(schema, label);
		validateJsonValue(schema, label, new WeakSet());
		validateJsonSchemaKeywords(schema, label);
		return { status: "valid" };
	} catch (error) {
		return { status: "invalid", message: `invalid ${label}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

const JSON_SCHEMA_TYPES = new Set(["null", "boolean", "object", "array", "number", "string", "integer"]);

function validateJsonValue(value: unknown, pathLabel: string, ancestors: WeakSet<object>): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${pathLabel} must contain only finite JSON numbers.`);
		return;
	}
	if (!value || typeof value !== "object") throw new Error(`${pathLabel} must contain only JSON values.`);
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		throw new Error(`${pathLabel} must contain only plain JSON objects.`);
	}
	if (ancestors.has(value)) throw new Error(`${pathLabel} must not contain circular references.`);
	ancestors.add(value);
	if (Array.isArray(value)) {
		value.forEach((entry, index) => validateJsonValue(entry, `${pathLabel}[${index}]`, ancestors));
	} else {
		for (const [key, entry] of Object.entries(value)) validateJsonValue(entry, `${pathLabel}.${key}`, ancestors);
	}
	ancestors.delete(value);
}

function validateStringArray(value: unknown, pathLabel: string): void {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string") || new Set(value).size !== value.length) {
		throw new Error(`${pathLabel} must be an array of unique strings.`);
	}
}

function validateJsonSchemaKeywordShapes(value: Record<string, unknown>, pathLabel: string): void {
	for (const keyword of ["$id", "$schema", "$ref", "$anchor", "$dynamicRef", "$dynamicAnchor", "$comment", "title", "description", "format", "pattern", "contentEncoding", "contentMediaType"] as const) {
		if (value[keyword] !== undefined && typeof value[keyword] !== "string") throw new Error(`${pathLabel}.${keyword} must be a string.`);
	}
	if (typeof value.pattern === "string") {
		try {
			new RegExp(value.pattern, "u");
		} catch {
			throw new Error(`${pathLabel}.pattern must be a valid regular expression.`);
		}
	}
	for (const keyword of ["deprecated", "readOnly", "writeOnly", "uniqueItems"] as const) {
		if (value[keyword] !== undefined && typeof value[keyword] !== "boolean") throw new Error(`${pathLabel}.${keyword} must be a boolean.`);
	}
	for (const keyword of ["minLength", "maxLength", "minItems", "maxItems", "minContains", "maxContains", "minProperties", "maxProperties"] as const) {
		const entry = value[keyword];
		if (entry !== undefined && (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0)) throw new Error(`${pathLabel}.${keyword} must be a non-negative integer.`);
	}
	for (const keyword of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
		const entry = value[keyword];
		if (entry !== undefined && (typeof entry !== "number" || !Number.isFinite(entry))) throw new Error(`${pathLabel}.${keyword} must be a finite number.`);
	}
	if (value.multipleOf !== undefined && (typeof value.multipleOf !== "number" || !Number.isFinite(value.multipleOf) || value.multipleOf <= 0)) {
		throw new Error(`${pathLabel}.multipleOf must be a finite number greater than zero.`);
	}
	const enumValues = value.enum;
	if (enumValues !== undefined && (!Array.isArray(enumValues) || enumValues.length === 0)) {
		throw new Error(`${pathLabel}.enum must be a non-empty array.`);
	}
	if (Array.isArray(enumValues) && enumValues.some((entry, index) => enumValues.slice(0, index).some((prior) => isDeepStrictEqual(prior, entry)))) {
		throw new Error(`${pathLabel}.enum values must be unique.`);
	}
	if (value.required !== undefined) validateStringArray(value.required, `${pathLabel}.required`);
	if (value.examples !== undefined && !Array.isArray(value.examples)) throw new Error(`${pathLabel}.examples must be an array.`);
	if (value.$vocabulary !== undefined) {
		if (!value.$vocabulary || typeof value.$vocabulary !== "object" || Array.isArray(value.$vocabulary)
			|| !Object.values(value.$vocabulary).every((entry) => typeof entry === "boolean")) {
			throw new Error(`${pathLabel}.$vocabulary must be an object of boolean values.`);
		}
	}
	if (value.dependentRequired !== undefined) {
		if (!value.dependentRequired || typeof value.dependentRequired !== "object" || Array.isArray(value.dependentRequired)) {
			throw new Error(`${pathLabel}.dependentRequired must be an object of string arrays.`);
		}
		for (const [name, entry] of Object.entries(value.dependentRequired)) validateStringArray(entry, `${pathLabel}.dependentRequired.${name}`);
	}
}

function validateJsonSchemaKeywords(schema: unknown, pathLabel: string): void {
	if (typeof schema === "boolean") return;
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		throw new Error(`${pathLabel} must be a JSON Schema object or boolean.`);
	}
	const value = schema as Record<string, unknown>;
	validateJsonSchemaKeywordShapes(value, pathLabel);
	if (Object.hasOwn(value, "type")) {
		const types = typeof value.type === "string" ? [value.type] : value.type;
		if (!Array.isArray(types) || types.length === 0 || new Set(types).size !== types.length || !types.every((entry) => typeof entry === "string" && JSON_SCHEMA_TYPES.has(entry))) {
			throw new Error(`${pathLabel}.type must be a JSON Schema type or non-empty array of JSON Schema types.`);
		}
	}
	for (const keyword of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const) {
		const entries = value[keyword];
		if (entries === undefined) continue;
		if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
			throw new Error(`${pathLabel}.${keyword} must be an object of schemas.`);
		}
		for (const [name, nested] of Object.entries(entries)) {
			if (keyword === "patternProperties") {
				try {
					new RegExp(name, "u");
				} catch {
					throw new Error(`${pathLabel}.patternProperties key ${JSON.stringify(name)} must be a valid regular expression.`);
				}
			}
			validateJsonSchemaKeywords(nested, `${pathLabel}.${keyword}.${name}`);
		}
	}
	for (const keyword of ["items", "additionalItems", "additionalProperties", "contains", "not", "propertyNames", "if", "then", "else", "unevaluatedItems", "unevaluatedProperties"] as const) {
		const nested = value[keyword];
		if (nested === undefined) continue;
		if (keyword === "items" && Array.isArray(nested)) {
			nested.forEach((entry, index) => validateJsonSchemaKeywords(entry, `${pathLabel}.items[${index}]`));
			continue;
		}
		validateJsonSchemaKeywords(nested, `${pathLabel}.${keyword}`);
	}
	if (value.contentSchema !== undefined) validateJsonSchemaKeywords(value.contentSchema, `${pathLabel}.contentSchema`);
	if (value.dependencies !== undefined) {
		if (!value.dependencies || typeof value.dependencies !== "object" || Array.isArray(value.dependencies)) {
			throw new Error(`${pathLabel}.dependencies must be an object of schemas or string arrays.`);
		}
		for (const [name, entry] of Object.entries(value.dependencies)) {
			if (Array.isArray(entry)) validateStringArray(entry, `${pathLabel}.dependencies.${name}`);
			else validateJsonSchemaKeywords(entry, `${pathLabel}.dependencies.${name}`);
		}
	}
	for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
		const nested = value[keyword];
		if (nested === undefined) continue;
		if (!Array.isArray(nested) || nested.length === 0) throw new Error(`${pathLabel}.${keyword} must be a non-empty array of schemas.`);
		nested.forEach((entry, index) => validateJsonSchemaKeywords(entry, `${pathLabel}.${keyword}[${index}]`));
	}
	if (value.prefixItems !== undefined) {
		if (!Array.isArray(value.prefixItems)) throw new Error(`${pathLabel}.prefixItems must be an array of schemas.`);
		value.prefixItems.forEach((entry, index) => validateJsonSchemaKeywords(entry, `${pathLabel}.prefixItems[${index}]`));
	}
}

export function createStructuredOutputRuntime(schema: JsonSchemaObject, baseDir?: string): StructuredOutputRuntime {
	assertJsonSchemaObject(schema);
	const rootDir = baseDir ?? os.tmpdir();
	fs.mkdirSync(rootDir, { recursive: true });
	const dir = fs.mkdtempSync(path.join(rootDir, "pi-subagent-structured-"));
	const schemaPath = path.join(dir, "schema.json");
	const outputPath = path.join(dir, "output.json");
	fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
	return { schema, schemaPath, outputPath };
}

export async function validateStructuredOutputValue(schema: JsonSchemaObject, value: unknown): Promise<{ status: "valid" } | { status: "invalid"; message: string }> {
	const compile = await loadCompile();
	let validator: CompiledJsonSchema;
	try {
		validator = compile(schema);
	} catch (error) {
		return { status: "invalid", message: `invalid outputSchema: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (validator.Check(value)) return { status: "valid" };
	const errors = [...validator.Errors(value)]
		.slice(0, 8)
		.map((error) => {
			const pathText = error.instancePath ? error.instancePath.replace(/^\//, "").replace(/\//g, ".") : "root";
			return `${pathText}: ${error.message}`;
		});
	return { status: "invalid", message: errors.join("; ") || "schema validation failed" };
}

export async function readStructuredOutput(runtime: StructuredOutputRuntime): Promise<{ value?: unknown; error?: string }> {
	if (!fs.existsSync(runtime.outputPath)) {
		return { error: "Missing structured_output call; this step has outputSchema and must finish by calling structured_output." };
	}
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(runtime.outputPath, "utf-8"));
	} catch (error) {
		return { error: `Failed to read structured output: ${error instanceof Error ? error.message : String(error)}` };
	}
	try {
		const validation = await validateStructuredOutputValue(runtime.schema, value);
		if (validation.status === "invalid") return { error: `Structured output validation failed: ${validation.message}` };
	} catch (error) {
		return { error: `Failed to validate structured output: ${error instanceof Error ? error.message : String(error)}` };
	}
	return { value };
}

export function cleanupStructuredOutputRuntime(runtime: StructuredOutputRuntime | undefined): void {
	if (!runtime) return;
	try {
		fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
	} catch {
		// Best-effort temp cleanup.
	}
}
