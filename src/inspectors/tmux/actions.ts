import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type { Details } from "../../shared/types.ts";
import type { InspectorContext, InspectorLaunch, InspectorTarget } from "../types.ts";
import type { TmuxClient, TmuxErrorCode } from "./client.ts";

export interface TmuxInspectorBinding {
	schemaVersion: 1;
	kind: "tmux-inspector";
	runId: string;
	asyncDir: string;
	childIndex?: number;
	paneId: string;
	serverPid?: string;
	openedAt: string;
	tmuxVersion?: string;
	missionId?: string;
	missionPath?: string;
	command: string;
}

export function bindingPath(asyncDir: string, index?: number): string {
	return path.join(asyncDir, "inspectors", `tmux${index === undefined ? "" : `-${index}`}.json`);
}

function parse(value: unknown): TmuxInspectorBinding | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const binding = value as Partial<TmuxInspectorBinding>;
	if (binding.schemaVersion !== 1
		|| binding.kind !== "tmux-inspector"
		|| (binding.childIndex !== undefined && (!Number.isInteger(binding.childIndex) || binding.childIndex < 0))
		|| typeof binding.runId !== "string"
		|| typeof binding.asyncDir !== "string"
		|| typeof binding.paneId !== "string"
		|| (binding.serverPid !== undefined && typeof binding.serverPid !== "string")
		|| typeof binding.openedAt !== "string"
		|| typeof binding.command !== "string") return undefined;
	return binding as TmuxInspectorBinding;
}

export function readTmuxInspectorBinding(asyncDir: string, index?: number): TmuxInspectorBinding | undefined {
	try {
		return parse(JSON.parse(fs.readFileSync(bindingPath(asyncDir, index), "utf8")));
	} catch {
		return undefined;
	}
}

/** Read a binding only when it belongs to the requested inspector target. */
export function readTmuxInspectorBindingForTarget(target: InspectorTarget): TmuxInspectorBinding | undefined {
	const binding = readTmuxInspectorBinding(target.asyncDir, target.index);
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

function errorText(input: { code: TmuxErrorCode; message: string }): string {
	return `tmux inspector error (${input.code}): ${input.message}`;
}

/** Pane option carrying this run's ownership marker; a pane without it is never ours to kill. */
const OWNER_OPTION = "@pi-subagents-inspector";

function ownerTag(runId: string, index?: number): string {
	return `pi-subagents:${runId}:${index ?? "-"}`;
}

type PaneProbe =
	| { state: "alive" }
	| { state: "gone" }
	| { state: "stale" }
	| { state: "error"; error: { code: TmuxErrorCode; message: string } };

/** Verify the pane is alive AND ours: list-panes fails on a gone pane, while display-message silently returns empty on tmux 3.3+; the marker survives pane-id reuse after a server restart. */
async function probePane(client: TmuxClient, binding: TmuxInspectorBinding, signal?: AbortSignal): Promise<PaneProbe> {
	const probe = await client.run(["list-panes", "-t", binding.paneId, "-F", `#{pane_id}|#{${OWNER_OPTION}}|#{pid}`], { timeoutMs: 5_000, signal });
	if (!probe.ok) return probe.error.code === "PANE_GONE" ? { state: "gone" } : { state: "error", error: probe.error };
	// A pane target resolves to its window, so list-panes reports every pane in it; read the target's line.
	const line = probe.data.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith(`${binding.paneId}|`));
	if (!line) return { state: "gone" };
	const [tag, serverPid] = line.split("|").slice(1);
	if (tag !== ownerTag(binding.runId, binding.childIndex)) return { state: "stale" };
	if (binding.serverPid !== undefined && binding.serverPid !== serverPid) return { state: "stale" };
	return { state: "alive" };
}

