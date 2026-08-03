import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	decodePermissionRules,
	encodePermissionRules,
	permissionArgsPreview,
	permissionDecision,
	resolvePermissionRules,
	validatePermissionConfig,
	validatePermissionRules,
} from "../../src/runs/shared/permissions.ts";

describe("native child permissions", () => {
	it("defaults every unconfigured tool and bash to pass-through", () => {
		assert.equal(permissionDecision(undefined, "write"), "allow");
		assert.equal(permissionDecision({ write: "deny" }, "unknown_tool"), "allow");
		assert.equal(permissionDecision({ write: "deny" }, "bash"), "allow");
		assert.equal(resolvePermissionRules(), undefined);
	});

	it("merges explicit global and agent rules while removing explicit allow rules", () => {
		assert.deepEqual(resolvePermissionRules(
			{ rules: { write: "ask", edit: "deny" } },
			{ write: "allow", read: "deny" },
		), { edit: "deny", read: "deny" });
	});

	it("rejects bash and coordination-tool rules", () => {
		assert.throws(() => validatePermissionRules({ bash: "ask" }, "permissions"), /pi-guard/);
		assert.throws(() => validatePermissionRules({ contact_supervisor: "deny" }, "permissions"), /reserved for child coordination/);
		assert.throws(() => validatePermissionConfig({ rules: { write: "sometimes" } }), /allow, ask, or deny/);
	});

	it("round-trips only explicit non-allow rules and redacts bounded previews", () => {
		const encoded = encodePermissionRules({ write: "ask" });
		assert.deepEqual(decodePermissionRules(encoded), { write: "ask" });
		const preview = permissionArgsPreview({ token: "secret-value", content: `Bearer abcdefghijklmnop ${"x".repeat(3000)}` });
		assert.doesNotMatch(preview, /secret-value|abcdefghijklmnop/);
		assert.ok(Buffer.byteLength(preview) <= 2048);

		const multibytePreview = permissionArgsPreview({ content: Array.from({ length: 10 }, () => "😀".repeat(300)) });
		assert.ok(Buffer.byteLength(multibytePreview, "utf-8") <= 2048);
		assert.doesNotMatch(multibytePreview, /�/);
		assert.match(multibytePreview, /…$/);
	});
});
