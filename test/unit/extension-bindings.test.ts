import assert from "node:assert/strict";
import * as os from "node:os";
import { describe, it } from "node:test";
import { launchBindingDigest } from "../../src/shared/launch-contract.ts";
import {
	MAX_EXTENSION_BINDING_NAMESPACES,
	MAX_EXTENSION_BINDINGS_BYTES,
	PI_SUBAGENT_EXTENSION_BINDINGS_ENV,
	type ExtensionBindings,
	normalizeExtensionBindings,
	omitExtensionBindingsEnv,
} from "../../src/runs/shared/extension-bindings.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

function childEnv(extensionBindings?: ExtensionBindings, host: "parent" | "runner" = "runner"): Record<string, string | undefined> {
	const normalizedExtensionBindings = normalizeExtensionBindings(extensionBindings)?.value;
	const launch = buildInProcessChildLaunch({
		host,
		cwd: os.tmpdir(),
		childAgentName: "worker",
		childIndex: 0,
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		extensionBindings: normalizedExtensionBindings,
	});
	return launch.session.processEnv ?? {};
}

describe("extension bindings", () => {
	it("canonicalizes bounded namespaced JSON and isolates it from caller mutation", () => {
		const input = { "shepherd.dispatch/1": { writeScope: ["src/a.ts"], role: "coder" } };
		const normalized = normalizeExtensionBindings(input)!;
		assert.equal(normalized.json, '{"shepherd.dispatch/1":{"role":"coder","writeScope":["src/a.ts"]}}');
		input["shepherd.dispatch/1"].role = "reviewer";
		assert.equal(normalized.json.includes("reviewer"), false);
		assert.equal(Object.isFrozen(normalized.value), true);
	});

	it("rejects malformed, oversized, and unsafe values", () => {
		assert.throws(() => normalizeExtensionBindings({ invalid: true }), /namespace/);
		assert.throws(() => normalizeExtensionBindings(Object.fromEntries(Array.from({ length: MAX_EXTENSION_BINDING_NAMESPACES + 1 }, (_, index) => [`pkg${index}\/1`, true]))), /at most/);
		assert.throws(() => normalizeExtensionBindings({ "pkg/1": "x".repeat(MAX_EXTENSION_BINDINGS_BYTES) }), /maximum/);
		assert.throws(() => normalizeExtensionBindings({ "pkg/1": Number.NaN }), /finite/);
		const cyclic: Record<string, unknown> = { "pkg/1": {} };
		(cyclic["pkg/1"] as Record<string, unknown>).self = cyclic;
		assert.throws(() => normalizeExtensionBindings(cyclic), /cycles/);
		const accessor = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(accessor, "pkg/1", { enumerable: true, get: () => true });
		assert.throws(() => normalizeExtensionBindings(accessor), /data property/);
	});

	it("sets canonical child env for the runner host and clears it when omitted", () => {
		const omitted = childEnv();
		assert.equal(Object.hasOwn(omitted, PI_SUBAGENT_EXTENSION_BINDINGS_ENV), true);
		assert.equal(omitted[PI_SUBAGENT_EXTENSION_BINDINGS_ENV], undefined);
		assert.equal(childEnv({ "child/1": { z: 1, a: 2 } })[PI_SUBAGENT_EXTENSION_BINDINGS_ENV], '{"child/1":{"a":2,"z":1}}');
		assert.deepEqual(childEnv({ "child/1": true }, "parent"), {}, "the parent host never writes child environment values");
	});

	it("removes ambient bindings from external runner environments", () => {
		assert.deepEqual(omitExtensionBindingsEnv({ KEEP_ME: "yes", [PI_SUBAGENT_EXTENSION_BINDINGS_ENV]: "secret" }), { KEEP_ME: "yes" });
	});

	it("changes launch provenance only when the binding changes", () => {
		const base = { definitionDigest: "definition", task: "task", inheritProjectContext: false, inheritSkills: false };
		const omitted = launchBindingDigest(base);
		const first = launchBindingDigest({ ...base, extensionBindings: normalizeExtensionBindings({ "policy/1": { role: "coder" } })!.value });
		const second = launchBindingDigest({ ...base, extensionBindings: normalizeExtensionBindings({ "policy/1": { role: "reviewer" } })!.value });
		assert.notEqual(first, omitted);
		assert.notEqual(first, second);
	});
});