export async function openTmuxInspector(
	context: InspectorContext,
	launch: InspectorLaunch,
	focus: boolean,
	client: TmuxClient,
): Promise<AgentToolResult<Details>> {
	const detected = await client.run(["-V"], { timeoutMs: 3_000, signal: context.signal });
	if (!detected.ok) return result(errorText(detected.error), true);
	const existing = readTmuxInspectorBindingForTarget(context.target);
	if (existing) {
		const probe = await probePane(client, existing, context.signal);
		if (probe.state === "alive") {
			if (focus) {
				const refocus = await client.run(["select-pane", "-t", existing.paneId], { timeoutMs: 5_000, signal: context.signal });
				if (!refocus.ok) return result(errorText(refocus.error), true);
			}
			return result(`tmux inspector pane ${existing.paneId} is already open for async run ${context.target.runId}. Ctrl-C inside the pane closes it.`);
		}
		// A gone or stale binding falls through to a fresh split; other failures must not open a duplicate.
		if (probe.state === "error") return result(errorText(probe.error), true);
	}
	// The split activates the new pane; when focus is not requested, remember the
	// active pane so it can be re-selected after the split.
	const originalPane = focus ? undefined : await client.run(["display-message", "-p", "#{pane_id}"], { timeoutMs: 5_000, signal: context.signal });
	const split = await client.run([
		"split-window", "-h", "-P", "-F", "#{pane_id}",
		"-c", context.target.status.cwd ?? context.cwd,
		launch.displayCommand,
	], { timeoutMs: 15_000, signal: context.signal });
	if (!split.ok) return result(errorText(split.error), true);
	const id = split.data;
	if (!id.startsWith("%")) return result(errorText({ code: "TMUX_ERROR", message: `split-window returned no pane id ('${id}').` }), true);
	if (context.signal?.aborted) {
		await client.run(["kill-pane", "-t", id], { timeoutMs: 5_000 });
		return result(errorText({ code: "TIMEOUT", message: `tmux inspector open was aborted.` }), true);
	}
	if (originalPane?.ok && originalPane.data) {
		await client.run(["select-pane", "-t", originalPane.data], { timeoutMs: 5_000, signal: context.signal });
	}
	// Stamp and cleanup run without the signal: aborting mid-stamp must not orphan an unstamped pane.
	const stamp = await client.run(["set-option", "-p", "-t", id, OWNER_OPTION, ownerTag(context.target.runId, context.target.index)], { timeoutMs: 5_000 });
	if (!stamp.ok) {
		await client.run(["kill-pane", "-t", id], { timeoutMs: 5_000 });
		return result(errorText(stamp.error), true);
	}
	const server = await client.run(["display-message", "-p", "#{pid}"], { timeoutMs: 5_000 });
	const binding: TmuxInspectorBinding = {
		schemaVersion: 1,
		kind: "tmux-inspector",
		runId: context.target.runId,
		asyncDir: context.target.asyncDir,
		...(context.target.index === undefined ? {} : { childIndex: context.target.index }),
		paneId: id,
		...(server.ok ? { serverPid: server.data } : {}),
		openedAt: (context.now?.() ?? new Date()).toISOString(),
		tmuxVersion: detected.data,
		...(launch.mission ? { missionId: launch.mission.id, missionPath: launch.mission.path } : {}),
		command: launch.displayCommand,
	};
	try {
		writeAtomicJson(bindingPath(context.target.asyncDir, context.target.index), binding);
	} catch (error) {
		// Without a binding, status and close cannot find the pane, so remove it before reporting the failure.
		await client.run(["kill-pane", "-t", id], { timeoutMs: 5_000 });
		throw error;
	}
	return result(`Opened read-only tmux inspector pane ${id} for async run ${context.target.runId}. Closing the pane does not stop the run.\nControls inside the pane: steer <message>, stop, status. Ctrl-C closes the pane.`);
}

export async function statusTmuxInspector(context: InspectorContext, client: TmuxClient): Promise<AgentToolResult<Details>> {
	const binding = readTmuxInspectorBindingForTarget(context.target);
	if (!binding) {
		return result(`No tmux inspector binding exists for async run ${context.target.runId}${context.target.index === undefined ? "" : ` child ${context.target.index}`}.`);
	}
	const label = context.target.index === undefined ? "" : ` child ${context.target.index}`;
	const probe = await probePane(client, binding, context.signal);
	if (probe.state === "error") return result(errorText(probe.error), true);
	if (probe.state === "stale") {
		return result(`tmux inspector pane ${binding.paneId} (run ${context.target.runId}${label}) is alive but does not carry this run's inspector marker; it may belong to other work after a tmux server restart.\nBinding: ${bindingPath(context.target.asyncDir, context.target.index)}\nRun state remains authoritative: ${context.target.status.state}.`);
	}
	if (probe.state === "gone") {
		return result(`tmux inspector pane ${binding.paneId} (run ${context.target.runId}${label}) no longer exists.\nBinding: ${bindingPath(context.target.asyncDir, context.target.index)}\nRun state remains authoritative: ${context.target.status.state}.`);
	}
	return result(`tmux inspector pane ${binding.paneId} is open for async run ${context.target.runId}${label}.\nRun state: ${context.target.status.state}\nBinding: ${bindingPath(context.target.asyncDir, context.target.index)}`);
}

export async function closeTmuxInspector(context: InspectorContext, client: TmuxClient): Promise<AgentToolResult<Details>> {
	const binding = readTmuxInspectorBindingForTarget(context.target);
	if (!binding) return result(`No tmux inspector binding exists for async run ${context.target.runId}.`);
	const probe = await probePane(client, binding, context.signal);
	if (probe.state === "error") return result(errorText(probe.error), true);
	if (probe.state === "stale") {
		fs.rmSync(bindingPath(context.target.asyncDir, context.target.index), { force: true });
		return result(`tmux inspector pane ${binding.paneId} does not carry this run's inspector marker; removed the stale binding without killing the pane.`);
	}
	if (probe.state === "alive") {
		const closed = await client.run(["kill-pane", "-t", binding.paneId], { timeoutMs: 10_000, signal: context.signal });
		if (!closed.ok && closed.error.code !== "PANE_GONE") {
			return result(errorText(closed.error), true);
		}
	}
	fs.rmSync(bindingPath(context.target.asyncDir, context.target.index), { force: true });
	return result(`Closed tmux inspector pane ${binding.paneId} for async run ${context.target.runId}. The subagent run was not stopped.`);
}
