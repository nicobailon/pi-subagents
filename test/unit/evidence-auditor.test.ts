import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clearAgentDiscoveryCache, discoverAgentsAll } from "../../src/agents/agents.ts";

describe("evidence-auditor builtin", () => {
	let projectDir: string;
	let homeDir: string;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;

	beforeEach(() => {
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-evidence-auditor-project-"));
		homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-evidence-auditor-home-"));
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		clearAgentDiscoveryCache();
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		fs.rmSync(projectDir, { recursive: true, force: true });
		fs.rmSync(homeDir, { recursive: true, force: true });
		clearAgentDiscoveryCache();
	});

	it("is discovered with a read-only evidence-review contract", () => {
		const auditor = discoverAgentsAll(projectDir).builtin.find((agent) => agent.name === "evidence-auditor");

		assert.ok(auditor);
		assert.deepEqual(auditor.tools, ["read", "web_search", "fetch_content", "get_search_content", "source_check"]);
		assert.equal(auditor.inheritProjectContext, true);
		assert.equal(auditor.inheritSkills, false);
		assert.match(auditor.systemPrompt, /Do not redo the original research/);
		assert.match(auditor.systemPrompt, /A URL is not evidence by itself/);
		assert.match(auditor.systemPrompt, /source_check.*supported.*contradicted.*unclear.*missing-evidence/);
		assert.match(auditor.systemPrompt, /Verified claims[\s\S]*Contradicted claims[\s\S]*Weak \/ unclear \/ unsupported claims/);
		assert.doesNotMatch(auditor.tools.join(","), /write|edit|bash/);
	});
});
