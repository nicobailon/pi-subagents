import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import type {
	AcceptanceEvidenceKind,
	AcceptanceLedger,
	AcceptanceProvenanceLevel,
	AcceptanceReport,
	AcceptanceRuntimeCheck,
	AcceptanceReviewResult,
	AcceptanceVerifyCommand,
	AcceptanceVerifyResult,
	ResolvedAcceptanceConfig,
	ResolvedAcceptanceGate,
} from "../../shared/types.ts";
import { parseAcceptanceReport } from "./acceptance-reports.ts";

const LEVEL_RANK: Record<AcceptanceProvenanceLevel, number> = {
	none: 0,
	attested: 1,
	checked: 2,
	verified: 3,
	reviewed: 4,
};

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function checkCriteriaSatisfied(criteria: ResolvedAcceptanceGate[], report: AcceptanceReport): AcceptanceRuntimeCheck[] {
	const reports = new Map((report.criteriaSatisfied ?? []).filter((item) => item.id).map((item) => [item.id!, item]));
	return criteria.filter((criterion) => criterion.severity !== "recommended").map((criterion) => {
		const item = reports.get(criterion.id);
		if (!item) return { id: `criterion:${criterion.id}`, status: "failed", message: `Required criterion '${criterion.id}' was not reported.` };
		if (item.status !== "satisfied") return { id: `criterion:${criterion.id}`, status: "failed", message: `Required criterion '${criterion.id}' was reported as ${item.status}.` };
		return { id: `criterion:${criterion.id}`, status: "passed", message: `Required criterion '${criterion.id}' satisfied.` };
	});
}

function reportEvidencePresent(report: AcceptanceReport, kind: AcceptanceEvidenceKind): boolean {
	switch (kind) {
		case "changed-files": return isStringArray(report.changedFiles) && report.changedFiles.length > 0;
		case "tests-added": return isStringArray(report.testsAddedOrUpdated) && report.testsAddedOrUpdated.length > 0;
		case "commands-run": return Array.isArray(report.commandsRun) && report.commandsRun.length > 0;
		case "validation-output": return isStringArray(report.validationOutput) && report.validationOutput.length > 0;
		case "residual-risks": return isStringArray(report.residualRisks);
		case "no-staged-files": return report.noStagedFiles === true;
		case "diff-summary": return typeof report.diffSummary === "string" && report.diffSummary.trim().length > 0;
		case "review-findings": return isStringArray(report.reviewFindings);
		case "manual-notes": return Boolean((report.manualNotes ?? report.notes)?.trim());
	}
}

function checkNoStagedFiles(cwd: string): AcceptanceRuntimeCheck {
	const result = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		return { id: "no-staged-files", status: "not-applicable", message: "git status unavailable; no staged-files check skipped" };
	}
	const staged = result.stdout.split(/\r?\n/).filter((line) => line.length >= 2 && line[0] !== " " && line[0] !== "?");
	return staged.length === 0
		? { id: "no-staged-files", status: "passed", message: "No staged files detected." }
		: { id: "no-staged-files", status: "failed", message: `Staged files present: ${staged.join(", ")}` };
}

function runStructuralChecks(acceptance: ResolvedAcceptanceConfig, report: AcceptanceReport, cwd: string): AcceptanceRuntimeCheck[] {
	const checks: AcceptanceRuntimeCheck[] = [];
	checks.push(...checkCriteriaSatisfied(acceptance.criteria, report));
	for (const kind of acceptance.evidence) {
		const present = reportEvidencePresent(report, kind);
		checks.push({
			id: `evidence:${kind}`,
			status: present ? "passed" : "failed",
			message: present ? `${kind} evidence present.` : `${kind} evidence missing from child report.`,
		});
	}
	if (acceptance.evidence.includes("no-staged-files")) checks.push(checkNoStagedFiles(cwd));
	return checks;
}

function trimOutput(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > 12_000 ? `${trimmed.slice(0, 12_000)}\n...[truncated]` : trimmed;
}

