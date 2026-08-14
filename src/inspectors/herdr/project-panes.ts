import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getPiSpawnCommand } from "../../runs/shared/pi-spawn.ts";
import { getProjectSubagentsDir } from "../../shared/artifacts.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type { Details } from "../../shared/types.ts";
import { createHerdrClient, detectHerdr, type HerdrClient, type HerdrErrorCode } from "./client.ts";
import { formatShellCommand } from "./shell-command.ts";

export const HERDR_PROJECT_PANE_ACTIONS = ["project.open", "project.status", "project.close"] as const;
export type HerdrProjectPaneAction = typeof HERDR_PROJECT_PANE_ACTIONS[number];

/** Versioned public contract exported through `pi-subagents/project-panes`. */
export const PROJECT_PANES_API_VERSION = 1 as const;
export const PROJECT_PANE_TRUST_STATUS = "human-verification-required" as const;

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

export interface ProjectPaneRuntime {
	paneId: string;
	agent?: string;
	agentStatus: string;
	cwd?: string;
	foregroundCwd?: string;
	focused?: boolean;
	terminalTitle?: string;
}

export type ProjectPaneErrorCode = HerdrErrorCode
	| "INVALID_PROJECT_ROOT"
	| "INVALID_PANE_RESPONSE"
	| "INVALID_BINDING"
	| "BINDING_READ_FAILED"
	| "BINDING_WRITE_FAILED"
	| "BINDING_REMOVE_FAILED"
	| "PANE_NOT_IDLE"
	| "PANE_OWNERSHIP_UNVERIFIED";

export interface ProjectPaneError {
	code: ProjectPaneErrorCode;
	message: string;
	projectRoot?: string;
	bindingPath?: string;
	details?: unknown;
}

export type ProjectPaneResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: ProjectPaneError };

interface ProjectPaneCommonData {
	apiVersion: typeof PROJECT_PANES_API_VERSION;
	projectRoot: string;
	bindingPath: string;
	trust: typeof PROJECT_PANE_TRUST_STATUS;
}

export interface OpenProjectPaneData extends ProjectPaneCommonData {
	disposition: "opened" | "already-open";
	binding: HerdrProjectPaneBinding;
	runtime?: ProjectPaneRuntime;
}

export interface ProjectPaneStatusData extends ProjectPaneCommonData {
	state: "absent" | "open" | "stale";
	binding?: HerdrProjectPaneBinding;
	runtime?: ProjectPaneRuntime;
	ownership: "verified" | "unknown" | "mismatch";
	safeToClose: boolean;
	staleReason?: { code: HerdrErrorCode; message: string };
}

export interface CloseProjectPaneData extends ProjectPaneCommonData {
	disposition: "closed" | "absent" | "stale-binding-removed";
	binding?: HerdrProjectPaneBinding;
	runtime?: ProjectPaneRuntime;
}

export interface OpenProjectPaneOptions {
	cwd: string;
	message?: string;
	focus?: boolean;
	signal?: AbortSignal;
}

export interface GetProjectPaneStatusOptions {
	cwd: string;
	signal?: AbortSignal;
}

export interface CloseProjectPaneOptions {
	cwd: string;
	/** Fail closed unless Herdr explicitly reports the owning Pi pane as idle. */
	requireIdle?: boolean;
	signal?: AbortSignal;
}

export interface ProjectPaneCommandClient {
	run<T = unknown>(
		args: string[],
		options?: { timeoutMs?: number; signal?: AbortSignal; textOk?: boolean },
	): Promise<{ ok: true; data: T } | { ok: false; error: { code: HerdrErrorCode; message: string; details?: unknown } }>;
}

export interface ProjectPaneManagerOptions {
	client?: ProjectPaneCommandClient;
	now?: () => Date;
}

export interface ProjectPaneManager {
	open(options: OpenProjectPaneOptions): Promise<ProjectPaneResult<OpenProjectPaneData>>;
	status(options: GetProjectPaneStatusOptions): Promise<ProjectPaneResult<ProjectPaneStatusData>>;
	close(options: CloseProjectPaneOptions): Promise<ProjectPaneResult<CloseProjectPaneData>>;
}

