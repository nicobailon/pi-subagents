import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const sourceImportPattern = /from\s+["'](@earendil-works\/[^"']+)["']|import\s+["'](@earendil-works\/[^"']+)["']/g;
const oldPiScopePattern = /@mariozechner\/pi-/;
const piPackageJsonSubpathPattern = /@earendil-works\/pi-[^"']+\/package\.json/;
const cjsPiPackageResolutionPattern = /require(?:\.resolve)?\(\s*["']@earendil-works\/pi-/;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const hostPeerPackages = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
] as const;
const expectedHostDevVersions = {
	"@earendil-works/pi-agent-core": "0.81.0",
	"@earendil-works/pi-ai": "0.81.0",
	"@earendil-works/pi-coding-agent": "0.81.0",
	"@earendil-works/pi-tui": "0.81.0",
} satisfies Record<(typeof hostPeerPackages)[number], string>;

function collectSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectSourceFiles(entryPath).forEach((file) => files.push(file));
		} else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) {
			files.push(entryPath);
		}
	}
	return files;
}

test("published extension APIs use supported package entrypoints", async () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));

	assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
	assert.equal(packageJson.files?.includes("index.ts"), true);
	assert.equal(
		fs.readFileSync(path.join(projectRoot, "index.ts"), "utf-8").trim(),
		'export { default } from "./src/extension/index.ts";',
	);
	assert.equal(fs.existsSync(path.join(projectRoot, "src", "api", "delegation.ts")), true);
	assert.deepEqual(packageJson.exports, {
		".": "./index.ts",
		"./background-work": "./src/api/background-work.ts",
		"./delegation": "./src/api/delegation.ts",
	});
	const backgroundWork = await import("pi-subagents/background-work");
	assert.equal(backgroundWork.BACKGROUND_WORK_PROTOCOL_VERSION, 1);
	assert.equal(backgroundWork.BACKGROUND_WORK_REGISTRY_KEY, "pi-subagents.background-work.v1");
	const delegation = await import("pi-subagents/delegation");
	assert.equal(delegation.SUBAGENT_DELEGATION_PROTOCOL_VERSION, 1);
	assert.equal(delegation.SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION, 2);
	assert.equal(delegation.SUBAGENT_DELEGATION_REQUEST_EVENT, "prompt-template:subagent:request");
});

test("direct @earendil-works runtime imports are declared for CI installs", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
	const declared = new Set([
		...Object.keys(packageJson.dependencies ?? {}),
		...Object.keys(packageJson.devDependencies ?? {}),
		...Object.keys(packageJson.peerDependencies ?? {}),
	]);
	const imported = new Set<string>();

	for (const file of [...collectSourceFiles(path.join(projectRoot, "src")), ...collectSourceFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		for (const match of source.matchAll(sourceImportPattern)) {
			const specifier = match[1] ?? match[2]!;
			imported.add(specifier.split("/").slice(0, 2).join("/"));
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

test("host-owned packages are optional wildcard peers, not production dependencies", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));

	for (const name of hostPeerPackages) {
		assert.equal(packageJson.peerDependencies?.[name], "*", `${name} should be a wildcard peer`);
		assert.equal(packageJson.dependencies?.[name], undefined, `${name} should not be a production dependency`);
		assert.deepEqual(packageJson.peerDependenciesMeta?.[name], { optional: true }, `${name} should be an optional peer`);
	}
});
test("typebox is a bundled runtime dependency", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));

	assert.equal(packageJson.dependencies?.typebox, "1.1.38");
	assert.equal(packageJson.peerDependencies?.typebox, undefined);
	assert.equal(packageJson.peerDependenciesMeta?.typebox, undefined);
	assert.equal(packageJson.devDependencies?.typebox, undefined);
});

test("host-owned development packages use the supported SDK baseline", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));

	for (const [name, version] of Object.entries(expectedHostDevVersions)) {
		assert.equal(packageJson.devDependencies?.[name], version, `${name} should use ${version}`);
	}
});

test("old pi package scope is not used by source or tests", () => {
	for (const file of [...collectSourceFiles(path.join(projectRoot, "src")), ...collectSourceFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		assert.equal(oldPiScopePattern.test(source), false, file);
	}
});

test("Pi package resolution stays export-map safe", () => {
	for (const file of [...collectSourceFiles(path.join(projectRoot, "src")), ...collectSourceFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		assert.equal(piPackageJsonSubpathPattern.test(source), false, `${file} should not resolve unexported package.json subpaths`);
		assert.equal(cjsPiPackageResolutionPattern.test(source), false, `${file} should not use CommonJS resolution for ESM-only Pi packages`);
	}
});
