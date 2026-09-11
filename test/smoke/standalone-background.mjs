// Linux real-binary smoke from xz-dev's PR #2049. No filesystem core SDK or execution network.
// node test/smoke/standalone-background.mjs /absolute/pi-binary [fresh-artifacts] [mode]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || process.arch !== "x64") {
	console.log(`SKIP standalone background smoke: requires Linux x64/bubblewrap; ${process.platform}/${process.arch} not validated.`);
	process.exit(0);
}

const source = fileURLToPath(new URL("../../", import.meta.url));
const binary = process.argv[2];
const mode = process.argv[4] ?? "single";
assert.ok(["single", "workflow", "targeted-controls", "steer", "interrupt", "stop", "child-stop", "child-timeout", "run-timeout", "tool-timeout", "sdk-init-failure", "persistence-failure", "authorization-failure", "missing-bootstrap", "revival", "shared-run", "parallel-stop", "bootstrap-errors", "remote-host"].includes(mode), "unknown standalone smoke mode");
assert.ok(binary && path.isAbsolute(binary) && fs.existsSync(binary), "an existing absolute Pi binary path is required on Linux x64");
const release = JSON.parse(fs.readFileSync(new URL("standalone-release.json", import.meta.url), "utf8"));
assert.equal(process.platform, release.platform, "requires Linux/bubblewrap");
assert.equal(process.arch, release.arch);
assert.equal(createHash("sha256").update(fs.readFileSync(binary)).digest("hex"), release.binarySha256);
const root = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(os.tmpdir(), "pi-standalone-smoke-"));
fs.mkdirSync(root, { recursive: true });
assert.deepEqual(fs.readdirSync(root), [], "requires an empty artifact directory");
const coreSdk = /(?:^|\/)@earendil-works\/(?:pi-coding-agent|pi-agent-core|pi-ai|pi-tui)(?:\/|$)/;
function run(name, command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: source, encoding: "utf8", timeout: 90_000, maxBuffer: 10 * 1024 * 1024, ...options });
	fs.writeFileSync(path.join(root, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
	assert.ifError(result.error);
	return result;
}
const packed = run("pack", "npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root]);
assert.equal(packed.status, 0, packed.stderr);
const tarball = JSON.parse(packed.stdout)[0];
assert.equal(run("extract", "tar", ["-xf", path.join(root, tarball.filename), "-C", root]).status, 0);
// Copy rather than symlink: ancestor resolution must not escape into the checkout's dev SDK/shim.
fs.cpSync(path.join(source, "node_modules"), path.join(root, "package/node_modules"), {
	recursive: true,
	filter: (entry) => !coreSdk.test(path.relative(source, entry).split(path.sep).join("/")),
});
for (const name of ["home", "agent", "work", "tmp", "cache", "bun-cache", "package/test/smoke"]) fs.mkdirSync(path.join(root, name), { recursive: true });
fs.copyFileSync(binary, path.join(root, "pi-native"));
for (const name of ["theme", "assets", "export-html", "photon_rs_bg.wasm"]) {
	const asset = path.join(path.dirname(binary), name);
	if (fs.existsSync(asset)) fs.cpSync(asset, path.join(root, name), { recursive: true });
}
for (const name of ["standalone-parent.ts", "standalone-provider.ts", "standalone-observer.ts", "standalone-fault.ts", "standalone-revival.ts", "standalone-shared.ts"]) fs.copyFileSync(new URL(name, import.meta.url), path.join(root, "package/test/smoke", name));
fs.writeFileSync(path.join(root, "work/bunfig.toml"), '[install]\nauto = "disable"\n');
fs.writeFileSync(path.join(root, "work/negative.ts"), 'import "@earendil-works/pi-coding-agent";\n');
fs.mkdirSync(path.join(root, "work/.pi/agents"), { recursive: true });
fs.writeFileSync(path.join(root, "work/.pi/agents/binary-smoke.md"), `---\nname: binary-smoke\ndescription: Isolated native async regression\nmodel: standalone-smoke/local\ntools: ${mode === "tool-timeout" ? "bash" : ""}\nextensions:\n  - /stage/package/test/smoke/standalone-observer.ts\n  - /stage/package/test/smoke/standalone-provider.ts\ncompletionGuard: false\n---\nReturn the scripted response.\n`);
fs.writeFileSync(path.join(root, "agent/settings.json"), JSON.stringify({ defaultProvider: "standalone-smoke", defaultModel: "local", packages: [] }));
fs.mkdirSync(path.join(root, "agent/extensions"), { recursive: true });
fs.writeFileSync(path.join(root, "agent/extensions/ambient-sentinel.ts"), 'import fs from "node:fs"; export default function () { fs.writeFileSync("/stage/ambient-loaded", String(process.pid)); }\n');
const sandbox = ["--die-with-parent", "--unshare-net", "--unshare-pid", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin"];
for (const lib of ["/lib", "/lib64"]) if (fs.existsSync(lib)) sandbox.push("--ro-bind", lib, lib);
// glibc may dlopen libgcc_s when a workflow worker exits; expose only the loader cache.
if (fs.existsSync("/etc/ld.so.cache")) sandbox.push("--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache");
sandbox.push("--proc", "/proc", "--dev", "/dev", "--bind", root, "/stage", "--bind", path.join(root, "tmp"), "/tmp", "--chdir", "/stage/work", "--clearenv");
for (const [key, value] of Object.entries({ PATH: "/usr/bin:/bin", HOME: "/stage/home", PI_CODING_AGENT_DIR: "/stage/agent", XDG_CACHE_HOME: "/stage/cache", BUN_INSTALL_CACHE_DIR: "/stage/bun-cache", JITI_FS_CACHE: "false", PI_OFFLINE: "1", TERM: "dumb", PI_STANDALONE_SMOKE_MODE: mode })) sandbox.push("--setenv", key, value);
const negative = run("negative", "bwrap", [...sandbox, "--setenv", "BUN_BE_BUN", "1", "--", "/stage/pi-native", "--no-install", "/stage/work/negative.ts"]);
assert.notEqual(negative.status, 0, "bare Bun must not resolve a downloaded or installed SDK");
assert.match(negative.stderr, /Cannot find (?:module|package).*pi-coding-agent/);
const version = run("version", "bwrap", [...sandbox, "--", "/stage/pi-native", "--version"]);
assert.equal(version.status, 0, version.stderr);
fs.writeFileSync(path.join(root, "identity.json"), JSON.stringify({ binary, sha256: release.binarySha256, version: version.stdout.trim(), packed: tarball.filename, network: "unshared", automaticInstall: "disabled; negative control verified" }, null, 2));
const bootstrap = "/stage/package/src/runs/background/binary-bootstrap.ts";
if (mode === "missing-bootstrap") fs.renameSync(path.join(root, "package/src/runs/background/binary-bootstrap.ts"), path.join(root, "withheld-binary-bootstrap.ts"));
const hostArgs = ["/stage/pi-native", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session", "--mode", "rpc"];
console.log(`Artifacts: ${root}`);
if (mode === "remote-host") {
	const launch = { type: "launch", protocol: 1, packageVersion: JSON.parse(fs.readFileSync(path.join(root, "package/package.json"), "utf8")).version, launch: {
		cwd: "/stage/work", storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: false, noSkills: true, noContextFiles: true,
		runtime: { agent: "worker", childIndex: 0, fanoutChild: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, fast: false, depth: 1, maxDepth: 2, waitTool: { enabled: false } },
	} };
	const input = `${JSON.stringify(launch)}\n${JSON.stringify({ type: "dispose", id: "dispose-1" })}\n`;
	const invocation = run("remote-host", "bwrap", [...sandbox, "--setenv", "PI_SUBAGENT_PI_BINARY", "/stage/pi-native", "--", "/stage/package/remote-native-host.sh"], { input });
	assert.equal(invocation.status, 0, invocation.stdout + invocation.stderr);
	assert.doesNotMatch(invocation.stderr, /MODULE_NOT_FOUND|pi-tui|"type":"(?:pi-subagents-ready|event|supervisor-request|response)"/);
	const records = invocation.stdout.trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(records.map((record) => record.type), ["pi-subagents-ready", "response"], "outer Pi RPC must never start");
	assert.equal(records[0].piVersion, version.stdout.trim());
	assert.deepEqual({ command: records[1].command, id: records[1].id, success: records[1].success }, { command: "dispose", id: "dispose-1", success: true });
	console.log("PASS standalone native remote host: raw launch/ready/dispose protocol");
} else if (mode === "bootstrap-errors") {
	const nativeStep = {
		agent: "binary-smoke", task: "Return the scripted response.", context: "fresh", model: "standalone-smoke/local", modelCandidates: ["standalone-smoke/local"],
		tools: [], extensions: ["/stage/package/test/smoke/standalone-provider.ts"], completionGuard: false,
		inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
	};
	const cases = [
		{ name: "authorization-positive", barrier: true, succeeds: true },
		{ name: "missing-input", expected: /Missing absolute PI_SUBAGENT_RUNNER_CONFIG/ },
		{ name: "relative-input", configPath: "relative.json", expected: /Missing absolute PI_SUBAGENT_RUNNER_CONFIG/ },
		{ name: "missing-file", configPath: "/stage/not-present.json", expected: /ENOENT/ },
		{ name: "malformed-json", payload: "{", expected: /Subagent binary runner error/ },
		{ name: "invalid-shape", payload: "{}", expected: /Invalid binary runner configuration/ },
		{ name: "wrong-authorization", barrier: true, expected: /startup control token does not match/ },
		{ name: "missing-authorization", barrier: true, expected: /waiting for runner startup control 'proceed'/ },
	];
	for (const entry of cases) {
		const asyncDir = `/stage/${entry.name}`;
		fs.mkdirSync(path.join(root, entry.name));
		const payload = entry.barrier ? JSON.stringify({
			id: entry.name, asyncDir, cwd: "/stage/work", resultPath: `${asyncDir}/result.json`, placeholder: "{previous}",
			sessionId: "bootstrap-fixture-parent", completionOwnerId: "bootstrap-fixture-owner",
			steps: [nativeStep], launchBarrierToken: "expected-token", timeoutMs: 20000,
			artifactConfig: { enabled: false }, sessionDir: `${asyncDir}/sessions`,
		}) : entry.payload;
		const configPath = payload === undefined ? entry.configPath : `/stage/${entry.name}.json`;
		if (payload !== undefined) fs.writeFileSync(path.join(root, `${entry.name}.json`), payload, { mode: 0o600 });
		if (entry.name === "wrong-authorization" || entry.succeeds) fs.writeFileSync(path.join(root, entry.name, "runner-startup-proceed.json"), JSON.stringify({ action: "proceed", token: entry.succeeds ? "expected-token" : "wrong-token" }));
		const invocation = run(entry.name, "bwrap", [...sandbox, "--setenv", "PI_STANDALONE_CASE", entry.name, ...(configPath ? ["--setenv", "PI_SUBAGENT_RUNNER_CONFIG", configPath] : []), "--", ...hostArgs, "--extension", "/stage/package/test/smoke/standalone-observer.ts", "--extension", bootstrap]);
		assert.equal(invocation.status, entry.succeeds ? 0 : 1, invocation.stdout + invocation.stderr);
		const observed = fs.readFileSync(path.join(root, "bootstrap-observer.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.case === entry.name);
		assert.deepEqual(observed.map((event) => event.event), ["observer-ready"], "installed observer must never see an outer session start");
		const lifecycleFile = path.join(root, "lifecycle.jsonl");
		const events = fs.existsSync(lifecycleFile) ? fs.readFileSync(lifecycleFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.case === entry.name) : [];
		if (entry.succeeds) {
			assert.deepEqual(events.map((event) => event.event), ["start", "request", "shutdown"], "the identical authorized task must actually execute and shut down");
			const result = JSON.parse(fs.readFileSync(path.join(root, entry.name, "result.json"), "utf8"));
			assert.equal(result.state, "complete");
			assert.match(JSON.stringify(result), /standalone child response verified/);
		} else {
			assert.match(invocation.stderr, entry.expected);
			assert.deepEqual(events, [], "the observed positive-control task must not start without authorization");
			if (entry.barrier) assert.equal(JSON.parse(fs.readFileSync(path.join(root, entry.name, "runner-startup.json"), "utf8")).state, "error");
		}
		console.log(`PASS standalone native async bootstrap: ${entry.name}`);
	}
} else {
	const faultExtension = ["persistence-failure", "authorization-failure", "revival"].includes(mode) ? ["--extension", "/stage/package/test/smoke/standalone-fault.ts"] : [];
	const result = run("parent", "bwrap", [...sandbox, "--", ...hostArgs, "--extension", "/stage/package/test/smoke/standalone-provider.ts", ...faultExtension, "--extension", "/stage/package/test/smoke/standalone-parent.ts"]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /PASS standalone native async/);
	console.log(result.stdout.split("\n").filter((line) => line.startsWith("PASS ")).join("\n"));
}
assert.equal(fs.existsSync(path.join(root, "ambient-loaded")), false, "outer bootstrap must not load ambient extensions");
assert.deepEqual(fs.readdirSync(root, { recursive: true }).filter((entry) => coreSdk.test(entry)), [], "no staged or downloaded filesystem SDK/shim may appear");
assert.deepEqual(fs.readdirSync(path.join(root, "bun-cache")), [], "the smoke must not populate Bun's install cache");
