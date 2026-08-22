import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { resolveNodeExecutable } from "../../shared/node-executable.ts";
import { getProjectSubagentsDir } from "../../shared/artifacts.ts";
import { TEMP_ROOT_DIR, type OrcaProgressTabsConfig } from "../../shared/types.ts";
import { extractTextFromContent, getAgentDir } from "../../shared/utils.ts";

const ORCA_CREATE_TIMEOUT_MS = 20_000;
const ORCA_KILL_GRACE_MS = 2_000;
const CLEANUP_DELAY_MS = 5 * 60_000;
const STALE_PROGRESS_MAX_AGE_MS = 24 * 60 * 60_000;
const VIEWER_POLL_MS = 150;
const MAX_MIRROR_BYTES = 1024 * 1024;
const MIRROR_FOOTER_RESERVE_BYTES = 16 * 1024;
const COUNTER_LOCK_STALE_MS = 30_000;
const COUNTER_LOCK_RETRIES = 200;
const COUNTER_LOCK_RETRY_MS = 10;
const ORCA_CREATE_WAIT_TIMEOUT_MS = ORCA_CREATE_TIMEOUT_MS + ORCA_KILL_GRACE_MS + 3_000;

const ORCA_CREATE_WATCHDOG_SCRIPT = [
	"const {spawn}=require('node:child_process');",
	"const fs=require('node:fs'),path=require('node:path');",
	"const timeout=Number(process.argv[1]),grace=Number(process.argv[2]),waitTimeout=Number(process.argv[3]);",
	"const previous=process.argv[4],done=process.argv[5],manifestPath=process.argv[6],manifestJson=process.argv[7],command=process.argv[8],args=process.argv.slice(9);",
	"function mark(){try{fs.writeFileSync(done.replace(/\\.pending$/,'.ready'),'')}catch{}}",
	"function exists(file){try{return fs.existsSync(file)}catch{return false}}",
	"function keepQueued(){try{const now=new Date();fs.utimesSync(done,now,now)}catch{}}",
	"function predecessorReady(){if(previous==='-')return true;if(exists(previous.replace(/\\.pending$/,'.ready')))return true;try{return Date.now()-fs.statSync(previous).mtimeMs>=waitTimeout}catch{return true}}",
	"function text(value){return typeof value==='string'&&value?value:undefined}",
	"function privateDirectory(root,directory){const relative=path.relative(root,directory);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))return false;let current=root;for(const segment of relative.split(path.sep)){current=path.join(current,segment);try{const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())return false}catch(error){if(!error||error.code!=='ENOENT')return false;try{fs.mkdirSync(current,{mode:448})}catch{try{const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())return false}catch{return false}}}}try{return fs.realpathSync(directory)===directory}catch{return false}}",
	"function persist(output){let temp;try{const manifest=JSON.parse(manifestJson),response=JSON.parse(output);if(!response||response.ok!==true)return;const terminal=response.result&&response.result.terminal;const ids=terminal&&typeof terminal==='object'?{handle:text(terminal.handle),tabId:text(terminal.tabId),paneKey:text(terminal.paneKey),ptyId:text(terminal.ptyId),worktreeId:text(terminal.worktreeId)}:undefined;const cleanIds=ids&&Object.fromEntries(Object.entries(ids).filter(([,value])=>value));const payload=cleanIds&&Object.keys(cleanIds).length?{...manifest,terminal:cleanIds}:manifest;const directory=path.dirname(manifestPath);if(!privateDirectory(manifest.worktree,directory))return;fs.chmodSync(directory,448);temp=manifestPath+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(payload,null,2),{encoding:'utf8',mode:384});fs.renameSync(temp,manifestPath);temp=undefined}catch{}finally{if(temp)try{fs.rmSync(temp,{force:true})}catch{}}}",
	"function start(){",
	" try{",
	"  const child=spawn(command,args,{stdio:['ignore','pipe','ignore'],windowsHide:true});",
	"  let hardKill,output=Buffer.alloc(0),settled=false;child.stdout.on('data',chunk=>{if(output.length<65536)output=Buffer.concat([output,chunk.subarray(0,65536-output.length)])});",
	"  const timer=setTimeout(()=>{child.kill('SIGTERM');hardKill=setTimeout(()=>child.kill('SIGKILL'),grace)},timeout);",
	"  const clear=code=>{if(settled)return;settled=true;clearTimeout(timer);if(hardKill)clearTimeout(hardKill);mark();if(code===0)persist(output.toString('utf8'));process.exitCode=code===0?0:1};",
	"  child.once('error',()=>clear(1));",
	"  child.once('close',code=>clear(code));",
	" }catch{mark();process.exitCode=1}",
	"}",
	"if(predecessorReady())start();",
	"else{(function waitPrev(){keepQueued();if(predecessorReady())return start();setTimeout(waitPrev,20)})();}",
].join("");

