import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { loadConfig } from "../../extension/config.ts";
import { TEMP_ROOT_DIR, type OrcaProgressTabsConfig } from "../../shared/types.ts";
import { extractTextFromContent, extractToolArgsPreview } from "../../shared/utils.ts";

const ORCA_CREATE_TIMEOUT_MS = 20_000;
const ORCA_KILL_GRACE_MS = 2_000;
const CLEANUP_DELAY_MS = 5 * 60_000;
const STALE_PROGRESS_MAX_AGE_MS = 24 * 60 * 60_000;
const VIEWER_POLL_MS = 150;
const COUNTER_LOCK_STALE_MS = 30_000;
const COUNTER_LOCK_RETRIES = 200;
const COUNTER_LOCK_RETRY_MS = 10;

export interface OrcaProgressTab {
	append(text: string): void;
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
	if (process.platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const VIEWER_SCRIPT = [
	"const fs=require('fs');",
	"const log=process.argv[1],done=process.argv[2];",
	"let offset=0,finishing=false;",
	"function pump(){",
	" try{const size=fs.statSync(log).size;if(size<offset)offset=0;if(size>offset){const fd=fs.openSync(log,'r');const b=Buffer.alloc(size-offset);fs.readSync(fd,b,0,b.length,offset);fs.closeSync(fd);offset=size;process.stdout.write(b);}}catch{}",
	" if(!finishing&&fs.existsSync(done)){finishing=true;pump();setTimeout(()=>{try{fs.unlinkSync(done)}catch{}try{fs.unlinkSync(log)}catch{}process.exit(0)},250);}",
	"}",
	`const timer=setInterval(pump,${VIEWER_POLL_MS});`,
	"pump();",
	"process.on('exit',()=>clearInterval(timer));",
].join("");

function viewerCommand(logPath: string, donePath: string): string {
	const invocation = [process.execPath, "-e", VIEWER_SCRIPT, logPath, donePath].map(shellQuote).join(" ");
	// Do not replace or exit Orca's interactive shell. The short-lived viewer may
	// finish and delete its mirror files, while the completed tab remains open at
	// the shell prompt until the user closes it.
	if (process.platform === "win32") return invocation;
	return `printf '\\033[2J\\033[H'; ${invocation}`;
}

function progressRoot(): string {
	return path.join(TEMP_ROOT_DIR, "orca-progress");
}

function pruneStaleProgressFiles(root: string, now = Date.now()): void {
	try {
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isFile() || (!entry.name.endsWith(".log") && !entry.name.endsWith(".done"))) continue;
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

function reserveTabSequence(root: string, cwd: string): number | undefined {
	const key = createHash("sha256").update(resolveSequenceScope(cwd)).digest("hex").slice(0, 20);
	const counterPath = path.join(root, `counter-${key}`);
	const lockPath = `${counterPath}.lock`;
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
		let current = 0;
		try {
			const parsed = Number.parseInt(fs.readFileSync(counterPath, "utf-8"), 10);
			if (Number.isSafeInteger(parsed) && parsed >= 0) current = parsed;
		} catch { /* first tab for this worktree */ }
		const next = current + 1;
		try {
			fs.writeFileSync(counterPath, `${next}\n`, { encoding: "utf-8", mode: 0o600 });
			return next;
		} catch {
			return undefined;
		}
	} finally {
		try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* stale lock cleanup handles crashes */ }
	}
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

function scheduleCleanup(paths: string[]): void {
	const timer = setTimeout(() => {
		for (const file of paths) {
			try { fs.rmSync(file, { force: true }); } catch { /* best-effort temp cleanup */ }
		}
	}, CLEANUP_DELAY_MS);
	timer.unref?.();
}

export function createOrcaProgressTab(input: {
	cwd: string;
	runId: string;
	agent: string;
	index: number;
	config?: OrcaProgressTabsConfig;
	env?: NodeJS.ProcessEnv;
	command?: string;
}): OrcaProgressTab | undefined {
	let config: OrcaProgressTabsConfig | undefined;
	try {
		config = input.config ?? loadConfig().orcaProgressTabs;
	} catch {
		return undefined;
	}
	if (config?.enabled !== true) return undefined;
	const command = input.command ?? resolveOrcaCommand(input.env);
	if (!command) return undefined;

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
	const tabSequence = reserveTabSequence(root, cwd);
	if (tabSequence === undefined) return undefined;
	const stem = `${runId}-${index}-${randomUUID()}`;
	const logPath = path.join(root, `${stem}.log`);
	const donePath = path.join(root, `${stem}.done`);
	const title = `subagent · ${agent} · ${tabSequence}`;
	try {
		fs.writeFileSync(logPath, `pi-subagents / ${agent}\nrun ${runId} · child ${index + 1}\n${"─".repeat(48)}\n`, { encoding: "utf-8", mode: 0o600 });
		fs.rmSync(donePath, { force: true });
	} catch {
		return undefined;
	}

	let available = true;
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
		if (!available || !text) return;
		try { logStream.write(text); } catch { failObserver(); }
	};
	try {
		const child = spawn(command, [
			"terminal", "create",
			"--worktree", `path:${path.resolve(cwd)}`,
			"--title", title,
			"--command", viewerCommand(logPath, donePath),
			"--json",
		], {
			cwd,
			stdio: "ignore",
			windowsHide: true,
			env: input.env ?? process.env,
		});
		let hardKillTimer: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			hardKillTimer = setTimeout(() => child.kill("SIGKILL"), ORCA_KILL_GRACE_MS);
			hardKillTimer.unref?.();
		}, ORCA_CREATE_TIMEOUT_MS);
		timer.unref?.();
		const clearProcessTimers = () => {
			clearTimeout(timer);
			if (hardKillTimer) clearTimeout(hardKillTimer);
		};
		child.once("close", (code) => {
			clearProcessTimers();
			if (code !== 0) failObserver();
		});
		child.once("error", () => {
			clearProcessTimers();
			failObserver();
		});
		child.unref();
	} catch {
		failObserver();
		return undefined;
	}

	let finished = false;
	return {
		append(text) {
			if (finished) return;
			writeProgress(text);
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
			const terminalMessage = sessionId
				? `completed. To remove the Pi session of this subagent, run rm $(find ~/.pi/agent/sessions -name "*_${sessionId}.jsonl" -print -quit)`
				: status;
			logStream.end(`\n${"─".repeat(48)}\n${terminalMessage}\n`, () => {
				if (!available) return;
				try { fs.writeFileSync(donePath, `${status}\n`, { encoding: "utf-8", mode: 0o600 }); } catch { /* best effort */ }
				scheduleCleanup([logPath, donePath]);
			});
		},
	};
}
