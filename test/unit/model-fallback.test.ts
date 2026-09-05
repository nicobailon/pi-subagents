import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildModelCandidates,
	fuzzyResolveModel,
	formatSubagentModelVerificationError,
	isContextOverflow,
	isRetryableModelFailure,
	isRetryableModelFailureAttempt,
	normalizeModelSegment,
	recordRetryableModelFailure,
	resolveEffectiveSubagentModel,
	resolveModelCandidate,
	resolveSubagentModelOverride,
} from "../../src/runs/shared/model-fallback.ts";
import { clearExclusions, findModelExclusion, getExcludedCount, recordModelFailure } from "../../src/runs/shared/model-exclusions.ts";
import { resolveModelScopesForAgent } from "../../src/runs/shared/model-scope.ts";

beforeEach(() => clearExclusions());
afterEach(() => clearExclusions());

describe("model fallback helpers", () => {
	const availableModels = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
		{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
	];

	it("keeps explicit provider/model ids unchanged", () => {
		assert.equal(resolveModelCandidate("openai/gpt-5-mini", availableModels), "openai/gpt-5-mini");
	});

	it("fails verification when the child reports an unregistered different model", () => {
		assert.match(
			formatSubagentModelVerificationError("openai/gpt-5-mini:high", "unknown-provider/wrong-model", availableModels) ?? "",
			/model_verification_failed/,
		);
	});

	it("accepts child-reported bare model ids for the expected registry entry", () => {
		assert.equal(
			formatSubagentModelVerificationError("openai/gpt-5-mini:high", "gpt-5-mini", availableModels),
			undefined,
		);
	});

	it("preserves variant tags when verifying provider-qualified model ids", () => {
		assert.equal(
			formatSubagentModelVerificationError(
				"ollama-cloud/deepseek-v4-flash:0731:high",
				"deepseek-v4-flash:0731",
				[{ provider: "ollama-cloud", id: "deepseek-v4-flash:0731", fullId: "ollama-cloud/deepseek-v4-flash:0731" }],
			),
			undefined,
		);
	});

	it("accepts a bare leaf reported by an Anthropic gateway driver", () => {
		const gatewayModels = [{
			provider: "bifrost-anthropic",
			id: "vertex/claude-fable-5",
			fullId: "bifrost-anthropic/vertex/claude-fable-5",
		}];
		assert.equal(
			formatSubagentModelVerificationError(
				"bifrost-anthropic/vertex/claude-fable-5:high",
				"claude-fable-5",
				gatewayModels,
			),
			undefined,
		);
		assert.match(
			formatSubagentModelVerificationError(
				"bifrost-anthropic/vertex/claude-fable-5:high",
				"wrong-provider/claude-fable-5",
				gatewayModels,
			) ?? "",
			/model_verification_failed/,
		);
		assert.match(
			formatSubagentModelVerificationError(
				"bifrost-anthropic/vertex/claude-fable-5:high",
				"claude-sonnet-4",
				gatewayModels,
			) ?? "",
			/model_verification_failed/,
		);
	});

	it("accepts exact response aliases only for the resolved candidate route", () => {
		const route = "databricks-bedrock/ias-claude-opus-5";
		const registry = [{ provider: "databricks-bedrock", id: "ias-claude-opus-5", fullId: route }];
		const aliases = { [route]: ["claude-opus-5"] };
		const candidate = resolveModelCandidate("ias-claude-opus-5:high", registry)!;
		assert.equal(candidate, `${route}:high`);
		assert.equal(formatSubagentModelVerificationError(candidate, "claude-opus-5", registry, aliases), undefined);
		for (const expected of ["other-provider/ias-claude-opus-5", "databricks-bedrock/other-route", "ias-claude-opus-5"]) {
			assert.match(formatSubagentModelVerificationError(expected, "claude-opus-5", registry, aliases) ?? "", /model_verification_failed/);
		}
		for (const observed of ["wrong-provider/claude-opus-5", "claude-opus-4", "opus-5", "Claude-Opus-5", "claude-opus-5:high"]) {
			assert.match(formatSubagentModelVerificationError(candidate, observed, registry, aliases) ?? "", /model_verification_failed/);
		}
		for (const map of [undefined, {}, { [route]: [] }]) {
			assert.match(formatSubagentModelVerificationError(candidate, "claude-opus-5", registry, map) ?? "", /model_verification_failed/);
		}
		assert.equal(formatSubagentModelVerificationError(candidate, "response:high", registry, { [route]: ["response:high"] }), undefined);
		assert.match(formatSubagentModelVerificationError(candidate, "response", registry, { [route]: ["response:high"] }) ?? "", /model_verification_failed/);
	});

	it("resolves unique owner/name ids when the owner is not a registered provider", () => {
		const registry = [
			...availableModels,
			{ provider: "huggingface", id: "thinkingmachines/Inkling", fullId: "huggingface/thinkingmachines/Inkling" },
		];
		assert.equal(resolveModelCandidate("thinkingmachines/Inkling", registry), "huggingface/thinkingmachines/Inkling");
		assert.equal(
			resolveModelCandidate("huggingface/thinkingmachines/Inkling", registry),
			"huggingface/thinkingmachines/Inkling",
		);
		assert.equal(
			resolveModelCandidate("thinkingmachines/Inkling:high", registry),
			"huggingface/thinkingmachines/Inkling:high",
		);
	});

	it("prefers the current provider for an ambiguous owner/name id", () => {
		const registry = [
			{ provider: "huggingface", id: "thinkingmachines/Inkling", fullId: "huggingface/thinkingmachines/Inkling" },
			{ provider: "together", id: "thinkingmachines/Inkling", fullId: "together/thinkingmachines/Inkling" },
		];
		assert.equal(resolveModelCandidate("thinkingmachines/Inkling", registry), "thinkingmachines/Inkling");
		assert.equal(
			resolveModelCandidate("thinkingmachines/Inkling", registry, "huggingface"),
			"huggingface/thinkingmachines/Inkling",
		);
	});

	it("treats a registered provider prefix as provider/id, not owner/name", () => {
		const registry = [
			{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
			{ provider: "huggingface", id: "openai/gpt-5-mini", fullId: "huggingface/openai/gpt-5-mini" },
		];
		assert.equal(resolveModelCandidate("openai/gpt-5-mini", registry), "openai/gpt-5-mini");
	});

	it("resolves a bare id when there is exactly one registry match", () => {
		assert.equal(resolveModelCandidate("gpt-5-mini", availableModels), "openai/gpt-5-mini");
	});

	it("preserves thinking suffix when resolving a bare id", () => {
		assert.equal(resolveModelCandidate("gpt-5-mini:high", availableModels), "openai/gpt-5-mini:high");
	});

	it("leaves ambiguous bare ids untouched", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
		];
		assert.equal(resolveModelCandidate("gpt-5-mini", ambiguous), "gpt-5-mini");
	});

	it("prefers the current provider when an ambiguous bare id exists there", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
		];
		assert.equal(resolveModelCandidate("gpt-5-mini", ambiguous, "github-copilot"), "github-copilot/gpt-5-mini");
	});

	it("falls back to the unique registry match when the current provider does not offer the model", () => {
		assert.equal(resolveModelCandidate("claude-sonnet-4", availableModels, "github-copilot"), "anthropic/claude-sonnet-4");
	});

	it("builds a deduplicated ordered candidate list", () => {
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["openai/gpt-5-mini", "anthropic/claude-sonnet-4", "gpt-5-mini"], availableModels),
			["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("excludes a candidate after a retryable model failure is recorded", () => {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message: unknown) => warnings.push(String(message));
		try {
			recordRetryableModelFailure("openai/gpt-5-mini", "rate limit exceeded for Bearer secret-token-value");
			assert.deepEqual(
				buildModelCandidates("gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels),
				["anthropic/claude-sonnet-4"],
			);
		} finally {
			console.warn = originalWarn;
		}
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /Skipping model 'openai\/gpt-5-mini'.*reason: rate limit exceeded for \[redacted\]; expires: \d{4}-\d{2}-\d{2}T/);
		assert.doesNotMatch(warnings[0]!, /secret-token-value/);
	});

	it("does not exclude a candidate after a task or tool failure", () => {
		recordRetryableModelFailure("openai/gpt-5-mini", "bash failed (exit 1): command not found");

		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels),
			["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("does not cache context overflow even when upstream makes it retryable", () => {
		const error = "upstream: maximum context length exceeded";
		assert.equal(isRetryableModelFailure(error), true);
		assert.equal(isContextOverflow(error), true);
		recordRetryableModelFailure("openai/gpt-5-mini", error);
		assert.equal(getExcludedCount(), 0);
	});

	it("still caches raw request limits and per-minute input-token rate quotas", () => {
		for (const error of [
			"REQUEST_LIMIT_EXCEEDED",
			'{"error_code":"REQUEST_LIMIT_EXCEEDED","message":"REQUEST_LIMIT_EXCEEDED: Exceeded workspace input tokens per minute rate limit for <model>."}',
		]) {
			clearExclusions();
			assert.equal(isContextOverflow(error), false);
			recordRetryableModelFailure("openai/gpt-5-mini", error);
			assert.equal(findModelExclusion("openai/gpt-5-mini")?.reason, error);
			assert.equal(getExcludedCount(), 1);
		}
	});

	it("applies the current provider preference to fallback candidates too", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
		];
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["gpt-5-mini", "anthropic/claude-sonnet-4"], ambiguous, "github-copilot"),
			["github-copilot/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("skips unavailable fallback models and warns once for each", () => {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message: unknown) => warnings.push(String(message));
		try {
			assert.deepEqual(
				buildModelCandidates("gpt-5-mini", ["does-not-exist", "also-unavailable"], availableModels),
				["openai/gpt-5-mini"],
			);
		} finally {
			console.warn = originalWarn;
		}
		assert.deepEqual(warnings, [
			"[pi-subagents] Skipping fallback model 'does-not-exist' because it is unavailable in this environment.",
			"[pi-subagents] Skipping fallback model 'also-unavailable' because it is unavailable in this environment.",
		]);
	});

	it("skips an unavailable configured primary and continues to available fallbacks", () => {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message: unknown) => warnings.push(String(message));
		try {
			assert.deepEqual(
				buildModelCandidates("does-not-exist", ["anthropic/claude-sonnet-4"], availableModels),
				["anthropic/claude-sonnet-4"],
			);
		} finally {
			console.warn = originalWarn;
		}
		assert.deepEqual(warnings, [
			"[pi-subagents] Skipping primary model 'does-not-exist' because it is unavailable in this environment.",
		]);
	});

	it("fails closed when no configured candidate resolves", () => {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message: unknown) => warnings.push(String(message));
		try {
			assert.throws(
				() => buildModelCandidates("does-not-exist", ["also-unavailable"], availableModels),
				/Unknown subagent model 'does-not-exist'/,
			);
			assert.throws(
				() => buildModelCandidates("does-not-exist", undefined, availableModels),
				/Unknown subagent model 'does-not-exist'/,
			);
		} finally {
			console.warn = originalWarn;
		}
		assert.ok(warnings.some((warning) => warning.includes("Skipping fallback model 'also-unavailable'")));
		assert.equal(warnings.some((warning) => warning.includes("Skipping primary model 'does-not-exist'")), false);
	});

	it("fails closed when fallback-only configuration resolves no candidates", () => {
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			assert.throws(
				() => buildModelCandidates(undefined, ["does-not-exist"], availableModels),
				/Unknown subagent model 'does-not-exist'/,
			);
		} finally {
			console.warn = originalWarn;
		}
	});

	it("keeps an explicit unknown primary strict even when fallbacks exist", () => {
		assert.throws(
			() => buildModelCandidates("does-not-exist", ["anthropic/claude-sonnet-4"], availableModels, undefined, { origin: "explicit" }),
			/Unknown subagent model 'does-not-exist'/,
		);
	});

	it("keeps eligible fallbacks after a valid explicit primary", () => {
		assert.deepEqual(
			buildModelCandidates("openai/gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels, undefined, { origin: "explicit" }),
			["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("ignores stale model-not-found exclusions when the model is back in the registry", () => {
		recordModelFailure({
			modelId: "gpt-5-mini",
			provider: "openai",
			reason: 'Model "openai/gpt-5-mini" not found. Use --list-models to see available models.',
		});
		assert.deepEqual(buildModelCandidates("openai/gpt-5-mini", undefined, availableModels), ["openai/gpt-5-mini"]);
	});

	it("keeps provider-wide exclusions when ignoring a stale model-not-found entry", () => {
		recordModelFailure({ provider: "openai", reason: "quota exceeded" });
		recordModelFailure({
			modelId: "gpt-5-mini",
			provider: "openai",
			reason: 'Model "openai/gpt-5-mini" not found. Use --list-models to see available models.',
		});
		assert.throws(
			() => buildModelCandidates("openai/gpt-5-mini", undefined, availableModels),
			/No usable subagent models remain after registry, scope, and cached-exclusion filtering/,
		);
	});

	it("keeps explicit stale model-not-found exclusions strict", () => {
		recordModelFailure({
			modelId: "gpt-5-mini",
			provider: "openai",
			reason: 'Model "openai/gpt-5-mini" not found. Use --list-models to see available models.',
		});
		assert.throws(
			() => buildModelCandidates("openai/gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels, undefined, { origin: "explicit" }),
			/Requested subagent model 'openai\/gpt-5-mini' is excluded and cannot be replaced by a fallback/,
		);
	});

	it("keeps an explicit cached-excluded primary strict even when fallbacks exist", () => {
		recordModelFailure({ modelId: "gpt-5-mini", provider: "openai", reason: "sk-secret-token-xyz" });
		assert.throws(
			() => buildModelCandidates("openai/gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels, undefined, { origin: "explicit" }),
			/Requested subagent model 'openai\/gpt-5-mini' is excluded and cannot be replaced by a fallback/,
		);
	});

	it("rejects an explicit non-strict out-of-scope primary before fallbacks", () => {
		assert.throws(
			() => buildModelCandidates("anthropic/claude-sonnet-4", ["openai/gpt-5-mini"], availableModels, undefined, {
				origin: "explicit",
				scope: { enforce: true, allow: ["openai/*"] },
			}),
			/outside the configured subagent model scope/,
		);
	});

	it("fails closed with a sanitized error when cached exclusions leave zero candidates", () => {
		recordModelFailure({ modelId: "gpt-5-mini", provider: "openai", reason: "sk-secret-token-xyz" });
		recordModelFailure({ modelId: "claude-sonnet-4", provider: "anthropic", reason: "sk-secret-token-xyz" });
		assert.throws(
			() => buildModelCandidates("openai/gpt-5-mini", ["anthropic/claude-sonnet-4"], availableModels),
			(error: unknown) => {
				const message = String(error);
				return /No usable subagent models remain after registry, scope, and cached-exclusion filtering/.test(message)
					&& /excluded: openai\/gpt-5-mini — model: gpt-5-mini; provider: openai; reason: \[redacted\]; expires: \d{4}-\d{2}-\d{2}T/.test(message)
					&& /excluded: .*anthropic\/claude-sonnet-4/.test(message)
					&& !message.includes("sk-secret-token-xyz");
			},
		);
	});

	it("keeps cached-exclusion diagnostics when an unrelated fallback is unavailable", () => {
		recordModelFailure({ modelId: "gpt-5-mini", provider: "openai", reason: "sk-secret-token-xyz" });
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			assert.throws(
				() => buildModelCandidates("openai/gpt-5-mini", ["does-not-exist"], availableModels),
				/No usable subagent models remain after registry, scope, and cached-exclusion filtering/,
			);
		} finally {
			console.warn = originalWarn;
		}
	});

	it("bounds and sanitizes excluded-candidate evidence", () => {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (message: unknown) => warnings.push(String(message));
		const candidates = Array.from({ length: 21 }, (_, index) => ({
			provider: index === 0 ? "sk-provider-secret" : "diagnostic-provider",
			id: index === 0 ? "sk-model-secret" : `diagnostic-model-${index}`,
			fullId: index === 0 ? "sk-provider-secret/sk-model-secret" : `diagnostic-provider/diagnostic-model-${index}`,
		}));
		for (const [index, candidate] of candidates.entries()) {
			recordModelFailure({
				modelId: candidate.id,
				provider: candidate.provider,
				reason: index === 0 ? "Bearer sk-secret-token-xyz\n" + "long-reason-".repeat(100) : `failure-${index}`,
			});
		}

		try {
			assert.throws(
				() => buildModelCandidates(candidates[0]!.fullId, candidates.slice(1).map((candidate) => candidate.fullId), candidates),
				(error: unknown) => {
					const message = String(error);
					assert.match(message, /excluded: \[redacted\]\/\[redacted\] — model: \[redacted\]; provider: \[redacted\]/);
					assert.match(message, /reason: \[redacted\] long-reason-/);
					assert.doesNotMatch(message, /sk-provider-secret|sk-model-secret|sk-secret-token-xyz/);
					assert.doesNotMatch(message, /[\r\n]/);
					assert.match(message, /diagnostic-model-19/);
					assert.doesNotMatch(message, /diagnostic-model-20/);
					assert.match(message, /\.\.\. and 1 more/);
					assert.equal((message.match(/reason: /g) ?? []).length, 20);
					return true;
				},
			);
		} finally {
			console.warn = originalWarn;
		}
		assert.equal(warnings.length, 21);
		assert.doesNotMatch(warnings.join("\n"), /sk-provider-secret|sk-model-secret|sk-secret-token-xyz/);
	});

	it("trusts an inherited parent model outside the registry", () => {
		assert.deepEqual(
			buildModelCandidates("gateway/parent-model", undefined, availableModels, undefined, { primaryModelFromParent: true }),
			["gateway/parent-model"],
		);
		assert.throws(
			() => buildModelCandidates("gateway/parent-model", undefined, availableModels),
			/Unknown subagent model 'gateway\/parent-model'/,
		);
	});

	it("detects retryable provider/model failures", () => {
		assert.equal(isRetryableModelFailure("rate limit exceeded for provider"), true);
		assert.equal(isRetryableModelFailure("The usage limit has been reached"), true);
		assert.equal(isRetryableModelFailure("model unavailable"), true);
		assert.equal(isRetryableModelFailure("authentication failed"), true);
		assert.equal(isRetryableModelFailure("Subagent produced no output (possible model cold-start or empty response)."), true);
		assert.equal(isRetryableModelFailure("model load failed"), true);
		assert.equal(isRetryableModelFailure("Stream ended without finish_reason"), true);
		assert.equal(isRetryableModelFailure("Connection error"), true);
		assert.equal(isRetryableModelFailure("APIConnectionError: Connection closed."), true);
		assert.equal(isRetryableModelFailure("Connection reset by peer"), true);
		assert.equal(isRetryableModelFailure("Request timed out."), true);
		assert.equal(isRetryableModelFailure("internal server error"), true);
		assert.equal(isRetryableModelFailure("500"), true);
	});

	it("does not treat ordinary task/tool failures as retryable model failures", () => {
		assert.equal(isRetryableModelFailure("bash failed (exit 1): command not found"), false);
		assert.equal(isRetryableModelFailure("read failed (exit 1): no such file or directory"), false);
		assert.equal(isRetryableModelFailure(undefined), false);
	});

	it("recognizes only the exact raw request-limit code without broadening limit families", () => {
		assert.equal(isRetryableModelFailure("REQUEST_LIMIT_EXCEEDED"), true);
		for (const error of ["TOKEN_LIMIT_EXCEEDED", "INPUT_LIMIT_EXCEEDED", "OUTPUT_LIMIT_EXCEEDED", "RESOURCE_EXHAUSTED", "NOT_REQUEST_LIMIT_EXCEEDED", "REQUEST_LIMIT_EXCEEDED_OTHER", "400"]) {
			assert.equal(isRetryableModelFailure(error), false, error);
		}
	});

	it("does not treat network-flavored tool failures as retryable model failures", () => {
		assert.equal(isRetryableModelFailure("bash failed (exit 1): requests.exceptions.ConnectionError: Connection error."), false);
		assert.equal(isRetryableModelFailure("bash failed (exit 1): urllib.error.URLError: request timed out"), false);
		assert.equal(isRetryableModelFailure("fetch_content failed with exit code 1"), false);
		assert.equal(isRetryableModelFailure("mcp.server/write failed (exit 1): request timed out"), false);
		assert.equal(isRetryableModelFailure("mcp:tools.search failed with exit code 1"), false);
		assert.equal(isRetryableModelFailure("Provider error: bash failed (exit 1): request timed out"), true);
		assert.equal(isRetryableModelFailure("bash failed (exit unknown): request timed out"), true);
	});

	it("does not retry raw process stderr after child activity", () => {
		assert.equal(isRetryableModelFailureAttempt({ error: "APIConnectionError: Connection closed.", messages: [{ role: "assistant" }], toolCount: 0 }), false);
		assert.equal(isRetryableModelFailureAttempt({ error: "APIConnectionError: Connection closed.", messages: [{ role: "assistant", errorMessage: "APIConnectionError: Connection closed." }], toolCount: 0 }), true);
		assert.equal(isRetryableModelFailureAttempt({ error: "APIConnectionError: Connection closed.", messages: [], toolCount: 0 }), true);
		assert.equal(isRetryableModelFailureAttempt({ error: "APIConnectionError: Connection closed.", messages: [{ role: "assistant", errorMessage: "APIConnectionError: Connection closed." }], toolCount: 1 }), false);
	});
});

describe("resolveSubagentModelOverride (cross-session inherit, issue #266)", () => {
	const availableModels = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
		{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
	];
	const parentModel = { provider: "deepseek", id: "deepseek-v4-flash" };

	it("inherits the parent session model when no model is requested", () => {
		// The crux of the bug: an undefined model must NOT collapse to `undefined`
		// (which leaves the child to read the shared global settings.json), but
		// must pin the parent session's in-memory provider/id.
		assert.equal(
			resolveSubagentModelOverride(undefined, parentModel, availableModels),
			"deepseek/deepseek-v4-flash",
		);
	});

	it("inherits the parent session model when the model is the \"inherit\" sentinel", () => {
		assert.equal(
			resolveSubagentModelOverride("inherit", parentModel, availableModels),
			"deepseek/deepseek-v4-flash",
		);
	});

	it("inherits the parent session model when the agent config sets model: false (delegate)", () => {
		assert.equal(
			resolveSubagentModelOverride(false, parentModel, availableModels),
			"deepseek/deepseek-v4-flash",
		);
	});

	it("treats an empty or whitespace-only model as inherit", () => {
		assert.equal(resolveSubagentModelOverride("", parentModel, availableModels), "deepseek/deepseek-v4-flash");
		assert.equal(resolveSubagentModelOverride("   ", parentModel, availableModels), "deepseek/deepseek-v4-flash");
	});

	it("trims surrounding whitespace from the \"inherit\" sentinel", () => {
		assert.equal(resolveSubagentModelOverride("  inherit  ", parentModel, availableModels), "deepseek/deepseek-v4-flash");
	});

	it("keeps an explicit provider/id model unchanged", () => {
		assert.equal(
			resolveSubagentModelOverride("anthropic/claude-sonnet-4", parentModel, availableModels),
			"anthropic/claude-sonnet-4",
		);
	});

	it("resolves an explicit bare id against the registry, not the parent", () => {
		assert.equal(
			resolveSubagentModelOverride("gpt-5-mini", parentModel, availableModels),
			"openai/gpt-5-mini",
		);
	});

	it("fails visibly when an explicit model is excluded instead of falling back", () => {
		recordModelFailure({ modelId: "gpt-5-mini", provider: "openai", reason: "rate limit" });
		assert.throws(
			() => resolveEffectiveSubagentModel("openai/gpt-5-mini", undefined, parentModel, availableModels),
			(error: unknown) => {
				const message = String(error);
				return message.includes("openai/gpt-5-mini") && message.includes("rate limit") && message.includes("expires:");
			},
		);
	});

	it("resolves owner/name frontmatter models against the registry", () => {
		const models = [
			...availableModels,
			{ provider: "huggingface", id: "thinkingmachines/Inkling", fullId: "huggingface/thinkingmachines/Inkling" },
		];
		assert.equal(
			resolveSubagentModelOverride("thinkingmachines/Inkling", parentModel, models, "huggingface"),
			"huggingface/thinkingmachines/Inkling",
		);
	});

	it("rejects explicit models that the active registry cannot resolve", () => {
		assert.throws(
			() => resolveSubagentModelOverride("does-not-exist", parentModel, availableModels, undefined, { source: "explicit" }),
			/Unknown subagent model 'does-not-exist'/,
		);
		assert.throws(
			() => resolveSubagentModelOverride("does-not-exist:high", parentModel, availableModels, undefined, { source: "explicit" }),
			/Unknown subagent model 'does-not-exist:high'/,
		);
	});

	it("suggests a unique alternate provider without resolving across providers", () => {
		assert.throws(
			() => resolveSubagentModelOverride("openai/claude-sonnet-4:high", parentModel, availableModels, undefined, { source: "explicit" }),
			/Unknown subagent model 'openai\/claude-sonnet-4:high'.*Did you mean 'anthropic\/claude-sonnet-4:high'\?/,
		);
	});

	it("does not suggest an alternate provider when the bare id is ambiguous or absent", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "claude-sonnet-4", fullId: "github-copilot/claude-sonnet-4" },
		];
		assert.throws(
			() => resolveSubagentModelOverride("openai/claude-sonnet-4", parentModel, ambiguous, undefined, { source: "explicit" }),
			(error: unknown) => !String(error).includes("Did you mean"),
		);
		assert.throws(
			() => resolveSubagentModelOverride("openai/does-not-exist", parentModel, availableModels, undefined, { source: "explicit" }),
			(error: unknown) => !String(error).includes("Did you mean"),
		);
	});

	it("returns undefined when inheriting but no parent model is known", () => {
		// No parent session model available: fall back to the prior behavior of
		// emitting no override rather than inventing an invalid one.
		assert.equal(resolveSubagentModelOverride(undefined, undefined, availableModels), undefined);
		assert.equal(resolveSubagentModelOverride("inherit", undefined, availableModels), undefined);
		assert.equal(resolveSubagentModelOverride(false, undefined, availableModels), undefined);
	});

	it("never emits the literal \"inherit\" string as a model", () => {
		// Regression guard: the old resolveModelCandidate returned "inherit" verbatim
		// (no registry match), which the child rejected and silently fell back to
		// the global default.
		assert.notEqual(resolveSubagentModelOverride("inherit", parentModel, availableModels), "inherit");
		assert.notEqual(resolveSubagentModelOverride("inherit", undefined, availableModels), "inherit");
	});
});

