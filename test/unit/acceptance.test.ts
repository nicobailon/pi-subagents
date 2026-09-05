import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import {
	acceptanceFailureMessage,
	aggregateAcceptanceReport,
	evaluateAcceptance,
	formatAcceptancePrompt,
	normalizeAcceptanceInput,
	normalizeGateAcceptance,
	parseAcceptanceReport,
	quoteExecutableForShell,
	resolveAcceptanceReportMode,
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

function tempGitRepo(): string {
	const dir = tempRepo();
	execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
	execFileSync("git", ["add", "file.txt"], { cwd: dir });
	execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
	return dir;
}

describe("acceptance gates", () => {
	it("infers evidence levels and review requirements independently", () => {
		assert.equal(resolveEffectiveAcceptance({ agentName: "reviewer", task: "Review-only. Do not edit.", mode: "single" }).level, "none");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "single" }).level, "checked");
		for (const resolved of [
			resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "single", async: true }),
			resolveEffectiveAcceptance({ agentName: "worker", task: "Fix each item", mode: "chain", dynamic: true }),
		]) {
			assert.equal(resolved.level, "checked");
			assert.equal(resolved.review && resolved.review !== false ? resolved.review.required : undefined, true);
		}
	});

	it("omits inferred acceptance for async oracle review tasks despite implementation vocabulary", () => {
		const resolved = resolveEffectiveAcceptance({
			agentName: "oracle",
			task: "Review prep findings and determine what to implement with playbooks instead of before.",
			mode: "single",
			async: true,
		});

		assert.equal(resolved.level, "none");
		assert.deepEqual(resolved.inferredReason, ["read-only/reviewer-style agent"]);
		assert.deepEqual(resolved.criteria, []);
	});

	it("uses explicit agent roles for ambiguous tasks while preserving task-intent precedence", () => {
		assert.equal(resolveEffectiveAcceptance({
			agentName: "explorer",
			acceptanceRole: "read-only",
			task: "Explore the authentication flow",
			mode: "single",
		}).level, "none");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "reviewer",
			acceptanceRole: "writer",
			task: "Handle the authentication flow",
			mode: "single",
		}).level, "checked");
		for (const task of ["Implement the authentication fix", "Create a fixture", "Add coverage", "Replace the dependency", "Patch src/auth.ts"]) {
			assert.equal(resolveEffectiveAcceptance({
				agentName: "worker",
				acceptanceRole: "read-only",
				task,
				mode: "single",
			}).level, "checked", task);
		}
		assert.equal(resolveEffectiveAcceptance({
			agentName: "worker",
			acceptanceRole: "read-only",
			task: "Patch src/auth.ts",
			mode: "single",
			async: true,
		}).level, "checked");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "worker",
			acceptanceRole: "read-only",
			task: "Create a report",
			mode: "single",
		}).level, "none");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "worker",
			acceptanceRole: "writer",
			task: "Review only; do not edit files",
			mode: "single",
		}).level, "none");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "reviewer",
			acceptanceRole: "writer",
			task: "Handle the authentication flow",
			mode: "single",
			async: true,
		}).level, "checked");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "worker",
			acceptanceRole: "read-only",
			task: "Explore the authentication flow",
			mode: "single",
		}).level, "none");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "explorer",
			acceptanceRole: "read-only",
			task: "Audit the security posture",
			mode: "single",
		}).level, "none");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "explorer",
			acceptanceRole: "read-only",
			task: "Explore each target",
			mode: "chain",
			dynamic: true,
		}).level, "none");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "worker",
			acceptanceRole: "writer",
			task: "Review only; do not edit files",
			mode: "chain",
			dynamicGroup: true,
		}).level, "none");
		const dynamicReviewer = resolveEffectiveAcceptance({
			agentName: "reviewer",
			task: "Review each target",
			mode: "chain",
			dynamic: true,
		});
		assert.equal(dynamicReviewer.level, "none");
		assert.equal(formatAcceptancePrompt(dynamicReviewer), "");
	});

	it("preserves risky keyword review inference when acceptance role metadata is omitted", () => {
		for (const task of ["Inspect the security posture", "Read-only security audit"]) {
			const resolved = resolveEffectiveAcceptance({ agentName: "worker", task });
			assert.equal(resolved.level, "checked", task);
			assert.equal(resolved.review && resolved.review !== false ? resolved.review.required : undefined, true, task);
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

	it("agent contract v1 disables inferred acceptance without changing current defaults", () => {
		const current = resolveEffectiveAcceptance({ agentName: "worker", acceptanceRole: "writer", task: "Implement the fix", mode: "single", async: true });
		assert.equal(current.level, "checked");
		assert.equal(current.review && current.review !== false ? current.review.required : undefined, true);
		assert.deepEqual(current.inferredReason, ["async write-capable or risky run"]);

		for (const explicit of [undefined, "auto" as const, false] as const) {
			const resolved = resolveEffectiveAcceptance({ agentName: "worker", acceptanceRole: "writer", task: "Implement the fix", mode: "single", async: true, explicit, agentContract: { version: 1 } });
			assert.equal(resolved.level, "none");
			assert.deepEqual(resolved.inferredReason, []);
			assert.equal(resolved.explicit, explicit !== undefined);
		}
	});

	it("agent contract v1 keeps explicit acceptance report-optional and verify-only", async () => {
		const checked = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement the fix",
			explicit: "checked",
			agentContract: { version: 1 },
		});
		assert.equal(formatAcceptancePrompt(checked, { reportOptional: true }), "");
		const checkedLedger = await evaluateAcceptance({ acceptance: checked, output: "done", cwd: process.cwd(), reportOptional: true });
		assert.equal(checkedLedger.status, "checked");
		assert.equal(acceptanceFailureMessage(checkedLedger), undefined);

		const verified = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement the fix",
			explicit: { level: "verified", verify: [{ id: "ok", command: `${process.execPath} -e "process.exit(0)"` }] },
			agentContract: { version: 1 },
		});
		assert.equal(formatAcceptancePrompt(verified, { reportOptional: true }), "");
		const verifiedLedger = await evaluateAcceptance({ acceptance: verified, output: "done", cwd: process.cwd(), reportOptional: true });
		assert.equal(verifiedLedger.status, "verified");
		assert.equal(verifiedLedger.verifyRuns[0]?.status, "passed");
	});

	it("current/default acceptance still rejects missing required reports", async () => {
		const current = resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", explicit: "checked" });
		const ledger = await evaluateAcceptance({ acceptance: current, output: "done", cwd: process.cwd() });

		assert.equal(ledger.status, "rejected");
		assert.match(acceptanceFailureMessage(ledger) ?? "", /Structured acceptance report not found/);
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
		assert.match(prompt, /empty-string entr(?:y|ies).*\[\s*""\s*\]/i);
		assert.match(prompt, /criteriaSatisfied\[\]\.status.*satisfied, not-satisfied, not-applicable/);
		assert.match(prompt, /commandsRun\[\]\.result.*passed, failed, not-run/);
		assert.match(prompt, /manualNotes.*optional strings.*empty string.*does not satisfy.*manual-notes/);
		assert.match(prompt, /"reviewFindings": \[\n    "blocker:/);
	});

	it("omits inferred read-only prompts while preserving explicit acceptance", () => {
		const inferred = resolveEffectiveAcceptance({
			agentName: "reviewer",
			task: "Review the diff and return findings only.",
		});
		assert.equal(inferred.level, "none");
		assert.equal(formatAcceptancePrompt(inferred), "");

		const explicit = resolveEffectiveAcceptance({
			agentName: "reviewer",
			task: "Review the diff and return findings only.",
			explicit: { level: "checked", criteria: ["Return the review findings"] },
		});
		assert.match(formatAcceptancePrompt(explicit), /```acceptance-report/);

		const explicitCriteria = resolveEffectiveAcceptance({
			agentName: "reviewer",
			task: "Review the diff and return findings only.",
			explicit: { criteria: ["Return the review findings"] },
		});
		assert.equal(explicitCriteria.level, "attested");
		assert.match(formatAcceptancePrompt(explicitCriteria), /```acceptance-report/);
	});

	it("includes every required resolved criterion in report examples", () => {
		const inferred = resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "single", async: true });
		const inferredExample = formatAcceptancePrompt(inferred).match(/```acceptance-report\n([\s\S]*?)\n```/);
		assert.ok(inferredExample?.[1]);
		assert.deepEqual(
			(JSON.parse(inferredExample[1]!) as { criteriaSatisfied: Array<{ id: string }> }).criteriaSatisfied.map((criterion) => criterion.id),
			["criterion-1", "criterion-2"],
		);

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
			"```acceptance-report\n{\"changedFiles\": false}",
			"ACCEPTANCE_REPORT: { not json",
			"ACCEPTANCE_REPORT: no object",
		]) {
			const malformed = parseAcceptanceReport(malformedOutput);
			assert.equal(malformed.report, undefined);
			assert.match(malformed.error ?? "", /Failed to parse acceptance-report/, malformedOutput);
		}
	});

	it("recovers a valid report from an unterminated explicit fence only", () => {
		const recovered = parseAcceptanceReport(`done\n\`\`\`acceptance-report\n${JSON.stringify(reportData())}`);
		assert.deepEqual(recovered.report?.changedFiles, ["src/file.ts"]);
		assert.equal(recovered.error, undefined);

		for (const invalid of [
			"```acceptance-report\n{ not json",
			`\`\`\`acceptance-report\n${JSON.stringify(reportData())}\ntrailing prose`,
			`\`\`\`acceptance-report\n${JSON.stringify({ changedFiles: false })}`,
		]) {
			const parsed = parseAcceptanceReport(invalid);
			assert.equal(parsed.report, undefined);
			assert.match(parsed.error ?? "", /Failed to parse acceptance-report/);
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
			[{ reviewFindings: [{}] }, /reviewFindings\[0\]: expected non-empty string; got object/],
			[{ noStagedFiles: "yes" }, /noStagedFiles: expected boolean; got "yes"/],
		] as const) {
			const parsed = parseAcceptanceReport(report(overrides));
			assert.equal(parsed.report, undefined);
			assert.match(parsed.error ?? "", expected);
		}
	});

	it("tolerates empty-string entries in string-array fields by dropping them at parse time", () => {
		// A model writing ["\"\""] for "no items" must not fail the whole report.
		for (const field of ["changedFiles", "testsAddedOrUpdated", "validationOutput", "residualRisks", "reviewFindings"] as const) {
			const parsed = parseAcceptanceReport(report({ [field]: [""] }));
			assert.equal(parsed.error, undefined, `${field}: ["\"\""] should parse`);
			assert.deepEqual(parsed.report?.[field], [], `${field}: empty-string entries dropped`);
		}

		// Mixed arrays keep only meaningful entries.
		const mixed = parseAcceptanceReport(report({ reviewFindings: ["blocker: file.ts:12", ""] }));
		assert.equal(mixed.error, undefined);
		assert.deepEqual(mixed.report?.reviewFindings, ["blocker: file.ts:12"]);

		// Whitespace-only entries are treated as empty.
		const whitespace = parseAcceptanceReport(report({ validationOutput: ["  "] }));
		assert.equal(whitespace.error, undefined);
		assert.deepEqual(whitespace.report?.validationOutput, []);

		// A single string is still coerced to a one-item array.
		const coerced = parseAcceptanceReport(report({ changedFiles: "src/file.ts" }));
		assert.equal(coerced.error, undefined);
		assert.deepEqual(coerced.report?.changedFiles, ["src/file.ts"]);

		// Structural garbage (non-string entries) is still rejected.
		const invalid = parseAcceptanceReport(report({ reviewFindings: [{}] }));
		assert.equal(invalid.report, undefined);
		assert.match(invalid.error ?? "", /reviewFindings\[0\]: expected non-empty string; got object/);
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

	it("accepts read-only reviewer reports that omit child no-staged-files evidence when the worktree is clean", async () => {
		const cwd = tempGitRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "reviewer",
				task: "Review-only. Do not edit.",
				explicit: { level: "checked", evidence: ["review-findings", "commands-run", "validation-output", "residual-risks"] },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({
					changedFiles: [],
					testsAddedOrUpdated: [],
					validationOutput: ["Read-only review completed."],
					reviewFindings: [],
					noStagedFiles: undefined,
				}),
				cwd,
			});

			assert.equal(ledger.status, "checked");
			assert.equal(ledger.runtimeChecks.find((check) => check.id === "evidence:no-staged-files"), undefined);
			assert.equal(ledger.runtimeChecks.find((check) => check.id === "no-staged-files")?.status, "passed");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("still rejects aggregate no-staged-files evidence when a child worktree reports staged files", async () => {
		const cwd = tempGitRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "reviewer",
				task: "Review-only. Do not edit.",
				explicit: { level: "checked", evidence: ["review-findings", "commands-run", "validation-output", "residual-risks"] },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({
					changedFiles: [],
					testsAddedOrUpdated: [],
					validationOutput: ["Dynamic fanout review completed."],
					reviewFindings: [],
					noStagedFiles: false,
				}),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.equal(ledger.runtimeChecks.find((check) => check.id === "evidence:no-staged-files")?.status, "failed");
			assert.equal(ledger.runtimeChecks.find((check) => check.id === "no-staged-files")?.status, "passed");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("still rejects omitted child no-staged-files evidence when the parent git check finds staged files", async () => {
		const cwd = tempGitRepo();
		try {
			fs.writeFileSync(path.join(cwd, "staged.txt"), "staged\n", "utf-8");
			execFileSync("git", ["add", "staged.txt"], { cwd });
			const acceptance = resolveEffectiveAcceptance({
				agentName: "reviewer",
				task: "Review-only. Do not edit.",
				explicit: { level: "checked", evidence: ["review-findings", "commands-run", "validation-output", "residual-risks"] },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({
					changedFiles: [],
					testsAddedOrUpdated: [],
					validationOutput: ["Read-only review completed."],
					reviewFindings: [],
					noStagedFiles: undefined,
				}),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.equal(ledger.runtimeChecks.find((check) => check.id === "evidence:no-staged-files"), undefined);
			assert.equal(ledger.runtimeChecks.find((check) => check.id === "no-staged-files")?.status, "failed");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /Staged files present/);
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

			const nullDirect = await evaluateAcceptance({
				acceptance,
				output: report({ changedFiles: [], testsAddedOrUpdated: [] }),
				report: null as never,
				cwd,
			});
			assert.equal(nullDirect.status, "rejected");
			assert.match(nullDirect.childReportParseError ?? "", /acceptance-report: expected object; got null/);
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

	it("records achieved, blocked, and pending independent review separately from evidence", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a risky fix",
				explicit: { level: "checked", review: { agent: "reviewer", required: true } },
			});
			const reviewed = await evaluateAcceptance({
				acceptance,
				output: report(),
				cwd,
				reviewResult: { status: "reviewed", findings: [] },
			});
			assert.equal(reviewed.status, "reviewed");
			assert.equal(reviewed.evidenceStatus, "checked");
			assert.equal(reviewed.reviewResult?.status, "reviewed");

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
			assert.equal(blockers.evidenceStatus, "checked");
			assert.equal(blockers.reviewResult?.status, "blockers");

			const pending = await evaluateAcceptance({ acceptance, output: report(), cwd });
			assert.equal(pending.status, "review-required");
			assert.equal(pending.evidenceStatus, "checked");
			assert.equal(pending.reviewResult?.status, "review-required");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps inferred review required when callers explicitly select checked or auto evidence", async () => {
		const cwd = tempRepo();
		try {
			for (const explicit of [{ level: "checked" }, "auto", { level: "auto" }] as const) {
				const acceptance = resolveEffectiveAcceptance({
					agentName: "worker",
					task: "Implement each dynamic item",
					dynamic: true,
					explicit,
				});

				assert.equal(acceptance.level, "checked");
				assert.equal(acceptance.review && acceptance.review !== false ? acceptance.review.required : undefined, true);
				const ledger = await evaluateAcceptance({ acceptance, output: report({ criteriaSatisfied: [
					{ id: "criterion-1", status: "satisfied", evidence: "implemented" },
					{ id: "criterion-2", status: "satisfied", evidence: "evidence returned" },
				] }), cwd });
				assert.equal(ledger.status, "review-required");
				assert.equal(ledger.evidenceStatus, "checked");
				assert.equal(ledger.reviewResult?.status, "review-required");
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("allows an explicit review opt-out without claiming reviewed status", async () => {
		const cwd = tempRepo();
		try {
			for (const review of [false, { agent: "reviewer", required: false }] as const) {
				const acceptance = resolveEffectiveAcceptance({
					agentName: "worker",
					task: "Implement an async fix",
					async: true,
					explicit: { level: "checked", review },
				});
				const ledger = await evaluateAcceptance({
					acceptance,
					output: report({ criteriaSatisfied: [
						{ id: "criterion-1", status: "satisfied", evidence: "implemented" },
						{ id: "criterion-2", status: "satisfied", evidence: "evidence returned" },
					] }),
					cwd,
					reviewResult: { status: "review-required", findings: [] },
				});
				assert.equal(ledger.status, "checked");
				assert.equal(ledger.evidenceStatus, "checked");
				assert.equal(ledger.reviewResult, undefined);
			}
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
				"```acceptance-report\n{\"changedFiles\": false}",
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

	it("records durable malformed report evidence without relaxing rejection", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked" },
			});
			const reportPath = path.join(cwd, "child-report.md");
			const malformed = JSON.stringify({ criteriaSatisfied: true, commandsRun: ["npm test"] });
			const ledger = await evaluateAcceptance({
				acceptance,
				output: "file-only child output",
				fileOutput: { content: `ACCEPTANCE_REPORT: ${malformed}`, path: reportPath, authoritative: true, durable: true },
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.deepEqual(ledger.recovery, {
				status: "available-for-review",
				reason: "acceptance-metadata-rejected",
				reportPath,
				reportHash: createHash("sha256").update(`ACCEPTANCE_REPORT: ${malformed}`).digest("hex"),
			});
			const optional = await evaluateAcceptance({
				acceptance,
				output: "file-only child output",
				fileOutput: { content: `ACCEPTANCE_REPORT: ${malformed}`, path: reportPath, authoritative: true, durable: true },
				cwd,
				reportOptional: true,
			});
			assert.equal(optional.status, "rejected");
			assert.deepEqual(optional.recovery, ledger.recovery);

			const missing = await evaluateAcceptance({
				acceptance,
				output: "file-only child output",
				fileOutput: { content: "artifact without acceptance metadata", path: reportPath, authoritative: true, durable: true },
				cwd,
			});
			assert.equal(missing.status, "rejected");
			assert.equal(missing.recovery, undefined);
			const textOnlyMalformed = await evaluateAcceptance({
				acceptance,
				output: `ACCEPTANCE_REPORT: ${malformed}`,
				fileOutput: { content: "artifact without acceptance metadata", path: reportPath, authoritative: true, durable: true },
				cwd,
			});
			assert.equal(textOnlyMalformed.status, "rejected");
			assert.equal(textOnlyMalformed.recovery, undefined);

			const unmet = await evaluateAcceptance({
				acceptance,
				output: report({ criteriaSatisfied: [{ id: "criterion-1", status: "not-satisfied", evidence: "not proved" }] }),
				fileOutput: { content: report({ criteriaSatisfied: [{ id: "criterion-1", status: "not-satisfied", evidence: "not proved" }] }), path: reportPath, authoritative: true, durable: true },
				cwd,
			});
			assert.equal(unmet.status, "rejected");
			assert.equal(unmet.recovery, undefined);
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
		assert.match(errors[0] ?? "", /^acceptance is an achieved status/);
		assert.match(errors[1] ?? "", /^tasks\[0\]\.acceptance\.level is an achieved status/);
		assert.match(errors[2] ?? "", /^chain\[0\]\.acceptance is an achieved status/);
		assert.match(errors[3] ?? "", /^chain\[1\]\.parallel\[0\]\.acceptance\.level is an achieved status/);
		assert.match(errors[4] ?? "", /^chain\[2\]\.parallel\.acceptance is an achieved status/);
		assert.match(errors.join("\n"), /acceptance\.review\.required/);
	});

	it("rejects transport-permitted true acceptance before execution, including nested inputs", () => {
		const errors = validateExecutionAcceptance({
			acceptance: true,
			tasks: [{ acceptance: true }],
			chain: [{ acceptance: true }, { parallel: [{ acceptance: true }] }, { parallel: { acceptance: true } }],
		});
		const paths = ["acceptance", "tasks[0].acceptance", "chain[0].acceptance", "chain[1].parallel[0].acceptance", "chain[2].parallel.acceptance"];
		assert.equal(errors.length, paths.length);
		paths.forEach((path, index) => assert.ok(errors[index]?.startsWith(`${path} must be a string level, false, or an object.`)));
	});

	it("requires outputSchema for explicit structured acceptance report mode", () => {
		const schema = { type: "object" as const };
		const errors = validateExecutionAcceptance({
			acceptance: { level: "checked", report: "on" },
			tasks: [
				{ acceptance: { level: "checked", report: "off" } },
				{ outputSchema: schema, acceptance: { level: "checked", report: "on" } },
			],
			chain: [
				{ acceptance: { level: "checked", report: "on" } },
				{ outputSchema: schema, acceptance: { level: "checked", report: "off" } },
				{ parallel: [{ acceptance: { level: "checked", report: "on" } }, { outputSchema: schema, acceptance: { level: "checked", report: "on" } }] },
				{ parallel: { acceptance: { level: "checked", report: "off" } } },
			],
		});

		assert.deepEqual(errors, [
			"acceptance.report requires outputSchema.",
			"tasks[0].acceptance.report requires outputSchema.",
			"chain[0].acceptance.report requires outputSchema.",
			"chain[2].parallel[0].acceptance.report requires outputSchema.",
			"chain[3].parallel.acceptance.report requires outputSchema.",
		]);
	});

	it("blanket read-only wording is not inferred as a risky write task", () => {
		const readOnlyWorker = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Report on the extraction pipeline. Do not modify project/source files.",
			async: true,
		});
		assert.equal(readOnlyWorker.level, "none");
		for (const task of [
			"Inspect the extraction pipeline",
			"Summarize the extraction pipeline",
			"Review only: return findings",
			"Analyze the extraction pipeline without edits",
		]) {
			assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task, async: true }).level, "none", task);
		}

		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Inspect the failure and implement the fix" }).level, "checked");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Inspect the failure and implement the fix", async: true }).level, "checked");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Do not modify tests; implement the fix", async: true }).level, "checked");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Do not modify tests but implement the fix", async: true }).level, "checked");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Do not modify tests and implement the fix", async: true }).level, "checked");
		for (const task of [
			"Do not modify tests - implement the fix",
			"Do not modify tests – implement the fix",
			"Do not modify tests — implement the fix",
		]) {
			assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task }).level, "checked", task);
			assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task, async: true }).level, "checked", task);
		}
	});

	it("bare write verbs keep their review requirement for async tasks on any agent", () => {
		const tasks = [
			"Write the code",
			"Commit the changes",
			"Delete temporary data",
			"Remove obsolete assets",
			"Update dependencies",
		];
		for (const task of tasks) {
			const resolved = resolveEffectiveAcceptance({ agentName: "delegate", task, async: true });
			assert.equal(resolved.level, "checked", task);
			assert.equal(resolved.review && resolved.review !== false ? resolved.review.required : undefined, true, task);
		}
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

	it("normalizes one gate command and rejects acceptance combinations", () => {
		assert.deepEqual(normalizeGateAcceptance(" npm run check ", undefined), {
			ok: true,
			acceptance: { level: "verified", verify: [{ id: "gate", command: "npm run check" }] },
		});
		const emptyGate = normalizeGateAcceptance("", undefined);
		assert.equal(emptyGate.ok, false);
		assert.match(emptyGate.error, /non-empty command string/);
		const conflictingGate = normalizeGateAcceptance("npm test", "checked");
		assert.equal(conflictingGate.ok, false);
		assert.match(conflictingGate.error, /cannot be combined with acceptance/);
		assert.match(conflictingGate.error, /Both fields were present: gate="npm test" acceptance="checked"/);
		const oversizedAcceptance = normalizeGateAcceptance("npm test", { level: "checked", evidence: ["a".repeat(200)] });
		assert.equal(oversizedAcceptance.ok, false);
		assert.match(oversizedAcceptance.error || "", /Both fields were present/);
		assert.ok(!(oversizedAcceptance.error || "").includes("a".repeat(200)));
		const disabledAcceptance = normalizeGateAcceptance("npm test", false);
		assert.deepEqual(disabledAcceptance, {
			ok: true,
			acceptance: { level: "verified", verify: [{ id: "gate", command: "npm test" }] },
		});
	});

	it("keeps explicit acceptance.verify arrays as existing verified acceptance", async () => {
		const cwd = tempGitRepo();
		const artifactsDir = path.join(cwd, ".artifacts");
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "run explicit verification",
				explicit: { level: "verified", verify: [
					{ id: "one", command: `${process.execPath} -e "require('node:fs').writeFileSync('one.txt','ok')"` },
					{ id: "two", command: `${process.execPath} -e "require('node:fs').writeFileSync('two.txt','ok')"` },
				] },
				agentContract: { version: 1 },
			});
			const ledger = await evaluateAcceptance({ acceptance, output: "done", cwd, reportOptional: true, artifactsDir, runId: "multi-verify" });
			assert.equal(ledger.status, "verified");
			assert.deepEqual(ledger.verifyRuns.map((run) => [run.id, run.status]), [["one", "passed"], ["two", "passed"]]);
			assert.equal(fs.readFileSync(path.join(cwd, "one.txt"), "utf-8"), "ok");
			assert.equal(fs.readFileSync(path.join(cwd, "two.txt"), "utf-8"), "ok");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("memoizes host verification by tracked Git state, including failures", async () => {
		const cwd = tempGitRepo();
		const artifactsDir = path.join(cwd, ".artifacts");
		const previousInheritedSecret = process.env.GATE_INHERITED_SECRET;
		process.env.GATE_INHERITED_SECRET = "host-secret-not-persisted";
		try {
			const passing = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "run gate",
				explicit: { level: "verified", verify: [{ id: "gate", command: `${process.execPath} -e "process.stdout.write(process.env.GATE_SECRET+':'+process.env.GATE_INHERITED_SECRET);require('node:fs').appendFileSync('count.txt','x')"`, env: { GATE_SECRET: "not-persisted" } }] },
				agentContract: { version: 1 },
			});
			const evaluate = () => evaluateAcceptance({ acceptance: passing, output: "done", cwd, reportOptional: true, artifactsDir, runId: "memo-run" });
			const first = await evaluate();
			const same = await evaluate();
			fs.writeFileSync(path.join(cwd, "untracked.txt"), "ignored\n", "utf-8");
			const untracked = await evaluate();
			process.env.GATE_INHERITED_SECRET = "host-secret-changed";
			const inheritedChanged = await evaluate();
			fs.writeFileSync(path.join(cwd, "file.txt"), "tracked change\n", "utf-8");
			const tracked = await evaluate();
			assert.equal(fs.readFileSync(path.join(cwd, "count.txt"), "utf-8"), "xxx");
			assert.equal(first.verifyRuns[0]?.memoized, false);
			assert.equal(first.verifyRuns[0]?.stdout, "[REDACTED]:[REDACTED]");
			assert.equal(same.verifyRuns[0]?.memoized, true);
			assert.equal(untracked.verifyRuns[0]?.memoized, true);
			assert.equal(inheritedChanged.verifyRuns[0]?.memoized, false);
			assert.equal(inheritedChanged.verifyRuns[0]?.stdout, "[REDACTED]:[REDACTED]");
			assert.equal(tracked.verifyRuns[0]?.memoized, false);
			const artifact = fs.readFileSync(first.verifyRuns[0]!.artifactPath!, "utf-8");
			assert.doesNotMatch(artifact, /not-persisted/);
			assert.doesNotMatch(artifact, /host-secret-not-persisted/);
			assert.doesNotMatch(artifact, /host-secret-changed/);
			assert.match(artifact, /GATE_SECRET/);

			const failing = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "run gate",
				explicit: { level: "verified", verify: [{ id: "gate", command: `${process.execPath} -e "require('node:fs').appendFileSync('fail-count.txt','x');process.exit(7)"` }] },
				agentContract: { version: 1 },
			});
			const failOnce = await evaluateAcceptance({ acceptance: failing, output: "done", cwd, reportOptional: true, artifactsDir, runId: "failure-run" });
			const failCached = await evaluateAcceptance({ acceptance: failing, output: "done", cwd, reportOptional: true, artifactsDir, runId: "failure-run" });
			assert.equal(failOnce.status, "rejected");
			assert.equal(failCached.status, "rejected");
			assert.equal(failCached.verifyRuns[0]?.memoized, true);
			assert.equal(failCached.verifyRuns[0]?.exitCode, 7);
			assert.equal(fs.readFileSync(path.join(cwd, "fail-count.txt"), "utf-8"), "x");
		} finally {
			if (previousInheritedSecret === undefined) delete process.env.GATE_INHERITED_SECRET;
			else process.env.GATE_INHERITED_SECRET = previousInheritedSecret;
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("normalizes JSON-encoded acceptance objects before existing validation", () => {
		const inline = { level: "checked" as const, evidence: ["commands-run" as const, "changed-files" as const] };
		const encoded = JSON.stringify(inline);

		assert.deepEqual(normalizeAcceptanceInput(encoded), inline);
		assert.deepEqual(validateAcceptanceInput(encoded), validateAcceptanceInput(inline));
		assert.match(validateAcceptanceInput(JSON.stringify({ evidence: "commands-run" })).join("\n"), /acceptance\.evidence must be an array/);
		assert.match(validateAcceptanceInput('{"level":"checked"').join("\n"), /acceptance JSON string must encode a valid acceptance object/i);
		assert.match(validateAcceptanceInput(JSON.stringify(["checked"])).join("\n"), /acceptance JSON string must encode an object/i);
	});

	it("validates invalid disable and verify shapes", () => {
		assert.deepEqual(validateAcceptanceInput({ level: "none" }), ["acceptance.reason is required when level is none."]);
		assert.deepEqual(validateAcceptanceInput("none"), ["acceptance level \"none\" requires a reason; use { level: \"none\", reason: \"...\" }."]);
		assert.match(validateAcceptanceInput("verified").join("\n"), /object form with at least one runtime verify command.*Use level "checked" or provide a non-empty acceptance\.verify array/);
		for (const input of [{ level: "verified" }, { level: "verified", verify: [] }]) {
			assert.match(validateAcceptanceInput(input).join("\n"), /at least one runtime command when level is verified.*Use level "checked" or provide a non-empty acceptance\.verify array/);
		}
		assert.deepEqual(validateAcceptanceInput({ level: "verified", verify: [{ id: "tests", command: "npm test" }] }), []);
		assert.deepEqual(validateAcceptanceInput({ level: "verified", verify: [{ id: "tests", command: "npm test" }, { id: "lint", command: "npm run lint" }] }), []);
		assert.deepEqual(validateAcceptanceInput({ level: "checked" }), []);
		assert.deepEqual(validateAcceptanceInput({ level: "checked", report: "on" }), []);
		assert.match(validateAcceptanceInput({ report: "sometimes" }).join("\n"), /acceptance\.report must be on or off/);
		assert.deepEqual(validateAcceptanceInput({ verify: [{ id: "missing-command" }] }), ["acceptance.verify[0].command is required."]);
		assert.deepEqual(validateAcceptanceInput({ verify: [{ id: "fractional", command: "npm test", timeoutMs: 1.5 }] }), ["acceptance.verify[0].timeoutMs must be an integer >= 1."]);
		assert.deepEqual(validateAcceptanceInput(false), []);
		assert.deepEqual(validateAcceptanceInput("checked"), []);
		assert.match(validateAcceptanceInput("reviewed").join("\n"), /achieved status.*omit acceptance.*acceptance\.review\.required/i);
		assert.match(validateAcceptanceInput({ level: "reviewed" }).join("\n"), /achieved status.*omit acceptance.*acceptance\.review\.required/i);
		assert.deepEqual(validateAcceptanceInput({ criteria: ["ship the fix"], review: false, stopRules: ["stay scoped"] }), []);
		assert.match(validateAcceptanceInput({ criteria: [{ id: "missing-must" }] }).join("\n"), /acceptance\.criteria\[0\]\.must is required/);
		assert.match(validateAcceptanceInput({ criteria: [
			{ id: "Release_Check", must: "first" },
			{ id: "release check", must: "second" },
		] }).join("\n"), /acceptance\.criteria\[1\]\.id duplicates normalized criterion id 'release-check'/);
		assert.match(validateAcceptanceInput({ criteria: [123] }).join("\n"), /acceptance\.criteria\[0\] must be a string or an object/);
		assert.match(validateAcceptanceInput({ evidence: "commands-run" }).join("\n"), /acceptance\.evidence must be an array.*Supported evidence kinds:.*commands-run.*changed-files/s);
		assert.match(validateAcceptanceInput({ evidence: ["bogus"] }).join("\n"), /acceptance\.evidence\[0\] "bogus" is not a supported evidence kind.*Supported evidence kinds:.*manual-notes.*Example:/s);
		assert.match(validateAcceptanceInput({ criteria: [{ id: "ship", must: "ship", evidence: ["commands_run"] }] }).join("\n"), /acceptance\.criteria\[0\]\.evidence\[0\] "commands_run" is not a supported evidence kind.*Supported evidence kinds:/s);
		assert.match(validateAcceptanceInput({ review: true }).join("\n"), /acceptance\.review must be false or an object/);
		assert.match(validateAcceptanceInput({ review: { required: "yes" } }).join("\n"), /acceptance\.review\.required must be a boolean/);
		assert.match(validateAcceptanceInput({ stopRules: [123] }).join("\n"), /acceptance\.stopRules\[0\] must be a string/);
		assert.match(validateAcceptanceInput({ surprise: true }).join("\n"), /acceptance\.surprise is not supported/);
	});

	it("resolves structured acceptance report capture without changing the omitted default", () => {
		assert.equal(resolveAcceptanceReportMode(undefined), "optional");
		assert.equal(resolveAcceptanceReportMode("checked"), "optional");
		assert.equal(resolveAcceptanceReportMode(false), "off");
		assert.equal(resolveAcceptanceReportMode({ report: "off" }), "off");
		assert.equal(resolveAcceptanceReportMode({ report: "on" }), "required");
	});
});

