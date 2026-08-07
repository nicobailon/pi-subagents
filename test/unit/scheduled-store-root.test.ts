import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getConfigPath, loadConfig, resolveScheduledStoreRoot, saveConfig, updateConfig } from "../../src/extension/config.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const HOME_ENV = "HOME";
const USERPROFILE_ENV = "USERPROFILE";
let agentDir: string;
let homeDir: string;
let previousAgentDir: string | undefined;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(() => {
	previousAgentDir = process.env[AGENT_DIR_ENV];
	previousHome = process.env[HOME_ENV];
	previousUserProfile = process.env[USERPROFILE_ENV];
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-schedule-store-root-"));
	homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-schedule-home-"));
	process.env[AGENT_DIR_ENV] = agentDir;
	process.env[HOME_ENV] = homeDir;
	process.env[USERPROFILE_ENV] = homeDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = previousAgentDir;
	if (previousHome === undefined) delete process.env[HOME_ENV];
	else process.env[HOME_ENV] = previousHome;
	if (previousUserProfile === undefined) delete process.env[USERPROFILE_ENV];
	else process.env[USERPROFILE_ENV] = previousUserProfile;
	fs.rmSync(agentDir, { recursive: true, force: true });
	fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("config.scheduledRuns.storeRoot", () => {
	it("accepts an absolute path and expands a ~/ path", () => {
		const absolute = path.join(os.tmpdir(), "pi-subagents-schedules");
		assert.equal(resolveScheduledStoreRoot(absolute), path.normalize(absolute));
		assert.equal(resolveScheduledStoreRoot("~/pi-subagents/schedules"), path.join(homeDir, "pi-subagents", "schedules"));
	});

	it("rejects project-relative paths during config load", () => {
		saveConfig({ scheduledRuns: { storeRoot: "schedules" } });
		const originalError = console.error;
		console.error = () => {};
		try {
			assert.deepEqual(loadConfig(), {});
		} finally {
			console.error = originalError;
		}
	});

	it("rejects project-relative paths during config update", () => {
		assert.throws(() => updateConfig(() => ({ scheduledRuns: { storeRoot: "./schedules" } })), /absolute path/);
		assert.equal(fs.existsSync(getConfigPath()), false);
	});

	it("preserves a configured store root", () => {
		const storeRoot = path.join(os.tmpdir(), "pi-subagents-schedules");
		saveConfig({ scheduledRuns: { storeRoot } });
		assert.equal(loadConfig().scheduledRuns?.storeRoot, storeRoot);
	});
});