interface InternalProjectPaneManagerOptions extends ProjectPaneManagerOptions {
	/** Preserve the historical model-facing action behavior without weakening the public API defaults. */
	legacyToolCompatibility?: boolean;
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

function toolResult(text: string, isError = false): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}), details: { mode: "management", results: [] } };
}

function projectPaneError<T>(code: ProjectPaneErrorCode, message: string, fields: Omit<ProjectPaneError, "code" | "message"> = {}): ProjectPaneResult<T> {
	return { ok: false, error: { code, message, ...fields } };
}

function formatProjectPaneError(input: { code: ProjectPaneErrorCode; message: string }): string {
	return `Herdr project pane error (${input.code}): ${input.message}`;
}

function projectPaneDir(projectRoot: string): string {
	return path.join(getProjectSubagentsDir(projectRoot), "project-panes");
}

export function projectPaneBindingPath(projectRoot: string): string {
	return path.join(projectPaneDir(projectRoot), "herdr.json");
}

function parseBinding(value: unknown, strict = false): HerdrProjectPaneBinding | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Partial<HerdrProjectPaneBinding>;
	if (input.schemaVersion !== 1 || input.kind !== "herdr-project-pane") return undefined;
	if (typeof input.projectRoot !== "string" || typeof input.paneId !== "string" || typeof input.openedAt !== "string" || typeof input.command !== "string") return undefined;
	if (strict) {
		if (![input.projectRoot, input.paneId, input.openedAt, input.command].every((field) => field.trim().length > 0)) return undefined;
		for (const field of ["lastFocusedAt", "herdrVersion", "startupMessage"] as const) {
			if (input[field] !== undefined && typeof input[field] !== "string") return undefined;
		}
	}
	return input as HerdrProjectPaneBinding;
}

type BindingReadResult =
	| { state: "absent" }
	| { state: "invalid" }
	| { state: "read-error"; cause: unknown }
	| { state: "valid"; binding: HerdrProjectPaneBinding };

function readBinding(projectRoot: string, strict: boolean): BindingReadResult {
	const file = projectPaneBindingPath(projectRoot);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch (cause) {
		const code = (cause as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { state: "absent" };
		return { state: "read-error", cause };
	}
	try {
		const binding = parseBinding(JSON.parse(raw), strict);
		return binding ? { state: "valid", binding } : { state: "invalid" };
	} catch {
		return { state: "invalid" };
	}
}

/** Legacy model-facing reader; preserves the original required-field-only parsing contract. */
export function readHerdrProjectPaneBinding(projectRoot: string): HerdrProjectPaneBinding | undefined {
	const read = readBinding(projectRoot, false);
	return read.state === "valid" ? read.binding : undefined;
}

/** Strict public reader for extension integrations. */
export function readProjectPaneBinding(projectRoot: string): ProjectPaneResult<HerdrProjectPaneBinding | undefined> {
	const read = readBinding(projectRoot, true);
	if (read.state === "absent") return { ok: true, data: undefined };
	if (read.state === "read-error") {
		const bindingPath = projectPaneBindingPath(projectRoot);
		return projectPaneError("BINDING_READ_FAILED", `Failed to read project pane binding '${bindingPath}': ${read.cause instanceof Error ? read.cause.message : String(read.cause)}`, {
			projectRoot, bindingPath, details: fileSystemErrorDetails(read.cause),
		});
	}
	if (read.state === "invalid") {
		return projectPaneError("INVALID_BINDING", `Project pane binding '${projectPaneBindingPath(projectRoot)}' is malformed.`, {
			projectRoot, bindingPath: projectPaneBindingPath(projectRoot),
		});
	}
	return { ok: true, data: read.binding };
}

function paneRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	return record.pane && typeof record.pane === "object" && !Array.isArray(record.pane)
		? record.pane as Record<string, unknown>
		: record;
}

function extractPaneId(value: unknown): string | undefined {
	const pane = paneRecord(value);
	if (!pane) return undefined;
	for (const key of ["pane_id", "paneId", "id"]) if (typeof pane[key] === "string") return pane[key];
	return undefined;
}

