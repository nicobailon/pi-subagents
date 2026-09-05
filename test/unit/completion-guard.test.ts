import test from "node:test";
import assert from "node:assert/strict";

import type { Message } from "@earendil-works/pi-ai";

import {
	evaluateCompletionMutationGuard,
	expectsImplementationMutation,
	hasMutationToolCall,
	validateImplementationToolContract,
} from "../../src/runs/shared/completion-guard.ts";
import { isMutatingTool } from "../../src/runs/shared/long-running-guard.ts";

function assistantToolCall(name: string, args: Record<string, unknown> = {}): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", name, arguments: args }],
	} as unknown as Message;
}

function assistantText(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	} as unknown as Message;
}

test("implementation task with no mutation triggers the completion guard", () => {
	for (const report of [
		"No better current-scope change is needed.",
		"Kept the current implementation. No new code or test changes were made in this challenge pass.",
	]) {
		const result = evaluateCompletionMutationGuard({
			agent: "worker",
			task: "Implement the approved fix",
			messages: [assistantText(report)],
		});

		assert.deepEqual(result, {
			expectedMutation: true,
			attemptedMutation: false,
			triggered: true,
			blocked: false,
		});
	}
});

function revivedTask(followUp: string): string {
	return [
		"You are reviving a previous subagent conversation.",
		"",
		"Original run: abc123",
		"Original agent: worker",
		"Original session file: /tmp/session.jsonl",
		"",
		"Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child session is still running.",
		"",
		"Follow-up:",
		followUp,
	].join("\n");
}

const implementationChallengeTask = revivedTask("Run implementation challenge pass two and implement any better current-scope change.");

test("implementation challenges may complete with explicit no-change reports", () => {
	for (const report of [
		"No better current-scope change is needed.",
		[
			"Kept the current implementation. No new code or test changes were made in this challenge pass.",
			"Reason: the current candidate is the smallest correct shape.",
		].join("\n\n"),
		"The current implementation was kept. No code changes were made.",
		"The current candidate was kept. No source changes were made.",
		"The current shape was kept. No file or test changes were made.",
		"Kept the current implementation. No code/source/file/test changes were made.",
		"Kept the current implementation. No code, source, or test changes were made.",
		"No better current-scope change is needed.\n\nReason: I cannot identify a smaller safe change.",
		"No better current-scope change is needed because I did not identify a smaller safe change.",
		"No better current-scope change is needed because no work remains.",
		"No better current-scope change is needed. I haven't identified required changes.",
		"No better current-scope change is needed. I haven’t identified required changes.",
		"No better current-scope change is needed; I did not identify a smaller safe change.",
		"No better current-scope change is needed, since I did not identify a smaller safe change.",
		"No better current-scope change is needed, I did not identify a smaller safe change.",
		"No better current-scope change is needed, the current implementation does not require further edits.",
		"No better current-scope change is needed; the current implementation does not require further edits.",
		"No better current-scope change is needed, but the current implementation does not require further edits.",
		"Kept the current implementation. No code changes were made.\n\nReason: this does not need a broader rewrite.",
		"Kept the current implementation; I did not identify a smaller safe change. No code changes were made.",
		"Kept the current implementation. No code changes were made, since I did not identify a smaller safe change.",
		"Kept the current implementation. No code changes were made, I did not identify a smaller safe change.",
		"Kept the current implementation, the current candidate does not need more work. No code changes were made.",
		"Kept the current implementation; the current candidate does not need more work. No code changes were made.",
		"Kept the current implementation because I did not identify a smaller safe change. No code changes were made.",
		"Kept the current implementation. No code changes were made because I did not identify a smaller safe change.",
	]) {
		const result = evaluateCompletionMutationGuard({
			agent: "worker",
			task: implementationChallengeTask,
			messages: [assistantText(report)],
		});

		assert.deepEqual(result, {
			expectedMutation: true,
			attemptedMutation: false,
			triggered: false,
			blocked: false,
		});
	}
});

