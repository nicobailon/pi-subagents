import assert from "node:assert/strict";
import { describe, it } from "node:test";

interface SlashLiveStateModule {
	applySlashUpdate?: typeof import("../../src/slash/slash-live-state.ts").applySlashUpdate;
	buildSlashInitialResult?: typeof import("../../src/slash/slash-live-state.ts").buildSlashInitialResult;
	clearSlashSnapshots?: typeof import("../../src/slash/slash-live-state.ts").clearSlashSnapshots;
	finalizeSlashResult?: typeof import("../../src/slash/slash-live-state.ts").finalizeSlashResult;
	getSlashRenderableSnapshot?: typeof import("../../src/slash/slash-live-state.ts").getSlashRenderableSnapshot;
	restoreSlashFinalSnapshots?: typeof import("../../src/slash/slash-live-state.ts").restoreSlashFinalSnapshots;
}

let applySlashUpdate: SlashLiveStateModule["applySlashUpdate"];
let buildSlashInitialResult: SlashLiveStateModule["buildSlashInitialResult"];
let clearSlashSnapshots: SlashLiveStateModule["clearSlashSnapshots"];
let finalizeSlashResult: SlashLiveStateModule["finalizeSlashResult"];
let getSlashRenderableSnapshot: SlashLiveStateModule["getSlashRenderableSnapshot"];
let restoreSlashFinalSnapshots: SlashLiveStateModule["restoreSlashFinalSnapshots"];
let available = true;
try {
	({
		applySlashUpdate,
		buildSlashInitialResult,
		clearSlashSnapshots,
		finalizeSlashResult,
		getSlashRenderableSnapshot,
		restoreSlashFinalSnapshots,
	} = await import("../../src/slash/slash-live-state.ts") as SlashLiveStateModule);
} catch {
	available = false;
}

describe("slash live state", { skip: !available ? "slash-live-state.ts not importable" : undefined }, () => {
	it("streams progress updates into the visible slash snapshot", () => {
		clearSlashSnapshots!();
		const details = buildSlashInitialResult!("req-1", {
			agent: "scout",
			task: "scan codebase",
		});

		applySlashUpdate!("req-1", {
			requestId: "req-1",
			currentTool: "find",
			toolCount: 2,
			progress: [{
				agent: "scout",
				status: "running",
				task: "scan codebase",
				currentTool: "find",
				currentToolArgs: '{"pattern":"**/*.ts"}',
				recentTools: [{ tool: "ls", args: '{"path":"."}', endMs: 10 }],
				recentOutput: ["src/index.ts", "src/render.ts"],
				toolCount: 2,
				tokens: 120,
				durationMs: 400,
			}],
		});

		const snapshot = getSlashRenderableSnapshot!(details);
		const progress = snapshot.result.details.results[0]?.progress;
		assert.equal(progress?.currentTool, "find");
		assert.deepEqual(progress?.recentOutput, ["src/index.ts", "src/render.ts"]);
		assert.equal(snapshot.version > 0, true);
	});

	it("does not assign a parallel child update to another chain placeholder", () => {
		clearSlashSnapshots!();
		const details = buildSlashInitialResult!("req-parallel", {
			chain: [{ parallel: [{ agent: "scout", task: "map" }, { agent: "context-builder", task: "analyze" }] }],
		});

		applySlashUpdate!("req-parallel", {
			requestId: "req-parallel",
			progress: [{
				index: 1,
				agent: "context-builder",
				status: "running",
				task: "analyze",
				currentTool: "find",
				recentTools: [],
				recentOutput: [],
				toolCount: 38,
				tokens: 1_000,
				durationMs: 1_000,
			}],
		});

		const results = getSlashRenderableSnapshot!(details).result.details.results;
		assert.equal(results[0]?.progress?.currentTool, undefined);
		assert.equal(results[1]?.progress?.currentTool, "find");
	});

	it("creates stable placeholders for a 40-step worker/reviewer chain", () => {
		clearSlashSnapshots!();
		const chain = Array.from({ length: 40 }, (_, index) => ({
			agent: index % 2 === 0 ? "worker" : "reviewer",
			...(index === 0 ? { task: "Start long chain" } : {}),
		}));

		const details = buildSlashInitialResult!("req-long-chain", { chain });

		assert.equal(details.result.details.mode, "chain");
		assert.equal(details.result.details.results.length, 40);
		assert.equal(details.result.details.progress?.length, 40);
		assert.equal(details.result.details.chainAgents?.length, 40);
		assert.equal(details.result.details.totalSteps, 40);
		assert.equal(details.result.details.currentStepIndex, 0);
		assert.equal(details.result.details.results[0]?.progress?.status, "running");
		assert.equal(details.result.details.results[39]?.agent, "reviewer");
		assert.equal(details.result.details.results[39]?.progress?.index, 39);
	});

	it("prefers finalized snapshots and restores them from persisted custom messages", () => {
		clearSlashSnapshots!();
		const details = buildSlashInitialResult!("req-2", {
			agent: "scout",
			task: "scan codebase",
		});

		const finalDetails = finalizeSlashResult!({
			requestId: "req-2",
			result: {
				content: [{ type: "text", text: "Done." }],
				details: {
					mode: "single",
					results: [{
						agent: "scout",
						task: "scan codebase",
						exitCode: 0,
						messages: [],
						usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
					}],
				},
			},
			isError: false,
		});

		const liveFinal = getSlashRenderableSnapshot!(details);
		assert.equal((liveFinal.result.content[0] as { text: string }).text, "Done.");

		clearSlashSnapshots!();
		restoreSlashFinalSnapshots!([
			{
				type: "custom_message",
				customType: "subagent-slash-result",
				display: true,
				details: finalDetails,
			},
		]);

		const restored = getSlashRenderableSnapshot!(details);
		assert.equal((restored.result.content[0] as { text: string }).text, "Done.");
	});
});
