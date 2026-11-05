import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { runLaunchDir } from "../../src/runs/shared/run-launch-folder.ts";
import { readWorkflowLaunchRecord } from "../../src/workflows/workflow-launch-record.ts";
import { writeFileCreatingDir } from "../support/helpers.ts";

describe("workflow launch record", () => {
	it("reports a missing or invalid record", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launch-record-invalid-"));
		try {
			const runs = path.join(root, "async-subagent-runs");
			assert.deepEqual(readWorkflowLaunchRecord(runs, "run"), { ok: false, missing: true, error: "launch.json is missing" });
			const write = (value: string) => writeFileCreatingDir(path.join(runLaunchDir(runs, "run"), "launch.json"), value);
			const cases: Array<[string, RegExp]> = [
				["{not json", /^not valid JSON: /],
				["[]", /^not a JSON object$/],
				[JSON.stringify({ version: 1, sessionId: "s", source: "script", params: {}, scriptDigest: "d" }), /^version must be 2$/],
				[JSON.stringify({ version: 2, sessionId: "s", source: "script", params: {} }), /^scriptDigest must be a non-empty string$/],
				[JSON.stringify({ version: 2, source: "script", params: {}, scriptDigest: "d" }), /^sessionId must be a non-empty string$/],
				[JSON.stringify({ version: 2, sessionId: "s", source: "script", params: {}, scriptDigest: "d", admissionCapabilityCeiling: { version: 9 } }), /admissionCapabilityCeiling/],
				[JSON.stringify({ version: 2, sessionId: "s", source: "other", scriptDigest: "d" }), /^source must be "script", "resource", "structured", or "internal"$/],
				[JSON.stringify({ version: 2, sessionId: "s", source: "script", params: [], scriptDigest: "d" }), /^params must be an object$/],
			];
			for (const [text, error] of cases) {
				write(text);
				const read = readWorkflowLaunchRecord(runs, "run");
				assert.equal(read.ok, false, text);
				assert.equal(!read.ok && read.missing, false, text);
				assert.match(!read.ok ? read.error : "", error, text);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
