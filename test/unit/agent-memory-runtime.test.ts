import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { AGENT_MEMORY_APPEND_TOOL, AGENT_MEMORY_FILE } from "../../src/agents/agent-memory.ts";
import { registerAgentMemoryRuntime } from "../../src/runs/shared/agent-memory-runtime.ts";

const tempDirs: string[] = [];
afterEach(() => {
	while (tempDirs.length) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("agent memory runtime", () => {
	it("registers a bounded append tool without exposing the target path", async () => {
		const rootDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-memory-runtime-")), "agent-memory");
		tempDirs.push(path.dirname(rootDir));
		type RegisteredTool = {
			name: string;
			execute: (id: string, params: { content: string }) => Promise<{ content: Array<{ text: string }>; details: { bytes: number } }>;
		};
		let registered: RegisteredTool | undefined;
		const api = { registerTool(tool: RegisteredTool) { registered = tool; } };
		registerAgentMemoryRuntime(api, { rootDir, scopedPath: "worker" });
		assert.ok(registered);
		assert.equal(registered.name, AGENT_MEMORY_APPEND_TOOL);
		const result = await registered.execute("call", { content: "2026-09-15: verified command" });
		const text = result.content[0]?.text ?? "";
		assert.match(text, /^Appended \d+ bytes to agent memory\.$/);
		assert.equal(text.includes(rootDir), false);
		assert.equal(fs.readFileSync(path.join(rootDir, "worker", AGENT_MEMORY_FILE), "utf8"), "2026-09-15: verified command\n");
	});
});
