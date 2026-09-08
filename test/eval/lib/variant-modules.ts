/**
 * Variant module loading for the paired catalog evaluation.
 *
 * Each variant is loaded from its own root using that root's actual published
 * tool description, parameter schema, parser, help renderer, and production
 * workflow sandbox. Roots and the production Pi SDK entry are always
 * caller-supplied; nothing here is portable to a hardcoded machine path, and
 * missing files or exports fail with an explicit message. Parser output is
 * decoded into the harness's named canonical view at this boundary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { decodeCanonicalParams } from "./decode.ts";
import { renderGenericGuideTopics } from "./fake-runtime.ts";
import type { WorkflowSandbox } from "./fake-runtime.ts";
import type {
  CanonicalizeResult,
  FakeToolResult,
  PublishedToolDefinition,
  VariantCanonicalize,
  VariantCall,
} from "./eval-types.ts";
import type { JsonRecord } from "./json-value.ts";

/** Opaque result of the catalog parser before canonical adaptation. */
interface ParsedCallHandle {
  ok: boolean;
  error?: string;
  request?: { kind?: string; params?: JsonRecord; topic?: string };
}

/** Opaque result of the baseline normalizer before canonical adaptation. */
interface NormalizedCallHandle {
  ok: boolean;
  error?: string;
  params?: JsonRecord;
}

interface WorkflowValidatorResult {
  ok: boolean;
  errors?: Array<{ message: string; line?: number }>;
}

/** Fully loaded model-facing variant adapted to the evaluator's canonical request seam. */
export interface LoadedVariant {
  kind: "catalog" | "baseline";
  root: string;
  description: string;
  descriptionKind: string;
  publishedDefinition: PublishedToolDefinition;
  canonicalize: VariantCanonicalize;
  renderHelp: (topic?: string) => FakeToolResult;
  runWorkflowScript: WorkflowSandbox;
  validateWorkflowScript: (script: string) => WorkflowValidatorResult;
}

const CATALOG_VARIANT_FILES: readonly string[] = [
  "src/extension/schemas.ts",
  "src/extension/tool-description.ts",
  "src/extension/subagent-command-catalog.ts",
  "src/workflows/scripted-workflow.ts",
];

const BASELINE_VARIANT_FILES: readonly string[] = [
  "src/extension/schemas.ts",
  "src/extension/tool-description.ts",
  "src/extension/public-execution.ts",
  "src/workflows/scripted-workflow.ts",
];

/** Source checkout dialect selected for one side of a paired comparison. */
export type VariantKind = "catalog" | "baseline";

/** Required source files for a variant root, used for clear startup failures. */
export function requiredVariantFiles(kind: VariantKind): readonly string[] {
  return kind === "catalog" ? CATALOG_VARIANT_FILES : BASELINE_VARIANT_FILES;
}

/** Validate a variant root, returning an explicit error listing what is missing. */
export function variantRootError(root: string, kind: VariantKind): string | null {
  const missing = requiredVariantFiles(kind)
    .map((relative) => path.join(root, relative))
    .filter((absolute) => !fs.existsSync(absolute));
  if (missing.length === 0) {
    return null;
  }
  return [
    `Variant root '${root}' does not look like a ${kind} pi-subagents checkout.`,
    `Missing required files: ${missing.join(", ")}.`,
    "Pass --candidate-root / --baseline-root (or CATALOG_EVAL_CANDIDATE_ROOT / CATALOG_EVAL_BASELINE_ROOT) pointing at the matching worktree.",
  ].join("\n");
}

/**
 * Resolve the production Pi SDK entry. Accepts a package root (its
 * dist/index.js is used) or the distribution file itself, and fails loudly
 * when the entry is absent so no shim can be silently substituted.
 */
export function resolveSdkEntry(rawEntry: string): string {
  const entry = path.resolve(rawEntry);
  let candidate = entry;
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    candidate = path.join(candidate, "dist", "index.js");
  }
  if (!fs.existsSync(candidate)) {
    return "";
  }
  return candidate;
}

/**
 * Import one module from a variant root and return a single named export.
 * The export is presence-checked here; the caller states the export's named
 * contract at the call site, and parser output is decoded before any use.
 */
async function requireVariantExport<ExportType>(
  root: string,
  relative: string,
  name: string,
): Promise<ExportType> {
  const moduleUrl = pathToFileURL(path.join(root, relative)).href;
  const loaded = await import(moduleUrl);
  const value = loaded[name];
  if (value === undefined) {
    throw new Error(`Variant module '${relative}' does not export '${name}'.`);
  }
  return value;
}

