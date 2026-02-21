/**
 * Integration tests for chain execution (sequential and parallel steps).
 *
 * Uses mock-pi.mjs to simulate subagent processes. Tests the full chain
 * pipeline: template resolution → spawn → output capture → {previous} passing.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	setupMockPi,
	teardownMockPi,
	resetMockEnv,
	createTempDir,
	removeTempDir,
	makeAgent,
	makeMinimalCtx,
	tryImport,
} from "./helpers.ts";

// Top-level await: try importing pi-dependent modules
const chainMod = await tryImport<any>("./chain-execution.ts");
const available = !!chainMod;
const executeChain = chainMod?.executeChain;

describe("chain execution — sequential", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let artifactsDir: string;

	before(() => setupMockPi());
	after(() => teardownMockPi());

	beforeEach(() => {
		tempDir = createTempDir();
		artifactsDir = path.join(tempDir, "artifacts");
		resetMockEnv();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeChainParams(chain: any[], agents: any[], overrides: Record<string, any> = {}) {
		return {
			chain,
			agents,
			ctx: makeMinimalCtx(tempDir),
			runId: `test-${Date.now().toString(36)}`,
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir,
			artifactConfig: { enabled: false },
			clarify: false,
			...overrides,
		};
	}

	it("runs a 2-step chain", async () => {
		process.env.MOCK_PI_OUTPUT = "Analysis complete: found 3 issues";
		const agents = [makeAgent("analyst"), makeAgent("reporter")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Analyze the code" }, { agent: "reporter" }],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
		assert.equal(result.details.results[0].agent, "analyst");
		assert.equal(result.details.results[1].agent, "reporter");
	});

	it("passes {previous} between steps (step 2 receives step 1 output)", async () => {
		// Mock echoes the task by default, so step 2's output will contain step 1's output
		// if {previous} was properly substituted
		process.env.MOCK_PI_OUTPUT = "Step 1 unique output: MARKER_ABC_123";
		const agents = [makeAgent("step1"), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Produce output" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		// Step 2's task should contain step 1's output (via {previous})
		const step2Task = result.details.results[1].task;
		assert.ok(
			step2Task.includes("MARKER_ABC_123"),
			`step 2 task should contain step 1 output via {previous}: ${step2Task.slice(0, 200)}`,
		);
	});

	it("substitutes {task} in templates", async () => {
		process.env.MOCK_PI_OUTPUT = "Done";
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Review {task} carefully" }],
				agents,
				{ task: "the authentication module" },
			),
		);

		assert.ok(!result.isError);
		const workerTask = result.details.results[0].task;
		assert.ok(
			workerTask.includes("the authentication module"),
			`should substitute {task}: ${workerTask.slice(0, 200)}`,
		);
	});

	it("creates and uses chain_dir", async () => {
		process.env.MOCK_PI_OUTPUT = "Done";
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Write to {chain_dir}" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		const summary = result.content[0].text;
		assert.ok(summary.includes("✅ Chain completed:"), `missing completion marker: ${summary}`);
		assert.ok(summary.includes("📁 Artifacts:"), `missing artifacts marker: ${summary}`);
	});

	it("stops chain on step failure", async () => {
		process.env.MOCK_PI_EXIT_CODE = "1";
		process.env.MOCK_PI_STDERR = "Agent crashed";
		const agents = [makeAgent("step1"), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do first thing" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(result.isError, "chain should fail");
		assert.equal(result.details.results.length, 1, "only step1 should have run");
		assert.equal(result.details.results[0].exitCode, 1);
	});

	it("runs a 3-step chain end-to-end", async () => {
		process.env.MOCK_PI_OUTPUT = "Step output";
		const agents = [makeAgent("scout"), makeAgent("planner"), makeAgent("executor")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Survey the codebase" },
					{ agent: "planner" },
					{ agent: "executor" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 3);
		assert.ok(result.details.results.every((r: any) => r.exitCode === 0));
	});

	it("returns error for unknown agent in chain", async () => {
		const agents = [makeAgent("scout")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "scout", task: "Start" }, { agent: "nonexistent" }],
				agents,
			),
		);

		assert.ok(result.isError);
		assert.ok(result.content[0].text.includes("Unknown agent"));
	});

	it("tracks chain metadata (chainAgents, totalSteps)", async () => {
		process.env.MOCK_PI_OUTPUT = "Done";
		const agents = [makeAgent("a"), makeAgent("b")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "a", task: "Start" }, { agent: "b" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.deepEqual(result.details.chainAgents, ["a", "b"]);
		assert.equal(result.details.totalSteps, 2);
	});

	it("uses custom chainDir when provided", async () => {
		process.env.MOCK_PI_OUTPUT = "Done";
		const agents = [makeAgent("worker")];
		const customChainDir = path.join(tempDir, "my-chain");

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Use {chain_dir}" }],
				agents,
				{ chainDir: customChainDir },
			),
		);

		assert.ok(!result.isError);
		assert.ok(fs.existsSync(customChainDir), "custom chainDir should exist");
	});
});

describe("chain execution — parallel steps", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;

	before(() => setupMockPi());
	after(() => teardownMockPi());

	beforeEach(() => {
		tempDir = createTempDir();
		resetMockEnv();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeChainParams(chain: any[], agents: any[], overrides: Record<string, any> = {}) {
		return {
			chain,
			agents,
			ctx: makeMinimalCtx(tempDir),
			runId: `test-${Date.now().toString(36)}`,
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir: path.join(tempDir, "artifacts"),
			artifactConfig: { enabled: false },
			clarify: false,
			...overrides,
		};
	}

	it("runs parallel tasks within a chain step", async () => {
		process.env.MOCK_PI_OUTPUT = "Parallel task done";
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review auth module" },
							{ agent: "reviewer-b", task: "Review data layer" },
						],
					},
				],
				agents,
			),
		);

		assert.ok(!result.isError, `should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
	});

	it("aggregates parallel outputs for next sequential step", async () => {
		process.env.MOCK_PI_OUTPUT = "Review findings here";
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b"), makeAgent("synthesizer")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review security" },
							{ agent: "reviewer-b", task: "Review performance" },
						],
					},
					{ agent: "synthesizer" }, // Gets aggregated {previous}
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 3); // 2 parallel + 1 sequential
		// Synthesizer's task should contain both parallel task blocks
		const synthTask = result.details.results[2].task;
		assert.ok(
			synthTask.includes("=== Parallel Task 1 (reviewer-a) ==="),
			"synthesizer should include reviewer-a output block",
		);
		assert.ok(
			synthTask.includes("=== Parallel Task 2 (reviewer-b) ==="),
			"synthesizer should include reviewer-b output block",
		);
	});

	it("fails chain on parallel step failure", async () => {
		process.env.MOCK_PI_EXIT_CODE = "1";
		process.env.MOCK_PI_STDERR = "Parallel task failed";
		const agents = [makeAgent("a"), makeAgent("b")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Task A" },
							{ agent: "b", task: "Task B" },
						],
					},
				],
				agents,
			),
		);

		assert.ok(result.isError, "chain should fail when parallel step fails");
	});

	it("sequential → parallel → sequential (mixed chain)", async () => {
		process.env.MOCK_PI_OUTPUT = "Step complete";
		const agents = [makeAgent("scout"), makeAgent("rev-a"), makeAgent("rev-b"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Initial scan" },
					{
						parallel: [
							{ agent: "rev-a", task: "Deep review A" },
							{ agent: "rev-b", task: "Deep review B" },
						],
					},
					{ agent: "writer" }, // Gets aggregated parallel output
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 4); // 1 + 2 + 1
		assert.equal(result.details.totalSteps, 3); // 3 chain steps
	});
});
