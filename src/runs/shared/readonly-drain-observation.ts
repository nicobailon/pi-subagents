const knownStates = new Set(["queued", "running", "complete", "failed", "partial", "paused", "stopped", "rejected"]);

/**
 * Private, installation-owned evidence. Never changes drain/query behavior or retains statuses.
 * Observes the ordinary indexed drain, not historical ownership or outside work appearing later.
 */
export class ReadonlyDrainObservation {
	private state: "pending" | "empty" | "denied" = "pending";
	private started = false;
	private first = false;
	private readonly file: string;
	private readonly guard: () => boolean;
	constructor(file: string, guard: () => boolean) { this.file = file; this.guard = guard; }
	deny(): void { this.state = "denied"; }
	check(): boolean {
		try { if (!this.guard()) this.deny(); } catch { this.deny(); }
		return this.state !== "denied";
	}
	begin(file: string | null, native: boolean): void {
		if (this.started || file !== this.file || !native) this.deny();
		this.started = true;
		this.check();
	}
	/** Called at the existing initial read, before reconciliation or filtering. */
	readonly status = (status: { sessionId?: unknown; state?: unknown } | null): void => {
		if (!status || typeof status.sessionId !== "string" || !status.sessionId
			|| !knownStates.has(status.state as string)) this.deny();
		else if (status.sessionId === this.file && (status.state === "queued" || status.state === "running")) this.deny();
	};
	predicate(hasWork: boolean): void {
		if (this.first) return;
		this.first = true;
		if (hasWork) this.deny();
	}
	complete(): void {
		if (this.started && this.first && this.check()) this.state = "empty";
	}
	settled(): boolean { return this.check() && this.state === "empty"; }
}

/** Internal synchronous sink; null means an existing query encountered uncertainty. */
export type RawDrainStatusObserver = (status: { sessionId?: unknown; state?: unknown } | null) => void;
