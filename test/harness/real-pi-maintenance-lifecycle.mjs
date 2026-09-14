import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveHostPeerAliases } from "../../src/runs/background/runner-aliases.ts";

function option(name) {
	const index = process.argv.indexOf(name);
	if (index === -1 || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
		throw new Error(`${name} is required.`);
	}
	return process.argv[index + 1];
}

const sourceRoot = fs.realpathSync(path.resolve(option("--source-root")));
const outputRoot = path.resolve(option("--output-root"));
const expectedSourceRef = option("--expected-source-ref");
const piRootInput = process.env.PI_CODING_AGENT_TEST_ROOT?.trim();
if (!piRootInput) throw new Error("PI_CODING_AGENT_TEST_ROOT must point to an official @earendil-works/pi-coding-agent installation.");
const piRoot = path.resolve(piRootInput);
const piPackagePath = path.join(piRoot, "package.json");
const cliPath = path.join(piRoot, "dist/bundle/cli.js");
if (!fs.existsSync(piPackagePath) || !fs.existsSync(cliPath)) throw new Error(`PI_CODING_AGENT_TEST_ROOT is not a valid Pi package root: ${piRoot}`);
const piPackage = JSON.parse(fs.readFileSync(piPackagePath, "utf8"));
if (piPackage.name !== "@earendil-works/pi-coding-agent") throw new Error(`PI_CODING_AGENT_TEST_ROOT contains '${String(piPackage.name)}', not @earendil-works/pi-coding-agent.`);
assert.equal(piPackage.version, "0.85.1", "this probe is pinned to official Pi 0.85.1");
const sourcePackagePath = path.join(sourceRoot, "package.json");
const extensionPath = path.join(sourceRoot, "index.ts");
if (!fs.existsSync(sourcePackagePath) || !fs.existsSync(extensionPath)) throw new Error(`--source-root is not a pi-subagents source tree: ${sourceRoot}`);
if (JSON.parse(fs.readFileSync(sourcePackagePath, "utf8")).name !== "pi-subagents") throw new Error(`--source-root package is not pi-subagents: ${sourceRoot}`);
if (outputRoot === sourceRoot || outputRoot.startsWith(`${sourceRoot}${path.sep}`)) throw new Error("--output-root must be outside --source-root.");
fs.mkdirSync(outputRoot, { recursive: true });

for (const name of Object.keys(process.env)) {
	if (name.startsWith("PI_") || /API_KEY|TOKEN|SECRET|PASSWORD/.test(name) || name === "NODE_OPTIONS" || name === "NODE_PATH") delete process.env[name];
}
const stage = path.join(outputRoot, "stage");
const home = path.join(stage, "home");
const agentDir = path.join(stage, "agent");
const cwd = path.join(stage, "cwd");
for (const directory of [home, agentDir, cwd, path.join(stage, "tmp")]) fs.mkdirSync(directory, { recursive: true });
Object.assign(process.env, {
	HOME: home,
	USERPROFILE: home,
	PI_CODING_AGENT_DIR: agentDir,
	PI_SUBAGENTS_TEMP_ROOT: path.join(stage, "tmp"),
	PI_OFFLINE: "1",
	XDG_CACHE_HOME: path.join(stage, "cache"),
	npm_config_cache: path.join(stage, "npm-cache"),
	JITI_FS_CACHE: "false",
});
const aliases = resolveHostPeerAliases(piRoot, sourceRoot);
assert.deepEqual(aliases.missing, [], `official Pi peer aliases missing: ${aliases.missing.join(", ")}`);
process.env.JITI_ALIAS = JSON.stringify(aliases.aliases);

function sourceHashes() {
	const files = [extensionPath];
	const walk = (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const pathname = path.join(directory, entry.name);
			if (entry.isDirectory()) walk(pathname);
			else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(pathname);
		}
	};
	walk(path.join(sourceRoot, "src"));
	const digest = createHash("sha256");
	for (const file of [...new Set(files)].sort()) {
		digest.update(path.relative(sourceRoot, file));
		digest.update("\0");
		digest.update(fs.readFileSync(file));
		digest.update("\0");
	}
	return {
		extensionSha256: createHash("sha256").update(fs.readFileSync(extensionPath)).digest("hex"),
		sourceTsTreeSha256: digest.digest("hex"),
	};
}
const sourceHashesBefore = sourceHashes();

