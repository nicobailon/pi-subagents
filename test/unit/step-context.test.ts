import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeStepContextFile, type StepContext } from "../../src/runs/shared/step-context.ts";

function mkTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "pi-sub-step-context-test-"));
}

describe("writeStepContextFile", () => {
    let tmpDir: string | undefined;

    afterEach(() => {
        if (tmpDir) {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup is best-effort */ }
            tmpDir = undefined;
        }
    });

    it("writes step context file with all fields populated", () => {
        tmpDir = mkTempDir();
        const runId = "abc12345";

        const filePath = writeStepContextFile(tmpDir, {
            chain_dir: "/tmp/fake-chain-dir",
            step_index: 0,
            agent: "scout",
            output: path.join(tmpDir, "context.md"),
            reads: ["plan.md"],
            inputs: {
                scan: {
                    text: '{"files":["auth.ts"]}',
                    structured: { files: ["auth.ts"] },
                },
            },
            run_id: runId,
            artifacts_dir: tmpDir,
            sessionFile: "/tmp/sessions/run-0/session.jsonl",
        });

        assert.ok(fs.existsSync(filePath));
        // Verify the filename matches the artifact naming scheme
        assert.strictEqual(path.basename(filePath), "abc12345_scout_0_context.json");
        const raw = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw) as StepContext;

        assert.strictEqual(data.agent, "scout");
        assert.strictEqual(data.run_id, runId);
        assert.strictEqual(data.artifacts_dir, tmpDir);
        assert.strictEqual(data.reads.length, 1);
        assert.strictEqual(data.reads[0], "plan.md");
        assert.strictEqual(data.output, path.join(tmpDir, "context.md"));
        assert.strictEqual(data.inputs.scan.text, '{"files":["auth.ts"]}');
        assert.deepStrictEqual(data.inputs.scan.structured, { files: ["auth.ts"] });
        assert.strictEqual(data.sessionFile, "/tmp/sessions/run-0/session.jsonl");
    });

    it("writes step context file with empty reads and no inputs (first step)", () => {
        tmpDir = mkTempDir();

        const filePath = writeStepContextFile(tmpDir, {
            chain_dir: "/tmp/fake-chain-dir",
            step_index: 0,
            agent: "planner",
            reads: [],
            inputs: {},
            run_id: "run001",
            artifacts_dir: tmpDir,
        });

        assert.strictEqual(path.basename(filePath), "run001_planner_0_context.json");
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as StepContext;
        assert.strictEqual(data.reads.length, 0);
        assert.strictEqual(Object.keys(data.inputs).length, 0);
        assert.strictEqual(data.output, undefined);
    });

    it("writes step context file without output (no output configured)", () => {
        tmpDir = mkTempDir();

        const filePath = writeStepContextFile(tmpDir, {
            chain_dir: "/tmp/fake-chain-dir",
            step_index: 2,
            agent: "reviewer",
            reads: ["context.md"],
            inputs: {},
            run_id: "run002",
            artifacts_dir: tmpDir,
        });

        assert.strictEqual(path.basename(filePath), "run002_reviewer_2_context.json");
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as StepContext;
        assert.strictEqual(data.output, undefined);
    });

    it("omits sessionFile when undefined", () => {
        tmpDir = mkTempDir();
        const runId = "run003";

        const filePath = writeStepContextFile(tmpDir, {
            chain_dir: "/tmp/fake-chain-dir",
            step_index: 0,
            agent: "scout",
            reads: [],
            inputs: {},
            run_id: runId,
            artifacts_dir: tmpDir,
        });

        const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as StepContext;
        assert.strictEqual(data.sessionFile, undefined);
        assert.strictEqual(Object.keys(data).includes("sessionFile"), false);
    });

    it("multiple successive steps write distinct files", () => {
        tmpDir = mkTempDir();
        const runId = "abc12345";

        writeStepContextFile(tmpDir, { chain_dir: "/tmp/chain", step_index: 0, agent: "scout", reads: [], inputs: {}, run_id: runId, artifacts_dir: tmpDir });
        writeStepContextFile(tmpDir, { chain_dir: "/tmp/chain", step_index: 1, agent: "planner", reads: [], inputs: {}, run_id: runId, artifacts_dir: tmpDir });
        writeStepContextFile(tmpDir, { chain_dir: "/tmp/chain", step_index: 2, agent: "worker", reads: [], inputs: {}, run_id: runId, artifacts_dir: tmpDir });

        assert.ok(fs.existsSync(path.join(tmpDir, "abc12345_scout_0_context.json")));
        assert.ok(fs.existsSync(path.join(tmpDir, "abc12345_planner_1_context.json")));
        assert.ok(fs.existsSync(path.join(tmpDir, "abc12345_worker_2_context.json")));
    });
});
