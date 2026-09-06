import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/watchdog/settings.ts";
import { MainWatchdogRuntime, type WatchdogReviewFunction } from "../../src/watchdog/runtime.ts";
import type { ResolvedWatchdogConfig, WatchdogLspResult, WatchdogSettingsResult, WatchdogWarning, WatchdogWarningDetails } from "../../src/watchdog/types.ts";

function cloneConfig(): ResolvedWatchdogConfig {
	return {
		...DEFAULT_WATCHDOG_CONFIG,
		guidance: { ...DEFAULT_WATCHDOG_CONFIG.guidance },
		scope: { ...DEFAULT_WATCHDOG_CONFIG.scope },
		cadence: { ...DEFAULT_WATCHDOG_CONFIG.cadence },
		main: { ...DEFAULT_WATCHDOG_CONFIG.main },
		children: {
			...DEFAULT_WATCHDOG_CONFIG.children,
			overrides: { ...DEFAULT_WATCHDOG_CONFIG.children.overrides },
		},
		lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp },
	};
}

function configResult(config: ResolvedWatchdogConfig): WatchdogSettingsResult {
	return { ok: true, config, errors: [], sources: [] };
}

function enabledConfig(overrides: Partial<ResolvedWatchdogConfig> = {}): ResolvedWatchdogConfig {
	const config = cloneConfig();
	config.enabled = true;
	config.main.enabled = true;
	config.lsp.enabled = false;
	Object.assign(config, overrides);
	if (overrides.main) config.main = { ...config.main, ...overrides.main };
	if (overrides.lsp) config.lsp = { ...config.lsp, ...overrides.lsp };
	if (overrides.scope) config.scope = { ...config.scope, ...overrides.scope };
	if (overrides.cadence) config.cadence = { ...config.cadence, ...overrides.cadence };
	return config;
}

function warning(): WatchdogWarning {
	return {
		severity: "concern",
		summary: "Runtime concern",
		evidence: "The runtime test emitted a concern.",
		recommendedAction: "Review the displayed warning before accepting the turn.",
		source: "main",
	};
}

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

function createRepo(): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-runtime-"));
	git(repo, ["init"]);
	git(repo, ["config", "user.email", "watchdog@example.com"]);
	git(repo, ["config", "user.name", "Watchdog Tests"]);
	fs.mkdirSync(path.join(repo, "src"));
	fs.writeFileSync(path.join(repo, "src", "file.ts"), "export const value = 1;\n", "utf-8");
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-m", "initial"]);
	return repo;
}