let phase = "host-import";
let nextHandleId = 1;
const timerEvents = [];
const handleEvents = new WeakMap();
const originalTimers = {
	setTimeout: globalThis.setTimeout,
	setInterval: globalThis.setInterval,
	clearTimeout: globalThis.clearTimeout,
	clearInterval: globalThis.clearInterval,
};
function targetOwner(kind, delay, stack) {
	const normalized = stack.replaceAll("\\", "/");
	const root = sourceRoot.replaceAll("\\", "/");
	if (kind === "timeout" && delay === 30_000 && normalized.includes(`${root}/src/extension/index.ts`)) return "result-index-cleanup";
	if (kind === "timeout" && delay === 60_000 && normalized.includes(`${root}/src/extension/index.ts`)) return "async-retention";
	if (kind === "interval" && delay === 1_000 && normalized.includes(`${root}/src/runs/background/wait-subscriptions.ts`)) return "wait-subscription-reconcile";
	return undefined;
}
function schedule(kind, original, callback, delay, args) {
	const stack = new Error().stack ?? "";
	const event = {
		id: nextHandleId++,
		kind,
		delay: Number(delay),
		owner: targetOwner(kind, Number(delay), stack),
		callsite: stack.split("\n").slice(2, 7).map((line) => line.trim()),
		createdPhase: phase,
		clears: [],
		fires: [],
	};
	const wrapped = function (...callbackArgs) {
		event.fires.push({ phase, at: new Date().toISOString() });
		return callback.apply(this, callbackArgs);
	};
	const handle = original(wrapped, delay, ...args);
	Object.defineProperty(event, "handle", { value: handle });
	handleEvents.set(handle, event);
	timerEvents.push(event);
	return handle;
}
globalThis.setTimeout = function (callback, delay, ...args) { return schedule("timeout", originalTimers.setTimeout, callback, delay, args); };
globalThis.setInterval = function (callback, delay, ...args) { return schedule("interval", originalTimers.setInterval, callback, delay, args); };
function clear(kind, original, handle) {
	const event = handleEvents.get(handle);
	if (event) event.clears.push({ kind, phase, at: new Date().toISOString() });
	return original(handle);
}
globalThis.clearTimeout = function (handle) { return clear("clearTimeout", originalTimers.clearTimeout, handle); };
globalThis.clearInterval = function (handle) { return clear("clearInterval", originalTimers.clearInterval, handle); };

const live = (event) => event.clears.length === 0 && (event.kind === "interval" || event.fires.length === 0);
const ownedSnapshot = () => timerEvents.filter((event) => event.owner).map((event) => ({ ...event, live: live(event), hasRef: event.handle?.hasRef?.() }));
const phaseSnapshot = (name) => {
	const owned = ownedSnapshot();
	return {
		phase: name,
		counts: {
			created: owned.length,
			live: owned.filter((event) => event.live).length,
			cleared: owned.filter((event) => event.clears.length > 0).length,
			fired: owned.filter((event) => event.fires.length > 0).length,
		},
		liveHandles: owned.filter((event) => event.live).map((event) => ({ id: event.id, kind: event.kind, delay: event.delay, owner: event.owner, hasRef: event.hasRef })),
	};
};

const lifecycleTrace = [];
let observerGeneration = 0;
const observer = {
	name: "maintenance-lifecycle-observer",
	factory(pi) {
		const generation = ++observerGeneration;
		lifecycleTrace.push({ event: "factory", generation, phase });
		pi.on("session_start", (event) => lifecycleTrace.push({ event: "session_start", reason: event.reason, generation, phase }));
		pi.on("session_shutdown", (event) => lifecycleTrace.push({ event: "session_shutdown", reason: event.reason, generation, phase }));
	},
};

const pi = await import(pathToFileURL(path.join(piRoot, "dist/index.js")).href);
const { fauxProvider } = await import(pathToFileURL(path.join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
const faux = fauxProvider({ provider: "maintenance-lifecycle", models: [{ id: "local" }], tokensPerSecond: 100_000 });
const model = faux.getModel();
const extensionErrors = [];

async function makeRuntime(label, extensionPaths) {
	const createRuntime = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
		const services = await pi.createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			settingsManager: pi.SettingsManager.inMemory(),
			resourceLoaderOptions: {
				noExtensions: true,
				additionalExtensionPaths: extensionPaths,
				extensionFactories: [observer],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const created = await pi.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, noTools: "all" });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await pi.createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: pi.SessionManager.inMemory(cwd),
	});
	let session = runtime.session;
	const bind = async () => session.bindExtensions({
		mode: "print",
		commandContextActions: { reload: () => session.reload() },
		onError: (error) => extensionErrors.push({ label, ...error, error: String(error.error) }),
	});
	runtime.setRebindSession(async () => { session = runtime.session; await bind(); });
	return { runtime, bind, session: () => session };
}

