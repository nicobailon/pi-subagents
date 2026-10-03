import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const WORKFLOW_FENCE = /^```(?:js|javascript) workflow[ \t]*$/;
const PLAIN_JS_FENCE = /^```(?:js|javascript)[ \t]*$/;
const OPEN_FENCE = /^(`{3,}|~{3,})/;
const CLOSE_FENCE = /^(`{3,}|~{3,})[ \t]*$/;
const FILE_FALLBACK = "Or write the script to a file and pass its path, such as workflow: \"./script.js\".";

export type ReplyWorkflowScript = { script: string } | { error: string };

/**
 * Pi persists the whole assistant message before running its tool calls, so the
 * message that issued this subagent call is on the branch and carries the script.
 */
export function readReplyWorkflowScript(sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">, toolCallId: string): ReplyWorkflowScript {
	const branch = sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		if (!message.content.some((block) => block.type === "toolCall" && block.id === toolCallId)) continue;
		return scriptFromReply(message.content);
	}
	return { error: "workflow: true only works from a model subagent tool call whose assistant message contains the ```js workflow block; other callers must pass a script path such as workflow: \"./script.js\"." };
}

function scriptFromReply(content: AssistantMessage["content"]): ReplyWorkflowScript {
	const replyCalls = content.filter((block) => block.type === "toolCall" && block.name === "subagent"
		&& (block.arguments?.workflow === true || block.arguments?.workflow === "true")).length;
	if (replyCalls > 1) return { error: `This reply has ${replyCalls} subagent calls with workflow: true; a reply can carry only one. Pass other scripts as workflow file paths.` };
	const text = content.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
	const { tagged, plain, unclosed } = workflowBlocks(text);
	if (unclosed) return { error: "The script's fenced block in this reply is not closed." };
	// Models often drop the workflow tag, so a lone plain js block is unambiguous enough to run.
	const blocks = tagged.length > 0 ? tagged : plain.length === 1 ? plain : [];
	if (blocks.length !== 1) {
		const untagged = tagged.length === 0 && plain.length > 1 ? ` This reply has ${plain.length} untagged js blocks; open the script's block with the line "\`\`\`js workflow".` : "";
		return { error: `workflow: true needs one fenced block in the same reply as the tool call, opened with the exact line "\`\`\`js workflow" and closed with "\`\`\`"; found ${tagged.length}.${untagged} ${FILE_FALLBACK}` };
	}
	const script = blocks[0]!;
	if (!script.trim()) return { error: "The script's fenced block in this reply is empty." };
	return { script };
}

/** Collects tagged (```js workflow) and plain (```js) fenced blocks, skipping the bodies of other fences. */
function workflowBlocks(text: string): { tagged: string[]; plain: string[]; unclosed: boolean } {
	const lines = text.split("\n");
	const tagged: string[] = [];
	const plain: string[] = [];
	let fence: { marker: string; kind: "tagged" | "plain" | undefined; start: number } | undefined;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!.replace(/\r$/, "");
		if (!fence) {
			const open = OPEN_FENCE.exec(line);
			if (open) fence = { marker: open[1]!, kind: WORKFLOW_FENCE.test(line) ? "tagged" : PLAIN_JS_FENCE.test(line) ? "plain" : undefined, start: index + 1 };
			continue;
		}
		const close = CLOSE_FENCE.exec(line);
		if (!close || close[1]![0] !== fence.marker[0] || close[1]!.length < fence.marker.length) continue;
		if (fence.kind) (fence.kind === "tagged" ? tagged : plain).push(lines.slice(fence.start, index).join("\n"));
		fence = undefined;
	}
	return { tagged, plain, unclosed: fence?.kind === "tagged" || (fence?.kind === "plain" && tagged.length === 0) };
}
