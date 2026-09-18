import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	acceptanceFailureMessage,
	acceptanceHasTypedVerify,
	evaluateAcceptance,
	normalizeGateAcceptance,
	parseGateInput,
	resolveEffectiveAcceptance,
	typedVerifyOutput,
	validateAcceptanceInput,
} from "../../src/runs/shared/acceptance.ts";

function tempGitRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "typed-gate-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
	return dir;
}

/** A gate command that prints exactly `text` on stdout and exits 0. */
function printing(text: string): string {
	return `${process.execPath} -e "process.stdout.write(process.argv[1])" ${JSON.stringify(text)}`;
}

async function runGate(gate: unknown, cwd: string, extra: { artifactsDir?: string; runId?: string } = {}) {
	const normalized = normalizeGateAcceptance(gate, undefined);
	assert.equal(normalized.ok, true, normalized.ok ? undefined : normalized.error);
	const acceptance = resolveEffectiveAcceptance({
		agentName: "reviewer",
		task: "Review the report.",
		explicit: normalized.ok ? normalized.acceptance : undefined,
		agentContract: { version: 1 },
	});
	return evaluateAcceptance({ acceptance, output: "done", cwd, reportOptional: true, ...extra });
}

describe("gate object form", () => {
	it("parses the string form and the object form", () => {
		assert.deepEqual(parseGateInput(" npm test "), { ok: true, gate: { command: "npm test" } });
		assert.deepEqual(parseGateInput({ command: "classify.sh", output: "json", timeoutMs: 5000 }), {
			ok: true,
			gate: { command: "classify.sh", output: "json", timeoutMs: 5000 },
		});
		assert.deepEqual(normalizeGateAcceptance({ command: "classify.sh", output: "json", schema: { type: "object" } }, undefined), {
			ok: true,
			acceptance: { level: "verified", verify: [{ id: "gate", command: "classify.sh", output: "json", schema: { type: "object" } }] },
		});
	});

	it("rejects malformed object gates with a field-level message", () => {
		for (const [gate, pattern] of [
			[{}, /non-empty command string/],
			[{ command: " " }, /non-empty command string/],
			[{ command: "x", output: "yaml" }, /gate\.output must be "json"/],
			[{ command: "x", schema: { type: "object" } }, /gate\.schema requires gate\.output/],
			[{ command: "x", output: "json", schema: "nope" }, /gate\.schema must be a JSON Schema object/],
			[{ command: "x", timeoutMs: 0 }, /gate\.timeoutMs must be an integer/],
			[{ command: "x", cwd: "." }, /gate\.cwd is not supported/],
			[["x"], /non-empty command string/],
		] as const) {
			const parsed = parseGateInput(gate);
			assert.equal(parsed.ok, false, JSON.stringify(gate));
			assert.match(parsed.ok ? "" : parsed.error, pattern, JSON.stringify(gate));
		}
	});

	it("detects typed verify commands in either spelling", () => {
		assert.equal(acceptanceHasTypedVerify(undefined), false);
		assert.equal(acceptanceHasTypedVerify("checked"), false);
		assert.equal(acceptanceHasTypedVerify({ level: "verified", verify: [{ id: "v", command: "x" }] }), false);
		assert.equal(acceptanceHasTypedVerify({ level: "verified", verify: [{ id: "v", command: "x", output: "json" }] }), true);
		const gate = normalizeGateAcceptance({ command: "x", output: "json" }, undefined);
		assert.equal(gate.ok && acceptanceHasTypedVerify(gate.acceptance), true);
	});

	it("accepts output and schema on explicit acceptance.verify entries", () => {
		assert.deepEqual(validateAcceptanceInput({ level: "verified", verify: [{ id: "v", command: "x", output: "json", schema: { type: "object" } }] }), []);
		assert.match(validateAcceptanceInput({ level: "verified", verify: [{ id: "v", command: "x", output: "text" }] }).join("\n"), /output must be "json"/);
		assert.match(validateAcceptanceInput({ level: "verified", verify: [{ id: "v", command: "x", schema: {} }] }).join("\n"), /schema requires output/);
	});
});

describe("typed gate output", () => {
	it("parses a passing json gate's stdout into the verify run and exposes it", async () => {
		const cwd = tempGitRepo();
		const ledger = await runGate({ command: printing('{"verdict":"blocked","score":0.9}'), output: "json" }, cwd);
		assert.equal(ledger.status, "verified");
		assert.equal(ledger.verifyRuns[0]?.status, "passed");
		assert.deepEqual(ledger.verifyRuns[0]?.structuredOutput, { verdict: "blocked", score: 0.9 });
		assert.deepEqual(typedVerifyOutput(ledger), { value: { verdict: "blocked", score: 0.9 } });
	});

	it("validates the parsed stdout against gate.schema", async () => {
		const cwd = tempGitRepo();
		const schema = { type: "object", properties: { verdict: { type: "string", enum: ["ok", "blocked"] } }, required: ["verdict"], additionalProperties: false };
		const good = await runGate({ command: printing('{"verdict":"ok"}'), output: "json", schema }, cwd);
		assert.equal(good.status, "verified");
		assert.deepEqual(typedVerifyOutput(good), { value: { verdict: "ok" } });

		const bad = await runGate({ command: printing('{"verdict":"maybe"}'), output: "json", schema }, cwd);
		assert.equal(bad.status, "rejected");
		assert.equal(bad.verifyRuns[0]?.status, "failed");
		assert.match(bad.verifyRuns[0]?.structuredOutputError ?? "", /does not match gate\.schema/);
		assert.match(acceptanceFailureMessage(bad) ?? "", /verification 'gate' failed: output: "json" stdout does not match gate\.schema/);
		assert.equal(typedVerifyOutput(bad), undefined);
	});

	it("fails the gate on invalid or empty stdout instead of dropping the verdict", async () => {
		const cwd = tempGitRepo();
		const invalid = await runGate({ command: printing("WRITER-FIX report=x"), output: "json" }, cwd);
		assert.equal(invalid.status, "rejected");
		assert.match(invalid.verifyRuns[0]?.structuredOutputError ?? "", /not valid JSON/);

		const empty = await runGate({ command: printing(""), output: "json" }, cwd);
		assert.equal(empty.status, "rejected");
		assert.match(empty.verifyRuns[0]?.structuredOutputError ?? "", /printed nothing/);
	});

	it("leaves string gates and non-json verify commands untouched", async () => {
		const cwd = tempGitRepo();
		const plain = await runGate(printing('{"verdict":"blocked"}'), cwd);
		assert.equal(plain.status, "verified");
		assert.equal(plain.verifyRuns[0]?.structuredOutput, undefined);
		assert.equal(typedVerifyOutput(plain), undefined);
	});

	it("never memoizes a typed gate, because its input can change without the tracked tree changing", async () => {
		const cwd = tempGitRepo();
		const artifactsDir = path.join(cwd, ".artifacts");
		const first = await runGate({ command: printing('{"n":1}'), output: "json" }, cwd, { artifactsDir, runId: "typed-memo" });
		const second = await runGate({ command: printing('{"n":1}'), output: "json" }, cwd, { artifactsDir, runId: "typed-memo" });
		assert.equal(first.verifyRuns[0]?.memoized, undefined);
		assert.equal(second.verifyRuns[0]?.memoized, undefined);
		assert.equal(second.verifyRuns[0]?.cacheKey, undefined);
	});
});
