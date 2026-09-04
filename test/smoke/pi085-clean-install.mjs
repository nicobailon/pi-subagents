// Run with Node >=22.19.0: node --experimental-strip-types test/smoke/pi085-clean-install.mjs [artifact-dir]
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = fileURLToPath(new URL("../../", import.meta.url));
const root = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), "pi085-smoke-"));
fs.mkdirSync(root, { recursive: true });
const host = path.join(root, "host");
const extension = path.join(root, "extension");
const cwd = path.join(root, "cwd");
for (const dir of [host, extension, cwd, path.join(root, "home")]) fs.mkdirSync(dir, { recursive: true });
assert.ok(!fs.existsSync(path.join(host, "node_modules")), "requires a pristine host install");
assert.ok(!fs.existsSync(path.join(extension, "node_modules")), "requires a pristine extension install");
const env = {
	...process.env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), PI_CODING_AGENT_DIR: path.join(root, "agent"),
	XDG_CACHE_HOME: path.join(root, "cache"), npm_config_cache: path.join(root, "npm-cache"),
	NODE_COMPILE_CACHE: path.join(root, "node-cache"), JITI_FS_CACHE: "false", PI_OFFLINE: "1",
};
// Do not inherit loader/alias overrides or operator credentials into the child.
for (const key of Object.keys(env)) {
	if (/API_KEY|TOKEN|SECRET|PASSWORD/.test(key) || ["NODE_OPTIONS", "NODE_PATH", "JITI_ALIAS"].includes(key)) delete env[key];
}
function run(name, command, args, workdir, extra = {}, success = true) {
	const result = spawnSync(command, args, { cwd: workdir, env: { ...env, ...extra }, encoding: "utf8", timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
	fs.writeFileSync(path.join(root, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
	assert.ifError(result.error);
	if (success) assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`);
	else assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
	return result;
}
fs.writeFileSync(path.join(host, "package.json"), JSON.stringify({ private: true, dependencies: { "@earendil-works/pi-coding-agent": "0.85.0" } }));
run("host-install", "npm", ["install", "--no-audit", "--no-fund"], host);
const packed = JSON.parse(run("pack", "npm", ["pack", "--json", "--pack-destination", root], source).stdout)[0];
assert.ok(packed.files.some(file => file.path === "runner-server-preload.mjs"), "preload must ship");
fs.writeFileSync(path.join(extension, "package.json"), JSON.stringify({ private: true, dependencies: { "pi-subagents": `file:${path.join(root, packed.filename)}` } }));
run("extension-install", "npm", ["install", "--no-audit", "--no-fund"], extension);
const installed = path.join(extension, "node_modules/pi-subagents");
const pi = path.join(host, "node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = await import(pathToFileURL(path.join(extension, "node_modules/jiti/lib/jiti.mjs")).href);
const jitiLoader = createJiti(import.meta.url, { fsCache: false });
const { resolveHostPeerAliases, findHostPeerPackageDir, resolvePackageSubpath } = await jitiLoader.import(path.join(installed, "src/runs/background/runner-aliases.ts"));
assert.equal(findHostPeerPackageDir(pi, "@earendil-works/pi-server"), undefined, "host must remain missing server");
const pristine = run("pristine-public-sdk", process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(resolvePackageSubpath(pi, ".")).href)})`], cwd, {}, false);
assert.match(pristine.stderr, /Cannot find package '@earendil-works\/pi-server'/);
const resolved = resolveHostPeerAliases(pi);
assert.deepEqual(resolved.missing, []);
assert.deepEqual(resolved.supplemental, ["@earendil-works/pi-server", "@earendil-works/pi-server/unix"]);
fs.writeFileSync(path.join(root, "aliases.json"), JSON.stringify(resolved, null, 2));
for (const file of ["pi085-child.ts", "pi085-extension.ts"]) fs.copyFileSync(new URL(file, import.meta.url), path.join(cwd, file));
const childEnv = { SMOKE_EXTENSION: installed, JITI_ALIAS: JSON.stringify(resolved.aliases) };
const jiti = path.join(extension, "node_modules/jiti/lib/jiti-cli.mjs");
const args = [jiti, path.join(cwd, "pi085-child.ts")];
// The real file-extension gate must fail with aliases alone, not just an import mock.
const negative = run("without-preload", process.execPath, args, cwd, childEnv, false);
assert.match(negative.stderr, /Model "pi085-smoke\/local" not found/);
const preload = resolved.supplemental.length ? ["--import", pathToFileURL(path.join(installed, "runner-server-preload.mjs")).href] : [];
const positive = run("child", process.execPath, [...preload, ...args], cwd, childEnv);
assert.match(positive.stdout, /PASS public SDK\/default child factory/);
assert.equal(findHostPeerPackageDir(pi, "@earendil-works/pi-server"), undefined);
console.log(`${positive.stdout.trim()}\nArtifacts: ${root}`);
