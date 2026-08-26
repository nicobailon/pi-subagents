import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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
const expectedHostPeerRanges = {
	"@earendil-works/pi-agent-core": "*",
	"@earendil-works/pi-ai": ">=0.80.0",
	"@earendil-works/pi-coding-agent": "*",
	"@earendil-works/pi-tui": "*",
} satisfies Record<(typeof hostPeerPackages)[number], string>;
const expectedHostDevVersions = {
	"@earendil-works/pi-agent-core": "0.81.0",
	"@earendil-works/pi-ai": "0.81.0",
	"@earendil-works/pi-tui": "0.81.0",
} satisfies Record<Exclude<(typeof hostPeerPackages)[number], "@earendil-works/pi-coding-agent">, string>;

test("the root entrypoint exposes the runtime error flag to TypeScript consumers", () => {
	const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-types-"));
	try {
		fs.writeFileSync(path.join(consumerRoot, "consumer.ts"), `
import "pi-subagents";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

const result: AgentToolResult<undefined> = {
	content: [],
	details: undefined,
	isError: true,
};

void result.isError;
`, "utf-8");
		fs.writeFileSync(path.join(consumerRoot, "tsconfig.json"), JSON.stringify({
			compilerOptions: {
				target: "ES2023",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				strict: true,
				noEmit: true,
				types: ["node"],
				typeRoots: [path.join(projectRoot, "node_modules", "@types")],
				skipLibCheck: true,
				allowImportingTsExtensions: true,
				baseUrl: consumerRoot,
				paths: {
					"pi-subagents": [path.join(projectRoot, "index.ts")],
				"@earendil-works/pi-agent-core": [path.join(projectRoot, "node_modules", "@earendil-works", "pi-agent-core", "dist", "index.d.ts")],
				},
			},
			files: [path.join(consumerRoot, "consumer.ts")],
		}, null, 2), "utf-8");

		execFileSync(process.execPath, [path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"), "--project", path.join(consumerRoot, "tsconfig.json")], {
			cwd: consumerRoot,
			stdio: "pipe",
		});
	} finally {
		fs.rmSync(consumerRoot, { recursive: true, force: true });
	}
});

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
	assert.equal(packageJson.files?.includes("*.mjs"), true);
	assert.equal(fs.existsSync(path.join(projectRoot, "async-retention-discovery-worker.mjs")), true);
	const entrySource = fs.readFileSync(path.join(projectRoot, "index.ts"), "utf-8");
	assert.match(entrySource, /import type \{\} from "\.\/src\/types\/pi-runtime-compat\.d\.ts";/);
	assert.equal(entrySource.includes('export { default } from "./src/extension/index.ts";'), false);
	assert.match(entrySource, /process\.env\.PI_SUBAGENT_CHILD === "1"/);
	assert.match(entrySource, /await import\("\.\/src\/extension\/index\.ts"\)/);
	assert.equal(fs.existsSync(path.join(projectRoot, "src", "api", "delegation.ts")), true);
	assert.deepEqual(packageJson.exports, {
		".": "./index.ts",
		"./agents": "./src/api/agents.ts",
		"./background-work": "./src/api/background-work.ts",
		"./external-job-provider": "./src/api/external-job-provider.ts",
		"./external-runs": "./src/api/external-runs.ts",
		"./capability-ceiling": "./src/api/capability-ceiling.ts",
		"./delegation": "./src/api/delegation.ts",
		"./preflight": "./src/api/preflight.ts",
		"./control-channel": "./src/api/control-channel.ts",
		"./intercom-bridge": "./src/api/intercom-bridge.ts",
		"./pi-args": "./src/api/pi-args.ts",
		"./shared-types": "./src/api/shared-types.ts",
		"./project-panes": "./src/api/project-panes.ts",
	});
	const agents = await import("pi-subagents/agents");
	assert.equal(agents.RUNTIME_AGENT_REGISTER_EVENT, "pi-subagents:runtime-agent-register:v1");
	assert.equal(agents.RUNTIME_AGENT_REGISTER_VERSION, 1);
	assert.equal(typeof agents.registerAgentViaEvents, "function");
	const backgroundWork = await import("pi-subagents/background-work");
	assert.equal(backgroundWork.BACKGROUND_WORK_PROTOCOL_VERSION, 1);
	assert.equal(backgroundWork.BACKGROUND_WORK_REGISTRY_KEY, "pi-subagents.background-work.v1");
	const externalJobProvider = await import("pi-subagents/external-job-provider");
	assert.equal(externalJobProvider.EXTERNAL_JOB_PROVIDER_PROTOCOL_VERSION, 1);
	assert.equal(externalJobProvider.EXTERNAL_JOB_PROVIDER_REGISTRY_KEY, "pi-subagents.external-job-providers.v1");
	assert.equal(typeof externalJobProvider.registerExternalJobProvider, "function");
	const externalRuns = await import("pi-subagents/external-runs");
	assert.equal(externalRuns.EXTERNAL_RUN_REGISTRY_VERSION, 2);
	assert.equal(typeof externalRuns.registerExternalRun, "function");
	assert.equal(typeof externalRuns.updateExternalRun, "function");
	assert.equal(typeof externalRuns.snapshotExternalRuns, "function");
	assert.equal(typeof externalRuns.unregisterExternalRun, "function");
	const capability = await import("pi-subagents/capability-ceiling");
	assert.equal(capability.SUBAGENT_CAPABILITY_CEILING_VERSION, 1);
	assert.equal(capability.SUBAGENT_CAPABILITY_CEILING_REGISTRY_KEY, "pi-subagents.capability-ceiling.v1");
	const delegation = await import("pi-subagents/delegation");
	assert.equal(delegation.SUBAGENT_DELEGATION_REQUEST_EVENT, "prompt-template:subagent:request");
	const preflight = await import("pi-subagents/preflight");
	assert.equal(preflight.SUBAGENT_LAUNCH_CONTRACT_VERSION, 2);
	assert.equal(typeof preflight.resolveSubagentLaunchContract, "function");
	const controlChannel = await import("pi-subagents/control-channel");
	assert.equal(typeof controlChannel.requestAsyncStop, "function");
	const intercomBridge = await import("pi-subagents/intercom-bridge");
	assert.equal(typeof intercomBridge.resolveIntercomSessionTarget, "function");
	const piArgs = await import("pi-subagents/pi-args");
	assert.equal(typeof piArgs.resolvePiLaunchToolPlan, "function");
	assert.equal("buildPiArgs" in piArgs, false);
	const sharedTypes = await import("pi-subagents/shared-types");
	assert.equal(typeof sharedTypes.wrapForkTask, "function");
	assert.equal(typeof sharedTypes.DEFAULT_FORK_PREAMBLE, "string");
	assert.equal("TEMP_ROOT_DIR" in sharedTypes, false);
	const projectPanes = await import("pi-subagents/project-panes");
	assert.equal(projectPanes.PROJECT_PANES_API_VERSION, 1);
	assert.equal(typeof projectPanes.openProjectPane, "function");
	assert.equal(typeof projectPanes.getProjectPaneStatus, "function");
	assert.equal(typeof projectPanes.closeProjectPane, "function");
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
			if (name === "@earendil-works/pi-coding-agent") {
				assert.equal(version, "file:./test/fixtures/pi-coding-agent-shim");
				continue;
			}
			assert.match(version, exactVersionPattern, `${section}.${name} should use an exact version`);
		}
	}
});

test("host-owned packages are optional peers with supported ranges, not production dependencies", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));

	for (const name of hostPeerPackages) {
		assert.equal(packageJson.peerDependencies?.[name], expectedHostPeerRanges[name], `${name} should use its supported peer range`);
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
	assert.equal(
		packageJson.devDependencies?.["@earendil-works/pi-coding-agent"],
		"file:./test/fixtures/pi-coding-agent-shim",
		"pi-coding-agent should use the local type/runtime shim until upstream Pi no longer pins vulnerable Undici",
	);
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
