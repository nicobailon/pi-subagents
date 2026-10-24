import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readWorkflowLaunchRecord, writeWorkflowLaunchRecord, type WorkflowLaunchRecord } from "../../src/workflows/workflow-launch-record.ts";

describe("workflow launch record", () => {
	it("round-trips script, resource, and structured launches", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launch-record-"));
		try {
			const records: WorkflowLaunchRecord[] = [
				{ version: 1, source: "script", params: { workflowScript: "return 1;", args: { n: 1 }, cwd: "/repo" }, scriptDigest: "digest-a" },
				{ version: 1, source: "resource", params: { workflow: "review", args: { pr: 7 }, cwd: "/repo" }, scriptDigest: "digest-b", resourceName: "review" },
				{ version: 1, source: "structured", scriptDigest: "digest-c" },
			];
			for (const [index, record] of records.entries()) {
				const asyncDir = path.join(root, `run-${index}`);
				fs.mkdirSync(asyncDir);
				writeWorkflowLaunchRecord(asyncDir, record);
				assert.deepEqual(readWorkflowLaunchRecord(asyncDir), { ok: true, record });
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

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
				[JSON.stringify({ version: 1, source: "resource", params: {}, scriptDigest: "d" }), /^launch\.json resourceName must be a non-empty string$/],
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
