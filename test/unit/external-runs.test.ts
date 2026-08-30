import assert from "node:assert/strict";
import test from "node:test";
import {
	EXTERNAL_RUN_LIMITS,
	EXTERNAL_RUN_REGISTRY_KEY,
	EXTERNAL_RUN_REGISTRY_VERSION,
	listExternalRuns,
	registerExternalRun,
	snapshotExternalRuns,
	unregisterExternalRun,
	updateExternalRun,
	type ExternalRun,
} from "../../src/api/external-runs.ts";

function clearRegistry(): void {
	delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)];
	delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(`${EXTERNAL_RUN_REGISTRY_KEY}.trusted`)];
}

test("external runs register, update, list, and unregister cached display records", () => {
	clearRegistry();
	assert.deepEqual(registerExternalRun({
		id: "review-1083",
		sessionId: "session-a",
		source: "interactive-shell",
		label: "Dependency review",
		state: "running",
		startedAt: 100,
		currentAction: "Inspecting package metadata",
	}), {
		id: "review-1083",
		sessionId: "session-a",
		source: "interactive-shell",
		label: "Dependency review",
		state: "running",
		startedAt: 100,
		currentAction: "Inspecting package metadata",
	});
	assert.deepEqual(snapshotExternalRuns("session-b"), []);
	assert.deepEqual(updateExternalRun("session-a", "review-1083", {
		state: "completed",
		updatedAt: 190,
		endedAt: 200,
		preview: "Review complete",
		reportPath: "/tmp/review.md",
	}), {
		id: "review-1083",
		sessionId: "session-a",
		source: "interactive-shell",
		label: "Dependency review",
		state: "completed",
		startedAt: 100,
		updatedAt: 190,
		endedAt: 200,
		currentAction: "Inspecting package metadata",
		preview: "Review complete",
		reportPath: "/tmp/review.md",
	});
	assert.deepEqual(listExternalRuns("session-a"), snapshotExternalRuns("session-a"));
	assert.equal(unregisterExternalRun("session-a", "review-1083"), true);
	assert.equal(unregisterExternalRun("session-a", "review-1083"), false);
	assert.deepEqual(snapshotExternalRuns("session-a"), []);
	clearRegistry();
});

test("external snapshots reuse validated records, detect direct mutations, and clone reads", () => {
	clearRegistry();
	try {
		const registered = registerExternalRun({
			id: "trusted",
			sessionId: "session-a",
			source: "tool",
			label: "Trusted run",
			state: "running",
			startedAt: 1,
		});
		const registry = (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)] as { runs: Map<string, ExternalRun> };
		const stored = registry.runs.get("session-a\0trusted")!;
		assert.notEqual(stored, registered, "callers receive a clone rather than the cached object");
		const snapshot = snapshotExternalRuns("session-a");
		assert.deepEqual(snapshot, [registered]);
		(snapshot[0] as ExternalRun).label = "Changed outside the registry";
		assert.equal(snapshotExternalRuns("session-a")[0]?.label, "Trusted run", "snapshot results remain cloned");

		const changed = registry.runs.get("session-a\0trusted")!;
		changed.label = "Directly changed";
		assert.equal(snapshotExternalRuns("session-a")[0]?.label, "Directly changed");
		const malformed = registry.runs.get("session-a\0trusted")!;
		malformed.state = "invalid" as never;
		assert.throws(() => snapshotExternalRuns("session-a"), /state is invalid/);
		assert.deepEqual(snapshotExternalRuns("session-a", { ignoreMalformed: true }), []);
	} finally {
		clearRegistry();
	}
});

test("external snapshots do not trust forged public-symbol metadata", () => {
	clearRegistry();
	try {
		const malformed = {
			id: "forged",
			sessionId: "session-a",
			source: "tool",
			label: "Forged",
			state: "invalid",
			startedAt: 1,
		};
		const forgedNormalized = {
			id: "forged",
			sessionId: "session-a",
			source: "tool",
			label: "Forged trusted value",
			state: "running",
			startedAt: 1,
		};
		const registry = {
			version: EXTERNAL_RUN_REGISTRY_VERSION,
			runs: new Map<string, ExternalRun>([["session-a\0forged", malformed as unknown as ExternalRun]]),
		};
		(globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)] = registry;
		(globalThis as Record<PropertyKey, unknown>)[Symbol.for(`${EXTERNAL_RUN_REGISTRY_KEY}.trusted`)] = new Map([
			["session-a\0forged", { value: malformed, normalized: forgedNormalized, keys: Object.keys(malformed), values: Object.values(malformed) }],
		]);

		assert.throws(() => snapshotExternalRuns("session-a"), /state is invalid/);
		assert.deepEqual(snapshotExternalRuns("session-a", { ignoreMalformed: true }), []);
	} finally {
		clearRegistry();
	}
});

