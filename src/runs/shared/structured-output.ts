import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";
import type { JsonSchemaObject } from "../../shared/types.ts";
import type { ResolvedAcceptanceReportMode } from "./acceptance.ts";

export const MISSING_STRUCTURED_OUTPUT_CALL_ERROR = "Missing structured_output call; this step has outputSchema and must finish by calling structured_output.";
export const MISSING_STRUCTURED_ACCEPTANCE_REPORT_ERROR = "Missing acceptanceReport in structured_output call; acceptance.report is \"on\".";
export const STRUCTURED_OUTPUT_REJECTION_ERROR = "structured_output was invoked but no valid output was captured.";
export const INVALID_STRUCTURED_OUTPUT_SCHEMA_ERROR = "Structured output invocation was rejected: invalid outputSchema.";
export const STRUCTURED_OUTPUT_VALIDATOR_UNAVAILABLE_ERROR = "Structured output invocation was rejected: validator unavailable.";
export const MAX_STRUCTURED_OUTPUT_REJECTION_ERROR_BYTES = 4096;

function utf8Prefix(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const suffix = "...";
	const contentLimit = maxBytes - Buffer.byteLength(suffix, "utf8");
	let bytes = 0;
	let result = "";
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > contentLimit) break;
		result += character;
		bytes += characterBytes;
	}
	return result + suffix;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

function sanitizeStructuredOutputRejection(text: string): string {
	const withoutControls = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
	if (/invalid outputSchema(?:\s*:|$)/i.test(withoutControls)) return INVALID_STRUCTURED_OUTPUT_SCHEMA_ERROR;
	if (/failed to validate structured output:|cannot load typebox\/compile/i.test(withoutControls)) return STRUCTURED_OUTPUT_VALIDATOR_UNAVAILABLE_ERROR;
	const validationMarker = "Structured output validation failed:";
	const markerIndex = withoutControls.indexOf(validationMarker);
	const diagnostic = markerIndex >= 0 ? withoutControls.slice(markerIndex) : withoutControls;
	const lines = diagnostic.split(/\r?\n/).filter((line) => {
		const trimmed = line.trim();
		return trimmed.length > 0
			&& !/^at\s/.test(trimmed)
			&& !/^(?:arguments?|parameters?|submitted value|input|outputSchema|schema|stack)\s*:/i.test(trimmed);
	});
	const sanitized = lines.join("\n")
		.replace(/\b(received|actual|got)(?:\s+value)?\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\{[^\n]*\}|\[[^\n]*\]|\S+)/gi, "$1: [redacted]")
		.trim();
	return sanitized || STRUCTURED_OUTPUT_REJECTION_ERROR;
}

/** Returns bounded evidence from the latest failed structured_output result in a terminal transcript. */
export function formatStructuredOutputRejectionError(messages: readonly Message[]): string {
	const toolCallIds = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			const call = part as { type?: unknown; id?: unknown; name?: unknown };
			if (call.type === "toolCall" && call.name === "structured_output" && typeof call.id === "string") toolCallIds.add(call.id);
		}
	}
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as Message & { toolCallId?: unknown; toolName?: unknown; isError?: unknown };
		if (message.role !== "toolResult" || message.isError !== true) continue;
		const matchingName = message.toolName === "structured_output";
		const matchingId = typeof message.toolCallId === "string" && toolCallIds.has(message.toolCallId);
		if (!matchingName && !matchingId) continue;
		return utf8Prefix(sanitizeStructuredOutputRejection(messageText(message.content)), MAX_STRUCTURED_OUTPUT_REJECTION_ERROR_BYTES);
	}
	return STRUCTURED_OUTPUT_REJECTION_ERROR;
}