test("implementation challenge reports require both a kept-current rationale and no-change statement", () => {
	for (const report of [
		"Kept the current implementation.",
		"No new code or test changes were made in this challenge pass.",
		"Kept the current implementation. No new code or test changes were made, but I am uncertain.",
	]) {
		assert.equal(evaluateCompletionMutationGuard({
			agent: "worker",
			task: implementationChallengeTask,
			messages: [assistantText(report)],
		}).triggered, true, report);
	}
});

test("implementation challenge reports require current kept/no-change claims", () => {
	for (const report of [
		"The previous message said \"Kept the current implementation. No code changes were made\".",
		"The prior report stated Kept the current implementation. No code changes were made.",
		"The previous message said \"Kept the current implementation. No code changes were made\". Kept the current implementation.",
		"'Kept the current implementation. No code changes were made.'",
	]) {
		assert.equal(evaluateCompletionMutationGuard({
			agent: "worker",
			task: implementationChallengeTask,
			messages: [assistantText(report)],
		}).triggered, true, report);
	}
});

test("implementation challenge reports with later implementation retractions remain guarded", () => {
	for (const report of [
		"No better current-scope change is needed. I found a required code change.",
		"Kept the current implementation. No code changes were made. Implementation work remains.",
		"No better current-scope change is needed. A code change is needed.",
		"Kept the current implementation. No code changes were made. I need to implement the fix.",
		"No better current-scope change is needed, but I found a required code change.",
		"No better current-scope change is needed\nI found a required code change.",
		"No better current-scope change is needed. I found required changes.",
		"No better current-scope change is needed. Code changes are needed.",
		"No better current-scope change is needed. Changes are needed.",
		"No better current-scope change is needed because no work remains. Code changes are needed.",
		"No better current-scope change is needed. I need changes.",
		"No better current-scope change is needed. We need edits.",
		"Kept the current implementation. No code changes were made. I need changes.",
		"Kept the current implementation. No code changes were made. We need patches.",
		"No better current-scope change is needed. That claim is rejected.",
		"No better current-scope change is needed. This report is retracted.",
		"No better current-scope change is needed. Required changes.",
		"No better current-scope change is needed. Need changes.",
		"No better current-scope change is needed, I disagree.",
		"No better current-scope change is needed; I disagree.",
		"Kept the current implementation. No code changes were made, I reject.",
		"Kept the current implementation. No code changes were made; I reject.",
		"No better current-scope change is needed: I disagree.",
		"No better current-scope change is needed — I disagree.",
		"No better current-scope change is needed. \"I reject.\"",
		"No better current-scope change is needed. 'I reject.'",
		"No better current-scope change is needed. ‘I reject.’",
		"Kept the current implementation. No code changes were made: I reject.",
		"Kept the current implementation. No code changes were made. \"I retract.\"",
		"No better current-scope change is needed. I disagree.",
		"No better current-scope change is needed. I reject.",
		"No better current-scope change is needed. I retract.",
		"Kept the current implementation. No code changes were made. I disagree.",
		"Kept the current implementation. No code changes were made. I reject.",
		"Kept the current implementation. No code changes were made. I retract.",
		"No better current-scope change is needed. I disagree with that.",
		"No better current-scope change is needed. I retract that.",
		"No better current-scope change is needed. I reject that.",
		"Kept the current implementation. No code changes were made. I disagree with that.",
		"Kept the current implementation. No code changes were made. I retract that.",
		"Kept the current implementation. No code changes were made. I reject that.",
	]) {
		assert.equal(evaluateCompletionMutationGuard({
			agent: "worker",
			task: implementationChallengeTask,
			messages: [assistantText(report)],
		}).triggered, true, report);
	}
});

test("revived implementation tasks that mention implementation challenge remain guarded", () => {
	for (const followUp of [
		"Fix the implementation challenge completion guard bug.",
		"Implementation challenge pass 1. Implement the required fix.",
		"Implementation challenge pass 1 and implement the fix.",
	]) {
		const result = evaluateCompletionMutationGuard({
			agent: "worker",
			task: revivedTask(followUp),
			messages: [assistantText("No better current-scope change is needed.")],
		});

		assert.deepEqual(result, {
			expectedMutation: true,
			attemptedMutation: false,
			triggered: true,
			blocked: false,
		}, followUp);
	}
});

