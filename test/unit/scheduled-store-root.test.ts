import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig, resolveScheduledStoreRoot, saveConfig } from "../../src/extension/config.ts";
import type { ExtensionConfig } from "../../src/shared/types.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
let agentDir: string;

beforeEach(() => {
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-config-store-root-"));
	process.env[AGENT_DIR_ENV] = agentDir;
});

afterEach(() => {
	delete process.env[AGENT_DIR_ENV];
	fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("config.scheduledRuns.storeRoot", () => {
	it("resolves an absolute store root unchanged", () => {
		const absolute = "/var/lib/pi-subagents/schedules";
		assert.equal(resolveScheduledStoreRoot(absolute), absolute);
	});

	it("expands a ~/ prefixed store root against os.homedir()", () => {
		assert.equal(resolveScheduledStoreRoot("~/pi-subagents/schedules"), path.join(os.homedir(), "pi-subagents/schedules"));
		assert.equal(resolveScheduledStoreRoot("~/"), os.homedir());
	});

	it("rejects a project-relative store root because a global store must not move per worktree", () => {
		assert.throws(() => resolveScheduledStoreRoot("tmp/schedules"), /absolute path/);
		assert.throws(() => resolveScheduledStoreRoot("./stores"), /absolute path/);
		assert.throws(() => resolveScheduledStoreRoot("stores"), /absolute path/);
	});

	it("round-trips a valid absolute storeRoot through save/load config", () => {
		const storeRoot = path.join(os.tmpdir(), "pi-subagents-global-schedules");
		saveConfig({ scheduledRuns: { storeRoot } });
		const config = loadConfig() as ExtensionConfig;
		assert.equal(config?.scheduledRuns?.storeRoot, storeRoot);
	});

	it("round-trips a ~/ storeRoot through save/load config", () => {
		saveConfig({ scheduledRuns: { storeRoot: "~/pi-subagents/schedules" } });
		const config = loadConfig() as ExtensionConfig;
		assert.equal(config?.scheduledRuns?.storeRoot, "~/pi-subagents/schedules");
	});

	it("rejects a non-empty invalid storeRoot on load", () => {
		saveConfig({ scheduledRuns: { storeRoot: "relative/store" } });
		// loadConfig catches validation and returns {} — valid values are preserved,
		// invalid configuration is rejected to avoid silently using a broken path.
		assert.deepEqual(loadConfig(), {});
	});

	it("keeps a config without storeRoot valid (backward compatible)", () => {
		saveConfig({ scheduledRuns: { enabled: true } });
		const config = loadConfig() as ExtensionConfig;
		assert.equal(config?.scheduledRuns?.enabled, true);
		assert.equal(config?.scheduledRuns?.storeRoot, undefined);
	});
});
