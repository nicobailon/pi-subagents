/**
 * Host-owned delegation ledger.
 *
 * Records the delegation lifecycle of structured subagent delegations
 * (`prompt-template:subagent:*` transport) inside the host process. The
 * registry is keyed by a well-known `Symbol.for` so every module instance
 * in the process shares one authoritative view of which delegations the
 * host actually performed.
 *
 * Threat model: artifacts written under a project (`.pi-subagents/`,
 * attestation files, plan receipts) are writable by any tool the delegated
 * session can reach, so they cannot by themselves prove that a child run
 * happened. This ledger is the in-process root of trust for "did the host
 * really run this child with this identity?". It never leaves the host
 * process, and it is only mutated by host-side extension code.
 *
 * Entries are bounded and validated fail-closed, mirroring the external-run
 * registry. Recording is best-effort from the caller's perspective: the
 * prompt-template bridge wraps these calls so a ledger failure can never
 * break a delegation in flight.
 */

export const DELEGATION_LEDGER_VERSION = 1;
export const DELEGATION_LEDGER_KEY = "pi-subagents.delegation-ledger.v1";

export const DELEGATION_LEDGER_LIMITS = {
	maxEntries: 256,
	maxIdLength: 256,
	maxAgentLength: 160,
	maxDigestLength: 160,
} as const;

/**
 * Lifecycle status for one delegated attempt. `running` is recorded when the
 * bridge accepts a structured delegation; the remaining values mirror the
 * terminal delegation statuses (minus request-validation-only states).
 */
export type DelegationLedgerStatus =
	| "running"
	| "completed"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "interrupted"
	| "tool_budget_exhausted"
	| "structured_output_failed"
	| "acceptance_failed"
	| "unavailable_context"
	| "duplicate_node";

const TERMINAL_STATUSES: readonly DelegationLedgerStatus[] = [
	"completed",
	"failed",
	"timed_out",
	"cancelled",
	"interrupted",
	"tool_budget_exhausted",
	"structured_output_failed",
	"acceptance_failed",
	"unavailable_context",
	"duplicate_node",
];

export interface DelegationLedgerEntry {
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	/** Present for launch records and most terminals; early bridge terminals may omit it. */
	agent?: string;
	status: DelegationLedgerStatus;
	runId?: string;
	childIndex?: number;
	launchContractDigest?: string;
	startedAt: number;
	endedAt?: number;
}

export interface DelegationRecordStartedInput {
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	agent: string;
}

export interface DelegationRecordTerminalInput {
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	agent?: string;
	status: Exclude<DelegationLedgerStatus, "running">;
	runId?: string;
	childIndex?: number;
	launchContractDigest?: string;
}

interface DelegationLedgerRegistry {
	version: typeof DELEGATION_LEDGER_VERSION;
	entries: Map<string, DelegationLedgerEntry>;
}

function entryKey(requestId: string, ownerRunId: string, nodeId: string): string {
	return JSON.stringify([requestId, ownerRunId, nodeId]);
}

function registry(): DelegationLedgerRegistry {
	const key = Symbol.for(DELEGATION_LEDGER_KEY);
	const target = globalThis as Record<PropertyKey, unknown>;
	const existing = target[key];
	if (existing === undefined) {
		const created: DelegationLedgerRegistry = { version: DELEGATION_LEDGER_VERSION, entries: new Map() };
		target[key] = created;
		return created;
	}
	if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
		throw new Error(`Malformed delegation ledger at Symbol.for("${DELEGATION_LEDGER_KEY}").`);
	}
	const candidate = existing as Partial<DelegationLedgerRegistry>;
	if (candidate.version !== DELEGATION_LEDGER_VERSION || !(candidate.entries instanceof Map)) {
		throw new Error(`Unsupported delegation ledger at Symbol.for("${DELEGATION_LEDGER_KEY}").`);
	}
	return candidate as DelegationLedgerRegistry;
}

function validId(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > DELEGATION_LEDGER_LIMITS.maxIdLength) {
		throw new Error(`Delegation ledger ${field} must be a non-empty string of at most ${DELEGATION_LEDGER_LIMITS.maxIdLength} characters.`);
	}
	if (/[\r\n]/.test(value)) throw new Error(`Delegation ledger ${field} must not contain line breaks.`);
	return value;
}

function boundedText(value: unknown, field: string, maxChars: number): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > maxChars || /[\r\n]/.test(value)) {
		throw new Error(`Delegation ledger ${field} must be a string of at most ${maxChars} characters without line breaks.`);
	}
	return value;
}