const measurements = {};
try {
	phase = "control-factory";
	const control = await makeRuntime("control", []);
	measurements.controlFactory = phaseSnapshot("control-factory");
	phase = "control-startup";
	await control.bind();
	measurements.controlStartup = phaseSnapshot("control-startup");
	phase = "control-shutdown";
	await control.runtime.dispose();
	measurements.controlShutdown = phaseSnapshot("control-shutdown");

	phase = "target-factory";
	const target = await makeRuntime("target", [extensionPath]);
	measurements.factory = phaseSnapshot("target-factory");
	phase = "target-startup";
	await target.bind();
	measurements.startup = phaseSnapshot("target-startup");
	const preReloadIds = measurements.startup.liveHandles.map((handle) => handle.id);
	phase = "target-reload";
	await target.session().reload();
	measurements.reload = phaseSnapshot("target-reload");
	measurements.reloadProof = {
		preReloadIds,
		postReloadIds: measurements.reload.liveHandles.map((handle) => handle.id),
		oldHandles: ownedSnapshot().filter((event) => preReloadIds.includes(event.id)),
	};
	phase = "target-shutdown";
	await target.runtime.dispose();
	measurements.shutdown = phaseSnapshot("target-shutdown");
} finally {
	globalThis.setTimeout = originalTimers.setTimeout;
	globalThis.setInterval = originalTimers.setInterval;
	globalThis.clearTimeout = originalTimers.clearTimeout;
	globalThis.clearInterval = originalTimers.clearInterval;
}

const sourceHashesAfter = sourceHashes();
const assertionErrors = [];
const check = (condition, message) => { if (!condition) assertionErrors.push(message); };
check(measurements.controlFactory.counts.live === 0 && measurements.controlStartup.counts.live === 0 && measurements.controlShutdown.counts.live === 0, "empty control attributed target maintenance handles");
check(measurements.factory.counts.live === 0, `factory-only load created ${measurements.factory.counts.live} live target maintenance timer(s)`);
check(measurements.startup.counts.live === 3, `session startup has ${measurements.startup.counts.live}, not 3, live target maintenance timers`);
check(new Set(measurements.startup.liveHandles.map((handle) => handle.owner)).size === 3, "session startup did not create one timer at each targeted owner/callsite");
check(measurements.reload.counts.live === 3, `reload has ${measurements.reload.counts.live}, not 3, live target maintenance timers`);
check(measurements.reloadProof.oldHandles.every((handle) => !handle.live && handle.clears.length > 0), "reload did not clear every pre-reload target handle");
check(measurements.reloadProof.postReloadIds.every((id) => !measurements.reloadProof.preReloadIds.includes(id)), "reload reused a pre-reload target handle ID");
check(measurements.shutdown.counts.live === 0, `normal shutdown left ${measurements.shutdown.counts.live} live target maintenance timer(s)`);
check(extensionErrors.length === 0, `extension errors occurred: ${JSON.stringify(extensionErrors)}`);
check(JSON.stringify(sourceHashesBefore) === JSON.stringify(sourceHashesAfter), "source hashes changed during the probe");

const gitIdentity = spawnSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
const result = {
	verdict: assertionErrors.length === 0 ? "pass" : "fail",
	assertionErrors,
	runtime: {
		node: process.version,
		platform: `${process.platform}-${process.arch}`,
		piRoot,
		piVersion: piPackage.version,
		sourceRoot,
		expectedSourceRef,
		gitHead: gitIdentity.status === 0 ? gitIdentity.stdout.trim() : null,
		outputRoot,
		cwd,
		piOffline: process.env.PI_OFFLINE,
		credentialsPresent: Object.keys(process.env).filter((name) => /API_KEY|TOKEN|SECRET|PASSWORD/.test(name)),
		model: `${model.provider}/${model.id}`,
		modelPrompts: 0,
		lifecycleEntrypoints: ["AgentSession.bindExtensions()", "AgentSession.reload()", "AgentSessionRuntime.dispose()"],
		syntheticLifecycleEmits: 0,
	},
	aliases: { missing: aliases.missing, supplemental: aliases.supplemental },
	sourceHashesBefore,
	sourceHashesAfter,
	measurements,
	lifecycleTrace,
	extensionErrors,
	timerEvents: ownedSnapshot(),
};
const resultPath = path.join(outputRoot, "result.json");
fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ verdict: result.verdict, assertionErrors, resultPath, measurements }, null, 2)}\n`);
assert.deepEqual(assertionErrors, [], assertionErrors.join("\n"));
