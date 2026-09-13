import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { HerdrMachineReference, RemoteWorktreeEvidence } from "../../shared/types.ts";
import { runHerdrRemoteCommand, remoteShellCommand } from "./herdr-connection.ts";
import { buildWorktreeNaming, normalizeWorktreeBaseRef, normalizeWorktreeBranchPrefix } from "./worktree.ts";

const CONTROL = /[\u0000-\u001f\u007f]/u;
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
type ManagedRequest = NonNullable<HerdrMachineReference["managedWorktree"]>;
type SourceProbe = ManagedRequest & { repositoryRoot: string };
type RemoteWorktreeRunner = typeof runHerdrRemoteCommand;
type Json = null | boolean | number | string | Json[] | JsonObject;
interface JsonObject { [key: string]: Json }
interface RecordUpdatePayload { id: string; machineId: string; repositoryKey: string; sourceRemote: string; baseCommit: string; branch: string; path: string; cwd: string; recordPath: string; state: "active" | "retained"; pane?: { workspaceId: string; tabId: string; paneId: string; terminalId: string } }
export interface ManagedRemoteWorktreeAllocation { machine: HerdrMachineReference; remoteWorktree: RemoteWorktreeEvidence; recordPath: string }

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
	if (result.error || result.status !== 0) throw new Error(String(result.stderr || result.error?.message || "Git source probe failed").trim().slice(0, 1000));
	return result.stdout.trim();
}

export function probeManagedRemoteWorktreeSource(cwd: string, requestedBaseRef?: string): SourceProbe {
	if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("managed remote worktree requires a Git repository");
	const repositoryRoot = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (git(repositoryRoot, ["status", "--porcelain", "--", ":!.pi/subagents"])) throw new Error("managed remote worktree requires a clean Git working tree. Commit or stash changes first.");
	const prefix = git(cwd, ["rev-parse", "--show-prefix"]).replace(/[\\/]+$/u, "");
	const upstream = spawnSync("git", ["-C", repositoryRoot, "config", "--get", `branch.${git(repositoryRoot, ["branch", "--show-current"])}.remote`], { encoding: "utf8" });
	const upstreamName = upstream.status === 0 ? upstream.stdout.trim() : "";
	const origin = spawnSync("git", ["-C", repositoryRoot, "remote", "get-url", "origin"], { encoding: "utf8" });
	const originUrl = origin.status === 0 ? origin.stdout.trim() : "", remoteName = upstreamName && upstreamName !== "." ? upstreamName : "origin";
	if (!upstreamName && !originUrl) throw new Error("managed remote worktree requires an origin or branch upstream remote");
	const selected = git(repositoryRoot, ["remote", "get-url", remoteName]);
	if (upstreamName && upstreamName !== "origin" && originUrl && selected !== originUrl) throw new Error("branch upstream and origin identify different repositories; managed remote worktree selection is ambiguous");
	if (CONTROL.test(selected) || /^(?:file:|\/|\.\/|\.\.\/|~)/iu.test(selected)) throw new Error("managed remote worktree rejects local, file, or control-character remotes");
	let parsed: URL; try { parsed = new URL(selected); } catch { throw new Error("managed remote worktree supports only explicit https or ssh remote URLs"); }
	if ((parsed.protocol !== "https:" && parsed.protocol !== "ssh:") || parsed.username || parsed.password || !parsed.hostname) throw new Error("managed remote worktree rejects remote URLs containing userinfo or credentials");
	if (parsed.search || parsed.hash) throw new Error("managed remote worktree remote URL must not contain query or fragment data");
	parsed.hostname = parsed.hostname.toLowerCase(); parsed.pathname = parsed.pathname.replace(/\/+$/u, "").replace(/\.git$/u, "");
	const sourceRemote = parsed.toString().replace(/\/$/u, "");
	return { repositoryRoot, repositoryKey: `${parsed.protocol}//${parsed.host}${parsed.pathname}`, sourceRemote, relativeCwd: prefix.split(path.sep).join("/"), baseRef: normalizeWorktreeBaseRef(requestedBaseRef) ?? "HEAD" };
}

