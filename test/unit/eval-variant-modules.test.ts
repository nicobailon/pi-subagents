import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  requiredVariantFiles,
  resolveSdkEntry,
  variantRootError,
} from "../eval/lib/variant-modules.ts";

function temporaryDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("paired evaluator variant roots", () => {
  it("reports every missing file for the selected variant", () => {
    const root = temporaryDirectory("catalog-eval-variant-");
    const error = variantRootError(root, "catalog");
    assert.notEqual(error, null);
    for (const relative of requiredVariantFiles("catalog")) {
      assert.match(error ?? "", new RegExp(relative.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    }
  });

  it("accepts a variant root only after all required files exist", () => {
    const root = temporaryDirectory("catalog-eval-complete-variant-");
    for (const relative of requiredVariantFiles("baseline")) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "export {};\n");
    }
    assert.equal(variantRootError(root, "baseline"), null);
  });

  it("resolves only an existing production SDK entry", () => {
    const root = temporaryDirectory("catalog-eval-sdk-");
    const entry = path.join(root, "dist", "index.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "export {};\n");

    assert.equal(resolveSdkEntry(root), entry);
    assert.equal(resolveSdkEntry(entry), entry);
    assert.equal(resolveSdkEntry(path.join(root, "missing")), "");
  });
});
