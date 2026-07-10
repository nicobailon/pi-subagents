import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";
import { WAIT_TOOL_ENABLED_ENV } from "../../src/runs/background/wait.ts";

type JsonSchemaNode = Record<string, unknown>;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parentToolEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env[SUBAGENT_CHILD_ENV];
	delete env[SUBAGENT_FANOUT_CHILD_ENV];
	delete env[WAIT_TOOL_ENABLED_ENV];
	return env;
}

function missingPackageName(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	return message.match(/Cannot find package ['"]([^'"]+)['"]/i)?.[1];
}

let validateChainInput: (args: unknown) => void = () => {};
let chainItemProperties: Record<string, unknown> | undefined;
let parallelTaskProperties: Record<string, unknown> | undefined;
let dynamicTemplateProperties: Record<string, unknown> | undefined;
let schemasAvailable = true;
try {
	const mod = await import("../../src/extension/chain-validation.ts") as {
		validateChainInput: (args: unknown) => void;
		CHAIN_STEP_KEYS: string[];
		PARALLEL_TASK_KEYS: string[];
		DYNAMIC_TEMPLATE_KEYS: string[];
	};
	validateChainInput = mod.validateChainInput;
	const schemas = await import("../../src/extension/schemas.ts") as {
		ChainItem: JsonSchemaNode;
		ParallelTaskSchema: JsonSchemaNode;
		DynamicParallelTemplateSchema: JsonSchemaNode;
	};
	chainItemProperties = schemas.ChainItem.properties as Record<string, unknown> | undefined;
	parallelTaskProperties = schemas.ParallelTaskSchema.properties as Record<string, unknown> | undefined;
	dynamicTemplateProperties = schemas.DynamicParallelTemplateSchema.properties as Record<string, unknown> | undefined;
} catch (error) {
	if (missingPackageName(error) !== "typebox") throw error;
	schemasAvailable = false;
}

function expectInvalid(args: unknown, ...patterns: RegExp[]): void {
	assert.throws(
		() => validateChainInput(args),
		(error) => {
			assert.ok(error instanceof Error, "validation should throw an Error");
			const message = error.message;
			for (const pattern of patterns) {
				assert.match(message, pattern, `expected message to match ${pattern}; got: ${message}`);
			}
			return true;
		},
		`expected validation to fail for ${JSON.stringify(args)}`,
	);
}

describe("chain input validation", { skip: !schemasAvailable ? "typebox not available" : undefined }, () => {
	it("is a no-op when chain is absent or not an array", () => {
		assert.doesNotThrow(() => validateChainInput({}));
		assert.doesNotThrow(() => validateChainInput({ agent: "worker", task: "do X" }));
		assert.doesNotThrow(() => validateChainInput({ chain: "not-an-array" }));
		assert.doesNotThrow(() => validateChainInput({ action: "status" }));
		assert.doesNotThrow(() => validateChainInput(undefined));
		assert.doesNotThrow(() => validateChainInput(null));
	});

	it("accepts valid chain steps without throwing", () => {
		assert.doesNotThrow(() => validateChainInput({ chain: [{ agent: "worker", task: "do X" }] }));
		assert.doesNotThrow(() =>
			validateChainInput({ chain: [{ agent: "worker", task: "do X", parallel: [{ agent: "reviewer", task: "review" }] }] }),
		);
		assert.doesNotThrow(() =>
			validateChainInput({
				chain: [{
					expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {item.path}" },
					collect: { as: "reviews" },
				}],
			}),
		);
	});

	it("names the disallowed property and lists allowed properties for a chain step", () => {
		expectInvalid(
			{ chain: [{ agent: "worker", task: "do X", bogus: true }] },
			/chain\[0\]/,
			/"bogus" is not allowed/,
			/Allowed properties:/,
			/Example:/,
		);
	});

	it("lists every allowed chain step property from the schema", () => {
		const allowed = Object.keys(chainItemProperties ?? {});
		assert.ok(allowed.includes("agent"));
		assert.ok(allowed.includes("parallel"));
		assert.ok(allowed.includes("expand"));
		try {
			validateChainInput({ chain: [{ notReal: 1 }] });
			assert.fail("should have thrown");
		} catch (error) {
			assert.ok(error instanceof Error);
			for (const key of allowed) {
				assert.match(error.message, new RegExp(`\\b${key}\\b`), `allowed key ${key} should appear in message: ${error.message}`);
			}
		}
	});

	it("reports multiple disallowed properties at once", () => {
		expectInvalid(
			{ chain: [{ agent: "worker", foo: 1, bar: 2 }] },
			/chain\[0\]/,
			/"foo"/,
			/"bar"/,
		);
	});

	it("explains expected shape when a chain step is not an object", () => {
		expectInvalid(
			{ chain: ["not-an-object"] },
			/chain\[0\]/,
			/expected an object/,
			/string/,
			/Allowed properties:/,
			/Example:/,
		);
		expectInvalid(
			{ chain: [42] },
			/chain\[0\]/,
			/expected an object/,
			/number/,
		);
	});

	it("names disallowed properties on a static parallel task", () => {
		expectInvalid(
			{ chain: [{ parallel: [{ agent: "worker", oops: true }] }] },
			/chain\[0\]\.parallel\[0\]/,
			/"oops" is not allowed/,
			/Allowed properties:/,
			/Example:/,
		);
	});

	it("lists every allowed static parallel task property from the schema", () => {
		const allowed = Object.keys(parallelTaskProperties ?? {});
		assert.ok(allowed.includes("agent"));
		assert.ok(allowed.includes("count"));
		try {
			validateChainInput({ chain: [{ parallel: [{ notReal: 1 }] }] });
			assert.fail("should have thrown");
		} catch (error) {
			assert.ok(error instanceof Error);
			for (const key of allowed) {
				assert.match(error.message, new RegExp(`\\b${key}\\b`), `allowed key ${key} should appear: ${error.message}`);
			}
		}
	});

	it("names disallowed properties on a dynamic fanout template", () => {
		expectInvalid(
			{
				chain: [{
					expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
					parallel: { agent: "worker", bogus: true },
					collect: { as: "reviews" },
				}],
			},
			/chain\[0\]\.parallel/,
			/"bogus" is not allowed/,
			/Allowed properties:/,
		);
	});

	it("lists every allowed dynamic template property from the schema", () => {
		const allowed = Object.keys(dynamicTemplateProperties ?? {});
		assert.ok(allowed.includes("agent"));
		assert.ok(allowed.includes("outputSchema"));
		try {
			validateChainInput({
				chain: [{
					expand: { from: { output: "x", path: "/items" }, maxItems: 4 },
					parallel: { notReal: 1 },
					collect: { as: "reviews" },
				}],
			});
			assert.fail("should have thrown");
		} catch (error) {
			assert.ok(error instanceof Error);
			for (const key of allowed) {
				assert.match(error.message, new RegExp(`\\b${key}\\b`), `allowed key ${key} should appear: ${error.message}`);
			}
		}
	});

	it("guides the agent when parallel is neither an array nor an object", () => {
		expectInvalid(
			{ chain: [{ parallel: "nope" }] },
			/chain\[0\]\.parallel/,
			/expected an array of task objects or a dynamic fanout template object/,
			/string/,
		);
	});

	it("names disallowed properties on expand", () => {
		expectInvalid(
			{
				chain: [{
					expand: { from: { output: "x", path: "/items" }, maxItems: 4, bogus: true },
					parallel: { agent: "worker" },
					collect: { as: "reviews" },
				}],
			},
			/chain\[0\]\.expand/,
			/"bogus" is not allowed/,
			/Allowed properties:/,
		);
	});

	it("names disallowed properties on expand.from", () => {
		expectInvalid(
			{
				chain: [{
					expand: { from: { output: "x", path: "/items", bogus: true }, maxItems: 4 },
					parallel: { agent: "worker" },
					collect: { as: "reviews" },
				}],
			},
			/chain\[0\]\.expand\.from/,
			/"bogus" is not allowed/,
			/Allowed properties:/,
		);
	});

	it("names disallowed properties on collect", () => {
		expectInvalid(
			{
				chain: [{
					expand: { from: { output: "x", path: "/items" }, maxItems: 4 },
					parallel: { agent: "worker" },
					collect: { as: "reviews", bogus: true },
				}],
			},
			/chain\[0\]\.collect/,
			/"bogus" is not allowed/,
			/Allowed properties:/,
		);
	});

	it("reports the correct chain index for multi-step chains", () => {
		expectInvalid(
			{ chain: [{ agent: "worker", task: "ok" }, { agent: "worker", bogus: true }] },
			/chain\[1\]/,
			/"bogus" is not allowed/,
		);
	});
});

