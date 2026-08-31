import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyTaskMutationIntent, expectsImplementationMutation, taskMayMutate } from "../../src/runs/shared/task-intent.ts";

describe("classifyTaskMutationIntent", () => {
	it("keeps write imperatives despite investigative wording", () => {
		assert.equal(classifyTaskMutationIntent("worker", "Inspect the failure and implement the fix").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("worker", "Research the current code path and patch the bug").kind, "implementation");
	});

	it("does not broaden the shared completion-guard classifier for role-only path patches", () => {
		assert.equal(classifyTaskMutationIntent("worker", "Patch src/auth.ts").kind, "unknown");
	});

	it("treats scoped no-edit constraints as constraints, not task intent", () => {
		assert.equal(classifyTaskMutationIntent("worker", "Do not modify tests; implement the fix").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("worker", "Fix the bug. Do not edit files outside src/.").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("worker", "Must not touch the production database; implement the fix locally").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("worker", "Do not modify tests\\nImplement the fix").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("worker", "Do not modify tests\\r\\nImplement the fix").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("worker", "Do not modify files\\nin src; implement the fix").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("worker", "Do not modify files\\nin output/; implement the fix").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("worker", "Do not modify files\\nin report/; implement the fix").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("worker", "Do not modify files\\r\\noutside docs; implement the fix").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("worker", "Do not modify files\nin src; implement the fix").kind, "implementation");
	});

	it("stops the prohibition object before a following implementation clause", () => {
		for (const task of [
			"Do not modify tests but implement the fix",
			"Do not modify tests and implement the fix",
			"Do not modify tests: implement the fix",
			"Do not modify tests? Implement the fix",
			"Do not modify tests - implement the fix",
			"Do not modify tests – implement the fix",
			"Do not modify tests — implement the fix",
		]) {
			assert.equal(classifyTaskMutationIntent("worker", task).kind, "implementation", task);
		}
		assert.equal(classifyTaskMutationIntent("worker", "Do not modify tests and fixtures").kind, "read-only");
	});

	it("recognizes coordinated read-only prohibitions", () => {
		for (const task of [
			"Do not read more files, run commands, or edit anything.",
			"Do not read more files, run commands, and edit anything.",
			"Do not read files or modify anything.",
		]) {
			assert.notEqual(classifyTaskMutationIntent("worker", task).kind, "implementation", task);
			assert.equal(expectsImplementationMutation("worker", task), false, task);
			assert.equal(taskMayMutate(task), false, task);
		}
		assert.equal(classifyTaskMutationIntent("worker", "Do not read more files, run commands, or edit anything; implement the fix").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("worker", "Do not read more files, run commands, or edit anything\\r\\nImplement the fix").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("worker", "Do not read more files\\r\\nImplement or edit the fix").kind, "implementation");
		assert.equal(taskMayMutate("Do not read more files\\r\\nImplement or edit the fix"), true);
	});

	it("lets blanket no-edit prohibitions win over write verbs", () => {
		assert.equal(classifyTaskMutationIntent("worker", "Implement this. Do not edit files.").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("worker", "Do not edit files. Tell me how to fix the bug.").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("worker", "Do not modify files\nIn your final response, explain how to implement the fix.").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("worker", "Do not modify files\\nIn your final output, implement the fix.").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("worker", "Do not modify files\\nIn your final output/report/response, implement the fix.").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("worker", "Do not modify files\\nIn your report, explain how to fix the bug.").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("worker", "Report on the extraction pipeline. Do not modify project/source files.").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("reviewer", "Final correctness review after prior fixes. Inspect all changed files and tests. Do not modify project/source files. Report findings.").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("worker", "Verification-only task. Do not edit product/source/config files.\n   Run a disposable check, delete its temporary harness, and retain only\n   a sanitized report at an explicitly named artifact path.").kind, "read-only");
	});

	it("strips repeated prohibition phrases before testing write intent", () => {
		assert.equal(classifyTaskMutationIntent("worker", "Do not modify vendor/. Do not modify generated/. Summarize the build.").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("worker", "Do not modify vendor/. Do not modify generated/. Implement the fix in src/.").kind, "implementation");
	});

	it("classifies research agents and reviewer-style tasks as read-only", () => {
		assert.equal(classifyTaskMutationIntent("researcher", "Research this and patch the bug").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("reviewer", "Review this and fix any real issues").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("oracle", "Review findings and determine what to implement with playbooks instead of before").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("advisor", "Review findings and determine what to implement with playbooks instead of before").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("reviewer", "Review this; regardless of findings, apply changes directly").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("oracle", "Implement the approved file changes").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("advisor", "Implement the approved file changes").kind, "implementation");
	});

	it("keeps report-writing deliverables read-only", () => {
		assert.equal(classifyTaskMutationIntent("worker", "Write a report on the API").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("worker", "Create a summary").kind, "unknown");
	});

	it("does not read hyphenated fix adjectives as the fix verb", () => {
		// Core regression: "must-fix items" in review output specs (fails on old code).
		assert.equal(classifyTaskMutationIntent("worker", "Return a review with the top 2-3 must-fix items").kind, "unknown");
		assert.equal(classifyTaskMutationIntent("worker", "Return a review with the top 2-3 must-fix items.").kind, "unknown");
		assert.equal(classifyTaskMutationIntent("worker", "Review and report MUST-FIX items").kind, "unknown");
		// should-fix with a noun from the pattern's alternation (also fails on old code).
		assert.equal(classifyTaskMutationIntent("worker", "List should-fix tests with severity labels").kind, "unknown");
		// Same class for other verbs: hyphenated adjective + verb.
		assert.equal(classifyTaskMutationIntent("worker", "Return must-edit findings").kind, "unknown");
		assert.equal(classifyTaskMutationIntent("worker", "Return must-update items").kind, "unknown");
		assert.equal(classifyTaskMutationIntent("worker", "List should-add files").kind, "unknown");
		assert.equal(classifyTaskMutationIntent("worker", "Return must-apply changes").kind, "unknown");
		assert.equal(classifyTaskMutationIntent("worker", "List should-make changes").kind, "unknown");
		assert.equal(classifyTaskMutationIntent("worker", "must-do those fixes").kind, "unknown");
		// Dash coverage: U+2010 hyphen, U+2011 non-breaking hyphen, en/em dashes.
		assert.equal(classifyTaskMutationIntent("worker", "Return the must\u2010fix items").kind, "unknown");
		assert.equal(classifyTaskMutationIntent("worker", "Return the must\u2011fix items").kind, "unknown");
		assert.equal(classifyTaskMutationIntent("worker", "Return the must\u2013fix items").kind, "unknown");
		assert.equal(classifyTaskMutationIntent("worker", "Return the must\u2014fix items").kind, "unknown");
		// Clause-level em/en dashes are punctuation, not compounds: "branch—fix it".
		assert.equal(classifyTaskMutationIntent("worker", "Inspect the failing branch\u2014fix it.").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("worker", "Inspect the failing branch\u2013fix it.").kind, "implementation");
		assert.equal(taskMayMutate("Inspect the failing branch\u2014fix it."), true);
		// Hyphenated genuine imperatives stay write-capable.
		assert.equal(taskMayMutate("hot-fix the bug"), true);
		assert.equal(taskMayMutate("quick-fix that bug"), true);
		// Genuine imperative usage keeps classifying as implementation.
		assert.equal(classifyTaskMutationIntent("worker", "Go through the list and fix items one by one").kind, "implementation");
		assert.equal(classifyTaskMutationIntent("worker", "fix items on the sprint board").kind, "implementation");
		// CLI flags keep write intent: "--fix" / "-w" are not hyphenated adjectives.
		assert.equal(classifyTaskMutationIntent("worker", "Run eslint --fix code").kind, "implementation");
		assert.equal(taskMayMutate("Run eslint --fix code"), true);
		// "--write" was never a classifier verb (pre-existing unknown); the
		// regression guard is that write-capability survives for acceptance.
		assert.equal(taskMayMutate("Run prettier --write files"), true);
		// Guard-facing mirror: the completion guard must not expect mutation.
		assert.equal(expectsImplementationMutation("worker", "Return a review with the top 2-3 must-fix items"), false);
	});

	it("expectsImplementationMutation mirrors the classifier", () => {
		assert.equal(expectsImplementationMutation("worker", "Do not modify tests; implement the fix"), true);
		assert.equal(expectsImplementationMutation("worker", "Review the diff and suggest fixes only. Do not edit files."), false);
	});
});

describe("taskMayMutate", () => {
	it("treats any bare write verb as write-capable", () => {
		for (const task of ["Write the code", "Commit the changes", "Delete temporary data", "Remove obsolete assets", "Update dependencies"]) {
			assert.equal(taskMayMutate(task), true, task);
		}
	});

	it("does not count verbs inside prohibitions or read-only deliverables", () => {
		assert.equal(taskMayMutate("Do not modify project/source files. Report findings."), false);
		assert.equal(taskMayMutate("Write a report on the API"), false);
		assert.equal(taskMayMutate("Summarize the build output"), false);
	});

	it("keeps verbs that survive outside a scoped prohibition", () => {
		assert.equal(taskMayMutate("Do not modify tests but implement the fix"), true);
		assert.equal(taskMayMutate("Do not modify tests; update the parser"), true);
	});
});
