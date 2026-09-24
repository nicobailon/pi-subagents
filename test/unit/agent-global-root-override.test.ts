import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, it } from "node:test";
import { clearAgentDiscoveryCache, discoverAgentSnapshot, discoverAgents } from "../../src/agents/agents.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-global-root-"));
const fixtureRoot = path.join(temp, "quote's & space");
const previous = Object.fromEntries(["HOME", "USERPROFILE", "APPDATA", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PATH"].map((key) => [key, process.env[key]]));
const project = path.join(fixtureRoot, "project");
const rootA = path.join(fixtureRoot, "prefix-a", "lib", "node_modules");
const rootB = path.join(fixtureRoot, "prefix-b", "lib", "node_modules");
const invocationFile = path.join(fixtureRoot, "npm-invocations");

function writeAgent(file: string, name: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name}\n---\n\n${name}\n`);
}

function writePackage(root: string, name: string): void {
	const pkg = path.join(root, name);
	fs.mkdirSync(pkg, { recursive: true });
	fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name, "pi-subagents": { agents: ["agents"] } }));
	writeAgent(path.join(pkg, "agents", `${name}.md`), name);
}

before(() => {
	process.env.HOME = path.join(temp, "home");
	process.env.USERPROFILE = process.env.HOME;
	process.env.APPDATA = path.join(temp, "missing-appdata");
	process.env.PI_CODING_AGENT_DIR = path.join(temp, "home", ".pi", "agent");
	delete process.env.PI_OFFLINE;
	writeAgent(path.join(project, ".pi", "agents", "local.md"), "local-only");
	writePackage(rootA, "global-a");
	writePackage(rootB, "global-b");
	const bin = path.join(fixtureRoot, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "fake-npm.cjs"), `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(invocationFile)}, "x");
process.stdout.write(${JSON.stringify(`${rootA}\n`)});
`);
	const npm = path.join(bin, process.platform === "win32" ? "npm.cmd" : "npm");
	fs.writeFileSync(npm, process.platform === "win32"
		? `@echo off\r\n"${process.execPath}" "%~dp0fake-npm.cjs" %*\r\n`
		: `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-npm.cjs" "$@"\n`);
	if (process.platform !== "win32") fs.chmodSync(npm, 0o755);
	process.env.PATH = `${bin}${path.delimiter}${previous.PATH ?? ""}`;
	clearAgentDiscoveryCache();
});

after(() => {
	clearAgentDiscoveryCache();
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(temp, { recursive: true, force: true });
});

it("explicit null skips global lookup while retaining local agents and does not poison later roots", () => {
	const pending = discoverAgentSnapshot(project, "both", undefined, { includeChains: false, globalNpmRoot: null });
	assert.equal(pending.effective.agents.some((agent) => agent.name === "local-only"), true);
	assert.equal(pending.effective.agents.some((agent) => agent.name === "global-a"), false);
	assert.equal(pending.all.package.some((agent) => agent.name === "global-a"), false);
	assert.equal(fs.existsSync(invocationFile), false);

	const completed = discoverAgentSnapshot(project, "both", undefined, { includeChains: false, globalNpmRoot: rootA });
	assert.equal(completed.effective.agents.some((agent) => agent.name === "global-a"), true);
	assert.equal(completed.all.package.some((agent) => agent.name === "global-a"), true);
	assert.equal(fs.existsSync(invocationFile), false);
});

it("preserves synchronous custom-prefix lookup without an override", () => {
	const result = discoverAgents(project, "both");
	assert.equal(result.agents.some((agent) => agent.name === "global-a" && agent.source === "package"), true);
	assert.equal(fs.readFileSync(invocationFile, "utf8").trim(), "x");
});

it("different explicit roots cannot reuse stale cached package sources", () => {
	const changed = discoverAgents(project, "both", undefined, { globalNpmRoot: rootB });
	assert.equal(changed.agents.some((agent) => agent.name === "global-b"), true);
	assert.equal(changed.agents.some((agent) => agent.name === "global-a"), false);
	assert.equal(discoverAgents(project, "user", undefined, { globalNpmRoot: rootB }).agents.some((agent) => agent.name === "global-b"), true);
	assert.equal(fs.readFileSync(invocationFile, "utf8").trim(), "x");
});
