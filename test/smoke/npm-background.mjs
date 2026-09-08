// Real npm CLI -> public subagent tool -> detached Node runner -> SDK session.
// Reuse a clean install made by pi085-clean-install.mjs; no installs during this check.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const npmRoot = process.argv[2];
const root = process.argv[3];
assert.equal(process.platform, "linux", "this focused real npm launch check requires bubblewrap");
assert.ok(npmRoot && path.isAbsolute(npmRoot));
assert.ok(root && path.isAbsolute(root) && !fs.existsSync(root), "fresh artifact root required");
const installed = path.join(npmRoot, "extension/node_modules/pi-subagents");
const sdk = "host/node_modules/@earendil-works/pi-coding-agent";
const version = JSON.parse(fs.readFileSync(path.join(npmRoot, sdk, "package.json"), "utf8")).version;
assert.ok(["0.85.0", "0.85.1"].includes(version));
for (const name of ["", "tmp", "home", "agent", "work/.pi/agents"]) fs.mkdirSync(path.join(root, name), { recursive: true });
fs.cpSync(installed, path.join(root, "package"), { recursive: true });
fs.mkdirSync(path.join(root, "package/test/smoke"), { recursive: true });
for (const name of ["standalone-parent.ts", "standalone-provider.ts", "standalone-observer.ts", "standalone-revival.ts", "standalone-shared.ts"]) fs.copyFileSync(new URL(name, import.meta.url), path.join(root, "package/test/smoke", name));
fs.copyFileSync(process.execPath, path.join(root, "node"));
fs.writeFileSync(path.join(root, "agent/settings.json"), JSON.stringify({ defaultProvider: "standalone-smoke", defaultModel: "local", packages: [] }));
fs.writeFileSync(path.join(root, "work/.pi/agents/binary-smoke.md"), "---\nname: binary-smoke\ndescription: Real npm background launch\nmodel: standalone-smoke/local\ntools:\nextensions:\n  - /stage/package/test/smoke/standalone-observer.ts\n  - /stage/package/test/smoke/standalone-provider.ts\ncompletionGuard: false\n---\nReturn the scripted response.\n");
const aliases = JSON.parse(fs.readFileSync(path.join(npmRoot, "aliases.json"), "utf8")).aliases;
const mapped = Object.fromEntries(Object.entries(aliases).map(([key, value]) => [key, value.replaceAll(npmRoot, "/npm-fixture")]));
const args = ["--die-with-parent", "--unshare-net", "--unshare-pid", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin"];
for (const lib of ["/lib", "/lib64", "/etc/ld.so.cache"]) if (fs.existsSync(lib)) args.push("--ro-bind", lib, lib);
args.push("--proc", "/proc", "--dev", "/dev", "--bind", root, "/stage", "--bind", path.join(root, "tmp"), "/tmp", "--ro-bind", npmRoot, "/npm-fixture", "--ro-bind", path.join(npmRoot, "extension/node_modules"), "/stage/node_modules", "--chdir", "/stage/work", "--clearenv");
for (const [key, value] of Object.entries({ PATH: "/stage:/usr/bin:/bin", HOME: "/stage/home", PI_CODING_AGENT_DIR: "/stage/agent", PI_OFFLINE: "1", JITI_FS_CACHE: "false", JITI_ALIAS: JSON.stringify(mapped), TERM: "dumb", PI_STANDALONE_SMOKE_MODE: "single" })) args.push("--setenv", key, value);
args.push("--", "/stage/node", "--import", "/stage/package/runner-peer-preload.mjs", `/npm-fixture/${sdk}/dist/cli.js`, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session", "--mode", "rpc", "--extension", "/stage/package/test/smoke/standalone-provider.ts", "--extension", "/stage/package/test/smoke/standalone-parent.ts");
const result = spawnSync("bwrap", args, { encoding: "utf8", timeout: 90000, maxBuffer: 10 * 1024 * 1024 });
fs.writeFileSync(path.join(root, "parent.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`);
assert.ifError(result.error);
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout + result.stderr, /PASS standalone native async/);
const lifecycle = fs.readFileSync(path.join(root, "lifecycle.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
assert.ok(lifecycle.filter((event) => event.event === "start").every((event) => event.executable === "/stage/node"));
fs.writeFileSync(path.join(root, "npm-launch.json"), JSON.stringify({ version, runtime: "Node", publicLaunch: true, network: "unshared" }, null, 2));
console.log(`PASS npm ${version}: real public background launch, SDK identity, notification and observed runner exit; ${root}`);