test("implementation challenge reports with negated or uncertain no-better-change claims remain guarded", () => {
	for (const report of [
		"I cannot say no better current-scope change is needed.",
		"The previous message said \"No better current-scope change is needed\", but I disagree.",
		"The previous message said \"Kept the current implementation. No code changes were made\", but I disagree.",
		"The previous message said \"Kept the current implementation. No code changes were made\", but that was wrong.",
		"The previous message said \"Kept the current implementation. No code changes were made\", but that was false.",
		"The previous message said \"Kept the current implementation. No code changes were made\", but I reject that.",
		"The previous message said \"Kept the current implementation. No code changes were made\". I reject that.",
		"The previous message said \"Kept the current implementation. No code changes were made\". I reject this.",
		"The previous message said \"Kept the current implementation. No code changes were made\". I disagree.",
		"The previous message said \"Kept the current implementation. No code changes were made\", but it was rejected.",
		"The previous message said \"Kept the current implementation. No code changes were made\", but I am rejecting it.",
		"The prior report stated no better current-scope change is needed.",
		"I don't think no better current-scope change is needed.",
		"I dont think no better current-scope change is needed.",
		"I do not think no better current-scope change is needed.",
		"I cant say no better current-scope change is needed.",
		"It is unclear whether no better current-scope change is needed.",
		"Maybe no better current-scope change is needed.",
	]) {
		assert.equal(evaluateCompletionMutationGuard({
			agent: "worker",
			task: implementationChallengeTask,
			messages: [assistantText(report)],
		}).triggered, true, report);
	}

});

test("source_check read-only capability suppresses an implementation completion guard", () => {
	assert.equal(expectsImplementationMutation("worker", "Implement the approved fix"), true);
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Implement the approved fix",
		messages: [assistantText("Source evidence only")],
		tools: ["source_check"],
	});

	assert.deepEqual(result, {
		expectedMutation: false,
		attemptedMutation: false,
		triggered: false,
		blocked: false,
	});
});

test("hyphenated fix adjectives in review tasks do not trigger the completion guard", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Return a review with the top 2-3 must-fix items.",
		messages: [assistantText("Review: findings with severity labels.")],
	});

	assert.deepEqual(result, {
		expectedMutation: false,
		attemptedMutation: false,
		triggered: false,
		blocked: false,
	});
	assert.equal(
		expectsImplementationMutation("worker", "Return a review with the top 2-3 must-fix items."),
		false,
	);
});

test("read-only issue drafting tasks do not trigger on suggested fix wording", () => {
	const task = "Draft GitHub issue for pi-subagents bug from current conversation. Include title, environment/context, reproduction steps, actual/expected, logs excerpt, suspected cause, suggested fix. Terse but complete. No tools needed.";
	const result = evaluateCompletionMutationGuard({
		agent: "delegate",
		task,
		messages: [assistantText("Title: completionGuard false positive\n\nSuggested fix: model read-only intent.")],
		tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
	});

	assert.deepEqual(result, {
		expectedMutation: false,
		attemptedMutation: false,
		triggered: false,
		blocked: false,
	});
	assert.equal(expectsImplementationMutation("worker", task), false);
	assert.equal(
		expectsImplementationMutation("worker", "Draft GitHub issue for a bug. Include suspected cause and suggested fix."),
		false,
	);
});

test("omitted, bash, unknown, write, and MCP tool capabilities stay conservative while empty tools are toolless", () => {
	const base = {
		agent: "architect",
		task: "Implement the approved source fix",
		messages: [assistantText("Validation only")],
	};

	assert.equal(evaluateCompletionMutationGuard(base).triggered, true);
	assert.equal(evaluateCompletionMutationGuard({ ...base, tools: [] }).triggered, false);
	assert.equal(evaluateCompletionMutationGuard({ ...base, tools: ["read", "bash", "ls"] }).triggered, true);
	assert.equal(evaluateCompletionMutationGuard({ ...base, tools: ["read", "custom_lookup"] }).triggered, true);
	assert.equal(evaluateCompletionMutationGuard({ ...base, tools: ["read", "write"] }).triggered, true);
	assert.equal(evaluateCompletionMutationGuard({ ...base, tools: ["read", "grep"], mcpDirectTools: ["github/search"] }).triggered, true);
});

