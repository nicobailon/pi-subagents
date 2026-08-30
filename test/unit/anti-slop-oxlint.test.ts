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
const chained = ("value" as string) as number;
const conditional = { ...(true ? { value: 1 } : {}) };
const widened: unknown = "known";
vi.mock("module");
function broad(parameter: object): void { void parameter; }
Reflect.apply(() => {}, null, []);
Reflect.get({ key: "value" }, "key");
function runtime(value: string): boolean { return typeof value === "string"; }
const shapeSignal = 1;
function unknownInput(value: unknown): void { void value; }
function unknownOutput(): unknown { return null; }
type Hidden = unknown;
type HiddenUnion = string | unknown;
export type ConcreteAlias = string | number;
type Opaque = object;
type ConditionalFunction = unknown extends infer Opaque ? (conditionalValue: Opaque) => void : never;
const dictionary: Record<string, unknown> = {};
const broadValue: object = { id: 1 };
const narrowedValue = broadValue as { id: number };
const asserted = "x" as string;

export function safeObjectInput(parameter: { id: number }): void { void parameter; }
export function safeCauseInput(cause: unknown): void { void cause; }
export const safeDictionary: Record<string, string> = {};
export const safeSpread = { ...(true ? { value: 1 } : { value: 2 }) };
export const safeConst = "x" as const;
`);
		const rules = [
			"no-chained-type-assertions",
			"no-conditional-empty-object-spread",
			"no-known-value-widening",
			"no-module-mocking",
			"no-object-parameters",
			"no-reflect-apply",
			"no-reflect-get",
			"no-runtime-typeof",
			"no-shape-in-symbol-names",
			"no-unknown-parameters",
			"no-unknown-returns",
			"no-unknown-type-aliases",
			"no-unsafe-dictionary-type",
			"no-widen-then-assert",
			"require-safety-comment-for-type-assertion",
		];
		for (const rule of rules) assert.ok(output.includes(`"code": "anti-slop(${rule})"`), `missing ${rule}`);
		assert.ok(output.includes("Type alias `HiddenUnion` hides `unknown`."), "missing union unknown alias");
		assert.equal(output.includes("Type alias `ConcreteAlias` hides `unknown`."), false);
		assert.equal(output.includes("Parameter `conditionalValue` uses the broad `object` type."), false);
		for (const safeName of ["safeObjectInput", "safeCauseInput", "safeDictionary", "safeSpread", "safeConst"]) {
			assert.equal(output.includes(safeName), false, `unexpected diagnostic for ${safeName}`);
		}
	});
});
