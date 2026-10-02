import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAuthorityDecision } from "../../policy/authority.ts";
import { resolveNodeExecutable } from "../../shared/node-executable.ts";
import type { ExtensionConfig } from "../../shared/types.ts";
import type { WorktreeCountReport } from "./worktree-count-policy.ts";

type Request = { authorized: true; repo: string; handoffPaths: string[]; limit: number; terminalForegroundRunIds: string[]; worktreeBaseDir?: string };
type Job = { handoffs: Set<string>; timer?: ReturnType<typeof setTimeout>; running: boolean; again: boolean };
type Deps = {
	config: ExtensionConfig;
	terminalForegroundRunIds?: () => Iterable<string>;
	report?: (report: WorktreeCountReport | { state: "blocked" | "failed"; reason: string }) => void;
	/** Test seams keep default-off and queue behavior observable without filesystem access. */
	resolveRepo?: (repo: string) => Promise<string>;
	run?: (request: Request, signal: AbortSignal) => Promise<WorktreeCountReport>;
	coalesceMs?: number;
};

async function resolveRepo(repo: string): Promise<string> {
	const root = await new Promise<string>((resolve, reject) => execFile("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf-8", windowsHide: true, timeout: 5_000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
	return fs.promises.realpath(root);
}

async function runWorker(request: Request, signal: AbortSignal): Promise<WorktreeCountReport> {
	const compiled = fileURLToPath(new URL("./worktree-count-worker.js", import.meta.url));
	const worker = fs.existsSync(compiled) ? compiled : fileURLToPath(new URL("./worktree-count-worker.ts", import.meta.url));
	return new Promise((resolve, reject) => {
		const child = spawn(resolveNodeExecutable(), [...(worker.endsWith(".ts") ? ["--experimental-strip-types"] : []), worker, JSON.stringify(request)], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
		// Keep the lock owner alive until its current Git command has finished.
		// Killing only Node could leave a destructive Git child running after the
		// repository lock became reclaimable. IPC cancellation also works on Windows.
		const cancel = () => { if (child.connected) child.send({ type: "cancel" }, () => {}); };
		signal.addEventListener("abort", cancel, { once: true });
		if (signal.aborted) cancel();
		let stdout = "", stderr = "";
		child.stdout!.on("data", (data) => { stdout += data; if (stdout.length > 2 * 1024 * 1024) child.kill(); });
		child.stderr!.on("data", (data) => { if (stderr.length < 16_384) stderr += data; });
		child.on("error", reject);
		child.on("close", (code) => {
			signal.removeEventListener("abort", cancel);
			if (code !== 0) reject(new Error(stderr.trim() || `Worktree maintenance worker exited ${code}.`));
			else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
		});
	});
}

/** Parent-owned, event-driven maintenance. No timers or I/O when the limit is absent. */
export function createWorktreeCountManager(deps: Deps) {
	const abort = new AbortController();
	const jobs = new Map<string, Job>();
	const roots = new Map<string, Promise<string>>();
	let blockedReported = false;
	const report = deps.report ?? ((result) => console.warn(`[pi-subagents] Worktree retention: ${JSON.stringify(result)}`));
	function arm(repo: string, job: Job): void {
		if (job.timer || job.running || job.handoffs.size > 256 || abort.signal.aborted) return;
		job.timer = setTimeout(() => {
			job.timer = undefined;
			if (abort.signal.aborted) return;
			if (resolveAuthorityDecision({ action: "discardWorktree", policy: deps.config.authorityPolicy }) !== "auto") return;
			job.running = true;
			job.again = false;
			const request: Request = { authorized: true, repo, limit: deps.config.worktreeRetainCount!, handoffPaths: [...job.handoffs], terminalForegroundRunIds: [...(deps.terminalForegroundRunIds?.() ?? [])].slice(0, 50), ...(deps.config.worktreeBaseDir ? { worktreeBaseDir: deps.config.worktreeBaseDir } : {}) };
			void (deps.run ?? runWorker)(request, abort.signal).then((result) => {
				if (!abort.signal.aborted && result.state !== "below-limit") report(result);
			}).catch((error) => {
				if (!abort.signal.aborted) report({ state: "failed", reason: error instanceof Error ? error.message : String(error) });
			}).finally(() => { job.running = false; if (job.again) arm(repo, job); });
		}, deps.coalesceMs ?? 100);
		job.timer.unref?.();
	}
	return {
		request(repo: string, handoffPath?: string): void {
			if (deps.config.worktreeRetainCount === undefined || abort.signal.aborted) return;
			if (resolveAuthorityDecision({ action: "discardWorktree", policy: deps.config.authorityPolicy }) !== "auto") {
				if (!blockedReported) { report({ state: "blocked", reason: "Automatic count cleanup requires authorityPolicy.discardWorktree='auto'; no background confirmation is opened." }); blockedReported = true; }
				return;
			}
			const requested = path.resolve(repo);
			let root = roots.get(requested);
			if (!root) { root = (deps.resolveRepo ?? resolveRepo)(requested); roots.set(requested, root); }
			void root.then((canonical) => {
				if (abort.signal.aborted) return;
				const job = jobs.get(canonical) ?? { handoffs: new Set<string>(), running: false, again: false };
				jobs.set(canonical, job);
				if (handoffPath) job.handoffs.add(path.resolve(handoffPath));
				if (job.handoffs.size > 256) { if (job.timer) { clearTimeout(job.timer); job.timer = undefined; } job.again = false; report({ state: "blocked", reason: "Known handoff inventory exceeds 256 records; inspect and clean manually." }); return; }
				if (job.running) job.again = true;
				else arm(canonical, job);
			}).catch((error) => {
				roots.delete(requested);
				if (!abort.signal.aborted) report({ state: "failed", reason: error instanceof Error ? error.message : String(error) });
			});
		},
		stop(): void {
			abort.abort();
			for (const job of jobs.values()) if (job.timer) clearTimeout(job.timer);
			jobs.clear(); roots.clear();
		},
	};
}
