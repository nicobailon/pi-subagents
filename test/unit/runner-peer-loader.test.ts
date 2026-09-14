import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const loaderUrl = new URL("../../runner-peer-loader.mjs", import.meta.url);
const hostModules = path.join(os.tmpdir(), "runner-peer-loader-host", "node_modules", "@earendil-works");
const aliases = {
	"@earendil-works/pi-tui": path.join(hostModules, "pi-tui", "dist", "index.js"),
	"@earendil-works/pi-ai": path.join(hostModules, "pi-ai", "dist", "index.js"),
};
const passthrough = (specifier: string) => ({ url: specifier, shortCircuit: true });

test("fallback loader aliases every host peer for a plain-JavaScript runner", async () => {
	const loader = await import(`${loaderUrl.href}?native`);
	loader.initialize({ aliases, nativeRunner: true });
	assert.equal(loader.resolve("@earendil-works/pi-ai", {}, passthrough).url, pathToFileURL(aliases["@earendil-works/pi-ai"]).href);
	assert.equal(loader.resolve("@earendil-works/pi-tui", {}, passthrough).url, pathToFileURL(aliases["@earendil-works/pi-tui"]).href);
	assert.equal(loader.resolve("node:fs", {}, passthrough).url, "node:fs");
});

test("fallback loader redirects only the TUI for a jiti-hosted TypeScript runner", async () => {
	const loader = await import(`${loaderUrl.href}?jiti`);
	loader.initialize({ aliases });
	assert.equal(loader.resolve("@earendil-works/pi-ai", {}, passthrough).url, "@earendil-works/pi-ai");
	assert.equal(loader.resolve("@earendil-works/pi-tui", {}, passthrough).url, pathToFileURL(aliases["@earendil-works/pi-tui"]).href);
});
