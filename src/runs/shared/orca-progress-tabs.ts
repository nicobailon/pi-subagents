import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { resolveNodeExecutable } from "../../shared/node-executable.ts";
import { getProjectSubagentsDir } from "../../shared/artifacts.ts";
import { TEMP_ROOT_DIR, type OrcaProgressTabsConfig } from "../../shared/types.ts";
import { extractTextFromContent, extractToolArgsPreview, getAgentDir } from "../../shared/utils.ts";

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
	"const fs=require('node:fs');",
	"const timeout=Number(process.argv[1]),grace=Number(process.argv[2]),waitTimeout=Number(process.argv[3]);",
	"const previous=process.argv[4],done=process.argv[5],manifest=process.argv[6],command=process.argv[7],args=process.argv.slice(8);",
	"function mark(){try{fs.writeFileSync(done.replace(/\\.pending$/,'.ready'),'')}catch{}}",
	"function exists(file){try{return fs.existsSync(file)}catch{return false}}",
	"function keepQueued(){try{const now=new Date();fs.utimesSync(done,now,now)}catch{}}",
	"function predecessorReady(){if(previous==='-')return true;if(exists(previous.replace(/\\.pending$/,'.ready')))return true;try{return Date.now()-fs.statSync(previous).mtimeMs>=waitTimeout}catch{return true}}",
	"function updateManifest(state,stdout=''){if(manifest==='-')return;try{const payload=JSON.parse(fs.readFileSync(manifest,'utf8'));payload.state=state;payload.updatedAt=new Date().toISOString();const raw=stdout.trim().split(/\\r?\\n/).filter(Boolean).at(-1);if(raw){try{payload.orca=JSON.parse(raw)}catch{payload.orcaRaw=raw.slice(0,4096)}}fs.writeFileSync(manifest,JSON.stringify(payload,null,2)+'\\n')}catch{}}",
	"function start(){",
	" try{",
	"  const child=spawn(command,args,{stdio:['ignore','pipe','ignore'],windowsHide:true});",
	"  let hardKill,stdout='';",
	"  if(child.stdout)child.stdout.on('data',chunk=>{stdout+=String(chunk);if(stdout.length>65536)stdout=stdout.slice(-65536)});",
	"  const timer=setTimeout(()=>{child.kill('SIGTERM');hardKill=setTimeout(()=>child.kill('SIGKILL'),grace)},timeout);",
	"  const clear=()=>{clearTimeout(timer);if(hardKill)clearTimeout(hardKill);mark()};",
	"  child.once('error',()=>{updateManifest('failed');clear();process.exitCode=1});",
	"  child.once('close',code=>{updateManifest(code===0?'open':'failed',stdout);clear();process.exitCode=code===0?0:1});",
	" }catch{updateManifest('failed');mark();process.exitCode=1}",
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
	append(text: string): void;
	section(input: { agent: string; index: number; count: number }): void;
	event(event: { type?: string; message?: Message; toolName?: string; args?: unknown }): void;
	finish(status: "completed" | "failed" | "stopped", sessionFile?: string): void;
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
	"const log=process.argv[1],done=process.argv[2],decoder=new StringDecoder('utf8');",
	"let offset=0,finishing=false,state='text';",
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
	"function pump(){",
	" try{const size=fs.statSync(log).size;if(size<offset)offset=0;if(size>offset){const fd=fs.openSync(log,'r');const b=Buffer.alloc(size-offset);fs.readSync(fd,b,0,b.length,offset);fs.closeSync(fd);offset=size;write(b);}}catch{}",
	" if(!finishing&&fs.existsSync(done)){finishing=true;pump();setTimeout(()=>{const output=sanitize(decoder.end());if(output)process.stdout.write(output);try{fs.unlinkSync(done)}catch{}try{fs.unlinkSync(log)}catch{}process.exit(0)},250);}",
	"}",
	`const timer=setInterval(pump,${VIEWER_POLL_MS});`,
	"pump();",
	"process.on('exit',()=>clearInterval(timer));",
].join("");

