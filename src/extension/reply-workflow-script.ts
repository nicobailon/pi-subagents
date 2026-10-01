import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const WORKFLOW_FENCE = /^```(?:js|javascript) workflow[ \t]*$/;
const OPEN_FENCE = /^(`{3,}|~{3,})/;
const CLOSE_FENCE = /^(`{3,}|~{3,})[ \t]*$/;

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
	const { blocks, unclosed } = workflowBlocks(text);
	if (unclosed) return { error: "The ```js workflow block in this reply is not closed." };
	if (blocks.length !== 1) return { error: `workflow: true requires exactly one \`\`\`js workflow fenced block in the same reply as the tool call; found ${blocks.length}.` };
	const script = blocks[0]!;
	if (!script.trim()) return { error: "The ```js workflow block in this reply is empty." };
	return { script };
}

/** Collects ```js workflow / ```javascript workflow fenced blocks, skipping the bodies of other fences. */
function workflowBlocks(text: string): { blocks: string[]; unclosed: boolean } {
	const lines = text.split("\n");
	const blocks: string[] = [];
	let fence: { marker: string; tagged: boolean; start: number } | undefined;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!.replace(/\r$/, "");
		if (!fence) {
			const open = OPEN_FENCE.exec(line);
			if (open) fence = { marker: open[1]!, tagged: WORKFLOW_FENCE.test(line), start: index + 1 };
			continue;
		}
		const close = CLOSE_FENCE.exec(line);
		if (!close || close[1]![0] !== fence.marker[0] || close[1]!.length < fence.marker.length) continue;
		if (fence.tagged) blocks.push(lines.slice(fence.start, index).join("\n"));
		fence = undefined;
	}
	return { blocks, unclosed: fence?.tagged === true };
}
