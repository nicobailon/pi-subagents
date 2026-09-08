/**
 * Boundary decoders for the paired catalog evaluation.
 *
 * Untrusted values (fixture JSON documents, variant parser output, model tool
 * calls) are decoded here through real TypeBox validators before the rest of
 * the harness touches them. Named-field views are verified where the harness
 * branches on them; object interiors that the variant parser already validated
 * (for example workflow args) are carried as named JSON records.
 */

import { Compile } from "typebox/compile";
import { Type } from "typebox";

import type {
  CanonicalParamsView,
  ChildResponseSpec,
  DiscoveryAgentRow,
  EvalSuiteDocument,
  JsonRecord,
  OutputSchemaView,
} from "./eval-types.ts";
import type { JsonValue } from "./json-value.ts";

const JsonObject = Type.Unsafe<JsonRecord>({ type: "object" });

const OutputSchemaField = Type.Object(
  {
    required: Type.Optional(Type.Array(Type.String())),
    properties: Type.Optional(JsonObject),
  },
  { additionalProperties: true },
);

const OutputPropertySchema = Type.Object(
  {
    type: Type.Optional(Type.String()),
    enum: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);

const outputPropertyCodec = Compile(OutputPropertySchema);

/** Decode one structured-output property declaration; null when absent or malformed. */
export function decodeOutputProperty(value: JsonValue): { type?: string; enum?: string[] } | null {
  if (!outputPropertyCodec.Check(value)) {
    return null;
  }
  return outputPropertyCodec.Decode(value);
}

const CanonicalParamsSchema = Type.Object(
  {
    action: Type.Optional(Type.String()),
    agent: Type.Optional(Type.String()),
    task: Type.Optional(Type.String()),
    topic: Type.Optional(Type.String()),
    workflow: Type.Optional(Type.String()),
    args: Type.Optional(JsonObject),
    workflowScript: Type.Optional(Type.String()),
    workflowScriptPath: Type.Optional(Type.String()),
    resume: Type.Optional(Type.String()),
    async: Type.Optional(Type.Boolean()),
    capabilities: Type.Optional(Type.Boolean()),
    id: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    dir: Type.Optional(Type.String()),
    index: Type.Optional(Type.Integer()),
    lines: Type.Optional(Type.Integer()),
    view: Type.Optional(Type.String()),
    childId: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
    missionId: Type.Optional(Type.String()),
    at: Type.Optional(Type.String()),
    every: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    context: Type.Optional(Type.String()),
    worktree: Type.Optional(Type.Boolean()),
    isolation: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    outputSchema: Type.Optional(OutputSchemaField),
  },
  { additionalProperties: true },
);

const canonicalParamsCodec = Compile(CanonicalParamsSchema);

/**
 * Decode variant parser output into the named canonical view. Returns null
 * when a field the harness branches on has the wrong type; extra fields pass
 * through untyped, exactly as the variant parser produced them.
 */
export function decodeCanonicalParams(value: JsonValue): CanonicalParamsView | null {
  if (!canonicalParamsCodec.Check(value)) {
    return null;
  }
  return canonicalParamsCodec.Decode(value);
}

const DiscoveryAgentSchema = Type.Object(
  {
    name: Type.String(),
    executable: Type.Optional(Type.Boolean()),
    disabled: Type.Optional(Type.Boolean()),
    access: Type.Optional(Type.String()),
    runner: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const OutputContractSchema = Type.Object({
  required: Type.Array(Type.String()),
  fieldTypes: Type.Optional(Type.Record(Type.String(), Type.String())),
  enums: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
});

const ChildResponseSchema = Type.Object({
  when: Type.Object({
    agent: Type.Optional(Type.String()),
    taskMatches: Type.Optional(Type.String()),
  }),
  occurrence: Type.Optional(Type.Integer()),
  output: Type.String(),
  structuredOutput: Type.Optional(JsonObject),
  outputContract: Type.Optional(OutputContractSchema),
});

const FixtureSchema = Type.Object(
  {
    id: Type.String(),
    prompt: Type.String(),
    discoveryAgents: Type.Optional(Type.Array(DiscoveryAgentSchema)),
    childResponses: Type.Optional(Type.Array(ChildResponseSchema)),
    infrastructureFailure: Type.Optional(
      Type.Object({
        failureKind: Type.String(),
        message: Type.String(),
      }),
    ),
    retainedRows: Type.Optional(
      Type.Array(
        Type.Object({
          runId: Type.String(),
          agent: Type.String(),
          task: Type.String(),
          resumable: Type.Boolean(),
        }),
      ),
    ),
    resumeResults: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object({
          runId: Type.String(),
          status: Type.String(),
          output: Type.String(),
        }),
      ),
    ),
    models: Type.Optional(
      Type.Array(
        Type.Object({
          selector: Type.String(),
          label: Type.String(),
          costTier: Type.String(),
        }),
      ),
    ),
    statusResults: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object({
          runId: Type.String(),
          status: Type.String(),
          output: Type.String(),
          transcript: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    ),
    statusRuns: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object({
          runId: Type.String(),
          status: Type.String(),
          children: Type.Array(
            Type.Object({
              index: Type.Integer(),
              agent: Type.String(),
              transcript: Type.Array(Type.String()),
            }),
          ),
        }),
      ),
    ),
    steerResults: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object({
          runId: Type.String(),
          state: Type.String(),
          deliveryStatus: Type.Optional(Type.String()),
        }),
      ),
    ),
    stopResults: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object({
          runId: Type.String(),
          stopped: Type.Boolean(),
        }),
      ),
    ),
    stopRuns: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object({
          runId: Type.String(),
          runState: Type.String(),
          children: Type.Array(
            Type.Object({
              id: Type.String(),
              state: Type.String(),
            }),
          ),
        }),
      ),
    ),
    missionRows: Type.Optional(
      Type.Array(
        Type.Object({
          missionId: Type.String(),
          status: Type.String(),
          runs: Type.Array(Type.String()),
        }),
      ),
    ),
    namedWorkflow: Type.Optional(
      Type.Object({
        name: Type.String(),
        args: JsonObject,
        output: Type.String(),
      }),
    ),
    workflowScriptFiles: Type.Optional(Type.Record(Type.String(), Type.String())),
    scheduleCreateResult: Type.Optional(
      Type.Object({
        id: Type.String(),
        nextRunAt: Type.String(),
        status: Type.String(),
      }),
    ),
    policy: Type.Optional(
      Type.Object({
        allowNamedWorkflow: Type.Object({
          name: Type.String(),
          args: JsonObject,
        }),
      }),
    ),
    prohibitedKinds: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);