function object(value: Json | undefined): JsonObject {
	if (value === undefined || value === null || Array.isArray(value) || Object.prototype.toString.call(value) !== "[object Object]") throw new Error("Managed remote worktree returned malformed evidence");
	/* SAFETY: the JSON domain and explicit null/array/plain-object checks establish a JSON object. */
	return value as JsonObject;
}
function text(value: Json | undefined, name: string, maximum = 4096): string {
	if (Object.prototype.toString.call(value) !== "[object String]") throw new Error(`Managed remote worktree returned invalid ${name}`);
	const result = String(value); if (!result || Buffer.byteLength(result) > maximum || CONTROL.test(result)) throw new Error(`Managed remote worktree returned invalid ${name}`);
	return result;
}
function projectEvidence(value: Json | undefined, expected: { id: string; machineId: string; repositoryKey: string; sourceRemote: string; branch: string; path?: string; cwd?: string; state: RemoteWorktreeEvidence["state"] }): RemoteWorktreeEvidence {
	const raw = object(value), id = text(raw.id, "id", 64), machineId = text(raw.machineId, "machineId", 256), repositoryKey = text(raw.repositoryKey, "repositoryKey"), sourceRemote = text(raw.sourceRemote, "sourceRemote"), baseCommit = text(raw.baseCommit, "baseCommit", 64), branch = text(raw.branch, "branch", 512), workspacePath = text(raw.path, "path"), cwd = text(raw.cwd, "cwd");
	if (id !== expected.id || machineId !== expected.machineId || repositoryKey !== expected.repositoryKey || sourceRemote !== expected.sourceRemote || branch !== expected.branch || raw.state !== expected.state || expected.path && workspacePath !== expected.path || expected.cwd && cwd !== expected.cwd || !FULL_COMMIT.test(baseCommit) || !path.posix.isAbsolute(workspacePath) || !path.posix.isAbsolute(cwd)) throw new Error("Managed remote worktree evidence identity did not match its request");
	const evidence: RemoteWorktreeEvidence = { id, machineId, repositoryKey, sourceRemote, baseCommit, branch, path: workspacePath, cwd, state: expected.state };
	if (raw.head !== undefined) { const head = text(raw.head, "head", 64); if (!FULL_COMMIT.test(head)) throw new Error("Managed remote worktree returned invalid head"); evidence.head = head; }
	if (raw.dirty !== undefined) { if (raw.dirty !== true && raw.dirty !== false) throw new Error("Managed remote worktree returned invalid dirty evidence"); evidence.dirty = raw.dirty; }
	if (raw.changedFiles !== undefined) { if (!Array.isArray(raw.changedFiles) || raw.changedFiles.length > 100) throw new Error("Managed remote worktree returned invalid changed files"); let bytes = 0; evidence.changedFiles = raw.changedFiles.map((entry) => { const item = text(entry, "changed file", 1024); bytes += Buffer.byteLength(item); if (bytes > 16_384) throw new Error("Managed remote worktree changed files exceeded its bound"); return item; }); }
	if (raw.evidenceUnavailable !== undefined) evidence.evidenceUnavailable = text(raw.evidenceUnavailable, "unavailable evidence", 512);
	return evidence;
}

export function projectRemoteWorktreeEvidence(value: RemoteWorktreeEvidence): RemoteWorktreeEvidence {
	const parsed: Json = JSON.parse(JSON.stringify(value));
	return projectEvidence(parsed, { id: value.id, machineId: value.machineId, repositoryKey: value.repositoryKey, sourceRemote: value.sourceRemote, branch: value.branch, path: value.path, cwd: value.cwd, state: value.state });
}

