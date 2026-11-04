import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_GLOBAL_CONCURRENCY_LIMIT, GLOBAL_CONCURRENCY_ENV, resolveEffectiveGlobalConcurrencyLimit } from "../../src/runs/shared/parallel-utils.ts";
import { loadConfig, updateConfig } from "../../src/extension/config.ts";

const envKeys = [GLOBAL_CONCURRENCY_ENV];
const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	for (const key of envKeys) {
		if (savedEnv.has(key)) process.env[key] = savedEnv.get(key);
		else delete process.env[key];
	}
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

describe("global concurrency limit resolution", () => {
	it("falls back to the built-in default when nothing is configured", () => {
		delete process.env[GLOBAL_CONCURRENCY_ENV];
		assert.equal(resolveEffectiveGlobalConcurrencyLimit(undefined), DEFAULT_GLOBAL_CONCURRENCY_LIMIT);
		assert.equal(DEFAULT_GLOBAL_CONCURRENCY_LIMIT, 20);
	});

	it("honors an explicit config value over the environment", () => {
		process.env[GLOBAL_CONCURRENCY_ENV] = "3";
		assert.equal(resolveEffectiveGlobalConcurrencyLimit(6), 6);
	});

	it("honors the environment override when no config value is set", () => {
		delete process.env[GLOBAL_CONCURRENCY_ENV];
		assert.equal(resolveEffectiveGlobalConcurrencyLimit(), DEFAULT_GLOBAL_CONCURRENCY_LIMIT);
		process.env[GLOBAL_CONCURRENCY_ENV] = "4";
		assert.equal(resolveEffectiveGlobalConcurrencyLimit(), 4);
	});

	it("ignores invalid explicit values and invalid env values", () => {
		process.env[GLOBAL_CONCURRENCY_ENV] = "not-a-number";
		assert.equal(resolveEffectiveGlobalConcurrencyLimit(0), DEFAULT_GLOBAL_CONCURRENCY_LIMIT);
		assert.equal(resolveEffectiveGlobalConcurrencyLimit(2.5), DEFAULT_GLOBAL_CONCURRENCY_LIMIT);
		assert.equal(resolveEffectiveGlobalConcurrencyLimit(), DEFAULT_GLOBAL_CONCURRENCY_LIMIT);
		process.env[GLOBAL_CONCURRENCY_ENV] = "0";
		assert.equal(resolveEffectiveGlobalConcurrencyLimit(), DEFAULT_GLOBAL_CONCURRENCY_LIMIT);
		process.env[GLOBAL_CONCURRENCY_ENV] = "7";
		assert.equal(resolveEffectiveGlobalConcurrencyLimit(), 7);
	});

	it("rejects a non-integer globalConcurrencyLimit in the extension config file", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-concurrency-config-"));
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
			fs.mkdirSync(path.dirname(configPath), { recursive: true });
			fs.writeFileSync(configPath, JSON.stringify({}), "utf-8");
			assert.throws(() => updateConfig(() => ({ globalConcurrencyLimit: 2.5 })), /globalConcurrencyLimit must be a positive integer/);
			assert.throws(() => updateConfig(() => ({ globalConcurrencyLimit: 0 })), /globalConcurrencyLimit must be a positive integer/);
			updateConfig(() => ({ globalConcurrencyLimit: 4 }));
			assert.equal(loadConfig().globalConcurrencyLimit, 4);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
