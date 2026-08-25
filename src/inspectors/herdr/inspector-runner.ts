import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseMissionRecord } from "../../missions/store.ts";
import type { MissionRecord } from "../../missions/types.ts";
import { requestAsyncSteer, requestAsyncStop } from "../../runs/background/control-channel.ts";
import { formatAsyncRunTranscript } from "../../runs/background/fleet-view.ts";
import { steeringReceipt } from "../../runs/background/steering.ts";
import type { AsyncStatus } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { decodeSessionRoots } from "./session-roots-codec.ts";

export interface RunnerOptions {
	asyncDir: string;
	runId: string;
	index?: number;
	missionPath?: string;
	refreshMs: number;
	allowSteer?: boolean;
	allowStop?: boolean;
	sessionRoots: string[];
}

function readMission(filePath: string | undefined): MissionRecord | undefined {
	if (!filePath) return undefined;
	try { return parseMissionRecord(JSON.parse(fs.readFileSync(filePath, "utf-8")), filePath); } catch { return undefined; }
}

export function formatInspectorDashboard(input: { status: AsyncStatus; asyncDir: string; index?: number; mission?: MissionRecord; allowSteer?: boolean; allowStop?: boolean; sessionRoots?: string[] }): string {
	const { status, asyncDir, mission } = input;
	const lines = [
		`pi-subagents inspector for ${status.runId}`,
		"This pane mirrors lifecycle artifacts; closing it does not stop the run.",
		"",
	];
	if (mission) {
		lines.push(`Mission: ${mission.title} (${mission.status})`, `Mission id: ${mission.id}`);
		const open = mission.decisions.filter((decision) => decision.status === "open");
		if (open.length) lines.push(`Open decisions: ${open.map((decision) => `${decision.id}: ${decision.title}`).join(" | ")}`);
		lines.push("");
	}
	lines.push(formatAsyncRunTranscript(status, asyncDir, { index: input.index, lines: 60, sessionRoots: input.sessionRoots }));
	const controls = [input.allowSteer === false ? undefined : "steer <message>", input.allowStop === false ? undefined : "stop", "status"].filter(Boolean);
	lines.push("", `Controls: ${controls.join(" | ")}`, "Supervisor replies remain in the parent Pi session (subagent_supervisor/intercom).");
	return lines.join("\n");
}

function parseArgs(argv: string[]): RunnerOptions {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid inspector argument '${key ?? ""}'.`);
		values.set(key, value);
	}
	const asyncDir = values.get("--async-dir");
	const runId = values.get("--run-id");
	if (!asyncDir || !runId) throw new Error("Inspector requires --async-dir and --run-id.");
	const indexRaw = values.get("--index");
	const childIndex = indexRaw === undefined ? undefined : Number(indexRaw);
	if (childIndex !== undefined && (!Number.isInteger(childIndex) || childIndex < 0)) throw new Error("--index must be a non-negative integer.");
	const sessionRootsRaw = values.get("--session-roots");
	const sessionRoots = sessionRootsRaw === undefined ? [] : decodeSessionRoots(sessionRootsRaw);
	const refreshRaw = values.get("--refresh-ms");
	const refreshMs = refreshRaw === undefined ? 1_500 : Number(refreshRaw);
	if (!Number.isInteger(refreshMs) || refreshMs < 250) throw new Error("--refresh-ms must be an integer >= 250.");
	return {
		asyncDir: path.resolve(asyncDir),
		runId,
		...(childIndex !== undefined ? { index: childIndex } : {}),
		...(values.get("--mission-path") ? { missionPath: path.resolve(values.get("--mission-path")!) } : {}),
		sessionRoots,
		refreshMs,
		allowSteer: values.get("--allow-steer") !== "false",
		allowStop: values.get("--allow-stop") !== "false",
	};
}

function isTerminal(status: AsyncStatus): boolean {
	return status.state !== "queued" && status.state !== "running";
}

export function submitInspectorControl(options: RunnerOptions, line: string): string {
	const command = line.trim();
	if (!command || command === "status") return "Status refreshed.";
	const status = readStatus(options.asyncDir);
	if (!status || status.runId !== options.runId) throw new Error(`Lifecycle status for run '${options.runId}' is unavailable.`);
	if (command === "stop") {
		if (options.allowStop === false) throw new Error("Authority policy does not allow stop from this inspector.");
		if (isTerminal(status)) throw new Error(`Run '${options.runId}' is ${status.state} and cannot be stopped.`);
		requestAsyncStop(options.asyncDir, { source: "herdr-inspector" });
		return `Stop requested for run ${options.runId}.`;
	}
	if (command.startsWith("steer ")) {
		if (options.allowSteer === false) throw new Error("Authority policy does not allow steer from this inspector.");
		const message = command.slice("steer ".length).trim();
		if (!message) throw new Error("steer requires a message.");
		if (isTerminal(status)) throw new Error(`Run '${options.runId}' is ${status.state} and cannot be steered.`);
		const runningIndexes = (status.steps ?? []).map((step, index) => step.status === "running" ? index : undefined).filter((index): index is number => index !== undefined);
		const targetIndex = options.index ?? (status.mode === "single" ? 0 : undefined);
		if (targetIndex === undefined && runningIndexes.length === 0) throw new Error("No running child is available to steer. Open a child-specific inspector for a pending child.");
		requestAsyncSteer(options.asyncDir, {
			message,
			...(targetIndex !== undefined ? { targetIndex } : { targetIndexes: runningIndexes }),
			source: "herdr-inspector",
		});
		return steeringReceipt(message, `Steering queued for run ${options.runId}.`);
	}
	if (command.startsWith("reply ")) throw new Error("Supervisor replies are owned by the parent Pi session; use subagent_supervisor/intercom there.");
	throw new Error("Unknown control. Use steer <message>, stop, or status.");
}

export function runInspector(argv = process.argv.slice(2)): void {
	const options = parseArgs(argv);
	let notice = "";
	let timer: ReturnType<typeof setInterval> | undefined;
	const render = () => {
		const status = readStatus(options.asyncDir);
		if (!status || status.runId !== options.runId) {
			process.stdout.write(`\x1b[2J\x1b[Hpi-subagents inspector\n\nLifecycle status for ${options.runId} is unavailable.\n`);
			return;
		}
		process.stdout.write(`\x1b[2J\x1b[H${formatInspectorDashboard({ status, asyncDir: options.asyncDir, index: options.index, mission: readMission(options.missionPath), allowSteer: options.allowSteer, allowStop: options.allowStop, sessionRoots: options.sessionRoots })}${notice ? `\n\n${notice}` : ""}\n> `);
		if (isTerminal(status) && timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
	rl.on("line", (line) => {
		try { notice = submitInspectorControl(options, line); } catch (cause) { notice = `Control error: ${cause instanceof Error ? cause.message : String(cause)}`; }
		render();
	});
	render();
	if (!isTerminal(readStatus(options.asyncDir) ?? { state: "failed" } as AsyncStatus)) {
		timer = setInterval(render, options.refreshMs);
		timer.unref?.();
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	try { runInspector(); } catch (cause) {
		process.stderr.write(`Herdr inspector failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
		process.exitCode = 1;
	}
}