function viewerCommand(nodeExecutable: string, logPath: string, donePath: string): string {
	const invocation = [nodeExecutable, "-e", VIEWER_SCRIPT, logPath, donePath].map(shellQuote).join(" ");
	// Do not replace or exit Orca's interactive shell. The short-lived viewer may
	// finish and delete its mirror files, while the completed tab remains open at
	// the shell prompt until the user closes it.
	return invocation;
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

interface OrcaObserverManifest {
	schemaVersion: 1;
	kind: "orca-observer-view";
	observer: "orca";
	role: "run";
	runId: string;
	title: string;
	worktree: string;
	state: "opening" | "open" | "failed";
	createdAt: string;
	updatedAt?: string;
	logPath: string;
	orca?: unknown;
	orcaRaw?: string;
}

function observerManifestPath(cwd: string, stem: string): string | undefined {
	try {
		const dir = path.join(getProjectSubagentsDir(resolveSequenceScope(cwd)), "views", "orca");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		return path.join(dir, `${stem}.json`);
	} catch {
		return undefined;
	}
}

function writeObserverManifest(manifestPath: string | undefined, manifest: OrcaObserverManifest): void {
	if (!manifestPath) return;
	try {
		fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	} catch {
		// The Orca observer stays display-only when project-local manifests cannot be written.
	}
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

export function createOrcaProgressTab(input: {
	cwd: string;
	runId: string;
	agent: string;
	index: number;
	stepCount?: number;
	config?: OrcaProgressTabsConfig;
	env?: NodeJS.ProcessEnv;
	command?: string;
}): OrcaProgressTab | undefined {
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
	const reservation = reserveTabSequence(root, cwd);
	if (reservation === undefined) return undefined;
	const tabSequence = reservation.sequence;
	const stem = `${runId}-${index}-${randomUUID()}`;
	const stepCount = typeof input.stepCount === "number" && Number.isInteger(input.stepCount) && input.stepCount > 0 ? input.stepCount : 1;
	const logPath = path.join(root, `${stem}.log`);
	const donePath = path.join(root, `${stem}.done`);
	const title = `subagents · ${agent} · ${tabSequence}`;
	const markCreateReady = () => {
		try { fs.writeFileSync(reservation.createDone.replace(/\.pending$/, ".ready"), ""); } catch { /* unblock later tabs */ }
	};
	const manifestPath = observerManifestPath(cwd, stem);
	writeObserverManifest(manifestPath, {
		schemaVersion: 1,
		kind: "orca-observer-view",
		observer: "orca",
		role: "run",
		runId,
		title,
		worktree: path.resolve(cwd),
		state: "opening",
		createdAt: new Date().toISOString(),
		logPath,
	});
	try {
		fs.writeFileSync(logPath, `pi-subagents / ${agent}\nrun ${runId} · ${stepCount === 1 ? "1 child" : `${stepCount} children`}\n${"─".repeat(48)}\n`, { encoding: "utf-8", mode: 0o600 });
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
			manifestPath ?? "-",
			command,
			"terminal", "create",
			"--worktree", `path:${path.resolve(cwd)}`,
			"--title", title,
			"--command", viewerCommand(nodeExecutable, logPath, donePath),
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
	return {
		append(text) {
			if (finished) return;
			writeProgress(text);
		},
		section(section) {
			if (finished) return;
			const label = safeSegment(section.agent, "subagent");
			const count = Number.isInteger(section.count) && section.count > 0 ? section.count : 1;
			const index = Number.isInteger(section.index) && section.index >= 0 ? section.index : 0;
			writeProgress(`\n${"─".repeat(16)} child ${index + 1}/${count} · ${label} ${"─".repeat(16)}\n`);
		},
		event(event) {
			if (!available || finished) return;
			if (event.type === "tool_execution_start" && event.toolName) {
				const args = event.args && typeof event.args === "object" && !Array.isArray(event.args)
					? extractToolArgsPreview(event.args as Record<string, unknown>)
					: "";
				writeProgress(`\n› ${event.toolName}${args ? `: ${args}` : ""}\n`);
				return;
			}
			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				const text = extractTextFromContent(event.message.content);
				if (text.trim()) writeProgress(`${text}${text.endsWith("\n") ? "" : "\n"}`);
			}
		},
		finish(status, sessionFile) {
			if (!available || finished) return;
			finished = true;
			const sessionId = status === "completed" ? resolvePiSessionId(sessionFile) : undefined;
			let verifiedSessionFile: string | undefined;
			if (sessionId && sessionFile) {
				try { verifiedSessionFile = fs.realpathSync(sessionFile); } catch { /* the session is no longer available */ }
			}
			const terminalMessage = verifiedSessionFile
				? `completed. To remove the Pi session for this run, run rm -- ${shellQuote(verifiedSessionFile)}`
				: status;
			const truncation = truncated ? `\n[progress mirror truncated at ${MAX_MIRROR_BYTES} bytes]\n` : "";
			let footer = `${truncation}\n${"─".repeat(48)}\n${terminalMessage}\n`;
			if (scheduledBytes + Buffer.byteLength(footer) > MAX_MIRROR_BYTES) footer = `\n${status}\n`;
			logStream.end(footer, () => {
				if (!available) return;
				try { fs.writeFileSync(donePath, `${status}\n`, { encoding: "utf-8", mode: 0o600 }); } catch { /* best effort */ }
				cleanupPaths = [logPath, donePath];
				scheduleDeferredCleanup();
			});
		},
	};
}
