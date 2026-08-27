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
			{ name: "browser_mcp_navigate", selector: "browser-mcp/navigate" },
			{ name: "browser_mcp_get_console_logs", selector: "browser-mcp/get_console_logs" },
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
