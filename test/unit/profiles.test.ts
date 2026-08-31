import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { discoverAgents } from "../../src/agents/agents.ts";
import {
	applySubagentProfile,
	checkSubagentProfile,
	DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS,
	generateProfilesForProvider,
	getProviderModelsPath,
	getSubagentProfilesDir,
	listSubagentProfiles,
	refreshProviderModelCatalog,
	readProviderModelCatalog,
} from "../../src/profiles/profiles.ts";
import { PI_SUBAGENT_PI_BINARY_ENV } from "../../src/runs/shared/pi-spawn.ts";

let homeDir = "";
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const previousPiBinary = process.env[PI_SUBAGENT_PI_BINARY_ENV];

function makeCtx(cwd: string, models: Array<Record<string, unknown>>) {
	return {
		cwd,
		modelRegistry: {
			getAvailable: () => models,
		},
	};
}

describe("profiles helpers", () => {
	beforeEach(() => {
		homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subprofiles-home-"));
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = path.join(homeDir, "pi-test-bin");
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		if (previousPiBinary === undefined) delete process.env[PI_SUBAGENT_PI_BINARY_ENV];
		else process.env[PI_SUBAGENT_PI_BINARY_ENV] = previousPiBinary;
		fs.rmSync(homeDir, { recursive: true, force: true });
	});

	it("lists no profiles when the directory is empty", () => {
		assert.deepEqual(listSubagentProfiles(), []);
		assert.equal(fs.existsSync(getSubagentProfilesDir()), true);
	});

	it("applies a saved profile while preserving unrelated subagent settings", () => {
		const profilesDir = getSubagentProfilesDir();
		fs.mkdirSync(profilesDir, { recursive: true });
		fs.writeFileSync(path.join(profilesDir, "openai-codex.quota.json"), JSON.stringify({
			subagents: {
				agentOverrides: {
					scout: {
						model: "openai-codex/gpt-5.3-codex-spark",
						thinking: "medium",
						fallbackModels: ["openai-codex/gpt-5.4-mini"],
					},
					reviewer: { thinking: false, fallbackModels: false },
				},
			},
		}, null, 2));
		const settingsPath = path.join(homeDir, ".pi", "agent", "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(settingsPath, JSON.stringify({
			defaultModel: "openai/gpt-5",
			subagents: {
				disableBuiltins: true,
				modelScope: { enforce: true, allow: ["openai-codex/*"] },
				agentOverrides: { scout: { model: "old" }, stale: { model: "remove-me" } },
			},
		}, null, 2));

		const result = applySubagentProfile("openai-codex.quota");
		const written = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		assert.equal(result.settingsPath, settingsPath);
		assert.equal(result.filePath.endsWith("openai-codex.quota.json"), true);
		assert.equal(written.defaultModel, "openai/gpt-5");
		assert.equal(written.subagents.disableBuiltins, true);
		assert.deepEqual(written.subagents.modelScope, { enforce: true, allow: ["openai-codex/*"] });
		assert.deepEqual(written.subagents.agentOverrides, {
			scout: {
				model: "openai-codex/gpt-5.3-codex-spark",
				thinking: "medium",
				fallbackModels: ["openai-codex/gpt-5.4-mini"],
			},
			reviewer: { thinking: false, fallbackModels: false },
		});
	});

	it("applies profile models and thinking to user agents without frontmatter pins", () => {
		const profilesDir = getSubagentProfilesDir();
		fs.mkdirSync(profilesDir, { recursive: true });
		fs.writeFileSync(path.join(profilesDir, "azure-fallback.json"), JSON.stringify({
			subagents: {
				disableBuiltins: true,
				agentOverrides: {
					worker: {
						model: "bluebox-azure-openai/gpt-5_6-luna",
						thinking: "high",
						fallbackModels: ["bluebox-azure-openai/gpt-5_6-terra"],
					},
				},
			},
		}, null, 2));
		const agentDir = path.join(homeDir, ".pi", "agent", "agents");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "worker.md"), `---\nname: worker\ndescription: Profile-managed worker\n---\n\nDo work.\n`);

		applySubagentProfile("azure-fallback");
		const agents = discoverAgents(process.cwd(), "both").agents;
		const worker = agents.find((agent) => agent.name === "worker");
		assert.equal(worker?.source, "user");
		assert.equal(worker?.model, "bluebox-azure-openai/gpt-5_6-luna");
		assert.equal(worker?.thinking, "high");
		assert.deepEqual(worker?.fallbackModels, ["bluebox-azure-openai/gpt-5_6-terra"]);
		assert.equal(worker?.override?.scope, "user");
		assert.equal(agents.some((agent) => agent.source === "builtin"), false);
	});

	it("rejects invalid profile fallback models", () => {
		const profilesDir = getSubagentProfilesDir();
		fs.mkdirSync(profilesDir, { recursive: true });
		fs.writeFileSync(path.join(profilesDir, "invalid.json"), JSON.stringify({
			subagents: {
				agentOverrides: {
					worker: { fallbackModels: ["openai/gpt-5", 42] },
				},
			},
		}, null, 2));

		assert.throws(() => applySubagentProfile("invalid"), /invalid fallbackModels.*array of strings or false/);
	});

	it("rejects profile and provider path traversal names", async () => {
		assert.throws(() => applySubagentProfile("../escape"), /safe file name/);
		assert.throws(() => getProviderModelsPath("../escape"), /safe file name/);
		await assert.rejects(
			refreshProviderModelCatalog({ exec: async () => ({ stdout: "OK\n", stderr: "", code: 0, killed: false }) }, makeCtx(process.cwd(), []) as never, "../escape"),
			/safe file name/,
		);
	});

	it("refreshes a provider model catalog using the resolved Pi executable and writes a cache file", async () => {
		const piBinary = path.join(homeDir, "pi-wrapper.exe");
		process.env[PI_SUBAGENT_PI_BINARY_ENV] = piBinary;
		const execCalls: string[] = [];
		const execCwds: unknown[] = [];
		const pi = {
			exec: async (command: string, args: string[], options?: Record<string, unknown>) => {
				assert.equal(command, piBinary);
				execCalls.push(args.join(" "));
				execCwds.push(options?.cwd);
				return { stdout: "OK\n", stderr: "", code: 0, killed: false };
			},
		};
		const ctx = makeCtx(process.cwd(), [
			{ provider: "openai-codex", id: "gpt-5.3-codex-spark", reasoning: true, name: "Spark" },
			{ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true, name: "Mini" },
			{ provider: "openai-codex", id: "gpt-5.4", reasoning: true, name: "Base" },
			{ provider: "openai-codex", id: "gpt-5.5", reasoning: true, name: "Best" },
		]);

		const result = await refreshProviderModelCatalog(pi, ctx as never, "openai-codex");
		assert.equal(result.reused, false);
		assert.equal(fs.existsSync(result.filePath), true);
		assert.equal(result.catalog.models.length, 4);
		assert.equal(execCalls.length, 4);
		assert.equal(execCalls.every((call) => call.includes("--no-tools")), true);
		assert.equal(execCalls.some((call) => call.includes("--tools read")), false);
		assert.deepEqual(execCwds, [os.tmpdir(), os.tmpdir(), os.tmpdir(), os.tmpdir()]);
		assert.deepEqual(result.catalog.models.map((entry) => entry.fullId), [
			"openai-codex/gpt-5.3-codex-spark",
			"openai-codex/gpt-5.4-mini",
			"openai-codex/gpt-5.4",
			"openai-codex/gpt-5.5",
		]);
		assert.equal(readProviderModelCatalog("openai-codex")?.provider, "openai-codex");
		assert.equal(result.heuristicFallbackCount, 4);
		assert.deepEqual(result.catalog.models[0]?.derived.classificationSources, ["heuristic-name"]);
		assert.deepEqual(result.catalog.models[0]?.warnings, ["Classification fell back to name heuristics."]);
	});

	it("does not count heuristic fallback when official metadata is present", async () => {
		const pi = {
			exec: async () => ({ stdout: "OK\n", stderr: "", code: 0, killed: false }),
		};
		const ctx = makeCtx(process.cwd(), [
			{
				provider: "openai",
				id: "gpt-5-mini",
				name: "GPT-5 Mini",
				reasoning: true,
				contextWindow: 128000,
				maxTokens: 16000,
				cost: { input: 0.25, output: 2 },
			},
			{
				provider: "openai",
				id: "gpt-5",
				name: "GPT-5",
				reasoning: true,
				contextWindow: 200000,
				maxTokens: 32000,
				cost: { input: 1.25, output: 10 },
			},
		]);
		const result = await refreshProviderModelCatalog(pi, ctx as never, "openai");
		assert.equal(result.heuristicFallbackCount, 0);
		assert.deepEqual(result.catalog.models[0]?.derived.classificationSources, ["official-metadata", "heuristic-name"]);
		assert.deepEqual(result.catalog.models[0]?.warnings, []);
	});

	it("reuses a fresh provider model catalog", async () => {
		const pi = {
			exec: async () => {
				throw new Error("should not probe fresh cache");
			},
		};
		const filePath = getProviderModelsPath("openai-codex");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify({
			provider: "openai-codex",
			refreshedAt: new Date().toISOString(),
			maxAgeDays: DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS,
			sources: ["runtime-registry"],
			models: [],
		}, null, 2));
		const result = await refreshProviderModelCatalog(pi, makeCtx(process.cwd(), []) as never, "openai-codex");
		assert.equal(result.reused, true);
	});

	it("generates quota and quality profiles from sorted provider models", async () => {
		const pi = {
			exec: async () => ({ stdout: "OK\n", stderr: "", code: 0, killed: false }),
		};
		const ctx = makeCtx(process.cwd(), [
			{ provider: "openai-codex", id: "gpt-5.3-codex-spark", reasoning: true },
			{ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: true },
			{ provider: "openai-codex", id: "gpt-5.4", reasoning: true },
			{ provider: "openai-codex", id: "gpt-5.5", reasoning: true },
		]);

		const result = await generateProfilesForProvider(pi, ctx as never, "openai-codex");
		assert.equal(result.heuristicFallbackCount, 4);
		assert.equal(result.selectedHeuristicFallbackCount, 4);
		assert.equal(result.quotaModels.cheap, "openai-codex/gpt-5.3-codex-spark");
		assert.equal(result.quotaModels.medium, "openai-codex/gpt-5.4-mini");
		assert.equal(result.quotaModels.strong, "openai-codex/gpt-5.4-mini");
		assert.equal(result.qualityModels.cheap, "openai-codex/gpt-5.4-mini");
		assert.equal(result.qualityModels.medium, "openai-codex/gpt-5.4");
		assert.equal(result.qualityModels.strong, "openai-codex/gpt-5.5");
	});

	it("does not treat provider names like MiniMax as mini-tier tokens and prefers M3 over M2.7-highspeed for quality", async () => {
		const pi = {
			exec: async () => ({ stdout: "OK\n", stderr: "", code: 0, killed: false }),
		};
		const ctx = makeCtx(process.cwd(), [
			{
				provider: "minimax",
				id: "MiniMax-M2.7",
				name: "MiniMax-M2.7",
				reasoning: true,
				contextWindow: 204800,
				maxTokens: 131072,
				cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
			},
			{
				provider: "minimax",
				id: "MiniMax-M3",
				name: "MiniMax-M3",
				reasoning: true,
				contextWindow: 512000,
				maxTokens: 128000,
				cost: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
			},
			{
				provider: "minimax",
				id: "MiniMax-M2.7-highspeed",
				name: "MiniMax-M2.7-highspeed",
				reasoning: true,
				contextWindow: 204800,
				maxTokens: 131072,
				cost: { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 },
			},
		]);

		const refreshed = await refreshProviderModelCatalog(pi, ctx as never, "minimax");
		const highspeed = refreshed.catalog.models.find((entry) => entry.fullId === "minimax/MiniMax-M2.7-highspeed");
		const m3 = refreshed.catalog.models.find((entry) => entry.fullId === "minimax/MiniMax-M3");
		assert.equal(highspeed?.derived.latencyTier, "fast");
		assert.equal(typeof highspeed?.derived.profileRank, "number");
		assert.equal(typeof m3?.derived.profileRank, "number");
		assert.equal((m3?.derived.profileRank ?? 0) > (highspeed?.derived.profileRank ?? 0), true);
		const result = await generateProfilesForProvider(pi, ctx as never, "minimax", { forceRefresh: true });
		assert.equal(result.quotaModels.cheap, "minimax/MiniMax-M2.7");
		assert.equal(result.quotaModels.medium, "minimax/MiniMax-M2.7");
		assert.equal(result.quotaModels.strong, "minimax/MiniMax-M2.7");
		assert.equal(result.qualityModels.strong, "minimax/MiniMax-M3");
		assert.equal(Object.values(result.quotaModels).includes("minimax/MiniMax-M2.7-highspeed"), false);
		assert.equal(Object.values(result.qualityModels).includes("minimax/MiniMax-M2.7-highspeed"), false);
	});

	it("checks a profile against the registry and live probe", async () => {
		const profilesDir = getSubagentProfilesDir();
		fs.mkdirSync(profilesDir, { recursive: true });
		fs.writeFileSync(path.join(profilesDir, "demo.json"), JSON.stringify({
			subagents: {
				agentOverrides: {
					scout: { model: "openai-codex/gpt-5.3-codex-spark" },
					worker: { model: "openai-codex/gpt-5.9" },
				},
			},
		}, null, 2));
		const pi = {
			exec: async (_command: string, args: string[]) => {
				const model = args[2];
				if (model === "openai-codex/gpt-5.9") {
					return { stdout: "", stderr: "model unavailable", code: 1, killed: false };
				}
				return { stdout: "OK\n", stderr: "", code: 0, killed: false };
			},
		};
		const ctx = makeCtx(process.cwd(), [{ provider: "openai-codex", id: "gpt-5.3-codex-spark" }]);
		const result = await checkSubagentProfile(pi, ctx as never, "demo");
		assert.deepEqual(result.results, [
			{
				agent: "scout",
				model: "openai-codex/gpt-5.3-codex-spark",
				inRegistry: true,
				probe: { status: "ok", message: "OK" },
			},
			{
				agent: "worker",
				model: "openai-codex/gpt-5.9",
				inRegistry: false,
				probe: { status: "unavailable", message: "model unavailable" },
			},
		]);
	});

	it("checks short model ids and thinking suffixes against the registry", async () => {
		const profilesDir = getSubagentProfilesDir();
		fs.mkdirSync(profilesDir, { recursive: true });
		fs.writeFileSync(path.join(profilesDir, "demo.json"), JSON.stringify({
			subagents: { agentOverrides: { scout: { model: "gpt-5.3-codex-spark:high" } } },
		}, null, 2));
		const probedModels: unknown[] = [];
		const pi = {
			exec: async (_command: string, args: string[]) => {
				probedModels.push(args[2]);
				assert.equal(args.includes("--no-tools"), true);
				assert.equal(args.includes("--tools"), false);
				return { stdout: "OK\n", stderr: "", code: 0, killed: false };
			},
		};
		const ctx = makeCtx(process.cwd(), [{ provider: "openai-codex", id: "gpt-5.3-codex-spark" }]);
		const result = await checkSubagentProfile(pi, ctx as never, "demo");
		assert.equal(result.results[0]?.inRegistry, true);
		assert.deepEqual(probedModels, ["openai-codex/gpt-5.3-codex-spark:high"]);
	});
});
