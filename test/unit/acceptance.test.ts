import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	acceptanceFailureMessage,
	attachFinalizationToLedger,
	createFinalizationTurn,
	evaluateAcceptance,
	formatAcceptanceFinalizationPrompt,
	formatAcceptancePrompt,
	parseAcceptanceReport,
	resolveEffectiveAcceptance,
	shouldRunAcceptanceFinalization,
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

async function withTempRepo<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-acceptance-"));
	fs.writeFileSync(path.join(cwd, "file.txt"), "hello\n", "utf-8");
	try {
		return await fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

describe("acceptance gates", () => {
	it("omitted acceptance resolves to no gates and no prompt", () => {
		const resolved = resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "single" });

		assert.equal(resolved.level, "none");
		assert.equal(resolved.explicit, false);
		assert.equal(shouldRunAcceptanceFinalization(resolved), false);
		assert.equal(formatAcceptancePrompt(resolved), "");
	});

	it("explicit criteria derive checked acceptance and a required finalization loop", () => {
		const resolved = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: {
				criteria: ["Patch the bug"],
				evidence: ["changed-files", "tests-added", "commands-run", "residual-risks"],
				maxFinalizationTurns: 2,
			},
		});

		assert.equal(resolved.level, "checked");
		assert.equal(resolved.finalization.mode, "self-review-loop");
		assert.equal(resolved.finalization.maxTurns, 2);
		assert.equal(shouldRunAcceptanceFinalization(resolved), true);
	});

	it("formats child and finalization prompt sections without public levels", () => {
		const resolved = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { criteria: ["Patch the bug"], evidence: ["diff-summary", "changed-files"], stopRules: ["Do not stop after analysis"] },
		});
		const prompt = formatAcceptancePrompt(resolved);

		assert.match(prompt, /## Acceptance Contract/);
		assert.doesNotMatch(prompt, /Acceptance level:/);
		assert.match(prompt, /same session for a bounded self-review\/repair loop/);
		assert.match(prompt, /Patch the bug/);
		assert.match(prompt, /Markdown sections in your visible answer do not satisfy required evidence/);
		assert.match(prompt, /diff-summary -> diffSummary: non-empty string/);
		assert.match(prompt, /changed-files -> changedFiles: array of changed file paths/);
		assert.match(prompt, /"diffSummary":/);
		assert.match(prompt, /"reviewFindings": \[\]/);
		assert.match(prompt, /```acceptance-report/);

		const initialLedger = {
			status: "rejected" as const,
			explicit: true,
			effectiveAcceptance: resolved,
			inferredReason: [],
			criteria: resolved.criteria,
			runtimeChecks: [{ id: "attestation", status: "failed" as const, message: "missing" }],
			verifyRuns: [],
			childReportParseError: "missing",
		};
		const finalizationPrompt = formatAcceptanceFinalizationPrompt({
			acceptance: resolved,
			initialOutput: "initial answer",
			initialLedger,
			turn: 1,
			maxTurns: 2,
			previousFailure: "Acceptance rejected: missing",
		});
		assert.match(finalizationPrompt, /## Acceptance Finalization/);
		assert.match(finalizationPrompt, /rejected if the contract is still not satisfied after turn 2/);
		assert.match(finalizationPrompt, /explain the blocker in residualRisks/);
		assert.match(finalizationPrompt, /concrete evidence from files, commands, validation output/);
		assert.match(finalizationPrompt, /Markdown sections in the visible answer do not satisfy required evidence/);
		assert.match(finalizationPrompt, /copy or summarize it into the matching JSON field/);
		assert.match(finalizationPrompt, /diff-summary -> diffSummary: non-empty string/);
		assert.match(finalizationPrompt, /"diffSummary":/);
		assert.match(finalizationPrompt, /Stop rules are hard constraints/);
		assert.match(finalizationPrompt, /Previous finalization failure/);
		assert.match(finalizationPrompt, /exactly one fenced JSON block/);
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

		const malformedCommands = parseAcceptanceReport("```acceptance-report\n{\"commandsRun\":[{}]}\n```");
		assert.equal(malformedCommands.report, undefined);
		assert.match(malformedCommands.error ?? "", /valid acceptance report/);
	});

	it("checked acceptance rejects missing required evidence", async () => withTempRepo(async (cwd) => {
		const acceptance = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { criteria: ["Patch the bug"], evidence: ["changed-files", "tests-added", "commands-run", "residual-risks"] },
		});
		const ledger = await evaluateAcceptance({
			acceptance,
			output: report({ testsAddedOrUpdated: [] }),
			cwd,
		});

		assert.equal(ledger.status, "rejected");
		assert.match(acceptanceFailureMessage(ledger) ?? "", /tests-added evidence missing/);
	}));

	it("requires diff-summary evidence in acceptance-report.diffSummary", async () => withTempRepo(async (cwd) => {
		const acceptance = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { criteria: ["Patch the bug"], evidence: ["diff-summary"] },
		});
		const markdownOnly = await evaluateAcceptance({
			acceptance,
			output: `## Diff summary\n\n- Patched the bug\n${report()}`,
			cwd,
		});
		assert.equal(markdownOnly.status, "rejected");
		assert.match(acceptanceFailureMessage(markdownOnly) ?? "", /diff-summary evidence missing/);

		const structured = await evaluateAcceptance({
			acceptance,
			output: report({ diffSummary: "Patched the bug in src/file.ts." }),
			cwd,
		});
		assert.equal(structured.status, "checked");
	}));

	it("checked acceptance rejects not-satisfied required criteria", async () => withTempRepo(async (cwd) => {
		const acceptance = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { criteria: [{ id: "regression", must: "Regression is covered" }] },
		});
		const ledger = await evaluateAcceptance({
			acceptance,
			output: report({ criteriaSatisfied: [{ id: "regression", status: "not-satisfied", evidence: "test missing" }] }),
			cwd,
		});

		assert.equal(ledger.status, "rejected");
		assert.match(acceptanceFailureMessage(ledger) ?? "", /Required criterion 'regression' was reported as not-satisfied/);
	}));

	it("verify commands derive verified status and stay separate from child command claims", async () => withTempRepo(async (cwd) => {
		const passing = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { criteria: ["Patch bug"], verify: [{ id: "pass", command: "node -e \"process.exit(0)\"", timeoutMs: 10_000 }] },
		});
		const passLedger = await evaluateAcceptance({ acceptance: passing, output: report(), cwd });
		assert.equal(passLedger.status, "verified");
		assert.equal(passLedger.verifyRuns[0]?.status, "passed");

		const failing = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { criteria: ["Patch bug"], verify: [{ id: "fail", command: "node -e \"process.exit(7)\"", timeoutMs: 10_000 }] },
		});
		const failLedger = await evaluateAcceptance({ acceptance: failing, output: report(), cwd });
		assert.equal(failLedger.status, "rejected");
		assert.equal(failLedger.childReport?.commandsRun?.[0]?.result, "passed");
		assert.equal(failLedger.verifyRuns[0]?.status, "failed");
	}));

	it("review gates require independent reviewer provenance", async () => withTempRepo(async (cwd) => {
		const acceptance = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a risky fix",
			explicit: { criteria: ["Patch bug"], review: { agent: "reviewer", required: true } },
		});
		const noBlockers = await evaluateAcceptance({
			acceptance,
			output: report(),
			cwd,
			reviewResult: { status: "no-blockers", findings: [] },
		});
		assert.equal(noBlockers.status, "reviewed");

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
	}));

	it("self-review finalization does not mark a run reviewed or verified by itself", async () => withTempRepo(async (cwd) => {
		const acceptance = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { criteria: ["Patch bug"] },
		});
		const initial = await evaluateAcceptance({ acceptance, output: report({ criteriaSatisfied: [{ id: "criterion-1", status: "not-satisfied", evidence: "missing" }] }), cwd });
		const final = await evaluateAcceptance({ acceptance, output: report(), cwd });
		const turn = createFinalizationTurn({ turn: 1, prompt: "finalize", rawOutput: report(), ledger: final });
		const ledger = attachFinalizationToLedger({ initialLedger: initial, authoritativeLedger: final, turns: [turn], status: "completed", maxTurns: 3 });

		assert.equal(ledger.status, "checked");
		assert.equal(ledger.initialChildReport?.criteriaSatisfied?.[0]?.status, "not-satisfied");
		assert.equal(ledger.childReport?.criteriaSatisfied?.[0]?.status, "satisfied");
		assert.equal(ledger.finalization?.status, "completed");
		assert.notEqual(ledger.status, "verified");
		assert.notEqual(ledger.status, "reviewed");
	}));


	it("validates removed level API, empty contracts, verify shapes, and loop bounds", () => {
		assert.deepEqual(validateAcceptanceInput({ level: "none" }), [
			"acceptance.level is no longer supported; configure criteria, evidence, verify, and review directly.",
			"acceptance must include at least one of criteria, evidence, verify, review, or stopRules.",
		]);
		assert.deepEqual(validateAcceptanceInput({}), ["acceptance must include at least one of criteria, evidence, verify, review, or stopRules."]);
		assert.deepEqual(validateAcceptanceInput({ criteria: [{ must: "Patch bug" }] }), ["acceptance.criteria[0].id is required."]);
		assert.deepEqual(validateAcceptanceInput({ verify: [{ id: "missing-command" }] }), ["acceptance.verify[0].command is required."]);
		assert.deepEqual(validateAcceptanceInput({ criteria: ["Patch bug"], maxFinalizationTurns: 0 }), ["acceptance.maxFinalizationTurns must be an integer from 1 to 10."]);
		assert.deepEqual(validateAcceptanceInput({ criteria: ["Patch bug"], maxFinalizationTurn: 2 }), ["acceptance.maxFinalizationTurn is not supported."]);
	});
});