describe("resolveEffectiveSubagentModel", () => {
	const availableModels = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
	];

	it("falls back to the agent model when inheritance has no parent", () => {
		assert.equal(resolveEffectiveSubagentModel("", "openai/gpt-5-mini", undefined, availableModels), "openai/gpt-5-mini");
		assert.equal(resolveEffectiveSubagentModel("inherit", "openai/gpt-5-mini", undefined, availableModels), "openai/gpt-5-mini");
	});

	it("keeps agent models inherited for scope enforcement", () => {
		const warnings: string[] = [];
		assert.equal(
			resolveEffectiveSubagentModel(undefined, "openai/gpt-5-mini", undefined, availableModels, undefined, {
				scope: { enforce: true, allow: ["anthropic/*"] },
				onWarn: (violation) => warnings.push(violation.message),
			}),
			"openai/gpt-5-mini",
		);
		assert.equal(warnings.length, 1);
	});

	it("uses the preferred provider for an ambiguous agent model", () => {
		const registry = [
			...availableModels,
			{ provider: "gpu-b", id: "gpt-5-mini", fullId: "gpu-b/gpt-5-mini" },
		];

		assert.equal(
			resolveEffectiveSubagentModel(undefined, "gpt-5-mini", undefined, registry, "gpu-b"),
			"gpu-b/gpt-5-mini",
		);
	});

	it("does not throw for an unavailable inherited agent model", () => {
		assert.equal(
			resolveEffectiveSubagentModel(undefined, "does-not-exist", { provider: "openai", id: "gpt-5-mini" }, availableModels),
			"does-not-exist",
		);
	});

	it("still throws for an explicit unknown per-call model", () => {
		assert.throws(
			() => resolveEffectiveSubagentModel("does-not-exist", "openai/gpt-5-mini", { provider: "openai", id: "gpt-5-mini" }, availableModels),
			/Unknown subagent model 'does-not-exist'/,
		);
	});
});

