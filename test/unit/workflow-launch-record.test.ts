import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readWorkflowLaunchRecord } from "../../src/workflows/workflow-launch-record.ts";

describe("workflow launch record", () => {
	it("reports a missing or invalid record", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launch-record-invalid-"));
		try {
			assert.deepEqual(readWorkflowLaunchRecord(root), { ok: false, missing: true, error: "launch.json is missing" });
			const write = (value: string) => fs.writeFileSync(path.join(root, "launch.json"), value, "utf-8");
			const cases: Array<[string, RegExp]> = [
				["{not json", /^launch\.json is not valid JSON: /],
				["[]", /^launch\.json must be a JSON object$/],
				[JSON.stringify({ version: 2, source: "script", params: {}, scriptDigest: "d" }), /^launch\.json version must be 1$/],
				[JSON.stringify({ version: 1, source: "script", params: {} }), /^launch\.json scriptDigest must be a non-empty string$/],
				[JSON.stringify({ version: 1, source: "other", scriptDigest: "d" }), /^launch\.json source must be /],
				[JSON.stringify({ version: 1, source: "script", params: [], scriptDigest: "d" }), /^launch\.json params must be an object$/],
			];
			for (const [text, error] of cases) {
				write(text);
				const read = readWorkflowLaunchRecord(root);
				assert.equal(read.ok, false, text);
				assert.equal(!read.ok && read.missing, false, text);
				assert.match(!read.ok ? read.error : "", error, text);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
