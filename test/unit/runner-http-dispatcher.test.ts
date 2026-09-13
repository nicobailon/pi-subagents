import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { EnvHttpProxyAgent, fetch as undiciFetch, getGlobalDispatcher } from "undici";
import {
	DEFAULT_HTTP_IDLE_TIMEOUT_MS,
	parseHttpIdleTimeoutMs,
	resolveHttpIdleTimeoutMs,
	runnerHttpDispatcherOptions,
	installRunnerHttpDispatcher,
} from "../../src/runs/background/runner-http-dispatcher.ts";
import { getConfigDirName } from "../../src/shared/utils.ts";

const roots: string[] = [];
function fixture(settings: { global?: unknown; project?: unknown; globalRaw?: string }): { agentDir: string; cwd: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-http-idle-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "work");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(path.join(cwd, getConfigDirName()), { recursive: true });
	if (settings.globalRaw !== undefined) fs.writeFileSync(path.join(agentDir, "settings.json"), settings.globalRaw);
	else if (settings.global !== undefined) fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings.global));
	if (settings.project !== undefined) fs.writeFileSync(path.join(cwd, getConfigDirName(), "settings.json"), JSON.stringify(settings.project));
	return { agentDir, cwd };
}
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

describe("parseHttpIdleTimeoutMs mirrors Pi", () => {
	it("floors numbers, accepts numeric strings, treats disabled as 0", () => {
		assert.equal(parseHttpIdleTimeoutMs(1200.9), 1200);
		assert.equal(parseHttpIdleTimeoutMs(" 900000 "), 900000);
		assert.equal(parseHttpIdleTimeoutMs("Disabled"), 0);
		assert.equal(parseHttpIdleTimeoutMs(0), 0);
	});
	it("rejects negative, non-finite, empty, and non-numeric values", () => {
		for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, "", "soon", null, true, {}]) {
			assert.equal(parseHttpIdleTimeoutMs(value), undefined, String(value));
		}
	});
});

describe("resolveHttpIdleTimeoutMs", () => {
	it("defaults to Pi's 300s when no settings file sets it", () => {
		assert.deepEqual(resolveHttpIdleTimeoutMs(fixture({ global: { theme: "dark" } })), { timeoutMs: DEFAULT_HTTP_IDLE_TIMEOUT_MS, source: "default" });
		assert.deepEqual(resolveHttpIdleTimeoutMs(fixture({})), { timeoutMs: DEFAULT_HTTP_IDLE_TIMEOUT_MS, source: "default" });
	});
	it("reads the global setting, including 0 for disabled", () => {
		assert.deepEqual(resolveHttpIdleTimeoutMs(fixture({ global: { httpIdleTimeoutMs: 1_800_000 } })), { timeoutMs: 1_800_000, source: "global" });
		assert.deepEqual(resolveHttpIdleTimeoutMs(fixture({ global: { httpIdleTimeoutMs: 0 } })), { timeoutMs: 0, source: "global" });
	});
	it("lets the project setting override the global one", () => {
		const resolved = resolveHttpIdleTimeoutMs(fixture({ global: { httpIdleTimeoutMs: 60_000 }, project: { httpIdleTimeoutMs: 0 } }));
		assert.deepEqual(resolved, { timeoutMs: 0, source: "project" });
	});
	it("falls back with a warning when the value or file is invalid", () => {
		const invalid = resolveHttpIdleTimeoutMs(fixture({ global: { httpIdleTimeoutMs: "later" } }));
		assert.equal(invalid.timeoutMs, DEFAULT_HTTP_IDLE_TIMEOUT_MS);
		assert.equal(invalid.source, "default");
		assert.match(invalid.warning ?? "", /invalid httpIdleTimeoutMs/);
		const projectInvalid = resolveHttpIdleTimeoutMs(fixture({ global: { httpIdleTimeoutMs: 0 }, project: { httpIdleTimeoutMs: -5 } }));
		assert.equal(projectInvalid.timeoutMs, DEFAULT_HTTP_IDLE_TIMEOUT_MS, "an invalid project override must not fall through to the global value");
		assert.equal(projectInvalid.source, "default");
		assert.match(projectInvalid.warning ?? "", /invalid httpIdleTimeoutMs/);
		const broken = resolveHttpIdleTimeoutMs(fixture({ globalRaw: "{ not json", project: { httpIdleTimeoutMs: 5_000 } }));
		assert.equal(broken.timeoutMs, 5_000);
		assert.equal(broken.source, "project");
		assert.equal(broken.warning, undefined, "project value wins before the global file is consulted");
		const brokenOnly = resolveHttpIdleTimeoutMs(fixture({ globalRaw: "{ not json" }));
		assert.equal(brokenOnly.timeoutMs, DEFAULT_HTTP_IDLE_TIMEOUT_MS);
		assert.match(brokenOnly.warning ?? "", /cannot parse/);
	});
});

describe("runner dispatcher honours the resolved idle timeout", () => {
	async function withDelayedServer(delayMs: number, run: (url: string) => Promise<void>): Promise<void> {
		const server = createServer((_req, res) => {
			setTimeout(() => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); }, delayMs);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address === "object");
		try {
			await run(`http://127.0.0.1:${address.port}/`);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	it("a short headersTimeout cuts a slow response; 0 (disabled) lets it finish", async () => {
		// undici coalesces idle timers on a ~1s tick, so keep the delay well past the bound.
		await withDelayedServer(2_500, async (url) => {
			const bounded = new EnvHttpProxyAgent(runnerHttpDispatcherOptions(200));
			try {
				await assert.rejects(undiciFetch(url, { dispatcher: bounded }), (error: unknown) => {
					const cause = (error as { cause?: { code?: string } }).cause;
					return cause?.code === "UND_ERR_HEADERS_TIMEOUT";
				});
			} finally {
				await bounded.close();
			}
			const unbounded = new EnvHttpProxyAgent(runnerHttpDispatcherOptions(0));
			try {
				const response = await undiciFetch(url, { dispatcher: unbounded });
				assert.equal(await response.text(), "ok");
			} finally {
				await unbounded.close();
			}
		});
	});

	it("installRunnerHttpDispatcher applies the resolved setting to the process-global dispatcher", async () => {
		// Runs last in this file: it replaces the global dispatcher and fetch for this test process.
		await withDelayedServer(2_500, async (url) => {
			installRunnerHttpDispatcher(fixture({ project: { httpIdleTimeoutMs: 200 } }));
			const installed = getGlobalDispatcher();
			assert.ok(installed instanceof EnvHttpProxyAgent, "runner dispatcher is the global dispatcher");
			await assert.rejects(globalThis.fetch(url), (error: unknown) => {
				const cause = (error as { cause?: { code?: string } }).cause;
				return cause?.code === "UND_ERR_HEADERS_TIMEOUT";
			});
			installRunnerHttpDispatcher(fixture({ project: { httpIdleTimeoutMs: 0 } }));
			assert.notEqual(getGlobalDispatcher(), installed, "a fresh dispatcher replaces the bounded one");
			const response = await globalThis.fetch(url);
			assert.equal(await response.text(), "ok");
		});
	});

	it("keeps the proxy-aware shape the runner relied on", () => {
		assert.deepEqual(runnerHttpDispatcherOptions(42), { allowH2: false, proxyTunnel: true, headersTimeout: 42, bodyTimeout: 42 });
	});
});
