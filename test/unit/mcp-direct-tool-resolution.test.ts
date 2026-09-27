import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { McpServerDefinition } from "../../src/runs/shared/mcp-config-sources.ts";

// The resolver captures the generic `~/.config/mcp/mcp.json` and import paths
// from the home directory when its module loads, and it resolves servers and the
// metadata cache through the Pi agent directory. Isolate the home environment
// before importing it, so a direct `node --test` run without the repository test
// preload neither reads a developer's real MCP config nor touches a real agent
// directory.
const managedEnv = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"] as const;
const previousEnv: Record<string, string | undefined> = {};
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-resolution-"));
const homeDir = path.join(tempRoot, "home");
const agentDir = path.join(homeDir, ".pi", "agent");
const projectDir = path.join(tempRoot, "project");
for (const name of managedEnv) previousEnv[name] = process.env[name];
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
assert.equal(os.homedir(), homeDir, "test isolation must redirect the home directory before the resolver loads");

const { computeMcpServerHash, resolveMcpDirectToolResolution } = await import("../../src/runs/shared/mcp-direct-tool-allowlist.ts");
const { getAgentDir, getProjectConfigDir } = await import("../../src/shared/utils.ts");

const SELECTORS = ["codegraph/codegraph_explore", "codegraph/codegraph_node", "codegraph/codegraph_status"];
const SELECTED_NAMES = ["codegraph_explore", "codegraph_node", "codegraph_status"];
const CURRENT_DEFINITION: McpServerDefinition = {
	command: "npx",
	args: ["-y", "@colbymchenry/codegraph@1.6.0", "serve", "--mcp"],
	env: { CODEGRAPH_MCP_TOOLS: "explore,node,status" },
};

function writeServerConfig(configPath: string, definition: McpServerDefinition): void {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { codegraph: definition } }, null, 2), "utf-8");
}

function writeMetadataCache(definition: McpServerDefinition): void {
	const cachePath = path.join(getAgentDir(), "mcp-cache.json");
	fs.mkdirSync(path.dirname(cachePath), { recursive: true });
	fs.writeFileSync(cachePath, JSON.stringify({
		version: 1,
		servers: {
			codegraph: {
				configHash: computeMcpServerHash(definition),
				tools: SELECTED_NAMES.map((name) => ({ name })),
				cachedAt: Date.now(),
			},
		},
	}), "utf-8");
}

after(() => {
	for (const name of managedEnv) {
		const value = previousEnv[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("MCP direct-tool resolution config sources", () => {
	beforeEach(() => {
		assert.equal(getAgentDir(), agentDir, "test isolation must redirect the Pi agent directory");
		fs.rmSync(projectDir, { recursive: true, force: true });
		fs.mkdirSync(projectDir, { recursive: true });
		for (const name of ["mcp.json", "mcp-adapter.json", "mcp-cache.json"]) {
			fs.rmSync(path.join(agentDir, name), { force: true });
		}
	});

	it("resolves direct tools declared in the Pi-global mcp-adapter.json", () => {
		writeServerConfig(path.join(agentDir, "mcp-adapter.json"), CURRENT_DEFINITION);
		writeMetadataCache(CURRENT_DEFINITION);

		const resolution = resolveMcpDirectToolResolution(SELECTORS, projectDir);

		assert.deepEqual(resolution.selections.map((selection) => selection.name), SELECTED_NAMES);
		assert.deepEqual(resolution.unresolvedSelectors, []);
	});

	it("ignores Pi's own mcp.json files, which the adapter no longer reads", () => {
		writeServerConfig(path.join(agentDir, "mcp.json"), CURRENT_DEFINITION);
		writeServerConfig(path.join(getProjectConfigDir(projectDir), "mcp.json"), CURRENT_DEFINITION);
		writeMetadataCache(CURRENT_DEFINITION);

		const resolution = resolveMcpDirectToolResolution(SELECTORS, projectDir);

		assert.deepEqual(resolution.selections, []);
		assert.deepEqual(resolution.unresolvedSelectors, SELECTORS);
	});

	it("resolves direct tools declared in the project mcp-adapter.json", () => {
		writeServerConfig(path.join(getProjectConfigDir(projectDir), "mcp-adapter.json"), CURRENT_DEFINITION);
		writeMetadataCache(CURRENT_DEFINITION);

		const resolution = resolveMcpDirectToolResolution(SELECTORS, projectDir);

		assert.deepEqual(resolution.selections.map((selection) => selection.name), SELECTED_NAMES);
		assert.deepEqual(resolution.unresolvedSelectors, []);
	});
});
