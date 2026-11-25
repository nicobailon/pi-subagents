import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { createDefaultChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { DEFAULT_ARTIFACT_CONFIG, type FastServiceTier } from "../../src/shared/types.ts";
import { makeAgent } from "../support/helpers.ts";

function readJson(file: string) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function awaitRunnerExit(dir: string) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const proof = readJson(path.join(dir, "process-terminal.json"));
		if (proof?.state === "observed") {
			assert.ok(proof.instances.some((instance: { kind: string }) => instance.kind === "runner"), JSON.stringify(proof));
			return readJson(path.join(dir, "status.json"));
		}
		await delay(25);
	}
	throw new Error(`Missing detached runner exit for ${dir}: ${JSON.stringify(readJson(path.join(dir, "status.json")))}`);
}

it("forwards Fast tiers via the native adapters on foreground and detached launches", { timeout: 90_000 }, async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fast-wire-"));
	const agentDir = path.join(cwd, "agent");
	const audit = path.join(cwd, "requests.jsonl");
	const preload = new URL("../fixtures/native-fast-wire.mjs", import.meta.url).href;
	const codexToken = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.token`;
	const env = { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NODE_OPTIONS: `--import=${preload}`, PI_FAST_WIRE_LOG: audit, PI_FAST_WIRE_CODEX_TOKEN: codexToken };
	const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
	t.after(() => {
		Object.defineProperty(globalThis, "fetch", originalFetch);
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		fs.rmSync(cwd, { recursive: true, force: true });
	});
	Object.assign(process.env, env);
	await import(preload);
	const configDir = path.join(agentDir, "extensions", "subagent");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(audit, "");
	const requests = (tag: string) => fs.readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(record => record.tag === tag);
	const writeJson = (dir: string, file: string, data: unknown) => fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
	const oauth = (access: string) => ({ type: "oauth", access, refresh: "fixture-refresh", expires: Date.now() + 86_400_000 });
	const oauthAuth = { openai: oauth("fixture.chatgpt.token"), "openai-codex": oauth(codexToken) };
	writeJson(agentDir, "auth.json", oauthAuth);
	writeJson(agentDir, "settings.json", { transport: "sse", compaction: { enabled: false }, retry: { enabled: false } });
	writeJson(agentDir, "models.json", { providers: {
		"fixture-responses": { api: "openai-responses", apiKey: "fixture-key", baseUrl: "https://fixture.invalid/v1", models: [{ id: "synthetic-next-model", name: "Synthetic" }] },
		"fixture-completions": { api: "openai-completions", apiKey: "fixture-key", baseUrl: "https://fixture.invalid/v1", models: [{ id: "unrelated-model", name: "Unrelated" }] },
	} });
	const factory = createDefaultChildSessionFactory();
	try {
		await t.test("installs Fast before a session_start hook can send a request", async () => {
			writeJson(configDir, "config.json", { fastServiceTier: "ultrafast" });
			const { session } = buildInProcessChildLaunch({
				host: "parent", cwd, childAgentName: "startup", childIndex: 0, sessionEnabled: false,
				model: "openai/gpt-6-sol", fast: true, tools: [], inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
			});
			session.hooks.push({ name: "startup-wire-fixture", factory(pi) {
				pi.on("session_start", async () => {
					const settled = new Promise<void>(resolve => {
						const unsubscribe = pi.on("agent_end", () => { unsubscribe(); resolve(); });
					});
					pi.sendUserMessage("WIRE_STARTUP: return the fixture response.");
					await Promise.race([settled, delay(10_000, undefined, { ref: false })]);
				});
			} });
			const child = await factory.create(session);
			try {
				const records = requests("WIRE_STARTUP");
				assert.equal(records.length, 1);
				assert.equal(records[0].body.service_tier, "ultrafast");
			} finally { await child.dispose(); }
		});
		const cases: Array<{ name: string; model: string; route?: string; configured?: FastServiceTier; fast?: boolean; expected?: FastServiceTier; invalidConfig?: boolean; diagnostic?: RegExp; alsoDetached?: boolean }> = [
			{ name: "DEFAULT", model: "openai/gpt-6-sol", route: "responses", fast: true, expected: "priority", alsoDetached: true },
			{ name: "ULTRA", model: "openai/gpt-6-sol", route: "responses", fast: true, configured: "ultrafast", expected: "ultrafast", alsoDetached: true },
			{ name: "CODEX", model: "openai-codex/gpt-6-sol", route: "codex", fast: true, configured: "priority", expected: "priority" },
			{ name: "KEY", model: "fixture-responses/synthetic-next-model", route: "api-key", fast: true, configured: "ultrafast", expected: "ultrafast" },
			{ name: "OMITTED", model: "openai/gpt-6-sol", route: "responses", configured: "ultrafast" },
			{ name: "FALSE", model: "openai/gpt-6-sol", route: "responses", fast: false, configured: "ultrafast" },
			{ name: "REJECT", model: "fixture-completions/unrelated-model", fast: true, diagnostic: /Cannot forward fast mode service_tier.*openai-completions.*fast: false/ },
			{ name: "UNRELATED", model: "fixture-completions/unrelated-model", route: "completions", fast: false },
			{ name: "TIER_DENIED", model: "openai/gpt-6-sol", route: "responses", fast: true, configured: "ultrafast", expected: "ultrafast", diagnostic: /fixture tier unsupported/ },
			{ name: "BAD_CONFIG", model: "openai/gpt-6-sol", fast: true, configured: "ultrafast", invalidConfig: true, diagnostic: /config\.asyncWidgetLayout/, alsoDetached: true },
			{ name: "BAD_CONFIG_OFF", model: "openai/gpt-6-sol", route: "responses", fast: false, configured: "ultrafast", invalidConfig: true },
			{ name: "OPENAI_KEY", model: "openai/gpt-6-sol", route: "responses", fast: true, configured: "priority", expected: "priority" },
		];
		for (const entry of cases) {
			if (entry.name === "OPENAI_KEY") {
				await factory.dispose();
				writeJson(agentDir, "auth.json", { ...oauthAuth, openai: { type: "api_key", key: "fixture-key" } });
			}
			writeJson(configDir, "config.json", { fastServiceTier: entry.configured, ...(entry.invalidConfig ? { asyncWidgetLayout: "compact" } : {}) });
			const [provider, id] = entry.model.split("/");
			const agent = makeAgent("worker", { model: entry.model, tools: ["read"], inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false });
			const fast = entry.fast === undefined ? {} : { fast: entry.fast };
			for (const detached of entry.alsoDetached ? [false, true] : [false]) await t.test(`${entry.name} ${detached ? "detached" : "foreground"}`, async () => {
				const tag = `WIRE_${entry.name}_${detached ? "BG" : "FG"}`;
				const task = `${tag}: return the fixture response.`;
				const { diagnostic } = entry;
				if (detached) {
					const launch = await executeAsyncSingle(tag.toLowerCase(), {
						agent: agent.name, agentConfig: agent, task, ...fast, acceptance: false,
						ctx: { pi: { events: { emit() {} } }, cwd, currentSessionId: "fast-wire" },
						artifactConfig: { ...DEFAULT_ARTIFACT_CONFIG, enabled: false }, shareEnabled: false,
						sessionRoot: path.join(cwd, "sessions"), availableModels: [{ provider, id, fullId: entry.model }],
					});
					assert.ok(launch.details.asyncDir && !launch.isError, JSON.stringify(launch));
					const status = await awaitRunnerExit(launch.details.asyncDir);
					assert.equal(status.state, diagnostic ? "failed" : "complete", JSON.stringify(status));
					if (diagnostic) assert.match(status.error, diagnostic);
				} else {
					const result = await runSync(cwd, [agent], agent.name, task, {
						runId: tag.toLowerCase(), childSessionFactory: factory, ...fast, acceptance: false, timeoutMs: 10_000,
					});
					assert.equal(result.exitCode, diagnostic ? 1 : 0, result.error);
					if (diagnostic) assert.match(result.error ?? "", diagnostic);
					else assert.equal(result.finalOutput, "FAST_WIRE_OK");
				}
				const records = requests(tag);
				assert.equal(records.length, entry.route ? 1 : 0);
				if (!entry.route) return;
				const [{ route, pid, body }] = records;
				assert.equal(route, entry.route);
				assert.equal(pid !== process.pid, detached);
				assert.equal(body.model, id);
				assert.equal(Object.hasOwn(body, "service_tier"), entry.expected !== undefined);
				assert.equal(body.service_tier, entry.expected);
			});
		}
	} finally { await factory.dispose(); }
});
