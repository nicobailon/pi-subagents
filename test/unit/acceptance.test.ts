import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	acceptanceFailureMessage,
	aggregateAcceptanceReport,
	evaluateAcceptance,
	formatAcceptancePrompt,
	parseAcceptanceReport,
	resolveEffectiveAcceptance,
	validateAcceptanceInput,
} from "../../src/runs/shared/acceptance.ts";

function report(overrides: Record<string, unknown> = {}): string {
	return [
		"done",
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "verified in test" }],
			changedFiles: ["src/file.ts"],
			testsAddedOrUpdated: ["test/file.test.ts"],
			commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
			validationOutput: ["tests passed"],
			residualRisks: [],
			noStagedFiles: true,
			notes: "complete",
			...overrides,
		}),
		"```",
	].join("\n");
}

function tempRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-acceptance-"));
	fs.writeFileSync(path.join(dir, "file.txt"), "hello\n", "utf-8");
	return dir;
}

describe("acceptance gates", () => {
	it("infers different policies for reviewer, writer, async writer, and dynamic contexts", () => {
		assert.equal(resolveEffectiveAcceptance({ agentName: "reviewer", task: "Review-only. Do not edit.", mode: "single" }).level, "attested");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "single" }).level, "checked");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "single", async: true }).level, "reviewed");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Fix each item", mode: "chain", dynamic: true }).level, "reviewed");
	});

	it("explicit acceptance can strengthen inferred policy", () => {
		const resolved = resolveEffectiveAcceptance({
			agentName: "reviewer",
			task: "Review-only.",
			explicit: { level: "verified", verify: [{ id: "ok", command: "node --version" }] },
		});

		assert.equal(resolved.level, "verified");
		assert.equal(resolved.verify[0]?.id, "ok");
	});

	it("formats a standardized child prompt section", () => {
		const resolved = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { level: "checked", criteria: ["Patch the bug"], stopRules: ["Do not stop after analysis"] },
		});
		const prompt = formatAcceptancePrompt(resolved);

		assert.match(prompt, /## Acceptance Contract/);
		assert.match(prompt, /Acceptance level: checked/);
		assert.match(prompt, /Patch the bug/);
		assert.match(prompt, /```acceptance-report/);
	});

	it("parses only explicit acceptance-report fences", () => {
		const parsed = parseAcceptanceReport(report());

		assert.ok(parsed.report);
		assert.deepEqual(parsed.report.changedFiles, ["src/file.ts"]);
		assert.equal(parsed.error, undefined);

		const genericJson = parseAcceptanceReport(`done\n\
\
\`\`\`json\n{\"notes\":\"not an acceptance report\"}\n\`\`\``);
		assert.equal(genericJson.report, undefined);
		assert.match(genericJson.error ?? "", /Structured acceptance report not found/);

		const malformed = parseAcceptanceReport("```acceptance-report\n{bad-json\n```");
		assert.equal(malformed.report, undefined);
		assert.match(malformed.error ?? "", /Failed to parse acceptance-report/);
	});

	it("explicit none disables inferred gates when a reason is present", () => {
		const acceptance = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { level: "none", reason: "parent is doing manual acceptance" },
		});

		assert.equal(acceptance.level, "none");
		assert.deepEqual(acceptance.evidence, []);
	});

	it("checked mode rejects missing required evidence", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked" },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({ testsAddedOrUpdated: [] }),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /tests-added evidence missing/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("checked mode rejects not-satisfied required criteria", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked", criteria: [{ id: "regression", must: "Regression is covered" }] },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({ criteriaSatisfied: [{ id: "regression", status: "not-satisfied", evidence: "test missing" }] }),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /Required criterion 'regression' was reported as not-satisfied/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("verified mode records runtime command success and failure separately from child command claims", async () => {
		const cwd = tempRepo();
		try {
			const passing = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "verified", verify: [{ id: "pass", command: "node --version", timeoutMs: 10_000 }] },
			});
			const passLedger = await evaluateAcceptance({ acceptance: passing, output: report(), cwd });
			assert.equal(passLedger.status, "verified");
			assert.equal(passLedger.verifyRuns[0]?.status, "passed");

			const failing = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "verified", verify: [{ id: "fail", command: "node", args: ["--invalid-flag"], timeoutMs: 10_000 }] },
			});
			const failLedger = await evaluateAcceptance({ acceptance: failing, output: report(), cwd });
			assert.equal(failLedger.status, "rejected");
			assert.equal(failLedger.childReport?.commandsRun?.[0]?.result, "passed");
			assert.equal(failLedger.verifyRuns[0]?.status, "failed");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("reviewed mode records no-blocker and blocker reviewer outcomes", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a risky fix",
				explicit: { level: "reviewed", review: { agent: "reviewer", required: true } },
			});
			const noBlockers = await evaluateAcceptance({
				acceptance,
				output: report(),
				cwd,
				reviewResult: { status: "no-blockers", findings: [] },
			});
			assert.equal(noBlockers.status, "reviewed");
			assert.equal(noBlockers.reviewResult?.status, "no-blockers");

			const blockers = await evaluateAcceptance({
				acceptance,
				output: report(),
				cwd,
				reviewResult: {
					status: "blockers",
					findings: [{ severity: "blocker", issue: "Missing test", rationale: "Acceptance requires test evidence." }],
				},
			});
			assert.equal(blockers.status, "rejected");
			assert.equal(blockers.reviewResult?.status, "blockers");

			const unavailable = await evaluateAcceptance({ acceptance, output: report(), cwd });
			assert.equal(unavailable.status, "rejected");
			assert.equal(unavailable.reviewResult?.status, "needs-parent-decision");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not make explicit checked acceptance an explicit reviewed blocker when inference recommends review", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement each dynamic item",
				dynamic: true,
				explicit: { level: "checked" },
			});

			assert.equal(acceptance.level, "reviewed");
			assert.equal(acceptance.review && acceptance.review !== false ? acceptance.review.required : undefined, false);
			const ledger = await evaluateAcceptance({ acceptance, output: report({ criteriaSatisfied: [
				{ id: "criterion-1", status: "satisfied", evidence: "implemented" },
				{ id: "criterion-2", status: "satisfied", evidence: "evidence returned" },
			] }), cwd });
			assert.equal(ledger.status, "checked");
			assert.equal(ledger.reviewResult?.status, "needs-parent-decision");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not mark reviewed without an independent reviewer result", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: {
					level: "reviewed",
					review: false,
				},
			});
			assert.equal(acceptance.level, "reviewed");

			const ledger = await evaluateAcceptance({ acceptance, output: report(), cwd });
			assert.equal(ledger.status, "rejected");
			assert.equal(ledger.reviewResult?.status, "needs-parent-decision");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /review required/i);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("zero-child aggregate reports do not fabricate required evidence", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement dynamic fanout fixes",
				explicit: { level: "checked" },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: "",
				report: aggregateAcceptanceReport({ results: [] }),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /criterion|changed-files|tests-added|commands-run|validation-output|no-staged-files/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("validates invalid disable and verify shapes", () => {
		assert.deepEqual(validateAcceptanceInput({ level: "none" }), ["acceptance.reason is required when level is none."]);
		assert.deepEqual(validateAcceptanceInput({ verify: [{ id: "missing-command" }] }), ["acceptance.verify[0].command is required."]);
	});
});
