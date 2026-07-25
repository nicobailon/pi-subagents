import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";

describe("capability ceiling child launch enforcement", () => {
	const base = {
		baseArgs: [] as string[],
		task: "test",
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritSkills: false,
	};

	it("intersects declared tools and preserves structured output as an internal tool", () => {
		const { args, env } = buildPiArgs({
			...base,
			tools: ["read", "write", "subagent"],
			capabilityCeiling: { version: 1, allowedTools: ["read", "structured_output"], denyExtensions: false, sources: ["test"] },
			structuredOutput: { schema: {}, schemaPath: "/tmp/schema.json", outputPath: "/tmp/output.json" },
		});
		assert.deepEqual(args.slice(args.indexOf("--tools") + 1, args.indexOf("--tools") + 2), ["read,structured_output"]);
		assert.equal(env.PI_SUBAGENT_CAPABILITY_CEILING_V1 !== undefined, true);
		assert.equal(args.includes("write"), false);
		assert.equal(args.includes("subagent"), false);
	});

	it("allows a valid empty intersection and denies configured extensions", () => {
		const { args } = buildPiArgs({
			...base,
			tools: ["read", "/tmp/provider.ts"],
			extensions: ["/tmp/extension.ts"],
			capabilityCeiling: { version: 1, allowedTools: [], denyExtensions: true, sources: ["plan"] },
		});
		assert.ok(args.includes("--no-tools"));
		assert.ok(args.includes("--no-extensions"));
		assert.equal(args.includes("/tmp/provider.ts"), false);
		assert.equal(args.includes("/tmp/extension.ts"), false);
	});

	it("restricts omitted tool declarations without requiring every allowed name", () => {
		const { args, env } = buildPiArgs({
			...base,
			capabilityCeiling: { version: 1, allowedTools: ["read", "grep"], denyExtensions: true, sources: ["plan"] },
		});
		assert.ok(args.includes("--tools"));
		assert.ok(args.includes("grep,read"));
		assert.equal(env.PI_SUBAGENT_REQUIRED_TOOLS, undefined);
	});


	it("does not report retained extension paths as removed tools", () => {
		const { capabilityAudit } = buildPiArgs({
			...base,
			tools: ["read", "/tmp/provider.ts"],
			extensions: ["/tmp/extension.ts"],
			capabilityCeiling: { version: 1, allowedTools: ["read"], denyExtensions: false, sources: ["plan"] },
		});
		assert.deepEqual(capabilityAudit?.requestedTools, ["read"]);
		assert.deepEqual(capabilityAudit?.removedTools, []);
		assert.equal(capabilityAudit?.removedExtensionCount, 0);
	});

	it("counts denied extension entries without exposing them as tool names", () => {
		const { capabilityAudit } = buildPiArgs({
			...base,
			tools: ["read", "/tmp/provider.ts"],
			extensions: ["/tmp/extension.ts"],
			subagentOnlyExtensions: ["/tmp/child-only.ts"],
			capabilityCeiling: { version: 1, allowedTools: ["read"], denyExtensions: true, sources: ["plan"] },
		});
		assert.deepEqual(capabilityAudit?.requestedTools, ["read"]);
		assert.deepEqual(capabilityAudit?.removedTools, []);
		assert.equal(capabilityAudit?.removedExtensionCount, 3);
	});

	it("fails closed when lazy skills require a denied read tool", () => {
		assert.throws(() => buildPiArgs({
			...base,
			tools: ["grep"],
			requireReadTool: true,
			capabilityCeiling: { version: 1, allowedTools: ["grep"], denyExtensions: false, sources: ["plan"] },
		}), /excludes required tool 'read'/);
	});
});
