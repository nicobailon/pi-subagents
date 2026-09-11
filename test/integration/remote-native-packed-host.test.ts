import assert from "node:assert/strict";
import { it } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nativeRemoteHostDiscoveryBody } from "../../src/runs/shared/herdr-machine.ts";

const supportsPosixPackedHost = process.platform !== "win32";
const pi = supportsPosixPackedHost ? spawnSync("/bin/sh", ["-c", "command -v pi"], { encoding: "utf8" }).stdout?.trim() ?? "" : "";
const npm = supportsPosixPackedHost ? spawnSync("/bin/sh", ["-c", "command -v npm"], { encoding: "utf8" }).stdout?.trim() ?? "" : "";

it("fresh packed user and project Pi installs run the complete raw-fd protocol", { timeout: 120_000, skip: !supportsPosixPackedHost || !pi || !npm ? "POSIX shell, Pi, or npm executable unavailable" : undefined }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-packed-host-"));
	try {
		const packed = spawnSync(npm, ["pack", "--pack-destination", root, "--silent"], { cwd: process.cwd(), encoding: "utf8" }); assert.equal(packed.status, 0, packed.stderr);
		const tarball = path.join(root, packed.stdout.trim().split(/\r?\n/u).at(-1)!);
		const project = path.join(root, "project"); const home = path.join(root, "home"); const projectRoot = path.join(project, ".pi", "npm"); const userRoot = path.join(home, ".pi", "agent", "npm");
		fs.mkdirSync(projectRoot, { recursive: true }); fs.mkdirSync(userRoot, { recursive: true });
		for (const prefix of [projectRoot, userRoot]) {
			const installed = spawnSync(npm, ["install", "--prefix", prefix, "--legacy-peer-deps", "--ignore-scripts", "--package-lock=false", tarball], { encoding: "utf8" }); assert.equal(installed.status, 0, installed.stderr);
			assert.equal(fs.existsSync(path.join(prefix, "node_modules", "@earendil-works", "pi-tui")), false);
			const executable = path.join(prefix, "node_modules", ".bin", "pi-subagents-remote-host"); assert.equal(fs.realpathSync(executable), fs.realpathSync(path.join(prefix, "node_modules", "pi-subagents", "remote-native-host.sh"))); assert.match(fs.readFileSync(executable, "utf8"), /^#!\/bin\/sh\n/u);
		}
		const isolatedBin = path.join(root, "bin"); fs.mkdirSync(isolatedBin); fs.symlinkSync(process.execPath, path.join(isolatedBin, "node"));
		for (const tool of ["dirname", "readlink"]) {
			const executable = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim(); fs.symlinkSync(executable, path.join(isolatedBin, tool));
		}
		const packageVersion = (JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { version: string }).version;
		const piVersion = spawnSync(pi, ["--version"], { encoding: "utf8" }).stdout.trim();
		const run = (cwd: string) => new Promise<{ status: number | null; records: Record<string, unknown>[]; stderr: string }>((resolve, reject) => {
			const child = spawn("/bin/sh", ["-c", nativeRemoteHostDiscoveryBody()], { cwd, env: { HOME: home, PATH: isolatedBin, PI_SUBAGENT_PI_BINARY: pi }, stdio: ["pipe", "pipe", "pipe"] });
			const records: Record<string, unknown>[] = []; let stdout = ""; let stderr = ""; let disposed = false;
			const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`packed host protocol timed out: ${stderr}`)); }, 30_000);
			child.stderr.on("data", (chunk) => { stderr += String(chunk); });
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk); let newline: number;
				while ((newline = stdout.indexOf("\n")) >= 0) {
					const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1); const record = JSON.parse(line) as Record<string, unknown>; records.push(record);
					if (record.type === "pi-subagents-ready" && !disposed) { disposed = true; child.stdin.write(`${JSON.stringify({ type: "dispose", id: "dispose-1" })}\n`); }
					if (record.type === "response" && record.command === "dispose" && record.id === "dispose-1") child.stdin.end();
				}
			});
			child.once("error", reject); child.once("close", (status) => { clearTimeout(timer); if (stdout) reject(new Error(`truncated stdout frame: ${stdout}`)); else resolve({ status, records, stderr }); });
			child.stdin.write(`${JSON.stringify({ type: "launch", protocol: 1, packageVersion, launch: {
				cwd, storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: false, noSkills: true, noContextFiles: true,
				runtime: { agent: "worker", childIndex: 0, fanoutChild: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, fast: false, depth: 1, maxDepth: 2, waitTool: { enabled: false } },
			} })}\n`);
		});
		for (const [scope, cwd] of [["project", project], ["user", path.join(root, "other-project")]] as const) {
			fs.mkdirSync(cwd, { recursive: true }); const result = await run(cwd);
			assert.equal(result.status, 0, `${scope}: ${result.stderr}`); assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|pi-tui|"type":"(?:pi-subagents-ready|event|supervisor-request|response)"/u);
			const ready = result.records.find((record) => record.type === "pi-subagents-ready"); assert.equal(ready?.piVersion, piVersion); assert.equal(ready?.packageVersion, packageVersion);
			assert.ok(result.records.some((record) => record.type === "response" && record.command === "dispose" && record.id === "dispose-1" && record.success === true));
			assert.ok(result.records.every((record) => record.type === "pi-subagents-ready" || record.type === "event" || (record.type === "response" && record.command === "dispose")), `${scope}: unexpected outer Pi frame ${JSON.stringify(result.records)}`);
		}
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
