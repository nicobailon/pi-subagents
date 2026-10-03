import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readReplyWorkflowScript } from "../../src/extension/reply-workflow-script.ts";

const call = (id: string, args: Record<string, unknown> = { workflow: true }) => ({ type: "toolCall", id, name: "subagent", arguments: args });
const branch = (...content: unknown[]) => ({ getBranch: () => [{ type: "message", message: { role: "assistant", content } }] }) as never;

describe("reply workflow block", () => {
	it("returns the one tagged block from the reply that issued the call, exactly as written", () => {
		const script = "const note = `\n```js\n`;\n  return runs.run('main', { agent: 'worker' });";
		// The first fence only quotes the tag, so it is skipped; the tagged fence may use javascript and trailing spaces.
		const text = ["Plan:", "```md", "```js workflow", "```", "```javascript workflow  ", script, "```", "Done."].join("\n");
		assert.deepEqual(readReplyWorkflowScript(branch({ type: "text", text }, call("call-1")), "call-1"), { script });
	});

	it("runs a lone plain js block, and prefers the tagged block when the reply also has plain js examples", () => {
		assert.deepEqual(readReplyWorkflowScript(branch({ type: "text", text: "```js\nreturn 1;\n```" }, call("call-1")), "call-1"), { script: "return 1;" });
		const text = "```js\nexample();\n```\n```js workflow\nreturn 2;\n```";
		assert.deepEqual(readReplyWorkflowScript(branch({ type: "text", text }, call("call-1")), "call-1"), { script: "return 2;" });
	});

	it("fails instead of guessing when the block or its owning call is ambiguous or missing", () => {
		const block = "```js workflow\nreturn 1;\n```";
		for (const [manager, pattern] of [
			[branch({ type: "text", text: "no block" }, call("call-1")), /exact line "```js workflow".*found 0\. Or write the script to a file/],
			[branch({ type: "thinking", thinking: "```js workflow\nreturn 1;\n```" }, call("call-1")), /no text in the session.*never reached it\. Write the script to a file/],
			[branch({ type: "text", text: "```js\na();\n```\n```js\nb();\n```" }, call("call-1")), /found 0\. This reply has 2 untagged js blocks/],
			[branch({ type: "text", text: `${block}\n${block}` }, call("call-1")), /found 2/],
			[branch({ type: "text", text: "```js workflow\nreturn 1;" }, call("call-1")), /not closed/],
			[branch({ type: "text", text: block }, call("call-1"), call("call-2")), /2 subagent calls with workflow: true/],
			[branch({ type: "text", text: block }, call("other-call")), /only works from a model subagent tool call/],
		] as const) {
			const result = readReplyWorkflowScript(manager, "call-1");
			assert.ok("error" in result && pattern.test(result.error), JSON.stringify(result));
		}
	});
});
