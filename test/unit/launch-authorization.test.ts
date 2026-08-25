import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	SUBAGENT_LAUNCH_AUTHORIZATION_ENV,
	authorizeSubagentLaunch,
	decodeSubagentLaunchAuthorizationReservations,
	encodeSubagentLaunchAuthorizationReservations,
	registerSubagentLaunchAuthorizationProvider,
	resolveSubagentLaunchAuthorizationReservations,
	type SubagentLaunchAuthorizationRequest,
} from "../../src/api/launch-authorization.ts";
import {
	createDetachedSubagentLaunchAuthorizationContext,
	createDetachedSubagentLaunchAuthorizationGate,
	createSubagentLaunchAuthorizationApproval,
} from "../../src/runs/shared/launch-authorization.ts";

const originalAuthorizationEnv = process.env[SUBAGENT_LAUNCH_AUTHORIZATION_ENV];

function request(sessionId: string, agent = "package.protected"): SubagentLaunchAuthorizationRequest {
	return {
		version: 1,
		sessionId,
		invocation: {
			id: "tool-call-1",
			origin: "workflow",
			parentId: "tool-call-1",
			workflowRunId: "workflow-1",
			workflowKey: "review",
		},
		run: {
			id: "child-run-1",
			childIndex: 0,
			modelAttempt: 0,
			startupAttempt: 0,
			async: false,
		},
		agent: {
			name: agent,
			source: "package",
			filePath: "/package/agents/protected.md",
			definitionDigest: "a".repeat(64),
			runner: "native",
		},
		contract: {
			launchContractDigest: "b".repeat(64),
			context: "fresh",
			model: "provider/model",
			modelCandidates: ["provider/model"],
		},
	};
}

afterEach(() => {
	if (originalAuthorizationEnv === undefined) delete process.env[SUBAGENT_LAUNCH_AUTHORIZATION_ENV];
	else process.env[SUBAGENT_LAUNCH_AUTHORIZATION_ENV] = originalAuthorizationEnv;
});