/** Adapt a parser/normalizer handle into the harness's decoded canonical view. */
function adaptParsedHandle(parsed: ParsedCallHandle): CanonicalizeResult {
  if (!parsed.ok || parsed.request === undefined) {
    return { ok: false, error: parsed.error ?? "variant parser rejected the call" };
  }
  const request = parsed.request;
  if (request.kind === "help") {
    return { ok: true, request: { kind: "help", topic: request.topic } };
  }
  const params = decodeCanonicalParams(request.params ?? {});
  if (params === null) {
    return { ok: false, error: "canonical params failed the evaluation boundary decoder" };
  }
  if (request.kind === "management") {
    return { ok: true, request: { kind: "management", params } };
  }
  return { ok: true, request: { kind: "execute", params } };
}

/** Load the candidate catalog from caller-supplied source without fallback to installed code. */
export async function loadCatalogVariant(root: string): Promise<LoadedVariant> {
  const error = variantRootError(root, "catalog");
  if (error !== null) {
    throw new Error(error);
  }
  const createSchema = await requireVariantExport<() => JsonRecord>(
    root,
    "src/extension/schemas.ts",
    "createSubagentCatalogParamsSchema",
  );
  const description = await requireVariantExport<string>(
    root,
    "src/extension/tool-description.ts",
    "SUBAGENT_COMMAND_TOOL_DESCRIPTION",
  );
  const parseCall = await requireVariantExport<(call: VariantCall) => ParsedCallHandle>(
    root,
    "src/extension/subagent-command-catalog.ts",
    "parseSubagentCatalogCall",
  );
  const renderTopic = await requireVariantExport<(topic?: string) => FakeToolResult>(
    root,
    "src/extension/subagent-command-catalog.ts",
    "renderSubagentCatalogHelp",
  );
  const runScript = await requireVariantExport<WorkflowSandbox>(
    root,
    "src/workflows/scripted-workflow.ts",
    "runWorkflowScript",
  );
  const validateScript = await requireVariantExport<(script: string) => WorkflowValidatorResult>(
    root,
    "src/workflows/scripted-workflow.ts",
    "validateWorkflowScript",
  );
  return {
    kind: "catalog",
    root,
    description,
    descriptionKind: "compact catalog envelope",
    publishedDefinition: { name: "subagent", description, parameters: createSchema() },
    canonicalize: (call) => adaptParsedHandle(parseCall(call)),
    renderHelp: (topic) => renderTopic(topic),
    runWorkflowScript: runScript,
    validateWorkflowScript: validateScript,
  };
}

/** Load the incumbent flat schema and compact description from its pinned source root. */
export async function loadBaselineVariant(root: string): Promise<LoadedVariant> {
  const error = variantRootError(root, "baseline");
  if (error !== null) {
    throw new Error(error);
  }
  const createSchema = await requireVariantExport<() => JsonRecord>(
    root,
    "src/extension/schemas.ts",
    "createSubagentParamsSchema",
  );
  const description = await requireVariantExport<string>(
    root,
    "src/extension/tool-description.ts",
    "COMPACT_SUBAGENT_TOOL_DESCRIPTION",
  );
  const normalize = await requireVariantExport<(params: VariantCall) => NormalizedCallHandle>(
    root,
    "src/extension/public-execution.ts",
    "normalizePublicSubagentExecution",
  );
  const runScript = await requireVariantExport<WorkflowSandbox>(
    root,
    "src/workflows/scripted-workflow.ts",
    "runWorkflowScript",
  );
  const validateScript = await requireVariantExport<(script: string) => WorkflowValidatorResult>(
    root,
    "src/workflows/scripted-workflow.ts",
    "validateWorkflowScript",
  );
  const canonicalize: VariantCanonicalize = (call) => {
    const normalized = normalize(call);
    if (!normalized.ok) {
      return { ok: false, error: normalized.error ?? "baseline normalization rejected the call" };
    }
    const params = decodeCanonicalParams(normalized.params ?? {});
    if (params === null) {
      return { ok: false, error: "canonical params failed the evaluation boundary decoder" };
    }
    return {
      ok: true,
      request:
        params.action === undefined ? { kind: "execute", params } : { kind: "management", params },
    };
  };
  return {
    kind: "baseline",
    root,
    description,
    descriptionKind: "compact flat baseline",
    publishedDefinition: { name: "subagent", description, parameters: createSchema() },
    canonicalize,
    renderHelp: () => renderGenericGuideTopics(),
    runWorkflowScript: runScript,
    validateWorkflowScript: validateScript,
  };
}
