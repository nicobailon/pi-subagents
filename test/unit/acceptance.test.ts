import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import {
	acceptanceBlocksRun,
	acceptanceFailureMessage,
	aggregateAcceptanceReport,
	evaluateAcceptance,
	formatAcceptancePrompt,
	mergeAcceptanceContracts,
	parseAcceptanceReport,
	resolveEffectiveAcceptance,
	stripAcceptanceReport,
	validateAcceptanceInput,
	validateExecutionAcceptance,
} from "../../src/runs/shared/acceptance.ts";
import { extractChildWrittenOutput } from "../../src/runs/shared/single-output.ts";

function reportData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "verified in test" }],
		changedFiles: ["src/file.ts"],
		testsAddedOrUpdated: ["test/file.test.ts"],
		commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
		validationOutput: ["tests passed"],
		residualRisks: [],
		noStagedFiles: true,
		notes: "complete",
		...overrides,
	};
}

function report(overrides: Record<string, unknown> = {}, fence = "acceptance-report"): string {
	return [
		"done",
		`\`\`\`${fence}`,
		JSON.stringify(reportData(overrides)),
		"```",
	].join("\n");
}

function tempRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-acceptance-"));
	fs.writeFileSync(path.join(dir, "file.txt"), "hello\n", "utf-8");
	return dir;
}