const SuiteDocumentSchema = Type.Object(
  {
    version: Type.Integer(),
    suite: Type.String(),
    status: Type.String(),
    sourceReport: Type.Optional(
      Type.Object({
        path: Type.String(),
        sha256: Type.String(),
        note: Type.Optional(Type.String()),
      }),
    ),
    discovery: Type.Object({ agents: Type.Array(DiscoveryAgentSchema) }),
    fixtures: Type.Array(FixtureSchema),
  },
  { additionalProperties: true },
);

const suiteDocumentCodec = Compile(SuiteDocumentSchema);

/** Decode a parsed suite JSON document; returns a listed error on mismatch. */
export function decodeSuiteDocument(
  value: JsonValue,
): { ok: true; document: EvalSuiteDocument } | { ok: false; error: string } {
  if (!suiteDocumentCodec.Check(value)) {
    const first = [...suiteDocumentCodec.Errors(value)][0];
    return {
      ok: false,
      error: `suite document failed schema validation: ${first?.message ?? "invalid input"}`,
    };
  }
  const document: EvalSuiteDocument = suiteDocumentCodec.Decode(value);
  return { ok: true, document };
}

/** Decode a single discovery agent row, used for fixture-level overrides. */
export function decodeDiscoveryAgents(value: JsonValue): DiscoveryAgentRow[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const rows: DiscoveryAgentRow[] = [];
  for (const item of value) {
    if (!DiscoveryAgentSchema.Check(item)) {
      return null;
    }
    rows.push(DiscoveryAgentSchema.Decode(item));
  }
  return rows;
}

/** Decode child response specs, rejecting malformed entries loudly. */
export function decodeChildResponses(value: JsonValue): ChildResponseSpec[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const specs: ChildResponseSpec[] = [];
  for (const item of value) {
    if (!ChildResponseSchema.Check(item)) {
      return null;
    }
    specs.push(ChildResponseSchema.Decode(item));
  }
  return specs;
}

/** Decode a structured-output schema view from canonical params. */
export function decodeOutputSchema(value: JsonValue): OutputSchemaView | null {
  if (!OutputSchemaField.Check(value)) {
    return null;
  }
  return OutputSchemaField.Decode(value);
}