test("worker with mutating-capable tools still triggers when no mutation is observed", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Fix the test implementation",
		messages: [assistantText("I will edit it next")],
		tools: ["read", "edit"],
	});

	assert.deepEqual(result, {
		expectedMutation: true,
		attemptedMutation: false,
		triggered: true,
		blocked: false,
	});
});

test("missing child tools block mutation effects instead of triggering no-edit blame", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Implement the requested source fix",
		messages: [assistantText("I cannot edit because tools are missing.")],
		tools: ["read", "fixture_search"],
		toolAvailabilityError: "Agent 'worker' requested unavailable child tools: fixture_search.",
	});

	assert.deepEqual(result, {
		expectedMutation: true,
		attemptedMutation: false,
		triggered: false,
		blocked: true,
		message: "Agent 'worker' requested unavailable child tools: fixture_search.",
	});
});

test("implementation tool contract rejects read-only worker launches", () => {
	assert.match(
		validateImplementationToolContract({
			agent: "worker",
			task: "Implement the requested source fix",
			tools: ["read", "grep", "find", "ls", "contact_supervisor"],
		}) ?? "",
		/no mutation-capable tools/,
	);
	assert.equal(validateImplementationToolContract({
		agent: "worker",
		task: "Review only and return findings",
		tools: ["read", "grep", "find", "ls"],
	}), undefined);
	assert.equal(validateImplementationToolContract({
		agent: "worker",
		task: "Implement the requested source fix",
		tools: ["read", "edit"],
	}), undefined);
	assert.match(
		validateImplementationToolContract({
			agent: "worker",
			task: "Implement the requested source fix",
			tools: ["read", "structured_output"],
		}) ?? "",
		/no mutation-capable tools/,
	);
	assert.equal(validateImplementationToolContract({
		agent: "worker",
		task: "Implement the requested source fix",
		tools: ["read", "/tmp/mutation-tools.ts"],
	}), undefined);
	assert.equal(validateImplementationToolContract({
		agent: "worker",
		task: "Implement the requested source fix",
	}), undefined);
});

test("oracle review tasks with bash available do not require mutation", () => {
	const task = "Review prep findings and determine what to implement with playbooks instead of before.";
	const result = evaluateCompletionMutationGuard({
		agent: "oracle",
		task,
		messages: [assistantText("Review complete with file-backed findings.")],
		tools: ["read", "grep", "find", "ls", "bash", "intercom"],
	});

	assert.deepEqual(result, {
		expectedMutation: false,
		attemptedMutation: false,
		triggered: false,
		blocked: false,
	});
});

test("review-only, research, and framework output instructions do not expect mutation", () => {
	assert.equal(expectsImplementationMutation("worker", "Review only: return findings, do not edit"), false);
	assert.equal(expectsImplementationMutation("worker", "Do not edit files. Tell me how to fix the bug."), false);
	assert.equal(expectsImplementationMutation("worker", "Review the diff and suggest fixes only. Do not edit files."), false);
	assert.equal(expectsImplementationMutation("worker", "Implement this. Do not edit files outside this repo. Do not edit files."), false);
	assert.equal(expectsImplementationMutation("worker", "Investigate why this failed"), false);
	assert.equal(expectsImplementationMutation("researcher", "Research the API behavior"), false);
	assert.equal(expectsImplementationMutation("researcher", "Research this and patch the bug"), false);
	assert.equal(expectsImplementationMutation("reviewer", "Review this and fix any real issues"), false);
	assert.equal(expectsImplementationMutation("reviewer", "Review this and fix any real issues; regardless of findings, apply changes directly"), true);
	assert.equal(expectsImplementationMutation("worker", "[Write to: /tmp/result.md]\n\nSummarize findings"), false);
	assert.equal(expectsImplementationMutation("worker", "Write report"), false);
	assert.equal(expectsImplementationMutation("worker", "Create a report"), false);
	assert.equal(expectsImplementationMutation("worker", "Create a summary"), false);
	assert.equal(expectsImplementationMutation("worker", "Add a report"), false);
	assert.equal(expectsImplementationMutation("worker", "Update a summary"), false);
	assert.equal(expectsImplementationMutation("worker", "Write to {chain_dir}"), false);
	assert.equal(
		expectsImplementationMutation("worker", "Do async work\nUpdate progress at: /tmp/progress.md\n**Output:**\nWrite your findings to exactly this path: /tmp/out.md\nThis path is authoritative for this run.\nIgnore any other output filename or output path mentioned elsewhere."),
		false,
	);
});