function timestamp(value: unknown, field: string, required: true): number;
function timestamp(value: unknown, field: string, required?: boolean): number | undefined;
function timestamp(value: unknown, field: string, required = false): number | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
		throw new Error(`Delegation ledger ${field} must be a non-negative safe timestamp.`);
	}
	return value;
}

function childIndex(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error("Delegation ledger childIndex must be a non-negative safe integer.");
	}
	return value;
}

function status(value: unknown, requireTerminal: boolean): DelegationLedgerStatus {
	if (typeof value !== "string" || !(TERMINAL_STATUSES as readonly string[]).includes(value)) {
		if (requireTerminal || value !== "running") {
			throw new Error(`Delegation ledger status must be one of: running, ${TERMINAL_STATUSES.join(", ")}.`);
		}
	}
	return value as DelegationLedgerStatus;
}

function validateEntry(value: unknown, requireTerminal: boolean): DelegationLedgerEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Delegation ledger entry must be a plain object.");
	}
	const input = value as Record<string, unknown>;
	const resolvedStatus = status(input.status, requireTerminal);
	const entry: DelegationLedgerEntry = {
		requestId: validId(input.requestId, "requestId"),
		ownerRunId: validId(input.ownerRunId, "ownerRunId"),
		nodeId: validId(input.nodeId, "nodeId"),
		agent: boundedText(input.agent, "agent", DELEGATION_LEDGER_LIMITS.maxAgentLength),
		status: resolvedStatus,
		startedAt: timestamp(input.startedAt, "startedAt", true),
		...(resolvedStatus === "running" ? {} : { endedAt: timestamp(input.endedAt, "endedAt", true) }),
	};
	const runId = boundedText(input.runId, "runId", DELEGATION_LEDGER_LIMITS.maxIdLength);
	if (runId !== undefined) entry.runId = runId;
	const digest = boundedText(input.launchContractDigest, "launchContractDigest", DELEGATION_LEDGER_LIMITS.maxDigestLength);
	if (digest !== undefined) entry.launchContractDigest = digest;
	const index = childIndex(input.childIndex);
	if (index !== undefined) entry.childIndex = index;
	return entry;
}

function evictOldestIfSaturated(): void {
	const store = registry();
	if (store.entries.size <= DELEGATION_LEDGER_LIMITS.maxEntries) return;
	const oldest = store.entries.keys().next().value;
	if (oldest !== undefined) store.entries.delete(oldest);
}

/**
 * Record that the host accepted a structured delegation and is launching the
 * child. Fails closed on malformed identity input.
 */
export function recordDelegationStarted(input: DelegationRecordStartedInput): DelegationLedgerEntry {
	const entry = validateEntry({ ...input, status: "running", startedAt: Date.now() }, false);
	const store = registry();
	store.entries.set(entryKey(entry.requestId, entry.ownerRunId, entry.nodeId), entry);
	evictOldestIfSaturated();
	return entry;
}

/**
 * Record the terminal outcome of a delegated attempt. Merges into the started
 * entry when one exists; otherwise records a standalone terminal entry so a
 * bridge restart cannot silently erase evidence of a completed run.
 */
export function recordDelegationTerminal(input: DelegationRecordTerminalInput): DelegationLedgerEntry {
	const endedAt = Date.now();
	const store = registry();
	const key = entryKey(input.requestId, input.ownerRunId, input.nodeId);
	const existing = store.entries.get(key);
	const merged = validateEntry(
		{
			...(existing ?? {}),
			...input,
			...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : { startedAt: endedAt }),
			endedAt,
		},
		true,
	);
	store.entries.set(key, merged);
	evictOldestIfSaturated();
	return merged;
}

/**
 * Look up the most recent ledger entry for a child run id. Entries are few
 * (bounded), so a reverse-order scan is sufficient and keeps the structure
 * index-free.
 */
export function getDelegationRecordByRun(
	runId: string,
	options: { agent?: string } = {},
): DelegationLedgerEntry | undefined {
	const id = validId(runId, "runId");
	const agent = options.agent === undefined ? undefined : validId(options.agent, "agent");
	const store = registry();
	const matches = [...store.entries.values()].filter(
		(entry) => entry.runId === id && (agent === undefined || entry.agent === agent),
	);
	return matches[matches.length - 1];
}

/** Bounded snapshot of the current ledger, oldest first. */
export function snapshotDelegationRecords(): readonly DelegationLedgerEntry[] {
	return [...registry().entries.values()];
}
