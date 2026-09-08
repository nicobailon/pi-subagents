/**
 * Named JSON value types for the paired catalog evaluation.
 *
 * Every untrusted value that crosses the harness boundary (model tool calls,
 * variant parser output, provider payloads, fixture documents) is represented
 * as one of these named types and decoded at the boundary in decode.ts.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord;

export interface JsonRecord {
  readonly [key: string]: JsonValue;
}

/** A parsed JSON document of unknown shape, kept as a named boundary type. */
export type JsonDocument = JsonValue;