test("escaped line separators do not hide read-only prohibitions", () => {
	const task = [
		"This is a read-only skill compliance scenario, not an implementation assignment.",
		"Read the supplied skill and write the exact user-facing response.",
		"Do not edit files.",
		"Use a scenario that discusses selection for an implementation task or closeout of an implementation assignment.",
	].join("\\n");

	assert.deepEqual(evaluateCompletionMutationGuard({
		agent: "delegate",
		task,
		messages: [assistantText("The exact user-facing response")],
		tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
	}), {
		expectedMutation: false,
		attemptedMutation: false,
		triggered: false,
		blocked: false,
	});
});

test("output instructions after blanket no-edit prohibitions stay read-only", () => {
	assert.deepEqual(evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Do not modify files\\nIn your final output, implement the fix.",
		messages: [assistantText("Here is the explanation.")],
		tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
	}), {
		expectedMutation: false,
		attemptedMutation: false,
		triggered: false,
		blocked: false,
	});
	assert.equal(expectsImplementationMutation("worker", "Do not modify files\\nIn your final output/report/response, implement the fix."), false);
});

test("worker implementation verbs win over investigative wording and scoped prohibitions", () => {
	assert.equal(expectsImplementationMutation("worker", "Investigate why the worker did not edit files and fix it"), true);
	assert.equal(expectsImplementationMutation("worker", "Do not modify tests; implement the fix"), true);
	assert.equal(expectsImplementationMutation("worker", "Do not modify files\\nin output/; implement the fix"), true);
	assert.equal(expectsImplementationMutation("worker", "Do not modify files\\nin report/; implement the fix"), true);
	assert.equal(expectsImplementationMutation("worker", "Do not modify tests — implement the fix"), true);
	assert.equal(expectsImplementationMutation("worker", "Research the current code path and patch the bug"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix the bug where no edits were made"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix lint"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix the build"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix TypeScript errors"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix CI"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix the failing test"), true);
	assert.equal(expectsImplementationMutation("worker", "Patch the cold start test"), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the fix and return findings."), true);
});

test("non-worker implementation tasks still expect mutation", () => {
	assert.equal(expectsImplementationMutation("delegate", "Fix the bug where no edits were made"), true);
	assert.equal(expectsImplementationMutation("delegate", "Apply the suggested fix to src/runs/shared/completion-guard.ts"), true);
	assert.equal(expectsImplementationMutation("worker", "Draft a GitHub issue, then implement the fix"), true);
});

test("worker edit intent covers common docs, config, and source tasks", () => {
	assert.equal(expectsImplementationMutation("worker", "Update README to mention the native tool"), true);
	assert.equal(expectsImplementationMutation("worker", "Remove share functionality and all Vercel references"), true);
	assert.equal(expectsImplementationMutation("worker", "Replace the registered command with a render tool"), true);
	assert.equal(expectsImplementationMutation("worker", "Create completion-guard.ts"), true);
	assert.equal(expectsImplementationMutation("worker", "Add tests for the completion guard"), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the approved fixes. Do not edit files outside this repo."), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the fix. Do not edit unrelated files."), true);
});

test("edit and write tool calls count as mutation attempts", () => {
	assert.equal(hasMutationToolCall([assistantToolCall("edit", { path: "a.ts" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("write", { path: "a.ts" })]), true);
});

test("declared extension mutation tools count without weakening unknown tools", () => {
	const messages = [assistantToolCall("replace", { remove_from: "Liv" })];
	assert.equal(hasMutationToolCall(messages), false);
	assert.equal(hasMutationToolCall(messages, ["replace"]), true);
	assert.equal(evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Replace the target line",
		messages,
		tools: ["read", "replace"],
		mutationTools: ["replace"],
		mutationEvidence: { source: "tracked-files", trackedOnly: true, attemptedMutation: false, changedFiles: [], unavailable: "not a Git worktree" },
	}).triggered, false);
	assert.equal(evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Replace the target line",
		messages,
		tools: ["read", "replace"],
		mutationEvidence: { source: "tracked-files", trackedOnly: true, attemptedMutation: false, changedFiles: [], unavailable: "not a Git worktree" },
	}).triggered, true);
});

