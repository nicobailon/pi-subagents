/**
 * Tests for chain template resolution and variable substitution.
 *
 * These test the pure logic of how {task}, {previous}, and {chain_dir}
 * variables get resolved in chain steps. Uses dynamic import since
 * settings.ts transitively depends on pi packages.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempDir, removeTempDir, tryImport } from "./helpers.ts";

// Top-level await
const settings = await tryImport<any>("./settings.ts");
const skills = await tryImport<any>("./skills.ts");
const available = !!(settings && skills);

const resolveChainTemplates = settings?.resolveChainTemplates;
const buildChainInstructions = settings?.buildChainInstructions;
const resolveStepBehavior = settings?.resolveStepBehavior;
const isParallelStep = settings?.isParallelStep;
const createChainDir = settings?.createChainDir;
const normalizeSkillInput = skills?.normalizeSkillInput;

describe("resolveChainTemplates", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("uses step task for first step", () => {
		const chain = [
			{ agent: "a", task: "Analyze {task}" },
			{ agent: "b" },
		];
		const templates = resolveChainTemplates(chain);
		assert.equal(templates[0], "Analyze {task}");
	});

	it("defaults to {previous} for subsequent steps without task", () => {
		const chain = [
			{ agent: "a", task: "Start" },
			{ agent: "b" },
			{ agent: "c" },
		];
		const templates = resolveChainTemplates(chain);
		assert.equal(templates[1], "{previous}");
		assert.equal(templates[2], "{previous}");
	});

	it("preserves explicit task on later steps", () => {
		const chain = [
			{ agent: "a", task: "Start" },
			{ agent: "b", task: "Custom task for B" },
		];
		const templates = resolveChainTemplates(chain);
		assert.equal(templates[1], "Custom task for B");
	});

	it("handles parallel steps", () => {
		const chain = [
			{
				parallel: [
					{ agent: "a", task: "Review auth" },
					{ agent: "b", task: "Review data" },
				],
			},
		];
		const templates = resolveChainTemplates(chain);
		assert.ok(Array.isArray(templates[0]), "parallel step templates should be an array");
		const parallelTemplates = templates[0] as string[];
		assert.equal(parallelTemplates[0], "Review auth");
		assert.equal(parallelTemplates[1], "Review data");
	});

	it("mixed sequential + parallel", () => {
		const chain = [
			{ agent: "scout", task: "Scan" },
			{
				parallel: [
					{ agent: "rev-a", task: "Deep review A" },
					{ agent: "rev-b" },
				],
			},
			{ agent: "writer" },
		];
		const templates = resolveChainTemplates(chain);
		assert.equal(templates[0], "Scan");
		assert.ok(Array.isArray(templates[1]));
		assert.equal(templates[2], "{previous}");
	});
});

describe("isParallelStep", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("returns true for parallel steps", () => {
		assert.ok(isParallelStep({ parallel: [{ agent: "a", task: "t" }] }));
	});

	it("returns false for sequential steps", () => {
		assert.ok(!isParallelStep({ agent: "a", task: "t" }));
	});
});

describe("normalizeSkillInput", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("returns undefined for undefined input", () => {
		assert.equal(normalizeSkillInput(undefined), undefined);
	});

	it("returns undefined for true (use default)", () => {
		assert.equal(normalizeSkillInput(true), undefined);
	});

	it("returns false for false (disable)", () => {
		assert.equal(normalizeSkillInput(false), false);
	});

	it("splits comma-separated string", () => {
		assert.deepEqual(normalizeSkillInput("web-search,pdf"), ["web-search", "pdf"]);
	});

	it("passes through array", () => {
		assert.deepEqual(normalizeSkillInput(["a", "b"]), ["a", "b"]);
	});

	it("deduplicates", () => {
		assert.deepEqual(normalizeSkillInput(["a", "b", "a"]), ["a", "b"]);
	});

	it("trims whitespace", () => {
		assert.deepEqual(normalizeSkillInput(" a , b "), ["a", "b"]);
	});

	it("filters empty strings", () => {
		assert.deepEqual(normalizeSkillInput(",a,,b,"), ["a", "b"]);
	});
});

describe("resolveStepBehavior", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("returns agent defaults when no overrides", () => {
		// Uses agentConfig.output, .defaultReads, .defaultProgress
		const config = { name: "test", output: "report.md", defaultProgress: true, defaultReads: ["input.md"] };
		const behavior = resolveStepBehavior(config, {});
		assert.equal(behavior.output, "report.md");
		assert.equal(behavior.progress, true);
		assert.deepEqual(behavior.reads, ["input.md"]);
	});

	it("step overrides take precedence", () => {
		const config = { name: "test", output: "report.md" };
		const behavior = resolveStepBehavior(config, { output: "custom.md" });
		assert.equal(behavior.output, "custom.md");
	});

	it("false disables output", () => {
		const config = { name: "test", output: "report.md" };
		const behavior = resolveStepBehavior(config, { output: false });
		assert.equal(behavior.output, false);
	});

	it("defaults to false when agent has no config", () => {
		const config = { name: "test" };
		const behavior = resolveStepBehavior(config, {});
		assert.equal(behavior.output, false);
		assert.equal(behavior.reads, false);
		assert.equal(behavior.progress, false);
	});
});

describe("buildChainInstructions", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("adds [Read from:] prefix for reads", () => {
		const behavior = { reads: ["context.md"], output: false, progress: false, skills: undefined };
		const dir = createTempDir("chain-test-");
		try {
			const { prefix } = buildChainInstructions(behavior, dir, false);
			assert.ok(prefix.includes("[Read from:"), `should have Read instruction: ${prefix}`);
			assert.ok(prefix.includes("context.md"), "should reference the file");
		} finally {
			removeTempDir(dir);
		}
	});

	it("adds [Write to:] prefix for output", () => {
		const behavior = { reads: undefined, output: "output.md", progress: false, skills: undefined };
		const dir = createTempDir("chain-test-");
		try {
			const { prefix } = buildChainInstructions(behavior, dir, false);
			assert.ok(prefix.includes("[Write to:"), `should have Write instruction: ${prefix}`);
			assert.ok(prefix.includes("output.md"), "should reference the file");
		} finally {
			removeTempDir(dir);
		}
	});

	it("adds progress instructions in suffix for first progress step", () => {
		const behavior = { reads: undefined, output: false, progress: true, skills: undefined };
		const dir = createTempDir("chain-test-");
		try {
			const { suffix } = buildChainInstructions(behavior, dir, true);
			assert.ok(
				suffix.includes("progress.md"),
				`should reference progress.md: ${suffix}`,
			);
			assert.ok(
				suffix.includes("Create") || suffix.includes("maintain"),
				`should say create/maintain for first progress step: ${suffix}`,
			);
		} finally {
			removeTempDir(dir);
		}
	});

	it("includes previous output in suffix when not in template", () => {
		const behavior = { reads: undefined, output: false, progress: false, skills: undefined };
		const dir = createTempDir("chain-test-");
		try {
			const { suffix } = buildChainInstructions(behavior, dir, false, "Previous step output here");
			assert.ok(
				suffix.includes("Previous step output here"),
				"should include previous output",
			);
		} finally {
			removeTempDir(dir);
		}
	});

	it("returns empty prefix/suffix when no behavior configured", () => {
		const behavior = { reads: undefined, output: false, progress: false, skills: undefined };
		const dir = createTempDir("chain-test-");
		try {
			const { prefix, suffix } = buildChainInstructions(behavior, dir, false);
			assert.equal(prefix, "");
			assert.equal(suffix, "");
		} finally {
			removeTempDir(dir);
		}
	});
});

describe("createChainDir", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("creates directory with runId", () => {
		const dir = createChainDir("test-run-123");
		try {
			assert.ok(fs.existsSync(dir));
			assert.ok(dir.includes("test-run-123"));
		} finally {
			removeTempDir(dir);
		}
	});

	it("uses custom base when provided", () => {
		const base = createTempDir("chain-base-");
		try {
			const dir = createChainDir("run-abc", base);
			assert.ok(fs.existsSync(dir));
			assert.ok(dir.startsWith(base) || dir === base);
		} finally {
			removeTempDir(base);
		}
	});
});
