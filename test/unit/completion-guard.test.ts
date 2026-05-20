import test from "node:test";
import assert from "node:assert/strict";

import type { Message } from "@earendil-works/pi-ai";

import {
	evaluateCompletionMutationGuard,
	expectsImplementationMutation,
	hasMutationToolCall,
} from "../../src/runs/shared/completion-guard.ts";

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
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Implement the approved fix",
		messages: [assistantText("Plan: update the files...")],
	});

	assert.deepEqual(result, {
		expectedMutation: true,
		attemptedMutation: false,
		triggered: true,
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
		expectsImplementationMutation("worker", "Do async work\nUpdate progress at: /tmp/progress.md\nWrite your findings to: /tmp/out.md"),
		false,
	);
});

test("worker implementation verbs win over investigative wording", () => {
	assert.equal(expectsImplementationMutation("worker", "Investigate why the worker did not edit files and fix it"), true);
	assert.equal(expectsImplementationMutation("worker", "Research the current code path and patch the bug"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix the bug where no edits were made"), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the fix and return findings."), true);
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

test("implementation task with mutation attempts does not trigger", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Fix the failing test",
		messages: [assistantToolCall("edit", { path: "test.ts" })],
	});

	assert.equal(result.triggered, false);
});

// Frontmatter-declared tools are checked BEFORE prose inference. An agent
// that declares only read-only tools cannot mutate the workspace, so the
// guard must not expect mutation regardless of how implementation-y the
// task text is.
const READ_ONLY = ["read", "grep", "find", "ls"];
const WORKER_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

test("architect with read-only tools never expects mutation", () => {
	// Real architect frontmatter: tools: read, grep, find, ls.
	assert.equal(
		expectsImplementationMutation(
			"architect",
			"Produce v4 proposal that implements the approved fix",
			READ_ONLY,
		),
		false,
	);
	assert.equal(
		expectsImplementationMutation(
			"architect",
			"Add the 6 new constraints to §5 and refactor the proposal",
			READ_ONLY,
		),
		false,
	);
});

test("reviewer with read-only tools is not flagged by 'must fix' prose", () => {
	// Real reviewer-codex-xhigh frontmatter: tools: read, grep, find, ls.
	// Even with the reviewer name and 'must fix' wording, declared capability
	// wins: this agent cannot mutate.
	assert.equal(
		expectsImplementationMutation(
			"reviewer-codex-xhigh",
			"Find correctness bugs the reviewers must fix before signoff",
			READ_ONLY,
		),
		false,
	);
});

test("agent that omits the tools field falls through to prose inference", () => {
	// undefined tools = inherits the default surface = could mutate.
	assert.equal(
		expectsImplementationMutation("worker", "Implement the approved fix", undefined),
		true,
	);
});

test("agent declaring an unknown tool is treated as possibly mutating", () => {
	// Unknown tools (extensions, custom) are conservatively NOT short-circuited.
	assert.equal(
		expectsImplementationMutation(
			"worker",
			"Implement the approved fix",
			["read", "grep", "custom_tool_we_dont_know"],
		),
		true,
	);
});

test("agent declaring MCP tools is treated as possibly mutating", () => {
	// We don't model individual MCP tool capabilities, so any declared MCP
	// tool disqualifies the read-only short-circuit.
	assert.equal(
		expectsImplementationMutation(
			"worker",
			"Implement the approved fix",
			READ_ONLY,
			["apply_patch"],
		),
		true,
	);
});

test("worker with edit/write/bash declared still falls through to prose path", () => {
	// Shape A does NOT short-circuit workers — they have mutation tools.
	assert.equal(
		expectsImplementationMutation("worker", "Implement the approved fix", WORKER_TOOLS),
		true,
	);
});

test("python heredoc f.write(...) counts as a mutation attempt", () => {
	// Worker false-positive case from handoff §8(c): edits go through bash
	// via `python3 <<'EOF'` heredoc with `with open(p) as f: f.write(...)`,
	// which the existing open(p, 'w') pattern misses.
	assert.equal(
		hasMutationToolCall([
			assistantToolCall("bash", {
				command: "python3 <<'EOF'\nwith open('a.ts') as f:\n    f.write('hello')\nEOF",
			}),
		]),
		true,
	);
	// Negative: the substring "selfwrite(" must NOT match \bf\.write\(.
	assert.equal(
		hasMutationToolCall([
			assistantToolCall("bash", { command: "echo 'selfwrite(thing)'" }),
		]),
		false,
	);
});

test("worker with read-only tools never triggers the guard", () => {
	// §8(a): architect-shaped run where the agent produced a design doc and no
	// edits. Even though the task says "implement," declared capability wins.
	const result = evaluateCompletionMutationGuard({
		agent: "architect",
		task: "Produce v4 proposal that implements the approved fix",
		messages: [assistantText("# Proposal v4\n\n## Choice...\n\nLong design doc here.")],
		tools: READ_ONLY,
	});
	assert.deepEqual(result, {
		expectedMutation: false,
		attemptedMutation: false,
		triggered: false,
	});
});

test("worker using python heredoc f.write does not trigger the guard", () => {
	// §8(c): worker reports changed files via heredoc python writes.
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Implement the approved fix",
		tools: WORKER_TOOLS,
		messages: [
			assistantToolCall("bash", {
				command: "python3 <<'EOF'\nwith open('a.ts') as f:\n    f.write('hello')\nEOF",
			}),
			assistantText("Changed files: a.ts. verify-baseline.sh passed."),
		],
	});
	assert.deepEqual(result, {
		expectedMutation: true,
		attemptedMutation: true,
		triggered: false,
	});
});

test("worker with mutation tools that produces no edits still triggers", () => {
	// §8(d): worker with edit/write/bash declared, no mutation attempted,
	// task is clearly implementation — guard must still fire.
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Implement the approved fix",
		tools: WORKER_TOOLS,
		messages: [assistantText("Here's my plan: ...")],
	});
	assert.equal(result.triggered, true);
});
