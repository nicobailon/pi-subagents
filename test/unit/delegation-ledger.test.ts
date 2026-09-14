import assert from "node:assert/strict";
import test from "node:test";
import {
	DELEGATION_LEDGER_KEY,
	DELEGATION_LEDGER_LIMITS,
	DELEGATION_LEDGER_VERSION,
	getDelegationRecordByRun,
	recordDelegationStarted,
	recordDelegationTerminal,
	snapshotDelegationRecords,
} from "../../src/api/delegation-ledger.ts";

function clearRegistry(): void {
	delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(DELEGATION_LEDGER_KEY)];
}

test("delegation ledger records started state and merges terminal outcomes", () => {
	clearRegistry();
	recordDelegationStarted({ requestId: "r1", ownerRunId: "o1", nodeId: "n1", agent: "worker" });
	const terminal = recordDelegationTerminal({
		requestId: "r1",
		ownerRunId: "o1",
		nodeId: "n1",
		status: "completed",
		runId: "run-1",
		childIndex: 0,
		launchContractDigest: "digest-1",
	});
	assert.equal(terminal.status, "completed");
	assert.equal(terminal.agent, "worker");
	assert.equal(terminal.runId, "run-1");
	assert.equal(terminal.launchContractDigest, "digest-1");
	assert.equal(typeof terminal.startedAt, "number");
	assert.equal(typeof terminal.endedAt, "number");
	const lookup = getDelegationRecordByRun("run-1", { agent: "worker" });
	assert.equal(lookup?.requestId, "r1");
	assert.equal(lookup?.nodeId, "n1");
	assert.equal(getDelegationRecordByRun("run-1", { agent: "other" }), undefined);
	assert.equal(getDelegationRecordByRun("missing"), undefined);
});

test("delegation ledger records standalone terminals without agent identity", () => {
	clearRegistry();
	const entry = recordDelegationTerminal({ requestId: "r2", ownerRunId: "o2", nodeId: "n2", status: "cancelled" });
	assert.equal(entry.status, "cancelled");
	assert.equal(entry.agent, undefined);
	assert.equal(typeof entry.startedAt, "number");
	assert.equal(typeof entry.endedAt, "number");
	assert.equal(getDelegationRecordByRun("run-1"), undefined);
	assert.equal(snapshotDelegationRecords().length, 1);
});

test("delegation ledger fails closed on malformed input", () => {
	clearRegistry();
	assert.throws(() => recordDelegationStarted({ requestId: "", ownerRunId: "o", nodeId: "n", agent: "a" }));
	assert.throws(() => recordDelegationStarted({ requestId: "r", ownerRunId: "o", nodeId: "n", agent: "a\nb" }));
	assert.throws(() => recordDelegationTerminal({ requestId: "r", ownerRunId: "o", nodeId: "n", status: "running" as never }));
	assert.throws(() => recordDelegationTerminal({ requestId: "r", ownerRunId: "o", nodeId: "n", status: "completed", childIndex: -1 }));
	assert.doesNotThrow(() => recordDelegationTerminal({ requestId: "r", ownerRunId: "o", nodeId: "n", status: "cancelled" }));
});

test("delegation ledger stays bounded by evicting the oldest entries", () => {
	clearRegistry();
	for (let index = 0; index < DELEGATION_LEDGER_LIMITS.maxEntries + 8; index++) {
		recordDelegationStarted({ requestId: `r${index}`, ownerRunId: "o", nodeId: "n", agent: "a" });
	}
	const snapshot = snapshotDelegationRecords();
	assert.equal(snapshot.length, DELEGATION_LEDGER_LIMITS.maxEntries);
	assert.equal(snapshot[0].requestId, `r${8}`);
	assert.equal(snapshot[snapshot.length - 1].requestId, `r${DELEGATION_LEDGER_LIMITS.maxEntries + 7}`);
});

test("delegation ledger rejects malformed persisted registries", () => {
	clearRegistry();
	(globalThis as Record<PropertyKey, unknown>)[Symbol.for(DELEGATION_LEDGER_KEY)] = { version: 2, entries: new Map() };
	assert.throws(() => snapshotDelegationRecords(), /Unsupported delegation ledger/);
	(globalThis as Record<PropertyKey, unknown>)[Symbol.for(DELEGATION_LEDGER_KEY)] = "garbage";
	assert.throws(() => snapshotDelegationRecords(), /Malformed delegation ledger/);
	clearRegistry();
	assert.equal(snapshotDelegationRecords().length, 0);
});
