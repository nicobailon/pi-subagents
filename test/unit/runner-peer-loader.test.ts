import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const loaderUrl = new URL("../../runner-peer-loader.mjs", import.meta.url);
const packageRootUrl = new URL("../../", import.meta.url).href;
const hostModules = path.join(os.tmpdir(), "runner-peer-loader-host", "node_modules", "@earendil-works");
const aliases = {
	"@earendil-works/pi-tui": path.join(hostModules, "pi-tui", "dist", "index.js"),
	"@earendil-works/pi-ai": path.join(hostModules, "pi-ai", "dist", "index.js"),
};
test("native preload leaves the SDK extension loader's require.resolve intact", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-extension-resolve-"));
	try {
		const sdkLoader = path.join(root, "host", "dist", "core", "extensions", "loader.js");
		const typeboxRoot = path.join(root, "host", "node_modules", "typebox");
		const target = path.join(typeboxRoot, "index.mjs");
		fs.mkdirSync(path.dirname(sdkLoader), { recursive: true });
		fs.mkdirSync(typeboxRoot, { recursive: true });
		fs.writeFileSync(sdkLoader, "");
		fs.writeFileSync(target, "export const Type = {};\n");
		fs.writeFileSync(path.join(typeboxRoot, "package.json"), JSON.stringify({ name: "typebox", type: "module", exports: "./index.mjs" }));
		const child = spawnSync(process.execPath, [
			"--import", new URL("../../runner-peer-preload.mjs", import.meta.url).href,
			"--input-type=module", "-e",
			"import { createRequire } from 'node:module'; console.log(createRequire(process.argv[1]).resolve('typebox'));",
			sdkLoader,
		], {
			encoding: "utf8",
			env: { ...process.env, JITI_ALIAS: JSON.stringify({ typebox: target }), PI_ASYNC_NATIVE_RUNNER: "1" },
			timeout: 10_000,
		});
		assert.equal(child.status, 0, child.stderr);
		assert.equal(child.stdout.trim(), fs.realpathSync(target));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

const passthrough = (specifier: string) => ({ url: specifier, shortCircuit: true });

test("fallback loader aliases every host peer for a plain-JavaScript runner", async () => {
	const loader = await import(`${loaderUrl.href}?native`);
	loader.initialize({ aliases, nativeRunner: true });
	const packageContext = { parentURL: new URL("src/runs/background/subagent-runner.js", packageRootUrl).href };
	assert.equal(loader.resolve("@earendil-works/pi-ai", packageContext, passthrough).url, pathToFileURL(aliases["@earendil-works/pi-ai"]).href);
	assert.equal(loader.resolve("@earendil-works/pi-tui", packageContext, passthrough).url, pathToFileURL(aliases["@earendil-works/pi-tui"]).href);
	assert.equal(loader.resolve("node:fs", packageContext, passthrough).url, "node:fs");
	assert.equal(loader.resolve("@earendil-works/pi-ai", { parentURL: "file:///host/pi-loader.js" }, passthrough).url, pathToFileURL(aliases["@earendil-works/pi-ai"]).href);
});

test("fallback loader aliases external imports for a native TypeScript runner", async () => {
	const loader = await import(`${loaderUrl.href}?native-typescript`);
	loader.initialize({ aliases, nativeRunner: true });
	assert.equal(loader.resolve("@earendil-works/pi-ai", { parentURL: "file:///tmp/child-factory.mjs" }, passthrough).url, pathToFileURL(aliases["@earendil-works/pi-ai"]).href);
});

test("fallback loader redirects only the TUI for a jiti-hosted TypeScript runner", async () => {
	const loader = await import(`${loaderUrl.href}?jiti`);
	loader.initialize({ aliases });
	assert.equal(loader.resolve("@earendil-works/pi-ai", {}, passthrough).url, "@earendil-works/pi-ai");
	assert.equal(loader.resolve("@earendil-works/pi-tui", {}, passthrough).url, pathToFileURL(aliases["@earendil-works/pi-tui"]).href);
});
