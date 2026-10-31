import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerSubagentLaunchCheck, type SubagentLaunch, type SubagentLaunchDecision } from "../../src/api/launch-check.ts";
import { evaluateSubagentLaunchChecks, hasSubagentLaunchChecks } from "../../src/runs/shared/launch-check.ts";

function launch(overrides: Partial<SubagentLaunch> = {}): SubagentLaunch {
	return {
		origin: { kind: "request", requestId: "call-1" },
		agent: "worker",
		task: "Do the work",
		cwd: "/work",
		worktree: false,
		verify: [{ id: "gate", command: "npm test" }],
		background: false,
		...overrides,
	};
}

const uniqueSession = () => `launch-check-${Date.now()}-${Math.random()}`;

describe("subagent launch checks", () => {
	it("returns synchronously and builds no description when nothing is registered", () => {
		const sessionId = uniqueSession();
		let described = false;
		const result = evaluateSubagentLaunchChecks({ sessionId, agent: "worker", describe: () => { described = true; return launch(); } });
		assert.equal(result, undefined);
		assert.equal(described, false);
		assert.equal(evaluateSubagentLaunchChecks({ sessionId: undefined, agent: "worker", describe: () => launch() }), undefined);
	});

	it("runs checks in registration order and stops at the first refusal", async () => {
		const sessionId = uniqueSession();
		const calls: string[] = [];
		const handles = [
			registerSubagentLaunchCheck({ sessionId, source: "first", check: async () => { calls.push("first"); return { allow: true }; } }),
			registerSubagentLaunchCheck({ sessionId, source: "second", check: () => { calls.push("second"); return { allow: false, reason: "not today" }; } }),
			registerSubagentLaunchCheck({ sessionId, source: "third", check: () => { calls.push("third"); return { allow: true }; } }),
		];
		try {
			const denial = await evaluateSubagentLaunchChecks({ sessionId, agent: "worker", describe: () => launch() });
			assert.equal(denial, "Launch check from second denied agent 'worker': not today");
			assert.deepEqual(calls, ["first", "second"]);
		} finally {
			for (const handle of handles) handle.dispose();
		}
	});

	it("allows a launch every check allows", async () => {
		const sessionId = uniqueSession();
		const seen: SubagentLaunch[] = [];
		const handle = registerSubagentLaunchCheck({ sessionId, source: "audit", check: (description) => { seen.push(description); return { allow: true }; } });
		try {
			assert.equal(await evaluateSubagentLaunchChecks({ sessionId, agent: "worker", describe: () => launch({ model: "mock/model", outputPath: "/work/out.md", background: true }) }), undefined);
			assert.deepEqual(seen, [launch({ model: "mock/model", outputPath: "/work/out.md", background: true })]);
		} finally {
			handle.dispose();
		}
	});

	it("refuses a throw, a rejection, an invalid decision, an empty reason and an abort", async () => {
		const sessionId = uniqueSession();
		const cases: Array<[string, (description: SubagentLaunch, signal: AbortSignal) => SubagentLaunchDecision | Promise<SubagentLaunchDecision>, RegExp]> = [
			["throws", () => { throw new Error("boom"); }, /denied agent 'worker': boom$/],
			["rejects", () => Promise.reject(new Error("async boom")), /denied agent 'worker': async boom$/],
			["returns nothing", () => undefined as unknown as SubagentLaunchDecision, /denied agent 'worker': returned an invalid decision$/],
			["returns a truthy non-decision", () => ({ allowed: true }) as unknown as SubagentLaunchDecision, /denied agent 'worker': returned an invalid decision$/],
			["returns a non-boolean allow", () => ({ allow: "yes" }) as unknown as SubagentLaunchDecision, /returned an invalid decision$/],
			["gives an empty reason", () => ({ allow: false, reason: " \n " }), /returned a denial without a reason$/],
			["waits past an abort", (_description, signal) => new Promise<SubagentLaunchDecision>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("late")), { once: true })), /aborted before the check answered$/],
		];
		for (const [name, check, expected] of cases) {
			const controller = new AbortController();
			const handle = registerSubagentLaunchCheck({ sessionId, source: name, check });
			try {
				const pending = evaluateSubagentLaunchChecks({ sessionId, agent: "worker", describe: () => launch(), signal: controller.signal });
				if (name === "waits past an abort") setImmediate(() => controller.abort());
				const denial = await pending;
				assert.match(denial ?? "", expected, name);
				assert.match(denial ?? "", new RegExp(`^Launch check from ${name} denied`), name);
			} finally {
				handle.dispose();
			}
		}
	});

	it("refuses when the launch is already aborted without calling the check", async () => {
		const sessionId = uniqueSession();
		let called = false;
		const handle = registerSubagentLaunchCheck({ sessionId, source: "late", check: () => { called = true; return { allow: true }; } });
		try {
			const controller = new AbortController();
			controller.abort();
			assert.match(await evaluateSubagentLaunchChecks({ sessionId, agent: "worker", describe: () => launch(), signal: controller.signal }) ?? "", /aborted before the check answered$/);
			assert.equal(called, false);
		} finally {
			handle.dispose();
		}
	});

	it("refuses a launch that cannot be described", async () => {
		const sessionId = uniqueSession();
		let called = false;
		const handle = registerSubagentLaunchCheck({ sessionId, source: "never", check: () => { called = true; return { allow: true }; } });
		try {
			const denial = await evaluateSubagentLaunchChecks({ sessionId, agent: "worker", describe: () => { throw new Error("no such model"); } });
			assert.equal(denial, "Launch of agent 'worker' was refused because it could not be described for launch checks: no such model");
			assert.equal(called, false);
		} finally {
			handle.dispose();
		}
	});

	it("strips control characters from a reason and bounds its length", async () => {
		const sessionId = uniqueSession();
		const handle = registerSubagentLaunchCheck({ sessionId, source: "loud", check: () => ({ allow: false, reason: `bad\u001b[31m\nthing${"x".repeat(2000)}` }) });
		try {
			const denial = await evaluateSubagentLaunchChecks({ sessionId, agent: "worker", describe: () => launch() });
			assert.ok(denial);
			assert.doesNotMatch(denial, /[\u0000-\u001f\u007f]/u);
			assert.match(denial, /^Launch check from loud denied agent 'worker': bad \[31m thingx+\.\.\.$/);
			assert.ok(denial.length < 650);
		} finally {
			handle.dispose();
		}
	});

	it("hands every check a deep-frozen copy that does not alias the caller's objects", async () => {
		const sessionId = uniqueSession();
		const verify = [{ id: "gate", command: "npm test", cwd: "/work" }];
		const source = launch({ verify });
		const frozen: boolean[] = [];
		const handle = registerSubagentLaunchCheck({
			sessionId,
			source: "freeze",
			check: (description) => {
				frozen.push(Object.isFrozen(description), Object.isFrozen(description.origin), Object.isFrozen(description.verify), Object.isFrozen(description.verify[0]));
				assert.throws(() => { (description as { agent: string }).agent = "other"; }, TypeError);
				return { allow: true };
			},
		});
		try {
			await evaluateSubagentLaunchChecks({ sessionId, agent: "worker", describe: () => source });
			assert.deepEqual(frozen, [true, true, true, true]);
			assert.equal(Object.isFrozen(source), false);
			assert.equal(Object.isFrozen(verify[0]), false);
		} finally {
			handle.dispose();
		}
	});

	it("disposes only its own registration, idempotently", async () => {
		const sessionId = uniqueSession();
		const calls: string[] = [];
		const first = registerSubagentLaunchCheck({ sessionId, source: "first", check: () => { calls.push("first"); return { allow: true }; } });
		const second = registerSubagentLaunchCheck({ sessionId, source: "second", check: () => { calls.push("second"); return { allow: true }; } });
		try {
			first.dispose();
			first.dispose();
			assert.equal(hasSubagentLaunchChecks(sessionId), true);
			await evaluateSubagentLaunchChecks({ sessionId, agent: "worker", describe: () => launch() });
			assert.deepEqual(calls, ["second"]);
			second.dispose();
			second.dispose();
			assert.equal(hasSubagentLaunchChecks(sessionId), false);
			assert.equal(evaluateSubagentLaunchChecks({ sessionId, agent: "worker", describe: () => launch() }), undefined);
		} finally {
			first.dispose();
			second.dispose();
		}
	});

	it("keeps a registration made after its bucket emptied", () => {
		const sessionId = uniqueSession();
		const stale = registerSubagentLaunchCheck({ sessionId, source: "stale", check: () => ({ allow: true }) });
		stale.dispose();
		const fresh = registerSubagentLaunchCheck({ sessionId, source: "fresh", check: () => ({ allow: true }) });
		try {
			stale.dispose();
			assert.equal(hasSubagentLaunchChecks(sessionId), true);
		} finally {
			fresh.dispose();
		}
	});

	it("applies a registration only to its own session", async () => {
		const sessionId = uniqueSession();
		const other = `${sessionId}-other`;
		const handle = registerSubagentLaunchCheck({ sessionId, source: "scoped", check: () => ({ allow: false, reason: "no" }) });
		try {
			assert.equal(evaluateSubagentLaunchChecks({ sessionId: other, agent: "worker", describe: () => launch() }), undefined);
			assert.match(await evaluateSubagentLaunchChecks({ sessionId, agent: "worker", describe: () => launch() }) ?? "", /denied agent 'worker': no$/);
		} finally {
			handle.dispose();
		}
	});

	it("validates the session id, source and check", () => {
		const check = () => ({ allow: true as const });
		assert.throws(() => registerSubagentLaunchCheck({ sessionId: "", source: "x", check }), /Invalid launch check sessionId/);
		assert.throws(() => registerSubagentLaunchCheck({ sessionId: "x", source: "bad\nsource", check }), /Invalid launch check source/);
		assert.throws(() => registerSubagentLaunchCheck({ sessionId: "x", source: "s".repeat(300), check }), /Invalid launch check source/);
		assert.throws(() => registerSubagentLaunchCheck({ sessionId: "x", source: "x", check: undefined as never }), /expected a function/);
		assert.equal(hasSubagentLaunchChecks("x"), false);
	});
});
