import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildForkHandlerEnv, buildForkRunPaths, getForkHandlersFile, getForkStateDir, launchDetachedFork } from "../../shared/fork-runtime.ts";
import { SUBAGENT_CHILD_ENV } from "../shared/pi-args.ts";
import { getPiSpawnCommand } from "../shared/pi-spawn.ts";
import type { BackgroundForkHandlersConfig } from "../../shared/types.ts";

export type BackgroundForkHandlerNotify = "ack-and-summary" | "summary" | "none";

export interface ResolvedBackgroundForkHandlersConfig {
	enabled: boolean;
	notify: BackgroundForkHandlerNotify;
	triggerParentOnSummary: boolean;
	piCommand?: string;
}

export interface SubagentBackgroundForkEvent {
	type: "async-complete" | "async-step-complete" | "control-notice";
	title: string;
	content: string;
	cwd?: string;
	parentSessionFile?: string;
	parentIntercomTarget?: string;
	details?: unknown;
}

interface BackgroundForkRun {
	id: string;
	type: SubagentBackgroundForkEvent["type"];
	title: string;
	cwd: string;
	dir: string;
	eventPath: string;
	promptPath: string;
	stdoutPath: string;
	stderrPath: string;
	sessionDir: string;
	parentSessionFile?: string;
	parentIntercomTarget?: string;
	status?: "starting" | "running" | "complete" | "failed";
	startedAt?: number;
	endedAt?: number;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	error?: string;
	pid?: number;
}

interface BackgroundForkRunsState {
	version: 1;
	handlers: BackgroundForkRun[];
}

const STATE_DIR = getForkStateDir("subagents");
const HANDLERS_FILE = getForkHandlersFile("subagents");
const SUMMARY_LIMIT_BYTES = 16 * 1024;
const MAX_PERSISTED_HANDLERS = 200;

function truncateText(text: string, limitBytes: number): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= limitBytes) return text;
	const truncated = Buffer.from(text, "utf8").subarray(0, limitBytes).toString("utf8");
	return `${truncated}\n… truncated ${bytes - limitBytes} bytes`;
}

function sanitizeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "event";
}

function makeRunId(event: SubagentBackgroundForkEvent): string {
	return `sbf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}_${sanitizeSegment(event.type)}`;
}

