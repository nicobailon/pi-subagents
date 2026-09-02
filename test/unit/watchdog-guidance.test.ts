import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadWatchdogGuidance, WATCHDOG_GUIDANCE_MAX_CHARS } from "../../src/watchdog/guidance.ts";

let dir = "";
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function projectDir(): string {
	return path.join(dir, "project");
}

function writeProjectGuidance(text: string): void {
	fs.mkdirSync(path.join(projectDir(), ".pi"), { recursive: true });
	fs.writeFileSync(path.join(projectDir(), ".pi", "WATCHDOG.md"), text, "utf-8");
}

function writeUserGuidance(text: string): void {
	fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
	fs.writeFileSync(path.join(dir, "agent", "WATCHDOG.md"), text, "utf-8");
}

describe("watchdog guidance", () => {
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-guidance-"));
		fs.mkdirSync(projectDir(), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("returns empty when no guidance files exist or when disabled", () => {
		assert.equal(loadWatchdogGuidance(projectDir(), true), "");
		writeProjectGuidance("Project rule.");
		assert.equal(loadWatchdogGuidance(projectDir(), false), "");
	});

	it("puts project guidance before user guidance", () => {
		writeUserGuidance("User rule.\n");
		writeProjectGuidance("\nProject rule.");
		assert.equal(loadWatchdogGuidance(projectDir(), true), "Project rule.\n\nUser rule.");
	});

	it("caps combined guidance from the head", () => {
		writeProjectGuidance("p".repeat(WATCHDOG_GUIDANCE_MAX_CHARS));
		writeUserGuidance("u".repeat(100));
		const guidance = loadWatchdogGuidance(projectDir(), true);
		assert.equal(guidance.length, WATCHDOG_GUIDANCE_MAX_CHARS);
		assert.equal(guidance, "p".repeat(WATCHDOG_GUIDANCE_MAX_CHARS));
	});
});
