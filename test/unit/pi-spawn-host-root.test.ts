import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { findPiPackageRootFromEntry, resolvePiPackageRoot } from "../../src/runs/shared/pi-spawn.ts";

const PACKAGE_DIR = path.join("@earendil-works", "pi-coding-agent");

function writePackageRoot(root: string, name = "@earendil-works/pi-coding-agent"): void {
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
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
