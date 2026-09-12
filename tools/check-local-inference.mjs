#!/usr/bin/env node
// Portable, real Pi CLI -> public subagent tool -> detached runner -> real SDK -> local HTTP.
// All config, credentials, sessions and runtime artifacts belong to an isolated test directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../", import.meta.url));
const piRoot = process.argv[2];
assert.ok(piRoot && path.isAbsolute(piRoot), "Usage: node tools/check-local-inference.mjs /absolute/pi-coding-agent/package [--long]");
const version = JSON.parse(fs.readFileSync(path.join(piRoot, "package.json"), "utf8")).version;
const delay = process.argv.includes("--long") ? 310_000 : 250;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-ai-regression-"));
for (const dir of ["agent/extensions/subagent", "work/.pi/agents", "tmp"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
const records = [];
const timers = new Set();
const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); };
const server = createServer(async (req, res) => {
	if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
	let raw = ""; for await (const chunk of req) raw += chunk;
	const body = JSON.parse(raw);
	const task = [...body.messages].reverse().find((m) => m.role === "user")?.content;
	const marker = JSON.stringify(task).match(/TEST_(HEADERS|BODY|CANCEL|QUICK)/)?.[0];
	records.push({ marker, at: Date.now(), reasoning_effort: body.reasoning_effort });
	fs.writeFileSync(path.join(root, "requests.json"), JSON.stringify(records, null, 2));
	if (body.reasoning_effort !== "xhigh" || !marker) { res.writeHead(400); res.end(JSON.stringify({ error: { message: "fixture contract rejected" } })); return; }
	if (marker === "TEST_CANCEL") {
		fs.writeFileSync(path.join(root, "cancel-received.json"), "{}");
		res.on("close", () => fs.writeFileSync(path.join(root, "cancel-closed.json"), "{}"));
		return;
	}
	const send = () => {
		if (res.destroyed) return;
		res.write('data: ' + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "local-test", choices: [{ index: 0, delta: { content: "FIXTURE_OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }) + '\n\n');
		res.end("data: [DONE]\n\n");
	};
	const headers = () => { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); res.flushHeaders(); };
	if (marker === "TEST_BODY") { headers(); res.write(": waiting for inference\n\n"); later(send, delay); }
	else later(() => { if (!res.destroyed) { headers(); send(); } }, marker === "TEST_HEADERS" ? delay : 100);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
fs.writeFileSync(path.join(root, "agent/settings.json"), JSON.stringify({ defaultProvider: "local-fixture", defaultModel: "local-test", defaultThinkingLevel: "xhigh", httpIdleTimeoutMs: 1, packages: [], retry: { enabled: false } }));
fs.writeFileSync(path.join(root, "agent/models.json"), JSON.stringify({ providers: { "local-fixture": { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fixture-only", models: [{ id: "local-test", name: "Local regression fixture", reasoning: true, thinkingLevelMap: { high: "xhigh", xhigh: "xhigh" }, contextWindow: 262144, maxTokens: 262144, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
fs.writeFileSync(path.join(root, "agent/extensions/subagent/config.json"), JSON.stringify({ localInference: { enabled: true }, timeoutMs: 1, maxActiveAsyncRunsPerSession: 1, globalConcurrencyLimit: 2 }));
fs.writeFileSync(path.join(root, "work/.pi/agents/local-fixture.md"), "---\nname: local-fixture\ndescription: Local HTTP regression fixture\nmodel: local-fixture/local-test:xhigh\nthinking: xhigh\ntools:\ncompletionGuard: false\n---\nReturn the fixture response.\n");
console.log(`Testing Pi ${version}; ${delay}ms HTTP delay. Artifacts: ${root}`);
const args = [path.join(piRoot, "dist/cli.js"), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session", "--mode", "rpc", "--extension", path.join(source, "test/smoke/local-inference-parent.ts")];
const child = spawn(process.execPath, args, { cwd: path.join(root, "work"), env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_SUBAGENTS_TEMP_ROOT: path.join(root, "tmp"), PI_LOCAL_AI_TEST_ROOT: root, PI_OFFLINE: "1", JITI_FS_CACHE: "false", TERM: "dumb" }, stdio: ["pipe", "pipe", "pipe"] });
const log = fs.createWriteStream(path.join(root, "parent.log"));
child.stdout.on("data", (chunk) => { log.write(chunk); for (const line of String(chunk).split("\n")) if (line.startsWith("PASS ")) console.log(line); });
child.stderr.on("data", (chunk) => log.write(chunk));
// Test watchdog only; never installed as an inference setting.
const watchdog = setTimeout(() => child.kill("SIGTERM"), delay + 120_000);
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
clearTimeout(watchdog);
for (const timer of timers) clearTimeout(timer);
server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); log.end();
assert.equal(code, 0, `Regression failed. Inspect ${path.join(root, "parent.log")}`);
assert.ok(fs.existsSync(path.join(root, "passed.json")));
assert.equal(records.filter((r) => r.marker === "TEST_HEADERS").length, 1, "no hidden retries");
assert.equal(records.filter((r) => r.marker === "TEST_BODY").length, 1, "no hidden retries");
console.log(`PASS real local-AI runtime ${version}; headers/body survived ${delay}ms, foreground/background, operator cancellation, capacity release.`);
