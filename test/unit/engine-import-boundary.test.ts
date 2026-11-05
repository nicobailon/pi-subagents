/**
 * Source-level architecture guard: the engine layer (src/runs/**) must not
 * gain new imports from the TUI layer (src/tui/**). Pure file reads, no code
 * executed.
 *
 * Rationale: background runs (run status, async execution) also serve embedded
 * hosts that never mount a terminal UI, and every reverse dependency makes the
 * engine harder to load without TUI code. Transcript parsing lives in
 * src/shared/fleet-transcript-reader.ts for exactly this reason.
 *
 * Known offender below stays until renderWidget gets a seam outside the
 * runner lifecycle; the guard keeps the set from growing.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const KNOWN_OFFENDERS = new Set([
	join(ROOT, "src", "runs", "background", "async-job-tracker.ts"),
]);

test("src/runs/** engine layer must not gain tui imports", async () => {
	const offenders: string[] = [];
	async function scan(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await scan(full);
			} else if (entry.name.endsWith(".ts")) {
				const source = await readFile(full, "utf8");
				if (/from\s+"[^"]*\/tui\//.test(source)) offenders.push(full);
			}
		}
	}
	await scan(join(ROOT, "src", "runs"));
	const unexpected = offenders.filter((file) => !KNOWN_OFFENDERS.has(file));
	assert.deepEqual(
		unexpected,
		[],
		`Engine layer gained a new tui reverse dependency:\n${unexpected.join("\n")}`,
	);
});
