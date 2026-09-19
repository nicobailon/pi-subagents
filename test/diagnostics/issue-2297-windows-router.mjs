/**
 * TEMPORARY issue-2297 Windows evidence fixture.
 *
 * It resolves real pi-router models through compiled pi-subagents without
 * prompting a model. Remove this file and its two Windows workflow steps when
 * the diagnostic PR is closed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const piRoot = process.env.PI_SUBAGENTS_NATIVE_PI_ROOT;
const routerRoot = process.env.PI_SUBAGENTS_ISSUE_2297_ROUTER_ROOT;
assert.ok(piRoot, "PI_SUBAGENTS_NATIVE_PI_ROOT is required");
assert.ok(routerRoot, "PI_SUBAGENTS_ISSUE_2297_ROUTER_ROOT is required");
assert.ok(process.platform === "win32" || process.env.PI_SUBAGENTS_ISSUE_2297_ALLOW_NON_WINDOWS === "1", "issue-2297 diagnostic is Windows-only outside explicit local validation");

for (const name of Object.keys(process.env)) {
	if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) delete process.env[name];
}
process.env.PI_OFFLINE = "1";
process.env.JITI_FS_CACHE = "false";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-issue-2297-"));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "cwd");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const piManifest = JSON.parse(fs.readFileSync(path.join(piRoot, "package.json"), "utf8"));
const routerManifest = JSON.parse(fs.readFileSync(path.join(routerRoot, "package.json"), "utf8"));
assert.equal(piManifest.version, "0.85.1");
assert.equal(routerManifest.version, "0.5.4");

const model = {
	id: "mimo-v2.5",
	name: "Issue 2297 credential-free static model",
	api: "openai-completions",
	reasoning: true,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { supportsDeveloperRole: false },
};
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
	providers: {
		mimo: {
			baseUrl: "http://127.0.0.1:1/v1",
			apiKey: "dummy-not-a-credential",
			api: "openai-completions",
			models: [model],
		},
	},
}, null, 2));
fs.writeFileSync(path.join(agentDir, "pi-router.json"), JSON.stringify({
	strategy: "channelFirst",
	auto: false,
	autoSync: false,
	healthProbe: { enabled: false },
	models: [{ id: model.id, channels: ["mimo"] }],
}, null, 2));

const pi = await import(pathToFileURL(path.join(piRoot, "dist", "index.js")).href);
const { createDefaultChildSessionFactory } = await import(new URL("../../dist-pkg/src/runs/shared/child-session.js", import.meta.url));
const routerPath = path.join(routerRoot, "index.ts");
const parentRuntime = await pi.ModelRuntime.create({ allowModelNetwork: false });
assert.ok(parentRuntime.getModel("mimo", model.id), "static upstream model must resolve before the matrix");

const extensionErrors = [];
const launch = (modelRef, foreground) => ({
	cwd,
	storage: { kind: "memory" },
	model: modelRef,
	tools: [],
	extensionPaths: [routerPath],
	ambientExtensions: false,
	hooks: [],
	noSkills: true,
	noContextFiles: true,
	runtime: {},
	...(foreground ? { parentProviderRegistry: parentRuntime } : {}),
	onExtensionError(error) {
		extensionErrors.push({ extensionPath: error.extensionPath, event: error.event, error: String(error.error) });
	},
});

const iterations = 13;
const rows = [];

async function runSequential(foreground, modelRef) {
	const factory = createDefaultChildSessionFactory();
	try {
		for (let iteration = 1; iteration <= iterations; iteration += 1) {
			const child = await factory.create(launch(modelRef, foreground));
			try {
				assert.equal(child.modelId, `router/${model.id}`, `iteration ${iteration}`);
			} finally {
				await child.dispose();
			}
		}
	} finally {
		await factory.dispose();
	}
	rows.push({ topology: foreground ? "foreground-parent-bound-isolated-runtime" : "detached-runner-relevant-shared-runtime", lifecycle: "sequential-create-dispose", modelRef, passed: iterations });
}

async function runParallel(foreground, modelRef) {
	const factory = createDefaultChildSessionFactory();
	try {
		const results = await Promise.allSettled(Array.from({ length: iterations }, async (_, index) => {
			const child = await factory.create(launch(modelRef, foreground));
			try {
				assert.equal(child.modelId, `router/${model.id}`, `iteration ${index + 1}`);
			} finally {
				await child.dispose();
			}
		}));
		const failure = results.find((result) => result.status === "rejected");
		if (failure) throw failure.reason;
	} finally {
		await factory.dispose();
	}
	rows.push({ topology: foreground ? "foreground-parent-bound-isolated-runtime" : "detached-runner-relevant-shared-runtime", lifecycle: "parallel-create-shared-process", modelRef, passed: iterations });
}

const startedAt = Date.now();
try {
	for (const foreground of [true, false]) {
		for (const modelRef of [`router/${model.id}`, `router/${model.id}:high`]) {
			await runSequential(foreground, modelRef);
			await runParallel(foreground, modelRef);
		}
	}
	assert.deepEqual(extensionErrors, []);
	const report = {
		diagnostic: "issue-2297-windows-real-pi-router",
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		pi: piManifest.version,
		router: routerManifest.version,
		compiledPiSubagents: true,
		modelNetworkCalls: 0,
		iterationsPerCell: iterations,
		totalResolutions: rows.reduce((total, row) => total + row.passed, 0),
		durationMs: Date.now() - startedAt,
		rows,
		extensionErrors,
	};
	assert.equal(report.totalResolutions, 104);
	console.log(JSON.stringify(report, null, 2));
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