describe("quoteExecutableForShell", () => {
	it("quotes an unquoted Windows executable path containing spaces", () => {
		assert.equal(
			quoteExecutableForShell("C:\\Program Files\\vendor\\tool.exe --flag", "win32"),
			"\"C:\\Program Files\\vendor\\tool.exe\" --flag",
		);
	});

	it("quotes an unquoted Windows executable path with parentheses", () => {
		assert.equal(
			quoteExecutableForShell("C:\\Program Files (x86)\\vendor\\tool.exe --flag", "win32"),
			"\"C:\\Program Files (x86)\\vendor\\tool.exe\" --flag",
		);
	});

	it("quotes an extensionless spaced executable before a later drive-root argument", () => {
		assert.equal(
			quoteExecutableForShell("C:\\Program Files\\Tool\\verify C:\\path\\to\\file.exe", "win32"),
			"\"C:\\Program Files\\Tool\\verify\" C:\\path\\to\\file.exe",
		);
	});

	it("quotes an extensionless spaced executable before a flag argument", () => {
		assert.equal(
			quoteExecutableForShell("C:\\Program Files\\Tool\\verify --flag", "win32"),
			"\"C:\\Program Files\\Tool\\verify\" --flag",
		);
	});

	it("quotes an extensionless spaced executable filename before a flag argument", () => {
		assert.equal(
			quoteExecutableForShell("C:\\Program Files\\my tool --flag", "win32"),
			"\"C:\\Program Files\\my tool\" --flag",
		);
	});

	it("quotes a spaced executable before a later drive-root executable argument", () => {
		assert.equal(
			quoteExecutableForShell("C:\\Program Files\\Tool\\verify.exe C:\\path\\to\\file.exe", "win32"),
			"\"C:\\Program Files\\Tool\\verify.exe\" C:\\path\\to\\file.exe",
		);
	});

	it("quotes a spaced executable filename", () => {
		assert.equal(
			quoteExecutableForShell("C:\\Program Files\\my tool.exe --flag", "win32"),
			"\"C:\\Program Files\\my tool.exe\" --flag",
		);
	});

	it("leaves an already-quoted command unchanged", () => {
		const command = "\"C:\\Program Files\\vendor\\tool.exe\" --flag";
		assert.equal(quoteExecutableForShell(command, "win32"), command);
	});

	it("leaves a single-token command unchanged", () => {
		assert.equal(quoteExecutableForShell("phpunit", "win32"), "phpunit");
	});

	it("leaves a first token without spaces unchanged", () => {
		const command = "node script.js --check";
		assert.equal(quoteExecutableForShell(command, "win32"), command);
	});

	it("leaves a Windows executable path without spaces unchanged", () => {
		const command = "C:\\tools\\tool.exe --flag";
		assert.equal(quoteExecutableForShell(command, "win32"), command);
	});

	it("leaves an executable followed by an executable-looking argument unchanged", () => {
		const command = "C:\\tools\\node script.exe";
		assert.equal(quoteExecutableForShell(command, "win32"), command);
	});

	it("quotes a shallow spaced executable filename", () => {
		assert.equal(
			quoteExecutableForShell("C:\\Program Files\\node script.exe", "win32"),
			"\"C:\\Program Files\\node script.exe\"",
		);
	});

	it("leaves ambiguous shell syntax in extensionless commands unchanged", () => {
		const command = "C:\\Program Files\\Tool\\verify&echo C:\\arg";
		assert.equal(quoteExecutableForShell(command, "win32"), command);
	});

	it("leaves a spaced executable argument after an executable unchanged", () => {
		const command = "C:\\tools\\tool.exe C:\\Program Files\\data\\file.exe";
		assert.equal(quoteExecutableForShell(command, "win32"), command);
	});

	it("leaves a spaced executable-looking argument after an extensionless executable unchanged", () => {
		const command = "C:\\tools\\verify C:\\Program Files\\data\\file.exe";
		assert.equal(quoteExecutableForShell(command, "win32"), command);
	});

	it("passes commands through unchanged on non-Windows platforms", () => {
		const command = "/opt/my tools/runner --flag";
		assert.equal(quoteExecutableForShell(command, "linux"), command);
		assert.equal(quoteExecutableForShell(command, "darwin"), command);
	});

	it("leaves ambiguous Windows commands unchanged", () => {
		for (const command of ["tool file.exe", "cmd /c tool.exe", "echo hi > out.exe"]) {
			assert.equal(quoteExecutableForShell(command, "win32"), command);
		}
	});
});
