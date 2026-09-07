import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type { Details } from "../../shared/types.ts";
import type { InspectorContext, InspectorLaunch, InspectorParams, InspectorTarget } from "../types.ts";
import { detectHerdr, type HerdrClient, type HerdrErrorCode, type HerdrResult } from "./client.ts";

export interface HerdrInspectorBinding {
	schemaVersion: 1;
	kind: "herdr-inspector";
	runId: string;
	asyncDir: string;
	childIndex?: number;
	missionId?: string;
	missionPath?: string;
	paneId: string;
	openedAt: string;
	lastFocusedAt?: string;
	herdrVersion?: string;
	command: string;
}

export function bindingPath(asyncDir: string, index?: number): string {
	return path.join(asyncDir, "inspectors", `herdr${index === undefined ? "" : `-${index}`}.json`);
}

function parse(value: unknown): HerdrInspectorBinding | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const binding = value as Partial<HerdrInspectorBinding>;
	if (binding.schemaVersion !== 1
		|| binding.kind !== "herdr-inspector"
		|| (binding.childIndex !== undefined && (!Number.isInteger(binding.childIndex) || binding.childIndex < 0))
		|| typeof binding.runId !== "string"
		|| typeof binding.asyncDir !== "string"
		|| typeof binding.paneId !== "string"
		|| typeof binding.openedAt !== "string"
		|| typeof binding.command !== "string") return undefined;
	return binding as HerdrInspectorBinding;
}

export function readHerdrInspectorBinding(asyncDir: string, index?: number): HerdrInspectorBinding | undefined {
	try {
		return parse(JSON.parse(fs.readFileSync(bindingPath(asyncDir, index), "utf8")));
	} catch {
		return undefined;
	}
}

/** Read a binding only when it belongs to the requested inspector target. */
export function readHerdrInspectorBindingForTarget(target: InspectorTarget): HerdrInspectorBinding | undefined {
	const binding = readHerdrInspectorBinding(target.asyncDir, target.index);
	if (!binding || binding.runId !== target.runId || binding.childIndex !== target.index) return undefined;
	try {
		if (fs.realpathSync(binding.asyncDir) !== fs.realpathSync(target.asyncDir)) return undefined;
	} catch {
		return undefined;
	}
	return binding;
}

function result(text: string, isError = false): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [] },
	};
}

function errorText(input: { code: HerdrErrorCode; message: string }): string {
	return `Herdr inspector error (${input.code}): ${input.message}`;
}

function paneId(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const pane = record.pane && typeof record.pane === "object" ? record.pane as Record<string, unknown> : record;
	for (const key of ["pane_id", "paneId", "id"]) {
		if (typeof pane[key] === "string") return pane[key];
	}
	return undefined;
}

async function pane(client: HerdrClient, id: string, signal?: AbortSignal): Promise<HerdrResult<unknown>> {
	return client.run(["pane", "get", id], { timeoutMs: 5_000, signal });
}

export async function openHerdrInspector(
	context: InspectorContext,
	launch: InspectorLaunch,
	params: InspectorParams,
	client: HerdrClient,
): Promise<AgentToolResult<Details>> {
	const detected = await detectHerdr(client, context.signal);
	if (!detected.ok) return result(errorText(detected.error), true);
	const existing = readHerdrInspectorBindingForTarget(context.target);
	if (existing) {
		const current = await pane(client, existing.paneId, context.signal);
		if (current.ok && paneId(current.data) === existing.paneId) {
			return result(`Herdr inspector pane ${existing.paneId} is already open for async run ${context.target.runId}.${params.focus ? " Herdr cannot refocus an arbitrary raw pane id; select it in the Herdr UI." : ""}`);
		}
	}
	const split = await client.run([
		"pane", "split", "--current", "--direction", "right",
		"--cwd", context.target.status.cwd ?? context.cwd,
		params.focus === true ? "--focus" : "--no-focus",
	], { timeoutMs: 15_000, signal: context.signal });
	if (!split.ok) return result(errorText(split.error), true);
	const id = paneId(split.data);
	if (!id) return result("Herdr inspector error (PANE_GONE): pane split returned no pane id.", true);
	const started = await client.run(["pane", "run", id, launch.displayCommand], { timeoutMs: 15_000, signal: context.signal });
	if (!started.ok) {
		await client.run(["pane", "close", id], { timeoutMs: 5_000 });
		return result(errorText(started.error), true);
	}
	const now = (context.now?.() ?? new Date()).toISOString();
	const binding: HerdrInspectorBinding = {
		schemaVersion: 1,
		kind: "herdr-inspector",
		runId: context.target.runId,
		asyncDir: context.target.asyncDir,
		...(context.target.index === undefined ? {} : { childIndex: context.target.index }),
		...(launch.mission ? { missionId: launch.mission.id, missionPath: launch.mission.path } : {}),
		paneId: id,
		openedAt: now,
		...(params.focus === true ? { lastFocusedAt: now } : {}),
		herdrVersion: detected.data.versionText,
		command: launch.displayCommand,
	};
	writeAtomicJson(bindingPath(context.target.asyncDir, context.target.index), binding);
	return result(`Opened read-only Herdr inspector pane ${id} for async run ${context.target.runId}. Closing the pane does not stop the run.\nControls inside the pane: steer <message>, stop, status.`);
}

export async function statusHerdrInspector(context: InspectorContext, client: HerdrClient): Promise<AgentToolResult<Details>> {
	const binding = readHerdrInspectorBindingForTarget(context.target);
	if (!binding) {
		return result(`No Herdr inspector binding exists for async run ${context.target.runId}${context.target.index === undefined ? "" : ` child ${context.target.index}`}.`);
	}
	const live = await pane(client, binding.paneId, context.signal);
	if (!live.ok) {
		return result(`${errorText(live.error)}\nBinding: ${bindingPath(context.target.asyncDir, context.target.index)}\nRun state remains authoritative: ${context.target.status.state}.`, true);
	}
	return result(`Herdr inspector ${binding.paneId} is open for async run ${context.target.runId}.\nRun state: ${context.target.status.state}\nBinding: ${bindingPath(context.target.asyncDir, context.target.index)}`);
}

export async function closeHerdrInspector(context: InspectorContext, client: HerdrClient): Promise<AgentToolResult<Details>> {
	const binding = readHerdrInspectorBindingForTarget(context.target);
	if (!binding) return result(`No Herdr inspector binding exists for async run ${context.target.runId}.`);
	const closed = await client.run(["pane", "close", binding.paneId], { timeoutMs: 10_000, signal: context.signal });
	if (!closed.ok && closed.error.code !== "NOT_FOUND" && closed.error.code !== "PANE_GONE") {
		return result(errorText(closed.error), true);
	}
	fs.rmSync(bindingPath(context.target.asyncDir, context.target.index), { force: true });
	return result(`Closed Herdr inspector pane ${binding.paneId} for async run ${context.target.runId}. The subagent run was not stopped.`);
}
