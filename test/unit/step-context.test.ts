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

        const filePath = writeStepContextFile(tmpDir, {
            chain_dir: tmpDir,
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
        });

        assert.ok(fs.existsSync(filePath));
        const raw = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw) as StepContext;

        assert.strictEqual(data.agent, "scout");
        assert.strictEqual(data.reads.length, 1);
        assert.strictEqual(data.reads[0], "plan.md");
        assert.strictEqual(data.output, path.join(tmpDir, "context.md"));
        assert.strictEqual(data.inputs.scan.text, '{"files":["auth.ts"]}');
        assert.deepStrictEqual(data.inputs.scan.structured, { files: ["auth.ts"] });
    });

    it("writes step context file with empty reads and no inputs (first step)", () => {
        tmpDir = mkTempDir();

        const filePath = writeStepContextFile(tmpDir, {
            chain_dir: tmpDir,
            step_index: 0,
            agent: "planner",
            reads: [],
            inputs: {},
        });

        const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as StepContext;
        assert.strictEqual(data.reads.length, 0);
        assert.strictEqual(Object.keys(data.inputs).length, 0);
        assert.strictEqual(data.output, undefined);
    });

    it("writes step context file without output (no output configured)", () => {
        tmpDir = mkTempDir();

        const filePath = writeStepContextFile(tmpDir, {
            chain_dir: tmpDir,
            step_index: 2,
            agent: "reviewer",
            reads: ["context.md"],
            inputs: {},
        });

        const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as StepContext;
        assert.strictEqual(data.output, undefined);
    });

    it("multiple successive steps write distinct files", () => {
        tmpDir = mkTempDir();

        writeStepContextFile(tmpDir, { chain_dir: tmpDir, step_index: 0, agent: "scout", reads: [], inputs: {} });
        writeStepContextFile(tmpDir, { chain_dir: tmpDir, step_index: 1, agent: "planner", reads: [], inputs: {} });
        writeStepContextFile(tmpDir, { chain_dir: tmpDir, step_index: 2, agent: "worker", reads: [], inputs: {} });

        assert.ok(fs.existsSync(path.join(tmpDir, "step-0-context.json")));
        assert.ok(fs.existsSync(path.join(tmpDir, "step-1-context.json")));
        assert.ok(fs.existsSync(path.join(tmpDir, "step-2-context.json")));
    });
});