async function readPersistedRuns(): Promise<BackgroundForkRun[]> {
	try {
		const raw = await fs.promises.readFile(HANDLERS_FILE, "utf8");
		const parsed = JSON.parse(raw) as Partial<BackgroundForkRunsState>;
		return Array.isArray(parsed.handlers) ? parsed.handlers : [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return [];
	}
}

async function writePersistedRuns(runs: BackgroundForkRun[]): Promise<void> {
	await fs.promises.mkdir(STATE_DIR, { recursive: true });
	const tmp = `${HANDLERS_FILE}.${process.pid}.${Date.now()}.tmp`;
	const state: BackgroundForkRunsState = { version: 1, handlers: runs.slice(-MAX_PERSISTED_HANDLERS) };
	await fs.promises.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	await fs.promises.rename(tmp, HANDLERS_FILE);
}

async function persistRun(run: BackgroundForkRun): Promise<void> {
	const runs = await readPersistedRuns();
	const next = [...runs.filter((candidate) => candidate.id !== run.id), run];
	await writePersistedRuns(next);
}

async function patchPersistedRun(id: string, patch: Partial<BackgroundForkRun>): Promise<void> {
	const runs = await readPersistedRuns();
	const index = runs.findIndex((candidate) => candidate.id === id);
	if (index === -1) return;
	runs[index] = { ...runs[index]!, ...patch };
	await writePersistedRuns(runs);
}

export function resolveBackgroundForkHandlersConfig(config?: BackgroundForkHandlersConfig): ResolvedBackgroundForkHandlersConfig {
	return {
		enabled: config?.enabled ?? true,
		notify: config?.notify ?? "ack-and-summary",
		triggerParentOnSummary: config?.triggerParentOnSummary ?? false,
		...(config?.piCommand ? { piCommand: config.piCommand } : {}),
	};
}

function buildSystemPrompt(run: BackgroundForkRun): string {
	return [
		"You are a background pi-subagents event handler in a sibling Pi process.",
		"Handle only the subagent event capsule in the latest user message.",
		"Do not continue unrelated parent work. Do not interrupt the parent unless a real decision or required parent action is needed.",
		"You may inspect referenced files, child session files, artifacts, and repo state to summarize or triage the event.",
		"Do the safe triage/checking in this fork. Do not send optional next steps, routine success, or no-action-needed updates back to the parent.",
		"If the event contains a concrete required parent action, blocker, or required parent follow-up, notify the parent through intercom instead of only writing a final summary.",
		"Use intercom({ action: \"send\", to: <parent>, message: ... }) for required actionable non-blocking parent notices; use intercom.ask only for true blocking decisions.",
		"Escalate only for destructive actions, ambiguous user preference, external side effects, security/privacy/cost risk, conflict with current parent work, or low confidence.",
		...(run.parentIntercomTarget ? [`Parent intercom target: ${run.parentIntercomTarget}`] : []),
		`Handler id: ${run.id}`,
	].join("\n");
}

function buildPrompt(event: SubagentBackgroundForkEvent, run: BackgroundForkRun): string {
	return [
		"# pi-subagents background event",
		"",
		`Type: ${event.type}`,
		`Title: ${event.title}`,
		`Handler: ${run.id}`,
		"",
		"## Parent notification content",
		"",
		event.content,
		"",
		"## Event details",
		"",
		"```json",
		JSON.stringify(event.details ?? {}, null, 2),
		"```",
		"",
		"## Instructions",
		"",
		"Handle this background event without waking the parent feed for routine summaries. If the event includes a child session or artifact path, read it only when it helps triage accurately.",
		"Do safe checks in this fork. If your conclusion is routine success, optional follow-up, or no action needed, do not send an intercom message to the parent; just state that in your final summary.",
		...(run.parentIntercomTarget
			? [
				`Parent intercom target: ${run.parentIntercomTarget}`,
				`Only if the event content includes a concrete required parent action, blocker, or required parent follow-up, call intercom({ action: \"send\", to: ${JSON.stringify(run.parentIntercomTarget)}, message: \"...\" }) with a concise action request so the parent can start it. If delivery fails because the target is stale, missing, or ambiguous, call intercom({ action: \"list\" }) and retry with the full id of the non-fork parent session that matches this event's cwd/name, excluding sessions whose status contains \"fork-handler:\". Use intercom.ask only if you need a decision before you can proceed.`,
			]
			: ["No parent intercom target is available; include any required parent action in your final summary."]),
		"Final summary: state what you inspected, what you sent/escalated to the parent if anything, and whether further parent action is still needed.",
	].join("\n");
}

function formatAck(run: BackgroundForkRun): string {
	return [
		`Background subagent event forked: ${run.title}`,
		`Handler: ${run.id}${run.pid ? ` (pid ${run.pid})` : ""}`,
		`Handler dir: ${run.dir}`,
	].join("\n");
}

function formatSummary(run: BackgroundForkRun, status: "complete" | "failed", code: number | null, signal: NodeJS.Signals | null): string {
	const stdout = fs.existsSync(run.stdoutPath) ? fs.readFileSync(run.stdoutPath, "utf8") : "";
	const stderr = fs.existsSync(run.stderrPath) ? fs.readFileSync(run.stderrPath, "utf8") : "";
	const output = stdout.trim() || stderr.trim() || "(no handler output)";
	const exit = code !== null ? String(code) : signal ? `signal ${signal}` : "unknown";
	return [
		`Background subagent event handler ${status}: ${run.title}`,
		`Handler: ${run.id}`,
		`Exit: ${exit}`,
		`Output: ${run.stdoutPath}`,
		`Errors: ${run.stderrPath}`,
		"",
		truncateText(output, SUMMARY_LIMIT_BYTES),
	].join("\n");
}

function sendFallback(pi: Pick<ExtensionAPI, "sendMessage">, event: SubagentBackgroundForkEvent): void {
	pi.sendMessage(
		{
			customType: event.type === "control-notice" ? "subagent_control_notice" : "subagent-notify",
			content: event.content,
			display: true,
			details: event.details,
		},
		{ triggerTurn: false },
	);
}

export async function deliverBackgroundForkEvent(
	pi: Pick<ExtensionAPI, "sendMessage">,
	config: BackgroundForkHandlersConfig | undefined,
	event: SubagentBackgroundForkEvent,
): Promise<void> {
	const resolved = resolveBackgroundForkHandlersConfig(config);
	if (!resolved.enabled) {
		sendFallback(pi, event);
		return;
	}

	let run: BackgroundForkRun | undefined;
	try {
		run = (() => {
			const id = makeRunId(event);
			return {
				...buildForkRunPaths("subagents", id),
				type: event.type,
				title: event.title,
				cwd: event.cwd ?? process.cwd(),
				status: "starting",
				startedAt: Date.now(),
				...(event.parentSessionFile ? { parentSessionFile: event.parentSessionFile } : {}),
				...(event.parentIntercomTarget ? { parentIntercomTarget: event.parentIntercomTarget } : {}),
			};
		})();

		await fs.promises.mkdir(run.sessionDir, { recursive: true });
		await fs.promises.writeFile(run.eventPath, `${JSON.stringify(event, null, 2)}\n`, "utf8");
		await fs.promises.writeFile(run.promptPath, buildPrompt(event, run), "utf8");
		await persistRun(run);

		const baseArgs = [
			"-p",
			"--session-dir",
			run.sessionDir,
			"--append-system-prompt",
			buildSystemPrompt(run),
			...(run.parentSessionFile ? ["--fork", run.parentSessionFile] : []),
			`@${run.promptPath}`,
		];
		const command = resolved.piCommand ? { command: resolved.piCommand, args: baseArgs } : getPiSpawnCommand(baseArgs);
		const launch = await launchDetachedFork({
			command: command.command,
			args: command.args,
			cwd: run.cwd,
			stdoutPath: run.stdoutPath,
			stderrPath: run.stderrPath,
			env: buildForkHandlerEnv("subagents", run.id, { ...process.env, [SUBAGENT_CHILD_ENV]: "1" }),
			onClose: (code, signal) => {
				const status = code === 0 ? "complete" : "failed";
				void patchPersistedRun(run!.id, { status, endedAt: Date.now(), exitCode: code, signal }).catch((error) => {
					console.error("[pi-subagents] Failed to persist background fork handler completion:", error);
				});
				if (resolved.notify !== "summary" && resolved.notify !== "ack-and-summary") return;
				pi.sendMessage(
					{ customType: "subagent-fork-handler", content: formatSummary(run!, status, code, signal), display: true, details: { id: run!.id, type: run!.type, status, dir: run!.dir, pid: run!.pid, exitCode: code, signal } },
					{ triggerTurn: resolved.triggerParentOnSummary },
				);
			},
		});
		if (!launch.ok) {
			const message = launch.error instanceof Error ? launch.error.message : String(launch.error);
			await patchPersistedRun(run.id, { status: "failed", endedAt: Date.now(), error: message });
			console.error("[pi-subagents] Failed to launch background fork handler:", launch.error);
			sendFallback(pi, event);
			return;
		}
		run.pid = launch.pid;
		run.status = "running";
		await patchPersistedRun(run.id, { pid: launch.pid, status: "running" });
		if (resolved.notify === "ack-and-summary") {
			pi.sendMessage(
				{ customType: "subagent-fork-handler", content: formatAck(run), display: true, details: { id: run.id, type: run.type, status: "running", dir: run.dir, pid: run.pid } },
				{ triggerTurn: false },
			);
		}
	} catch (error) {
		if (run) await patchPersistedRun(run.id, { status: "failed", endedAt: Date.now(), error: error instanceof Error ? error.message : String(error) });
		console.error("[pi-subagents] Failed to start background fork handler:", error);
		sendFallback(pi, event);
	}
}