test("obvious mutating bash commands count as mutation attempts", () => {
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "mkdir -p src && cat > src/file.ts <<'EOF'\nhi\nEOF" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "cat <<'EOF' > src/file.ts\nhi\nEOF" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "python3 -c \"from pathlib import Path; Path('x').write_text('hi')\"" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "node script.js > generated.txt" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "echo 'a > b'" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "node -e \"console.log(a > b)\"" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "python3 <<'PY'\nprint('inspect only')\nPY" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "echo 'rm file'" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "printf \"mkdir x\"" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "git apply patch.diff" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "patch -p0 < fix.patch" })]), true);
});

test("git publication commands count as mutation attempts", () => {
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "git add src/file.ts" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "git commit -m 'fix: finish change'" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "git push origin HEAD" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "git -C /tmp/project add src/file.ts" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: 'git -C "/tmp/project with space" add src/file.ts' })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: 'git -C "$WORKTREE" commit -m fix' })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "git --paginate push" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "git diff --check && git add src/file.ts && git commit -m fix && git push" })]), true);
});

test("read-only and quoted git commands do not count as mutation attempts", () => {
	for (const command of [
		"git status --short",
		"git diff --check",
		"git log -1 --oneline",
		"git show --stat HEAD",
		"git ls-remote origin main",
		"git --help add",
		"git --version add",
		"git -h commit",
		"gh pr view 749",
		"echo 'git add src/file.ts'",
		'printf "git commit -m fix"',
		"echo 'then git push origin HEAD'",
	]) {
		assert.equal(hasMutationToolCall([assistantToolCall("bash", { command })]), false, command);
	}
});

test("implementation task with mutation attempts does not trigger", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Fix the failing test",
		messages: [assistantToolCall("edit", { path: "test.ts" })],
	});

	assert.equal(result.triggered, false);
});

function assistantThinking(thinking: string): Message {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking }],
	} as unknown as Message;
}

test("Cursor edit/write thinking traces count as mutation attempts", () => {
	assert.equal(
		hasMutationToolCall([assistantThinking("Cursor edit: docs/BACKEND_ARCHITECTURE.md added 10 lines, removed 3 lines\n")]),
		true,
	);
	assert.equal(
		hasMutationToolCall([assistantThinking("Cursor write: src/file.ts created\n")]),
		true,
	);
	assert.equal(
		hasMutationToolCall([assistantThinking("I plan to edit the file next\n")]),
		false,
	);
	assert.equal(
		hasMutationToolCall([assistantThinking("Cursor read: docs/BACKEND_ARCHITECTURE.md\n")]),
		false,
	);
});

test("Cursor replay tool calls count only edit/write activity as mutation", () => {
	const cursorEdit = { activityTitle: "Cursor edit", path: "docs/BACKEND_ARCHITECTURE.md" };
	const cursorWrite = { activityTitle: "Cursor write", path: "src/file.ts" };
	assert.equal(hasMutationToolCall([assistantToolCall("cursor", cursorEdit)]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("cursor", cursorWrite)]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("cursor", { activityTitle: "Cursor read" })]), false);
	assert.equal(isMutatingTool("cursor", cursorEdit), true);
	assert.equal(isMutatingTool("cursor", { activityTitle: "Cursor read" }), false);
});

test("claimed changedFiles without mutation evidence does not bypass the guard", () => {
	const report = assistantText(`Done.\n\`\`\`acceptance-report\n{\n  "changedFiles": ["docs/BACKEND_ARCHITECTURE.md"]\n}\n\`\`\``);
	assert.equal(hasMutationToolCall([report]), false);
});

