import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildSession, ChildSessionFactory, ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import { createPlacementAwareChildSessionFactory, projectNativeMachineEvidence, serializeNativeRemoteLaunch } from "../../src/runs/shared/remote-native-session.ts";
import { formatHerdrMachineRunnerUnsupported, isNativePiRunner } from "../../src/runs/shared/herdr-machine.ts";
import { buildRunnerChildLaunch } from "../../src/runs/background/runner-child-launch.ts";
import { resolveRemoteNativePromptLaunch, resolveRemoteNativeSkillLaunch, runRemoteNativeHost, teardownRemoteNativeChild } from "../../src/runs/shared/remote-native-host.ts";
import { encodeNativeRemoteRpcRecord } from "../../src/runs/shared/native-remote-rpc.ts";

const child: ChildSession = {
	subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, followUp: async () => {}, abort: async () => {}, dispose: async () => {},
	messages: [], sessionFile: undefined, sessionId: "remote", modelId: "test/model",
};

function launch(machine = true): ChildSessionLaunch {
	return {
		cwd: "/remote/project", storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: true, hooks: [], noSkills: true, noContextFiles: false,
		runtime: { agent: "worker", childIndex: 0, fanoutChild: false, inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: false, fast: false, depth: 1, maxDepth: 2, waitTool: { enabled: true } },
		...(machine ? { machine: { provider: "herdr" as const, id: "saved", label: "workmac", target: "remote.example", cwd: "/remote/project" } } : {}),
	};
}