describe("acceptance gates", () => {
	it("supports canonical off switches and advisory-only auto", () => {
		const disabled = resolveEffectiveAcceptance({ agentName: "worker", task: "Implement a risky fix", explicit: false, async: true });
		assert.equal(disabled.level, "none");
		assert.equal(disabled.report, false);
		assert.deepEqual(disabled.verify, []);
		assert.equal(disabled.review, false);
		assert.deepEqual(disabled.deprecationWarnings, []);

		const deprecatedNone = resolveEffectiveAcceptance({ agentName: "worker", task: "Implement a fix", explicit: "none" });
		assert.equal(deprecatedNone.level, "none");
		assert.match(deprecatedNone.deprecationWarnings.join("\n"), /deprecated.*false/i);

		for (const explicit of [undefined, "auto" as const]) {
			const advisory = resolveEffectiveAcceptance({ agentName: "worker", task: "Implement a risky fix", explicit, async: true });
			assert.equal(advisory.level, "none");
			assert.equal(advisory.onFailure, "warn");
			assert.equal(advisory.report, false);
			assert.ok(advisory.recommendations.length > 0);
		}
	});

	it("normalizes canonical report, verify-only, and failure policy dimensions", async () => {
		const cwd = tempRepo();
		try {
			const reportOnly = resolveEffectiveAcceptance({
				agentName: "worker",
				explicit: { report: { evidence: ["commands-run", "no-staged-files"] } },
			});
			assert.equal(reportOnly.evidence.includes("tests-added"), false);
			const reportLedger = await evaluateAcceptance({
				acceptance: reportOnly,
				output: report({ testsAddedOrUpdated: undefined }),
				cwd,
			});
			assert.notEqual(reportLedger.status, "rejected");

			const verifyOnly = resolveEffectiveAcceptance({
				agentName: "worker",
				explicit: { verify: [{ id: "runtime", command: "node -e \"process.exit(0)\"" }] },
			});
			assert.equal(verifyOnly.report, false);
			const verifyLedger = await evaluateAcceptance({ acceptance: verifyOnly, output: "no report", cwd });
			assert.equal(verifyLedger.status, "verified");
			assert.equal(verifyLedger.verifyRuns[0]?.status, "passed");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("blocks only rejected fail-policy contracts", async () => {
		const cwd = tempRepo();
		try {
			for (const [onFailure, blocks] of [["fail", true], ["warn", false]] as const) {
				const acceptance = resolveEffectiveAcceptance({
					agentName: "worker",
					explicit: { verify: [{ id: "fail", command: "node -e \"process.exit(1)\"" }], onFailure },
				});
				const ledger = await evaluateAcceptance({ acceptance, output: "", cwd });
				assert.equal(ledger.status, "rejected");
				assert.equal(acceptanceBlocksRun(ledger), blocks);
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("merges canonical contracts dimension by dimension with replace and clear semantics", () => {
		const parent = {
			report: { criteria: ["parent"], evidence: ["changed-files" as const] },
			verify: [{ id: "parent", command: "parent" }],
			review: { agent: "reviewer", required: false },
			onFailure: "fail" as const,
		};
		assert.deepEqual(mergeAcceptanceContracts(parent, { report: { criteria: ["child"] }, verify: [] }), {
			report: { criteria: ["child"] },
			verify: [],
			review: { agent: "reviewer", required: false },
			onFailure: "fail",
		});
		assert.deepEqual(mergeAcceptanceContracts(parent, { report: false, review: false }), {
			report: false,
			verify: parent.verify,
			review: false,
			onFailure: "fail",
		});
		assert.equal(mergeAcceptanceContracts(parent, false), false);
	});

	it("strictly validates canonical contracts and rejects legacy ambiguity", () => {
		assert.deepEqual(validateAcceptanceInput({ report: {} }), []);
		assert.match(validateAcceptanceInput({ report: { surprise: true } }).join("\n"), /acceptance\.report\.surprise is not supported/);
		assert.match(validateAcceptanceInput({ report: { criteria: [{ id: "x", must: "one" }, { id: "X", must: "two" }] } }).join("\n"), /duplicates normalized criterion id/);
		assert.match(validateAcceptanceInput({ report: {}, criteria: ["legacy"] }).join("\n"), /mix legacy and canonical/i);
		assert.match(validateAcceptanceInput({ onFailure: "fail", reason: "legacy" }).join("\n"), /mix legacy and canonical/i);
		assert.match(validateAcceptanceInput({ onFailure: "maybe" }).join("\n"), /must be fail or warn/);
		assert.match(validateAcceptanceInput({ review: { required: true } }).join("\n"), /independent reviewer result/i);
	});

	it("keeps role and task inference advisory", () => {
		for (const input of [
			{ agentName: "reviewer", task: "Review-only. Do not edit.", mode: "single" as const },
			{ agentName: "worker", acceptanceRole: "writer" as const, task: "Implement the fix", mode: "single" as const },
			{ agentName: "worker", task: "Implement the fix", mode: "single" as const, async: true },
			{ agentName: "worker", task: "Fix each item", mode: "chain" as const, dynamic: true },
		]) {
			const resolved = resolveEffectiveAcceptance(input);
			assert.equal(resolved.level, "none");
			assert.equal(resolved.onFailure, "warn");
			assert.ok(resolved.recommendations.length > 0);
		}
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
		assert.match(prompt, /array fields contain strings/);
		assert.match(prompt, /criteriaSatisfied\[\]\.status.*satisfied, not-satisfied, not-applicable/);
		assert.match(prompt, /commandsRun\[\]\.result.*passed, failed, not-run/);
		assert.match(prompt, /manualNotes.*optional strings.*empty string.*does not satisfy.*manual-notes/);
		assert.match(prompt, /"reviewFindings": \[\n    "blocker:/);
	});

	it("includes every required resolved criterion in report examples", () => {
		const custom = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement the fix",
			explicit: { level: "checked", criteria: [
				{ id: "required-check", must: "Required", severity: "required" },
				{ id: "recommended-check", must: "Recommended", severity: "recommended" },
			] },
		});
		const customExample = formatAcceptancePrompt(custom).match(/```acceptance-report\n([\s\S]*?)\n```/);
		assert.ok(customExample?.[1]);
		assert.deepEqual(
			(JSON.parse(customExample[1]!) as { criteriaSatisfied: Array<{ id: string }> }).criteriaSatisfied.map((criterion) => criterion.id),
			["required-check"],
		);
	});

	it("parses acceptance-report fences and ignores unrelated json fences", () => {
		const parsed = parseAcceptanceReport(report());

		assert.ok(parsed.report);
		assert.deepEqual(parsed.report.changedFiles, ["src/file.ts"]);
		assert.equal(parsed.error, undefined);

		const genericJson = parseAcceptanceReport(`done\n\
\
\`\`\`json\n{\"notes\":\"not an acceptance report\"}\n\`\`\``);
		assert.equal(genericJson.report, undefined);
		assert.match(genericJson.error ?? "", /Structured acceptance report not found/);

		const criteriaOnlyJson = parseAcceptanceReport(`done\n\
\
\`\`\`json\n{\"criteriaSatisfied\":[{\"id\":\"criterion-1\",\"status\":\"satisfied\",\"evidence\":\"example\"}]}\n\`\`\``);
		assert.equal(criteriaOnlyJson.report, undefined);
		assert.match(criteriaOnlyJson.error ?? "", /Structured acceptance report not found/);

		const criteriaWithUnknownJson = parseAcceptanceReport(`done\n\
\
\`\`\`json\n{\"criteriaSatisfied\":[],\"unexpected\":true}\n\`\`\``);
		assert.equal(criteriaWithUnknownJson.report, undefined);
		assert.match(criteriaWithUnknownJson.error ?? "", /unexpected: unsupported acceptance report field/);

		const invalidSignalJson = `done\n\
\
\`\`\`json\n{\"criteriaSatisfied\":[{\"id\":\"criterion-1\",\"status\":\"satisfied\",\"evidence\":\"example\"}],\"changedFiles\":false}\n\`\`\``;
		const genericJsonWithInvalidSignal = parseAcceptanceReport(invalidSignalJson);
		assert.equal(genericJsonWithInvalidSignal.report, undefined);
		assert.match(genericJsonWithInvalidSignal.error ?? "", /changedFiles: expected string\[\]; got boolean false/);
		assert.equal(stripAcceptanceReport(invalidSignalJson), invalidSignalJson);

		const partialWrapperJson = `done\n\
\
\`\`\`json\n{\"acceptance\":{\"changedFiles\":[\"src/file.ts\"]}}\n\`\`\``;
		const genericJsonWithPartialWrapper = parseAcceptanceReport(partialWrapperJson);
		assert.equal(genericJsonWithPartialWrapper.report, undefined);
		assert.match(genericJsonWithPartialWrapper.error ?? "", /Structured acceptance report not found/);
		assert.equal(stripAcceptanceReport(partialWrapperJson), partialWrapperJson);

		const reportShapedJson = `done\n\
\
\`\`\`json\n{\"changedFiles\":[\"src/file.ts\"]}\n\`\`\``;
		const genericReportShapedJson = parseAcceptanceReport(reportShapedJson);
		assert.equal(genericReportShapedJson.report, undefined);
		assert.match(genericReportShapedJson.error ?? "", /Structured acceptance report not found/);
		assert.equal(stripAcceptanceReport(reportShapedJson), reportShapedJson);

		for (const malformedOutput of [
			"```acceptance-report\n{bad-json\n```",
			"```acceptance-report\n```",
			"```acceptance-report\n{\"criteriaSatisfied\": []}",
			"ACCEPTANCE_REPORT: { not json",
			"ACCEPTANCE_REPORT: no object",
		]) {
			const malformed = parseAcceptanceReport(malformedOutput);
			assert.equal(malformed.report, undefined);
			assert.match(malformed.error ?? "", /Failed to parse acceptance-report/, malformedOutput);
		}
	});

	it("parses acceptance reports from json-family fences", () => {
		for (const fence of ["json", "jsonc", "json5"]) {
			const output = report({}, fence);
			const parsed = parseAcceptanceReport(output);

			assert.ok(parsed.report);
			assert.deepEqual(parsed.report.changedFiles, ["src/file.ts"]);
			assert.equal(parsed.error, undefined);
			assert.equal(stripAcceptanceReport(output), "done");
		}
	});

	it("strips trailing json-family reports after earlier unrelated json fences", () => {
		const output = [
			"metadata",
			"```json",
			JSON.stringify({ notes: "not an acceptance report" }),
			"```",
			"done",
			"```json",
			JSON.stringify(reportData()),
			"```",
		].join("\n");
		const parsed = parseAcceptanceReport(output);

		assert.ok(parsed.report);
		assert.equal(stripAcceptanceReport(output), [
			"metadata",
			"```json",
			JSON.stringify({ notes: "not an acceptance report" }),
			"```",
			"done",
		].join("\n"));
	});

	it("unwraps every accepted report wrapper", () => {
		for (const wrapper of ["acceptance", "acceptance-report", "acceptance_report", "acceptanceReport"]) {
			const output = [
				"done",
				"```json",
				JSON.stringify({ [wrapper]: reportData() }),
				"```",
			].join("\n");
			const parsed = parseAcceptanceReport(output);

			assert.ok(parsed.report, wrapper);
			assert.deepEqual(parsed.report.testsAddedOrUpdated, ["test/file.test.ts"]);
			assert.equal(stripAcceptanceReport(output), "done");
		}
	});

	it("normalizes known report wire variants to the canonical shape", () => {
		const output = [
			"done",
			"```acceptance_report",
			JSON.stringify({ acceptance_report: {
				criteria_satisfied: { id: "Criterion_1", status: "DONE", evidence: "verified" },
				changed_files: "src/file.ts",
				tests_added_or_updated: "test/file.test.ts",
				commands_run: { command: "npm test", result: "success", summary: "passed" },
				validation_output: "tests passed",
				residual_risks: "none",
				no_staged_files: " TRUE ",
				diff_summary: "patched",
				review_findings: "no blockers",
				manual_notes: "complete",
			} }),
			"```",
		].join("\n");
		const parsed = parseAcceptanceReport(output);

		assert.equal(parsed.error, undefined);
		assert.deepEqual(parsed.report, {
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "verified" }],
			changedFiles: ["src/file.ts"],
			testsAddedOrUpdated: ["test/file.test.ts"],
			commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
			validationOutput: ["tests passed"],
			residualRisks: ["none"],
			noStagedFiles: true,
			diffSummary: "patched",
			reviewFindings: ["no blockers"],
			manualNotes: "complete",
		});
		assert.equal(stripAcceptanceReport(output), "done");
	});

	it("normalizes only known enum synonyms and criterion id separators", () => {
		for (const [value, expected] of [
			["met", "satisfied"],
			["not met", "not-satisfied"],
			["not_applicable", "not-applicable"],
		] as const) {
			const parsed = parseAcceptanceReport(report({ criteriaSatisfied: [{ id: "Criterion 1", status: value, evidence: "proof" }] }));
			assert.equal(parsed.report?.criteriaSatisfied?.[0]?.id, "criterion-1");
			assert.equal(parsed.report?.criteriaSatisfied?.[0]?.status, expected);
		}
		for (const [value, expected] of [
			["ok", "passed"],
			["failure", "failed"],
			["not run", "not-run"],
		] as const) {
			const parsed = parseAcceptanceReport(report({ commandsRun: [{ command: "check", result: value, summary: "complete" }] }));
			assert.equal(parsed.report?.commandsRun?.[0]?.result, expected);
		}
	});

	it("rejects unknown and ambiguous report fields with exact diagnostics", () => {
		for (const [value, expected] of [
			[{ ...reportData(), unexpected: true }, /unexpected: unsupported acceptance report field/],
			[{ ...reportData(), changed_files: ["src/other.ts"] }, /changed_files: duplicates normalized field 'changedFiles'/],
			[{ acceptance: reportData(), changedFiles: ["src/file.ts"] }, /changedFiles: unsupported alongside acceptance report wrapper 'acceptance'/],
			[{ acceptance: reportData(), acceptance_report: reportData() }, /multiple acceptance report wrappers are ambiguous/],
		] as const) {
			const parsed = parseAcceptanceReport(`\`\`\`acceptance-report\n${JSON.stringify(value)}\n\`\`\``);
			assert.equal(parsed.report, undefined);
			assert.match(parsed.error ?? "", expected);
		}
	});

	it("rejects unknown enums, duplicate criterion ids, and blank evidence", () => {
		for (const [overrides, expected] of [
			[{ commandsRun: [{ command: "npm test", result: "maybe", summary: "passed" }] }, /commandsRun\[0\]\.result.*got "maybe"/],
			[{ commandsRun: [{ command: "npm test", result: "passed", summary: "", exitCode: 0 }] }, /commandsRun\[0\]\.exitCode: unsupported acceptance command field/],
			[{ commandsRun: [{ command: "npm test", result: "passed", summary: "" }] }, /commandsRun\[0\]\.summary: expected non-empty string; got ""/],
			[{ criteriaSatisfied: [{ id: "criterion-1", status: "maybe", evidence: "proof" }] }, /criteriaSatisfied\[0\]\.status.*got "maybe"/],
			[{ criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "proof", confidence: 1 }] }, /criteriaSatisfied\[0\]\.confidence: unsupported acceptance criterion field/],
			[{ criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "proof" }, { id: "Criterion_1", status: "satisfied", evidence: "proof" }] }, /duplicate normalized criterion id 'criterion-1'/],
			[{ reviewFindings: [""] }, /reviewFindings\[0\]: expected non-empty string; got ""/],
			[{ noStagedFiles: "yes" }, /noStagedFiles: expected boolean; got "yes"/],
		] as const) {
			const parsed = parseAcceptanceReport(report(overrides));
			assert.equal(parsed.report, undefined);
			assert.match(parsed.error ?? "", expected);
		}
	});

	it("accepts empty optional note strings without treating them as evidence", async () => {
		for (const field of ["manualNotes", "notes"] as const) {
			const parsed = parseAcceptanceReport(report({ notes: undefined, [field]: "" }));
			assert.equal(parsed.error, undefined);
			assert.equal(parsed.report?.[field], "");
		}

		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Return a concise result",
				explicit: { level: "attested", evidence: ["manual-notes"] },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({ notes: undefined, manualNotes: "" }),
				cwd,
			});
			assert.equal(ledger.childReportParseError, undefined);
			assert.equal(ledger.childReport?.manualNotes, "");
			assert.equal(ledger.status, "rejected");
			assert.equal(ledger.runtimeChecks.find((check) => check.id === "evidence:manual-notes")?.status, "failed");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("reports field-level validation errors for malformed acceptance-report fields", () => {
		const invalidReviewerReport = parseAcceptanceReport(report({
			reviewFindings: [{ id: "B-1", severity: "blocker", finding: "Missing evidence" }],
		}));
		assert.equal(invalidReviewerReport.report, undefined);
		assert.match(invalidReviewerReport.error ?? "", /reviewFindings\[0\]: expected non-empty string; got object/);

		const invalidCommandReport = parseAcceptanceReport(report({
			commandsRun: [{ command: "npm test", exitCode: 0 }],
		}));
		assert.equal(invalidCommandReport.report, undefined);
		assert.match(invalidCommandReport.error ?? "", /commandsRun\[0\]\.result: expected one of "passed", "failed", "not-run"; got missing/);
		assert.match(invalidCommandReport.error ?? "", /commandsRun\[0\]\.summary: expected non-empty string; got missing/);

		const invalidCriteriaReport = parseAcceptanceReport(report({
			criteriaSatisfied: [{ id: 7, status: "maybe", evidence: "" }],
		}));
		assert.equal(invalidCriteriaReport.report, undefined);
		assert.match(invalidCriteriaReport.error ?? "", /criteriaSatisfied\[0\]\.id: expected string; got number 7/);
		assert.match(invalidCriteriaReport.error ?? "", /criteriaSatisfied\[0\]\.status: expected one of "satisfied", "not-satisfied", "not-applicable"; got "maybe"/);
		assert.match(invalidCriteriaReport.error ?? "", /criteriaSatisfied\[0\]\.evidence: expected non-empty string; got ""/);
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

	it("checked mode accepts explicit empty changed and test arrays as not applicable", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked" },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({ changedFiles: [], testsAddedOrUpdated: [] }),
				cwd,
			});

			assert.equal(ledger.status, "checked");
			assert.equal(ledger.runtimeChecks.find((check) => check.id === "evidence:changed-files")?.status, "not-applicable");
			assert.equal(ledger.runtimeChecks.find((check) => check.id === "evidence:tests-added")?.status, "not-applicable");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("still rejects missing changed and test evidence and empty required commands", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({ agentName: "worker", task: "Implement a fix", explicit: { level: "checked" } });
			const missing = await evaluateAcceptance({ acceptance, output: report({
				changedFiles: undefined,
				testsAddedOrUpdated: undefined,
			}), cwd });
			assert.equal(missing.status, "rejected");
			assert.match(acceptanceFailureMessage(missing) ?? "", /changed-files evidence missing/);

			const missingTests = await evaluateAcceptance({ acceptance, output: report({
				changedFiles: [],
				testsAddedOrUpdated: undefined,
			}), cwd });
			assert.equal(missingTests.status, "rejected");
			assert.match(acceptanceFailureMessage(missingTests) ?? "", /tests-added evidence missing/);

			const emptyCommands = await evaluateAcceptance({
				acceptance,
				output: report({ changedFiles: [], testsAddedOrUpdated: [], commandsRun: [] }),
				cwd,
			});
			assert.equal(emptyCommands.status, "rejected");
			assert.match(acceptanceFailureMessage(emptyCommands) ?? "", /commands-run evidence missing/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("surfaces parse validation details in acceptance failure messages", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "reviewer",
				task: "Review-only. Do not edit.",
				explicit: { level: "attested", evidence: ["review-findings"] },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({ reviewFindings: [{ id: "B-1", finding: "Missing evidence" }] }),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /Failed to parse acceptance-report/);
			assert.match(acceptanceFailureMessage(ledger) ?? "", /reviewFindings\[0\]: expected non-empty string; got object/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("normalizes configured criterion ids and validates direct report objects", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked", criteria: [{ id: "Release_Check", must: "Release check passes" }] },
			});
			const normalized = await evaluateAcceptance({
				acceptance,
				output: report({
					criteriaSatisfied: [{ id: "release check", status: "met", evidence: "verified" }],
					changedFiles: [],
					testsAddedOrUpdated: [],
				}),
				cwd,
			});
			assert.equal(normalized.status, "checked");
			assert.equal(normalized.childReport?.criteriaSatisfied?.[0]?.id, "release-check");

			const malformedDirect = await evaluateAcceptance({
				acceptance,
				output: "",
				report: { ...reportData(), unexpected: true } as never,
				cwd,
			});
			assert.equal(malformedDirect.status, "rejected");
			assert.match(malformedDirect.childReportParseError ?? "", /unexpected: unsupported acceptance report field/);
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
				explicit: { level: "verified", verify: [{ id: "pass", command: "node -e \"process.exit(0)\"", timeoutMs: 10_000 }] },
			});
			const passLedger = await evaluateAcceptance({ acceptance: passing, output: report(), cwd });
			assert.equal(passLedger.status, "verified");
			assert.equal(passLedger.verifyRuns[0]?.status, "passed");

			const failing = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "verified", verify: [{ id: "fail", command: "node -e \"process.exit(7)\"", timeoutMs: 10_000 }] },
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

	it("does not turn recommendations into explicit review requirements", () => {
		const explicit = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement each dynamic item",
			dynamic: true,
			explicit: { level: "checked" },
		});
		assert.equal(explicit.level, "checked");
		assert.equal(explicit.review, false);
		assert.deepEqual(explicit.recommendations, []);

		for (const auto of ["auto", { level: "auto" }] as const) {
			const advisory = resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the async fix", async: true, explicit: auto });
			assert.equal(advisory.level, "none");
			assert.equal(advisory.review, false);
		}
	});

	it("records an optional canonical review honestly without self-certifying", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				explicit: { review: { agent: "reviewer", required: false } },
			});
			const ledger = await evaluateAcceptance({ acceptance, output: "done", cwd });
			assert.equal(ledger.reviewResult?.status, "needs-parent-decision");
			assert.notEqual(ledger.status, "reviewed");
			assert.equal(acceptanceBlocksRun(ledger), false);
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

	it("recovers the acceptance report from child-written configured output", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked" },
			});
			const receipt = "Report written to the configured output file.";

			const withoutFile = await evaluateAcceptance({ acceptance, output: receipt, cwd });
			assert.equal(withoutFile.status, "rejected");

			const ledger = await evaluateAcceptance({
				acceptance,
				output: receipt,
				fileOutput: { content: report(), path: "/tmp/report.md", authoritative: true },
				cwd,
			});
			assert.equal(ledger.status, "checked");
			assert.ok(ledger.childReport);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("report source order follows output authority", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked" },
			});
			const inline = await evaluateAcceptance({
				acceptance,
				output: report({ notes: "from text" }),
				fileOutput: { content: report({ notes: "from file" }), path: "/tmp/report.md" },
				cwd,
			});
			assert.equal(inline.childReport?.notes, "from text");

			const fileOnly = await evaluateAcceptance({
				acceptance,
				output: report({ notes: "from text" }),
				fileOutput: { content: report({ notes: "from file" }), path: "/tmp/report.md", authoritative: true },
				cwd,
			});
			assert.equal(fileOnly.childReport?.notes, "from file");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("sibling overwrites of a shared output path cannot pollute this child's acceptance", async () => {
		const cwd = tempRepo();
		const sharedPath = path.join(cwd, "context.md");
		try {
			// Sibling child B wrote the shared path last (issue #420); the disk
			// content is B's. Child A's acceptance input comes from A's own
			// successful write-tool call, so B's report must not be attributed to A.
			fs.writeFileSync(sharedPath, report({ notes: "sibling B report" }), "utf-8");
			const childAMessages: Message[] = [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "w1", name: "write", arguments: { path: sharedPath, content: report({ notes: "child A report" }) } }],
					api: "test",
					provider: "test",
					model: "mock/test-model",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: 0,
				},
				{ role: "toolResult", toolCallId: "w1", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 },
			];
			const childAContent = extractChildWrittenOutput(childAMessages, sharedPath, cwd);
			assert.equal(typeof childAContent, "string");

			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked" },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: "Report written to the configured output file.",
				fileOutput: { content: childAContent!, path: sharedPath, authoritative: true },
				cwd,
			});
			assert.equal(ledger.childReport?.notes, "child A report");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects a malformed primary report instead of falling back to the secondary source", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked" },
			});
			const malformedReports = [
				"```acceptance-report\n{ not json\n```",
				"```acceptance-report\n```",
				"```acceptance-report\n{\"criteriaSatisfied\": []}",
				"ACCEPTANCE_REPORT: { not json",
			];

			for (const malformed of malformedReports) {
				const fileOnly = await evaluateAcceptance({
					acceptance,
					output: report({ notes: "valid text report" }),
					fileOutput: { content: malformed, path: "/tmp/report.md", authoritative: true },
					cwd,
				});
				assert.equal(fileOnly.status, "rejected", malformed);
				assert.match(fileOnly.childReportParseError ?? "", /configured output/, malformed);
			}

			const inline = await evaluateAcceptance({
				acceptance,
				output: malformedReports[0]!,
				fileOutput: { content: report({ notes: "valid file report" }), path: "/tmp/report.md" },
				cwd,
			});
			assert.equal(inline.status, "rejected");
			assert.match(inline.childReportParseError ?? "", /Failed to parse acceptance-report/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("surfaces field-level errors from an invalid configured-output report", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked" },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: "wrote the report to the file",
				fileOutput: {
					content: report({ criteriaSatisfied: [{ id: "criterion-1", status: "partially_done", evidence: "x" }] }),
					path: "/tmp/report.md",
				},
				cwd,
			});
			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /partially_done/);
			assert.match(acceptanceFailureMessage(ledger) ?? "", /configured output/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("validates explicit reviewed acceptance at every execution nesting level", () => {
		const errors = validateExecutionAcceptance({
			acceptance: "reviewed",
			tasks: [{ acceptance: { level: "reviewed" } }],
			chain: [
				{ acceptance: "reviewed" },
				{ parallel: [{ acceptance: { level: "reviewed" } }] },
				{ parallel: { acceptance: "reviewed" } },
			],
		});

		assert.equal(errors.length, 5);
		assert.match(errors[0] ?? "", /^acceptance cannot be requested explicitly/);
		assert.match(errors[1] ?? "", /^tasks\[0\]\.acceptance\.level cannot be requested explicitly/);
		assert.match(errors[2] ?? "", /^chain\[0\]\.acceptance cannot be requested explicitly/);
		assert.match(errors[3] ?? "", /^chain\[1\]\.parallel\[0\]\.acceptance\.level cannot be requested explicitly/);
		assert.match(errors[4] ?? "", /^chain\[2\]\.parallel\.acceptance cannot be requested explicitly/);
		assert.match(errors.join("\n"), /independent reviewer result/);
	});

	it("keeps read-only and write-task heuristics in recommendations only", () => {
		const readOnly = resolveEffectiveAcceptance({ agentName: "worker", task: "Review only; do not edit", async: true });
		const writer = resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", async: true });
		assert.equal(readOnly.level, "none");
		assert.equal(writer.level, "none");
		assert.notDeepEqual(readOnly.recommendations, writer.recommendations);
	});

	it("explicit levels are honored over a read-only inference without silent escalation", () => {
		const resolved = resolveEffectiveAcceptance({
			agentName: "researcher",
			task: "Research PDF backends. Do not modify project/source files.",
			explicit: "checked",
			async: true,
		});
		assert.equal(resolved.level, "checked");
	});

	it("validates invalid disable and verify shapes", () => {
		assert.deepEqual(validateAcceptanceInput({ level: "none" }), []);
		assert.deepEqual(validateAcceptanceInput("none"), []);
		assert.deepEqual(validateAcceptanceInput({ verify: [{ id: "missing-command" }] }), ["acceptance.verify[0].command is required."]);
		assert.deepEqual(validateAcceptanceInput({ verify: [{ id: "fractional", command: "npm test", timeoutMs: 1.5 }] }), ["acceptance.verify[0].timeoutMs must be an integer >= 1."]);
		assert.deepEqual(validateAcceptanceInput(false), []);
		assert.deepEqual(validateAcceptanceInput("checked"), []);
		assert.match(validateAcceptanceInput("reviewed").join("\n"), /cannot be requested explicitly.*independent reviewer result/i);
		assert.match(validateAcceptanceInput({ level: "reviewed" }).join("\n"), /cannot be requested explicitly.*independent reviewer result/i);
		assert.deepEqual(validateAcceptanceInput({ criteria: ["ship the fix"], review: false, stopRules: ["stay scoped"] }), []);
		assert.match(validateAcceptanceInput({ criteria: [{ id: "missing-must" }] }).join("\n"), /acceptance\.criteria\[0\]\.must is required/);
		assert.match(validateAcceptanceInput({ criteria: [
			{ id: "Release_Check", must: "first" },
			{ id: "release check", must: "second" },
		] }).join("\n"), /acceptance\.criteria\[1\]\.id duplicates normalized criterion id 'release-check'/);
		assert.match(validateAcceptanceInput({ criteria: [123] }).join("\n"), /acceptance\.criteria\[0\] must be a string or an object/);
		assert.match(validateAcceptanceInput({ evidence: ["bogus"] }).join("\n"), /acceptance\.evidence\[0\] is not a supported evidence kind/);
		assert.match(validateAcceptanceInput({ review: true }).join("\n"), /acceptance\.review must be false or an object/);
		assert.match(validateAcceptanceInput({ review: { required: "yes" } }).join("\n"), /acceptance\.review\.required must be a boolean/);
		assert.match(validateAcceptanceInput({ stopRules: [123] }).join("\n"), /acceptance\.stopRules\[0\] must be a string/);
		assert.match(validateAcceptanceInput({ surprise: true }).join("\n"), /acceptance\.surprise is not supported/);
	});
});
