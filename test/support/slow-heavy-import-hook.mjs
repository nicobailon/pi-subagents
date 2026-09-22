/**
 * Test-only loader hook: redirect the runner's execution-graph import to a stub
 * that resolves only after a fixed delay.
 *
 * Usage: node --import <this file> --experimental-strip-types <runner-bootstrap.ts> <config>
 *
 * Delays are applied in the hook's own thread, so the runner keeps running: the
 * startup handshake must be published before the delayed import is awaited
 * (issue #2403).
 */
import { register } from "node:module";

const markerPath = process.env.PI_SUBAGENTS_TEST_HEAVY_IMPORT_MARKER;
const delayMs = Number(process.env.PI_SUBAGENTS_TEST_HEAVY_IMPORT_DELAY_MS ?? 4000);
const failImport = process.env.PI_SUBAGENTS_TEST_HEAVY_IMPORT_FAIL === "1";

if (markerPath || failImport) {
	register(new URL("./slow-heavy-import-loader.mjs", import.meta.url), {
		data: {
			markerPath,
			failImport,
			delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 0,
			stubUrl: new URL("./stub-heavy-runner.mjs", import.meta.url).href,
		},
	});
}
