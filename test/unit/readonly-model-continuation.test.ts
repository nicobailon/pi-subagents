import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createDefaultChildSessionFactory, type ChildSession, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { createChildHooks } from "../../src/runs/shared/child-hooks.ts";
import { getReadonlySessionEvidence, requestReadonlySessionEvidence } from "../../src/runs/shared/readonly-session-evidence.ts";
import { planReadonlyModelContinuation as plan, type ReadonlyContinuationCandidate, type ReadonlyContinuationInput } from "../../src/runs/shared/readonly-model-continuation.ts";

const candidate = (model: string, provider = "baseten", tried = false): ReadonlyContinuationCandidate => ({ resolved: { model, provider, api: "openai-completions" }, tried, compatibility: "compatible" });
function input(source?: ChildSession): ReadonlyContinuationInput {
	return { source, recoveryState: "unused", candidates: [candidate("model-a", "baseten", true), candidate("model-b")], currentIndex: 0,
		lifecycleAllowsContinuation: true, effectsAllowContinuation: true, budget: "unconfigured", knownContextOverflow: false };
}
it("denies absent and duck-typed serialized receipts", () => {
	assert.deepEqual(plan(input()), { kind: "deny", reason: "no-evidence" });
	assert.deepEqual(plan(input({ continuationEvidence: { status: 429, readOnly: true } } as unknown as ChildSession)), { kind: "deny", reason: "no-evidence" });
});

const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK;
it("plans only from a real settled receipt: ordered siblings, vetoes, one-cap transitions and revocation", { skip: !sdkRoot && "Set PI_SUBAGENTS_NATIVE_SDK" }, async () => {
	const entry = execFileSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('@earendil-works/pi-coding-agent'))"], { cwd: sdkRoot, encoding: "utf8" }).trim();
	const pi: PiCodingAgentModule = await import(entry);
	assert.equal(pi.VERSION, "0.85.1");
	const cwd = mkdtempSync(join(tmpdir(), "readonly-planner-"));
	const agentDir = join(cwd, "agent"); mkdirSync(agentDir);
	const priorDir = process.env.PI_CODING_AGENT_DIR, priorFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false } }));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { baseten: { baseUrl: "https://synthetic.invalid/v1", apiKey: "fixture", models: ["model-a", "model-b"].map(id => ({ id, name: id, api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) } } }));
	writeFileSync(join(cwd, "marker.txt"), "Actual builtin read result");
	let requests = 0;
	let stale = false;
	globalThis.fetch = async (url, init) => {
		assert.equal(String(url), "https://synthetic.invalid/v1/chat/completions");
		assert.equal(init?.method, "POST");
		requests++;
		if (requests === 1) {
			const chunk = { id: "synthetic", object: "chat.completion.chunk", created: 1, model: "model-a", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "read-1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "marker.txt" }) } }] }, finish_reason: "tool_calls" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		}
		if (stale) throw new Error("429: stale-looking error without a response");
		return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json" } });
	};
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
	function launch(file: string): ChildSessionLaunch {
		const runtime = { fanoutChild: false, fast: false, depth: 1, waitTool: { enabled: false } };
		return { cwd, storage: { kind: "file", sessionFile: join(cwd, file) }, model: "baseten/model-a", tools: ["read"], extensionPaths: [], ambientExtensions: false, hooks: createChildHooks(runtime), noSkills: true, noContextFiles: true, runtime };
	}
	try {
		const l = launch("session.jsonl"); requestReadonlySessionEvidence(l);
		const child = await factory.create(l);
		await child.prompt("Read marker.txt once");
		assert.equal(plan(input(child)).kind, "deny", "prompt completion alone is not settlement proof");
		await child.dispose();
		const receipt = getReadonlySessionEvidence(child); assert.ok(receipt);
		const base = input(child);
		const selected = plan({ ...base, candidates: [candidate("model-a", "baseten", true), candidate("foreign", "other"), candidate("model-a"), candidate("tried", "baseten", true), candidate("tried"), candidate("model-b")] });
		assert.ok(selected.kind === "continue");
		assert.equal(selected.candidateIndex, 5);
		assert.equal(selected.expected, receipt, "opaque receipt is passed unchanged");
		assert.equal(selected.prompt, "The previous provider request failed with HTTP 429 after read-only progress. Continue from the retained transcript and completed tool results. Do not restart or repeat completed work. Use only the existing read-only tools and finish the requested response.");
		assert.equal(base.recoveryState, "unused", "planner does not consume host-owned state itself");
		assert.equal(plan({ ...base, recoveryState: selected.recoveryState }).kind, "deny");
		assert.equal(plan({ ...base, recoveryState: "abort-recovery" }).kind, "deny");
		for (const patch of [
			{ lifecycleAllowsContinuation: false }, { effectsAllowContinuation: false }, { knownContextOverflow: true },
			...(["unknown", "exhausted", "tool-budget-configured"] as const).map(budget => ({ budget })),
			{ currentIndex: -1 }, { currentIndex: 0.5 }, { currentIndex: 8 },
			{ candidates: [candidate("alias"), candidate("model-b")] },
			{ candidates: [base.candidates[0], candidate("foreign", "other")] },
			{ candidates: [base.candidates[0], { ...candidate("model-b"), resolved: undefined }] },
			...(["unknown", "incompatible"] as const).map(compatibility => ({ candidates: [base.candidates[0], { ...candidate("model-b"), compatibility }] })),
			{ candidates: [base.candidates[0], { ...candidate("model-b"), resolved: { provider: "baseten", model: "model-b", api: "other" } }] },
		]) assert.equal(plan({ ...base, ...patch }).kind, "deny", JSON.stringify(patch));
		assert.equal(plan({ ...base, budget: "available" }).kind, "continue");
		assert.equal(requests, 2, "all decisions are dispatch-free");
		await child.abort();
		assert.equal(getReadonlySessionEvidence(child), undefined);
		assert.deepEqual(plan(base), { kind: "deny", reason: "no-evidence" }, "previously captured receipt cannot bypass revocation");
		// A prior real 429 on this retained transcript cannot authorize a later statusless error.
		stale = true;
		const later = launch("session.jsonl"); requestReadonlySessionEvidence(later);
		const laterChild = await factory.create(later);
		await laterChild.prompt("Continue"); await laterChild.dispose();
		assert.deepEqual(plan(input(laterChild)), { kind: "deny", reason: "no-evidence" });
	} finally {
		await factory.dispose(); globalThis.fetch = priorFetch;
		if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});