const ORCA_CLEANUP_WATCHDOG_SCRIPT = [
	"const fs=require('node:fs');",
	"const deadline=Date.now()+Number(process.argv[1]),files=process.argv.slice(2);",
	"function check(){if(!files.some(file=>fs.existsSync(file)))process.exit(0);if(Date.now()<deadline)return;for(const file of files){try{fs.rmSync(file,{force:true})}catch{}}process.exit(0)}",
	"setInterval(check,1000);check();",
].join("");

export interface OrcaProgressTab {
	/** Best-effort observer metadata for future shared views discovery. */
	readonly observerManifestPath?: string;
	append(text: string): void;
	event(event: { type?: string; message?: Message; toolName?: string; args?: unknown }): void;
	finish(status: "completed" | "failed" | "stopped", sessionFile?: string): Promise<void>;
}

function executableFile(candidate: string): boolean {
	try {
		const stats = fs.statSync(candidate);
		if (!stats.isFile()) return false;
		if (process.platform === "win32") return true;
		fs.accessSync(candidate, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function executableNames(command: string, env: NodeJS.ProcessEnv): string[] {
	if (process.platform !== "win32") return [command];
	const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
	return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`), ...extensions.map((extension) => `${command}${extension.toUpperCase()}`)];
}

export function resolveOrcaCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = env.PI_SUBAGENT_ORCA_BINARY?.trim();
	if (override) return executableFile(override) ? override : undefined;
	for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		for (const name of executableNames("orca", env)) {
			const candidate = path.join(directory, name);
			if (executableFile(candidate)) return candidate;
		}
	}
	return undefined;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const VIEWER_SCRIPT = [
	"const fs=require('fs'),{StringDecoder}=require('string_decoder');",
	"const log=process.argv[1],done=process.argv[2],transcript=process.argv[3]==='-'?undefined:process.argv[3],decoder=new StringDecoder('utf8'),transcriptDecoder=new StringDecoder('utf8');",
	`const projectionLimit=${MAX_MIRROR_BYTES};`,
	"let offset=0,transcriptOffset=0,transcriptRemainder='',projectionBytes=0,projectionTruncated=false,finishing=false,state='text';const toolCounts=new Map();",
	"function sanitize(input){let output='';for(const char of input){const code=char.charCodeAt(0);",
	"if(state==='text'){if(code===27){state='escape';continue}if(code===155){state='csi';continue}if(code===157){state='osc';continue}if(code===144||code===152||code===158||code===159){state='string';continue}if(code===10||(code>=32&&code!==127&&(code<128||code>159)))output+=char;continue}",
	"if(state==='escape'){if(char==='[')state='csi';else if(char===']')state='osc';else if(char==='P'||char==='X'||char==='^'||char==='_')state='string';else if(code<32||code>47)state='text';continue}",
	"if(state==='csi'){if(code>=64&&code<=126)state='text';continue}",
	"if(state==='osc'){if(code===7)state='text';else if(code===27)state='osc-escape';continue}",
	"if(state==='osc-escape'){state=char==='\\\\'?'text':code===27?'osc-escape':'osc';continue}",
	"if(state==='string'){if(code===27)state='string-escape';continue}",
	"if(state==='string-escape')state=char==='\\\\'?'text':code===27?'string-escape':'string';",
	"}return output}",
	"function write(buffer){const output=sanitize(decoder.write(buffer));if(output)process.stdout.write(output)}",
	"function emitProjection(text){if(!text||projectionTruncated)return;const clean=sanitize(text),bytes=Buffer.byteLength(clean);if(projectionBytes+bytes>projectionLimit){projectionTruncated=true;process.stdout.write('\\n[artifact transcript projection truncated]\\n');return}projectionBytes+=bytes;process.stdout.write(clean)}",
	"function tool(name){if(typeof name!=='string'||!name.trim())return;const safe=name.replace(/[^A-Za-z0-9._-]+/g,'-').slice(0,80);if(!safe)return;toolCounts.set(safe,(toolCounts.get(safe)||0)+1)}",
	"function flushTools(){const tools=[...toolCounts].map(([name,count])=>count+'x '+name).join(', ');if(tools)emitProjection('\\ntools: '+tools+'\\n');toolCounts.clear()}",
	"function completion(){let info={status:'completed',kind:'subagent'};try{const raw=fs.readFileSync(done,'utf8').trim();if(raw.startsWith('{'))info={...info,...JSON.parse(raw)};else if(raw)info.status=raw.split(/\\s+/)[0]}catch{}flushTools();const marker=info.status==='completed'?'✓':info.status==='failed'?'✗':'■';const subject=info.kind==='parent-batch'?'parent batch':'subagent';process.stdout.write('\\n'+'─'.repeat(48)+'\\n'+marker+' '+subject+' '+info.status+'\\n')}",
	"function messageText(message){if(!message||message.role!=='assistant'||!Array.isArray(message.content))return '';return message.content.filter(part=>part&&part.type==='text'&&typeof part.text==='string').map(part=>part.text).join('\\n')}",
	"function project(line){try{const record=JSON.parse(line);if(!record||typeof record!=='object')return;if(record.recordType==='tool_start'){tool(record.toolName);return}if(record.recordType==='message'&&record.role==='assistant'){flushTools();if(typeof record.text==='string'&&record.text.trim())emitProjection(record.text+(record.text.endsWith('\\n')?'':'\\n'));return}if(record.recordType==='truncated'){flushTools();emitProjection('\\n[retained artifact transcript truncated]\\n');return}if(record.type==='tool_execution_start'){tool(record.toolName);return}if(record.type==='message_end'&&record.message?.role==='assistant'){flushTools();const text=messageText(record.message);if(text)emitProjection(text+(text.endsWith('\\n')?'':'\\n'));return}if(record.type==='message'&&record.message?.role==='assistant'){flushTools();for(const part of Array.isArray(record.message.content)?record.message.content:[])if(part?.type==='toolCall')tool(part.name);const text=messageText(record.message);if(text)emitProjection(text+(text.endsWith('\\n')?'':'\\n'))}}catch{}}",
	"function consumeTranscript(text){transcriptRemainder+=text;const lines=transcriptRemainder.split('\\n');transcriptRemainder=lines.pop()||'';for(const line of lines)if(line)project(line)}",
	"function pumpTranscript(){if(!transcript||projectionTruncated)return;try{const size=fs.statSync(transcript).size;if(size<transcriptOffset){transcriptOffset=0;transcriptRemainder=''}if(size>transcriptOffset){const fd=fs.openSync(transcript,'r');const b=Buffer.alloc(size-transcriptOffset);fs.readSync(fd,b,0,b.length,transcriptOffset);fs.closeSync(fd);transcriptOffset=size;consumeTranscript(transcriptDecoder.write(b));}}catch{}}",
	"function pump(){",
	" try{const size=fs.statSync(log).size;if(size<offset)offset=0;if(size>offset){const fd=fs.openSync(log,'r');const b=Buffer.alloc(size-offset);fs.readSync(fd,b,0,b.length,offset);fs.closeSync(fd);offset=size;write(b);}}catch{}",
	" pumpTranscript();",
	" if(!finishing&&fs.existsSync(done)){finishing=true;pump();setTimeout(()=>{pumpTranscript();consumeTranscript(transcriptDecoder.end());if(transcriptRemainder)project(transcriptRemainder);const output=sanitize(decoder.end());if(output)process.stdout.write(output);completion();try{fs.unlinkSync(done)}catch{}try{fs.unlinkSync(log)}catch{}process.exit(0)},250);}",
	"}",
	`const timer=setInterval(pump,${VIEWER_POLL_MS});`,
	"pump();",
	"process.on('exit',()=>clearInterval(timer));",
].join("");

function viewerCommand(nodeExecutable: string, logPath: string, donePath: string, transcriptPath?: string): string {
	return [nodeExecutable, "-e", VIEWER_SCRIPT, logPath, donePath, transcriptPath ?? "-"].map(shellQuote).join(" ");
}

function progressRoot(): string {
	return path.join(TEMP_ROOT_DIR, "orca-progress");
}

function pruneStaleProgressFiles(root: string, now = Date.now()): void {
	try {
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isFile() || (!entry.name.endsWith(".log") && !entry.name.endsWith(".done") && !entry.name.endsWith(".ready") && !entry.name.endsWith(".pending"))) continue;
			const file = path.join(root, entry.name);
			try {
				if (now - fs.statSync(file).mtimeMs > STALE_PROGRESS_MAX_AGE_MS) fs.rmSync(file, { force: true });
			} catch { /* best-effort stale cleanup */ }
		}
	} catch {
		// The observer remains optional when temp cleanup is unavailable.
	}
}

function safeSegment(value: unknown, fallback = "subagent"): string {
	if (typeof value !== "string") return fallback;
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || fallback;
}

function sleepSync(ms: number): void {
	const signal = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(signal, 0, 0, ms);
}

function resolveSequenceScope(cwd: string): string {
	let current = path.resolve(cwd);
	try { current = fs.realpathSync(current); } catch { /* use the lexical cwd */ }
	while (true) {
		try {
			if (fs.existsSync(path.join(current, ".git"))) return current;
		} catch { /* keep walking */ }
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(cwd);
		current = parent;
	}
}

function sequenceKey(cwd: string): string {
	return createHash("sha256").update(resolveSequenceScope(cwd)).digest("hex").slice(0, 20);
}

function withSequenceLock<T>(root: string, key: string, fn: () => T): T | undefined {
	const lockPath = path.join(root, `counter-${key}.lock`);
	let locked = false;
	for (let attempt = 0; attempt < COUNTER_LOCK_RETRIES; attempt++) {
		try {
			fs.mkdirSync(lockPath, { mode: 0o700 });
			locked = true;
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") break;
			try {
				if (Date.now() - fs.statSync(lockPath).mtimeMs > COUNTER_LOCK_STALE_MS) {
					fs.rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch { /* another process released the lock */ }
			sleepSync(COUNTER_LOCK_RETRY_MS);
		}
	}
	if (!locked) return undefined;
	try {
		return fn();
	} finally {
		try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* stale lock cleanup handles crashes */ }
	}
}

function predecessorMarker(pathValue: string | undefined): string | undefined {
	if (!pathValue) return undefined;
	const ready = pathValue.endsWith(".pending") ? pathValue.replace(/\.pending$/, ".ready") : pathValue;
	const pending = ready.replace(/\.ready$/, ".pending");
	if (fs.existsSync(ready) || fs.existsSync(pending)) return pending;
	return undefined;
}

function reserveTabSequence(root: string, cwd: string): { sequence: number; previousCreateDone?: string; createDone: string } | undefined {
	const key = sequenceKey(cwd);
	const counterPath = path.join(root, `counter-${key}`);
	const createDone = path.join(root, `create-${key}-${randomUUID()}.pending`);
	return withSequenceLock(root, key, () => {
		let current = 0;
		let previousCreateDone: string | undefined;
		try {
			const raw = fs.readFileSync(counterPath, "utf-8");
			const [countLine, previousLine] = raw.split("\n");
			const parsed = Number.parseInt(countLine ?? "", 10);
			if (Number.isSafeInteger(parsed) && parsed >= 0) current = parsed;
			previousCreateDone = predecessorMarker(previousLine?.trim());
		} catch { /* first tab for this worktree */ }
		const next = current + 1;
		try {
			fs.writeFileSync(createDone, "", { encoding: "utf-8", mode: 0o600 });
			fs.writeFileSync(counterPath, `${next}\n${createDone}\n`, { encoding: "utf-8", mode: 0o600 });
			return { sequence: next, previousCreateDone, createDone };
		} catch {
			try { fs.rmSync(createDone, { force: true }); } catch { /* best effort */ }
			return undefined;
		}
	});
}

export function resolvePiSessionId(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	try {
		const fd = fs.openSync(sessionFile, "r");
		try {
			const buffer = Buffer.alloc(16 * 1024);
			const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
			const line = buffer.toString("utf-8", 0, bytes).split("\n", 1)[0];
			if (!line) return undefined;
			const header = JSON.parse(line) as { type?: unknown; id?: unknown };
			if (header.type === "session" && typeof header.id === "string" && /^[A-Za-z0-9-]{8,}$/.test(header.id)) return header.id;
			return undefined;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

function scheduleCleanup(nodeExecutable: string, paths: string[]): void {
	try {
		const watchdog = spawn(nodeExecutable, ["-e", ORCA_CLEANUP_WATCHDOG_SCRIPT, String(CLEANUP_DELAY_MS), ...paths], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		watchdog.once("error", () => {});
		watchdog.unref();
	} catch {
		// Cleanup remains best effort for this optional observer.
	}
}

function loadOrcaProgressTabsConfig(): OrcaProgressTabsConfig | undefined {
	try {
		const configPath = path.join(getAgentDir(), "extensions", "subagent", "config.json");
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const value = (parsed as Record<string, unknown>).orcaProgressTabs;
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const config = value as Record<string, unknown>;
		if (Object.keys(config).some((key) => key !== "enabled") || typeof config.enabled !== "boolean") return undefined;
		return { enabled: config.enabled };
	} catch {
		return undefined;
	}
}

export interface OrcaProgressTabInput {
	cwd: string;
	/** Parent Pi worktree where the N+1 Orca tab set must remain grouped. */
	orcaWorktree?: string;
	/** Owning top-level tool call for parent observer manifests. */
	observerBatchId?: string;
	runId: string;
	agent: string;
	index: number;
	/** Retained readable child transcript artifact, when enabled. */
	transcriptPath?: string;
	/** Optional raw child-protocol artifact, when enabled. */
	jsonlPath?: string;
	/** Authoritative Pi session file when its path is known before launch. */
	sessionFile?: string;
	config?: OrcaProgressTabsConfig;
	env?: NodeJS.ProcessEnv;
	command?: string;
}

interface OrcaMirrorSource {
	label: "session" | "transcript" | "events";
	path: string;
}

function createSingleOrcaProgressTab(input: OrcaProgressTabInput, mirrorSource?: OrcaMirrorSource, titleOverride?: string): OrcaProgressTab | undefined {
	const config = input.config ?? loadOrcaProgressTabsConfig();
	if (config?.enabled !== true || process.platform === "win32") return undefined;
	const command = input.command ?? resolveOrcaCommand(input.env);
	if (!command) return undefined;
	const nodeExecutable = resolveNodeExecutable();

	const root = progressRoot();
	try {
		fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	} catch {
		return undefined;
	}
	pruneStaleProgressFiles(root);
	const runId = safeSegment(input.runId, "run");
	const agent = safeSegment(input.agent, "subagent");
	const index = typeof input.index === "number" && Number.isInteger(input.index) && input.index >= 0 ? input.index : 0;
	const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
	const orcaWorktree = resolveSequenceScope(input.orcaWorktree ?? cwd);
	const reservation = reserveTabSequence(root, orcaWorktree);
	if (reservation === undefined) return undefined;
	const tabSequence = reservation.sequence;
	const stem = `${runId}-${index}-${randomUUID()}`;
	const logPath = path.join(root, `${stem}.log`);
	const donePath = path.join(root, `${stem}.done`);
	const title = titleOverride ?? `subagent · ${agent} · ${tabSequence}`;
	const observerManifestPath = path.join(getProjectSubagentsDir(orcaWorktree), "views", "orca", `${stem}.json`);
	const observerManifest = {
		schemaVersion: 1,
		kind: "orca-progress-tab",
		observer: "orca",
		role: titleOverride ? "parent" : "child",
		title,
		worktree: orcaWorktree,
		runId,
		agent,
		index,
		sequence: tabSequence,
		...(input.observerBatchId ? { batchId: input.observerBatchId } : {}),
		createdAt: new Date().toISOString(),
	};
	const mirrorSourcePath = mirrorSource ? path.resolve(mirrorSource.path) : undefined;
	const association = [
		titleOverride ? `parent aggregate: ${runId}` : `child: run ${runId} · ${agent} · ${index + 1}`,
		titleOverride ? "projection: accumulated subagent summaries" : "projection: assistant text and tool names",
		"details omitted: arguments, tool results, protocol metadata, reasoning, and retained artifact paths",
	].join("\n");
	const markCreateReady = () => {
		try { fs.writeFileSync(reservation.createDone.replace(/\.pending$/, ".ready"), ""); } catch { /* unblock later tabs */ }
	};
	try {
		fs.writeFileSync(logPath, `pi-subagents / ${agent}\n${association}\n${"─".repeat(48)}\n`, { encoding: "utf-8", mode: 0o600 });
		fs.rmSync(donePath, { force: true });
	} catch {
		markCreateReady();
		return undefined;
	}

	let available = true;
	let truncated = false;
	let scheduledBytes = fs.statSync(logPath).size;
	const progressByteLimit = MAX_MIRROR_BYTES - MIRROR_FOOTER_RESERVE_BYTES;
	const logStream = fs.createWriteStream(logPath, { flags: "a", mode: 0o600 });
	const failObserver = () => {
		if (!available) return;
		available = false;
		logStream.destroy();
		try { fs.rmSync(logPath, { force: true }); } catch { /* best effort */ }
		try { fs.rmSync(donePath, { force: true }); } catch { /* best effort */ }
	};
	logStream.once("error", failObserver);
	const writeProgress = (text: string) => {
		if (!available || !text || truncated) return;
		const bytes = Buffer.byteLength(text);
		if (scheduledBytes + bytes > progressByteLimit) {
			truncated = true;
			return;
		}
		scheduledBytes += bytes;
		try {
			logStream.write(text);
		} catch {
			failObserver();
		}
	};
	let createSettled = false;
	let cleanupPaths: string[] | undefined;
	const scheduleDeferredCleanup = () => {
		if (!createSettled || cleanupPaths === undefined) return;
		scheduleCleanup(nodeExecutable, cleanupPaths);
		cleanupPaths = undefined;
	};
	try {
		const watchdog = spawn(nodeExecutable, [
			"-e", ORCA_CREATE_WATCHDOG_SCRIPT,
			String(ORCA_CREATE_TIMEOUT_MS),
			String(ORCA_KILL_GRACE_MS),
			String(ORCA_CREATE_WAIT_TIMEOUT_MS),
			reservation.previousCreateDone ?? "-",
			reservation.createDone,
			observerManifestPath,
			JSON.stringify(observerManifest),
			command,
			"terminal", "create",
			"--worktree", `path:${orcaWorktree}`,
			"--title", title,
			"--command", viewerCommand(nodeExecutable, logPath, donePath, mirrorSourcePath),
			"--json",
		], {
			cwd,
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			env: input.env ?? process.env,
		});
		watchdog.once("close", (code) => {
			createSettled = true;
			if (code !== 0) failObserver();
			scheduleDeferredCleanup();
		});
		watchdog.once("error", () => {
			markCreateReady();
			createSettled = true;
			failObserver();
			scheduleDeferredCleanup();
		});
		watchdog.unref();
	} catch {
		markCreateReady();
		failObserver();
		return undefined;
	}

	let finished = false;
	const liveToolCounts = new Map<string, number>();
	const flushLiveTools = (): string => {
		if (liveToolCounts.size === 0) return "";
		const summary = `\ntools: ${[...liveToolCounts].map(([name, count]) => `${count}x ${name}`).join(", ")}\n`;
		liveToolCounts.clear();
		return summary;
	};
	return {
		observerManifestPath,
		append(text) {
			if (finished) return;
			writeProgress(text);
		},
		event(event) {
			if (!available || finished || mirrorSourcePath) return;
			if (event.type === "tool_execution_start" && event.toolName) {
				// Tool arguments can contain prompts, credentials, and file contents.
				// The retained artifact/native inspector remain the detailed views.
				const toolName = safeSegment(event.toolName, "tool");
				liveToolCounts.set(toolName, (liveToolCounts.get(toolName) ?? 0) + 1);
				return;
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				writeProgress(flushLiveTools());
				const text = extractTextFromContent(event.message.content);
				if (text.trim()) writeProgress(`${text}${text.endsWith("\n") ? "" : "\n"}`);
			}
		},
		finish(status, _sessionFile) {
			if (!available || finished) return Promise.resolve();
			finished = true;
			const toolSummary = !mirrorSourcePath ? flushLiveTools() : "";
			const truncation = truncated ? `\n[progress projection truncated at ${MAX_MIRROR_BYTES} bytes]\n` : "";
			let footer = `${toolSummary}${truncation}`;
			if (scheduledBytes + Buffer.byteLength(footer) > MAX_MIRROR_BYTES) footer = "";
			return new Promise<void>((resolve) => {
				let settled = false;
				const complete = () => {
					if (settled) return;
					settled = true;
					if (available) {
						try {
							fs.writeFileSync(donePath, `${JSON.stringify({ status, kind: titleOverride ? "parent-batch" : "subagent" })}\n`, { encoding: "utf-8", mode: 0o600 });
						} catch { /* best effort */ }
						cleanupPaths = [logPath, donePath];
						scheduleDeferredCleanup();
					}
					resolve();
				};
				logStream.once("error", complete);
				logStream.end(footer, complete);
			});
		},
	};
}

export function createOrcaProgressTab(input: OrcaProgressTabInput): OrcaProgressTab | undefined {
	const readable = (label: OrcaMirrorSource["label"], value: string | undefined): OrcaMirrorSource | undefined => {
		if (!value) return undefined;
		const resolved = path.resolve(value);
		return { label, path: resolved };
	};
	const source =
		readable("transcript", input.transcriptPath)
		?? readable("session", input.sessionFile)
		?? readable("events", input.jsonlPath);
	return createSingleOrcaProgressTab(input, source);
}

interface OrcaParentTabRecord {
	key: string;
	sessionKey: string;
	batchId: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	tab: OrcaProgressTab;
	files: Set<string>;
	dirs: Set<string>;
	runIds: Set<string>;
	seenResults: Set<string>;
}

const ORCA_PARENT_TABS_KEY = Symbol.for("pi-subagents.orca-parent-tabs");

function parentTabs(): Map<string, OrcaParentTabRecord> {
	const globalStore = globalThis as typeof globalThis & { [ORCA_PARENT_TABS_KEY]?: Map<string, OrcaParentTabRecord> };
	return globalStore[ORCA_PARENT_TABS_KEY] ??= new Map();
}

function parentKey(sessionFile: string | undefined, sessionId: string | undefined): string | undefined {
	if (sessionFile) return path.resolve(sessionFile);
	return sessionId?.trim() || undefined;
}

function quoteCleanupPath(value: string): string {
	return shellQuote(path.resolve(value));
}

function addOwnedPath(record: OrcaParentTabRecord, value: unknown): void {
	if (typeof value !== "string" || !value.trim()) return;
	if (!record.parentSessionFile) return;
	const resolved = path.resolve(value);
	if (resolved === path.parse(resolved).root) return;
	const parentRoot = path.join(path.dirname(record.parentSessionFile), path.basename(record.parentSessionFile, ".jsonl"));
	const artifactRoot = path.join(path.dirname(record.parentSessionFile), "subagent-artifacts");
	const owningRoot = [parentRoot, artifactRoot].find((root) => {
		const relative = path.relative(root, resolved);
		return !relative.startsWith("..") && !path.isAbsolute(relative);
	});
	if (!owningRoot) return;
	try {
		if (fs.statSync(resolved).isDirectory()) {
			// Recursive cleanup is allowed only for a directory rooted in one of this
			// batch's exact run ids. Shared roots such as `forks` and
			// `subagent-artifacts` can contain retained data from other batches.
			if (owningRoot !== parentRoot) return;
			const [runRoot] = path.relative(parentRoot, resolved).split(path.sep);
			if (!runRoot || !record.runIds.has(runRoot)) return;
			record.dirs.add(resolved);
		} else {
			record.files.add(resolved);
		}
	} catch {
		// Result metadata may name an optional artifact that was not enabled.
	}
}

function collectResultPaths(record: OrcaParentTabRecord, details: unknown): void {
	if (!details || typeof details !== "object" || Array.isArray(details)) return;
	const root = details as Record<string, unknown>;
	for (const key of ["asyncDir", "savedOutputPath", "structuredOutputPath", "sessionFile", "transcriptPath"] as const) addOwnedPath(record, root[key]);
	if (Array.isArray(root.artifactPaths)) for (const value of root.artifactPaths) addOwnedPath(record, value);
	const handoff = root.parallelHandoff;
	if (handoff && typeof handoff === "object" && !Array.isArray(handoff)) addOwnedPath(record, (handoff as Record<string, unknown>).path);
	const results = Array.isArray(root.results) ? root.results : [];
	for (const entry of results) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const result = entry as Record<string, unknown>;
		for (const key of ["sessionFile", "transcriptPath", "savedOutputPath", "structuredOutputPath"] as const) addOwnedPath(record, result[key]);
		const outputReference = result.outputReference;
		if (outputReference && typeof outputReference === "object" && !Array.isArray(outputReference)) addOwnedPath(record, (outputReference as Record<string, unknown>).path);
		const artifacts = result.artifactPaths;
		if (Array.isArray(artifacts)) for (const value of artifacts) addOwnedPath(record, value);
		else if (artifacts && typeof artifacts === "object") {
			for (const value of Object.values(artifacts as Record<string, unknown>)) addOwnedPath(record, value);
		}
	}
}

function conciseResultSummary(details: unknown, failed: boolean): string {
	if (!details || typeof details !== "object" || Array.isArray(details)) return failed ? "subagent call failed" : "subagent call completed";
	const results = Array.isArray((details as Record<string, unknown>).results) ? (details as Record<string, unknown>).results as unknown[] : [];
	if (results.length === 0) return failed ? "subagent call failed" : "subagent call completed";
	const lines: string[] = [];
	for (const [index, value] of results.entries()) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const result = value as Record<string, unknown>;
		const agent = typeof result.agent === "string" ? safeSegment(result.agent) : `child-${index + 1}`;
		const runId = typeof result.runId === "string" ? safeSegment(result.runId, "run") : undefined;
		const terminal = typeof result.exitCode === "number" || typeof result.error === "string" || result.stopped === true || result.timedOut === true;
		const ok = result.exitCode === 0 && typeof result.error !== "string" && result.stopped !== true && result.timedOut !== true;
		const output = [result.finalOutput, result.output, result.error].find((item): item is string => typeof item === "string" && Boolean(item.trim()));
		const bounded = output?.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
		lines.push(`${terminal ? ok ? "✓" : "✗" : "•"} ${agent}${runId ? ` · ${runId}` : ""}${bounded ? `\n  ${bounded}` : ""}`);
	}
	return lines.join("\n") || (failed ? "subagent call failed" : "subagent call completed");
}

export function ensureOrcaParentProgressTab(input: {
	cwd: string;
	batchId: string;
	sessionId?: string;
	sessionFile?: string;
	config?: OrcaProgressTabsConfig;
	env?: NodeJS.ProcessEnv;
	command?: string;
}): void {
	const sessionKey = parentKey(input.sessionFile, input.sessionId);
	const batchId = input.batchId.trim();
	if (!sessionKey || !batchId) return;
	const key = `${sessionKey}\u0000${batchId}`;
	if (parentTabs().has(key)) return;
	const sessionLabel = safeSegment(input.sessionId ?? (input.sessionFile ? path.basename(input.sessionFile, ".jsonl").split("_").at(-1) : undefined), "parent");
	const batchLabel = safeSegment(batchId, "batch").slice(-12);
	const tab = createSingleOrcaProgressTab({
		cwd: input.cwd,
		runId: sessionLabel,
		agent: "parent",
		index: 0,
		sessionFile: input.sessionFile,
		config: input.config,
		env: input.env,
		command: input.command,
		observerBatchId: batchId,
	}, undefined, `parent · ${sessionLabel} · ${batchLabel}`);
	if (!tab) return;
	parentTabs().set(key, {
		key,
		sessionKey,
		batchId,
		parentSessionId: input.sessionId?.trim() || resolvePiSessionId(input.sessionFile),
		parentSessionFile: input.sessionFile ? path.resolve(input.sessionFile) : undefined,
		tab,
		files: new Set(),
		dirs: new Set(),
		runIds: new Set(),
		seenResults: new Set(),
	});
}

function collectBatchRunIds(record: OrcaParentTabRecord, details: unknown): void {
	if (!details || typeof details !== "object" || Array.isArray(details)) return;
	const root = details as Record<string, unknown>;
	for (const value of [root.id, root.runId, root.asyncId]) {
		if (typeof value === "string" && value.trim()) record.runIds.add(value.trim());
	}
	for (const entry of Array.isArray(root.results) ? root.results : []) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const result = entry as Record<string, unknown>;
		for (const value of [result.id, result.runId]) if (typeof value === "string" && value.trim()) record.runIds.add(value.trim());
	}
}

function batchResultIsTerminal(details: unknown, isError: boolean): boolean {
	if (isError) return true;
	if (!details || typeof details !== "object" || Array.isArray(details)) return true;
	const root = details as Record<string, unknown>;
	const results = Array.isArray(root.results) ? root.results : undefined;
	if (root.detached === true || results?.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).detached === true)) return false;
	const state = typeof root.state === "string" ? root.state : typeof root.status === "string" ? root.status : undefined;
	if (state === "running" || state === "pending" || state === "started") return false;
	if (state === "complete" || state === "completed" || state === "failed" || state === "stopped") return true;
	const pendingAsyncLaunch = typeof root.asyncId === "string" || typeof root.asyncDir === "string";
	if (pendingAsyncLaunch) return false;
	if (!results) return root.async !== true;
	if (results.length === 0) return root.async !== true;
	return results.every((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
		const result = entry as Record<string, unknown>;
		return typeof result.exitCode === "number" || typeof result.error === "string" || result.stopped === true || result.timedOut === true;
	});
}

async function finishOrcaParentRecord(record: OrcaParentTabRecord, status: "completed" | "failed" | "stopped" = "completed"): Promise<void> {
	if (!parentTabs().delete(record.key)) return;
	const files = [...record.files].filter((file) => ![...record.dirs].some((dir) => file === dir || file.startsWith(`${dir}${path.sep}`))).sort();
	const dirs = [...record.dirs].sort();
	const cleanup = [
		"",
		"cleanup all retained subagent files for this batch:",
		files.length > 0 ? `rm -f -- ${files.map(quoteCleanupPath).join(" ")}` : undefined,
		dirs.length > 0 ? `rm -rf -- ${dirs.map(quoteCleanupPath).join(" ")}` : undefined,
	].filter((line): line is string => line !== undefined).join("\n");
	record.tab.append(`${cleanup}\n`);
	await record.tab.finish(status, record.parentSessionFile);
}

export async function recordOrcaParentResult(input: {
	sessionId?: string;
	sessionFile?: string;
	toolCallId?: string;
	details?: unknown;
	isError?: boolean;
}): Promise<void> {
	const sessionKey = parentKey(input.sessionFile, input.sessionId);
	const sessionId = input.sessionId?.trim();
	if (!sessionKey && !sessionId) return;
	const resultKey = input.toolCallId?.trim() || `${Date.now()}`;
	let record = sessionKey && input.toolCallId
		? parentTabs().get(`${sessionKey}\u0000${input.toolCallId.trim()}`)
		: undefined;
	if (!record) {
		const runId = /^(?:async|foreground):(.+)$/.exec(resultKey)?.[1];
		const candidates = [...parentTabs().values()].filter((candidate) =>
			((sessionKey !== undefined && candidate.sessionKey === sessionKey)
				|| (sessionId !== undefined && candidate.parentSessionId === sessionId))
			&& (!runId || candidate.runIds.has(runId)));
		if (candidates.length === 1) record = candidates[0];
	}
	if (!record || record.seenResults.has(resultKey)) return;
	record.seenResults.add(resultKey);
	collectBatchRunIds(record, input.details);
	collectResultPaths(record, input.details);
	record.tab.append(`\n${conciseResultSummary(input.details, input.isError === true)}\n`);
	if (batchResultIsTerminal(input.details, input.isError === true)) {
		await finishOrcaParentRecord(record, input.isError === true ? "failed" : "completed");
	}
}

export async function finishOrcaParentProgressTabs(input?: { sessionId?: string; sessionFile?: string }): Promise<void> {
	const onlySessionKey = input ? parentKey(input.sessionFile, input.sessionId) : undefined;
	const requestedSessionId = input?.sessionId?.trim() || resolvePiSessionId(input?.sessionFile);
	const completions: Promise<void>[] = [];
	for (const record of parentTabs().values()) {
		const recordSessionId = record.parentSessionId ?? resolvePiSessionId(record.parentSessionFile);
		if (onlySessionKey && record.sessionKey !== onlySessionKey && (!requestedSessionId || recordSessionId !== requestedSessionId)) continue;
		completions.push(finishOrcaParentRecord(record));
	}
	await Promise.all(completions);
}
