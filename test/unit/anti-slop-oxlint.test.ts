import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const oxlint = path.join(projectRoot, "node_modules", "oxlint", "bin", "oxlint");
const config = path.join(projectRoot, ".oxlintrc.json");

function lintFixture(source: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-anti-slop-"));
	try {
		const fixture = path.join(root, "rules.ts");
		fs.writeFileSync(fixture, source, "utf8");
		const result = spawnSync(process.execPath, [oxlint, "--config", config, "--format", "json", fixture], {
			cwd: projectRoot,
			encoding: "utf8",
		});
		const stdout = String(result.stdout ?? "");
		const processOutput = [String(result.stderr ?? ""), stdout].filter(Boolean).join("\n").trim() || "(no output)";
		if (result.error) assert.fail(`Oxlint setup failed to start: ${result.error.message}\n${processOutput}`);
		if (result.status === null) assert.fail(`Oxlint setup failed before producing a result:\n${processOutput}`);

		let lintResult: unknown;
		try {
			lintResult = JSON.parse(stdout);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			assert.fail(`Oxlint setup/configuration failed before producing a JSON lint result: ${message}\n${processOutput}`);
		}
		const diagnostics = lintResult !== null && typeof lintResult === "object" && "diagnostics" in lintResult ? lintResult.diagnostics : undefined;
		assert.ok(Array.isArray(diagnostics), `Oxlint setup/configuration did not produce a JSON lint result with diagnostics:\n${processOutput}`);
		assert.notEqual(result.status, 0, result.stderr);
		return stdout;
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe("anti-slop Oxlint plugin", () => {
	it("loads every configured rule and reports representative violations without flagging safe counterparts", () => {
		const output = lintFixture(String.raw`
vi.mock("module");
Reflect.apply(() => {}, null, []);
const shapeSignal = 1;
type Hidden = unknown;
type HiddenUnion = string | unknown;
export type ConcreteAlias = string | number;
type T = string;
type Fixed = T;
type Wrap<T> = Fixed | { item: T };
export type WrappedAlias = Wrap<unknown>;
const broadValue: object = { id: 1 };
const narrowedValue = broadValue as { id: number };
const spreadTotals = [1, 2].reduce((totals, item) => ({ ...totals, [item]: item }), {});
const copiedTotals = [1, 2].reduce((totals, item) => Object.assign({}, totals, { [item]: item }), {});

export const safeTotals = [1, 2].reduce<Record<number, number>>((totals, item) => { totals[item] = item; return totals; }, {});
export const safeConst = "x" as const;
`);
		const rules = [
			"anti-slop(no-module-mocking)",
			"anti-slop(no-reduce-accumulator-copy)",
			"anti-slop(no-reflect-apply)",
			"anti-slop(no-shape-in-symbol-names)",
			"anti-slop(no-unknown-type-aliases)",
			"anti-slop(no-widen-then-assert)",
			"oxc(no-accumulating-spread)",
		];
		for (const rule of rules) assert.ok(output.includes(`"code": "${rule}"`), `missing ${rule}`);
		assert.ok(output.includes("Type alias `HiddenUnion` hides `unknown`."), "missing union unknown alias");
		assert.equal(output.includes("Type alias `ConcreteAlias` hides `unknown`."), false);
		assert.equal(output.includes("Type alias `WrappedAlias` hides `unknown`."), false);
		for (const safeName of ["safeTotals", "safeConst"]) {
			assert.equal(output.includes(safeName), false, `unexpected diagnostic for ${safeName}`);
		}
	});
});
