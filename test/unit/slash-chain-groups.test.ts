import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildChainExpressionSteps,
	hasGroupSyntax,
	PARALLEL_GROUP_USAGE,
	parseChainExpression,
	parseGroupSegment,
	parseSingleTaskToken,
	SlashParseError,
} from "../../src/slash/slash-commands.ts";

function makeCtx(notifications: string[]): {
	ui: { notify: (message: string, level?: string) => void };
} {
	return {
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
		},
	};
}

function makeState(cwd: string) {
	return {
		baseCwd: cwd,
	};
}

let tempRoot: string;

before(() => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slash-chain-test-"));
	fs.mkdirSync(path.join(tempRoot, ".pi", "agents"), { recursive: true });
	const agentsDir = path.join(tempRoot, ".pi", "agents");
	const writeAgent = (name: string) => {
		fs.writeFileSync(
			path.join(agentsDir, `${name}.md`),
			`---\nname: ${name}\ndescription: ${name}\n---\nBody\n`,
			"utf-8",
		);
	};
	for (const name of ["scout", "reviewer", "writer", "unknown"]) {
		writeAgent(name);
	}
});

after(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("parseSingleTaskToken", () => {
	it("parses a quoted task", () => {
		const parsed = parseSingleTaskToken('reviewer "review auth module"');
		assert.equal(parsed.kind, "step");
		assert.equal(parsed.name, "reviewer");
		assert.equal(parsed.task, "review auth module");
	});

	it("parses an agent with inline config and no task", () => {
		const parsed = parseSingleTaskToken(
			"scout[output=ctx.md,outputMode=file-only]",
		);
		assert.equal(parsed.kind, "step");
		assert.equal(parsed.name, "scout");
		assert.equal(parsed.config.output, "ctx.md");
		assert.equal(parsed.config.outputMode, "file-only");
		assert.equal(parsed.task, undefined);
	});

	it("parses a task via -- delimiter", () => {
		const parsed = parseSingleTaskToken("reviewer -- Review {previous}");
		assert.equal(parsed.kind, "step");
		assert.equal(parsed.name, "reviewer");
		assert.equal(parsed.task, "Review {previous}");
	});
});

describe("parseGroupSegment", () => {
	it("parses a static parallel group with two quoted tasks", () => {
		const parsed = parseGroupSegment('(reviewer "A" | reviewer "B")');
		assert.equal(parsed.kind, "group");
		assert.equal(parsed.tasks.length, 2);
		assert.equal(parsed.tasks[0]?.name, "reviewer");
		assert.equal(parsed.tasks[0]?.task, "A");
		assert.equal(parsed.tasks[1]?.task, "B");
	});

	it("rejects groups with a single task", () => {
		assert.throws(
			() => parseGroupSegment('(reviewer "A")'),
			(error: unknown) => error instanceof SlashParseError,
		);
	});

	it("rejects groups with unbalanced parentheses", () => {
		assert.throws(
			() => parseGroupSegment('(reviewer "A"'),
			(error: unknown) => error instanceof SlashParseError,
		);
	});
});

describe("hasGroupSyntax", () => {
	it("detects parentheses", () => {
		assert.equal(hasGroupSyntax("a -> (b | c)"), true);
	});

	it("detects pipe", () => {
		assert.equal(hasGroupSyntax("a -> b | c"), true);
	});

	it("ignores delimiters inside quotes", () => {
		assert.equal(hasGroupSyntax('a -> b "with | inside"'), false);
	});

	it("returns false for plain chain input", () => {
		assert.equal(hasGroupSyntax("scout -> reviewer"), false);
	});
});

describe("parseChainExpression", () => {
	it("parses sequential + group + sequential", () => {
		const expression = parseChainExpression(
			'scout "scan" -> (reviewer "A" | reviewer "B") -> writer "fix"',
		);
		assert.equal(expression.steps.length, 3);
		const group = expression.steps[1];
		assert.ok(group);
		assert.equal(group.kind, "group");
		if (group.kind === "group") {
			assert.equal(group.tasks.length, 2);
		}
		assert.equal(expression.steps[0]?.kind, "step");
		assert.equal((expression.steps[0] as { name: string }).name, "scout");
		assert.equal((expression.steps[2] as { name: string }).name, "writer");
	});

	it("rejects expression without arrows", () => {
		assert.throws(
			() => parseChainExpression('(reviewer "A" | reviewer "B")'),
			(error: unknown) =>
				error instanceof SlashParseError && error.message.includes("->"),
		);
	});

	it("rejects groups with one task", () => {
		assert.throws(
			() => parseChainExpression('scout "scan" -> (reviewer "A")'),
			(error: unknown) => error instanceof SlashParseError,
		);
	});

	it("respects quotes when splitting on arrows", () => {
		const expression = parseChainExpression(
			'scout "scan -> quick" -> reviewer "Review"',
		);
		assert.equal(expression.steps.length, 2);
		assert.equal(
			(expression.steps[0] as { task: string }).task,
			"scan -> quick",
		);
	});
});

describe("buildChainExpressionSteps", () => {
	it("emits a chain with a { parallel: [...] } step for groups", () => {
		const notifications: string[] = [];
		const built = buildChainExpressionSteps(
			makeState(tempRoot) as never,
			'scout "scan" -> (reviewer "A" | reviewer "B") -> writer "fix"',
			makeCtx(notifications) as never,
		);
		assert.ok(built, "should build a chain");
		if (!built) return;
		assert.deepEqual(notifications, []);
		assert.equal(built.chain.length, 3);
		assert.equal(
			built.chain[0] && "agent" in built.chain[0]
				? built.chain[0].agent
				: undefined,
			"scout",
		);
		assert.equal(
			built.chain[1] && "parallel" in built.chain[1]
				? built.chain[1].parallel.length
				: undefined,
			2,
		);
		assert.equal(
			built.chain[2] && "agent" in built.chain[2]
				? built.chain[2].agent
				: undefined,
			"writer",
		);
		assert.equal(built.task, "scan");
	});

	it("preserves backward-compatible linear chain behavior", () => {
		const notifications: string[] = [];
		const built = buildChainExpressionSteps(
			makeState(tempRoot) as never,
			'scout "scan" -> reviewer "review"',
			makeCtx(notifications) as never,
		);
		assert.ok(built);
		if (!built) return;
		assert.equal(built.chain.length, 2);
		assert.equal(built.task, "scan");
	});

	it("falls back to shared task when first step has no task", () => {
		const notifications: string[] = [];
		const built = buildChainExpressionSteps(
			makeState(tempRoot) as never,
			"scout -> reviewer",
			makeCtx(notifications) as never,
		);
		assert.equal(built, null);
		assert.ok(
			notifications.some((message) => /task/i.test(message)),
			`notifications: ${notifications.join(" | ")}`,
		);
	});

	it("reports parallel group errors as notifications", () => {
		const notifications: string[] = [];
		const built = buildChainExpressionSteps(
			makeState(tempRoot) as never,
			'scout "scan" -> (reviewer "A")',
			makeCtx(notifications) as never,
		);
		assert.equal(built, null);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0] ?? "", /at least two/i);
	});

	it("exports a stable parallel group usage hint", () => {
		assert.match(PARALLEL_GROUP_USAGE, /Usage: \/chain/);
		assert.match(PARALLEL_GROUP_USAGE, /\(/);
		assert.match(PARALLEL_GROUP_USAGE, /\|/);
	});
});