test("external snapshots filter unrelated cache keys before normalizing records", () => {
	clearRegistry();
	try {
		registerExternalRun({
			id: "good",
			sessionId: "session-a",
			source: "tool",
			label: "Good run",
			state: "running",
			startedAt: 1,
		});
		const malformed = {
			id: "bad",
			sessionId: "session-b",
			source: "tool",
			state: "running",
			startedAt: 2,
		} as Record<string, unknown>;
		Object.defineProperty(malformed, "label", {
			enumerable: true,
			get() {
				throw new Error("unrelated record was normalized");
			},
		});
		const registry = (globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)] as { runs: Map<string, ExternalRun> };
		registry.runs.set("session-b\0bad", malformed as unknown as ExternalRun);

		assert.deepEqual(snapshotExternalRuns("session-a").map((run) => run.id), ["good"]);
		assert.throws(() => snapshotExternalRuns("session-b"), /unrelated record was normalized/);
	} finally {
		clearRegistry();
	}
});

test("external run validation is atomic and display text is bounded", () => {
	clearRegistry();
	registerExternalRun({
		id: "run",
		sessionId: "session-a",
		source: "tool",
		label: "Initial",
		state: "running",
		startedAt: 1,
	});
	assert.throws(
		() => updateExternalRun("session-a", "run", { state: "invalid" as never, label: "Changed" }),
		/state is invalid/,
	);
	assert.equal(snapshotExternalRuns("session-a")[0]?.label, "Initial");
	const updated = updateExternalRun("session-a", "run", {
		label: `\u001b[31m${"x".repeat(EXTERNAL_RUN_LIMITS.maxTextLength + 20)}`,
		preview: `line 1\n${"p".repeat(EXTERNAL_RUN_LIMITS.maxPreviewLength + 20)}`,
	});
	assert.equal(updated.label.length, EXTERNAL_RUN_LIMITS.maxTextLength);
	assert.ok(updated.preview!.length <= EXTERNAL_RUN_LIMITS.maxPreviewLength);
	assert.doesNotMatch(updated.label, /\u001b/);
	assert.doesNotMatch(updated.preview!, /\n/);
	assert.throws(
		() => registerExternalRun({ id: "unsafe\nrun", sessionId: "session-a", source: "tool", label: "Unsafe", state: "running", startedAt: 1 }),
		/display-safe/,
	);
	assert.throws(
		() => registerExternalRun({ id: "extra", sessionId: "session-a", source: "tool", label: "Extra", state: "running", startedAt: 1, cwd: "/private" } as never),
		/unknown fields: cwd/,
	);
	assert.throws(
		() => registerExternalRun({ id: "invalid-date", sessionId: "session-a", source: "tool", label: "Invalid date", state: "running", startedAt: Number.MAX_SAFE_INTEGER }),
		/safe timestamp/,
	);
	clearRegistry();
});

test("external snapshots throw on malformed cached records by default", () => {
	clearRegistry();
	try {
		(globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)] = {
			version: EXTERNAL_RUN_REGISTRY_VERSION,
			runs: new Map<string, unknown>([
				["session-a\0bad", { id: "bad", sessionId: "session-a", source: "tool", label: "Bad", state: "running", startedAt: Number.NaN }],
				["session-a\0good", { id: "good", sessionId: "session-a", source: "tool", label: "Good", state: "running", startedAt: 1 }],
			]),
		};
		assert.throws(
			() => snapshotExternalRuns("session-a"),
			/Malformed cached external run 'session-a\0bad': External run startedAt must be a non-negative safe timestamp/,
		);
	} finally {
		clearRegistry();
	}
});

test("external snapshots can remove malformed cached records for display-only callers", () => {
	clearRegistry();
	const diagnostics: string[] = [];
	try {
		(globalThis as Record<PropertyKey, unknown>)[Symbol.for(EXTERNAL_RUN_REGISTRY_KEY)] = {
			version: EXTERNAL_RUN_REGISTRY_VERSION,
			runs: new Map<string, unknown>([
				["session-a\0bad", { id: "bad", sessionId: "session-a", source: "tool", label: "Bad", state: "running", startedAt: Number.NaN }],
				["session-a\0good", { id: "good", sessionId: "session-a", source: "tool", label: "Good", state: "running", startedAt: 1 }],
			]),
		};
		assert.deepEqual(snapshotExternalRuns("session-a", { ignoreMalformed: true, onMalformedRecord: (message) => diagnostics.push(message) }).map((run) => run.id), ["good"]);
		assert.deepEqual(diagnostics, ["Malformed cached external run 'session-a\0bad': External run startedAt must be a non-negative safe timestamp."]);
		assert.deepEqual(snapshotExternalRuns("session-a").map((run) => run.id), ["good"]);
	} finally {
		clearRegistry();
	}
});

test("external snapshots apply count and serialized byte caps without provider callbacks", () => {
	clearRegistry();
	for (let index = 0; index < EXTERNAL_RUN_LIMITS.maxSnapshotRuns + 5; index++) {
		registerExternalRun({
			id: `run-${index}`,
			sessionId: "session-a",
			source: "tool",
			label: `Run ${index}`,
			state: index === 0 ? "running" : "completed",
			startedAt: index,
			updatedAt: index,
			preview: "p".repeat(EXTERNAL_RUN_LIMITS.maxPreviewLength),
		});
	}
	const snapshot = snapshotExternalRuns("session-a");
	assert.ok(snapshot.length <= EXTERNAL_RUN_LIMITS.maxSnapshotRuns);
	assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= EXTERNAL_RUN_LIMITS.maxSerializedBytes);
	assert.equal(snapshot[0]?.id, "run-0", "active jobs sort ahead of terminal jobs");
	clearRegistry();
});
