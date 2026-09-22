// Run with Node >=22.19.0: node --experimental-strip-types test/smoke/clean-install.mjs [artifact-dir] [0.86.1]
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = fileURLToPath(new URL("../../", import.meta.url));
const version = process.argv[3] ?? "0.86.1";
assert.equal(version, "0.86.1", "requires the supported smoke version");
const root = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), "clean-install-smoke-"));
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
fs.writeFileSync(path.join(host, "package.json"), JSON.stringify({ private: true, dependencies: { "@earendil-works/pi-coding-agent": version } }));
run("host-install", "npm", ["install", "--no-audit", "--no-fund"], host);
run("build-package", process.execPath, ["scripts/build-package.mjs"], source);
const packed = JSON.parse(run("pack", "npm", ["pack", "--json", "--pack-destination", root, path.join(source, "dist-pkg")], source).stdout)[0];
assert.ok(packed.files.some(file => file.path === "runner-peer-preload.mjs"), "peer preload must ship");
assert.ok(packed.files.some(file => file.path === "runner-peer-loader.mjs"), "older-Node peer loader must ship");
assert.equal(packed.files.some(file => file.path.endsWith(".ts") && !file.path.endsWith(".d.ts")), false, "package must not ship TypeScript sources");
assert.ok(packed.files.some(file => file.path === "index.js"), "compiled extension entry must ship");
assert.ok(packed.files.some(file => file.path === "src/inspectors/inspector-runner.js"), "compiled inspector runner must ship");
assert.ok(packed.files.some(file => file.path === "src/runs/background/subagent-runner-bootstrap.js"), "compiled background bootstrap must ship");
assert.ok(packed.files.some(file => file.path === "src/runs/background/subagent-runner.js"), "compiled background execution module must ship");
fs.writeFileSync(path.join(extension, "package.json"), JSON.stringify({ private: true, dependencies: { "pi-subagents": `file:${path.join(root, packed.filename)}` } }));
run("extension-install", "npm", ["install", "--no-audit", "--no-fund"], extension);
const installed = path.join(extension, "node_modules/pi-subagents");
const inspectorRun = path.join(root, "inspector-run");
fs.mkdirSync(inspectorRun);
fs.writeFileSync(path.join(inspectorRun, "status.json"), JSON.stringify({
	runId: "smoke-inspector", mode: "single", state: "completed", startedAt: Date.now(), cwd,
	steps: [{ agent: "worker", status: "completed", recentOutput: ["done"] }],
}));
const inspector = run("inspector", process.execPath, [
	path.join(installed, "inspector-runner.mjs"), "--async-dir", inspectorRun, "--run-id", "smoke-inspector",
], cwd);
assert.match(inspector.stdout, /pi-subagents inspector for smoke-inspector/);
const pi = path.join(host, "node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = await import(pathToFileURL(path.join(extension, "node_modules/jiti/lib/jiti.mjs")).href);
const { resolveHostPeerAliases, findHostPeerPackageDir, resolvePackageSubpath } = await import(pathToFileURL(path.join(installed, "src/runs/background/runner-aliases.js")).href);
assert.equal(findHostPeerPackageDir(pi, "@earendil-works/pi-client"), undefined, "stable host must remain missing client");
run("pristine-public-sdk", process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(resolvePackageSubpath(pi, ".")).href)})`], cwd);
const resolved = resolveHostPeerAliases(pi);
assert.deepEqual(resolved.missing, []);
const tui = findHostPeerPackageDir(pi, "@earendil-works/pi-tui");
assert.ok(tui.startsWith(host + path.sep), "TUI must come from the host install");
assert.equal(resolved.aliases["@earendil-works/pi-tui"], resolvePackageSubpath(tui, "."));
for (const specifier of ["@earendil-works/chord", "@earendil-works/chord/context"]) {
	assert.ok(resolved.aliases[specifier]);
}
assert.equal(resolved.aliases["@earendil-works/pi-client/unix"], undefined);
fs.writeFileSync(path.join(root, "aliases.json"), JSON.stringify(resolved, null, 2));
// Pi serves its own packages to extensions as virtual modules; the fixture stands in with jiti aliases to the host install.
delete process.env.PI_SUBAGENT_CHILD;
const entryLoader = createJiti(import.meta.url, {
	moduleCache: false,
	tryNative: false,
	alias: { "@earendil-works/pi-coding-agent": resolvePackageSubpath(pi, "."), ...resolved.aliases },
});
const entryStarted = performance.now();
const entry = await entryLoader.import(path.join(installed, "index.js"));
assert.equal(typeof entry.default, "function", "compiled extension entry must export its factory");
console.log(`PASS compiled package entry loaded through Jiti in ${Math.round(performance.now() - entryStarted)} ms`);
for (const file of ["sdk-child.ts", "sdk-extension.ts"]) fs.copyFileSync(new URL(file, import.meta.url), path.join(cwd, file));
const childEnv = {
	SMOKE_EXTENSION: installed,
	JITI_ALIAS: JSON.stringify(resolved.aliases),
	PI_ASYNC_NATIVE_RUNNER: "1",
};
const jiti = path.join(extension, "node_modules/jiti/lib/jiti-cli.mjs");
const args = [jiti, path.join(cwd, "sdk-child.ts")];
const preload = Object.keys(resolved.aliases).length ? ["--import", pathToFileURL(path.join(installed, "runner-peer-preload.mjs")).href] : [];
const positive = run("child", process.execPath, [...preload, ...args], cwd, childEnv);
assert.match(positive.stdout, /PASS public SDK\/default child factory/);
const packedSelection = run("packed-selection", process.execPath, [
	path.join(source, "test/smoke/packed-runner-selection.mjs"),
	installed,
	resolvePackageSubpath(pi, "."),
], cwd, childEnv);
assert.match(packedSelection.stdout, /PASS packed node_modules selects compiled JavaScript/);
assert.equal(findHostPeerPackageDir(pi, "@earendil-works/pi-client"), undefined);
console.log(`${positive.stdout.trim()}\nArtifacts: ${root}`);