function runVerifyCommand(command: AcceptanceVerifyCommand, defaultCwd: string): Promise<AcceptanceVerifyResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const cwd = command.cwd ? path.resolve(defaultCwd, command.cwd) : defaultCwd;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const child = spawn(command.command, {
			cwd,
			env: { ...process.env, ...(command.env ?? {}) },
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1000).unref?.();
		}, command.timeoutMs ?? 120_000);
		timeout.unref?.();
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (exitCode) => {
			clearTimeout(timeout);
			const durationMs = Date.now() - startedAt;
			const passed = exitCode === 0 && !timedOut;
			resolve({
				id: command.id,
				command: command.command,
				cwd,
				exitCode,
				status: timedOut ? "timed-out" : passed ? "passed" : command.allowFailure ? "allowed-failure" : "failed",
				stdout: trimOutput(stdout),
				stderr: trimOutput(stderr),
				durationMs,
			});
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			resolve({
				id: command.id,
				command: command.command,
				cwd,
				exitCode: 1,
				status: command.allowFailure ? "allowed-failure" : "failed",
				stderr: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startedAt,
			});
		});
	});
}

export async function evaluateAcceptance(input: {
	acceptance: ResolvedAcceptanceConfig;
	output: string;
	cwd: string;
	report?: AcceptanceReport;
	reviewResult?: AcceptanceReviewResult;
}): Promise<AcceptanceLedger> {
	const acceptance = input.acceptance;
	const ledger: AcceptanceLedger = {
		status: acceptance.level === "none" ? "not-required" : "claimed",
		explicit: acceptance.explicit,
		effectiveAcceptance: acceptance,
		inferredReason: acceptance.inferredReason,
		criteria: acceptance.criteria,
		runtimeChecks: [],
		verifyRuns: [],
	};
	if (acceptance.level === "none") return ledger;

	const parsed = input.report ? { report: input.report } : parseAcceptanceReport(input.output);
	if (parsed.report) {
		ledger.childReport = parsed.report;
		ledger.status = "attested";
	} else {
		ledger.childReportParseError = parsed.error;
		ledger.runtimeChecks.push({ id: "attestation", status: "failed", message: parsed.error ?? "Structured acceptance report missing." });
		ledger.status = "rejected";
		return ledger;
	}

	if (LEVEL_RANK[acceptance.level] >= LEVEL_RANK.checked) {
		ledger.runtimeChecks = runStructuralChecks(acceptance, parsed.report, input.cwd);
		if (ledger.runtimeChecks.some((check) => check.status === "failed")) {
			ledger.status = "rejected";
			return ledger;
		}
		ledger.status = "checked";
	}

	if (acceptance.verify.length > 0) {
		ledger.verifyRuns = [];
		for (const command of acceptance.verify) ledger.verifyRuns.push(await runVerifyCommand(command, input.cwd));
		if (ledger.verifyRuns.some((run) => run.status === "failed" || run.status === "timed-out")) {
			ledger.status = "rejected";
			return ledger;
		}
		ledger.status = "verified";
	}

	if (acceptance.review) {
		if (input.reviewResult) {
			ledger.reviewResult = input.reviewResult;
			ledger.status = input.reviewResult.status === "no-blockers" ? "reviewed" : "rejected";
		} else {
			const optionalReview = acceptance.review.required === false;
			ledger.reviewResult = {
				status: "needs-parent-decision",
				findings: [{
					severity: optionalReview ? "non-blocking" : "blocker",
					issue: "Reviewed acceptance requires an independent reviewer result.",
					rationale: "The run cannot be marked reviewed from child self-review or evidence alone.",
				}],
			};
			if (!optionalReview) ledger.status = "rejected";
		}
	}

	return ledger;
}


export function acceptanceFailureMessage(ledger: AcceptanceLedger): string | undefined {
	if (ledger.status !== "rejected") return undefined;
	const failedCheck = ledger.runtimeChecks.find((check) => check.status === "failed");
	if (failedCheck) return `Acceptance rejected: ${failedCheck.message}`;
	const failedVerify = ledger.verifyRuns.find((run) => run.status === "failed" || run.status === "timed-out");
	if (failedVerify) return `Acceptance verification '${failedVerify.id}' ${failedVerify.status}.`;
	if (ledger.reviewResult?.status === "needs-parent-decision") return "Acceptance review required but no automatic reviewer result is available.";
	if (ledger.reviewResult?.status === "blockers") return "Acceptance review found blockers.";
	return "Acceptance rejected.";
}
