import { Buffer } from "node:buffer";

export const SUBAGENT_LAUNCH_CHECK_REGISTRY_KEY = "pi-subagents.launch-check.v1";

export type SubagentLaunchOrigin =
	| { readonly kind: "request"; readonly requestId: string }
	| { readonly kind: "workflow"; readonly workflowRunId: string; readonly key: string; readonly scheduleId?: string }
	| { readonly kind: "resume"; readonly sourceRunId: string; readonly requestId: string };

export interface SubagentLaunch {
	readonly origin: SubagentLaunchOrigin;
	readonly agent: string;
	readonly task: string;
	/** Absolute. With `worktree`, the directory the new worktree is created from. */
	readonly cwd: string;
	/** Whether this start creates a new managed worktree from `cwd`. A resume in a retained worktree is `false`, with `cwd` set to that checkout. */
	readonly worktree: boolean;
	readonly model?: string;
	readonly verify: readonly {
		readonly id: string;
		readonly command: string;
		readonly cwd?: string;
		/** Environment overrides declared for this command, applied on top of the inherited process environment. */
		readonly env?: Readonly<Record<string, string>>;
	}[];
	readonly outputPath?: string;
	readonly background: boolean;
}

export type SubagentLaunchDecision = { readonly allow: true } | { readonly allow: false; readonly reason: string };

export interface RegisterSubagentLaunchCheckOptions {
	sessionId: string;
	source: string;
	check: (launch: SubagentLaunch, signal: AbortSignal) => SubagentLaunchDecision | Promise<SubagentLaunchDecision>;
}

export interface SubagentLaunchCheckHandle {
	dispose(): void;
}

type Registration = { source: string; check: RegisterSubagentLaunchCheckOptions["check"] };
type Registry = Map<string, Map<symbol, Registration>>;

const MAX_REASON_LENGTH = 500;

function registry(): Registry {
	const key = Symbol.for(SUBAGENT_LAUNCH_CHECK_REGISTRY_KEY);
	const store = globalThis as typeof globalThis & { [key: symbol]: unknown };
	const existing = store[key];
	if (existing instanceof Map) return existing as Registry;
	const created: Registry = new Map();
	store[key] = created;
	return created;
}

function validateText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value, "utf8") > 256) {
		throw new Error(`Invalid launch check ${field}; expected a non-empty string without surrounding whitespace or control characters (max 256 UTF-8 bytes).`);
	}
	return value;
}

export function registerSubagentLaunchCheck(options: RegisterSubagentLaunchCheckOptions): SubagentLaunchCheckHandle {
	const sessionId = validateText(options.sessionId, "sessionId");
	const source = validateText(options.source, "source");
	if (typeof options.check !== "function") throw new Error("Invalid launch check; expected a function.");
	const token = Symbol(source);
	const store = registry();
	const session = store.get(sessionId) ?? new Map<symbol, Registration>();
	store.set(sessionId, session);
	session.set(token, { source, check: options.check });
	let disposed = false;
	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			session.delete(token);
			if (session.size === 0 && store.get(sessionId) === session) store.delete(sessionId);
		},
	};
}

export function hasSubagentLaunchChecks(sessionId: string | undefined): boolean {
	return sessionId !== undefined && registry().has(sessionId);
}

function freezeLaunch(launch: SubagentLaunch): SubagentLaunch {
	return Object.freeze({
		...launch,
		origin: Object.freeze({ ...launch.origin }),
		verify: Object.freeze(launch.verify.map(({ id, command, cwd, env }) => Object.freeze({
			id,
			command,
			...(cwd !== undefined ? { cwd } : {}),
			...(env !== undefined ? { env: Object.freeze({ ...env }) } : {}),
		}))),
	});
}

function boundedReason(reason: string): string {
	const cleaned = reason.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
	if (cleaned.length <= MAX_REASON_LENGTH) return cleaned;
	const cut = /[\ud800-\udbff]/u.test(cleaned[MAX_REASON_LENGTH - 1] ?? "") ? MAX_REASON_LENGTH - 1 : MAX_REASON_LENGTH;
	return `${cleaned.slice(0, cut)}...`;
}

