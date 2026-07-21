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

	it("lets blanket no-edit prohibitions win over write verbs", () => {
		assert.equal(classifyTaskMutationIntent("worker", "Implement this. Do not edit files.").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("worker", "Do not edit files. Tell me how to fix the bug.").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("worker", "Report on the extraction pipeline. Do not modify project/source files.").kind, "read-only");
		assert.equal(classifyTaskMutationIntent("reviewer", "Final correctness review after prior fixes. Inspect all changed files and tests. Do not modify project/source files. Report findings.").kind, "read-only");
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
