import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { allocateManagedRemoteWorktree, probeManagedRemoteWorktreeSource, updateManagedRemoteWorktreeRecord } from "../../src/runs/shared/herdr-remote-worktree.ts";
import { resolveHerdrMachinePlacement } from "../../src/runs/shared/herdr-machine.ts";
import { runHerdrRemoteCommand } from "../../src/runs/shared/herdr-connection.ts";

type RemoteRunner = typeof runHerdrRemoteCommand;

const roots: string[] = [];
const pathKey = process.platform === "win32" ? "Path" : "PATH";
const stableTestPath = [path.dirname(process.execPath), process.env[pathKey] ?? process.env.PATH].filter(Boolean).join(path.delimiter);
function localShellEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
	return { ...env, ...overrides, [pathKey]: stableTestPath };
}
function localRemoteRunner(overrides: NodeJS.ProcessEnv = {}): RemoteRunner {
	return (_machine, command) => spawnSync("sh", ["-c", command], { encoding: "utf8", env: localShellEnvironment(overrides) });
}
function repository(remote = "https://Example.COM/team/project.git") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-managed-source-")); roots.push(root);
	execFileSync("git", ["init", "-b", "main", root]);
	execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
	fs.writeFileSync(path.join(root, "tracked"), "ok\n");
	execFileSync("git", ["-C", root, "add", "tracked"]); execFileSync("git", ["-C", root, "commit", "-m", "base"]);
	execFileSync("git", ["-C", root, "remote", "add", "origin", remote]);
	const nested = path.join(root, "packages", "api"); fs.mkdirSync(nested, { recursive: true }); return { root, nested };
}
async function waitForFile(file: string): Promise<void> {
	if (fs.existsSync(file)) return;
	await new Promise<void>((resolve, reject) => { const watcher = fs.watch(path.dirname(file), () => { if (fs.existsSync(file)) { watcher.close(); resolve(); } }); const timer = setTimeout(() => { watcher.close(); reject(new Error(`Timed out waiting for ${file}`)); }, 5_000); watcher.on("close", () => clearTimeout(timer)); });
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("managed Herdr remote worktrees", () => {
	it("keeps the local remote-shell fixture on its captured Node path", () => {
		const originalPath = process.env[pathKey];
		const hostilePath = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-hostile-path-")); roots.push(hostilePath); process.env[pathKey] = hostilePath;
		try {
			const result = localRemoteRunner()({ provider: "herdr", id: "machine-id", target: "saved-host" }, 'exec node -e "process.stdout.write(process.execPath)"');
			assert.equal(result.status, 0, result.stderr);
			assert.equal(path.resolve(result.stdout), path.resolve(process.execPath));
		} finally {
			if (originalPath === undefined) delete process.env[pathKey]; else process.env[pathKey] = originalPath;
		}
	});

	it("admits a clean current repository and preserves its exact nested cwd without credentials", () => {
		const { nested } = repository(); const source = probeManagedRemoteWorktreeSource(nested, "refs/heads/main");
		assert.equal(source.relativeCwd, "packages/api");
		assert.equal(source.sourceRemote, "https://example.com/team/project");
		assert.equal(source.repositoryKey, "https://example.com/team/project");
		assert.equal(source.baseRef, "refs/heads/main");
	});

	it("admits public managed placement without a configured remote root and rejects absolute or tilde cwd", () => {
		const { root, nested } = repository(), catalogJson = JSON.stringify([{ id: "machine-id", label: "workmac", target: "saved-host", enabled: true }]);
		const placement = resolveHerdrMachinePlacement({ machine: "workmac", cwd: root, stepCwd: "packages/api", worktree: true, catalogJson });
		assert.equal(placement.machine.managedWorktree?.relativeCwd, "packages/api");
		assert.equal(placement.machine.cwd, "/__pi_subagents_remote_worktree_pending__");
		assert.throws(() => resolveHerdrMachinePlacement({ machine: "workmac", cwd: nested, stepCwd: "/tmp/no", worktree: true, catalogJson }), /repository-relative/u);
		assert.throws(() => resolveHerdrMachinePlacement({ machine: "workmac", cwd: nested, stepCwd: "~/no", worktree: true, catalogJson }), /repository-relative/u);
		const sibling = repository("https://example.com/team/sibling.git");
		assert.throws(() => resolveHerdrMachinePlacement({ machine: "workmac", cwd: root, stepCwd: path.relative(root, sibling.root), worktree: true, catalogJson }), /current parent repository/u);
	});

	for (const [remote, pattern] of [
		["https://user:secret@example.com/team/project.git", /userinfo or credentials/u],
		["file:///tmp/project.git", /local, file/u],
		["/tmp/project.git", /local, file/u],
		["git@example.com:team/project.git", /explicit https or ssh/u],
	] as const) it(`rejects unsafe source remote ${remote}`, () => { const { root } = repository(remote); assert.throws(() => probeManagedRemoteWorktreeSource(root), pattern); });

	it("rejects dirty sources and unsafe base expressions before remote transport", () => {
		const { root } = repository(); fs.writeFileSync(path.join(root, "tracked"), "dirty\n");
		assert.throws(() => probeManagedRemoteWorktreeSource(root), /clean Git working tree/u);
		fs.writeFileSync(path.join(root, "tracked"), "ok\n");
		assert.throws(() => probeManagedRemoteWorktreeSource(root, "HEAD~1"), /valid Git ref/u);
	});

	it("returns only matching bounded allocation evidence and maps the managed cwd", () => {
		let id = ""; const machine = { provider: "herdr" as const, id: "machine-id", target: "saved-host" };
		const source = { repositoryKey: "https://example.com/team/project", sourceRemote: "https://example.com/team/project", relativeCwd: "packages/api", baseRef: "HEAD" };
		const run: RemoteRunner = (requestedMachine, command) => {
			assert.equal(requestedMachine.id, machine.id);
			id = command.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu)?.[0] ?? "";
			assert.ok(id);
			// SAFETY: the fake implements only fields read by the allocator after transport returns.
			return { status: 0, stdout: JSON.stringify({ evidence: { id, machineId: machine.id, repositoryKey: source.repositoryKey, sourceRemote: source.sourceRemote, baseCommit: "a".repeat(40), branch: "pi-subagents/worker-run-1-s0-t0", path: `/home/me/.pi-subagents-managed/allocations/${id}/worktree`, cwd: `/home/me/.pi-subagents-managed/allocations/${id}/worktree/packages/api`, state: "ready", recordPath: "/private", unexpectedSecret: "do not expose" }, recordPath: `/home/me/.pi-subagents-managed/allocations/${id}/records/ready.json`, unexpectedTransport: true }), stderr: "" } as never;
		};
		const allocated = allocateManagedRemoteWorktree({ machine, source, runId: "run-1", agent: "worker" }, run);
		assert.equal(allocated.machine.cwd, allocated.remoteWorktree.cwd);
		assert.equal(allocated.remoteWorktree.id, id);
		assert.deepEqual(Object.keys(allocated.remoteWorktree).sort(), ["baseCommit", "branch", "cwd", "id", "machineId", "path", "repositoryKey", "sourceRemote", "state"]);
	});

	it("binds exact owner identity and retains without issuing a workspace deletion", () => {
		const id = "12345678-1234-4234-9234-123456789abc", machine = { provider: "herdr" as const, id: "machine-id", target: "saved-host", cwd: "/managed/tree/pkg" }, projection = { id, machineId: machine.id, repositoryKey: "https://example.com/team/project", sourceRemote: "https://example.com/team/project", baseCommit: "a".repeat(40), branch: "pi-subagents/test", path: "/managed/tree", cwd: machine.cwd, state: "ready" as const }, recordPath = `/records/${id}.json`;
		const commands: string[] = [], run: RemoteRunner = (_machine, command) => { commands.push(command); const state = commands.length === 1 ? "active" : "retained";
			// SAFETY: the fake implements only the status/stdout/stderr fields consumed by the record updater.
			return { status: 0, stdout: JSON.stringify({ ...projection, state, head: projection.baseCommit, dirty: false, changedFiles: [] }), stderr: "" } as never; };
		const active = updateManagedRemoteWorktreeRecord({ machine, remoteWorktree: projection, recordPath, state: "active", pane: { workspaceId: "w", tabId: "t", paneId: "p", terminalId: "term" } }, run);
		const retained = updateManagedRemoteWorktreeRecord({ machine, remoteWorktree: active, recordPath, state: "retained" }, run);
		assert.equal(retained.state, "retained");
		assert.equal(commands.some((command) => /worktree remove|branch -D|rm -rf/u.test(command)), false);
	});

	it("rejects a hostile symlink at the authoritative record descriptor", () => {
		const { root } = repository(), id = "12345678-1234-4234-9234-123456789abc", directory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-record-hostile-")); roots.push(directory);
		const target = path.join(directory, "target.json"), recordPath = path.join(directory, "record.json"), machine = { provider: "herdr" as const, id: "machine-id", target: "saved-host", cwd: root }, projection = { id, machineId: machine.id, repositoryKey: "https://example.com/team/project", sourceRemote: "https://example.com/team/project", baseCommit: "a".repeat(40), branch: "pi-subagents/test", path: root, cwd: root, state: "ready" as const };
		fs.writeFileSync(target, JSON.stringify(projection), { mode: 0o600 }); fs.symlinkSync(target, recordPath);
		const run = localRemoteRunner();
		assert.throws(() => updateManagedRemoteWorktreeRecord({ machine, remoteWorktree: projection, recordPath, state: "retained" }, run), /remote command failed|symbolic links|too many levels/iu);
		assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).state, "ready");
	});

	it("never overwrites a replacement inserted at lifecycle publication", () => {
		const { root } = repository(), id = "12345678-1234-4234-9234-123456789abc", allocation = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-record-swap-")); roots.push(allocation); const records = path.join(allocation, "records"); fs.mkdirSync(records, { mode: 0o700 });
		const recordPath = path.join(records, "ready.json"), destination = path.join(records, "retained.json"), replacement = JSON.stringify({ id: "replacement-owner", state: "retained" }), machine = { provider: "herdr" as const, id: "machine-id", target: "saved-host", cwd: root }, projection = { id, machineId: machine.id, repositoryKey: "https://example.com/team/project", sourceRemote: "https://example.com/team/project", baseCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), branch: "main", path: root, cwd: root, state: "ready" as const }; fs.writeFileSync(recordPath, JSON.stringify(projection), { mode: 0o600 });
		const preload = path.join(allocation, "swap.cjs"); fs.writeFileSync(preload, `const fs=require("node:fs"),old=fs.linkSync;fs.linkSync=function(source,destination){if(destination===process.env.SWAP&&!fs.existsSync(destination))fs.writeFileSync(destination,process.env.REPLACEMENT,{mode:0o600});return old.call(this,source,destination)};`);
		const run = localRemoteRunner({ NODE_OPTIONS: `--require=${preload}`, SWAP: destination, REPLACEMENT: replacement });
		assert.throws(() => updateManagedRemoteWorktreeRecord({ machine, remoteWorktree: projection, recordPath, state: "retained" }, run), /record update failed/u); assert.equal(fs.readFileSync(destination, "utf8"), replacement);
	});

	it("rejects same-inode staging mutation at lifecycle publication", () => {
		const { root } = repository(), id = "12345678-1234-4234-9234-123456789abc", allocation = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-lifecycle-stage-swap-")); roots.push(allocation); const records = path.join(allocation, "records"); fs.mkdirSync(records, { mode: 0o700 }); const recordPath = path.join(records, "ready.json"), destination = path.join(records, "retained.json"), machine = { provider: "herdr" as const, id: "machine-id", target: "saved-host", cwd: root }, projection = { id, machineId: machine.id, repositoryKey: "https://example.com/team/project", sourceRemote: "https://example.com/team/project", baseCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), branch: "main", path: root, cwd: root, state: "ready" as const }; fs.writeFileSync(recordPath, JSON.stringify(projection), { mode: 0o600 }); const preload = path.join(allocation, "swap.cjs"); fs.writeFileSync(preload, `const fs=require("node:fs"),old=fs.linkSync;fs.linkSync=function(source,destination){if(destination.endsWith("/retained.json")){let value=JSON.parse(fs.readFileSync(source,"utf8"));value.machineId="attacker";fs.writeFileSync(source,JSON.stringify(value))}return old.call(this,source,destination)};`);
		const run = localRemoteRunner({ NODE_OPTIONS: `--require=${preload}` }); assert.throws(() => updateManagedRemoteWorktreeRecord({ machine, remoteWorktree: projection, recordPath, state: "retained" }, run), /record update failed/u); assert.equal(JSON.parse(fs.readFileSync(destination, "utf8")).machineId, "attacker");
	});

	it("reports exact one-path tracked, rename, and untracked evidence", () => {
		const { root } = repository(), allocation = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-status-evidence-")); roots.push(allocation); fs.writeFileSync(path.join(root, "original-name.txt"), "rename me\n"); execFileSync("git", ["-C", root, "add", "original-name.txt"]); execFileSync("git", ["-C", root, "commit", "-m", "rename base"]); fs.renameSync(path.join(root, "original-name.txt"), path.join(root, "renamed-name.txt")); fs.writeFileSync(path.join(root, "tracked"), "changed\n"); fs.writeFileSync(path.join(root, "untracked.txt"), "new\n"); const records = path.join(allocation, "records"); fs.mkdirSync(records, { mode: 0o700 }); const id = "12345678-1234-4234-9234-123456789abc", recordPath = path.join(records, "ready.json"), machine = { provider: "herdr" as const, id: "machine-id", target: "saved-host", cwd: root }, projection = { id, machineId: machine.id, repositoryKey: "https://example.com/team/project", sourceRemote: "https://example.com/team/project", baseCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), branch: "main", path: root, cwd: root, state: "ready" as const }; fs.writeFileSync(recordPath, JSON.stringify(projection), { mode: 0o600 }); const evidence = updateManagedRemoteWorktreeRecord({ machine, remoteWorktree: projection, recordPath, state: "retained" }, localRemoteRunner()); assert.deepEqual(evidence.changedFiles?.sort(), ["original-name.txt", "renamed-name.txt", "tracked", "untracked.txt"]); assert.equal(evidence.dirty, true);
	});

	it("rejects same-inode staging mutation at ready publication", () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-ready-swap-")); roots.push(fixture); const home = path.join(fixture, "home"), source = path.join(fixture, "origin.git"); fs.mkdirSync(home, { mode: 0o700 }); const { root } = repository(); execFileSync("git", ["clone", "--bare", root, source]);
		const machine = { provider: "herdr" as const, id: "machine-id", target: "saved-host" }, request = { repositoryKey: "ready-swap", sourceRemote: source, relativeCwd: "", baseRef: "HEAD" }; let command = "", id = ""; const capture: RemoteRunner = (_machine, value) => { command = value; id = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu)?.[0] ?? ""; const branch = value.match(/\\?"branch\\?":\\?"([^"\\]+)/u)?.[1] ?? "", evidence = { id, machineId: machine.id, repositoryKey: request.repositoryKey, sourceRemote: source, baseCommit: "a".repeat(40), branch, path: "/tree", cwd: "/tree", state: "ready" };
			// SAFETY: capture response fields are validated and used only to obtain the actual transported command.
			return { status: 0, stdout: JSON.stringify({ evidence, recordPath: "/record" }), stderr: "" } as never; }; allocateManagedRemoteWorktree({ machine, source: request, runId: "ready-swap", agent: "worker" }, capture);
		const preload = path.join(fixture, "swap.cjs"); fs.writeFileSync(preload, `const fs=require("node:fs"),old=fs.linkSync;fs.linkSync=function(source,destination){if(destination.endsWith("/ready.json")){let value=JSON.parse(fs.readFileSync(source,"utf8"));value.machineId="attacker";fs.writeFileSync(source,JSON.stringify(value))}return old.call(this,source,destination)};`); const result = localRemoteRunner({ HOME: home, NODE_OPTIONS: `--require=${preload}` })(machine, command), destination = path.join(home, ".pi-subagents-managed", "allocations", id, "records", "ready.json"); assert.notEqual(result.status, 0); assert.equal(JSON.parse(fs.readFileSync(destination, "utf8")).machineId, "attacker");
	});

	it("ignores crashed recovery residue and gives concurrent attempts fresh namespaces", async () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-fresh-allocation-")); roots.push(fixture); const home = path.join(fixture, "home"), source = path.join(fixture, "origin.git"), finish = path.join(fixture, "finish"); fs.mkdirSync(home, { mode: 0o700 });
		const { root } = repository(); execFileSync("git", ["clone", "--bare", root, source]);
		const preload = path.join(fixture, "preload.cjs"); fs.writeFileSync(preload, `const fs=require("node:fs");fs.writeFileSync(process.env.READY,"ready");while(!fs.existsSync(process.env.FINISH))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);`);
		const machine = { provider: "herdr" as const, id: "machine-id", target: "saved-host" }, sourceRequest = { repositoryKey: "local-adversarial-key", sourceRemote: source, relativeCwd: "", baseRef: "HEAD" }, commands: string[] = [];
		for (const index of [1, 2]) { const capture: RemoteRunner = (_machine, command) => { commands.push(command); const id = command.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu)?.[0] ?? "", branch = command.match(/\\?"branch\\?":\\?"([^"\\]+)/u)?.[1] ?? "", evidence = { id, machineId: machine.id, repositoryKey: sourceRequest.repositoryKey, sourceRemote: source, baseCommit: "a".repeat(40), branch, path: `/tree-${index}`, cwd: `/tree-${index}`, state: "ready" };
			// SAFETY: the capture fake supplies the envelope fields validated by the allocator.
			return { status: 0, stdout: JSON.stringify({ evidence, recordPath: `/record-${index}` }), stderr: "" } as never; }; allocateManagedRemoteWorktree({ machine, source: sourceRequest, runId: "same-run", index: 0, agent: "worker" }, capture); }
		const managedRoot = path.join(home, ".pi-subagents-managed"), legacy = path.join(managedRoot, "locks"); fs.mkdirSync(legacy, { recursive: true, mode: 0o700 }); fs.chmodSync(managedRoot, 0o700); fs.chmodSync(legacy, 0o700); const lock = path.join(legacy, "dead.lock"), recovery = path.join(legacy, "dead.recovery"); fs.writeFileSync(lock, "dead", { mode: 0o600 }); fs.linkSync(lock, recovery); const original = fs.statSync(lock).ino;
		const runAttempt = (index: number) => new Promise<{ code: number | null; stderr: string }>((resolve) => { const child = spawn("sh", ["-c", commands[index - 1]!], { env: localShellEnvironment({ HOME: home, NODE_OPTIONS: `--require=${preload}`, READY: path.join(fixture, `ready-${index}`), FINISH: finish }), stdio: ["ignore", "ignore", "pipe"] }); let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk.toString(); }); child.on("close", code => resolve({ code, stderr })); });
		const attempts = [runAttempt(1), runAttempt(2)]; await Promise.all([waitForFile(path.join(fixture, "ready-1")), waitForFile(path.join(fixture, "ready-2"))]); fs.writeFileSync(finish, "finish"); const outcomes = await Promise.all(attempts); assert.deepEqual(outcomes.map(value => value.code), [0, 0], outcomes.map(value => value.stderr).join("\n")); const allocations = fs.readdirSync(path.join(home, ".pi-subagents-managed", "allocations")); assert.equal(allocations.length, 2); assert.notEqual(allocations[0], allocations[1]); assert.equal(fs.statSync(lock).ino, original); assert.equal(fs.statSync(recovery).ino, original);
	});
});
