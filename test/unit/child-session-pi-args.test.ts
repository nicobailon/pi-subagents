import assert from "node:assert/strict";
import { it } from "node:test";
import { buildPiArgs, SUBAGENT_MODEL_SCOPES_ENV } from "../../src/runs/shared/pi-args.ts";

it("passes launch-resolved model scopes to the child runtime", () => {
	const scopes = [{ origin: "modelScope", enforce: true, allow: ["openai-codex/*"] }];
	const { env } = buildPiArgs({
		baseArgs: [],
		task: "Test runtime scope wiring.",
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		modelScopes: scopes,
	});
	assert.deepEqual(JSON.parse(env[SUBAGENT_MODEL_SCOPES_ENV]!), scopes);
});
