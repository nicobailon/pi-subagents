import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/watchdog/settings.ts";
import { MainWatchdogRuntime, type WatchdogReviewFunction } from "../../src/watchdog/runtime.ts";
import type { ResolvedWatchdogConfig, WatchdogSettingsResult, WatchdogWarning } from "../../src/watchdog/types.ts";

function cloneConfig(): ResolvedWatchdogConfig {
	return {
		...DEFAULT_WATCHDOG_CONFIG,
		guidance: { ...DEFAULT_WATCHDOG_CONFIG.guidance },
		autoFollow: { ...DEFAULT_WATCHDOG_CONFIG.autoFollow },
		main: { ...DEFAULT_WATCHDOG_CONFIG.main },
		children: {
			...DEFAULT_WATCHDOG_CONFIG.children,
			autoFollow: { ...DEFAULT_WATCHDOG_CONFIG.children.autoFollow },
			overrides: { ...DEFAULT_WATCHDOG_CONFIG.children.overrides },
		},
		asyncCompletion: { ...DEFAULT_WATCHDOG_CONFIG.asyncCompletion },
	};
}

function configResult(config: ResolvedWatchdogConfig): WatchdogSettingsResult {
	return { ok: true, config, errors: [], sources: [] };
}

function enabledConfig(overrides: Partial<ResolvedWatchdogConfig> = {}): ResolvedWatchdogConfig {
	const config = cloneConfig();
	config.enabled = true;
	config.main.enabled = true;
	Object.assign(config, overrides);
	if (overrides.main) config.main = { ...config.main, ...overrides.main };
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
		assert.equal(snapshot.autoFollowQueued, false);
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

	it("treats failed review stop reasons as failed and never auto-follows", async () => {
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
		assert.equal(snapshot.autoFollowQueued, false);
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
		assert.equal(snapshot.autoFollowQueued, false);
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
		assert.equal(snapshot.autoFollowQueued, false);
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

		assert.equal(reviewedDelta.length, 24_000);
		assert.match(reviewedDelta, /^x+$/);
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
		assert.match(reviewedDelta, /^Changed repo paths:/);
		assert.match(reviewedDelta, /src\/file\.ts/);
		assert.match(reviewedDelta, /x+$/);
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