function projectPaneRuntime(value: unknown): ProjectPaneRuntime | undefined {
	const pane = paneRecord(value);
	const paneId = extractPaneId(value);
	if (!pane || !paneId) return undefined;
	const text = (key: string): string | undefined => typeof pane[key] === "string" ? pane[key] as string : undefined;
	const agentStatus = text("agent_status") ?? text("agentStatus") ?? "unknown";
	return {
		paneId,
		...(text("agent") ? { agent: text("agent") } : {}),
		agentStatus: agentStatus.toLowerCase(),
		...(text("cwd") ? { cwd: text("cwd") } : {}),
		...(text("foreground_cwd") || text("foregroundCwd") ? { foregroundCwd: text("foreground_cwd") ?? text("foregroundCwd") } : {}),
		...(typeof pane.focused === "boolean" ? { focused: pane.focused } : {}),
		...(text("terminal_title_stripped") || text("terminal_title") || text("terminalTitle")
			? { terminalTitle: text("terminal_title_stripped") ?? text("terminal_title") ?? text("terminalTitle") }
			: {}),
	};
}

function resolveProjectRoot(requested: string): ProjectPaneResult<string> {
	const resolved = path.resolve(requested);
	try {
		const stat = fs.statSync(resolved);
		if (!stat.isDirectory()) return projectPaneError("INVALID_PROJECT_ROOT", `Project pane target '${resolved}' is not a directory.`, { projectRoot: resolved });
		return { ok: true, data: fs.realpathSync(resolved) };
	} catch (cause) {
		return projectPaneError("INVALID_PROJECT_ROOT", `Project pane target '${resolved}' is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, { projectRoot: resolved });
	}
}

async function inspectPane(client: HerdrClient, paneId: string, signal?: AbortSignal): Promise<ProjectPaneResult<ProjectPaneRuntime>> {
	const live = await client.run(["pane", "get", paneId], { timeoutMs: 5_000, signal });
	if (live.ok === false) return projectPaneError(live.error.code, live.error.message, { details: live.error.details });
	const runtime = projectPaneRuntime(live.data);
	if (!runtime) return projectPaneError("INVALID_PANE_RESPONSE", `Herdr pane get returned no pane runtime for '${paneId}'.`, { details: live.data });
	return { ok: true, data: runtime };
}

function projectPaneCommand(message: string | undefined): string {
	const args = message?.trim() ? [message.trim()] : [];
	const command = getPiSpawnCommand(args);
	return formatShellCommand(command.command, command.args);
}

function canonicalRuntimePath(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try { return fs.realpathSync(path.resolve(value)); } catch { return path.resolve(value); }
}

function projectPaneOwnership(runtime: ProjectPaneRuntime, binding: HerdrProjectPaneBinding, projectRoot: string): "verified" | "unknown" | "mismatch" {
	if (runtime.paneId !== binding.paneId) return "mismatch";
	const runtimeRoot = canonicalRuntimePath(runtime.cwd);
	if (!runtimeRoot) return "unknown";
	return runtimeRoot === projectRoot ? "verified" : "mismatch";
}

function bindingForManager(projectRoot: string, legacyToolCompatibility: boolean | undefined): ProjectPaneResult<HerdrProjectPaneBinding | undefined> {
	const read = readBinding(projectRoot, !legacyToolCompatibility);
	if (read.state === "absent") return { ok: true, data: undefined };
	if (read.state === "read-error") {
		if (legacyToolCompatibility) return { ok: true, data: undefined };
		const bindingPath = projectPaneBindingPath(projectRoot);
		return projectPaneError("BINDING_READ_FAILED", `Failed to read project pane binding '${bindingPath}': ${read.cause instanceof Error ? read.cause.message : String(read.cause)}`, {
			projectRoot, bindingPath, details: fileSystemErrorDetails(read.cause),
		});
	}
	if (read.state === "invalid") {
		if (legacyToolCompatibility) return { ok: true, data: undefined };
		return projectPaneError("INVALID_BINDING", `Project pane binding '${projectPaneBindingPath(projectRoot)}' is malformed.`, {
			projectRoot, bindingPath: projectPaneBindingPath(projectRoot),
		});
	}
	const binding = read.binding;
	if (!legacyToolCompatibility && canonicalRuntimePath(binding.projectRoot) !== projectRoot) {
		return projectPaneError("INVALID_BINDING", `Project pane binding root '${binding.projectRoot}' does not match '${projectRoot}'.`, {
			projectRoot, bindingPath: projectPaneBindingPath(projectRoot), details: binding,
		});
	}
	return { ok: true, data: binding };
}

function common(projectRoot: string): ProjectPaneCommonData {
	return {
		apiVersion: PROJECT_PANES_API_VERSION,
		projectRoot,
		bindingPath: projectPaneBindingPath(projectRoot),
		trust: PROJECT_PANE_TRUST_STATUS,
	};
}

function fileSystemErrorDetails(cause: unknown): unknown {
	if (!(cause instanceof Error)) return cause;
	const code = (cause as NodeJS.ErrnoException).code;
	return { name: cause.name, message: cause.message, ...(code ? { code } : {}) };
}

function removeProjectPaneBinding(projectRoot: string): ProjectPaneResult<void> {
	const bindingPath = projectPaneBindingPath(projectRoot);
	try {
		fs.rmSync(bindingPath, { force: true });
		return { ok: true, data: undefined };
	} catch (cause) {
		return projectPaneError("BINDING_REMOVE_FAILED", `Failed to remove project pane binding '${bindingPath}': ${cause instanceof Error ? cause.message : String(cause)}`, {
			projectRoot, bindingPath, details: fileSystemErrorDetails(cause),
		});
	}
}

function createProjectPaneManagerInternal(options: InternalProjectPaneManagerOptions = {}): ProjectPaneManager {
	const client = options.client ?? createHerdrClient();
	return {
		async status(input) {
			const root = resolveProjectRoot(input.cwd);
			if (!root.ok) return root;
			const projectRoot = root.data;
			const bindingResult = bindingForManager(projectRoot, options.legacyToolCompatibility);
			if (!bindingResult.ok) return bindingResult;
			const existing = bindingResult.data;
			if (!existing) return { ok: true, data: { ...common(projectRoot), state: "absent", ownership: "unknown", safeToClose: true } };
			const live = await inspectPane(client, existing.paneId, input.signal);
			if (!live.ok) {
				if (live.error.code === "INVALID_PANE_RESPONSE" && options.legacyToolCompatibility) {
					const runtime: ProjectPaneRuntime = { paneId: existing.paneId, agentStatus: "unknown" };
					return { ok: true, data: { ...common(projectRoot), state: "open", binding: existing, runtime, ownership: "unknown", safeToClose: false } };
				}
				if (live.error.code === "NOT_FOUND" || live.error.code === "PANE_GONE") {
					return { ok: true, data: {
						...common(projectRoot), state: "stale", binding: existing, ownership: "unknown", safeToClose: false,
						staleReason: { code: live.error.code, message: live.error.message },
					} };
				}
				return { ok: false, error: { ...live.error, projectRoot, bindingPath: projectPaneBindingPath(projectRoot) } };
			}
			const ownership = projectPaneOwnership(live.data, existing, projectRoot);
			return { ok: true, data: {
				...common(projectRoot), state: "open", binding: existing, runtime: live.data, ownership,
				safeToClose: live.data.agentStatus === "idle" && ownership === "verified",
			} };
		},

		async open(input) {
			const root = resolveProjectRoot(input.cwd);
			if (!root.ok) return root;
			const projectRoot = root.data;
			const detected = await detectHerdr(client, input.signal);
			if (!detected.ok) return projectPaneError(detected.error.code, detected.error.message, { projectRoot, details: detected.error.details });
			const bindingResult = bindingForManager(projectRoot, options.legacyToolCompatibility);
			if (!bindingResult.ok) return bindingResult;
			const existing = bindingResult.data;
			if (existing) {
				const live = await inspectPane(client, existing.paneId, input.signal);
				if (live.ok) {
					const ownership = projectPaneOwnership(live.data, existing, projectRoot);
					if (!options.legacyToolCompatibility && ownership !== "verified") {
						return projectPaneError("PANE_OWNERSHIP_UNVERIFIED", `Project pane '${existing.paneId}' ownership is '${ownership}' for '${projectRoot}'.`, {
							projectRoot, bindingPath: projectPaneBindingPath(projectRoot), details: live.data,
						});
					}
					return { ok: true, data: { ...common(projectRoot), disposition: "already-open", binding: existing, runtime: live.data } };
				}
				if (live.error.code === "INVALID_PANE_RESPONSE" && options.legacyToolCompatibility) {
					return { ok: true, data: {
						...common(projectRoot), disposition: "already-open", binding: existing,
						runtime: { paneId: existing.paneId, agentStatus: "unknown" },
					} };
				}
				const stale = live.error.code === "NOT_FOUND" || live.error.code === "PANE_GONE";
				if (!stale && !options.legacyToolCompatibility) {
					return { ok: false, error: { ...live.error, projectRoot, bindingPath: projectPaneBindingPath(projectRoot) } };
				}
			}
			const splitArgs = ["pane", "split", "--current", "--direction", "right", "--cwd", projectRoot];
			if (input.focus !== false) splitArgs.push("--focus");
			const split = await client.run(splitArgs, { timeoutMs: 15_000, signal: input.signal });
			if (!split.ok) return projectPaneError(split.error.code, split.error.message, { projectRoot, details: split.error.details });
			const paneId = extractPaneId(split.data);
			if (!paneId) return projectPaneError(options.legacyToolCompatibility ? "PANE_GONE" : "INVALID_PANE_RESPONSE", "Herdr pane split returned no pane id.", { projectRoot, details: split.data });
			const startupMessage = input.message?.trim();
			const command = projectPaneCommand(startupMessage);
			const started = await client.run(["pane", "run", paneId, command], { timeoutMs: 15_000, signal: input.signal });
			if (!started.ok) {
				await client.run(["pane", "close", paneId], { timeoutMs: 5_000 });
				return projectPaneError(started.error.code, started.error.message, { projectRoot, details: started.error.details });
			}
			const now = (options.now?.() ?? new Date()).toISOString();
			const binding: HerdrProjectPaneBinding = {
				schemaVersion: 1,
				kind: "herdr-project-pane",
				projectRoot,
				paneId,
				openedAt: now,
				...(input.focus !== false ? { lastFocusedAt: now } : {}),
				herdrVersion: detected.data.versionText,
				command,
				...(startupMessage ? { startupMessage } : {}),
			};
			const bindingPath = projectPaneBindingPath(projectRoot);
			try {
				writeAtomicJson(bindingPath, binding);
			} catch (cause) {
				let cleanup: { paneClosed: true } | { paneClosed: false; error: unknown };
				try {
					const closed = await client.run(["pane", "close", paneId], { timeoutMs: 5_000 });
					cleanup = closed.ok
						? { paneClosed: true }
						: { paneClosed: false, error: closed.error };
				} catch (cleanupCause) {
					cleanup = { paneClosed: false, error: fileSystemErrorDetails(cleanupCause) };
				}
				const cleanupMessage = cleanup.paneClosed
					? ` The newly opened pane '${paneId}' was closed.`
					: ` Cleanup could not close the newly opened pane '${paneId}'.`;
				return projectPaneError("BINDING_WRITE_FAILED", `Failed to persist project pane binding '${bindingPath}': ${cause instanceof Error ? cause.message : String(cause)}.${cleanupMessage}`, {
					projectRoot, bindingPath, details: { cause: fileSystemErrorDetails(cause), cleanup },
				});
			}
			return { ok: true, data: { ...common(projectRoot), disposition: "opened", binding } };
		},

		async close(input) {
			const root = resolveProjectRoot(input.cwd);
			if (!root.ok) return root;
			const projectRoot = root.data;
			const bindingResult = bindingForManager(projectRoot, options.legacyToolCompatibility);
			if (!bindingResult.ok) return bindingResult;
			const existing = bindingResult.data;
			if (!existing) return { ok: true, data: { ...common(projectRoot), disposition: "absent" } };
			let runtime: ProjectPaneRuntime | undefined;
			if (input.requireIdle) {
				const live = await inspectPane(client, existing.paneId, input.signal);
				if (!live.ok) {
					if (live.error.code === "NOT_FOUND" || live.error.code === "PANE_GONE") {
						const removed = removeProjectPaneBinding(projectRoot);
						if (!removed.ok) return removed;
						return { ok: true, data: { ...common(projectRoot), disposition: "stale-binding-removed", binding: existing } };
					}
					return { ok: false, error: { ...live.error, projectRoot, bindingPath: projectPaneBindingPath(projectRoot) } };
				}
				runtime = live.data;
				const ownership = projectPaneOwnership(runtime, existing, projectRoot);
				if (ownership !== "verified") {
					return projectPaneError("PANE_OWNERSHIP_UNVERIFIED", `Project pane '${existing.paneId}' ownership is '${ownership}' for '${projectRoot}'.`, {
						projectRoot, bindingPath: projectPaneBindingPath(projectRoot), details: runtime,
					});
				}
				if (runtime.agentStatus !== "idle") {
					return projectPaneError("PANE_NOT_IDLE", `Project pane '${existing.paneId}' is '${runtime.agentStatus}', not explicitly idle.`, {
						projectRoot, bindingPath: projectPaneBindingPath(projectRoot), details: runtime,
					});
				}
			}
			const closed = await client.run(["pane", "close", existing.paneId], { timeoutMs: 10_000, signal: input.signal });
			if (!closed.ok && closed.error.code !== "NOT_FOUND" && closed.error.code !== "PANE_GONE") {
				return projectPaneError(closed.error.code, closed.error.message, { projectRoot, bindingPath: projectPaneBindingPath(projectRoot), details: closed.error.details });
			}
			const disposition: CloseProjectPaneData["disposition"] = closed.ok ? "closed" : "stale-binding-removed";
			const removed = removeProjectPaneBinding(projectRoot);
			if (!removed.ok) return removed;
			return { ok: true, data: { ...common(projectRoot), disposition, binding: existing, ...(runtime ? { runtime } : {}) } };
		},
	};
}

export function createProjectPaneManager(options: ProjectPaneManagerOptions = {}): ProjectPaneManager {
	return createProjectPaneManagerInternal(options);
}

export async function openProjectPane(options: OpenProjectPaneOptions): Promise<ProjectPaneResult<OpenProjectPaneData>> {
	return createProjectPaneManager().open(options);
}

export async function getProjectPaneStatus(options: GetProjectPaneStatusOptions): Promise<ProjectPaneResult<ProjectPaneStatusData>> {
	return createProjectPaneManager().status(options);
}

export async function closeProjectPane(options: CloseProjectPaneOptions): Promise<ProjectPaneResult<CloseProjectPaneData>> {
	return createProjectPaneManager().close(options);
}

export async function handleHerdrProjectPaneAction(action: HerdrProjectPaneAction, params: ProjectPaneParams, deps: ProjectPaneDeps): Promise<AgentToolResult<Details>> {
	const requested = params.cwd?.trim() || deps.cwd;
	const manager = createProjectPaneManagerInternal({ client: deps.client, now: deps.now, legacyToolCompatibility: true });
	if (action === "project.status") {
		const status = await manager.status({ cwd: requested, signal: deps.signal });
		if (!status.ok) return toolResult(formatProjectPaneError(status.error), true);
		if (status.data.state === "absent") return toolResult(`No Herdr project pane binding exists for ${status.data.projectRoot}.`);
		if (status.data.state === "stale") {
			const reason = status.data.staleReason!;
			return toolResult(`${formatProjectPaneError(reason)}\nBinding: ${status.data.bindingPath}`, true);
		}
		return toolResult(`Herdr project pane ${status.data.binding!.paneId} is open for ${status.data.projectRoot}.\nBinding: ${status.data.bindingPath}`);
	}
	if (action === "project.close") {
		const closed = await manager.close({ cwd: requested, signal: deps.signal });
		if (!closed.ok) return toolResult(formatProjectPaneError(closed.error), true);
		if (closed.data.disposition === "absent") return toolResult(`No Herdr project pane binding exists for ${closed.data.projectRoot}.`);
		return toolResult(`Closed Herdr project pane ${closed.data.binding!.paneId} for ${closed.data.projectRoot}.`);
	}
	const opened = await manager.open({ cwd: requested, message: params.message, focus: params.focus, signal: deps.signal });
	if (!opened.ok) return toolResult(formatProjectPaneError(opened.error), true);
	if (opened.data.disposition === "already-open") {
		return toolResult(`Herdr project pane ${opened.data.binding.paneId} is already open for ${opened.data.projectRoot}.${params.focus ? " Herdr cannot refocus an arbitrary raw pane id; select it in the Herdr UI." : ""}`);
	}
	return toolResult(`Opened Herdr project pane ${opened.data.binding.paneId} for ${opened.data.projectRoot}. The pane runs its own Pi session; subagents launched there belong to that project.`);
}
