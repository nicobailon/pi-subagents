import assert from "node:assert/strict";
import test from "node:test";
import { planMcpDirectToolGrant } from "../../src/runs/shared/mcp-direct-tool-grant.ts";

test("plans server grants from explicit metadata facts and preserves resource filtering", () => {
	const grant = planMcpDirectToolGrant({
		selectors: ["browser-mcp"],
		servers: {
			"browser-mcp": { excludeTools: ["browser_click"] },
		},
		metadata: {
			"browser-mcp": {
				tools: [{ name: "click" }, { name: "navigate" }],
				resources: [{ name: "Console Logs", uri: "resource://console" }],
			},
		},
		toolPrefix: "server",
	});

	assert.deepEqual(grant, {
		selections: [
			{ name: "browser-mcp_navigate", selector: "browser-mcp/navigate" },
			{ name: "browser-mcp_get_console_logs", selector: "browser-mcp/get_console_logs" },
		],
		unresolvedSelectors: [],
	});
});

test("plans tool-specific grants and reports unresolved selectors deterministically", () => {
	const grant = planMcpDirectToolGrant({
		selectors: ["github/search_repositories", "missing"],
		servers: {
			github: {},
		},
		metadata: {
			github: { tools: [{ name: "search_repositories" }, { name: "create_issue" }] },
		},
		toolPrefix: "none",
	});

	assert.deepEqual(grant, {
		selections: [{ name: "search_repositories", selector: "github/search_repositories" }],
		unresolvedSelectors: ["missing"],
	});
});

test("fails closed for missing or stale source facts without consulting ambient state", () => {
	const grant = planMcpDirectToolGrant({
		selectors: ["github", "github/search_repositories"],
		servers: {
			github: {},
		},
		metadata: {},
	});

	assert.deepEqual(grant, {
		selections: [],
		unresolvedSelectors: ["github", "github/search_repositories"],
	});
});

test("enforces server includeTools before exclusions for tools and generated resources", () => {
	const grant = planMcpDirectToolGrant({
		selectors: ["demo"],
		servers: {
			demo: {
				includeTools: ["get_*", "demo_list_records"],
				excludeTools: ["get_secret", "demo_get_private*"],
			},
		},
		metadata: {
			demo: {
				tools: [
					{ name: "get_public" },
					{ name: "get_secret" },
					{ name: "list_records" },
					{ name: "other" },
				],
				resources: [
					{ name: "Run Book", uri: "resource://run-book" },
					{ name: "Private Notes", uri: "resource://private-notes" },
				],
			},
		},
		toolPrefix: "server",
	});

	assert.deepEqual(grant.selections, [
		{ name: "demo_get_public", selector: "demo/get_public" },
		{ name: "demo_list_records", selector: "demo/list_records" },
		{ name: "demo_get_run_book", selector: "demo/get_run_book" },
	]);
	assert.deepEqual(grant.unresolvedSelectors, []);
});

test("matches include and exclude patterns against raw and alternate prefix names", () => {
	for (const [toolPrefix, expectedName] of [
		["server", "demo-mcp_search-records"],
		["short", "demo_search-records"],
		["none", "search-records"],
	] as const) {
		const allowed = planMcpDirectToolGrant({
			selectors: ["demo-mcp"],
			servers: { "demo-mcp": { includeTools: ["demo_mcp_search_records"] } },
			metadata: { "demo-mcp": { tools: [{ name: "search-records" }] } },
			toolPrefix,
		});
		assert.deepEqual(allowed.selections, [{ name: expectedName, selector: "demo-mcp/search-records" }]);

		const excluded = planMcpDirectToolGrant({
			selectors: ["demo-mcp"],
			servers: { "demo-mcp": { includeTools: ["demo_mcp_search_records"], excludeTools: ["search_records"] } },
			metadata: { "demo-mcp": { tools: [{ name: "search-records" }] } },
			toolPrefix,
		});
		assert.deepEqual(excluded.selections, []);
	}
});

test("matches adapter names for test-mcp/example in every prefix mode", () => {
	for (const [toolPrefix, expectedName] of [
		["server", "test-mcp_example"],
		["short", "test_example"],
		["none", "example"],
	] as const) {
		const grant = planMcpDirectToolGrant({
			selectors: ["test-mcp"],
			servers: { "test-mcp": {} },
			metadata: { "test-mcp": { tools: [{ name: "example" }] } },
			toolPrefix,
		});

		assert.deepEqual(grant.selections, [{ name: expectedName, selector: "test-mcp/example" }]);
	}
});

