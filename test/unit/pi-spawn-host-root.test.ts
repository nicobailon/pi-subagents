import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	findPiPackageRootFromEntry,
	PI_PACKAGE_DIR_ENV,
	resolvePiPackageRoot,
	resolveRunningPiPackageRoot,
} from "../../src/runs/shared/pi-spawn.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";

const PACKAGE_DIR = path.join("@earendil-works", "pi-coding-agent");

function writePackageRoot(root: string, name = "@earendil-works/pi-coding-agent"): void {
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
}

function resolutionReason(result: ReturnType<typeof resolveRunningPiPackageRoot>): string {
	return result && "reason" in result ? result.reason : "";
}

describe("findPiPackageRootFromEntry", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-entry-root-"));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("returns the root of the package containing the entry", () => {
		const root = path.join(tmp, "install", PACKAGE_DIR);
		writePackageRoot(root);
		fs.mkdirSync(path.join(root, "dist"), { recursive: true });
		fs.writeFileSync(path.join(root, "dist", "index.js"), "");
		assert.equal(findPiPackageRootFromEntry(path.join(root, "dist", "index.js")), root);
	});

	it("keeps walking past packages with a different name", () => {
		const root = path.join(tmp, "install", PACKAGE_DIR);
		writePackageRoot(path.join(root, "node_modules", "other-pkg"), "other-pkg");
		writePackageRoot(root);
		assert.equal(findPiPackageRootFromEntry(path.join(root, "node_modules", "other-pkg", "index.js")), root);
	});

	it("returns undefined for a missing entry", () => {
		assert.equal(findPiPackageRootFromEntry(path.join(tmp, "absent", "index.js")), undefined);
	});
});

describe("resolvePiPackageRoot host discovery", () => {
	let tmp: string;
	let previousArgv1: string | undefined;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-root-"));
		previousArgv1 = process.argv[1];
	});

	afterEach(() => {
		process.argv[1] = previousArgv1;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("finds the package through a bin script whose realpath lives inside it", { skip: process.platform === "win32" ? "file symlinks require elevated privileges on Windows" : undefined }, () => {
		const root = path.join(tmp, "install", PACKAGE_DIR);
		writePackageRoot(root);
		fs.mkdirSync(path.join(root, "dist", "bundle"), { recursive: true });
		fs.writeFileSync(path.join(root, "dist", "bundle", "cli.js"), "");
		const binDir = path.join(tmp, "prefix", "bin");
		fs.mkdirSync(binDir, { recursive: true });
		const bin = path.join(binDir, "pi");
		fs.symlinkSync(path.join(root, "dist", "bundle", "cli.js"), bin);
		process.argv[1] = bin;
		const resolved = resolvePiPackageRoot();
		assert.ok(resolved);
		assert.equal(fs.realpathSync(resolved), fs.realpathSync(root));
	});

	it("ignores unrelated packages higher up the tree", () => {
		const unrelated = path.join(tmp, "unrelated");
		writePackageRoot(unrelated, "some-other-package");
		fs.writeFileSync(path.join(unrelated, "script.js"), "");
		process.argv[1] = path.join(unrelated, "script.js");
		assert.equal(resolvePiPackageRoot(), undefined);
	});
});

