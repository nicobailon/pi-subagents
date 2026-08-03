import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getPiSpawnCommand } from "../../runs/shared/pi-spawn.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type { Details } from "../../shared/types.ts";
import { createHerdrClient, detectHerdr, type HerdrClient, type HerdrErrorCode, type HerdrResult } from "./client.ts";

export const HERDR_PROJECT_PANE_ACTIONS = ["project.open", "project.status", "project.close"] as const;
export type HerdrProjectPaneAction = typeof HERDR_PROJECT_PANE_ACTIONS[number];

export interface HerdrProjectPaneBinding {
	schemaVersion: 1;
	kind: "herdr-project-pane";
	projectRoot: string;
	paneId: string;
	openedAt: string;
	lastFocusedAt?: string;
	herdrVersion?: string;
	command: string;
	startupMessage?: string;
}

interface ProjectPaneParams {
	cwd?: string;
	message?: string;
	focus?: boolean;
}

interface ProjectPaneDeps {
	cwd: string;
	client?: HerdrClient;
	signal?: AbortSignal;
	now?: () => Date;
}

function result(text: string, isError = false): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}), details: { mode: "management", results: [] } };
}

function formatHerdrError(input: { code: HerdrErrorCode; message: string }): string {
	return `Herdr project pane error (${input.code}): ${input.message}`;
}

function projectPaneDir(projectRoot: string): string {
	return path.join(projectRoot, ".pi-subagents", "project-panes");
}

function bindingPath(projectRoot: string): string {
	return path.join(projectPaneDir(projectRoot), "herdr.json");
}

function parseBinding(value: unknown): HerdrProjectPaneBinding | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Partial<HerdrProjectPaneBinding>;
	if (input.schemaVersion !== 1 || input.kind !== "herdr-project-pane") return undefined;
	if (typeof input.projectRoot !== "string" || typeof input.paneId !== "string" || typeof input.openedAt !== "string" || typeof input.command !== "string") return undefined;
	return input as HerdrProjectPaneBinding;
}

export function readHerdrProjectPaneBinding(projectRoot: string): HerdrProjectPaneBinding | undefined {
	try { return parseBinding(JSON.parse(fs.readFileSync(bindingPath(projectRoot), "utf-8"))); } catch { return undefined; }
}

function extractPaneId(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const pane = record.pane && typeof record.pane === "object" && !Array.isArray(record.pane) ? record.pane as Record<string, unknown> : record;
	for (const key of ["pane_id", "paneId", "id"]) if (typeof pane[key] === "string") return pane[key];
	return undefined;
}

function shellQuote(value: string): string {
	if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveProjectRoot(params: ProjectPaneParams, deps: ProjectPaneDeps): string | { error: string } {
	const requested = params.cwd?.trim() || deps.cwd;
	const resolved = path.resolve(requested);
	try {
		const stat = fs.statSync(resolved);
		if (!stat.isDirectory()) return { error: `Project pane target '${resolved}' is not a directory.` };
		return fs.realpathSync(resolved);
	} catch (cause) {
		return { error: `Project pane target '${resolved}' is unavailable: ${cause instanceof Error ? cause.message : String(cause)}` };
	}
}

async function paneExists(client: HerdrClient, paneId: string, signal?: AbortSignal): Promise<HerdrResult<unknown>> {
	return client.run(["pane", "get", paneId], { timeoutMs: 5_000, signal });
}

function projectPaneCommand(message: string | undefined): string {
	const args = message?.trim() ? [message.trim()] : [];
	const command = getPiSpawnCommand(args);
	return [command.command, ...command.args].map(shellQuote).join(" ");
}

export async function handleHerdrProjectPaneAction(action: HerdrProjectPaneAction, params: ProjectPaneParams, deps: ProjectPaneDeps): Promise<AgentToolResult<Details>> {
	const projectRoot = resolveProjectRoot(params, deps);
	if (typeof projectRoot !== "string") return result(projectRoot.error, true);
	const client = deps.client ?? createHerdrClient();
	const existing = readHerdrProjectPaneBinding(projectRoot);

	if (action === "project.status") {
		if (!existing) return result(`No Herdr project pane binding exists for ${projectRoot}.`);
		const live = await paneExists(client, existing.paneId, deps.signal);
		if (live.ok === false) return result(`${formatHerdrError(live.error)}\nBinding: ${bindingPath(projectRoot)}`, true);
		return result(`Herdr project pane ${existing.paneId} is open for ${projectRoot}.\nBinding: ${bindingPath(projectRoot)}`);
	}

	if (action === "project.close") {
		if (!existing) return result(`No Herdr project pane binding exists for ${projectRoot}.`);
		const closed = await client.run(["pane", "close", existing.paneId], { timeoutMs: 10_000, signal: deps.signal });
		if (closed.ok === false && closed.error.code !== "NOT_FOUND" && closed.error.code !== "PANE_GONE") return result(formatHerdrError(closed.error), true);
		fs.rmSync(bindingPath(projectRoot), { force: true });
		return result(`Closed Herdr project pane ${existing.paneId} for ${projectRoot}.`);
	}

	const detected = await detectHerdr(client, deps.signal);
	if (detected.ok === false) return result(formatHerdrError(detected.error), true);
	if (existing) {
		const live = await paneExists(client, existing.paneId, deps.signal);
		if (live.ok) return result(`Herdr project pane ${existing.paneId} is already open for ${projectRoot}.${params.focus ? " Herdr cannot refocus an arbitrary raw pane id; select it in the Herdr UI." : ""}`);
	}
	const splitArgs = ["pane", "split", "--current", "--direction", "right", "--cwd", projectRoot];
	if (params.focus !== false) splitArgs.push("--focus");
	const split = await client.run(splitArgs, { timeoutMs: 15_000, signal: deps.signal });
	if (split.ok === false) return result(formatHerdrError(split.error), true);
	const paneId = extractPaneId(split.data);
	if (!paneId) return result("Herdr project pane error (PANE_GONE): pane split returned no pane id.", true);
	const startupMessage = params.message?.trim();
	const command = projectPaneCommand(startupMessage);
	const started = await client.run(["pane", "run", paneId, command], { timeoutMs: 15_000, signal: deps.signal });
	if (started.ok === false) {
		await client.run(["pane", "close", paneId], { timeoutMs: 5_000 });
		return result(formatHerdrError(started.error), true);
	}
	const now = (deps.now?.() ?? new Date()).toISOString();
	const binding: HerdrProjectPaneBinding = {
		schemaVersion: 1,
		kind: "herdr-project-pane",
		projectRoot,
		paneId,
		openedAt: now,
		...(params.focus !== false ? { lastFocusedAt: now } : {}),
		herdrVersion: detected.data.versionText,
		command,
		...(startupMessage ? { startupMessage } : {}),
	};
	writeAtomicJson(bindingPath(projectRoot), binding);
	return result(`Opened Herdr project pane ${paneId} for ${projectRoot}. The pane runs its own Pi session; subagents launched there belong to that project.`);
}
