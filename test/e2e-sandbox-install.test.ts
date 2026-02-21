/**
 * E2E test: npm pack + install sandbox verification.
 *
 * Uses pi-test-harness verifySandboxInstall() to ensure the published package
 * can be installed cleanly and loads expected extensions/tools.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { tryImport } from "./helpers.ts";

const harness = await tryImport<any>("@marcfargas/pi-test-harness");
const available = !!harness;
const PACKAGE_DIR = path.resolve(".");

describe(
	"sandbox install",
	{ skip: !available ? "pi-test-harness not available" : undefined },
	() => {
		const { verifySandboxInstall } = harness;

		it("loads extension after npm pack+install with expected tools", { timeout: 120_000 }, async () => {
			const result = await verifySandboxInstall({
				packageDir: PACKAGE_DIR,
				expect: {
					extensions: 2,
					tools: ["subagent", "subagent_status"],
				},
			});

			assert.deepEqual(result.loaded.extensionErrors, []);
			assert.equal(result.loaded.extensions, 2);
			assert.ok(result.loaded.tools.includes("subagent"));
			assert.ok(result.loaded.tools.includes("subagent_status"));
		});
	},
);
