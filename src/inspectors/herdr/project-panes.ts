import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getPiSpawnCommand } from "../../runs/shared/pi-spawn.ts";
import { getProjectSubagentsDir } from "../../shared/artifacts.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type { Details, HerdrProjectPaneSnapshot, SubagentState } from "../../shared/types.ts";
import { createHerdrClient, detectHerdr, type HerdrClient, type HerdrErrorCode } from "./client.ts";
import { focusHerdrPane, herdrPaneFocusTarget, herdrPaneRecord } from "./focus.ts";
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
	tabId?: string;
	workspaceId?: string;
	summary?: string;
	terminalTitle?: string;
}

export type ProjectPaneErrorCode = HerdrErrorCode
	| "INVALID_PROJECT_ROOT"
	| "INVALID_PANE_RESPONSE"
	| "INVALID_BINDING"
	| "BINDING_READ_FAILED"
	| "BINDING_WRITE_FAILED"
	| "BINDING_REMOVE_FAILED"
	| "PANE_FOCUS_UNSUPPORTED"
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

export interface FocusProjectPaneData extends ProjectPaneCommonData {
	binding: HerdrProjectPaneBinding;
	runtime: ProjectPaneRuntime;
	ownership: "verified" | "unknown" | "mismatch";
	focused: { paneId: string; tabId?: string; workspaceId?: string };
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

export type ProjectPaneCommandClient = Pick<HerdrClient, "run">;

export interface ProjectPaneManagerOptions {
	client?: ProjectPaneCommandClient;
	now?: () => Date;
}

export interface ProjectPaneManager {
	open(options: OpenProjectPaneOptions): Promise<ProjectPaneResult<OpenProjectPaneData>>;
	status(options: GetProjectPaneStatusOptions): Promise<ProjectPaneResult<ProjectPaneStatusData>>;
	focus(options: GetProjectPaneStatusOptions): Promise<ProjectPaneResult<FocusProjectPaneData>>;
	close(options: CloseProjectPaneOptions): Promise<ProjectPaneResult<CloseProjectPaneData>>;
}

interface InternalProjectPaneManagerOptions extends ProjectPaneManagerOptions {
	/** Preserve the historical model-facing action behavior without weakening the public API defaults. */
	legacyToolCompatibility?: boolean;
}

interface HerdrProjectPaneRootIndex {
	schemaVersion: 1;
	kind: "herdr-project-pane-roots";
	projectRoots: string[];
}

interface ProjectPaneParams {
	cwd?: string;
	message?: string;
	focus?: boolean;
}

interface ProjectPaneDeps {
	cwd: string;
	state?: SubagentState;
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

function projectPaneRootIndexPath(ownerRoot: string): string {
	return path.join(projectPaneDir(ownerRoot), "herdr-roots.json");
}

function parseRootIndex(value: unknown): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Herdr project pane root index.");
	const input = value as Partial<HerdrProjectPaneRootIndex>;
	if (input.schemaVersion !== 1 || input.kind !== "herdr-project-pane-roots" || !Array.isArray(input.projectRoots)) throw new Error("Invalid Herdr project pane root index.");
	if (!input.projectRoots.every((root) => typeof root === "string" && root.length > 0)) throw new Error("Invalid Herdr project pane root index.");
	return input.projectRoots;
}

export function listHerdrProjectPaneRoots(ownerRoot: string): string[] {
	try {
		return parseRootIndex(JSON.parse(fs.readFileSync(projectPaneRootIndexPath(ownerRoot), "utf-8")));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return [];
		throw error;
	}
}

function writeHerdrProjectPaneRoot(ownerRoot: string, projectRoot: string): void {
	const projectRoots = [...new Set([...listHerdrProjectPaneRoots(ownerRoot), projectRoot])].sort();
	writeAtomicJson(projectPaneRootIndexPath(ownerRoot), {
		schemaVersion: 1,
		kind: "herdr-project-pane-roots",
		projectRoots,
	} satisfies HerdrProjectPaneRootIndex);
}

function removeHerdrProjectPaneRoot(ownerRoot: string, projectRoot: string): void {
	const projectRoots = listHerdrProjectPaneRoots(ownerRoot).filter((root) => root !== projectRoot);
	const file = projectPaneRootIndexPath(ownerRoot);
	if (projectRoots.length === 0) {
		fs.rmSync(file, { force: true });
		return;
	}
	writeAtomicJson(file, {
		schemaVersion: 1,
		kind: "herdr-project-pane-roots",
		projectRoots,
	} satisfies HerdrProjectPaneRootIndex);
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

function herdrProjectPaneSnapshotFromBinding(binding: HerdrProjectPaneBinding, now = Date.now()): HerdrProjectPaneSnapshot {
	return {
		projectRoot: binding.projectRoot,
		bindingPath: projectPaneBindingPath(binding.projectRoot),
		paneId: binding.paneId,
		openedAt: binding.openedAt,
		...(binding.lastFocusedAt ? { lastFocusedAt: binding.lastFocusedAt } : {}),
		state: "open",
		agentStatus: "unknown",
		ownership: "unknown",
		safeToClose: false,
		refreshedAt: now,
	};
}

export function restoreHerdrProjectPaneSnapshots(state: SubagentState, projectRoots: Iterable<string>, now = Date.now()): void {
	const restored = new Map(state.herdrProjectPanes ?? []);
	for (const projectRoot of projectRoots) {
		const binding = readHerdrProjectPaneBinding(projectRoot);
		if (binding) restored.set(binding.projectRoot, herdrProjectPaneSnapshotFromBinding(binding, now));
	}
	state.herdrProjectPanes = restored;
}

function sanitizedSummary(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	return cleaned ? cleaned.slice(0, 120) : undefined;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const child = (value as Record<string, unknown>)[key];
	return child && typeof child === "object" && !Array.isArray(child) ? child as Record<string, unknown> : undefined;
}

function paneSummary(pane: Record<string, unknown>): string | undefined {
	return sanitizedSummary(pane.summary)
		?? sanitizedSummary(pane.state_text)
		?? sanitizedSummary(pane.stateText)
		?? sanitizedSummary(pane.token_summary)
		?? sanitizedSummary(nestedRecord(pane, "tokens")?.summary)
		?? sanitizedSummary(nestedRecord(pane, "metadata")?.summary)
		?? sanitizedSummary(nestedRecord(nestedRecord(pane, "metadata"), "tokens")?.summary);
}

function projectPaneRuntime(value: unknown): ProjectPaneRuntime | undefined {
	const pane = herdrPaneRecord(value);
	const focusTarget = herdrPaneFocusTarget(value);
	const paneId = focusTarget.paneId;
	if (!pane || !paneId) return undefined;
	const text = (key: string): string | undefined => typeof pane[key] === "string" ? pane[key] as string : undefined;
	const agentStatus = text("agent_status") ?? text("agentStatus") ?? "unknown";
	const summary = paneSummary(pane);
	return {
		paneId,
		...(text("agent") ? { agent: text("agent") } : {}),
		agentStatus: agentStatus.toLowerCase(),
		...(text("cwd") ? { cwd: text("cwd") } : {}),
		...(text("foreground_cwd") || text("foregroundCwd") ? { foregroundCwd: text("foreground_cwd") ?? text("foregroundCwd") } : {}),
		...(typeof pane.focused === "boolean" ? { focused: pane.focused } : {}),
		...(focusTarget.tabId ? { tabId: focusTarget.tabId } : {}),
		...(focusTarget.workspaceId ? { workspaceId: focusTarget.workspaceId } : {}),
		...(summary ? { summary } : {}),
		...(text("terminal_title_stripped") || text("terminal_title") || text("terminalTitle")
			? { terminalTitle: text("terminal_title_stripped") ?? text("terminal_title") ?? text("terminalTitle") }
			: {}),
	};
}

function herdrProjectPaneSnapshotFromStatus(data: ProjectPaneStatusData, now: number): HerdrProjectPaneSnapshot | undefined {
	if (data.state === "absent" || !data.binding) return undefined;
	return {
		projectRoot: data.projectRoot,
		bindingPath: data.bindingPath,
		paneId: data.binding.paneId,
		openedAt: data.binding.openedAt,
		...(data.binding.lastFocusedAt ? { lastFocusedAt: data.binding.lastFocusedAt } : {}),
		state: data.state,
		agentStatus: data.runtime?.agentStatus ?? "unknown",
		ownership: data.ownership,
		safeToClose: data.safeToClose,
		refreshedAt: now,
		...(data.runtime?.summary ? { summary: data.runtime.summary } : {}),
		...(data.runtime?.tabId ? { tabId: data.runtime.tabId } : {}),
		...(data.runtime?.workspaceId ? { workspaceId: data.runtime.workspaceId } : {}),
		...(data.runtime?.terminalTitle ? { terminalTitle: data.runtime.terminalTitle } : {}),
		...(data.staleReason ? { staleReason: data.staleReason.message } : {}),
	};
}

function rememberProjectPane(state: SubagentState | undefined, data: ProjectPaneStatusData, now: number): void {
	if (!state) return;
	state.herdrProjectPanes ??= new Map();
	const snapshot = herdrProjectPaneSnapshotFromStatus(data, now);
	if (snapshot) state.herdrProjectPanes.set(data.projectRoot, snapshot);
	else state.herdrProjectPanes.delete(data.projectRoot);
}

function forgetProjectPane(state: SubagentState | undefined, projectRoot: string): void {
	state?.herdrProjectPanes?.delete(projectRoot);
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

		async focus(input) {
			const status = await this.status(input);
			if (!status.ok) return projectPaneError(status.error.code, status.error.message, status.error);
			if (status.data.state !== "open" || !status.data.binding || !status.data.runtime) {
				return projectPaneError("PANE_GONE", `No open Herdr project pane binding exists for '${status.data.projectRoot}'.`, {
					projectRoot: status.data.projectRoot, bindingPath: status.data.bindingPath,
				});
			}
			if (status.data.ownership !== "verified") {
				return projectPaneError("PANE_OWNERSHIP_UNVERIFIED", `Project pane '${status.data.binding.paneId}' ownership is '${status.data.ownership}' for '${status.data.projectRoot}'.`, {
					projectRoot: status.data.projectRoot, bindingPath: status.data.bindingPath, details: status.data.runtime,
				});
			}
			const focused = await focusHerdrPane(client, status.data.binding.paneId, input.signal);
			if (!focused.ok) return projectPaneError(focused.error.code, focused.error.message, {
				projectRoot: status.data.projectRoot, bindingPath: status.data.bindingPath, details: focused.error.details,
			});
			const now = (options.now?.() ?? new Date()).toISOString();
			const binding = { ...status.data.binding, lastFocusedAt: now };
			try {
				writeAtomicJson(status.data.bindingPath, binding);
			} catch (cause) {
				return projectPaneError("BINDING_WRITE_FAILED", `Failed to update project pane binding '${status.data.bindingPath}': ${cause instanceof Error ? cause.message : String(cause)}`, {
					projectRoot: status.data.projectRoot, bindingPath: status.data.bindingPath, details: fileSystemErrorDetails(cause),
				});
			}
			return { ok: true, data: {
				...common(status.data.projectRoot),
				binding,
				runtime: status.data.runtime,
				ownership: status.data.ownership,
				focused: focused.data,
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
			splitArgs.push(input.focus === true ? "--focus" : "--no-focus");
			const split = await client.run(splitArgs, { timeoutMs: 15_000, signal: input.signal });
			if (!split.ok) return projectPaneError(split.error.code, split.error.message, { projectRoot, details: split.error.details });
			const paneId = herdrPaneFocusTarget(split.data).paneId;
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
				...(input.focus === true ? { lastFocusedAt: now } : {}),
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
			const live = await inspectPane(client, existing.paneId, input.signal);
			if (!live.ok) {
				if (live.error.code === "NOT_FOUND" || live.error.code === "PANE_GONE") {
					const removed = removeProjectPaneBinding(projectRoot);
					if (!removed.ok) return removed;
					return { ok: true, data: { ...common(projectRoot), disposition: "stale-binding-removed", binding: existing } };
				}
				return { ok: false, error: { ...live.error, projectRoot, bindingPath: projectPaneBindingPath(projectRoot) } };
			}
			const runtime = live.data;
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

export async function focusProjectPane(options: GetProjectPaneStatusOptions): Promise<ProjectPaneResult<FocusProjectPaneData>> {
	return createProjectPaneManager().focus(options);
}

export async function handleHerdrProjectPaneAction(action: HerdrProjectPaneAction, params: ProjectPaneParams, deps: ProjectPaneDeps): Promise<AgentToolResult<Details>> {
	const requested = params.cwd?.trim() || deps.cwd;
	const ownerRoot = path.resolve(deps.cwd);
	const manager = createProjectPaneManagerInternal({ client: deps.client, now: deps.now, legacyToolCompatibility: true });
	const remember = (data: ProjectPaneStatusData) => rememberProjectPane(deps.state, data, deps.now?.().getTime() ?? Date.now());
	if (action === "project.status") {
		const status = await manager.status({ cwd: requested, signal: deps.signal });
		if (!status.ok) return toolResult(formatProjectPaneError(status.error), true);
		remember(status.data);
		if (status.data.state === "absent") return toolResult(`No Herdr project pane binding exists for ${status.data.projectRoot}.`);
		if (status.data.state === "stale") {
			const reason = status.data.staleReason!;
			return toolResult(`${formatProjectPaneError(reason)}\nBinding: ${status.data.bindingPath}`, true);
		}
		return toolResult(`Herdr project pane ${status.data.binding!.paneId} is open for ${status.data.projectRoot}.\nBinding: ${status.data.bindingPath}`);
	}
	if (action === "project.close") {
		const closed = await manager.close({ cwd: requested, requireIdle: true, signal: deps.signal });
		if (!closed.ok) return toolResult(formatProjectPaneError(closed.error), true);
		forgetProjectPane(deps.state, closed.data.projectRoot);
		try { removeHerdrProjectPaneRoot(ownerRoot, closed.data.projectRoot); } catch (error) {
			return toolResult(`Herdr project pane error (BINDING_REMOVE_FAILED): Failed to remove project pane root index '${projectPaneRootIndexPath(ownerRoot)}': ${error instanceof Error ? error.message : String(error)}`, true);
		}
		if (closed.data.disposition === "absent") return toolResult(`No Herdr project pane binding exists for ${closed.data.projectRoot}.`);
		return toolResult(`Closed Herdr project pane ${closed.data.binding!.paneId} for ${closed.data.projectRoot}.`);
	}
	const opened = await manager.open({ cwd: requested, message: params.message, focus: params.focus, signal: deps.signal });
	if (!opened.ok) return toolResult(formatProjectPaneError(opened.error), true);
	try { writeHerdrProjectPaneRoot(ownerRoot, opened.data.projectRoot); } catch (error) {
		return toolResult(`Herdr project pane error (BINDING_WRITE_FAILED): Failed to persist project pane root index '${projectPaneRootIndexPath(ownerRoot)}': ${error instanceof Error ? error.message : String(error)}`, true);
	}
	const status = await manager.status({ cwd: opened.data.projectRoot, signal: deps.signal });
	if (status.ok) remember(status.data);
	if (opened.data.disposition === "already-open") {
		if (params.focus) {
			const focused = await manager.focus({ cwd: opened.data.projectRoot, signal: deps.signal });
			if (!focused.ok) return toolResult(`Herdr project pane ${opened.data.binding.paneId} is already open for ${opened.data.projectRoot}. ${formatProjectPaneError(focused.error)}`, true);
			const focusedStatus = await manager.status({ cwd: opened.data.projectRoot, signal: deps.signal });
			if (focusedStatus.ok) remember(focusedStatus.data);
			return toolResult(`Herdr project pane ${opened.data.binding.paneId} is already open for ${opened.data.projectRoot}. Focused ${focused.data.focused.tabId ? `tab ${focused.data.focused.tabId}` : `workspace ${focused.data.focused.workspaceId}`}.`);
		}
		return toolResult(`Herdr project pane ${opened.data.binding.paneId} is already open for ${opened.data.projectRoot}.`);
	}
	return toolResult(`Opened Herdr project pane ${opened.data.binding.paneId} for ${opened.data.projectRoot}. The pane runs its own Pi session; subagents launched there belong to that project.`);
}