describe("main watchdog runtime", () => {
	function activityTurn(name: string, args: Record<string, unknown>, text: string, id = "activity-call") {
		return { type: "turn_end", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] }, toolResults: [{ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false }] };
	}

	it("invalidates activity Q/A when a dirty prompt baseline becomes clean, using one observation per boundary", async () => {
		const ctx = { cwd: "/tmp/project" };
		let observation = { root: ctx.cwd, key: "dirty-A", changedPaths: ["file.ts"] };
		let scans = 0;
		const requests: Parameters<WatchdogReviewFunction>[0][] = [];
		const runtime = new MainWatchdogRuntime({ cwd: ctx.cwd, resolveConfig: () => configResult(enabledConfig({ clarification: true })), reviewChangesOnly: true,
			repoChangeSignature: () => { scans++; return observation; }, displayClarification: () => {}, review: (r) => { requests.push(r); return { clarification: { question: "Keep the existing edit?", evidence: "Dirty file at task start" } }; } });
		try {
			runtime.handleBeforeAgentStart({ prompt: "Check task status" }, ctx);
			runtime.handleTurnEnd(activityTurn("subagent", { action: "status", id: "task" }, "Task awaits a decision"), ctx);
			const before = scans;
			await runtime.handleAgentEnd({}, ctx);
			runtime.replyToClarification(runtime.getSnapshot().clarification!.id, "Obsolete answer", ctx);
			observation = { root: ctx.cwd, key: "clean-B", changedPaths: [] };
			await runtime.handleAgentEnd({}, ctx);
			assert.equal(runtime.getSnapshot().clarification?.state, "stale evidence");
			assert.equal(requests.length, 1, "no fresh review consumes the obsolete answer");
			assert.equal(scans - before, 2, "raw freshness reuses each existing boundary lookup");
		} finally { runtime.dispose(); }
	});

	it("invalidates an admitted LSP pre-pass on user input, model selection or configured model change", async () => {
		for (const edge of ["input", "model", "config"] as const) {
			const ctx = { cwd: "/tmp/project" };
			let config = enabledConfig({ clarification: true, lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp, enabled: true } });
			let key = "baseline";
			let started!: () => void;
			const ready = new Promise<void>((resolve) => { started = resolve; });
			let finish!: (result: WatchdogLspResult) => void;
			let signal: AbortSignal | undefined;
			let reviews = 0;
			const notices: string[] = [];
			const runtime = new MainWatchdogRuntime({ cwd: ctx.cwd, resolveConfig: () => configResult(config), reviewChangesOnly: true,
				repoChangeSignature: () => ({ root: ctx.cwd, key, changedPaths: ["file.ts"] }),
				lspDiagnostics: (request) => new Promise((resolve) => { signal = request.signal; finish = resolve; started(); }),
				displayClarification: (text) => { notices.push(text); }, review: () => { reviews++; return { clarification: { question: "Old scope?", evidence: "Old boundary" } }; } });
			try {
				runtime.handleBeforeAgentStart({ prompt: "Original task" }, ctx);
				key = "edited";
				const boundary = runtime.handleAgentEnd({}, ctx);
				await ready;
				if (edge === "input") runtime.handleUserInput();
				else if (edge === "model") runtime.handleModelChange();
				else { config = { ...config, main: { ...config.main, model: "mock/new-model" } }; runtime.refreshConfig(); }
				assert.equal(signal?.aborted, true, edge);
				finish({ status: "ok", checkedPaths: ["file.ts"], skippedPaths: [], diagnostics: [] });
				await boundary;
				assert.equal(reviews, 0, edge);
				assert.deepEqual(notices, [], edge);
			} finally { runtime.dispose(); }
		}
	});

	it("reviews delivered orchestration outcomes without edits once per prompt and retains evidence through a side ask", async () => {
		const ctx = { cwd: "/tmp/project" };
		const requests: Parameters<WatchdogReviewFunction>[0][] = [];
		const runtime = new MainWatchdogRuntime({ cwd: ctx.cwd, resolveConfig: () => configResult(enabledConfig({ clarification: true })), reviewChangesOnly: true, repoChangeSignature: () => ({ root: ctx.cwd, key: "unchanged", changedPaths: [] }), displayClarification: () => {}, review: (r) => { requests.push(r); return requests.length === 2 ? { warnings: [warning()] } : {}; } });
		try {
			runtime.handleBeforeAgentStart({ prompt: "Finish the original implementation and CI gate" }, ctx);
			runtime.handleTurnEnd(activityTurn("subagent", { agent: "worker", task: "Implement original objective" }, "Implementation remains active; explicitly held pending CI"), ctx);
			await runtime.handleAgentEnd({}, ctx);
			assert.equal(requests.length, 1);
			assert.match(requests[0]!.delta, /explicitly held pending CI/);
			assert.match(requests[0]!.delta, /waits\/holds are not evidence of neglect/);
			assert.equal(runtime.getSnapshot().lastWarning, undefined, "a pending/held outcome is evidence, not an automatic finding");
			runtime.handleTurnEnd(activityTurn("bg_wait", { id: "ci-gate" }, "CI gate completed successfully"), ctx);
			await runtime.handleAgentEnd({}, ctx);
			assert.equal(requests.length, 1, "one additional activity review per prompt");
			runtime.handleBeforeAgentStart({ prompt: "Side question: explain this acronym" }, ctx);
			await runtime.handleAgentEnd({}, ctx);
			assert.equal(requests.length, 2, "unreviewed delivered completion survives skipped boundary and new prompt");
			for (const text of ["original implementation", "Side question", "CI gate completed successfully", "Implementation remains active", "Side questions are additive"]) assert.ok(requests[1]!.delta.includes(text));
			runtime.handleTurnEnd(activityTurn("subagent", { action: "status", id: "ci-gate" }, "Warning continuation status"), ctx);
			await runtime.handleAgentEnd({}, ctx);
			runtime.handleBeforeAgentStart({ prompt: "Continue" }, ctx);
			await runtime.handleAgentEnd({}, ctx);
			assert.equal(requests.length, 2, "warning continuations and side prompts alone cannot create fresh activity");
			runtime.reset("compact", { clearScope: true });
			runtime.handleBeforeAgentStart({ prompt: "New scope" }, ctx);
			runtime.handleTurnEnd(activityTurn("subagent_supervisor", { action: "pending" }, "No pending requests"), ctx);
			await runtime.handleAgentEnd({}, ctx);
			assert.doesNotMatch(requests.at(-1)!.delta, /CI gate completed successfully/);
		} finally { runtime.dispose(); }
	});

	it("uses activity freshness for no-edit Q/A and excludes unmatched tools and watchdog receipts", async () => {
		const ctx = { cwd: "/tmp/project" };
		const config = enabledConfig({ clarification: true });
		const requests: Parameters<WatchdogReviewFunction>[0][] = [];
		const runtime = new MainWatchdogRuntime({ cwd: ctx.cwd, resolveConfig: () => configResult(config), reviewChangesOnly: true, repoChangeSignature: () => undefined, displayClarification: () => {}, review: (r) => { requests.push(r); return r.allowClarification ? { clarification: { question: "Is the gate held?", evidence: "Delivered gate status is unclear" } } : {}; } });
		try {
			runtime.handleBeforeAgentStart({ prompt: "Finish task" }, ctx);
			const unmatched = activityTurn("subagent", { action: "status" }, "unmatched");
			unmatched.toolResults[0]!.toolCallId = "other";
			runtime.handleTurnEnd(unmatched, ctx);
			runtime.handleTurnEnd(activityTurn("bash", { command: "echo subagent" }, "not orchestration evidence"), ctx);
			await runtime.handleAgentEnd({}, ctx);
			assert.equal(requests.length, 0);
			runtime.handleTurnEnd(activityTurn("subagent", { action: "status", id: "gate" }, "Gate state unclear"), ctx);
			await runtime.handleAgentEnd({}, ctx);
			const id = runtime.getSnapshot().clarification!.id;
			runtime.replyToClarification(id, "Explicitly held", ctx);
			runtime.handleTurnEnd(activityTurn("subagent", { action: "watchdog.reply", id, message: "Explicitly held" }, "receipt"), ctx);
			await runtime.handleAgentEnd({}, ctx);
			assert.match(requests[1]!.delta, /Explicitly held/);
			assert.ok(requests[1]!.delta.length <= 24_000);
			runtime.handleBeforeAgentStart({ prompt: "Next task" }, ctx);
			await runtime.handleAgentEnd({}, ctx);
			assert.equal(requests.length, 2, "receipt did not create activity");
			runtime.handleTurnEnd(activityTurn("bg_wait", {}, `New unclear outcome ${"x".repeat(40_000)}`), ctx);
			await runtime.handleAgentEnd({}, ctx);
			assert.ok(requests.at(-1)!.delta.length <= 24_000, "activity and delta share the input cap");
			runtime.replyToClarification(runtime.getSnapshot().clarification!.id, "Obsolete answer", ctx);
			runtime.handleTurnEnd(activityTurn("bg_wait", {}, "Gate changed while answering"), ctx);
			await runtime.handleAgentEnd({}, ctx);
			assert.equal(runtime.getSnapshot().clarification?.state, "stale evidence");
			assert.equal(requests.some((r) => r.delta.includes("Obsolete answer")), false);
		} finally { runtime.dispose(); }
	});

	function clarificationFixture(clarification = true, main = true) {
		let key = "baseline";
		const config = enabledConfig({ clarification, cadence: { everyNTools: 1 } });
		const requests: Parameters<WatchdogReviewFunction>[0][] = [];
		const messages: Array<{ content: string; trigger: boolean }> = [];
		const warnings: WatchdogWarningDetails[] = [];
		const ctx = { cwd: "/tmp/project" };
		const runtime = new MainWatchdogRuntime({
			cwd: ctx.cwd, resolveConfig: () => configResult(config), reviewChangesOnly: true,
			repoChangeSignature: () => ({ root: ctx.cwd, key, changedPaths: ["file.ts"] }),
			...(main ? { displayClarification: (content: string, trigger: boolean) => { messages.push({ content, trigger }); } } : {}),
			displayWarning: (warning) => { warnings.push(warning); },
			review: (request) => {
				requests.push(request);
				return request.allowClarification ? { clarification: { question: "Which scope?", evidence: "Original evidence" } } : { warnings: [warning()] };
			},
		});
		runtime.handleBeforeAgentStart({ prompt: "Original task" }, ctx);
		key = "edited";
		runtime.enqueueDelta("Original bounded delta");
		return { runtime, config, ctx, requests, messages, warnings, change: (value = "changed again") => { key = value; } };
	}

	it("rejects wrong, cross-runtime and duplicate replies and suppresses cadence/further questions", async () => {
		const f = clarificationFixture();
		try {
			await f.runtime.handleAgentEnd({}, f.ctx);
			const id = f.runtime.getSnapshot().clarification!.id;
			assert.throws(() => f.runtime.replyToClarification("wrong", "answer", f.ctx), /matching/);
			const other = clarificationFixture();
			assert.throws(() => other.runtime.replyToClarification(id, "answer", other.ctx), /matching/);
			other.runtime.dispose();
			f.runtime.handleToolResult(f.ctx);
			assert.equal(f.requests.length, 1, "cadence suppressed while pending");
			f.runtime.replyToClarification(id, "Exact answer", f.ctx);
			assert.throws(() => f.runtime.replyToClarification(id, "duplicate", f.ctx), /matching/);
			await f.runtime.handleAgentEnd({}, f.ctx);
			f.change();
			f.runtime.enqueueDelta("New work, same user prompt");
			await f.runtime.handleAgentEnd({}, f.ctx);
			assert.equal(f.requests.at(-1)?.allowClarification, undefined);
		} finally { f.runtime.dispose(); }
	});

	it("keeps unverifiable non-Git observed-edit boundaries warning-only", async () => {
		const f = clarificationFixture();
		try {
			f.change("observed-edit:1:0:12");
			await f.runtime.handleAgentEnd({}, f.ctx);
			assert.equal(f.requests[0]?.allowClarification, undefined);
			assert.equal(f.messages.length, 0);
			assert.equal(f.warnings.length, 1);
		} finally { f.runtime.dispose(); }
	});

	it("closes unanswered and expired requests without a nag or repeat review", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		for (const expire of [false, true]) {
			const f = clarificationFixture();
			try {
				await f.runtime.handleAgentEnd({}, f.ctx);
				const id = f.runtime.getSnapshot().clarification!.id;
				if (expire) t.mock.timers.tick(60_001);
				await f.runtime.handleAgentEnd({}, f.ctx);
				assert.throws(() => f.runtime.replyToClarification(id, "late", f.ctx), /matching/);
				assert.equal(f.requests.length, 1);
				assert.equal(f.messages.filter((m) => m.trigger).length, 1);
				assert.equal(f.runtime.getSnapshot().clarification?.state, expire ? "expired" : "unanswered");
			} finally { f.runtime.dispose(); }
		}
	});

	it("invalidates replies on lifecycle, abort, model/disable and changed evidence", async () => {
		for (const edge of ["reset", "new prompt", "user steer", "model", "selected model", "disabled", "clarification off", "abort", "repo", "dispose"]) {
			const f = clarificationFixture();
			try {
				await f.runtime.handleAgentEnd({}, f.ctx);
				const id = f.runtime.getSnapshot().clarification!.id;
				if (edge === "repo") { f.runtime.replyToClarification(id, "stale answer", f.ctx); f.change(); }
				else if (edge === "new prompt") f.runtime.handleBeforeAgentStart({ prompt: "New task" }, f.ctx);
				else if (edge === "user steer") f.runtime.handleUserInput();
				else if (edge === "model") f.runtime.setSessionModel({ model: "mock/new" });
				else if (edge === "selected model") f.runtime.handleModelChange();
				else if (edge === "disabled") { f.config.main.enabled = false; f.runtime.refreshConfig(); }
				else if (edge === "clarification off") { f.config.clarification = false; f.runtime.refreshConfig(); }
				else if (edge === "abort") { const c = new AbortController(); f.runtime.handleAgentStart({ ...f.ctx, signal: c.signal }); c.abort(); }
				else if (edge === "dispose") f.runtime.dispose();
				else f.runtime.reset("session switch/fork/compact");
				await f.runtime.handleAgentEnd({}, f.ctx);
				assert.throws(() => f.runtime.replyToClarification(id, "late", f.ctx), /matching/);
				assert.equal(f.requests.some((r) => r.delta.includes("stale answer")), false, edge);
				assert.equal(f.messages.filter((m) => m.trigger).length, 1, edge);
			} finally { f.runtime.dispose(); }
		}
	});

	it("adds no clarification calls, messages or timers when off or without main delivery capability", async (t) => {
		for (const [enabled, main] of [[false, true], [true, false]]) {
			const f = clarificationFixture(enabled, main);
			const timer = t.mock.method(globalThis, "setTimeout");
			try {
				const disabled = activityTurn("subagent", { action: "status" }, "disabled");
				Object.defineProperty(disabled.toolResults[0], "toolCallId", { get() { throw new Error("disabled activity must not correlate results"); } });
				f.runtime.handleTurnEnd(disabled, f.ctx);
				assert.equal(f.runtime.getSnapshot().failedReviews, 0);
				await f.runtime.handleAgentEnd({}, f.ctx);
				assert.equal(f.requests[0]?.allowClarification, undefined);
				assert.equal(f.messages.length, 0);
				assert.equal(timer.mock.calls.length, 1, "only the existing model timeout");
				assert.equal(f.runtime.getSnapshot().clarification, undefined);
				const epoch = f.runtime.getSnapshot().epoch;
				f.runtime.handleModelChange();
				f.runtime.handleUserInput();
				assert.equal(f.runtime.getSnapshot().epoch, epoch, "disabled clarification lifecycle handlers are inert");
			} finally { timer.mock.restore(); f.runtime.dispose(); }
		}
	});

	it("bounds retained Q/A, accepts timely replies after deadline, and preserves warning budget", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		const f = clarificationFixture();
		f.config.maxWarnings = 0;
		try {
			f.runtime.enqueueDelta("x".repeat(40_000));
			await f.runtime.handleAgentEnd({}, f.ctx);
			const id = f.runtime.getSnapshot().clarification!.id;
			f.runtime.replyToClarification(id, "ANSWER".repeat(3_000), f.ctx);
			t.mock.timers.tick(60_001);
			assert.equal(f.runtime.getSnapshot().clarification?.state, "answered");
			await f.runtime.handleAgentEnd({}, f.ctx);
			assert.equal(f.requests.length, 2);
			assert.ok(f.requests[1]!.delta.length <= 24_000);
			assert.match(f.requests[1]!.delta, /ANSWER/);
			assert.equal(f.warnings.length, 0, "Q/A never resets warning budget");
		} finally { f.runtime.dispose(); }
	});

	it("aborts an active reply review and ignores its late result without repeated invalidation", async () => {
		const config = enabledConfig({ clarification: true });
		const ctx = { cwd: "/tmp/project" };
		let finish: ((value: { warnings: WatchdogWarning[] }) => void) | undefined;
		let followSignal: AbortSignal | undefined;
		let calls = 0;
		const delivered: WatchdogWarningDetails[] = [];
		const runtime = new MainWatchdogRuntime({ cwd: ctx.cwd, resolveConfig: () => configResult(config), displayClarification: () => {}, displayWarning: (w) => { delivered.push(w); }, review: (request) => {
			calls++;
			if (calls === 1) return { clarification: { question: "Question", evidence: "Evidence" } };
			followSignal = request.signal;
			return new Promise((resolve) => { finish = resolve; });
		} });
		try {
			runtime.enqueueDelta("Original delta");
			await runtime.handleAgentEnd({}, ctx);
			runtime.replyToClarification(runtime.getSnapshot().clarification!.id, "Answer", ctx);
			const boundary = runtime.handleAgentEnd({}, ctx);
			await tick();
			config.clarification = false;
			runtime.refreshConfig();
			assert.equal(followSignal?.aborted, true);
			const epoch = runtime.getSnapshot().epoch;
			runtime.refreshConfig();
			assert.equal(runtime.getSnapshot().epoch, epoch, "terminal invalidation is not repeated on refresh");
			finish!({ warnings: [warning()] });
			await boundary;
			assert.equal(delivered.length, 0);
			assert.equal(runtime.getSnapshot().activeReviewId, undefined);
		} finally { runtime.dispose(); }
	});

	it("does not inspect the repository until the watchdog is enabled", () => {
		let enabled = false;
		let signatureCalls = 0;
		const runtime = new MainWatchdogRuntime({
			cwd: "/tmp/project",
			resolveConfig: () => configResult(enabled ? enabledConfig() : cloneConfig()),
			reviewChangesOnly: true,
			repoChangeSignature: () => {
				signatureCalls++;
				return { root: "/tmp/project", key: "signature", changedPaths: [] };
			},
		});

		assert.equal(signatureCalls, 0);
		runtime.handleBeforeAgentStart({ prompt: "disabled" }, { cwd: "/tmp/project" });
		assert.equal(signatureCalls, 0);

		enabled = true;
		runtime.handleBeforeAgentStart({ prompt: "enabled" }, { cwd: "/tmp/project" });
		assert.equal(signatureCalls, 1);
	});

	it("does not use stale enabled config to inspect a newly bound default-off session", () => {
		let signatureCalls = 0;
		const runtime = new MainWatchdogRuntime({
			cwd: "/tmp/enabled",
			resolveConfig: (cwd) => configResult(cwd === "/tmp/enabled" ? enabledConfig() : cloneConfig()),
			reviewChangesOnly: true,
			repoChangeSignature: (cwd) => {
				signatureCalls++;
				return { root: cwd, key: cwd, changedPaths: [] };
			},
		});

		assert.equal(signatureCalls, 1);
		runtime.bindSession({ cwd: "/tmp/default-off" });
		assert.equal(signatureCalls, 1);
		assert.equal(runtime.getSnapshot().enabled, false);
	});

	it("stays default-off and contains invalid config at the watchdog boundary", () => {
		let reviewCalls = 0;
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => ({
				ok: false,
				config: cloneConfig(),
				errors: [{ scope: "user", path: "/tmp/settings.json", message: "bad watchdog config" }],
				sources: [{ scope: "user", path: "/tmp/settings.json", exists: true }],
			}),
			review: () => {
				reviewCalls++;
			},
		});

		runtime.handleTurnEnd({ type: "turn_end", message: { role: "assistant", content: "Done." }, toolResults: [] }, { cwd: "/tmp/project" });

		const snapshot = runtime.getSnapshot();
		assert.equal(snapshot.enabled, false);
		assert.equal(snapshot.configOk, false);
		assert.equal(snapshot.status, "idle");
		assert.equal(reviewCalls, 0);
		assert.equal(snapshot.errors[0]?.message, "bad watchdog config");
	});

	it("queues turn deltas, reviews once at agent_end, displays one warning, and returns idle", async () => {
		let releaseReview!: () => void;
		let started!: () => void;
		const displayed: unknown[] = [];
		const reviewStarted = new Promise<void>((resolve) => { started = resolve; });
		const review: WatchdogReviewFunction = async (request) => {
			started();
			await new Promise<void>((resolve) => { releaseReview = resolve; });
			assert.equal(request.delta, "Assistant:\nWorking");
			assert.equal(request.emitWarning(warning()), true);
			return { stopReason: "stop" };
		};
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => configResult(enabledConfig()),
			review,
			displayWarning: (details) => displayed.push(details),
		});

		runtime.enqueueDelta("Assistant:\nWorking");
		assert.equal(runtime.getSnapshot().status, "queued");
		const end = runtime.handleAgentEnd({ type: "agent_end", messages: [] }, { cwd: "/tmp/project" });
		await reviewStarted;
		assert.equal(runtime.getSnapshot().status, "reviewing");

		releaseReview();
		await end;

		const snapshot = runtime.getSnapshot();
		assert.equal(snapshot.status, "idle");
		assert.equal(snapshot.lastWarning?.state, "displayed");
		assert.equal(displayed.length, 1);
		assert.equal((displayed[0] as { state?: string }).state, "displayed");
	});

	it("drops stale async warning callbacks after reset", async () => {
		let emitWarning!: (candidate: WatchdogWarning) => boolean;
		let finishReview!: () => void;
		let started!: () => void;
		const reviewStarted = new Promise<void>((resolve) => { started = resolve; });
		const review: WatchdogReviewFunction = async (request) => {
			emitWarning = request.emitWarning;
			started();
			await new Promise<void>((resolve) => { finishReview = resolve; });
		};
		const runtime = new MainWatchdogRuntime({ resolveConfig: () => configResult(enabledConfig()), review });

		runtime.enqueueDelta("Assistant:\nWorking");
		const end = runtime.handleAgentEnd({ type: "agent_end", messages: [] }, { cwd: "/tmp/project" });
		await reviewStarted;
		const epoch = runtime.getSnapshot().epoch;
		runtime.reset("test reset");

		assert.equal(emitWarning(warning()), false);
		finishReview();
		await end;
		await tick();

		const snapshot = runtime.getSnapshot();
		assert.equal(snapshot.epoch, epoch + 1);
		assert.equal(snapshot.status, "idle");
		assert.equal(snapshot.lastWarning, undefined);
	});

	it("treats failed review stop reasons as failed", async () => {
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => configResult(enabledConfig()),
			review: () => ({ stopReason: "length" }),
		});

		runtime.enqueueDelta("Assistant:\nWorking");
		await runtime.handleAgentEnd({ type: "agent_end", messages: [] }, { cwd: "/tmp/project" });

		const snapshot = runtime.getSnapshot();
		assert.equal(snapshot.status, "failed");
		assert.match(snapshot.lastError ?? "", /stop reason 'length'/);
		assert.equal(snapshot.failedReviews, 1);
	});

	it("marks unresolved agent-end review work stale on timeout", async () => {
		let started!: () => void;
		const reviewStarted = new Promise<void>((resolve) => { started = resolve; });
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => configResult(enabledConfig({ agentEndTimeoutMs: 5 })),
			review: async () => {
				started();
				await new Promise<void>(() => {});
			},
		});

		runtime.enqueueDelta("Assistant:\nStill working");
		const end = runtime.handleAgentEnd({ type: "agent_end", messages: [] }, { cwd: "/tmp/project" });
		await reviewStarted;
		await end;

		const snapshot = runtime.getSnapshot();
		assert.equal(snapshot.status, "stale");
		assert.equal(snapshot.staleReviews, 1);
		runtime.reset("cleanup");
	});

	it("aborts timed-out review work before another agent-end review can overlap", async () => {
		let activeReviews = 0;
		let maxActiveReviews = 0;
		let aborts = 0;
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => configResult(enabledConfig({ agentEndTimeoutMs: 5 })),
			review: async (request) => {
				activeReviews++;
				maxActiveReviews = Math.max(maxActiveReviews, activeReviews);
				await new Promise<void>((resolve) => {
					request.signal?.addEventListener("abort", () => {
						aborts++;
						resolve();
					}, { once: true });
				});
				activeReviews--;
				return { stopReason: "aborted" };
			},
		});

		runtime.enqueueDelta("Assistant:\nFirst review");
		await runtime.handleAgentEnd({ type: "agent_end", messages: [] }, { cwd: "/tmp/project" });
		await tick();
		runtime.enqueueDelta("Assistant:\nSecond review");
		await runtime.handleAgentEnd({ type: "agent_end", messages: [] }, { cwd: "/tmp/project" });
		await tick();

		assert.equal(aborts, 2);
		assert.equal(activeReviews, 0);
		assert.equal(maxActiveReviews, 1);
		assert.equal(runtime.getSnapshot().staleReviews, 2);
	});

	it("drops late warning callbacks after agent-end timeout marks a review stale", async () => {
		let emitWarning!: (candidate: WatchdogWarning) => boolean;
		let finishReview!: () => void;
		let started!: () => void;
		const reviewStarted = new Promise<void>((resolve) => { started = resolve; });
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => configResult(enabledConfig({ agentEndTimeoutMs: 5 })),
			review: async (request) => {
				emitWarning = request.emitWarning;
				started();
				await new Promise<void>((resolve) => { finishReview = resolve; });
			},
		});

		runtime.enqueueDelta("Assistant:\nStill working");
		const end = runtime.handleAgentEnd({ type: "agent_end", messages: [] }, { cwd: "/tmp/project" });
		await reviewStarted;
		await end;

		assert.equal(emitWarning(warning()), false);
		finishReview();
		await tick();

		const snapshot = runtime.getSnapshot();
		assert.equal(snapshot.status, "stale");
		assert.equal(snapshot.lastWarning, undefined);
	});

	it("invalidates an in-flight review when refreshed config disables the watchdog", async () => {
		let enabled = true;
		let emitWarning!: (candidate: WatchdogWarning) => boolean;
		let finishReview!: () => void;
		let started!: () => void;
		const reviewStarted = new Promise<void>((resolve) => { started = resolve; });
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => configResult(enabled ? enabledConfig() : cloneConfig()),
			review: async (request) => {
				emitWarning = request.emitWarning;
				started();
				await new Promise<void>((resolve) => { finishReview = resolve; });
			},
		});

		runtime.enqueueDelta("Assistant:\nWorking");
		const end = runtime.handleAgentEnd({ type: "agent_end", messages: [] }, { cwd: "/tmp/project" });
		await reviewStarted;
		enabled = false;
		runtime.refreshConfig("/tmp/project");

		assert.equal(runtime.getSnapshot().enabled, false);
		assert.equal(runtime.getSnapshot().status, "idle");
		assert.equal(emitWarning(warning()), false);
		finishReview();
		await end;
		await tick();

		assert.equal(runtime.getSnapshot().lastWarning, undefined);
	});

	it("bounds review input before calling the reviewer", async () => {
		let reviewedDelta = "";
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => configResult(enabledConfig()),
			review: (request) => {
				reviewedDelta = request.delta;
				return { stopReason: "stop" };
			},
		});

		runtime.enqueueDelta(`Assistant:\n${"x".repeat(30_000)}`);
		await runtime.handleAgentEnd({ type: "agent_end", messages: [] }, { cwd: "/tmp/project" });

		assert.equal(reviewedDelta.length, 24_000, "head + marker + tail fill the cap exactly");
		assert.match(reviewedDelta, /^Assistant:\nx+\n\n\[\.\.\. about \d+ characters omitted \.\.\.\]\n\nx+$/);
		assert.equal(reviewedDelta.indexOf("\n\n[..."), 6_000, "the first 6,000 characters are kept as the head");
	});

	it("does not record duplicate signatures for stale invalidated reviews", async () => {
		let reviewCalls = 0;
		let finishFirstReview!: () => void;
		let firstReviewStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => { firstReviewStarted = resolve; });
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => configResult(enabledConfig()),
			review: async () => {
				reviewCalls++;
				if (reviewCalls === 1) {
					firstReviewStarted();
					await new Promise<void>((resolve) => { finishFirstReview = resolve; });
				}
				return { stopReason: "stop" };
			},
		});

		runtime.enqueueDelta("Assistant:\nSame work");
		const firstEnd = runtime.handleAgentEnd({ type: "agent_end", messages: [] }, { cwd: "/tmp/project" });
		await firstStarted;
		runtime.reset("test invalidation");
		finishFirstReview();
		await firstEnd;

		runtime.enqueueDelta("Assistant:\nSame work");
		await runtime.handleAgentEnd({ type: "agent_end", messages: [] }, { cwd: "/tmp/project" });

		assert.equal(reviewCalls, 2);
		assert.equal(runtime.getSnapshot().status, "idle");
	});

	it("skips duplicate bounded review input within the session", async () => {
		let reviewCalls = 0;
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => configResult(enabledConfig()),
			review: () => {
				reviewCalls++;
				return { stopReason: "stop" };
			},
		});

		runtime.enqueueDelta("Assistant:\nSame work");
		await runtime.handleAgentEnd({ type: "agent_end", messages: [] }, { cwd: "/tmp/project" });
		runtime.enqueueDelta("Assistant:\nSame work");
		await runtime.handleAgentEnd({ type: "agent_end", messages: [] }, { cwd: "/tmp/project" });

		assert.equal(reviewCalls, 1);
		assert.equal(runtime.getSnapshot().status, "idle");
	});

	it("skips edit-gated watchdog reviews when no repo changes occurred", async () => {
		const repo = createRepo();
		let reviewCalls = 0;
		const runtime = new MainWatchdogRuntime({
			cwd: repo,
			reviewChangesOnly: true,
			resolveConfig: () => configResult(enabledConfig()),
			review: () => {
				reviewCalls++;
				return { stopReason: "stop" };
			},
		});

		runtime.handleBeforeAgentStart({ prompt: "Explain the file." }, { cwd: repo });
		runtime.enqueueDelta("Assistant:\nI inspected the repo without editing.");
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });

		assert.equal(reviewCalls, 0);
		assert.equal(runtime.getSnapshot(repo).reviewTrigger, "repo-edits");
		assert.equal(runtime.getSnapshot(repo).status, "idle");
	});

	it("coalesces multiple repo edits in one turn into one edit-gated review", async () => {
		const repo = createRepo();
		let reviewCalls = 0;
		let reviewedDelta = "";
		const runtime = new MainWatchdogRuntime({
			cwd: repo,
			reviewChangesOnly: true,
			resolveConfig: () => configResult(enabledConfig()),
			review: (request) => {
				reviewCalls++;
				reviewedDelta = request.delta;
				return { stopReason: "stop" };
			},
		});

		runtime.handleBeforeAgentStart({ prompt: "Patch the feature." }, { cwd: repo });
		fs.writeFileSync(path.join(repo, "src", "file.ts"), "export const value = 2;\n", "utf-8");
		fs.writeFileSync(path.join(repo, "src", "other.ts"), "export const other = true;\n", "utf-8");
		runtime.enqueueDelta("Assistant:\nEdited two files.");
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });

		assert.equal(reviewCalls, 1);
		assert.match(reviewedDelta, /Changed repo paths:/);
		assert.match(reviewedDelta, /src\/file\.ts/);
		assert.match(reviewedDelta, /src\/other\.ts/);

		runtime.handleBeforeAgentStart({ prompt: "Say more." }, { cwd: repo });
		runtime.enqueueDelta("Assistant:\nNo further edits.");
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });

		assert.equal(reviewCalls, 1);
	});

	it("reviews same-path repo edits with identical turn text when content changes", async () => {
		const repo = createRepo();
		let reviewCalls = 0;
		const reviewedDeltas: string[] = [];
		const runtime = new MainWatchdogRuntime({
			cwd: repo,
			reviewChangesOnly: true,
			resolveConfig: () => configResult(enabledConfig()),
			review: (request) => {
				reviewCalls++;
				reviewedDeltas.push(request.delta);
				return { stopReason: "stop" };
			},
		});

		for (const value of [2, 3]) {
			runtime.handleBeforeAgentStart({ prompt: "Patch the feature." }, { cwd: repo });
			fs.writeFileSync(path.join(repo, "src", "file.ts"), `export const value = ${value};\n`, "utf-8");
			runtime.enqueueDelta("Assistant:\nEdited the file.");
			await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });
		}

		assert.equal(reviewCalls, 2);
		assert.match(reviewedDeltas[1] ?? "", /Changed repo paths:/);
		assert.match(reviewedDeltas[1] ?? "", /src\/file\.ts/);
	});

	it("keeps changed repo paths when bounding large edit-gated review input", async () => {
		const repo = createRepo();
		let reviewedDelta = "";
		const runtime = new MainWatchdogRuntime({
			cwd: repo,
			reviewChangesOnly: true,
			resolveConfig: () => configResult(enabledConfig()),
			review: (request) => {
				reviewedDelta = request.delta;
				return { stopReason: "stop" };
			},
		});

		runtime.handleBeforeAgentStart({ prompt: "Patch the feature." }, { cwd: repo });
		fs.writeFileSync(path.join(repo, "src", "file.ts"), "export const value = 4;\n", "utf-8");
		runtime.enqueueDelta(`Assistant:\n${"x".repeat(30_000)}`);
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });

		assert.equal(reviewedDelta.length, 24_000);
		assert.match(reviewedDelta, /^Current scope:/);
		assert.match(reviewedDelta, /Changed repo paths:/);
		assert.match(reviewedDelta, /src\/file\.ts/);
		assert.match(reviewedDelta, /x+$/);
	});

	it("emits changed-file LSP errors as watchdog blockers before model review", async () => {
		const repo = createRepo();
		const displayed: unknown[] = [];
		let reviewedDelta = "";
		const runtime = new MainWatchdogRuntime({
			cwd: repo,
			reviewChangesOnly: true,
			resolveConfig: () => configResult(enabledConfig({ lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp, enabled: true } })),
			lspDiagnostics: () => ({
				status: "ok",
				provider: "stub-lsp",
				checkedPaths: ["src/file.ts"],
				skippedPaths: [],
				diagnostics: [{
					path: "src/file.ts",
					line: 1,
					column: 14,
					severity: "error",
					source: "typescript",
					code: "TS2322",
					message: "Type 'string' is not assignable to type 'number'.",
				}],
			}),
			review: (request) => {
				reviewedDelta = request.delta;
				assert.equal(request.emitWarning({
					...warning(),
					summary: "Model tried to add a second warning",
					evidence: "The same boundary already displayed an LSP warning.",
				}), false);
				return { stopReason: "stop" };
			},
			displayWarning: (details) => displayed.push(details),
		});

		runtime.handleBeforeAgentStart({ prompt: "Patch the feature." }, { cwd: repo });
		fs.writeFileSync(path.join(repo, "src", "file.ts"), "export const value: number = 'bad';\n", "utf-8");
		runtime.enqueueDelta("Assistant:\nEdited the file.");
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });

		assert.match(reviewedDelta, /Changed repo paths:/);
		assert.match(reviewedDelta, /LSP diagnostics:/);
		assert.match(reviewedDelta, /TS2322/);
		assert.equal(displayed.length, 1);
		assert.equal((displayed[0] as { source?: string }).source, "lsp");
		assert.equal((displayed[0] as { severity?: string }).severity, "blocker");
		const snapshot = runtime.getSnapshot(repo);
		assert.equal(snapshot.lsp.status, "ok");
		assert.equal(snapshot.lsp.diagnosticCount, 1);
		assert.equal(snapshot.lsp.freshDiagnosticCount, 1);
	});

	it("records LSP info and hints without sending them to model review", async () => {
		const repo = createRepo();
		const displayed: unknown[] = [];
		let reviewedDelta = "";
		const runtime = new MainWatchdogRuntime({
			cwd: repo,
			reviewChangesOnly: true,
			resolveConfig: () => configResult(enabledConfig({ lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp, enabled: true } })),
			lspDiagnostics: () => ({
				status: "ok",
				provider: "stub-lsp",
				checkedPaths: ["src/file.ts"],
				skippedPaths: [],
				diagnostics: [{
					path: "src/file.ts",
					line: 1,
					column: 14,
					severity: "info",
					source: "typescript",
					message: "Helpful note.",
				}, {
					path: "src/file.ts",
					line: 2,
					column: 4,
					severity: "hint",
					source: "typescript",
					message: "Suggestion.",
				}],
			}),
			review: (request) => {
				reviewedDelta = request.delta;
				return { stopReason: "stop" };
			},
			displayWarning: (details) => displayed.push(details),
		});

		runtime.handleBeforeAgentStart({ prompt: "Patch the feature." }, { cwd: repo });
		fs.writeFileSync(path.join(repo, "src", "file.ts"), "export const value = 7;\n", "utf-8");
		runtime.enqueueDelta("Assistant:\nEdited the file.");
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });

		assert.match(reviewedDelta, /Changed repo paths:/);
		assert.doesNotMatch(reviewedDelta, /LSP diagnostics:/);
		assert.equal(displayed.length, 0);
		const snapshot = runtime.getSnapshot(repo);
		assert.equal(snapshot.lsp.diagnosticCount, 2);
		assert.equal(snapshot.lsp.freshDiagnosticCount, 2);
		assert.deepEqual(snapshot.lsp.diagnostics.map((diagnostic) => diagnostic.severity), ["info", "hint"]);
	});

	it("aborts and ignores stale LSP diagnostics after reset", async () => {
		const repo = createRepo();
		const displayed: unknown[] = [];
		let lspStarted!: () => void;
		const lspStartedPromise = new Promise<void>((resolve) => { lspStarted = resolve; });
		let signalAborted = false;
		let reviewCalls = 0;
		const runtime = new MainWatchdogRuntime({
			cwd: repo,
			reviewChangesOnly: true,
			resolveConfig: () => configResult(enabledConfig({ lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp, enabled: true } })),
			lspDiagnostics: (request) => new Promise((resolve) => {
				request.signal?.addEventListener("abort", () => {
					signalAborted = true;
					resolve({
						status: "ok",
						provider: "stub-lsp",
						checkedPaths: ["src/file.ts"],
						skippedPaths: [],
						diagnostics: [{
							path: "src/file.ts",
							line: 1,
							column: 14,
							severity: "error",
							source: "typescript",
							code: "TS2322",
							message: "Type 'string' is not assignable to type 'number'.",
						}],
					});
				}, { once: true });
				lspStarted();
			}),
			review: () => {
				reviewCalls++;
				return { stopReason: "stop" };
			},
			displayWarning: (details) => displayed.push(details),
		});

		runtime.handleBeforeAgentStart({ prompt: "Patch the feature." }, { cwd: repo });
		fs.writeFileSync(path.join(repo, "src", "file.ts"), "export const value: number = 'bad';\n", "utf-8");
		runtime.enqueueDelta("Assistant:\nEdited the file.");
		const end = runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });
		await lspStartedPromise;
		runtime.reset("test reset");
		await end;

		assert.equal(signalAborted, true);
		assert.equal(displayed.length, 0);
		assert.equal(reviewCalls, 0);
		assert.equal(runtime.getSnapshot(repo).status, "idle");
	});

	it("clears pending deltas when an edit-gated signature was already reviewed", async () => {
		const repo = createRepo();
		let reviewCalls = 0;
		const runtime = new MainWatchdogRuntime({
			cwd: repo,
			reviewChangesOnly: true,
			resolveConfig: () => configResult(enabledConfig()),
			review: () => {
				reviewCalls++;
				return { stopReason: "stop" };
			},
		});

		runtime.handleBeforeAgentStart({ prompt: "Patch the feature." }, { cwd: repo });
		fs.writeFileSync(path.join(repo, "src", "file.ts"), "export const value = 2;\n", "utf-8");
		runtime.enqueueDelta("Assistant:\nEdited the file.");
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });

		runtime.enqueueDelta("Assistant:\nDiscussed the already-reviewed edit.");
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });

		const snapshot = runtime.getSnapshot(repo);
		assert.equal(reviewCalls, 1);
		assert.equal(snapshot.status, "idle");
		assert.equal(snapshot.bufferedDeltas, 0);
	});

	it("dedupes repeated LSP diagnostic identities until diagnostics clear", async () => {
		const repo = createRepo();
		const displayed: unknown[] = [];
		let diagnostics: WatchdogLspResult["diagnostics"] = [{
			path: "src/file.ts",
			line: 1,
			column: 14,
			severity: "warning",
			source: "typescript",
			code: "TS6133",
			message: "'value' is declared but its value is never read.",
		}];
		const runtime = new MainWatchdogRuntime({
			cwd: repo,
			reviewChangesOnly: true,
			resolveConfig: () => configResult(enabledConfig({ lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp, enabled: true } })),
			lspDiagnostics: () => ({ status: "ok", provider: "stub-lsp", checkedPaths: ["src/file.ts"], skippedPaths: [], diagnostics }),
			review: () => ({ stopReason: "stop" }),
			displayWarning: (details) => displayed.push(details),
		});

		for (const value of [2, 3]) {
			runtime.handleBeforeAgentStart({ prompt: "Patch the feature." }, { cwd: repo });
			fs.writeFileSync(path.join(repo, "src", "file.ts"), `export const value = ${value};\n`, "utf-8");
			runtime.enqueueDelta("Assistant:\nEdited the file.");
			await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });
		}
		assert.equal(displayed.length, 1);
		assert.equal(runtime.getSnapshot(repo).lsp.freshDiagnosticCount, 0);

		diagnostics = [];
		runtime.handleBeforeAgentStart({ prompt: "Fix diagnostics." }, { cwd: repo });
		fs.writeFileSync(path.join(repo, "src", "file.ts"), "export const value = 4;\n", "utf-8");
		runtime.enqueueDelta("Assistant:\nEdited the file.");
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });

		diagnostics = [{
			path: "src/file.ts",
			line: 2,
			column: 1,
			severity: "warning",
			source: "typescript",
			code: "TS6133",
			message: "'value' is declared but its value is never read.",
		}];
		runtime.handleBeforeAgentStart({ prompt: "Reintroduce diagnostics." }, { cwd: repo });
		fs.writeFileSync(path.join(repo, "src", "file.ts"), "export const value = 5;\n", "utf-8");
		runtime.enqueueDelta("Assistant:\nEdited the file.");
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });

		assert.equal(displayed.length, 2);
	});

	it("records slow LSP checks as timeout status without emitting a warning", async () => {
		const repo = createRepo();
		const displayed: unknown[] = [];
		const runtime = new MainWatchdogRuntime({
			cwd: repo,
			reviewChangesOnly: true,
			resolveConfig: () => configResult(enabledConfig({ lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp, enabled: true } })),
			lspDiagnostics: () => ({
				status: "timeout",
				provider: "stub-lsp",
				checkedPaths: ["src/file.ts"],
				skippedPaths: [],
				diagnostics: [],
				message: "Timed out waiting for diagnostics.",
			}),
			review: () => ({ stopReason: "stop" }),
			displayWarning: (details) => displayed.push(details),
		});

		runtime.handleBeforeAgentStart({ prompt: "Patch the feature." }, { cwd: repo });
		fs.writeFileSync(path.join(repo, "src", "file.ts"), "export const value = 6;\n", "utf-8");
		runtime.enqueueDelta("Assistant:\nEdited the file.");
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });

		const snapshot = runtime.getSnapshot(repo);
		assert.equal(displayed.length, 0);
		assert.equal(snapshot.lsp.status, "timeout");
		assert.match(snapshot.lsp.message ?? "", /Timed out/);
	});

	it("does not review reverted or ignored tmp-only changes in edit-gated mode", async () => {
		const repo = createRepo();
		let reviewCalls = 0;
		const runtime = new MainWatchdogRuntime({
			cwd: repo,
			reviewChangesOnly: true,
			resolveConfig: () => configResult(enabledConfig()),
			review: () => {
				reviewCalls++;
				return { stopReason: "stop" };
			},
		});

		runtime.handleBeforeAgentStart({ prompt: "Try an edit." }, { cwd: repo });
		fs.writeFileSync(path.join(repo, "src", "file.ts"), "export const value = 3;\n", "utf-8");
		fs.writeFileSync(path.join(repo, "src", "file.ts"), "export const value = 1;\n", "utf-8");
		runtime.enqueueDelta("Assistant:\nEdited then reverted.");
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });

		fs.mkdirSync(path.join(repo, "tmp"));
		runtime.handleBeforeAgentStart({ prompt: "Write tmp artifact." }, { cwd: repo });
		fs.writeFileSync(path.join(repo, "tmp", "artifact.md"), "ignore me\n", "utf-8");
		runtime.enqueueDelta("Assistant:\nWrote tmp artifact.");
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: repo });

		assert.equal(reviewCalls, 0);
	});

	it("hard-caps each successful review to one displayed warning", async () => {
		const displayed: unknown[] = [];
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => configResult(enabledConfig()),
			displayWarning: (details) => displayed.push(details),
			review: (request) => {
				assert.equal(request.emitWarning(warning()), true);
				assert.equal(request.emitWarning({
					...warning(),
					summary: "Second runtime concern",
					evidence: "The same review tried to emit another concern.",
				}), false);
				return { stopReason: "stop" };
			},
		});

		runtime.enqueueDelta("Assistant:\nWorking");
		await runtime.handleAgentEnd({ type: "agent_end", messages: [] }, { cwd: "/tmp/project" });

		assert.equal(displayed.length, 1);
		assert.equal(runtime.getSnapshot().lastWarning?.summary, "Runtime concern");
		assert.equal(runtime.getSnapshot().lastWarning?.state, "displayed");
	});

	it("prepends current scope to boundary reviews", async () => {
		let reviewedDelta = "";
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => configResult(enabledConfig()),
			review: (request) => {
				reviewedDelta = request.delta;
				assert.equal(request.hasScope, true);
				return { stopReason: "stop" };
			},
		});

		runtime.handleBeforeAgentStart({ prompt: "Only update docs." }, { cwd: "/tmp/project" });
		runtime.enqueueDelta("Assistant:\nEdited docs.");
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: "/tmp/project" });

		assert.match(reviewedDelta, /^Current scope:/);
		assert.match(reviewedDelta, /Only update docs\./);
		assert.match(reviewedDelta, /category 'scope-drift'/);
	});

	it("runs visible steer corrections at cadence multiples and skips overlapping mid-run reviews", async () => {
		let releaseReview!: () => void;
		let reviewCalls = 0;
		const delivered: unknown[] = [];
		const firstStarted = new Promise<void>((resolve) => {
			const runtime = new MainWatchdogRuntime({
				resolveConfig: () => configResult(enabledConfig({ cadence: { everyNTools: 5 } })),
				displayWarning: (details, options) => delivered.push({ details, options }),
				review: async (request) => {
					reviewCalls++;
					assert.match(request.delta, /Current scope:/);
					assert.equal(request.emitWarning({ ...warning(), severity: "blocker", summary: `Cadence blocker ${reviewCalls}` }), true);
					resolve();
					await new Promise<void>((done) => { releaseReview = done; });
					return { stopReason: "stop" };
				},
			});
			runtime.handleBeforeAgentStart({ prompt: "Stay in scope." }, { cwd: "/tmp/project" });
			runtime.enqueueDelta("Assistant:\nUsing tools.");
			for (let index = 0; index < 5; index++) runtime.handleToolResult({ cwd: "/tmp/project" });
			for (let index = 0; index < 5; index++) runtime.handleToolResult({ cwd: "/tmp/project" });
		});

		await firstStarted;
		assert.equal(reviewCalls, 1);
		releaseReview();
		await tick();
		assert.equal(delivered.length, 1);
		assert.deepEqual((delivered[0] as { options?: unknown }).options, { deliverAs: "steer" });
	});

	it("cancels an in-flight cadence review so the agent-end boundary review still runs", async () => {
		let releaseFirstReview!: () => void;
		let reviewCalls = 0;
		let markFirstStarted!: () => void;
		const firstReviewStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => configResult(enabledConfig({ cadence: { everyNTools: 5 } })),
			review: async (request) => {
				reviewCalls++;
				if (reviewCalls === 1) {
					markFirstStarted();
					await new Promise<void>((done) => { releaseFirstReview = done; });
				}
				return { stopReason: "stop" };
			},
		});

		runtime.handleBeforeAgentStart({ prompt: "Stay in scope." }, { cwd: "/tmp/project" });
		runtime.enqueueDelta("Assistant:\nUsing tools.");
		for (let index = 0; index < 5; index++) runtime.handleToolResult({ cwd: "/tmp/project" });
		await firstReviewStarted;

		runtime.enqueueDelta("Assistant:\nFinal edits.");
		const agentEnd = runtime.handleAgentEnd({ type: "agent_end" }, { cwd: "/tmp/project" });
		releaseFirstReview();
		await agentEnd;

		const snapshot = runtime.getSnapshot();
		assert.equal(reviewCalls, 2, "boundary review must run even when a cadence review was in flight");
		assert.equal(snapshot.staleReviews, 1, "superseded cadence review is counted as stale");
		assert.equal(snapshot.status, "idle");
	});

	it("marks the third consecutive identical boundary warning as stalemate and delivers it held", async () => {
		const delivered: Array<{ warning: WatchdogWarningDetails; options?: unknown }> = [];
		const runtime = new MainWatchdogRuntime({
			resolveConfig: () => configResult(enabledConfig({ stalemateRepeats: 3 })),
			displayWarning: (details, options) => { delivered.push({ warning: details, options }); },
			review: (request) => {
				request.emitWarning({ ...warning(), severity: "blocker", summary: "Same blocker" });
				return { stopReason: "stop" };
			},
		});

		runtime.handleBeforeAgentStart({ prompt: "Patch carefully." }, { cwd: "/tmp/project" });
		for (const delta of ["Assistant:\nBad patch.", "Assistant:\nStill bad.", "Assistant:\nStill bad again."]) {
			runtime.enqueueDelta(delta);
			await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: "/tmp/project" });
		}

		assert.equal(delivered.length, 3, "repeats keep nudging until the stalemate threshold");
		assert.equal(delivered[0]?.options, undefined);
		assert.equal(delivered[1]?.options, undefined);
		assert.deepEqual(delivered[2]?.options, { triggerTurn: false });
		assert.equal(delivered[2]?.warning.state, "stalemate");
		assert.equal(delivered[2]?.warning.stalemateRepeats, 3);
		let snapshot = runtime.getSnapshot();
		assert.equal(snapshot.stalemate, true);
		assert.equal(snapshot.boundaryRepeats, 3);
		assert.equal(snapshot.lastWarning?.state, "stalemate");

		// After stalemate the same finding is a plain duplicate again: no further delivery.
		runtime.enqueueDelta("Assistant:\nStill bad, fourth time.");
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: "/tmp/project" });
		assert.equal(delivered.length, 3);

		// A real prompt resets the counter.
		runtime.handleBeforeAgentStart({ prompt: "Human: try a different approach." }, { cwd: "/tmp/project" });
		runtime.enqueueDelta("Assistant:\nNew attempt.");
		await runtime.handleAgentEnd({ type: "agent_end" }, { cwd: "/tmp/project" });
		assert.equal(delivered.length, 4);
		assert.equal(delivered[3]?.options, undefined);
		snapshot = runtime.getSnapshot();
		assert.equal(snapshot.boundaryRepeats, 1);
		assert.equal(snapshot.stalemate, false);
	});

	it("session on/off overrides explicit main enabled settings", () => {
		const runtime = new MainWatchdogRuntime({
			resolveConfig: (_cwd, options) => {
				const config = enabledConfig({ main: { enabled: false } });
				const session = options?.session as { enabled?: boolean; main?: { enabled?: boolean } } | undefined;
				if (session) {
					config.enabled = session.enabled ?? config.enabled;
					config.main.enabled = session.main?.enabled ?? config.main.enabled;
				}
				return configResult(config);
			},
		});

		assert.equal(runtime.getSnapshot().enabled, false);
		assert.equal(runtime.setSessionEnabled(true, "/tmp/project").enabled, true);
		assert.equal(runtime.setSessionEnabled(false, "/tmp/project").enabled, false);
	});

	it("clears session overrides when a new session is bound", () => {
		const runtime = new MainWatchdogRuntime({
			resolveConfig: (_cwd, options) => {
				const config = enabledConfig();
				const session = options?.session as { enabled?: boolean; main?: { enabled?: boolean } } | undefined;
				if (session) {
					config.enabled = session.enabled ?? config.enabled;
					config.main.enabled = session.main?.enabled ?? config.main.enabled;
				}
				return configResult(config);
			},
		});

		assert.equal(runtime.setSessionEnabled(false, "/tmp/project").enabled, false);
		runtime.bindSession({ cwd: "/tmp/project" });

		const snapshot = runtime.getSnapshot();
		assert.equal(snapshot.enabled, true);
		assert.equal(snapshot.sessionOverride, undefined);
	});
});