describe("resolveRunningPiPackageRoot", () => {
	it("keeps argv ownership ahead of both explicit roots", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-running-root-precedence-"));
		try {
			const argvRoot = path.join(tmp, "argv");
			const entry = path.join(argvRoot, "dist", "cli.js");
			writePackageRoot(argvRoot);
			fs.mkdirSync(path.dirname(entry), { recursive: true });
			fs.writeFileSync(entry, "");
			assert.deepEqual(resolveRunningPiPackageRoot({
				argv1: entry,
				env: {
					[PI_PACKAGE_DIR_ENV]: path.join(tmp, "pi-owned"),
					[PI_CODING_AGENT_PACKAGE_ROOT_ENV]: path.join(tmp, "subagents"),
				},
			}), { root: fs.realpathSync(argvRoot), source: "argv" });
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("reports an unreadable argv-owned manifest instead of selecting an override", () => {
		const reason = resolutionReason(resolveRunningPiPackageRoot({
			platform: "linux",
			argv1: "/synthetic-host/pi/dist/cli.js",
			env: { [PI_PACKAGE_DIR_ENV]: "/fallback" },
			realpathSync: (value) => value,
			existsSync: (value) => value === "/synthetic-host/pi/package.json",
			readFileSync: () => { throw new Error("manifest unreadable"); },
		}));
		assert.match(reason, /running Pi entry.*manifest unreadable/);
	});

	it("prefers PI_PACKAGE_DIR, ignores blanks, and fails closed on explicit invalid roots", () => {
		const manifests = new Map([
			["/pi-owned/package.json", JSON.stringify({ name: "@earendil-works/pi-coding-agent" })],
			["/subagents/package.json", JSON.stringify({ name: "@earendil-works/pi-coding-agent" })],
			["/foreign/package.json", JSON.stringify({ name: "someone-else" })],
		]);
		const base = {
			platform: "linux" as const,
			argv1: "/missing/entry.js",
			realpathSync: () => { throw new Error("missing"); },
			readFileSync: (filePath: string) => {
				const value = manifests.get(filePath);
				if (value === undefined) throw new Error("missing");
				return value;
			},
		};
		assert.deepEqual(resolveRunningPiPackageRoot({ ...base, env: {
			[PI_PACKAGE_DIR_ENV]: "/pi-owned",
			[PI_CODING_AGENT_PACKAGE_ROOT_ENV]: "/subagents",
		} }), { root: "/pi-owned", source: "PI_PACKAGE_DIR" });
		assert.deepEqual(resolveRunningPiPackageRoot({ ...base, env: {
			[PI_PACKAGE_DIR_ENV]: "  ",
			[PI_CODING_AGENT_PACKAGE_ROOT_ENV]: "/subagents",
		} }), { root: "/subagents", source: "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT" });
		assert.match(resolutionReason(resolveRunningPiPackageRoot({ ...base, env: {
			[PI_PACKAGE_DIR_ENV]: "/foreign",
			[PI_CODING_AGENT_PACKAGE_ROOT_ENV]: "/subagents",
		} })), /is not @earendil-works\/pi-coding-agent \(PI_PACKAGE_DIR\)/);
		assert.match(resolutionReason(resolveRunningPiPackageRoot({ ...base, env: {
			[PI_PACKAGE_DIR_ENV]: "/malformed",
			[PI_CODING_AGENT_PACKAGE_ROOT_ENV]: "/subagents",
		}, readFileSync: () => "{" })), /Could not read a valid Pi package manifest.*PI_PACKAGE_DIR/);
	});

	it("recognizes POSIX share and Windows adjacent compiled Bun layouts", () => {
		const manifest = JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.87.0" });
		const posixRoot = path.posix.join("/", "synthetic-host", "share", "pi-coding-agent");
		const posixManifest = path.posix.join(posixRoot, "package.json");
		assert.deepEqual(resolveRunningPiPackageRoot({
			platform: "linux", bunVersion: "1.2.0", argv1: "/$bunfs/root/pi", execPath: "/synthetic-host/bin/pi", env: {},
			realpathSync: (value) => value,
			existsSync: (value) => value === posixManifest,
			readFileSync: (value) => value === posixManifest ? manifest : (() => { throw new Error("unexpected"); })(),
		}), { root: posixRoot, source: "bun-share" });

		const windowsRoot = path.win32.join("Q:\\", "synthetic-host", "pi");
		const windowsManifest = path.win32.join(windowsRoot, "package.json");
		assert.deepEqual(resolveRunningPiPackageRoot({
			platform: "win32", bunVersion: "1.2.0", argv1: "B:\\~BUN\\root\\pi.exe", execPath: path.win32.join(windowsRoot, "pi.exe"), env: {},
			realpathSync: (value) => value,
			existsSync: (value) => value === windowsManifest,
			readFileSync: (value) => value === windowsManifest ? manifest : (() => { throw new Error("unexpected"); })(),
		}), { root: windowsRoot, source: "bun-adjacent" });
	});

	it("does not infer image layouts for ordinary Node processes named pi", () => {
		assert.equal(resolveRunningPiPackageRoot({
			bunVersion: "", argv1: "/app/index.js", execPath: "/opt/pi/bin/pi", env: {},
			realpathSync: (value) => value,
			existsSync: () => false,
			readFileSync: () => JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
		}), undefined);
	});
});
