import assert from "node:assert/strict";
import test from "node:test";
import {
	EXTERNAL_RUN_REGISTRY_KEY,
	registerExternalRunProvider,
	snapshotExternalRuns,
} from "../../src/api/external-runs.ts";

function clearRegistry(): void {
	delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)];
}

test("external-run providers expose scoped observational records without controls", () => {
	clearRegistry();
	const dispose = registerExternalRunProvider({
		name: "interactive-shell",
		listExternalRuns: () => [{
			id: "review-794",
			sessionId: "session-a",
			source: "interactive_shell",
			state: "completed",
			completionReason: "auto-close-quiet",
			cwd: "/tmp/review",
			reportPath: "/tmp/review.md",
			exitCode: null,
			residualRisks: ["The terminal runtime owns process control."],
		}],
	});
	assert.deepEqual(snapshotExternalRuns("session-a"), [{
		provider: "interactive-shell",
		id: "review-794",
		sessionId: "session-a",
		source: "interactive_shell",
		state: "completed",
		completionReason: "auto-close-quiet",
		cwd: "/tmp/review",
		reportPath: "/tmp/review.md",
		exitCode: null,
		residualRisks: ["The terminal runtime owns process control."],
	}]);
	assert.deepEqual(snapshotExternalRuns("session-b"), []);
	dispose();
	clearRegistry();
});

test("external-run providers reject malformed and duplicate records", () => {
	clearRegistry();
	assert.throws(() => registerExternalRunProvider({ name: " bad", listExternalRuns: () => [] }), /trimmed/);
	registerExternalRunProvider({
		name: "interactive-shell",
		listExternalRuns: () => [
			{ id: "run", sessionId: "session-a", source: "interactive_shell", state: "running", extra: true },
		] as never,
	});
	assert.throws(() => snapshotExternalRuns("session-a"), /unknown fields: extra/);
	clearRegistry();
	registerExternalRunProvider({
		name: "interactive-shell",
		listExternalRuns: () => [
			{ id: "run", sessionId: "session-a", source: "interactive_shell", state: "running" },
			{ id: "run", sessionId: "session-a", source: "interactive_shell", state: "running" },
		],
	});
	assert.throws(() => snapshotExternalRuns("session-a"), /duplicate run 'run'/);
	clearRegistry();
});