describe("fuzzyResolveModel / normalizeModelSegment", () => {
	const registry = [
		{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
		{ provider: "anthropic", id: "claude-haiku-4-5", fullId: "anthropic/claude-haiku-4-5" },
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
		{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
	];

	it("normalizes dots, underscores, case, and repeated dashes", () => {
		assert.equal(normalizeModelSegment("Claude.Sonnet_4"), "claude-sonnet-4");
		assert.equal(normalizeModelSegment("GPT--5.Mini"), "gpt-5-mini");
	});

	it("fuzzy-matches a bare id with separator/case differences", () => {
		assert.equal(fuzzyResolveModel("Claude-Sonnet-4", registry), "anthropic/claude-sonnet-4");
		assert.equal(fuzzyResolveModel("claude.haiku.4.5", registry), "anthropic/claude-haiku-4-5");
	});

	it("fuzzy-matches a bare id with an optional trailing date stamp", () => {
		assert.equal(fuzzyResolveModel("claude-haiku-4-5-20251001", registry), "anthropic/claude-haiku-4-5");
		assert.equal(fuzzyResolveModel("claude-haiku-4-5-2025-10-01", registry), "anthropic/claude-haiku-4-5");
	});

	it("does not strip arbitrary trailing 8-digit numbers as date stamps", () => {
		const numbered = [{ provider: "test", id: "model", fullId: "test/model" }];
		assert.equal(fuzzyResolveModel("model-12345678", numbered), undefined);
	});

	it("fuzzy-matches an undated query against a dated registry id", () => {
		const dated = [
			{ provider: "anthropic", id: "claude-3-5-sonnet-20241022", fullId: "anthropic/claude-3-5-sonnet-20241022" },
			{ provider: "openai", id: "gpt-5-2025-10-01", fullId: "openai/gpt-5-2025-10-01" },
		];
		assert.equal(fuzzyResolveModel("claude-3-5-sonnet", dated), "anthropic/claude-3-5-sonnet-20241022");
		assert.equal(fuzzyResolveModel("gpt-5", dated), "openai/gpt-5-2025-10-01");
	});

	it("fuzzy-matches a qualified provider/id with case/separator differences", () => {
		assert.equal(fuzzyResolveModel("Anthropic/Claude-Sonnet-4", registry), "anthropic/claude-sonnet-4");
		assert.equal(fuzzyResolveModel("Anthropic:Claude-Sonnet-4", registry), "anthropic/claude-sonnet-4");
		assert.equal(fuzzyResolveModel("anthropic.claude.haiku.4.5", registry), "anthropic/claude-haiku-4-5");
		assert.equal(fuzzyResolveModel("anthropic/claude.haiku.4.5", registry), "anthropic/claude-haiku-4-5");
	});

	it("fuzzy-matches owner/name ids when the owner is not a registered provider", () => {
		const hfRegistry = [
			...registry,
			{ provider: "huggingface", id: "thinkingmachines/Inkling", fullId: "huggingface/thinkingmachines/Inkling" },
		];
		assert.equal(fuzzyResolveModel("ThinkingMachines/Inkling", hfRegistry), "huggingface/thinkingmachines/Inkling");
		assert.equal(
			fuzzyResolveModel("huggingface/ThinkingMachines/Inkling", hfRegistry),
			"huggingface/thinkingmachines/Inkling",
		);
	});

	it("does not switch providers for a qualified query", () => {
		// Named provider has no such model; do not fall back to another provider.
		assert.equal(fuzzyResolveModel("openai/claude-sonnet-4", registry), undefined);
		assert.equal(fuzzyResolveModel("github-copilot/claude-haiku-4-5", registry), undefined);
	});

	it("prefers the current provider for an ambiguous bare fuzzy id", () => {
		assert.equal(fuzzyResolveModel("GPT.5.Mini", registry, "github-copilot"), "github-copilot/gpt-5-mini");
	});

	it("returns undefined for an ambiguous bare fuzzy id with no preferred provider", () => {
		assert.equal(fuzzyResolveModel("gpt-5-mini", registry), undefined);
	});

	it("returns undefined when nothing fuzzy-matches", () => {
		assert.equal(fuzzyResolveModel("does-not-exist", registry), undefined);
		assert.equal(fuzzyResolveModel("anthropic/does-not-exist", registry), undefined);
	});
});

describe("resolveModelCandidate fuzzy fallback", () => {
	const registry = [
		{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
		{ provider: "anthropic", id: "claude-haiku-4-5", fullId: "anthropic/claude-haiku-4-5" },
	];

	it("resolves a bare id with case/separator differences via fuzzy fallback", () => {
		assert.equal(resolveModelCandidate("Claude-Sonnet-4", registry), "anthropic/claude-sonnet-4");
		assert.equal(resolveModelCandidate("claude.haiku.4.5", registry), "anthropic/claude-haiku-4-5");
	});

	it("resolves a bare id with a trailing date stamp via fuzzy fallback", () => {
		assert.equal(resolveModelCandidate("claude-haiku-4-5-20251001", registry), "anthropic/claude-haiku-4-5");
	});

	it("resolves a qualified provider/id with case differences via fuzzy fallback", () => {
		assert.equal(resolveModelCandidate("Anthropic/Claude-Sonnet-4", registry), "anthropic/claude-sonnet-4");
		assert.equal(resolveModelCandidate("Anthropic:Claude-Sonnet-4", registry), "anthropic/claude-sonnet-4");
	});

	it("preserves the thinking suffix through fuzzy resolution", () => {
		assert.equal(resolveModelCandidate("claude.haiku.4.5:high", registry), "anthropic/claude-haiku-4-5:high");
		assert.equal(resolveModelCandidate("anthropic:claude.sonnet.4:high", registry), "anthropic/claude-sonnet-4:high");
	});

	it("still prefers exact registry matches over fuzzy", () => {
		assert.equal(resolveModelCandidate("anthropic/claude-sonnet-4", registry), "anthropic/claude-sonnet-4");
	});

	it("leaves an unknown qualified model unchanged instead of switching providers", () => {
		assert.equal(resolveModelCandidate("openai/claude-sonnet-4", registry), "openai/claude-sonnet-4");
	});

	it("leaves an unknown bare id unchanged when no fuzzy match exists", () => {
		assert.equal(resolveModelCandidate("does-not-exist", registry), "does-not-exist");
	});
});

describe("resolveSubagentModelOverride scope enforcement", () => {
	const availableModels = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
		{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
		{ provider: "deepseek", id: "deepseek-v4", fullId: "deepseek/deepseek-v4" },
	];
	const parentModel = { provider: "deepseek", id: "deepseek-v4" };
	const scope = { enforce: true, allow: ["anthropic/*", "openai/gpt-5-*"] } as const;

	it("is a no-op when scope is not enforced", () => {
		assert.equal(
			resolveSubagentModelOverride("deepseek/deepseek-v4", parentModel, availableModels, undefined, { scope: { enforce: false, allow: ["anthropic/*"] }, source: "explicit" }),
			"deepseek/deepseek-v4",
		);
	});

	it("throws for an explicit out-of-scope model", () => {
		assert.throws(
			() => resolveSubagentModelOverride("deepseek/deepseek-v4", parentModel, availableModels, undefined, { scope, source: "explicit" }),
			/outside the configured subagent model scope/,
		);
	});

	it("identifies the per-agent scope that rejects an explicit model", () => {
		const scopes = resolveModelScopesForAgent(
			{ enforce: true, allow: ["openai/*", "deepseek/*"], agents: { worker: { allow: ["openai/gpt-5-mini"] } } },
			"worker",
			parentModel,
		);
		assert.throws(
			() => resolveEffectiveSubagentModel("deepseek/deepseek-v4", undefined, parentModel, availableModels, undefined, { scope: scopes }),
			/modelScope\.agents\.worker/,
		);
	});

	it("allows an inherited parent model through an inherit agent scope", () => {
		const scopes = resolveModelScopesForAgent(
			{ enforce: true, agents: { reviewer: { allow: ["inherit"] } } },
			"reviewer",
			parentModel,
		);
		assert.equal(resolveEffectiveSubagentModel(undefined, undefined, parentModel, availableModels, undefined, { scope: scopes }), "deepseek/deepseek-v4");
	});

	it("fails closed when enforced inherit cannot resolve a parent model", () => {
		const scopes = resolveModelScopesForAgent(
			{ enforce: true, agents: { reviewer: { allow: ["inherit"] } } },
			"reviewer",
			undefined,
		);
		assert.throws(
			() => resolveEffectiveSubagentModel(undefined, undefined, undefined, availableModels, undefined, { scope: scopes }),
			/modelScope\.agents\.reviewer.*requires a current parent session model/,
		);
	});

	it("fails closed before using an agent fallback when enforced inherit has no parent model", () => {
		const scopes = resolveModelScopesForAgent(
			{ enforce: true, agents: { reviewer: { allow: ["inherit"] } } },
			"reviewer",
			undefined,
		);
		for (const explicitModel of [undefined, "inherit"] as const) {
			assert.throws(
				() => resolveEffectiveSubagentModel(explicitModel, "openai/gpt-5-mini", undefined, availableModels, undefined, { scope: scopes }),
				/modelScope\.agents\.reviewer.*requires a current parent session model/,
			);
		}
	});

	it("fails closed before using fallback candidates when enforced inherit has no parent model", () => {
		const scopes = resolveModelScopesForAgent(
			{ enforce: true, agents: { worker: { allow: ["inherit"] } } },
			"worker",
			undefined,
		);
		assert.throws(
			() => buildModelCandidates(undefined, ["openai/gpt-5-mini"], availableModels, undefined, { scope: scopes }),
			/modelScope\.agents\.worker.*requires a current parent session model/,
		);
	});

	it("fails closed for mixed inherit scopes before omitting the model", () => {
		const scopes = resolveModelScopesForAgent(
			{ enforce: true, agents: { worker: { allow: ["inherit", "openai/gpt-5-*"] } } },
			"worker",
			undefined,
		);
		assert.throws(
			() => resolveEffectiveSubagentModel(undefined, undefined, undefined, availableModels, undefined, { scope: scopes }),
			/modelScope\.agents\.worker.*requires a current parent session model/,
		);
		assert.throws(
			() => buildModelCandidates(undefined, ["openai/gpt-5-mini"], availableModels, undefined, { scope: scopes }),
			/modelScope\.agents\.worker.*requires a current parent session model/,
		);
	});

	it("allows an explicit model through a mixed inherit scope without a parent", () => {
		const scopes = resolveModelScopesForAgent(
			{ enforce: true, agents: { worker: { allow: ["inherit", "openai/gpt-5-*"] } } },
			"worker",
			undefined,
		);
		assert.equal(resolveEffectiveSubagentModel("openai/gpt-5-mini", undefined, undefined, availableModels, undefined, { scope: scopes }), "openai/gpt-5-mini");
	});

	it("fails closed before using an agent model through a mixed inherit scope without a parent", () => {
		const scopes = resolveModelScopesForAgent(
			{ enforce: true, agents: { worker: { allow: ["inherit", "openai/gpt-5-*"] } } },
			"worker",
			undefined,
		);
		assert.throws(
			() => resolveEffectiveSubagentModel(undefined, "openai/gpt-5-mini", undefined, availableModels, undefined, { scope: scopes }),
			/modelScope\.agents\.worker.*requires a current parent session model/,
		);
	});

	it("throws the strict agent violation before emitting a global warning", () => {
		const warnings: string[] = [];
		const scopes = resolveModelScopesForAgent(
			{ enforce: true, allow: ["openai/*"], agents: { worker: { strict: true, allow: ["anthropic/*"] } } },
			"worker",
			parentModel,
		);
		assert.throws(
			() => resolveEffectiveSubagentModel(undefined, undefined, parentModel, availableModels, undefined, { scope: scopes, onWarn: (violation) => warnings.push(violation.message) }),
			/modelScope\.agents\.worker/,
		);
		assert.deepEqual(warnings, []);
	});

	it("warns (and still returns the model) for an inherited out-of-scope model", () => {
		const warnings: string[] = [];
		const resolved = resolveSubagentModelOverride("deepseek/deepseek-v4", parentModel, availableModels, undefined, {
			scope,
			source: "inherited",
			onWarn: (v) => warnings.push(v.message),
		});
		assert.equal(resolved, "deepseek/deepseek-v4");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /outside the configured subagent model scope/);
	});

	it("warns for an inherited parent-session model that is out of scope", () => {
		const warnings: string[] = [];
		// No explicit model requested: inherits the parent (deepseek), which is out of scope.
		const resolved = resolveSubagentModelOverride(undefined, parentModel, availableModels, undefined, {
			scope,
			onWarn: (v) => warnings.push(v.message),
		});
		assert.equal(resolved, "deepseek/deepseek-v4");
		assert.equal(warnings.length, 1);
	});

	it("throws for an inherited parent-session model in strict mode", () => {
		assert.throws(
			() => resolveSubagentModelOverride(undefined, parentModel, availableModels, undefined, {
				scope: { ...scope, strict: true },
			}),
			/deepseek\/deepseek-v4.*outside the configured subagent model scope/,
		);
	});

	it("passes through an in-scope explicit model without warning or error", () => {
		const warnings: string[] = [];
		const resolved = resolveSubagentModelOverride("gpt-5-mini", parentModel, availableModels, undefined, {
			scope,
			source: "explicit",
			onWarn: (v) => warnings.push(v.message),
		});
		assert.equal(resolved, "openai/gpt-5-mini");
		assert.equal(warnings.length, 0);
	});

	it("checks the resolved (canonicalized) model against the scope", () => {
		// Fuzzy-resolves Claude-Sonnet-4 -> anthropic/claude-sonnet-4, which is in scope.
		const warnings: string[] = [];
		const resolved = resolveSubagentModelOverride("Claude-Sonnet-4", parentModel, availableModels, undefined, {
			scope,
			source: "explicit",
			onWarn: (v) => warnings.push(v.message),
		});
		assert.equal(resolved, "anthropic/claude-sonnet-4");
		assert.equal(warnings.length, 0);
	});

	it("ignores a thinking suffix when checking scope", () => {
		const warnings: string[] = [];
		const resolved = resolveSubagentModelOverride("gpt-5-mini:high", parentModel, availableModels, undefined, {
			scope,
			source: "explicit",
			onWarn: (v) => warnings.push(v.message),
		});
		assert.equal(resolved, "openai/gpt-5-mini:high");
		assert.equal(warnings.length, 0);
	});

	it("warns for out-of-scope fallback models while keeping them available", () => {
		const warnings: string[] = [];
		const candidates = buildModelCandidates("gpt-5-mini", ["deepseek/deepseek-v4"], availableModels, undefined, {
			scope,
			onWarn: (v) => warnings.push(v.message),
		});
		assert.deepEqual(candidates, ["openai/gpt-5-mini", "deepseek/deepseek-v4"]);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /deepseek\/deepseek-v4/);
	});

	it("throws for an out-of-scope primary candidate in strict mode", () => {
		assert.throws(
			() => buildModelCandidates("deepseek/deepseek-v4", undefined, availableModels, undefined, {
				scope: { ...scope, strict: true },
			}),
			/deepseek\/deepseek-v4.*outside the configured subagent model scope/,
		);
	});

	it("throws instead of pruning an out-of-scope fallback in strict mode", () => {
		assert.throws(
			() => buildModelCandidates("gpt-5-mini", ["deepseek/deepseek-v4"], availableModels, undefined, {
				scope: { ...scope, strict: true },
			}),
			/deepseek\/deepseek-v4.*outside the configured subagent model scope/,
		);
	});

	it("applies a strict per-agent scope to fallback candidates", () => {
		const scopes = resolveModelScopesForAgent(
			{ enforce: true, strict: true, agents: { worker: { allow: ["openai/*"] } } },
			"worker",
			parentModel,
		);
		assert.throws(
			() => buildModelCandidates("openai/gpt-5-mini", ["deepseek/deepseek-v4"], availableModels, undefined, { scope: scopes }),
			/modelScope\.agents\.worker/,
		);
	});
});

describe("isContextOverflow", () => {
	it("detects common context-overflow error shapes", () => {
		assert.equal(isContextOverflow("This model's maximum context length is 8192 tokens"), true);
		assert.equal(isContextOverflow("context length exceeded for the requested prompt"), true);
		assert.equal(isContextOverflow("too many tokens in the request"), true);
		assert.equal(isContextOverflow("context_length_exceeded"), true);
		assert.equal(isContextOverflow("prompt is too long for this model"), true);
		assert.equal(isContextOverflow("input too long: 40000 tokens"), true);
	});

	it("does not flag unrelated retryable failures as overflow", () => {
		assert.equal(isContextOverflow("rate limit exceeded for provider"), false);
		assert.equal(isContextOverflow("503 service unavailable"), false);
		assert.equal(isContextOverflow("connection refused"), false);
	});

	it("does not flag tool failures as overflow", () => {
		assert.equal(isContextOverflow("bash failed (exit 1): context length exceeded in output"), false);
	});

	it("returns false for empty or undefined input", () => {
		assert.equal(isContextOverflow(undefined), false);
		assert.equal(isContextOverflow(""), false);
	});
});
