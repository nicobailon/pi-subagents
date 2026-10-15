import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { createDefaultChildSessionFactory, loadHostPiCodingAgent, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";

// Opt-in, like nested-async-wait: the real host owns the MCP runtime and all peers.
it("native built-in MCP startup follows the selected connection attempts", {
	skip: !process.env.PI_SUBAGENTS_NATIVE_PI_ROOT && "Requires PI_SUBAGENTS_NATIVE_PI_ROOT and native-peer-loader.mjs",
	timeout: 60_000,
}, async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-mcp-ready-"));
	const agentDir = path.join(root, "agent");
	const serverPath = path.join(root, "server.cjs");
	const auditPath = path.join(root, "server.jsonl");
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
	fs.writeFileSync(serverPath, `
const fs = require("node:fs");
const readline = require("node:readline");
const [delay, mode, audit] = process.argv.slice(2);
const record = (event) => fs.appendFileSync(audit, JSON.stringify({ pid: process.pid, mode, event }) + "\\n");
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const tools = ["status", "node", "explore", "unselected"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } }));
record("started");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  record(message.method);
  if (message.method === "initialize") {
    if (mode === "fail") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "controlled startup failure" } }) + "\\n");
    else setTimeout(() => { record("initialized"); reply(message.id, { protocolVersion: message.params.protocolVersion, serverInfo: { name: "readiness-fixture", version: "1" }, capabilities: { tools: {} } }); }, Number(delay));
  } else if (message.method === "tools/list") reply(message.id, { tools });
  else if (message.method === "tools/call") reply(message.id, { content: [{ type: "text", text: "CALLED_" + message.params.name }] });
});
rl.on("close", () => { record("closed"); process.exit(0); });
`);
	const host = await loadHostPiCodingAgent();
	let session: Awaited<ReturnType<PiCodingAgentModule["createAgentSession"]>>["session"] | undefined;
	const pi = { ...host, createAgentSession: async (options) => {
		const result = await host.createAgentSession(options);
		session = result.session;
		return result;
	} } as PiCodingAgentModule;
	const launch: ChildSessionLaunch = {
		cwd: root, storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: false,
		hooks: [], noSkills: true, noContextFiles: true,
		tools: ["read", ...["status", "node", "explore"].map((name) => `mcp__selected__${name}`)],
		builtinMcpTools: ["status", "node", "explore"].map((name) => ({ name: `mcp__selected__${name}`, selector: `selected/${name}` })),
		runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"],
	};
	const audit = () => fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; mode: string; event: string }) : [];
	const configure = (delay: number, mode = "selected", unselected = false) => {
		fs.writeFileSync(auditPath, "");
		const server = (ms: number, name: string) => ({ command: process.execPath, args: [serverPath, String(ms), name, auditPath], timeout: 30 });
		fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
			selected: server(delay, mode), ...(unselected ? { other: server(25_000, "other") } : {}),
		} }));
	};
	try {
		await t.test("waits beyond ten seconds without waiting for an unselected server or requesting a model", async () => {
			configure(11_200, "selected", true);
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
			try {
				const started = Date.now();
				const child = await factory.create(launch);
				assert.ok(Date.now() - started >= 11_000);
				assert.ok(audit().some((row) => row.mode === "selected" && row.event === "initialized"));
				assert.ok(!audit().some((row) => row.mode === "other" && row.event === "initialized"));
				assert.deepEqual(child.messages, []);
				assert.deepEqual(session!.getActiveToolNames().filter((name) => name.startsWith("mcp__")), launch.builtinMcpTools!.map(({ name }) => name));
				for (const { name } of launch.builtinMcpTools!) {
					const tool = session!.agent.state.tools.find((candidate) => candidate.name === name);
					assert.ok(tool);
					const result = await tool.execute(`readiness/${name}`, {}, new AbortController().signal);
					assert.ok(result.content.some((part) => part.type === "text" && part.text === `CALLED_${name.split("__").at(-1)}`));
				}
				assert.ok(!session!.getActiveToolNames().includes("codemode"), "readiness must not grant codemode access");
				await child.dispose();
			} finally { await factory.dispose(); }
		});
		await t.test("fails promptly after initialization fails and shuts the session down", async () => {
			configure(0, "fail");
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
			try {
				const started = Date.now();
				await assert.rejects(factory.create(launch), /Selected built-in MCP tools did not register/);
				assert.ok(Date.now() - started < 8_000, "must not wait for an unrelated registration deadline");
				assert.ok(!audit().some((row) => row.event === "tools/call"));
			} finally { await factory.dispose(); }
		});
		await t.test("fails closed when a connected server does not offer the selected tool", async () => {
			configure(0);
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
			try {
				await assert.rejects(factory.create({ ...launch, tools: ["mcp__selected__missing"], builtinMcpTools: [{ name: "mcp__selected__missing", selector: "selected/missing" }] }), /did not register in the child session: mcp__selected__missing/);
				assert.ok(audit().some((row) => row.event === "tools/list"));
				assert.ok(!audit().some((row) => row.event === "tools/call"));
			} finally { await factory.dispose(); }
		});
		await t.test("factory disposal cancels a pending connection and closes its stdio server", async () => {
			configure(25_000);
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
			const creating = factory.create(launch);
			const rejected = assert.rejects(creating, /disposed while the child waited for its MCP tools/);
			try {
				const deadline = Date.now() + 10_000;
				while (!audit().some((row) => row.event === "initialize")) {
					assert.ok(Date.now() < deadline, "server did not start");
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				const started = Date.now();
				await factory.dispose();
				await rejected;
				assert.ok(Date.now() - started < 3_000);
				assert.ok(audit().some((row) => row.event === "closed"));
				assert.ok(!audit().some((row) => row.event === "initialized"));
			} finally { await factory.dispose(); }
		});
		await t.test("launch cancellation stops a pending MCP connection before the model starts", async () => {
			configure(25_000);
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
			const cancel = new AbortController();
			const creating = factory.create({ ...launch, signal: cancel.signal });
			const rejected = assert.rejects(creating, /launch was cancelled while waiting for its MCP tools/);
			try {
				const deadline = Date.now() + 10_000;
				while (!audit().some((row) => row.event === "initialize")) {
					assert.ok(Date.now() < deadline, "server did not start");
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				const started = Date.now();
				cancel.abort();
				await rejected;
				assert.ok(Date.now() - started < 3_000);
				assert.ok(audit().some((row) => row.event === "closed"));
				assert.ok(!audit().some((row) => row.event === "tools/call"));
				assert.deepEqual(session!.messages, []);
			} finally { await factory.dispose(); }
		});
	} finally {
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