describe("registered subagent tool prepareArguments", { skip: !schemasAvailable ? "typebox not available" : undefined }, () => {
	function runPrepare(args: unknown): { error?: string; ok: true } | { error: string; ok: false } {
		const script = String.raw`
			import registerSubagentExtension from "./src/extension/index.ts";
			const events = { on() { return () => {}; }, emit() {} };
			let registeredTool;
			const fakePi = new Proxy({
				events,
				registerTool(tool) { if (tool.name === "subagent") registeredTool = tool; },
				registerCommand() {},
				registerShortcut() {},
				registerMessageRenderer() {},
				sendMessage() {},
				getSessionName() { return undefined; },
			}, {
				get(target, prop) {
					if (prop in target) return target[prop];
					return () => undefined;
				},
			});
			registerSubagentExtension(fakePi);
			if (!registeredTool) throw new Error("tool not registered");
			if (typeof registeredTool.prepareArguments !== "function") throw new Error("prepareArguments not attached");
			const args = JSON.parse(process.argv[process.argv.length - 1] ?? "{}");
			try {
				registeredTool.prepareArguments(args);
				process.stdout.write(JSON.stringify({ ok: true }));
			} catch (error) {
				process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
			}
		`;
		const output = execFileSync(
			process.execPath,
			[
				"--experimental-transform-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--input-type=module",
				"--eval",
				script,
				"--",
				JSON.stringify(args),
			],
			{ cwd: projectRoot, env: parentToolEnv(), encoding: "utf-8", stdio: "pipe" },
		);
		return JSON.parse(output) as { error?: string; ok: boolean };
	}

	it("throws a friendly chain error before schema validation when a step has a disallowed property", () => {
		const result = runPrepare({ chain: [{ agent: "worker", task: "do X", bogus: true }] });
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /chain\[0\]/);
		assert.match(result.error ?? "", /"bogus" is not allowed/);
		assert.match(result.error ?? "", /Allowed properties:/);
		assert.match(result.error ?? "", /Example:/);
	});

	it("passes valid chain arguments through unchanged", () => {
		const result = runPrepare({ chain: [{ agent: "worker", task: "do X" }] });
		assert.equal(result.ok, true);
	});

	it("is a no-op for management actions and single/parallel calls", () => {
		assert.equal(runPrepare({ action: "status" }).ok, true);
		assert.equal(runPrepare({ agent: "worker", task: "do X" }).ok, true);
		assert.equal(runPrepare({ tasks: [{ agent: "worker", task: "do X" }] }).ok, true);
	});
});