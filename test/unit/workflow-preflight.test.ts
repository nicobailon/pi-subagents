import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	WORKFLOW_PREFLIGHT_MAX_BYTES,
	WORKFLOW_PREFLIGHT_MAX_CLAIMS,
	WORKFLOW_PREFLIGHT_MAX_LANES,
	WORKFLOW_PREFLIGHT_MAX_STRING_LENGTH,
	WORKFLOW_PREFLIGHT_MAX_WARNINGS,
	annotateWorkflowPreflightTrace,
	formatWorkflowPreflight,
	formatWorkflowPreflightPlanSummary,
	formatWorkflowPreflightSummary,
	formatWorkflowPreflightWarningSummary,
	normalizeWorkflowPreflight,
	validateWorkflowPreflight,
	workflowPreflightWarnings,
} from "../../src/workflows/workflow-preflight.ts";

const preflight = {
	version: 1 as const,
	coverage: "complete" as const,
	lanes: [{
		key: "issue1624-writer",
		mode: "mutation" as const,
		decision: "Implement bounded preflight",
		claims: ["src/workflows/workflow-preflight.ts"],
		expectedOutput: "writer and review report",
		independence: "does not touch cleanup",
	}],
};

describe("workflow preflight metadata", () => {
	it("normalizes bounded display hints and renders the compact table", () => {
		const normalized = normalizeWorkflowPreflight({
			...preflight,
			lanes: [{
				...preflight.lanes[0],
				key: " issue1624-writer ",
				decision: "Implement\n bounded\tpreflight",
			}],
		});
		assert.deepEqual(normalized, {
			version: 1,
			coverage: "complete",
			lanes: [{
				key: "issue1624-writer",
				mode: "mutation",
				decision: "Implement bounded preflight",
				claims: ["src/workflows/workflow-preflight.ts"],
				expectedOutput: "writer and review report",
				independence: "does not touch cleanup",
			}],
		});
		const table = formatWorkflowPreflight(normalized);
		assert.match(table, /Preflight: v1 · complete · 1 lane/);
		assert.match(table, /key \| mode \| decision \| claims \| expected output \| independence/);
		assert.match(table, /issue1624-writer \| mutation \| Implement bounded preflight/);
		assert.match(formatWorkflowPreflightSummary(normalized), /preflight · complete · 1 lane: issue1624-writer/);
		assert.equal(formatWorkflowPreflightPlanSummary(normalized), "Plan: 1 lane · Implement bounded preflight");
		assert.equal(formatWorkflowPreflightWarningSummary(["one", "two"], { indent: "  ", hint: "expand for debug" }), "  Plan note: 2 preflight mismatches · expand for debug.");
	});

	it("rejects unsupported, malformed, duplicate, and over-bound metadata", () => {
		const invalidValues: Array<[unknown, RegExp]> = [
			[{ version: 2, lanes: [] }, /preflight\.version/],
			[{ version: 1, lanes: [], extra: true }, /unsupported field 'extra'/],
			[{ version: 1, coverage: "strict", lanes: [] }, /coverage/],
			[{ version: 1, lanes: [{ key: "bad key" }] }, /lanes\[0\]\.key/],
			[{ version: 1, lanes: [{ key: "same" }, { key: "same" }] }, /duplicate key/],
			[{ version: 1, lanes: [{ key: "same", mode: "owner" }] }, /mode/],
			[{ version: 1, lanes: [{ key: "same", claims: ["claim", "claim", "claim", "claim", "claim", "claim", "claim", "claim", "claim", "claim", "claim", "claim", "claim", "claim", "claim", "claim", "claim"] }] }, /at most/],
			[{ version: 1, lanes: [{ key: "same", decision: "x".repeat(WORKFLOW_PREFLIGHT_MAX_STRING_LENGTH + 1) }] }, /maximum length/],
		];
		for (const [value, pattern] of invalidValues) assert.throws(() => normalizeWorkflowPreflight(value), pattern);
		assert.throws(() => normalizeWorkflowPreflight({ version: 1, lanes: Array.from({ length: WORKFLOW_PREFLIGHT_MAX_LANES + 1 }, (_, index) => ({ key: `lane-${index}` })) }), /at most/);
		const getter = { version: 1, lanes: [] } as Record<string, unknown>;
		Object.defineProperty(getter, "lanes", { enumerable: true, get: () => [] });
		assert.throws(() => normalizeWorkflowPreflight(getter), /must be an enumerable data property/);
		const tooLarge = {
			version: 1,
			lanes: Array.from({ length: WORKFLOW_PREFLIGHT_MAX_LANES }, (_, index) => ({
				key: `large-${index}`,
				decision: "x".repeat(WORKFLOW_PREFLIGHT_MAX_STRING_LENGTH),
			})),
		};
		assert.ok(Buffer.byteLength(JSON.stringify(tooLarge), "utf8") > WORKFLOW_PREFLIGHT_MAX_BYTES);
		assert.throws(() => normalizeWorkflowPreflight(tooLarge), /canonical JSON/);
		assert.equal(validateWorkflowPreflight(preflight).ok, true);
		assert.equal(validateWorkflowPreflight({ version: 1, lanes: [{ key: "bad key" }] }).ok, false);
	});

	it("reports bounded advisory mismatches and ignores auto-resume launches", () => {
		const trace = [
			{ operation: "run", key: "issue1624-writer", state: "started" as const },
			{ operation: "run", key: "undeclared", state: "started" as const },
			{ operation: "run", key: "undeclared", state: "completed" as const },
			{ operation: "run", key: "issue1624-writer", state: "started" as const, phase: "auto-resume" },
		];
		assert.deepEqual(workflowPreflightWarnings(preflight, trace), [
			"Preflight advisory: workflow key 'undeclared' launched without a declared lane.",
		]);
		assert.deepEqual(workflowPreflightWarnings(preflight, trace, { settled: true }), [
			"Preflight advisory: workflow key 'undeclared' launched without a declared lane.",
		]);
		const annotated = annotateWorkflowPreflightTrace(trace, preflight);
		assert.match(annotated[1]?.warning ?? "", /undeclared/);
		assert.equal(annotated[2]?.warning, undefined);
		assert.equal(annotated[3]?.warning, undefined);
	});

	it("reports declared-but-never-launched lanes only at settlement and caps warnings", () => {
		const manyLanes = normalizeWorkflowPreflight({
			version: 1,
			lanes: Array.from({ length: WORKFLOW_PREFLIGHT_MAX_LANES }, (_, index) => ({ key: `declared-${index}` })),
		});
		const warnings = workflowPreflightWarnings(manyLanes, Array.from({ length: WORKFLOW_PREFLIGHT_MAX_LANES }, (_, index) => ({ operation: "run", key: `extra-${index}`, state: "started" as const })), { settled: true });
		assert.equal(warnings.length, WORKFLOW_PREFLIGHT_MAX_WARNINGS);
		assert.match(warnings.at(-1) ?? "", /additional mismatch warning\(s\) omitted/);
		assert.deepEqual(workflowPreflightWarnings(manyLanes, [], { settled: false }), []);
		assert.ok(workflowPreflightWarnings(manyLanes, [], { settled: true }).some((warning) => warning.includes("declared lane 'declared-0' was not launched")));
		assert.ok(WORKFLOW_PREFLIGHT_MAX_CLAIMS > 0);
	});

	it("treats exact and direct dotted keys as declared lane stages by convention", () => {
		const lanes = normalizeWorkflowPreflight({
			version: 1,
			coverage: "complete",
			lanes: [{ key: "audit" }],
		});
		const generatedStageTrace = [
			{ operation: "run", key: "audit.writer", generatedLaneKey: "audit", state: "completed" as const },
			{ operation: "run", key: "audit.review", generatedLaneKey: "audit", state: "completed" as const },
		];
		assert.deepEqual(workflowPreflightWarnings(lanes, generatedStageTrace, { settled: true }), []);
		assert.equal(annotateWorkflowPreflightTrace(generatedStageTrace, lanes).some((entry) => entry.warning), false);

		// Direct runs.run keys intentionally use the same lane.stage convention without provenance.
		const directStageTrace = [
			{ operation: "run", key: "audit.shadow", state: "started" as const },
			{ operation: "run", key: "audit-other.writer", state: "started" as const },
		];
		assert.deepEqual(workflowPreflightWarnings(lanes, directStageTrace), [
			"Preflight advisory: workflow key 'audit-other.writer' launched without a declared lane.",
		]);
		assert.deepEqual(workflowPreflightWarnings(lanes, directStageTrace, { settled: true }), [
			"Preflight advisory: workflow key 'audit-other.writer' launched without a declared lane.",
		]);
		const directAnnotated = annotateWorkflowPreflightTrace(directStageTrace, lanes);
		assert.equal(directAnnotated[0]?.warning, undefined);
		assert.match(directAnnotated[1]?.warning ?? "", /without a declared lane/);

		const exactTrace = [{ operation: "run", key: "audit", state: "completed" as const }];
		assert.deepEqual(workflowPreflightWarnings(lanes, exactTrace, { settled: true }), []);
	});
});