describe("subagent launch authorization", () => {
	it("adds no launch work when no provider reserves the selected agent", () => {
		const sessionId = `unreserved-${Date.now()}-${Math.random()}`;
		assert.deepEqual(authorizeSubagentLaunch(request(sessionId)), { providers: [] });
	});

	it("does not call same-session providers that reserve another agent", () => {
		const sessionId = `unmatched-${Date.now()}-${Math.random()}`;
		let calls = 0;
		const dispose = registerSubagentLaunchAuthorizationProvider({
			name: "policy.unmatched/1",
			sessionId,
			agents: ["package.other"],
			authorize() {
				calls += 1;
				return { decision: "allow" };
			},
		});
		try {
			assert.deepEqual(authorizeSubagentLaunch(request(sessionId)), { providers: [] });
			assert.equal(calls, 0);
		} finally {
			dispose();
		}
	});

	it("requires every matching provider to allow the launch", () => {
		const sessionId = `composition-${Date.now()}-${Math.random()}`;
		const calls: string[] = [];
		const disposeAllow = registerSubagentLaunchAuthorizationProvider({
			name: "policy.a-allow/1",
			sessionId,
			agents: ["package.protected"],
			authorize() {
				calls.push("allow");
				return { decision: "allow" };
			},
		});
		const disposeDeny = registerSubagentLaunchAuthorizationProvider({
			name: "policy.z-deny/1",
			sessionId,
			agents: ["package.protected"],
			authorize() {
				calls.push("deny");
				return { decision: "deny", reason: "second policy rejected" };
			},
		});
		try {
			assert.throws(() => authorizeSubagentLaunch(request(sessionId)), /second policy rejected/);
			assert.deepEqual(calls, ["allow", "deny"]);
		} finally {
			disposeDeny();
			disposeAllow();
		}
	});

	it("calls every matching exact-session provider with a frozen prompt-free contract", () => {
		const sessionId = `allow-${Date.now()}-${Math.random()}`;
		const seen: Readonly<SubagentLaunchAuthorizationRequest>[] = [];
		const disposeFirst = registerSubagentLaunchAuthorizationProvider({
			name: "policy.first/1",
			sessionId,
			agents: ["package.protected"],
			authorize(value) {
				seen.push(value);
				return { decision: "allow" };
			},
		});
		const disposeSecond = registerSubagentLaunchAuthorizationProvider({
			name: "policy.second/1",
			sessionId,
			agents: ["package.protected", "package.other"],
			authorize() {
				return { decision: "allow" };
			},
		});
		try {
			assert.deepEqual(authorizeSubagentLaunch(request(sessionId)), { providers: ["policy.first/1", "policy.second/1"] });
			assert.equal(seen.length, 1);
			assert.equal(Object.isFrozen(seen[0]), true);
			assert.equal(Object.isFrozen(seen[0]?.contract), true);
			assert.equal(Object.isFrozen(seen[0]?.contract.modelCandidates), true);
			assert.equal("task" in (seen[0] as unknown as Record<string, unknown>), false);
			assert.equal(JSON.stringify(seen[0]).includes("systemPrompt"), false);
		} finally {
			disposeSecond();
			disposeFirst();
		}
	});

	it("fails closed on denial, provider errors, and invalid async decisions", () => {
		const deniedSession = `deny-${Date.now()}-${Math.random()}`;
		const disposeDenied = registerSubagentLaunchAuthorizationProvider({
			name: "policy.deny/1",
			sessionId: deniedSession,
			agents: ["package.protected"],
			authorize: () => ({ decision: "deny", reason: "receipt missing" }),
		});
		try {
			assert.throws(() => authorizeSubagentLaunch(request(deniedSession)), /denied agent 'package\.protected': receipt missing/);
		} finally {
			disposeDenied();
		}

		const throwingSession = `throw-${Date.now()}-${Math.random()}`;
		const disposeThrowing = registerSubagentLaunchAuthorizationProvider({
			name: "policy.throw/1",
			sessionId: throwingSession,
			agents: ["package.protected"],
			authorize() {
				throw new Error("policy unavailable");
			},
		});
		try {
			assert.throws(() => authorizeSubagentLaunch(request(throwingSession)), /provider 'policy\.throw\/1' failed closed\./);
		} finally {
			disposeThrowing();
		}

		const asyncSession = `async-${Date.now()}-${Math.random()}`;
		const disposeAsync = registerSubagentLaunchAuthorizationProvider({
			name: "policy.async/1",
			sessionId: asyncSession,
			agents: ["package.protected"],
			authorize: (() => Promise.resolve({ decision: "allow" })) as never,
		});
		try {
			assert.throws(() => authorizeSubagentLaunch(request(asyncSession)), /returned an invalid decision/);
		} finally {
			disposeAsync();
		}
	});

	it("keeps replacement disposal exact and session scoped", () => {
		const sessionId = `replace-${Date.now()}-${Math.random()}`;
		const otherSessionId = `${sessionId}-other`;
		const oldDispose = registerSubagentLaunchAuthorizationProvider({
			name: "policy.replace/1",
			sessionId,
			agents: ["package.protected"],
			authorize: () => ({ decision: "deny", reason: "old" }),
		});
		const newDispose = registerSubagentLaunchAuthorizationProvider({
			name: "policy.replace/1",
			sessionId,
			agents: ["package.protected"],
			authorize: () => ({ decision: "allow" }),
		});
		try {
			oldDispose();
			assert.deepEqual(authorizeSubagentLaunch(request(sessionId)), { providers: ["policy.replace/1"] });
			assert.deepEqual(authorizeSubagentLaunch(request(otherSessionId)), { providers: [] });
		} finally {
			newDispose();
		}
	});

	it("keeps a recreated session registry when an older disposer runs again", () => {
		const sessionId = `recreated-${Date.now()}-${Math.random()}`;
		const staleDispose = registerSubagentLaunchAuthorizationProvider({
			name: "policy.recreated/1",
			sessionId,
			agents: ["package.protected"],
			authorize: () => ({ decision: "deny", reason: "stale" }),
		});
		staleDispose();
		const currentDispose = registerSubagentLaunchAuthorizationProvider({
			name: "policy.recreated/1",
			sessionId,
			agents: ["package.protected"],
			authorize: () => ({ decision: "allow" }),
		});
		try {
			staleDispose();
			assert.deepEqual(authorizeSubagentLaunch(request(sessionId)), { providers: ["policy.recreated/1"] });
		} finally {
			currentDispose();
		}
	});

	it("propagates reservations and rejects an inherited provider that is unavailable locally", () => {
		const sessionId = `inherited-${Date.now()}-${Math.random()}`;
		const dispose = registerSubagentLaunchAuthorizationProvider({
			name: "policy.inherited/1",
			sessionId,
			agents: ["package.protected"],
			authorize: () => ({ decision: "allow" }),
		});
		try {
			const reservations = resolveSubagentLaunchAuthorizationReservations(sessionId);
			const encoded = encodeSubagentLaunchAuthorizationReservations(reservations);
			assert.deepEqual(decodeSubagentLaunchAuthorizationReservations(encoded), reservations);
			process.env[SUBAGENT_LAUNCH_AUTHORIZATION_ENV] = encoded;
			assert.throws(
				() => authorizeSubagentLaunch(request(`${sessionId}-child`)),
				/provider 'policy\.inherited\/1' is unavailable for reserved agent 'package\.protected'/,
			);
		} finally {
			dispose();
		}
	});

	it("consumes exact detached attempt approvals once and rejects missing manifests", () => {
		const sessionId = `detached-${Date.now()}-${Math.random()}`;
		const dispose = registerSubagentLaunchAuthorizationProvider({
			name: "policy.detached/1",
			sessionId,
			agents: ["package.protected"],
			authorize: () => ({ decision: "allow" }),
		});
		try {
			const reservations = resolveSubagentLaunchAuthorizationReservations(sessionId);
			assert.throws(
				() => createDetachedSubagentLaunchAuthorizationGate({ agentName: "package.protected", reservations }),
				/no exact detached launch authorization approval context/,
			);
			const base = request(sessionId);
			const detached = (startupAttempt: number): SubagentLaunchAuthorizationRequest => ({
				...base,
				run: { ...base.run, startupAttempt, async: true },
			});
			const approvals = [0, 1].map((startupAttempt) => createSubagentLaunchAuthorizationApproval(detached(startupAttempt), reservations));
			assert.ok(approvals.every((approval) => approval !== undefined));
			const context = createDetachedSubagentLaunchAuthorizationContext(approvals as NonNullable<(typeof approvals)[number]>[]);
			const gate = createDetachedSubagentLaunchAuthorizationGate({ agentName: "package.protected", context, reservations });
			const attempt = (startupAttempt: number) => ({
				run: { id: base.run.id, childIndex: 0, modelAttempt: 0, startupAttempt },
				agent: { name: base.agent.name, definitionDigest: base.agent.definitionDigest, runner: base.agent.runner },
				contract: {
					launchContractDigest: base.contract.launchContractDigest,
					context: "fresh" as const,
					model: "provider/model",
					modelCandidates: base.contract.modelCandidates,
				},
			});
			gate.authorizeAttempt(attempt(0));
			assert.throws(() => gate.authorizeAttempt(attempt(0)), /no exact detached launch authorization approval/);
			gate.authorizeAttempt(attempt(1));
		} finally {
			dispose();
		}
	});

	it("enforces request, provider, and inherited payload bounds", () => {
		const boundarySession = `bounds-${Date.now()}-${Math.random()}`;
		const maxAgents = Array.from({ length: 256 }, (_, index) => `agent-${index}`);
		const disposeBoundary = registerSubagentLaunchAuthorizationProvider({
			name: "p".repeat(128),
			sessionId: boundarySession,
			agents: maxAgents,
			authorize: () => ({ decision: "allow" }),
		});
		disposeBoundary();
		assert.throws(() => registerSubagentLaunchAuthorizationProvider({
			name: "p".repeat(129),
			sessionId: boundarySession,
			agents: ["worker"],
			authorize: () => ({ decision: "allow" }),
		}), /exceeds 128 UTF-8 bytes/);
		assert.throws(() => registerSubagentLaunchAuthorizationProvider({
			name: "policy.bounds/1",
			sessionId: boundarySession,
			agents: [...maxAgents, "agent-overflow"],
			authorize: () => ({ decision: "allow" }),
		}), /between 1 and 256/);

		const dispose = registerSubagentLaunchAuthorizationProvider({
			name: "policy.request-bounds/1",
			sessionId: boundarySession,
			agents: ["package.protected"],
			authorize: () => ({ decision: "allow" }),
		});
		try {
			const base = request(boundarySession);
			assert.throws(() => authorizeSubagentLaunch({ ...base, run: { ...base.run, childIndex: -1 } }), /childIndex must be a non-negative integer/);
			assert.throws(() => authorizeSubagentLaunch({ ...base, run: { ...base.run, modelAttempt: 0.5 } }), /modelAttempt must be a non-negative integer/);
			assert.throws(() => authorizeSubagentLaunch({ ...base, invocation: { ...base.invocation, id: "x".repeat(513) } }), /invocation id exceeds 512 UTF-8 bytes/);
			assert.throws(() => authorizeSubagentLaunch({ ...base, contract: { ...base.contract, modelCandidates: Array.from({ length: 65 }, (_, index) => `provider/model-${index}`) } }), /at most 64/);
			assert.throws(() => authorizeSubagentLaunch({ ...base, agent: { ...base.agent, filePath: `/${"x".repeat(16 * 1024)}` } }), /filePath exceeds 16384 UTF-8 bytes/);
		} finally {
			dispose();
		}
		assert.throws(() => decodeSubagentLaunchAuthorizationReservations("x".repeat(128 * 1024 + 1)), /encoded payload is too large/);
	});

	it("rejects malformed providers, reserved requests, and inherited payloads", () => {
		assert.throws(() => registerSubagentLaunchAuthorizationProvider({ name: "bad provider", sessionId: "session", agents: ["worker"], authorize: () => ({ decision: "allow" }) }), /invalid provider name/);
		assert.throws(() => registerSubagentLaunchAuthorizationProvider({ name: "policy/1", sessionId: "session", agents: [], authorize: () => ({ decision: "allow" }) }), /between 1 and 256/);
		const sessionId = `validation-${Date.now()}-${Math.random()}`;
		const dispose = registerSubagentLaunchAuthorizationProvider({
			name: "policy.validation/1",
			sessionId,
			agents: ["package.protected"],
			authorize: () => ({ decision: "allow" }),
		});
		try {
			assert.throws(() => authorizeSubagentLaunch({ ...request(sessionId), contract: { ...request(sessionId).contract, launchContractDigest: "bad" } }), /lowercase SHA-256/);
		} finally {
			dispose();
		}
		assert.throws(() => decodeSubagentLaunchAuthorizationReservations("not-json"), /Invalid inherited launch authorization/);
	});
});
