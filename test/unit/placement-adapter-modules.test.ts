import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
// Importing herdr-placed-run loads the built-in Herdr and Rex adapters, so the before-herdr precedence is observable.
import "../../src/runs/shared/herdr-placed-run.ts";
import {
	PLACEMENT_ADAPTER_MODULES_ENV,
	loadPlacementAdapterModules,
	placementAdapterModuleUrls,
	placementAdapterModuleUrlsFromEnv,
} from "../../src/runs/shared/placement-adapter-modules.ts";
import { placementAdapters, type PlacementAdapterV1 } from "../../src/runs/shared/placement-registry.ts";

function fakeAdapter(provider: string, moduleUrl?: string): PlacementAdapterV1 {
	return { kind: "pi-subagents.placement-adapter", version: 1, provider, ...(moduleUrl ? { moduleUrl } : {}), async openPlacedRun() { throw new Error("unused in this test"); } };
}

function tempModuleDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "placement-modules-"));
}

describe("placement adapter modules", () => {
	it("forwards one module URL per adapter and skips adapters that only live in the host", () => {
		const urls = placementAdapterModuleUrls([
			fakeAdapter("one", "file:///adapters/one.ts"),
			fakeAdapter("two"),
			fakeAdapter("three", "file:///adapters/one.ts"),
		]);
		assert.deepEqual(urls, ["file:///adapters/one.ts"]);
		assert.deepEqual(placementAdapterModuleUrls(), [], "the built-in adapters declare no module");
	});

	it("reads the forwarded module list from the runner environment and tolerates a malformed value", () => {
		assert.deepEqual(placementAdapterModuleUrlsFromEnv('["file:///a.ts","file:///b.ts"]'), ["file:///a.ts", "file:///b.ts"]);
		assert.deepEqual(placementAdapterModuleUrlsFromEnv(undefined), []);
		assert.deepEqual(placementAdapterModuleUrlsFromEnv("not json"), []);
		assert.deepEqual(placementAdapterModuleUrlsFromEnv('{"a":1}'), []);
		assert.deepEqual(placementAdapterModuleUrlsFromEnv('["file:///a.ts",7]'), ["file:///a.ts"]);
	});

	it("imports an adapter module and lets it register into this process's registry", async () => {
		const dir = tempModuleDir();
		const modulePath = path.join(dir, "adapter.mjs");
		fs.writeFileSync(modulePath, [
			"export function registerPlacementAdapters(register) {",
			"\tregister({ kind: \"pi-subagents.placement-adapter\", version: 1, provider: \"modulepipe\", async openPlacedRun() {} }, { before: \"herdr\" });",
			"}",
		].join("\n"));
		try {
			await loadPlacementAdapterModules([pathToFileURL(modulePath).href]);
			const providers = placementAdapters().map((adapter) => adapter.provider);
			assert.ok(providers.includes("modulepipe"), `expected the module adapter to register, got ${providers.join(",")}`);
			assert.ok(providers.indexOf("modulepipe") < providers.indexOf("herdr"), "the module adapter keeps its before-herdr precedence");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a module that does not export the registration function", async () => {
		const dir = tempModuleDir();
		const modulePath = path.join(dir, "not-an-adapter.mjs");
		fs.writeFileSync(modulePath, "export const something = 1;\n");
		try {
			await assert.rejects(
				() => loadPlacementAdapterModules([pathToFileURL(modulePath).href]),
				new RegExp(`does not export registerPlacementAdapters`, "u"),
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("names the environment variable the parent sets for the runner", () => {
		assert.equal(PLACEMENT_ADAPTER_MODULES_ENV, "PI_SUBAGENTS_PLACEMENT_ADAPTERS");
	});
});
