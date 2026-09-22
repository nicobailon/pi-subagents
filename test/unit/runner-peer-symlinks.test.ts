import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolveHostPeerAliases } from "../../src/runs/background/runner-aliases.ts";

for (const nativeRunner of [true, false]) {
	for (const loader of ["preload", "fallback"]) {
		test(`${loader} resolves dependencies and module identity through symlinked host peers (native=${nativeRunner})`, () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-peer-symlinks-"));
			try {
				const host = path.join(root, "host");
				const storeModules = path.join(root, "store", "pi-tui", "node_modules");
				const tui = path.join(storeModules, "@earendil-works", "pi-tui");
				const marked = path.join(storeModules, "marked");
				const link = path.join(host, "node_modules", "@earendil-works", "pi-tui");
				fs.mkdirSync(path.dirname(link), { recursive: true });
				fs.mkdirSync(tui, { recursive: true });
				fs.mkdirSync(marked, { recursive: true });
				fs.writeFileSync(path.join(host, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.87.0" }));
				fs.writeFileSync(path.join(tui, "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", type: "module", exports: "./index.js" }));
				fs.writeFileSync(path.join(tui, "index.js"), "export { marker } from 'marked';\n");
				fs.writeFileSync(path.join(marked, "package.json"), JSON.stringify({ name: "marked", type: "module", exports: "./index.js" }));
				fs.writeFileSync(path.join(marked, "index.js"), "export const marker = 'resolved-from-store';\n");
				fs.symlinkSync(tui, link, "junction");
				const { aliases } = resolveHostPeerAliases(host);
				assert.ok(aliases["@earendil-works/pi-tui"]);
				const preload = loader === "preload"
					? new URL("../../runner-peer-preload.mjs", import.meta.url).href
					: `data:text/javascript,${encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(new URL("../../runner-peer-loader.mjs", import.meta.url).href)}, { data: { aliases: JSON.parse(process.env.JITI_ALIAS), nativeRunner: ${nativeRunner} } });`)}`;
				const child = spawnSync(process.execPath, [
					"--import", preload, "--input-type=module", "-e",
					"import assert from 'node:assert/strict'; const peer = await import('@earendil-works/pi-tui'); const direct = await import(process.argv[1]); assert.strictEqual(peer, direct); console.log(peer.marker);",
					pathToFileURL(fs.realpathSync(path.join(tui, "index.js"))).href,
				], {
					encoding: "utf8",
					env: { ...process.env, JITI_ALIAS: JSON.stringify(aliases), PI_ASYNC_NATIVE_RUNNER: nativeRunner ? "1" : "0" },
					timeout: 10_000,
				});
				assert.equal(child.status, 0, child.stderr);
				assert.equal(child.stdout.trim(), "resolved-from-store");
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	}
}
