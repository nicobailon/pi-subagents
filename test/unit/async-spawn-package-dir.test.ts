import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { resolveInstalledPiPackageRoot, resolvePiPackageRoot } from "../../src/runs/shared/pi-spawn.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";
import { makeAgent } from "../support/helpers.ts";

test("detached spawn does not keep an inherited bundled-layout PI_PACKAGE_DIR", async (t) => {
	const bundled = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-pi-"));
	const previous = process.env.PI_PACKAGE_DIR;
	const previousRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	// The launch path consults this variable when argv discovery cannot identify
	// the host; an ambient value from the outer environment would change the spawn env.
	delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	process.env.PI_PACKAGE_DIR = bundled;
	const spawn = t.mock.method(childProcess, "spawn", () => {
		throw new Error("spawn boundary captured");
	});
	syncBuiltinESMExports();
	try {
		// Re-evaluate the module's launch-time host detection: the top-level
		// import already cached a root resolved against the ambient environment.
		const { executeAsyncSingle: launch } = await import("../../src/runs/background/async-execution.ts?pi-package-dir");
		const result = launch("spawn-package-dir", {
			agent: "worker",
			task: "Inspect package dir",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: bundled, currentSessionId: "spawn-package-dir" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(bundled, "sessions"),
			maxSubagentDepth: 1,
			acceptance: false,
		});
		assert.match(result.content[0]!.text, /spawn boundary captured/);
		const npmRoot = resolvePiPackageRoot() ?? resolveInstalledPiPackageRoot();
		assert.equal(spawn.mock.calls[0]!.arguments[2].env.PI_PACKAGE_DIR, npmRoot);
		assert.notEqual(npmRoot, bundled);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = previous;
		if (previousRoot === undefined) delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		else process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = previousRoot;
		fs.rmSync(bundled, { recursive: true, force: true });
	}
});

test("detached launch honors the package-root environment override when host detection cannot identify the package", async (t) => {
	const detected = [resolvePiPackageRoot(), resolveInstalledPiPackageRoot()].filter((dir): dir is string => Boolean(dir));
	assert.ok(detected.length > 0, "fixture must start with a detectable host root");
	const manifests = detected.map((dir) => path.join(dir, "package.json"));
	// A real, complete host root: the override must carry it through the
	// launch while the same mock reproduces the closed failure without it.
	const override = detected[0]!;
	const exists = fs.existsSync;
	t.mock.method(fs, "existsSync", (file) => manifests.includes(String(file)) ? false : exists(file));
	const previous = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = override;
	const spawn = t.mock.method(childProcess, "spawn", () => {
		throw new Error("spawn boundary captured");
	});
	syncBuiltinESMExports();
	try {
		// Re-evaluate the module's launch-time host detection with auto-discovery hidden.
		const { executeAsyncSingle: launch } = await import("../../src/runs/background/async-execution.ts?env-package-root");
		const result = launch("env-package-root", {
			agent: "worker", task: "Inspect files", agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: override, currentSessionId: "env-package-root" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false, sessionRoot: path.join(override, "sessions"), maxSubagentDepth: 1, acceptance: false,
		});
		assert.match(result.content[0]!.text, /spawn boundary captured/);
		assert.equal(spawn.mock.calls[0]!.arguments[2].env[PI_CODING_AGENT_PACKAGE_ROOT_ENV], override);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		if (previous === undefined) delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		else process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = previous;
	}
});

test("detached launch ignores a whitespace-only package-root override", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "blank-package-root-"));
	const previous = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = "   ";
	const manifests = [resolvePiPackageRoot(), resolveInstalledPiPackageRoot()]
		.filter((dir): dir is string => Boolean(dir)).map((dir) => path.join(dir, "package.json"));
	assert.ok(manifests.length > 0, "fixture must start with a detectable npm root");
	const exists = fs.existsSync;
	t.mock.method(fs, "existsSync", (file) => manifests.includes(String(file)) ? false : exists(file));
	const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("must not spawn"); });
	syncBuiltinESMExports();
	try {
		// With auto-discovery hidden, a blank override must not count as a host root.
		const { executeAsyncSingle: launch } = await import("../../src/runs/background/async-execution.ts?blank-package-root");
		const result = launch("blank-package-root", {
			agent: "worker", task: "Inspect files", agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: root, currentSessionId: "blank-package-root" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false, sessionRoot: path.join(root, "sessions"), maxSubagentDepth: 1, acceptance: false,
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /installed npm package.*neither is available/);
		assert.equal(spawn.mock.calls.length, 0);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		if (previous === undefined) delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		else process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("npm detached launch fails closed when the detected package root is absent", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "missing-npm-root-"));
	const previous = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	// An ambient override would satisfy host detection and defeat the fixture.
	delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	const manifests = [resolvePiPackageRoot(), resolveInstalledPiPackageRoot()]
		.filter((dir): dir is string => Boolean(dir)).map((dir) => path.join(dir, "package.json"));
	assert.ok(manifests.length > 0, "fixture must start with a detectable npm root");
	const exists = fs.existsSync;
	t.mock.method(fs, "existsSync", (file) => manifests.includes(String(file)) ? false : exists(file));
	const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("must not spawn"); });
	syncBuiltinESMExports();
	try {
		// Re-evaluate the module's launch-time host detection with the package withheld.
		const { executeAsyncSingle: launch } = await import("../../src/runs/background/async-execution.ts?missing-npm-root");
		const result = launch("missing-npm-root", {
			agent: "worker", task: "Inspect files", agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: root, currentSessionId: "missing-npm-root" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false, sessionRoot: path.join(root, "sessions"), maxSubagentDepth: 1, acceptance: false,
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /installed npm package.*neither is available/);
		assert.equal(spawn.mock.callCount(), 0);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		if (previous === undefined) delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		else process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
