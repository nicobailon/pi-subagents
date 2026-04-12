import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { registerSlashSubagentBridge } from "../../slash-bridge.ts";
import { resolveChainDirPath } from "../../settings.ts";
import {
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	SLASH_SUBAGENT_STARTED_EVENT,
	type Details,
} from "../../types.ts";

class FakeEvents {
	private handlers = new Map<string, Array<(data: unknown) => void>>();
	
	on(event: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
		return () => {
			const current = this.handlers.get(event) ?? [];
			this.handlers.set(event, current.filter((entry) => entry !== handler));
		};
	}
	
	emit(event: string, data: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) {
			handler(data);
		}
	}
}

function once(events: FakeEvents, event: string): Promise<unknown> {
	return new Promise((resolve) => {
		const off = events.on(event, (data) => {
			off();
			resolve(data);
		});
	});
}

describe("slash bridge chain metadata", () => {
	afterEach(() => {
		for (const entry of fs.readdirSync(os.tmpdir())) {
			if (entry.startsWith("pi-chain-runs-test-")) {
				fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
			}
		}
	});

	it("emits chainId and chainDir on started and response events for chain runs", async () => {
		const events = new FakeEvents();
		const chainBase = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chain-runs-test-"));
		const requestId = "req-chain-123";
		const expectedDir = resolveChainDirPath(requestId, chainBase);
		const bridge = registerSlashSubagentBridge({
			events,
			getContext: () => ({ cwd: "/repo" }) as never,
			execute: async () => {
				fs.mkdirSync(expectedDir, { recursive: true });
				fs.writeFileSync(path.join(expectedDir, "context.md"), "scout output\n");
				return {
					content: [{ type: "text", text: "done" }],
					details: { mode: "chain", results: [] } satisfies Details,
				};
			},
		});

		const startedPromise = once(events, SLASH_SUBAGENT_STARTED_EVENT);
		const responsePromise = once(events, SLASH_SUBAGENT_RESPONSE_EVENT);

		events.emit(SLASH_SUBAGENT_REQUEST_EVENT, {
			requestId,
			params: {
				chain: [{ agent: "worker", task: "do work" }],
				chainDir: chainBase,
			},
		});

		const started = await startedPromise as { requestId: string; chainId?: string; chainDir?: string };
		assert.equal(started.requestId, requestId);
		assert.equal(started.chainId, requestId);
		assert.equal(started.chainDir, expectedDir);

		const response = await responsePromise as { requestId: string; chainId?: string; chainDir?: string; isError: boolean };
		assert.equal(response.requestId, requestId);
		assert.equal(response.chainId, requestId);
		assert.equal(response.chainDir, expectedDir);
		assert.equal(response.isError, false);
		assert.equal(fs.existsSync(expectedDir), true);
		assert.equal(fs.existsSync(path.join(expectedDir, "context.md")), true);

		bridge.dispose();
	});
});
