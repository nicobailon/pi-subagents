import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatChildModelResolutionDiagnostic, isChildModelResolutionFailure } from "../../src/runs/shared/model-resolution-diagnostic.ts";

const CORE_MESSAGE = 'Model "pengepul/commandcode/deepseek/deepseek-v4.1-flash:max" not found. Use --list-models to see available models.';
const CORE_PROVIDER_MESSAGE = 'Unknown provider "pengepul/commandcode". Use --list-models to see available providers/models.';

describe("child model resolution diagnostic", () => {
	it("matches core's model-resolution failure text and leaves other failures alone", () => {
		assert.equal(isChildModelResolutionFailure(CORE_MESSAGE), true);
		assert.equal(isChildModelResolutionFailure(`  ${CORE_PROVIDER_MESSAGE}  `), true);
		assert.equal(isChildModelResolutionFailure('Model "openai/gpt-5" is temporarily unavailable (HTTP 503).'), false);
		assert.equal(isChildModelResolutionFailure('Model "openai/gpt-5" is disabled for this account.'), false);
		assert.equal(isChildModelResolutionFailure("Subagent session failed before its first turn."), false);
		assert.equal(isChildModelResolutionFailure(""), false);
		assert.equal(isChildModelResolutionFailure(undefined), false);
	});

	it("names the foreground provider-inheritance rule, the model, and the remedies", () => {
		const text = formatChildModelResolutionDiagnostic({
			agent: "provider-model-worker",
			model: "pengepul/commandcode/deepseek/deepseek-v4.1-flash",
			host: "parent",
		});
		assert.match(text, /Agent 'provider-model-worker' ran as a foreground child, which never loads the parent's ambient extensions but inherits the providers they registered/);
		assert.match(text, /If 'pengepul\/commandcode\/deepseek\/deepseek-v4\.1-flash' is served by a provider extension, check the parent's `\/model` list and the child extension diagnostics/);
		assert.doesNotMatch(text, /`async: true`/);
		assert.match(text, /`subagentOnlyExtensions` or `extensions` in the agent frontmatter/);
		assert.doesNotMatch(text, /background child without the ambient extensions/);
		assert.doesNotMatch(text, /Capability ceiling/);
	});

	it("tells a foreground child that a capability ceiling denies the extension", () => {
		const text = formatChildModelResolutionDiagnostic({
			agent: "provider-model-worker",
			model: "pengepul/commandcode/deepseek/deepseek-v4.1-flash",
			host: "parent",
			capabilityCeiling: { denyExtensions: true, sources: ["policy-fixture"] },
		});
		assert.match(text, /Capability ceiling from policy-fixture denies extensions/);
		assert.match(text, /`async: true` does not help either/);
		assert.match(text, /Relax the capability ceiling to allow extensions/);
		assert.doesNotMatch(text, /must run as background children/);
		assert.doesNotMatch(text, /load the provider extension explicitly/);
	});

	it("tells a background child that a capability ceiling denies the extension", () => {
		const text = formatChildModelResolutionDiagnostic({
			model: "pengepul/commandcode/deepseek/deepseek-v4.1-flash",
			host: "runner",
			capabilityCeiling: { denyExtensions: true },
		});
		assert.match(text, /^Subagent ran as a background child without the ambient extensions/);
		assert.match(text, /Capability ceiling from an unnamed source denies extensions/);
		assert.match(text, /does not enable ambient loading/);
		assert.match(text, /Relax the capability ceiling to allow extensions/);
		assert.doesNotMatch(text, /leave `extensions` unset so the child loads the ambient extensions/);
	});

	it("explains a background child launched without the ambient extensions", () => {
		const text = formatChildModelResolutionDiagnostic({
			model: "pengepul/commandcode/deepseek/deepseek-v4.1-flash",
			host: "runner",
		});
		assert.match(text, /^Subagent ran as a background child without the ambient extensions/);
		assert.match(text, /that extension is not loaded for this child: list it in `subagentOnlyExtensions` or `extensions` in the agent frontmatter/);
		assert.match(text, /leave `extensions` unset/);
		assert.doesNotMatch(text, /foreground child/);
		assert.doesNotMatch(text, /Capability ceiling/);
	});

	it("defaults to the background branch and tolerates a missing model", () => {
		const text = formatChildModelResolutionDiagnostic({});
		assert.match(text, /^Subagent ran as a background child without the ambient extensions/);
		assert.match(text, /If this model is served by a provider extension/);
		assert.doesNotMatch(text, /Capability ceiling/);
	});
});