test("supports adapter-compatible question-mark patterns", () => {
	const grant = planMcpDirectToolGrant({
		selectors: ["demo"],
		servers: { demo: { includeTools: ["get_????"], excludeTools: ["get_?ecret"] } },
		metadata: { demo: { tools: [{ name: "get_wiki" }, { name: "get_secret" }, { name: "get_longer" }] } },
	});

	assert.deepEqual(grant.selections, [{ name: "demo_get_wiki", selector: "demo/get_wiki" }]);
});

test("matches adapter mcp-prefixed policy names", () => {
	const grant = planMcpDirectToolGrant({
		selectors: ["demo"],
		servers: { demo: { includeTools: ["mcp_search_records"] } },
		metadata: { demo: { tools: [{ name: "search_records" }, { name: "list_records" }] } },
	});

	assert.deepEqual(grant.selections, [{ name: "demo_search_records", selector: "demo/search_records" }]);
});

test("keeps a tool name that already carries the server prefix, matching adapter registration", () => {
	for (const [toolPrefix, serverName, expectedName] of [
		["server", "codegraph", "codegraph_explore"],
		["short", "codegraph-mcp", "codegraph_explore"],
		["none", "codegraph", "codegraph_explore"],
	] as const) {
		const grant = planMcpDirectToolGrant({
			selectors: [`${serverName}/codegraph_explore`],
			servers: { [serverName]: {} },
			metadata: { [serverName]: { tools: [{ name: "codegraph_explore" }, { name: "codegraph_status" }] } },
			toolPrefix,
		});

		assert.deepEqual(grant.selections, [{ name: expectedName, selector: `${serverName}/codegraph_explore` }]);
	}
});

test("sanitizes server prefixes the way adapter registration does", () => {
	for (const [toolPrefix, serverName, expectedName] of [
		["server", "my server.x", "my_20_server_2e_x_ping"],
		["short", "weird  server-mcp", "weird_20__20_server_ping"],
		["mcp", "my server.x", "mcp__my_20_server_2e_x_ping"],
	] as const) {
		const grant = planMcpDirectToolGrant({
			selectors: [serverName],
			servers: { [serverName]: {} },
			metadata: { [serverName]: { tools: [{ name: "ping" }] } },
			toolPrefix,
		});

		assert.deepEqual(grant.selections, [{ name: expectedName, selector: `${serverName}/ping` }]);
	}
});

test("supports the adapter mcp prefix mode", () => {
	const grant = planMcpDirectToolGrant({
		selectors: ["codegraph"],
		servers: { codegraph: {} },
		metadata: { codegraph: { tools: [{ name: "ping" }, { name: "codegraph_explore" }] } },
		toolPrefix: "mcp",
	});

	assert.deepEqual(grant.selections, [
		{ name: "mcp__codegraph_ping", selector: "codegraph/ping" },
		{ name: "mcp__codegraph_codegraph_explore", selector: "codegraph/codegraph_explore" },
	]);
});

test("honours a per-server toolPrefix over the global setting", () => {
	const grant = planMcpDirectToolGrant({
		selectors: ["demo", "demo-mcp"],
		servers: { demo: { toolPrefix: "none" }, "demo-mcp": { toolPrefix: "short" } },
		metadata: { demo: { tools: [{ name: "ping" }] }, "demo-mcp": { tools: [{ name: "ping" }] } },
		toolPrefix: "server",
	});

	assert.deepEqual(grant.selections, [
		{ name: "ping", selector: "demo/ping" },
		{ name: "demo_ping", selector: "demo-mcp/ping" },
	]);
});

test("sanitizes dotted tool names the way adapter registration does", () => {
	const grant = planMcpDirectToolGrant({
		selectors: ["github"],
		servers: { github: {} },
		metadata: { github: { tools: [{ name: "repo.search" }] } },
		toolPrefix: "server",
	});

	assert.deepEqual(grant.selections, [{ name: "github_repo_search", selector: "github/repo.search" }]);
});
