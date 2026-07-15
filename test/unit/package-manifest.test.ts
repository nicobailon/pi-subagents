import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
} from "../../src/api/delegation.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const sourceImportPattern = /from\s+["'](@earendil-works\/[^"']+)["']|import\s+["'](@earendil-works\/[^"']+)["']/g;
const oldPiScopePattern = /@mariozechner\/pi-/;
const piPackageJsonSubpathPattern = /@earendil-works\/pi-[^"']+\/package\.json/;
const cjsPiPackageResolutionPattern = /require(?:\.resolve)?\(\s*["']@earendil-works\/pi-/;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function collectTsFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectTsFiles(entryPath).forEach((file) => files.push(file));
		} else if (entry.name.endsWith(".ts")) {
			files.push(entryPath);
		}
	}
	return files;
}

test("the packed source surface includes the public delegation contract", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
	assert.equal(packageJson.files.includes("src/**/*.ts"), true);
	assert.equal(packageJson.files.includes("src/**/*.mjs"), true);
	assert.equal(packageJson.files.includes("src/**/*.d.mts"), true);
	assert.equal(fs.existsSync(path.join(projectRoot, "src", "api", "delegation.mjs")), true);
	assert.equal(fs.existsSync(path.join(projectRoot, "src", "api", "delegation.d.mts")), true);
	assert.equal(SUBAGENT_DELEGATION_REQUEST_EVENT, "subagent:delegation:request");
	assert.equal(SUBAGENT_DELEGATION_RESPONSE_EVENT, "subagent:delegation:response");

	const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: projectRoot,
		encoding: "utf-8",
	});
	assert.equal(packed.status, 0, packed.stderr);
	const packReport = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
	const packedPaths = new Set(packReport[0]?.files.map((file) => file.path));
	assert.equal(packedPaths.has("src/api/delegation.mjs"), true);
	assert.equal(packedPaths.has("src/api/delegation.d.mts"), true);
});

test("direct @earendil-works runtime imports are declared for CI installs", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
	const declared = new Set([
		...Object.keys(packageJson.dependencies ?? {}),
		...Object.keys(packageJson.devDependencies ?? {}),
	]);
	const imported = new Set<string>();

	for (const file of [...collectTsFiles(path.join(projectRoot, "src")), ...collectTsFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		for (const match of source.matchAll(sourceImportPattern)) {
			imported.add(match[1] ?? match[2]!);
		}
	}

	const missing = [...imported].filter((specifier) => !declared.has(specifier)).sort();
	assert.deepEqual(missing, []);
});

test("direct dependency declarations are exact version pins", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));

	for (const section of ["dependencies", "devDependencies"] as const) {
		for (const [name, version] of Object.entries<string>(packageJson[section] ?? {})) {
			assert.match(version, exactVersionPattern, `${section}.${name} should use an exact version`);
		}
	}
});

test("old pi package scope is not used by source or tests", () => {
	for (const file of [...collectTsFiles(path.join(projectRoot, "src")), ...collectTsFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		assert.equal(oldPiScopePattern.test(source), false, file);
	}
});

test("Pi package resolution stays export-map safe", () => {
	for (const file of [...collectTsFiles(path.join(projectRoot, "src")), ...collectTsFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		assert.equal(piPackageJsonSubpathPattern.test(source), false, `${file} should not resolve unexported package.json subpaths`);
		assert.equal(cjsPiPackageResolutionPattern.test(source), false, `${file} should not use CommonJS resolution for ESM-only Pi packages`);
	}
});
