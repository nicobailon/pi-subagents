import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type {
	WatchdogLspConfig,
	WatchdogLspDiagnostic,
	WatchdogLspDiagnosticSeverity,
	WatchdogLspResult,
	WatchdogWarning,
} from "./types.ts";
export interface WatchdogLspRequest {
	cwd: string;
	root: string;
	changedPaths: string[];
	config: WatchdogLspConfig;
	signal?: AbortSignal;
}
export type WatchdogLspDiagnosticsFunction = (request: WatchdogLspRequest) => Promise<WatchdogLspResult> | WatchdogLspResult;
interface TargetFile {
	relPath: string;
	absPath: string;
	uri: string;
	languageId: string;
}
interface LspCommand {
	command: string;
	args: string[];
	label: string;
}
type JsonRpcId = number | string;
type JsonRpcMessage = {
	jsonrpc?: string;
	id?: JsonRpcId | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { message?: string; code?: number };
};
type LspDiagnostic = {
	range?: {
		start?: { line?: number; character?: number };
	};
	severity?: number;
	code?: string | number;
	source?: string;
	message?: string;
};
const TS_JS_EXTENSIONS = new Map<string, string>([
	[".ts", "typescript"],
	[".tsx", "typescriptreact"],
	[".mts", "typescript"],
	[".cts", "typescript"],
	[".js", "javascript"],
	[".jsx", "javascriptreact"],
	[".mjs", "javascript"],
	[".cjs", "javascript"],
]);
const PROVIDER_NAME = "typescript-language-server";
const MAX_MESSAGE_LENGTH = 500;
const MAX_STDERR_LENGTH = 2_000;
const SHUTDOWN_TIMEOUT_MS = 250;
function normalizeRelPath(value: string): string {
	return value.replaceAll(path.sep, "/").replace(/^\.\//, "");
}
function isPathInsideRoot(absPath: string, root: string): boolean {
	const rel = path.relative(root, absPath);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
function languageIdForPath(filePath: string): string | undefined {
	return TS_JS_EXTENSIONS.get(path.extname(filePath).toLowerCase());
}

function trimDiagnosticMessage(message: string): string {
	const normalized = message.replace(/\s+/g, " ").trim();
	return normalized.length > MAX_MESSAGE_LENGTH ? `${normalized.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : normalized;
}

function severityFromLsp(value: number | undefined): WatchdogLspDiagnosticSeverity {
	if (value === 1) return "error";
	if (value === 2) return "warning";
	if (value === 3) return "info";
	return "hint";
}

function pathExecutable(filePath: string): boolean {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return false;
		if (process.platform === "win32") return true;
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function pathExecutableNames(name: string): string[] {
	if (process.platform !== "win32") return [name];
	const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
	return [name, ...extensions.map((ext) => `${name}${ext.toLowerCase()}`), ...extensions.map((ext) => `${name}${ext.toUpperCase()}`)];
}

function resolveTypeScriptLanguageServer(root: string): LspCommand | undefined {
	for (const name of pathExecutableNames(PROVIDER_NAME)) {
		const local = path.join(root, "node_modules", ".bin", name);
		if (pathExecutable(local)) return { command: local, args: ["--stdio"], label: `${PROVIDER_NAME} (project)` };
	}
	for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		for (const name of pathExecutableNames(PROVIDER_NAME)) {
			const candidate = path.join(dir, name);
			if (pathExecutable(candidate)) return { command: candidate, args: ["--stdio"], label: PROVIDER_NAME };
		}
	}
	return undefined;
}

function collectTargetFiles(root: string, changedPaths: string[], maxFiles: number): { targets: TargetFile[]; skippedPaths: string[] } {
	const targets: TargetFile[] = [];
	const skippedPaths: string[] = [];
	for (const changedPath of changedPaths) {
		const relPath = normalizeRelPath(changedPath);
		const absPath = path.resolve(root, relPath);
		const languageId = languageIdForPath(absPath);
		if (!languageId || !isPathInsideRoot(absPath, root)) {
			skippedPaths.push(relPath);
			continue;
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(absPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				skippedPaths.push(relPath);
				continue;
			}
			throw error;
		}
		if (!stat.isFile()) {
			skippedPaths.push(relPath);
			continue;
		}
		if (targets.length >= maxFiles) {
			skippedPaths.push(relPath);
			continue;
		}
		targets.push({ relPath, absPath, uri: pathToFileURL(absPath).href, languageId });
	}
	return { targets, skippedPaths };
}

function diagnosticIdentity(diagnostic: WatchdogLspDiagnostic): string {
	return createHash("sha256")
		.update([
			diagnostic.path,
			diagnostic.severity,
			diagnostic.source,
			diagnostic.code ?? "",
			diagnostic.message,
		].join("\n"))
		.digest("hex");
}

export class WatchdogLspDiagnosticsLedger {
	private readonly seen = new Map<string, Set<string>>();

	reset(): void {
		this.seen.clear();
	}

	reduce(result: WatchdogLspResult): WatchdogLspResult {
		if (result.status === "disabled" || result.status === "unavailable" || result.status === "failed") return result;
		const currentByPath = new Map<string, Set<string>>();
		const fresh: WatchdogLspDiagnostic[] = [];
		for (const diagnostic of result.diagnostics) {
			const identity = diagnosticIdentity(diagnostic);
			const current = currentByPath.get(diagnostic.path) ?? new Set<string>();
			current.add(identity);
			currentByPath.set(diagnostic.path, current);
			if (!this.seen.get(diagnostic.path)?.has(identity)) fresh.push(diagnostic);
		}
		for (const [filePath, identities] of currentByPath) this.seen.set(filePath, identities);
		if (result.status === "ok") {
			for (const checkedPath of result.checkedPaths) {
				if (!currentByPath.has(checkedPath)) this.seen.delete(checkedPath);
			}
		}
		return { ...result, diagnostics: fresh };
	}
}

function formatDiagnostic(diagnostic: WatchdogLspDiagnostic): string {
	const code = diagnostic.code ? ` ${diagnostic.code}` : "";
	return `${diagnostic.path}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity}${code} ${diagnostic.source}: ${diagnostic.message}`;
}

export function formatWatchdogLspDiagnosticsBlock(result: WatchdogLspResult): string {
	const actionable = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "warning");
	if (!actionable.length) return "";
	return [
		"LSP diagnostics:",
		...actionable.map((diagnostic) => `- ${formatDiagnostic(diagnostic)}`),
	].join("\n");
}

export function watchdogWarningFromLspDiagnostics(result: WatchdogLspResult): WatchdogWarning | undefined {
	const actionable = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "warning");
	if (!actionable.length) return undefined;
	const errors = actionable.filter((diagnostic) => diagnostic.severity === "error");
	const severity = errors.length ? "blocker" : "concern";
	const primary = errors[0] ?? actionable[0]!;
	const count = errors.length || actionable.length;
	const kind = errors.length ? "error" : "warning";
	const evidence = actionable.slice(0, 5).map(formatDiagnostic).join("\n");
	return {
		severity,
		category: "correctness",
		confidence: "high",
		source: "lsp",
		summary: `LSP found ${count} ${kind}${count === 1 ? "" : "s"} in changed ${count === 1 ? "file" : "files"}.`,
		evidence: evidence || formatDiagnostic(primary),
		recommendedAction: "Fix the reported diagnostics or explain why they are expected before accepting the change.",
	};
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) return Promise.reject(new Error("aborted"));
	let timer: ReturnType<typeof setTimeout> | undefined;
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			if (timer) clearTimeout(timer);
			reject(new Error("aborted"));
		};
		timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			reject(new Error(message));
		}, timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

class JsonRpcLspClient {
	private nextId = 1;
	private stdoutBuffer = Buffer.alloc(0);
	private readonly pending = new Map<JsonRpcId, { resolve(value: unknown): void; reject(error: Error): void }>();
	readonly diagnostics = new Map<string, LspDiagnostic[]>();
	private readonly child: ChildProcessWithoutNullStreams;
	private stderr = "";
	private exited = false;
	private readonly exitWaiters: Array<() => void> = [];

	constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child;
		child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = `${this.stderr}${chunk.toString("utf-8")}`.slice(-MAX_STDERR_LENGTH);
		});
		child.on("error", (error) => {
			this.exited = true;
			this.rejectPending(error);
			this.resolveExitWaiters();
		});
		child.on("exit", (code, signal) => {
			this.exited = true;
			this.rejectPending(new Error(`language server exited${code === null ? "" : ` with code ${code}`}${signal ? ` signal ${signal}` : ""}`));
			this.resolveExitWaiters();
		});
	}

	request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		const id = this.nextId++;
		const promise = new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
		return withTimeout(promise, timeoutMs, `${method} timed out`, signal);
	}

	notify(method: string, params: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	async shutdown(): Promise<void> {
		if (this.exited) return;
		try {
			await this.request("shutdown", null, SHUTDOWN_TIMEOUT_MS);
			this.notify("exit", null);
		} catch {
			this.child.kill("SIGTERM");
		}
		await this.waitForExit(SHUTDOWN_TIMEOUT_MS);
	}

	kill(): void {
		if (!this.exited) this.child.kill("SIGTERM");
	}

	stderrTail(): string {
		return this.stderr.trim();
	}

	private send(payload: JsonRpcMessage): void {
		if (this.exited) throw new Error("language server already exited");
		const body = JSON.stringify(payload);
		this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`);
	}

	private handleStdout(chunk: Buffer): void {
		this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
		while (true) {
			const headerEnd = this.stdoutBuffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const header = this.stdoutBuffer.slice(0, headerEnd).toString("utf-8");
			const match = header.match(/content-length:\s*(\d+)/i);
			if (!match) {
				this.stdoutBuffer = this.stdoutBuffer.slice(headerEnd + 4);
				continue;
			}
			const length = Number(match[1]);
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + length;
			if (this.stdoutBuffer.length < bodyEnd) return;
			const body = this.stdoutBuffer.slice(bodyStart, bodyEnd).toString("utf-8");
			this.stdoutBuffer = this.stdoutBuffer.slice(bodyEnd);
			try {
				this.handleMessage(JSON.parse(body) as JsonRpcMessage);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.failProtocol(new Error(`Invalid LSP JSON-RPC response: ${message}`));
				return;
			}
		}
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (message.method === "textDocument/publishDiagnostics") {
			const params = message.params as { uri?: unknown; diagnostics?: unknown } | undefined;
			if (typeof params?.uri === "string" && Array.isArray(params.diagnostics)) {
				this.diagnostics.set(params.uri, params.diagnostics as LspDiagnostic[]);
			}
			return;
		}
		if (message.id === undefined || message.id === null) return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (message.error) {
			pending.reject(new Error(message.error.message || `LSP request ${message.id} failed`));
		} else {
			pending.resolve(message.result);
		}
	}

	private failProtocol(error: Error): void {
		if (this.exited) return;
		this.rejectPending(error);
		this.child.kill("SIGTERM");
	}

	private waitForExit(timeoutMs: number): Promise<void> {
		if (this.exited) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, timeoutMs);
			this.exitWaiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private resolveExitWaiters(): void {
		for (const resolve of this.exitWaiters.splice(0)) resolve();
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

function convertDiagnostics(target: TargetFile, diagnostics: LspDiagnostic[]): WatchdogLspDiagnostic[] {
	return diagnostics
		.filter((diagnostic) => typeof diagnostic.message === "string" && diagnostic.range?.start)
		.map((diagnostic) => ({
			path: target.relPath,
			line: Math.max(1, (diagnostic.range?.start?.line ?? 0) + 1),
			column: Math.max(1, (diagnostic.range?.start?.character ?? 0) + 1),
			severity: severityFromLsp(diagnostic.severity),
			source: diagnostic.source || PROVIDER_NAME,
			...(diagnostic.code !== undefined ? { code: String(diagnostic.code) } : {}),
			message: trimDiagnosticMessage(diagnostic.message ?? ""),
		}));
}

function initializeParams(root: string): unknown {
	const rootUri = pathToFileURL(root).href;
	return {
		processId: process.pid,
		rootUri,
		capabilities: {
			textDocument: {
				publishDiagnostics: { relatedInformation: false, versionSupport: true },
			},
			workspace: { configuration: false, workspaceFolders: true },
		},
		workspaceFolders: [{ uri: rootUri, name: path.basename(root) || "workspace" }],
	};
}

async function waitForDiagnostics(client: JsonRpcLspClient, targets: TargetFile[], timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
	const started = Date.now();
	while (!signal?.aborted && Date.now() - started < timeoutMs) {
		if (targets.every((target) => client.diagnostics.has(target.uri))) return true;
		await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, timeoutMs - (Date.now() - started)))));
	}
	return targets.every((target) => client.diagnostics.has(target.uri));
}

