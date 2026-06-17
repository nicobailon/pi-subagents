import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseTaskText, findContextFile, loadContextFile } from "../../src/determinator/extension.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "determinator-test-"));
  tempDirs.push(dir);
  return dir;
}

// ── parseTaskText ──────────────────────────────────────────────────────────

describe("parseTaskText", () => {
  it("parses valid JSON with script and params", () => {
    const result = parseTaskText(
      '{"script": "/path/to/script.ts", "params": {"threshold": 0.5}}',
    );
    assert.equal(result.scriptPath, "/path/to/script.ts");
    assert.deepEqual(result.params, { threshold: 0.5 });
    assert.deepEqual(result.reads, []);
    assert.equal(result.writeTo, null);
  });

  it("parses JSON with only script field", () => {
    const result = parseTaskText('{"script": "./check.ts"}');
    assert.equal(result.scriptPath, "./check.ts");
    assert.deepEqual(result.params, {});
    assert.deepEqual(result.reads, []);
  });

  it("falls back to first line as script path when text is not JSON", () => {
    const result = parseTaskText("/abs/path/to/script.ts\nsome extra text");
    assert.equal(result.scriptPath, "/abs/path/to/script.ts");
    assert.deepEqual(result.params, {});
  });

  it("skips comments and --- lines in fallback mode", () => {
    const result = parseTaskText("# comment\n---\n/actual/script.ts\nmore text");
    assert.equal(result.scriptPath, "/actual/script.ts");
  });

  it("returns empty scriptPath for empty text", () => {
    const result = parseTaskText("");
    assert.equal(result.scriptPath, "");
  });

  it("extracts [Read from: ...] prefixes", () => {
    const result = parseTaskText(
      "[Read from: /tmp/file1.md, /tmp/file2.md]\n\n/script.ts",
    );
    assert.deepEqual(result.reads, ["/tmp/file1.md", "/tmp/file2.md"]);
    assert.equal(result.scriptPath, "/script.ts");
  });

  it("extracts [Write to: ...] prefix", () => {
    const result = parseTaskText(
      "[Write to: /chain/output.md]\n\n/script.ts",
    );
    assert.equal(result.writeTo, "/chain/output.md");
    assert.equal(result.scriptPath, "/script.ts");
  });

  it("handles JSON body after chain prefix lines", () => {
    const result = parseTaskText(
      '[Read from: /chain/context.md]\n[Write to: /chain/output.md]\n\n{"script": "./analyze.ts", "params": {"verbose": true}}',
    );
    assert.deepEqual(result.reads, ["/chain/context.md"]);
    assert.equal(result.writeTo, "/chain/output.md");
    assert.equal(result.scriptPath, "./analyze.ts");
    assert.deepEqual(result.params, { verbose: true });
  });

  it("ignores params that are arrays (must be object)", () => {
    const result = parseTaskText(
      '{"script": "./s.ts", "params": [1, 2, 3]}',
    );
    assert.equal(result.scriptPath, "./s.ts");
    assert.deepEqual(result.params, {});
  });

  it("accepts empty object params", () => {
    const result = parseTaskText('{"script": "./s.ts", "params": {}}');
    assert.equal(result.scriptPath, "./s.ts");
    assert.deepEqual(result.params, {});
  });

  it("keeps body text without prefix lines", () => {
    const result = parseTaskText(
      '[Write to: /chain/out.md]\n\n{"script": "./s.ts", "params": {"x": 1}}',
    );
    assert.equal(result.body, '{"script": "./s.ts", "params": {"x": 1}}');
  });

  it("ignores invalid JSON gracefully and falls back", () => {
    const result = parseTaskText("{invalid json /path/to/script.ts");
    assert.equal(result.scriptPath, "{invalid json /path/to/script.ts");
    assert.deepEqual(result.params, {});
  });

  it("extracts multiple reads from single [Read from:] line", () => {
    const result = parseTaskText(
      "[Read from: /tmp/a.md, /tmp/b.md, /tmp/c.md]\n\n/script.ts",
    );
    assert.deepEqual(result.reads, ["/tmp/a.md", "/tmp/b.md", "/tmp/c.md"]);
  });
});

// ── findContextFile / loadContextFile ───────────────────────────────────────

describe("findContextFile", () => {
  it("returns null when chainDir does not exist", () => {
    const result = findContextFile("/nonexistent/dir", "run-123");
    assert.equal(result, null);
  });

  it("finds context file by runId prefix", () => {
    const dir = makeTempDir();
    const contextFile = path.join(dir, "run-abc_scout_0_context.json");
    fs.writeFileSync(contextFile, "{}", "utf-8");
    fs.writeFileSync(path.join(dir, "other-file.txt"), "x", "utf-8");

    const result = findContextFile(dir, "run-abc");
    assert.ok(result);
    assert.ok(result!.endsWith("run-abc_scout_0_context.json"));
  });

  it("returns null when no context file matches runId", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "run-xyz_worker_1_context.json"),
      "{}",
      "utf-8",
    );

    const result = findContextFile(dir, "run-abc");
    assert.equal(result, null);
  });
});

describe("loadContextFile", () => {
  it("parses a valid context.json and returns StepContext", () => {
    const dir = makeTempDir();
    const contextFile = path.join(dir, "r1_determinator_0_context.json");
    const contextData = {
      chain_dir: dir,
      step_index: 0,
      agent: "determinator",
      output: path.join(dir, "output.md"),
      reads: [path.join(dir, "input.md")],
      inputs: {},
      run_id: "r1",
      artifacts_dir: path.join(dir, "artifacts"),
    };
    fs.writeFileSync(contextFile, JSON.stringify(contextData), "utf-8");

    const result = loadContextFile(dir, "r1");
    assert.ok(result);
    assert.equal(result!.chain_dir, dir);
    assert.equal(result!.agent, "determinator");
    assert.equal(result!.output, path.join(dir, "output.md"));
    assert.deepEqual(result!.reads, [path.join(dir, "input.md")]);
  });

  it("returns null for invalid JSON", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "r2_determinator_0_context.json"),
      "not json {{{",
      "utf-8",
    );

    const result = loadContextFile(dir, "r2");
    assert.equal(result, null);
  });
});