const remotePrelude = String.raw`const fs=require("node:fs"),cp=require("node:child_process"),path=require("node:path"),os=require("node:os"),p=JSON.parse(process.argv[1]);process.umask(63);const fail=m=>{throw Error(m)},own=d=>{let s=fs.lstatSync(d);if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(d)!==d||s.uid!==process.getuid()||(s.mode&511)!==448)fail("unsafe managed directory")},mk=d=>{try{fs.mkdirSync(d,{mode:448})}catch(e){if(e.code!=="EEXIST")throw e}own(d)},read=f=>{let d=fs.openSync(f,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),s=fs.fstatSync(d);try{if(!s.isFile()||s.uid!==process.getuid()||(s.mode&511)!==384||s.size>65536)fail("unsafe managed record");return JSON.parse(fs.readFileSync(d,"utf8"))}finally{fs.closeSync(d)}},publish=(dir,name,value)=>{let stage=path.join(dir,"."+name+"."+p.id),final=path.join(dir,name),intended=JSON.stringify(value);fs.writeFileSync(stage,intended,{mode:384,flag:"wx"});let before=fs.lstatSync(stage);fs.linkSync(stage,final);let fd=fs.openSync(final,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),after=fs.fstatSync(fd),actual;try{actual=fs.readFileSync(fd,"utf8")}finally{fs.closeSync(fd)}if(before.dev!==after.dev||before.ino!==after.ino||actual!==intended)fail("managed record publication changed");return final},run=(a,cwd)=>{let r=cp.spawnSync("git",a,{cwd,encoding:"utf8",timeout:30000,maxBuffer:1048576});if(r.error||r.status!==0)fail(String(r.stderr||r.error?.message||"remote git failed").slice(0,1000));return r.stdout},sh=(a,cwd)=>run(a,cwd).trim();`;

export function updateManagedRemoteWorktreeRecord(input: { machine: HerdrMachineReference; remoteWorktree: RemoteWorktreeEvidence; recordPath: string; state: "active" | "retained"; pane?: { workspaceId: string; tabId: string; paneId: string; terminalId: string } }, run: RemoteWorktreeRunner = runHerdrRemoteCommand): RemoteWorktreeEvidence {
	if (input.state === "active" && !input.pane) throw new Error("Active managed remote worktree state requires exact pane and terminal identity");
	const payload: RecordUpdatePayload = { id: input.remoteWorktree.id, machineId: input.machine.id, repositoryKey: input.remoteWorktree.repositoryKey, sourceRemote: input.remoteWorktree.sourceRemote, baseCommit: input.remoteWorktree.baseCommit, branch: input.remoteWorktree.branch, path: input.remoteWorktree.path, cwd: input.remoteWorktree.cwd, recordPath: input.recordPath, state: input.state }; if (input.pane) payload.pane = input.pane;
	const script = `${remotePrelude}\nconst ready=read(p.recordPath);if(ready.id!==p.id||ready.machineId!==p.machineId||ready.repositoryKey!==p.repositoryKey||ready.sourceRemote!==p.sourceRemote||ready.baseCommit!==p.baseCommit||ready.branch!==p.branch||ready.path!==p.path||ready.cwd!==p.cwd)fail("managed ready identity changed");let observed={};try{let head=sh(["rev-parse","HEAD"],p.path),current=sh(["branch","--show-current"],p.path),tracked=run(["diff","--name-only","-z","HEAD","--"],p.path).split("\\0").filter(Boolean),untracked=run(["ls-files","--others","--exclude-standard","-z","--"],p.path).split("\\0").filter(Boolean),changedFiles=[...new Set([...tracked,...untracked])].slice(0,100);if(current!==p.branch)fail("managed branch identity changed");observed={head,dirty:changedFiles.length>0,changedFiles}}catch{observed={evidenceUnavailable:"Remote Git evidence was unavailable; workspace retained."}}let value={id:p.id,machineId:p.machineId,repositoryKey:p.repositoryKey,sourceRemote:p.sourceRemote,baseCommit:p.baseCommit,branch:p.branch,path:p.path,cwd:p.cwd,state:p.state,...observed,...(p.pane?{pane:p.pane}:{})};publish(path.dirname(p.recordPath),p.state+".json",value);process.stdout.write(JSON.stringify(value));`;
	const result = run(input.machine, remoteShellCommand("exec node -e \"$1\" \"$2\"", [script, JSON.stringify(payload)]), { timeout: 10_000, maxBuffer: 64 * 1024 });
	if (result.status !== 0) throw new Error(`Managed remote worktree record update failed: ${String(result.stderr).slice(0, 1000)}`);
	let parsed: Json; try { parsed = JSON.parse(String(result.stdout)); } catch { throw new Error("Managed remote worktree record update returned malformed evidence"); }
	return projectEvidence(parsed, { ...input.remoteWorktree, machineId: input.machine.id, state: input.state });
}