describe("native saved-machine placement", () => {
	it("routes a bare worker machine launch to the native remote session rather than the local factory", async () => {
		let localCreates = 0;
		let remoteLaunch: ChildSessionLaunch | undefined;
		const local: ChildSessionFactory = { create: async () => { localCreates++; return child; }, dispose: async () => {} };
		const factory = createPlacementAwareChildSessionFactory(local, { createRemote: async (input) => { remoteLaunch = input; return child; } });
		assert.equal(formatHerdrMachineRunnerUnsupported({ machine: "workmac", agentName: "worker" }), process.platform === "win32" ? "Herdr saved-machine launches use OpenSSH and a POSIX remote shell, which is not supported from a Windows host yet." : undefined);
		await factory.create(launch());
		assert.equal(localCreates, 0);
		assert.equal(remoteLaunch?.machine?.label, "workmac");
		assert.equal(remoteLaunch?.runtime.agent, "worker");
	});

	it("leaves local native launches and external-cli restrictions unchanged", async () => {
		let localCreates = 0;
		const local: ChildSessionFactory = { create: async () => { localCreates++; return child; }, dispose: async () => {} };
		await createPlacementAwareChildSessionFactory(local).create(launch(false));
		assert.equal(localCreates, 1);
		if (process.platform !== "win32") assert.match(formatHerdrMachineRunnerUnsupported({ machine: "workmac", agentName: "custom", runnerType: "external-cli" }) ?? "", /generic external-cli commands/u);
		assert.equal(isNativePiRunner({ type: "pi" }), true);
	});

	it("preserves read-only versus writer tool policy and rejects local resource transfer", () => {
		const readonly = { ...launch(), tools: ["read", "grep", "find", "ls"] };
		const writer = { ...launch(), tools: ["read", "bash", "edit", "write", "contact_supervisor"] };
		assert.deepEqual(serializeNativeRemoteLaunch(readonly).tools, readonly.tools);
		assert.deepEqual(serializeNativeRemoteLaunch(writer).tools, writer.tools);
		assert.throws(() => serializeNativeRemoteLaunch({ ...writer, extensionPaths: ["/local/extension.ts"] }), /cannot transfer local extension resources/u);
		assert.throws(() => serializeNativeRemoteLaunch({ ...writer, storage: { kind: "file", sessionFile: "/local/fork.jsonl" } }), /does not support forked, resumed, or revived/u);
		const runnerBaseline = { ...writer, processEnv: { PI_SUBAGENT_EXTENSION_BINDINGS: undefined, MCP_DIRECT_TOOLS: "__none__" } };
		assert.doesNotThrow(() => serializeNativeRemoteLaunch(runnerBaseline));
		assert.throws(() => serializeNativeRemoteLaunch({ ...writer, runtime: { ...writer.runtime, nestedRoute: { rootRunId: "r", eventSink: "/Users/alice/events", controlInbox: "/Users/alice/control", capabilityToken: "SECRET" } } }), /does not transfer nested-route paths or capability tokens/u);
		assert.doesNotMatch(JSON.stringify(serializeNativeRemoteLaunch(runnerBaseline)), /Users|SECRET|PI_SUBAGENT_EXTENSION_BINDINGS|MCP_DIRECT_TOOLS/u);
	});

	it("serializes the production async buildRunnerChildLaunch path without local process environment", () => {
		const machine = launch().machine!;
		const localSessions = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-sessions-"));
		const built = buildRunnerChildLaunch({ agent: "worker", task: "edit", machine, machineEnv: {}, tools: ["read", "edit", "write"], skills: ["remote-review"], memory: { scope: "project", path: "worker" }, systemPrompt: "BASE_REMOTE_PROMPT", systemPromptMode: "replace", inheritProjectContext: true, inheritGlobalContext: false, inheritSkills: false }, { cwd: "/local/project", id: "run", flatIndex: 0 }, { sessionEnabled: true, sessionDir: localSessions, thinking: undefined, watchdogStatus() {} } as never);
		const serialized = serializeNativeRemoteLaunch(built.session);
		assert.equal(serialized.cwd, "/remote/project");
		assert.ok(!JSON.stringify(serialized).includes(localSessions));
		assert.deepEqual((serialized.remotePromptSpec as { skillNames?: string[] }).skillNames, ["remote-review"]);
		assert.equal((serialized.remotePromptSpec as { memory?: { path: string } }).memory?.path, "worker");
		assert.doesNotMatch(JSON.stringify(serialized), /PI_SUBAGENT_CHILD|MCP_DIRECT_TOOLS/u);
		fs.rmSync(localSessions, { recursive: true, force: true });
	});

	it("preserves remote-only provider models and thinking while leaving omitted defaults omitted", () => {
		const selected = serializeNativeRemoteLaunch({ ...launch(), model: "remote-provider/model-x:high" });
		assert.equal(selected.model, "remote-provider/model-x:high");
		const defaulted = serializeNativeRemoteLaunch({ ...launch(), thinking: "high" });
		assert.equal(defaulted.model, undefined);
		assert.equal(defaulted.thinking, "high");
	});

	it("serializes only logical skill names and resolves their locations from the remote cwd", () => {
		const remote = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-remote-skills-"));
		const skillFile = path.join(remote, ".pi", "skills", "remote-review", "SKILL.md"); fs.mkdirSync(path.dirname(skillFile), { recursive: true }); fs.writeFileSync(skillFile, "---\ndescription: Remote review\n---\n\nUse remote resources.\n");
		try {
			const localSecret = "/Users/local/private/skills/remote-review/SKILL.md";
			const frame = serializeNativeRemoteLaunch({ ...launch(), skillNames: ["remote-review"], appendSystemPrompt: "base" });
			assert.deepEqual(frame.skillNames, ["remote-review"]); assert.equal(JSON.stringify(frame).includes(localSecret), false);
			assert.throws(() => serializeNativeRemoteLaunch({ ...launch(), skillNames: [localSecret] }), /must use logical names/u);
			const resolved = resolveRemoteNativeSkillLaunch({ cwd: remote, skillNames: ["remote-review"], appendSystemPrompt: "base" });
			assert.match(resolved.appendSystemPrompt ?? "", new RegExp(skillFile.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
			assert.throws(() => resolveRemoteNativeSkillLaunch({ cwd: remote, skillNames: ["local-only"] }), /Remote native Pi skills not found: local-only/u);
		} finally { fs.rmSync(remote, { recursive: true, force: true }); }
	});

	it("builds memory and refinement prompt resources only from the remote cwd", () => {
		const remote = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-remote-prompt-")); fs.mkdirSync(path.join(remote, ".git"));
		const memoryFile = path.join(remote, ".pi", "agent-memory", "worker", "MEMORY.md"); fs.mkdirSync(path.dirname(memoryFile), { recursive: true }); fs.writeFileSync(memoryFile, "REMOTE_MEMORY_CONTENT\n");
		const refinementFile = path.join(remote, ".pi", "subagents", "refinements", "worker.md"); fs.mkdirSync(path.dirname(refinementFile), { recursive: true });
		fs.writeFileSync(refinementFile, `<!-- pi-subagents-refinement:v1\n${JSON.stringify({ agent: "worker", revision: 1, updatedAt: new Date().toISOString(), base: { source: "project", filePath: "agents/worker.md", systemPromptSha256: "abc" }, evidence: {} })}\n-->\n\n\`\`\`pi-subagents-refinement-current\nREMOTE_REFINEMENT_CONTENT\n\`\`\`\n\n\`\`\`pi-subagents-refinement-snapshots-json\n[]\n\`\`\`\n`);
		try {
			const localPath = "/Users/local/.pi/agent/agent-memory/worker/MEMORY.md"; const localContent = "LOCAL_MEMORY_CONTENT";
			const remotePromptSpec = { agentName: "worker", baseSystemPrompt: "BASE", mode: "replace" as const, memory: { scope: "project" as const, path: "worker", writable: true } };
			const frame = serializeNativeRemoteLaunch({ ...launch(), remotePromptSpec }); const json = JSON.stringify(frame); assert.equal(json.includes(localPath), false); assert.equal(json.includes(localContent), false);
			const resolved = resolveRemoteNativePromptLaunch({ ...launch(), cwd: remote, remotePromptSpec }); const prompt = resolved.systemPrompt ?? "";
			assert.match(prompt, /REMOTE_MEMORY_CONTENT/u); assert.match(prompt, /REMOTE_REFINEMENT_CONTENT/u); assert.match(prompt, new RegExp(memoryFile.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
			assert.throws(() => serializeNativeRemoteLaunch({ ...launch(), remotePromptSpec: { ...remotePromptSpec, memory: { ...remotePromptSpec.memory, path: "/Users/local/secret" } } }), /safe relative logical path/u);
		} finally { fs.rmSync(remote, { recursive: true, force: true }); }
	});

	it("does not apply the short control acknowledgement timeout to prompt settlement", { skip: process.platform === "win32" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-prompt-timeout-")); const ssh = path.join(dir, "ssh");
		fs.writeFileSync(ssh, `#!/usr/bin/env node
const readline=require('readline');let first=true;const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(first){first=false;send({type:'pi-subagents-ready',protocol:1,packageVersion:'0.67.0',piVersion:'0.85.0',capabilities:['settlement','steer','follow-up','abort'],cwd:'/remote/project',tools:[]});return;}if(c.type==='prompt'){setTimeout(()=>send({type:'response',id:c.id,command:'prompt',success:true}),80);return;}send({type:'response',id:c.id,command:c.type,success:true});if(c.type==='dispose')process.exit(0);});`, { mode: 0o755 });
		const oldPath = process.env.PATH; process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`;
		try { const local: ChildSessionFactory = { create: async () => child, dispose: async () => {} }; const session = await createPlacementAwareChildSessionFactory(local, { remoteCommandTimeoutMs: 10 }).create({ ...launch(), tools: [] }); await session.prompt("long turn"); await session.dispose(); }
		finally { process.env.PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("fails the runtime-observed handshake when a required remote tool is missing", { skip: process.platform === "win32" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-tools-")); const ssh = path.join(dir, "ssh");
		fs.writeFileSync(ssh, `#!/usr/bin/env node
const readline=require('readline');let first=true;const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(first){first=false;send({type:'pi-subagents-ready',protocol:1,packageVersion:'0.67.0',piVersion:'0.85.0',capabilities:['settlement','steer','follow-up','abort'],cwd:'/remote/project',tools:['read']});return;}if(c.type==='prompt'){send({type:'response',id:c.id,command:'prompt',success:false,error:'required tool missing',data:{toolDiagnostic:{required:['contact_supervisor'],available:['read'],missing:['contact_supervisor']}}});return;}send({type:'response',id:c.id,command:c.type,success:true});if(c.type==='dispose')process.exit(0);});`, { mode: 0o755 });
		const oldPath = process.env.PATH; process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`;
		try { const local: ChildSessionFactory = { create: async () => child, dispose: async () => {} }; await assert.rejects(createPlacementAwareChildSessionFactory(local).create({ ...launch(), tools: ["read", "contact_supervisor"], runtime: { ...launch().runtime, requiredTools: ["contact_supervisor"] } }), /runtime lacks required tools: contact_supervisor/u); }
		finally { process.env.PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("aborts and boundedly disposes the remote child when control input reaches EOF during a hung prompt", async () => {
		let aborted = 0; let disposed = 0; let factoryDisposed = 0;
		const hung: ChildSession = { ...child, prompt: () => new Promise(() => {}), abort: async () => { aborted++; }, dispose: async () => { disposed++; await new Promise(() => {}); } };
		void hung.prompt("never settles");
		await teardownRemoteNativeChild(hung, { dispose: async () => { factoryDisposed++; } }, 10);
		assert.equal(aborted, 1); assert.equal(disposed, 1); assert.equal(factoryDisposed, 1);
	});

	it("exits the production host loop after EOF while a prompt never settles", async () => {
		let aborted = 0; let disposed = 0; let factoryDisposed = 0; const sent: unknown[] = [];
		const hung: ChildSession = { ...child, prompt: () => new Promise(() => {}), abort: async () => { aborted++; }, dispose: async () => { disposed++; } };
		const factory: ChildSessionFactory = { create: async () => hung, dispose: async () => { factoryDisposed++; } };
		const version = (JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string }).version;
		const input = async function* () { yield encodeNativeRemoteRpcRecord({ type: "launch", protocol: 1, packageVersion: version, launch: serializeNativeRemoteLaunch(launch()) }); yield encodeNativeRemoteRpcRecord({ type: "prompt", id: "1", message: "never" }); };
		await runRemoteNativeHost({ input: input(), factory, sendRecord: (value) => sent.push(value), teardownTimeoutMs: 10, piVersion: "9.8.7" });
		assert.equal((sent.find((value) => (value as { type?: string }).type === "pi-subagents-ready") as { piVersion?: string }).piVersion, "9.8.7"); assert.equal(aborted, 1); assert.equal(disposed, 1); assert.equal(factoryDisposed, 1);
		await assert.rejects(runRemoteNativeHost({ input: input(), factory, piVersion: "unknown" }), /invalid Pi SDK version/u);
	});

	it("projects explicit typed before/after Git evidence for public machine results", () => {
		assert.deepEqual(projectNativeMachineEvidence(launch().machine!, { initial: { head: "before", dirty: false }, final: { head: "after", dirty: true } }), {
			...launch().machine, remoteGit: { head: "after", dirty: true }, nativeGit: { initial: { head: "before", dirty: false }, final: { head: "after", dirty: true } },
		});
	});

	it("drives prompt, steering, follow-up, abort, settlement messages, and dispose over the SSH protocol", { skip: process.platform === "win32" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-ssh-"));
		const log = path.join(dir, "commands.log");
		const ssh = path.join(dir, "ssh");
		fs.writeFileSync(ssh, `#!/usr/bin/env node
const fs=require('fs'); const readline=require('readline'); const log=${JSON.stringify(log)};
let first=true; const rl=readline.createInterface({input:process.stdin});
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
rl.on('line',line=>{const c=JSON.parse(line); fs.appendFileSync(log,c.type+'\\n');
if(first){first=false;send({type:'pi-subagents-ready',protocol:1,packageVersion:'0.67.0',piVersion:'0.85.0',capabilities:['settlement','steer','follow-up','abort'],cwd:'/remote/project',model:'test/model',tools:['read'],initialGit:{head:'abc',dirty:false}});return;}
if(c.type==='prompt') send({type:'event',event:{type:'agent_end',messages:[]}});
send({type:'response',id:c.id,command:c.type,success:true,...(c.type==='prompt'?{data:{finalGit:{head:'def',dirty:true}}}:{})});
if(c.type==='dispose') process.exit(0);
});`, { mode: 0o755 });
		const oldPath = process.env.PATH;
		process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`;
		try {
			const local: ChildSessionFactory = { create: async () => { throw new Error("local factory used"); }, dispose: async () => {} };
			const session = await createPlacementAwareChildSessionFactory(local).create({ ...launch(), tools: ["read"] });
			await session.prompt("task");
			assert.deepEqual(session.machineEvidence, { initial: { head: "abc", dirty: false }, final: { head: "def", dirty: true } });
			await session.steer("guidance");
			await session.followUp("continue");
			await session.abort();
			await session.dispose();
			assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["launch", "prompt", "steer", "follow_up", "abort", "dispose"]);
		} finally {
			process.env.PATH = oldPath;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("delivers abort while a prompt is active and fails immediately on clean premature exit", { skip: process.platform === "win32" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-active-"));
		const ssh = path.join(dir, "ssh");
		fs.writeFileSync(ssh, `#!/usr/bin/env node
const readline=require('readline');let first=true,prompt;
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);
if(first){first=false;send({type:'pi-subagents-ready',protocol:1,packageVersion:'0.67.0',piVersion:'0.85.0',capabilities:['settlement','steer','follow-up','abort'],cwd:'/remote/project',tools:[],initialGit:{head:'before',dirty:false}});return;}
if(c.type==='prompt'){prompt=c;return;} if(c.type==='abort'){send({type:'response',id:c.id,command:'abort',success:true});send({type:'response',id:prompt.id,command:'prompt',success:false,error:'aborted',data:{finalGit:{head:'after',dirty:true}}});return;}
send({type:'response',id:c.id,command:c.type,success:true}); if(c.type==='dispose')process.exit(0);
});`, { mode: 0o755 });
		const oldPath = process.env.PATH; process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`;
		try {
			const local: ChildSessionFactory = { create: async () => child, dispose: async () => {} };
			const session = await createPlacementAwareChildSessionFactory(local).create({ ...launch(), tools: [] });
			const prompting = session.prompt("hang");
			await session.abort();
			await assert.rejects(prompting, /aborted/u);
			assert.deepEqual(session.machineEvidence, { initial: { head: "before", dirty: false }, final: { head: "after", dirty: true } });
			await session.dispose();

			fs.writeFileSync(ssh, `#!/usr/bin/env node
const readline=require('readline');let first=true;const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(first){first=false;send({type:'pi-subagents-ready',protocol:1,packageVersion:'0.67.0',piVersion:'0.85.0',capabilities:['settlement','steer','follow-up','abort'],cwd:'/remote/project',tools:[]});}else if(c.type==='prompt')process.exit(0);});`, { mode: 0o755 });
			const exited = await createPlacementAwareChildSessionFactory(local).create({ ...launch(), tools: [] });
			await assert.rejects(Promise.race([exited.prompt("exit"), new Promise((_, reject) => setTimeout(() => reject(new Error("too slow")), 2_000))]), /exited prematurely/u);

			const pidFile = path.join(dir, "bad.pid");
			fs.writeFileSync(ssh, `#!/usr/bin/env node
const fs=require('fs'),readline=require('readline');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));readline.createInterface({input:process.stdin}).once('line',()=>{process.stdout.write(JSON.stringify({type:'pi-subagents-ready',protocol:99,packageVersion:'0.67.0',piVersion:'0.85.0',capabilities:[],cwd:'/remote/project',tools:[]})+'\\n');setInterval(()=>{},1000);});`, { mode: 0o755 });
			await assert.rejects(createPlacementAwareChildSessionFactory(local).create({ ...launch(), tools: [] }), /Incompatible remote native protocol/u);
			const pid = Number(fs.readFileSync(pidFile, "utf8"));
			for (let attempt = 0; attempt < 20; attempt++) {
				try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 25)); } catch { break; }
			}
			assert.throws(() => process.kill(pid, 0));
		} finally { process.env.PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("terminates the owned transport when aggregate event output exceeds its bound", { skip: process.platform === "win32" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-bound-")); const ssh = path.join(dir, "ssh");
		fs.writeFileSync(ssh, `#!/usr/bin/env node
const readline=require('readline');let first=true;const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(first){first=false;send({type:'pi-subagents-ready',protocol:1,packageVersion:'0.67.0',piVersion:'0.85.0',capabilities:['settlement','steer','follow-up','abort'],cwd:'/remote/project',tools:[]});return;}if(c.type==='prompt'){const text='x'.repeat(900000);for(let i=0;i<40;i++)send({type:'event',event:{type:'noise',text}});}});`, { mode: 0o755 });
		const oldPath = process.env.PATH; process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`;
		try {
			const local: ChildSessionFactory = { create: async () => child, dispose: async () => {} };
			const session = await createPlacementAwareChildSessionFactory(local).create({ ...launch(), tools: [] });
			await assert.rejects(session.prompt("flood"), /aggregate bytes/u);
		} finally { process.env.PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("does not resolve acknowledged disposal until the owned SSH process is reaped", { skip: process.platform === "win32" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-dispose-")); const ssh = path.join(dir, "ssh"); const pidFile = path.join(dir, "pid");
		fs.writeFileSync(ssh, `#!/usr/bin/env node
const fs=require('fs'),readline=require('readline');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));let first=true;const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(first){first=false;send({type:'pi-subagents-ready',protocol:1,packageVersion:'0.67.0',piVersion:'0.85.0',capabilities:['settlement','steer','follow-up','abort'],cwd:'/remote/project',tools:[]});return;}send({type:'response',id:c.id,command:c.type,success:true});if(c.type==='dispose')setInterval(()=>{},1000);});`, { mode: 0o755 });
		const oldPath = process.env.PATH; process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`;
		try {
			const local: ChildSessionFactory = { create: async () => child, dispose: async () => {} };
			const session = await createPlacementAwareChildSessionFactory(local).create({ ...launch(), tools: [] }); const pid = Number(fs.readFileSync(pidFile, "utf8"));
			await session.dispose(); assert.throws(() => process.kill(pid, 0));
		} finally { process.env.PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("rejects invalid launch DTOs before spawning SSH", { skip: process.platform === "win32" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-prespawn-")); const ssh = path.join(dir, "ssh"); const marker = path.join(dir, "spawned");
		fs.writeFileSync(ssh, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`, { mode: 0o755 });
		const oldPath = process.env.PATH; process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`;
		try {
			const local: ChildSessionFactory = { create: async () => child, dispose: async () => {} };
			await assert.rejects(createPlacementAwareChildSessionFactory(local).create({ ...launch(), extensionPaths: ["/local/secret.ts"] }), /cannot transfer local extension resources/u);
			assert.equal(fs.existsSync(marker), false);
		} finally { process.env.PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("drains the final stdout response before classifying an immediate SSH exit", { skip: process.platform === "win32" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-drain-")); const ssh = path.join(dir, "ssh");
		fs.writeFileSync(ssh, `#!/usr/bin/env node
const readline=require('readline');let first=true;const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(first){first=false;send({type:'pi-subagents-ready',protocol:1,packageVersion:'0.67.0',piVersion:'0.85.0',capabilities:['settlement','steer','follow-up','abort'],cwd:'/remote/project',tools:[],initialGit:{head:'before',dirty:false}});return;}if(c.type==='prompt'){send({type:'response',id:c.id,command:'prompt',success:true,data:{finalGit:{head:'after',dirty:false}}});process.exit(0);}});`, { mode: 0o755 });
		const oldPath = process.env.PATH; process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`;
		try {
			const local: ChildSessionFactory = { create: async () => child, dispose: async () => {} }; const session = await createPlacementAwareChildSessionFactory(local).create({ ...launch(), tools: [] });
			await session.prompt("finish and exit"); assert.equal(session.machineEvidence?.final?.head, "after");
		} finally { process.env.PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); }
	});
});
