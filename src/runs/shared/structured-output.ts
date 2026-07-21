import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
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
		validateJsonSchemaTypeKeywords(schema, label);
		return { status: "valid" };
	} catch (error) {
		return { status: "invalid", message: `invalid ${label}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

const JSON_SCHEMA_TYPES = new Set(["null", "boolean", "object", "array", "number", "string", "integer"]);

function validateJsonSchemaTypeKeywords(schema: unknown, pathLabel: string): void {
	if (typeof schema === "boolean") return;
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		throw new Error(`${pathLabel} must be a JSON Schema object or boolean.`);
	}
	const value = schema as Record<string, unknown>;
	if (Object.hasOwn(value, "type")) {
		const types = typeof value.type === "string" ? [value.type] : value.type;
		if (!Array.isArray(types) || types.length === 0 || !types.every((entry) => typeof entry === "string" && JSON_SCHEMA_TYPES.has(entry))) {
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
			validateJsonSchemaTypeKeywords(nested, `${pathLabel}.${keyword}.${name}`);
		}
	}
	for (const keyword of ["items", "additionalItems", "additionalProperties", "contains", "not", "propertyNames", "if", "then", "else", "unevaluatedItems", "unevaluatedProperties"] as const) {
		const nested = value[keyword];
		if (nested === undefined) continue;
		if (keyword === "items" && Array.isArray(nested)) {
			nested.forEach((entry, index) => validateJsonSchemaTypeKeywords(entry, `${pathLabel}.items[${index}]`));
			continue;
		}
		validateJsonSchemaTypeKeywords(nested, `${pathLabel}.${keyword}`);
	}
	for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
		const nested = value[keyword];
		if (nested === undefined) continue;
		if (!Array.isArray(nested) || nested.length === 0) throw new Error(`${pathLabel}.${keyword} must be a non-empty array of schemas.`);
		nested.forEach((entry, index) => validateJsonSchemaTypeKeywords(entry, `${pathLabel}.${keyword}[${index}]`));
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