export interface StructuredOutputRuntime {
	schema: JsonSchemaObject;
	schemaPath: string;
	outputPath: string;
	acceptanceReportPath?: string;
	acceptanceReportRequired?: boolean;
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

export function createStructuredOutputToolParameters(schema: JsonSchemaObject, options: { acceptanceReport?: "optional" | "required" } = {}): JsonSchemaObject {
	return {
		type: "object",
		properties: {
			value: rewriteLocalJsonPointerRefs(schema, "#/properties/value"),
			...(options.acceptanceReport ? { acceptanceReport: { type: "object" } } : {}),
		},
		required: ["value", ...(options.acceptanceReport === "required" ? ["acceptanceReport"] : [])],
		additionalProperties: false,
	};
}

interface CompiledJsonSchema {
	Check(value: unknown): boolean;
	Errors(value: unknown): Iterable<JsonSchemaValidationError>;
}

interface JsonSchemaValidationError {
	keyword?: string;
	schemaPath?: string;
	instancePath?: string;
	params?: { failingKeyword?: string; requiredProperties?: string[] };
	message?: string;
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

function jsonPointerTarget(root: unknown, pointer: string): unknown {
	if (pointer === "#") return root;
	if (!pointer.startsWith("#/")) return undefined;
	let current = root;
	for (const encoded of pointer.slice(2).split("/")) {
		if (!current || typeof current !== "object") return undefined;
		const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function resolveLocalRefs(root: unknown, node: unknown): Record<string, unknown> | undefined {
	const seen = new Set<unknown>();
	while (node && typeof node === "object" && !Array.isArray(node) && !seen.has(node)) {
		seen.add(node);
		const record = node as Record<string, unknown>;
		if (typeof record.$ref !== "string" || !record.$ref.startsWith("#")) return record;
		node = jsonPointerTarget(root, record.$ref);
	}
	return undefined;
}

type InstanceSchemaStep = { kind: "property"; key: string } | { kind: "index"; index: number };

function traverseInstanceSchema(root: unknown, instancePath: string | undefined): { node: Record<string, unknown>; steps: InstanceSchemaStep[] } | undefined {
	let node = resolveLocalRefs(root, root);
	const steps: InstanceSchemaStep[] = [];
	for (const encoded of instancePath?.replace(/^\//, "").split("/") ?? []) {
		if (!encoded || !node) continue;
		const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
		const properties = node.properties;
		if (properties && typeof properties === "object" && !Array.isArray(properties) && key in properties) {
			steps.push({ kind: "property", key });
			node = resolveLocalRefs(root, (properties as Record<string, unknown>)[key]);
			continue;
		}
		if (/^(0|[1-9]\d*)$/.test(key)) {
			const index = Number(key);
			const prefixItems = node.prefixItems;
			const itemSchema = Array.isArray(prefixItems) && index < prefixItems.length ? prefixItems[index] : node.items;
			if (itemSchema !== undefined) {
				steps.push({ kind: "index", index });
				node = resolveLocalRefs(root, itemSchema);
				continue;
			}
		}
		return undefined;
	}
	return node ? { node, steps } : undefined;
}

function conditionalTarget(root: unknown, schemaPath: string, instancePath: string | undefined): { node: Record<string, unknown>; steps: InstanceSchemaStep[] } | undefined {
	const traversed = traverseInstanceSchema(root, instancePath);
	if (!traversed) return undefined;
	let pointer = schemaPath;
	const seen = new Set<string>();
	while (!seen.has(pointer)) {
		seen.add(pointer);
		const record = resolveLocalRefs(root, jsonPointerTarget(root, pointer));
		if (!record) break;
		if (record.if !== undefined) return { node: record, steps: traversed.steps };
		if (typeof record.$ref !== "string" || !record.$ref.startsWith("#")) break;
		pointer = record.$ref;
	}
	if (traversed.node.if !== undefined) return traversed;
	return undefined;
}

function errorKey(error: JsonSchemaValidationError): string {
	return JSON.stringify([error.keyword, error.instancePath, error.params, error.message]);
}

function branchDiagnosticSchema(schema: JsonSchemaObject, steps: InstanceSchemaStep[], branch: unknown): JsonSchemaObject {
	const diagnostic: Record<string, unknown> = {};
	for (const keyword of ["$schema", "$id", "$defs", "definitions"] as const) {
		if (schema[keyword] !== undefined) diagnostic[keyword] = schema[keyword];
	}
	let target = diagnostic;
	for (const step of steps) {
		if (step.kind === "index") {
			const index = step.index;
			const prefixItems = Array.from({ length: index + 1 }, () => true as unknown);
			const nested: Record<string, unknown> = {};
			prefixItems[index] = nested;
			target.prefixItems = prefixItems;
			target.items = true;
			target = nested;
		} else {
			const nested: Record<string, unknown> = {};
			target.properties = { [step.key]: nested };
			target = nested;
		}
	}
	target.allOf = [branch];
	return diagnostic as JsonSchemaObject;
}

function expandConditionalError(compile: CompileJsonSchema, schema: JsonSchemaObject, value: unknown, error: JsonSchemaValidationError): { schema: JsonSchemaObject; errors: JsonSchemaValidationError[] } | undefined {
	const branch = error.params?.failingKeyword;
	if (error.keyword !== "if" || (branch !== "then" && branch !== "else") || !error.schemaPath) return undefined;
	try {
		const target = conditionalTarget(schema, error.schemaPath, error.instancePath);
		if (!target || target.node[branch] === undefined) return undefined;
		const expandedSchema = branchDiagnosticSchema(schema, target.steps, target.node[branch]);
		const expandedErrors = [...compile(expandedSchema).Errors(value)];
		if (expandedErrors.length === 0) return undefined;
		return { schema: expandedSchema, errors: expandedErrors };
	} catch {
		return undefined;
	}
}

function formatValidationError(error: JsonSchemaValidationError): string[] {
	const pathText = error.instancePath ? error.instancePath.replace(/^\//, "").replace(/\//g, ".") : "root";
	if (error.keyword === "required" && error.params?.requiredProperties?.length) {
		return error.params.requiredProperties.map((property) => `${pathText === "root" ? property : `${pathText}.${property}`}: is required`);
	}
	return [`${pathText}: ${error.message}`];
}

function expandedErrorMessages(compile: CompileJsonSchema, schema: JsonSchemaObject, value: unknown, error: JsonSchemaValidationError, limit: number, seen: Set<string>): string[] {
	if (limit <= 0) return [];
	const state = `${errorKey(error)}\0${JSON.stringify(schema)}`;
	if (seen.has(state)) return formatValidationError(error).slice(0, limit);
	seen.add(state);
	const expanded = expandConditionalError(compile, schema, value, error);
	if (!expanded) return formatValidationError(error).slice(0, limit);
	const messages: string[] = [];
	for (const candidate of expanded.errors) {
		messages.push(...expandedErrorMessages(compile, expanded.schema, value, candidate, limit - messages.length, seen));
		if (messages.length >= limit) break;
	}
	return messages;
}

export function assertJsonSchemaObject(schema: unknown, label = "outputSchema"): asserts schema is JsonSchemaObject {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		throw new Error(`${label} must be a JSON Schema object.`);
	}
}

export function createStructuredOutputRuntime(schema: JsonSchemaObject, baseDir?: string, options: { acceptanceReport?: ResolvedAcceptanceReportMode } = {}): StructuredOutputRuntime {
	assertJsonSchemaObject(schema);
	const rootDir = baseDir ?? os.tmpdir();
	fs.mkdirSync(rootDir, { recursive: true });
	const dir = fs.mkdtempSync(path.join(rootDir, "pi-subagent-structured-"));
	const schemaPath = path.join(dir, "schema.json");
	const outputPath = path.join(dir, "output.json");
	fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
	return {
		schema,
		schemaPath,
		outputPath,
		...(options.acceptanceReport && options.acceptanceReport !== "off"
			? { acceptanceReportPath: path.join(dir, "acceptance-report.json"), acceptanceReportRequired: options.acceptanceReport === "required" }
			: {}),
	};
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
	const originalErrors = [...validator.Errors(value)];
	const errors: string[] = [];
	const uniqueErrors = new Set<string>();
	const seen = new Set<string>();
	for (const error of originalErrors) {
		for (const message of expandedErrorMessages(compile, schema, value, error, 8 - errors.length, seen)) {
			if (!uniqueErrors.has(message)) {
				uniqueErrors.add(message);
				errors.push(message);
			}
		}
		if (errors.length >= 8) break;
	}
	return { status: "invalid", message: errors.join("; ") || "schema validation failed" };
}

export async function readStructuredOutput(runtime: StructuredOutputRuntime): Promise<{ value?: unknown; error?: string }> {
	if (!fs.existsSync(runtime.outputPath)) {
		return { error: MISSING_STRUCTURED_OUTPUT_CALL_ERROR };
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

export function readStructuredOutputAcceptanceReport(runtime: StructuredOutputRuntime): { value?: unknown; error?: string } {
	if (!runtime.acceptanceReportPath) return {};
	if (!fs.existsSync(runtime.acceptanceReportPath)) {
		return runtime.acceptanceReportRequired ? { error: MISSING_STRUCTURED_ACCEPTANCE_REPORT_ERROR } : {};
	}
	try {
		return { value: JSON.parse(fs.readFileSync(runtime.acceptanceReportPath, "utf-8")) as unknown };
	} catch (error) {
		return { error: `Failed to read structured output acceptance report: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * Capture callback that persists the structured output (and acceptance report)
 * to the runtime's files, for hosts that read the value back from disk.
 */
export function createStructuredOutputFileCapture(runtime: StructuredOutputRuntime): (value: unknown, acceptanceReport: unknown | undefined) => void {
	return (value, acceptanceReport) => {
		fs.mkdirSync(path.dirname(runtime.outputPath), { recursive: true });
		if (runtime.acceptanceReportPath && acceptanceReport !== undefined) {
			fs.mkdirSync(path.dirname(runtime.acceptanceReportPath), { recursive: true });
			fs.writeFileSync(runtime.acceptanceReportPath, JSON.stringify(acceptanceReport), { mode: 0o600 });
		} else if (runtime.acceptanceReportPath && fs.existsSync(runtime.acceptanceReportPath)) {
			fs.unlinkSync(runtime.acceptanceReportPath);
		}
		fs.writeFileSync(runtime.outputPath, JSON.stringify(value), { mode: 0o600 });
	};
}

export function clearStructuredOutputCaptures(runtime: StructuredOutputRuntime): string | undefined {
	let cleanupError: string | undefined;
	for (const filePath of [runtime.outputPath, runtime.acceptanceReportPath]) {
		if (!filePath) continue;
		try {
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		} catch (error) {
			cleanupError ??= `Failed to clear stale structured output capture ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	return cleanupError;
}

export function cleanupStructuredOutputRuntime(runtime: StructuredOutputRuntime | undefined): void {
	if (!runtime) return;
	try {
		fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
	} catch {
		// Best-effort temp cleanup.
	}
}