export function allocateManagedRemoteWorktree(input: { machine: Omit<HerdrMachineReference, "cwd"> & { cwd?: string }; source: ManagedRequest; runId: string; index?: number; agent?: string }, run: RemoteWorktreeRunner = runHerdrRemoteCommand): ManagedRemoteWorktreeAllocation {
	const namingInput = { runId: input.runId, index: input.index ?? 0, branchPrefix: normalizeWorktreeBranchPrefix(input.source.branchPrefix) }, naming = buildWorktreeNaming(input.agent === undefined ? namingInput : { ...namingInput, agent: input.agent }), id = randomUUID();
	const payload = { id, machineId: input.machine.id, repositoryKey: input.source.repositoryKey, sourceRemote: input.source.sourceRemote, baseRef: input.source.baseRef, branch: naming.requestedBranch, relativeCwd: input.source.relativeCwd, runId: input.runId, index: input.index ?? 0 };
	const script = `${remotePrelude}\nconst root=path.join(fs.realpathSync(os.homedir()),".pi-subagents-managed"),allocations=path.join(root,"allocations");mk(root);mk(allocations);const allocation=path.join(allocations,p.id);fs.mkdirSync(allocation,{mode:448});own(allocation);const records=path.join(allocation,"records"),repo=path.join(allocation,"repository.git"),tree=path.join(allocation,"worktree");fs.mkdirSync(records,{mode:448});own(records);publish(records,"intent.json",{id:p.id,machineId:p.machineId,repositoryKey:p.repositoryKey,sourceRemote:p.sourceRemote,baseRef:p.baseRef,branch:p.branch});sh(["clone","--mirror","--",p.sourceRemote,repo],allocation);let commit=sh(["rev-parse","--verify","--end-of-options",p.baseRef+"^{commit}"],repo);if(!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))fail("remote base did not resolve to a full commit");sh(["worktree","add","-b",p.branch,"--",tree,commit],repo);if(fs.realpathSync(tree)!==tree||sh(["rev-parse","HEAD"],tree)!==commit||sh(["branch","--show-current"],tree)!==p.branch)fail("managed worktree identity validation failed");let cwd=p.relativeCwd?path.join(tree,...p.relativeCwd.split("/")):tree,real=fs.realpathSync(cwd);if(!fs.lstatSync(cwd).isDirectory()||real!==tree&&!real.startsWith(tree+path.sep))fail("managed nested cwd is unavailable or escaped");let value={id:p.id,machineId:p.machineId,repositoryKey:p.repositoryKey,sourceRemote:p.sourceRemote,baseCommit:commit,branch:p.branch,path:tree,cwd,state:"ready"};let recordPath=publish(records,"ready.json",value);process.stdout.write(JSON.stringify({evidence:value,recordPath}));`;
	/* SAFETY: transport ignores cwd during allocation; the exact managed cwd is supplied only after verified allocation. */
	const result = run(input.machine as HerdrMachineReference, remoteShellCommand("exec node -e \"$1\" \"$2\"", [script, JSON.stringify(payload)]), { timeout: 60_000, maxBuffer: 64 * 1024 });
	if (result.status !== 0) throw new Error(`Managed remote worktree allocation failed; its fresh allocation is retained: ${String(result.stderr).slice(0, 1000)}`);
	let envelope: JsonObject; try { envelope = object(JSON.parse(String(result.stdout))); } catch { throw new Error("Managed remote worktree allocation returned malformed evidence"); }
	const remoteWorktree = projectEvidence(envelope.evidence, { id, machineId: input.machine.id, repositoryKey: input.source.repositoryKey, sourceRemote: input.source.sourceRemote, branch: naming.requestedBranch, state: "ready" }), recordPath = text(envelope.recordPath, "record path");
	if (!path.posix.isAbsolute(recordPath)) throw new Error("Managed remote worktree returned invalid record path");
	return { machine: { ...input.machine, provider: "herdr", cwd: remoteWorktree.cwd }, remoteWorktree, recordPath };
}