function checkpointDataEntry(beforeCommit: string, afterCommit: string): Message {
	return {
		type: "custom",
		customType: "pi-checkpoint",
		data: { beforeCommit, afterCommit },
	} as unknown as Message;
}

function checkpointDetailsMessage(beforeCommit: string, afterCommit: string): Message {
	return {
		role: "custom",
		customType: "pi-checkpoint",
		content: [],
		details: { beforeCommit, afterCommit },
	} as unknown as Message;
}

function checkpointNestedDetailsMessage(beforeCommit: string, afterCommit: string): Message {
	return {
		role: "custom",
		customType: "pi-checkpoint",
		content: [],
		details: { data: { beforeCommit, afterCommit } },
	} as unknown as Message;
}

test("provider checkpoint with a changed commit counts as mutation evidence", () => {
	for (const message of [
		checkpointDataEntry("before", "after"),
		checkpointDetailsMessage("before", "after"),
		checkpointNestedDetailsMessage("before", "after"),
	]) {
		assert.equal(hasMutationToolCall([message]), true);
		assert.equal(
			evaluateCompletionMutationGuard({
				agent: "worker",
				task: "Edit the target source file",
				messages: [message],
			}).triggered,
			false,
		);
	}
});

test("unchanged provider checkpoint does not bypass the completion guard", () => {
	for (const message of [
		checkpointDataEntry("same", "same"),
		checkpointDetailsMessage("same", "same"),
		checkpointNestedDetailsMessage("same", "same"),
	]) {
		assert.equal(hasMutationToolCall([message]), false);
		assert.equal(
			evaluateCompletionMutationGuard({
				agent: "worker",
				task: "Edit the target source file",
				messages: [message],
			}).triggered,
			true,
		);
	}
});

test("implementation task with Cursor edit thinking does not trigger", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Edit docs/BACKEND_ARCHITECTURE.md",
		messages: [
			assistantThinking("Cursor edit: docs/BACKEND_ARCHITECTURE.md added 1 line\n"),
			assistantText("Implemented the six simplifications."),
		],
		tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
	});
	assert.deepEqual(result, {
		expectedMutation: true,
		attemptedMutation: true,
		triggered: false,
		blocked: false,
	});
});

test("writer-role tasks with unknown implementation wording reject read-only launch tools", () => {
	for (const task of [
		"Address issue #1371 end-to-end: land the fix with tests.",
		"Resolve backlog item #1371. Land the change and open a PR.",
		"Work issue #1371. Ship the feature, run the test suite, and report back.",
	]) {
		assert.match(validateImplementationToolContract({
			agent: "worker",
			task,
			tools: ["read", "grep", "find", "ls", "contact_supervisor"],
			requestedTools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
		}), /no mutation-capable tools/, task);
	}
});

test("configured extensions do not rescue clamped-away builtin mutation tools", () => {
	assert.match(validateImplementationToolContract({
		agent: "worker",
		task: "Fix the lane-owned workflowScript launch so writer children get mutation tools.",
		tools: ["read", "grep", "find", "ls", "contact_supervisor"],
		configuredExtensions: ["/tmp/provider.ts"],
		requestedTools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
	}), /no mutation-capable tools/);
});

test("read-only agents and pure extension workers keep their launch contracts", () => {
	assert.equal(validateImplementationToolContract({
		agent: "reviewer",
		task: "Review the diff and return findings only.",
		tools: ["read", "grep", "find", "ls", "contact_supervisor"],
		acceptanceRole: "read-only",
	}), undefined);

	assert.equal(validateImplementationToolContract({
		agent: "worker",
		task: "Implement the requested source fix.",
		tools: ["read", "grep", "find", "ls", "contact_supervisor"],
		configuredExtensions: ["/tmp/mutation-extension.ts"],
		requestedTools: ["read", "grep", "find", "ls", "contact_supervisor"],
	}), undefined);

	assert.equal(validateImplementationToolContract({
		agent: "worker",
		task: "Task",
		tools: ["read"],
		requestedTools: ["read"],
	}), undefined);

	assert.equal(validateImplementationToolContract({
		agent: "worker",
		task: "Summarize the fix",
		tools: ["read"],
		requestedTools: ["read"],
		completionGuard: false,
	}), undefined);
});