function describeFailure(error: unknown): string {
	return boundedReason(error instanceof Error ? error.message : String(error)) || "unknown error";
}

const ABORTED_MESSAGE = "the launch was aborted before the check answered";

function waitForDecision(check: RegisterSubagentLaunchCheckOptions["check"], launch: SubagentLaunch, signal: AbortSignal): Promise<SubagentLaunchDecision> {
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new Error(ABORTED_MESSAGE));
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			Promise.resolve(check(launch, signal)).then(resolve, reject).finally(cleanup);
		} catch (error) {
			cleanup();
			reject(error);
		}
		if (signal.aborted) onAbort();
	});
}

export type LaunchAdmissionStep =
	| { readonly done: true; readonly refusal?: string }
	| { readonly done: false; readonly wait: Promise<void> };

export interface LaunchAdmission {
	/**
	 * Synchronous. A `done` step is the final test: every check registered right now has allowed and the
	 * signal is not aborted, or the start is refused. Act on it in the same tick, with nothing awaited between.
	 */
	poll(): LaunchAdmissionStep;
}

interface LaunchAdmissionInput {
	sessionId: string | undefined;
	agent: string;
	describe: () => SubagentLaunch;
	signal?: AbortSignal;
}

export function openLaunchAdmission(input: LaunchAdmissionInput): LaunchAdmission | undefined {
	if (input.sessionId === undefined) return undefined;
	const sessionId = input.sessionId;
	if (!registry().has(sessionId)) return undefined;
	const signal = input.signal ?? new AbortController().signal;
	const answered = new Set<symbol>();
	let launch: SubagentLaunch | undefined;
	let lastSource: string | undefined;
	let refusal: string | undefined;
	let running: Promise<void> | undefined;
	const denied = (source: string, reason: string) => {
		refusal = `Launch check from ${source} denied agent '${input.agent}': ${reason}`;
	};
	const ask = (token: symbol, registration: Registration, description: SubagentLaunch) => {
		lastSource = registration.source;
		running = waitForDecision(registration.check, description, signal).then((decision) => {
			running = undefined;
			if (typeof decision !== "object" || decision === null) return denied(registration.source, "returned an invalid decision");
			if (decision.allow === true) {
				answered.add(token);
				return;
			}
			if (decision.allow !== false) return denied(registration.source, "returned an invalid decision");
			const reason = typeof decision.reason === "string" ? boundedReason(decision.reason) : "";
			denied(registration.source, reason || "returned a denial without a reason");
		}, (error) => {
			running = undefined;
			denied(registration.source, describeFailure(error));
		});
		return running;
	};
	return {
		poll() {
			if (refusal !== undefined) return { done: true, refusal };
			if (running !== undefined) return { done: false, wait: running };
			const next = [...(registry().get(sessionId) ?? [])].find(([token]) => !answered.has(token));
			const source = next?.[1].source ?? lastSource;
			if (signal.aborted && source !== undefined) {
				denied(source, ABORTED_MESSAGE);
				return { done: true, refusal };
			}
			if (!next) return { done: true };
			if (launch === undefined) {
				try {
					launch = freezeLaunch(input.describe());
				} catch (error) {
					refusal = `Launch of agent '${input.agent}' was refused because it could not be described for launch checks: ${describeFailure(error)}`;
					return { done: true, refusal };
				}
			}
			return { done: false, wait: ask(next[0], next[1], launch) };
		},
	};
}

export function admitSubagentLaunch<R>(input: LaunchAdmissionInput, commit: (refusal: string | undefined) => R | Promise<R>): R | Promise<R> {
	const admission = openLaunchAdmission(input);
	if (admission === undefined) return commit(undefined);
	const settle = (): R | Promise<R> => {
		const step = admission.poll();
		return step.done ? commit(step.refusal) : step.wait.then(settle);
	};
	return settle();
}
