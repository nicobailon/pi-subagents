const MAX_SCOPE_ENTRIES = 8;
const MAX_SCOPE_ENTRY_CHARS = 2_000;
const MAX_SCOPE_TOTAL_CHARS = 16_000;

export interface WatchdogScopeEntry {
	prompt: string;
	createdAt: string;
}

export class WatchdogScopeArtifact {
	private entries: WatchdogScopeEntry[] = [];

	addPrompt(prompt: string, options: { createdAt?: string } = {}): void {
		const normalized = prompt.trim();
		if (!normalized) return;
		this.entries.push({
			prompt: normalized.length > MAX_SCOPE_ENTRY_CHARS ? normalized.slice(0, MAX_SCOPE_ENTRY_CHARS) : normalized,
			createdAt: options.createdAt ?? new Date().toISOString(),
		});
		this.trim();
	}

	reset(): void {
		this.entries = [];
	}

	snapshot(): WatchdogScopeEntry[] {
		return this.entries.map((entry) => ({ ...entry }));
	}

	render(): string {
		if (!this.entries.length) return "";
		return [
			"Current scope:",
			"The following real user prompts are the current scope record, newest last. Side questions are additive, not scope drift or cancellation of older objectives; only explicit changes supersede requirements. Use watchdog_warn for evidence-backed reminders of forgotten authorized work, not dependencies still pending or explicit holds. The orchestrator owns task tracking. Flag unauthorized work as category 'scope-drift'.",
			...this.entries.map((entry, index) => [
				`Scope prompt ${index + 1} (${entry.createdAt}):`,
				entry.prompt,
			].join("\n")),
		].join("\n\n");
	}

	private trim(): void {
		while (this.entries.length > MAX_SCOPE_ENTRIES) this.entries.shift();
		let total = this.entries.reduce((sum, entry) => sum + entry.prompt.length, 0);
		while (this.entries.length > 1 && total > MAX_SCOPE_TOTAL_CHARS) {
			const removed = this.entries.shift();
			if (removed) total -= removed.prompt.length;
		}
	}
}
