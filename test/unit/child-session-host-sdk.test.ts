import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createDefaultChildSessionFactory, loadHostPiCodingAgent } from "../../src/runs/shared/child-session.ts";
import { resolvePackageSubpath } from "../../src/runs/background/runner-aliases.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";

declare global {
	// eslint-disable-next-line no-var
	var __fakeHostSdkLoads: number | undefined;
}

function writeManifest(root: string, manifest: unknown): void {
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
}

function fakeHostRoot(base: string, directory = "fake-pi-coding-agent", source = [
	"globalThis.__fakeHostSdkLoads = (globalThis.__fakeHostSdkLoads ?? 0) + 1;",
	"export const __fakeHostSdk = true;",
	"",
].join("\n")): string {
	const root = path.join(base, directory);
	fs.mkdirSync(path.join(root, "dist"), { recursive: true });
	writeManifest(root, {
		name: "@earendil-works/pi-coding-agent",
		version: "0.0.0-fake",
		type: "module",
		exports: { ".": { import: "./dist/index.js" } },
	});
	fs.writeFileSync(path.join(root, "dist", "index.js"), source);
	return root;
}

describe("loadHostPiCodingAgent", () => {
	let tmp: string;
	let root: string;
	let previous: string | undefined;
	let previousArgv1: string | undefined;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fake-host-sdk-"));
		root = fakeHostRoot(tmp);
		previous = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		previousArgv1 = process.argv[1];
		process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = root;
	});

	afterEach(() => {
		if (previous === undefined) delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		else process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = previous;
		process.argv[1] = previousArgv1;
		delete globalThis.__fakeHostSdkLoads;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("imports the SDK entry from the override root", async () => {
		const mod = await loadHostPiCodingAgent() as { __fakeHostSdk?: unknown };
		assert.equal(mod.__fakeHostSdk, true);
	});

	it("imports supported root exports forms", async () => {
		for (const exports of [
			"./dist/index.js",
			{ node: { import: "./dist/index.js" } },
			{ require: "./dist/missing.js", default: "./dist/index.js" },
			[null, { browser: "./dist/missing.js" }, { import: "./dist/index.js" }],
			{ ".": "./dist/index.js" },
		]) {
			writeManifest(root, { name: "@earendil-works/pi-coding-agent", type: "module", exports });
			const mod = await loadHostPiCodingAgent() as { __fakeHostSdk?: unknown };
			assert.equal(mod.__fakeHostSdk, true, JSON.stringify(exports));
		}
	});

	it("honors an explicit null export target", async () => {
		writeManifest(root, {
			name: "@earendil-works/pi-coding-agent",
			exports: { ".": { import: null, default: "./dist/index.js" } },
		});
		await assert.rejects(loadHostPiCodingAgent(), /no resolvable root export/);
	});

	it("treats top-level null exports as absent", async () => {
		writeManifest(root, {
			name: "@earendil-works/pi-coding-agent",
			type: "module",
			exports: null,
			main: "./dist/index.js",
		});
		const mod = await loadHostPiCodingAgent() as { __fakeHostSdk?: unknown };
		assert.equal(mod.__fakeHostSdk, true);
	});

	it("preserves null blocking when an export fallback array is exhausted", async () => {
		for (const blocked of [[], [null], [[null]]]) {
			writeManifest(root, {
				name: "@earendil-works/pi-coding-agent",
				exports: { ".": { import: blocked, default: "./dist/index.js" } },
			});
			await assert.rejects(loadHostPiCodingAgent(), /no resolvable root export/);
		}
	});

	it("selects the most specific export pattern before applying null blocking", () => {
		writeManifest(root, {
			name: "@earendil-works/pi-coding-agent",
			exports: { "./*": null, "./x/*": "./dist/*.js" },
		});
		assert.equal(resolvePackageSubpath(root, "./x/y"), path.join(root, "dist/y.js"));
	});

	it("replaces every export wildcard with literal capture text", () => {
		writeManifest(root, {
			name: "@earendil-works/pi-coding-agent",
			exports: { "./x/*": "./dist/*/*.js" },
		});
		assert.equal(resolvePackageSubpath(root, "./x/$&"), path.join(root, "dist/$&/$&.js"));
	});

	it("keeps one host module instance across repeated loads", async () => {
		await loadHostPiCodingAgent();
		await loadHostPiCodingAgent();
		assert.equal(globalThis.__fakeHostSdkLoads, 1);
	});

	it("auto-discovers the host package when no override is set", async () => {
		delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		const mod = await loadHostPiCodingAgent() as { createAgentSession?: unknown };
		assert.equal(typeof mod.createAgentSession, "function");
	});

	it("prefers the running host over the environment override", async () => {
		const runningRoot = fakeHostRoot(tmp, "running-pi-coding-agent", "export const owner = 'running';\n");
		const overrideRoot = fakeHostRoot(tmp, "override-pi-coding-agent", "export const owner = 'override';\n");
		process.argv[1] = path.join(runningRoot, "dist", "index.js");
		process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = overrideRoot;

		const mod = await loadHostPiCodingAgent() as { owner?: unknown };
		assert.equal(mod.owner, "running");
	});

	it("propagates dependency failures from an existing auto-discovered entry", async () => {
		const runningRoot = fakeHostRoot(tmp, "broken-running-pi-coding-agent", "import 'definitely-missing-pr2348-dependency';\n");
		process.argv[1] = path.join(runningRoot, "dist", "index.js");
		delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];

		await assert.rejects(loadHostPiCodingAgent(), /definitely-missing-pr2348-dependency/);
	});

	it("rejects when an auto-discovered root's selected entry is missing", async () => {
		const runningRoot = fakeHostRoot(tmp, "missing-entry-pi-coding-agent");
		writeManifest(runningRoot, {
			name: "@earendil-works/pi-coding-agent",
			version: "0.0.0-fake",
			type: "module",
			exports: { ".": { import: "./dist/missing.js" } },
		});
		process.argv[1] = path.join(runningRoot, "dist", "index.js");
		delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];

		await assert.rejects(loadHostPiCodingAgent(), /ENOENT/);
	});

	it("rejects a null package manifest clearly", async () => {
		fs.writeFileSync(path.join(root, "package.json"), "null\n");
		await assert.rejects(loadHostPiCodingAgent(), /invalid host SDK manifest.*expected a JSON object/);
	});

	it("rejects malformed package JSON", async () => {
		fs.writeFileSync(path.join(root, "package.json"), "{ malformed");
		await assert.rejects(loadHostPiCodingAgent(), /invalid host SDK manifest.*malformed JSON/);
	});

	it("uses the host loader when the default factory creates a child", async () => {
		const runningRoot = fakeHostRoot(tmp, "factory-owner-pi-coding-agent", [
			"export const ModelRuntime = { create: async () => { throw new Error('factory loaded host-owned SDK'); } };",
			"",
		].join("\n"));
		process.argv[1] = path.join(runningRoot, "dist", "index.js");

		const factory = createDefaultChildSessionFactory();
		await assert.rejects(() => factory.create({
			cwd: tmp,
			storage: { kind: "memory" },
			extensionPaths: [],
			ambientExtensions: false,
			hooks: [],
			noSkills: true,
			noContextFiles: true,
			runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false },
		}), /factory loaded host-owned SDK/);
	});

	it("rethrows when the override root cannot be imported", async () => {
		const broken = path.join(tmp, "broken-pi-coding-agent");
		fs.mkdirSync(path.join(broken, "dist"), { recursive: true });
		writeManifest(broken, {
			name: "@earendil-works/pi-coding-agent",
			version: "0.0.0-fake",
			type: "module",
			exports: { ".": { import: "./dist/index.js" } },
		});
		fs.writeFileSync(path.join(broken, "dist", "index.js"), "throw new Error('broken entry');");
		process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = broken;
		await assert.rejects(loadHostPiCodingAgent(), /broken entry/);
	});

	it("rejects an override root whose package name differs", async () => {
		const wrong = path.join(tmp, "wrong-pi-coding-agent");
		fs.mkdirSync(path.join(wrong, "dist"), { recursive: true });
		writeManifest(wrong, {
			name: "some-other-package",
			version: "0.0.0-fake",
			type: "module",
			exports: { ".": { import: "./dist/index.js" } },
		});
		fs.writeFileSync(path.join(wrong, "dist", "index.js"), "throw new Error('must not be imported');");
		process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = wrong;
		await assert.rejects(loadHostPiCodingAgent(), /expected "@earendil-works\/pi-coding-agent"/);
	});
});
