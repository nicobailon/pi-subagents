import { Buffer } from "node:buffer";

export const SUBAGENT_LAUNCH_CHECK_REGISTRY_KEY = "pi-subagents.launch-check.v1";

export type SubagentLaunchOrigin =
	| { readonly kind: "request"; readonly requestId: string }
	| { readonly kind: "workflow"; readonly workflowRunId: string; readonly key: string }
	| { readonly kind: "schedule"; readonly scheduleId: string }
	| { readonly kind: "resume"; readonly sourceRunId: string; readonly requestId: string };

export interface SubagentLaunch {
	readonly origin: SubagentLaunchOrigin;
	readonly agent: string;
	readonly task: string;
	/** Absolute. With `worktree`, the directory the new worktree is created from. */
	readonly cwd: string;
	readonly worktree: boolean;
	readonly model?: string;
	readonly verify: readonly { readonly id: string; readonly command: string; readonly cwd?: string }[];
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
	if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value.trim(), "utf8") > 256) {
		throw new Error(`Invalid launch check ${field}; expected a non-empty string without control characters (max 256 UTF-8 bytes).`);
	}
	return value.trim();
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
		verify: Object.freeze(launch.verify.map((entry) => Object.freeze({ ...entry }))),
	});
}

function boundedReason(reason: string): string {
	const cleaned = reason.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
	return cleaned.length > MAX_REASON_LENGTH ? `${cleaned.slice(0, MAX_REASON_LENGTH)}...` : cleaned;
}

function describeFailure(error: unknown): string {
	return boundedReason(error instanceof Error ? error.message : String(error)) || "unknown error";
}

const ABORTED_MESSAGE = "the launch was aborted before the check answered";

function waitForDecision(pending: SubagentLaunchDecision | Promise<SubagentLaunchDecision>, signal: AbortSignal): Promise<SubagentLaunchDecision> {
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new Error(ABORTED_MESSAGE));
		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve(pending).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/**
 * Returns undefined at once, without building the description, when the session has no
 * registration. Otherwise resolves to the denial message, or undefined when every check allows.
 */
export function evaluateSubagentLaunchChecks(input: {
	sessionId: string | undefined;
	agent: string;
	describe: () => SubagentLaunch;
	signal?: AbortSignal;
}): Promise<string | undefined> | undefined {
	if (input.sessionId === undefined) return undefined;
	const registrations = registry().get(input.sessionId);
	if (!registrations) return undefined;
	const snapshot = [...registrations.values()];
	return (async () => {
		const signal = input.signal ?? new AbortController().signal;
		let launch: SubagentLaunch;
		try {
			launch = freezeLaunch(input.describe());
		} catch (error) {
			return `Launch of agent '${input.agent}' was refused because it could not be described for launch checks: ${describeFailure(error)}`;
		}
		for (const { source, check } of snapshot) {
			const denied = (reason: string) => `Launch check from ${source} denied agent '${input.agent}': ${reason}`;
			if (signal.aborted) return denied(ABORTED_MESSAGE);
			let decision: SubagentLaunchDecision;
			try {
				decision = await waitForDecision(check(launch, signal), signal);
			} catch (error) {
				return denied(describeFailure(error));
			}
			if (typeof decision !== "object" || decision === null) return denied("returned an invalid decision");
			if (decision.allow === true) continue;
			if (decision.allow !== false) return denied("returned an invalid decision");
			const reason = typeof decision.reason === "string" ? boundedReason(decision.reason) : "";
			return denied(reason || "returned a denial without a reason");
		}
		return undefined;
	})();
}
