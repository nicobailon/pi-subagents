import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	decodeSubagentCapabilityCeiling,
	encodeSubagentCapabilityCeiling,
	intersectSubagentCapabilityCeilings,
	resolveCurrentSubagentCapabilityCeiling,
	parseSubagentCapabilityCeiling,
	registerSubagentCapabilityCeiling,
	resolveSubagentCapabilityCeiling,
} from "../../src/api/capability-ceiling.ts";

describe("subagent capability ceiling", () => {
	it("intersects active registrations for an exact session", () => {
		const sessionId = `cap-${Date.now()}-${Math.random()}`;
		const first = registerSubagentCapabilityCeiling({ sessionId, source: "plan", ceiling: { allowedTools: ["read", "grep", "write"] } });
		const second = registerSubagentCapabilityCeiling({ sessionId, source: "review", ceiling: { allowedTools: ["read", "grep"], denyExtensions: true } });
		assert.deepEqual(resolveSubagentCapabilityCeiling(sessionId), {
			version: 1,
			allowedTools: ["grep", "read"],
			denyExtensions: true,
			sources: ["plan", "review"],
		});
		assert.equal(resolveSubagentCapabilityCeiling(`${sessionId}-other`), undefined);
		second.dispose();
		first.dispose();
	});

	it("keeps explicit empty allowlists distinct from unrestricted state", () => {
		const ceiling = intersectSubagentCapabilityCeilings({ version: 1, allowedTools: [], denyExtensions: false, sources: ["test"] });
		assert.deepEqual(ceiling?.allowedTools, []);
		assert.equal(intersectSubagentCapabilityCeilings(), undefined);
	});

	it("rejects malformed policy and disposed updates", () => {
		assert.throws(() => registerSubagentCapabilityCeiling({ sessionId: "x", source: "x", ceiling: {} }), /allowedTools or denyExtensions/);
		const handle = registerSubagentCapabilityCeiling({ sessionId: "disposed", source: "test", ceiling: { denyExtensions: true } });
		handle.dispose();
		assert.throws(() => handle.update({ allowedTools: ["read"] }), /disposed/);
	});

	it("round-trips inherited policy and rejects malformed payloads", () => {
		const input = { version: 1 as const, allowedTools: ["read"], denyExtensions: true, sources: ["plan"] };
		assert.deepEqual(decodeSubagentCapabilityCeiling(encodeSubagentCapabilityCeiling(input)), input);
		assert.throws(() => decodeSubagentCapabilityCeiling("not-base64-json"), /Invalid inherited capability ceiling/);
		assert.throws(() => parseSubagentCapabilityCeiling({ version: 1, allowedTools: ["read"], denyExtensions: true }), /sources/);
		assert.throws(() => parseSubagentCapabilityCeiling({ version: 2, allowedTools: ["read"], denyExtensions: true, sources: ["plan"] }), /version/);
	});

	it("combines inherited process policy with exact-session registrations", () => {
		const previous = process.env.PI_SUBAGENT_CAPABILITY_CEILING_V1;
		const sessionId = `current-${Date.now()}-${Math.random()}`;
		const handle = registerSubagentCapabilityCeiling({ sessionId, source: "local", ceiling: { allowedTools: ["grep", "read"] } });
		try {
			process.env.PI_SUBAGENT_CAPABILITY_CEILING_V1 = encodeSubagentCapabilityCeiling({ version: 1, allowedTools: ["read", "write"], denyExtensions: true, sources: ["ancestor"] });
			assert.deepEqual(resolveCurrentSubagentCapabilityCeiling(sessionId), {
				version: 1,
				allowedTools: ["read"],
				denyExtensions: true,
				sources: ["ancestor", "local"],
			});
		} finally {
			handle.dispose();
			if (previous === undefined) delete process.env.PI_SUBAGENT_CAPABILITY_CEILING_V1;
			else process.env.PI_SUBAGENT_CAPABILITY_CEILING_V1 = previous;
		}
	});
});