async function collectWithTypeScriptLanguageServer(input: {
	root: string;
	targets: TargetFile[];
	skippedPaths: string[];
	command: LspCommand;
	config: WatchdogLspConfig;
	signal?: AbortSignal;
}): Promise<WatchdogLspResult> {
	const started = Date.now();
	const child = spawn(input.command.command, input.command.args, {
		cwd: input.root,
		stdio: "pipe",
		env: { ...process.env, NO_COLOR: "1" },
		shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(input.command.command),
	});
	const client = new JsonRpcLspClient(child);
	const remaining = () => Math.max(1, input.config.timeoutMs - (Date.now() - started));
	const abort = () => client.kill();
	input.signal?.addEventListener("abort", abort, { once: true });
	try {
		await client.request("initialize", initializeParams(input.root), remaining(), input.signal);
		client.notify("initialized", {});
		for (const target of input.targets) {
			const text = fs.readFileSync(target.absPath, "utf-8");
			client.notify("textDocument/didOpen", {
				textDocument: { uri: target.uri, languageId: target.languageId, version: 1, text },
			});
			client.notify("textDocument/didSave", {
				textDocument: { uri: target.uri },
				text,
			});
		}
		const complete = await waitForDiagnostics(client, input.targets, remaining(), input.signal);
		const diagnostics = input.targets
			.flatMap((target) => convertDiagnostics(target, client.diagnostics.get(target.uri) ?? []))
			.slice(0, input.config.maxDiagnostics);
		return {
			status: complete ? "ok" : "timeout",
			provider: input.command.label,
			checkedPaths: input.targets.map((target) => target.relPath),
			skippedPaths: input.skippedPaths,
			diagnostics,
			...(complete ? {} : { message: `Timed out waiting ${input.config.timeoutMs}ms for fresh LSP diagnostics.` }),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const timedOut = message.includes("timed out") || message === "aborted";
		const stderr = client.stderrTail();
		return {
			status: timedOut ? "timeout" : "failed",
			provider: input.command.label,
			checkedPaths: input.targets.map((target) => target.relPath),
			skippedPaths: input.skippedPaths,
			diagnostics: [],
			message: stderr ? `${message}; ${stderr}` : message,
		};
	} finally {
		input.signal?.removeEventListener("abort", abort);
		await client.shutdown();
	}
}

export async function collectWatchdogLspDiagnostics(request: WatchdogLspRequest): Promise<WatchdogLspResult> {
	if (!request.config.enabled) {
		return { status: "disabled", checkedPaths: [], skippedPaths: [], diagnostics: [] };
	}
	const root = path.resolve(request.root || request.cwd);
	const { targets, skippedPaths } = collectTargetFiles(root, request.changedPaths, request.config.maxFiles);
	if (!targets.length) {
		return {
			status: "skipped",
			checkedPaths: [],
			skippedPaths,
			diagnostics: [],
			message: "No changed TypeScript or JavaScript files to check.",
		};
	}
	const command = resolveTypeScriptLanguageServer(root);
	if (!command) {
		return {
			status: "unavailable",
			provider: PROVIDER_NAME,
			checkedPaths: [],
			skippedPaths: [...skippedPaths, ...targets.map((target) => target.relPath)],
			diagnostics: [],
			message: `${PROVIDER_NAME} was not found in project node_modules/.bin or PATH.`,
		};
	}
	try {
		return await collectWithTypeScriptLanguageServer({ root, targets, skippedPaths, command, config: request.config, signal: request.signal });
	} catch (error) {
		return {
			status: "failed",
			provider: command.label,
			checkedPaths: targets.map((target) => target.relPath),
			skippedPaths,
			diagnostics: [],
			message: error instanceof Error ? error.message : String(error),
		};
	}
}
