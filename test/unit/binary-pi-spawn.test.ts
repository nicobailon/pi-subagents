import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getPiSpawnCommand, type PiSpawnDeps } from "../../src/runs/shared/pi-spawn.ts";

describe("compiled Pi invocation", () => {
	const host = {
		platform: "linux",
		execPath: "/opt/standalone/pi-native",
		argv1: "/$bunfs/root/pi-native",
		bunVersion: "1.3.14",
		env: {},
		existsSync: () => false,
		readFileSync: () => { throw new Error("No filesystem SDK"); },
		resolvePackageEntry: () => { throw new Error("No filesystem SDK"); },
	} satisfies PiSpawnDeps;

	it("launches a renamed compiled host rather than its virtual entrypoint or PATH Pi", () => {
		assert.deepEqual(getPiSpawnCommand(["--no-session"], host), { command: host.execPath, args: ["--no-session"] });
	});

	it("does not mistake a manifest-only binary bundle for an npm CLI", () => {
		assert.deepEqual(getPiSpawnCommand([], {
			...host, piPackageRoot: "/opt/standalone",
			existsSync: (file) => file.endsWith("/package.json"),
			readFileSync: () => JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: "dist/cli.js" }),
		}), { command: host.execPath, args: [] });
	});

	it("retains an explicit Pi executable override", () => {
		assert.deepEqual(getPiSpawnCommand([], { ...host, env: { PI_SUBAGENT_PI_BINARY: "/custom/pi" } }), { command: "/custom/pi", args: [] });
	});

	it("does not treat an ordinary Bun script as a compiled Pi host", () => {
		assert.equal(getPiSpawnCommand([], { ...host, execPath: "/usr/bin/bun", argv1: "/work/script.ts" }).command, "pi");
	});
});
