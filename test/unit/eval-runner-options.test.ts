import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseRunnerOptions } from "../eval/lib/runner-options.ts";

function requiredArguments(root: string): string[] {
  return ["--baseline-root", root, "--pi-sdk", root, "--model", "provider/model"];
}

describe("paired evaluator provider extension options", () => {
  it("preserves repeated explicit provider extension files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-eval-options-"));
    const first = path.join(root, "first-provider.js");
    const second = path.join(root, "second-provider.js");
    fs.writeFileSync(first, "export default () => {};\n");
    fs.writeFileSync(second, "export default () => {};\n");

    const parsed = parseRunnerOptions(
      [...requiredArguments(root), "--provider-extension", first, "--provider-extension", second],
      {},
      { repoRoot: root, cwd: root },
    );

    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.options?.providerExtensions, [first, second]);
  });

  it("rejects a provider extension path that is not a file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-eval-options-missing-"));
    const missing = path.join(root, "missing-provider.js");

    const parsed = parseRunnerOptions(
      [...requiredArguments(root), "--provider-extension", missing],
      {},
      { repoRoot: root, cwd: root },
    );

    assert.match(parsed.error ?? "", /provider extension.*does not exist/i);
    assert.equal(parsed.options, null);
  });
});
