import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPiArgs } from "./pi-args.ts";

function valueAfter(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	return idx === -1 ? undefined : args[idx + 1];
}

describe("buildPiArgs session wiring", () => {
	it("uses --session when sessionFile is provided", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: true,
			sessionFile: "/tmp/forked-session.jsonl",
			sessionDir: "/tmp/should-not-be-used",
		});

		assert.ok(args.includes("--session"));
		assert.ok(args.includes("/tmp/forked-session.jsonl"));
		assert.ok(!args.includes("--session-dir"), "--session-dir should not be emitted with --session");
		assert.ok(!args.includes("--no-session"), "--no-session should not be emitted with --session");
	});

	it("keeps fresh mode behavior (sessionDir + no session file)", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: true,
			sessionDir: "/tmp/subagent-sessions",
		});

		assert.ok(args.includes("--session-dir"));
		assert.ok(args.includes("/tmp/subagent-sessions"));
		assert.ok(!args.includes("--session"));
	});

	it("uses --model (not --models) so configured agent models override restored fork sessions", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: true,
			sessionFile: "/tmp/forked-session.jsonl",
			model: "github-copilot/gpt-5.5",
		});

		assert.equal(valueAfter(args, "--model"), "github-copilot/gpt-5.5");
		assert.ok(!args.includes("--models"), "--models only scopes cycling and should not be used to select subagent models");
	});

	it("preserves thinking suffix on forced model selection", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "anthropic/claude-opus-4-6",
			thinking: "high",
		});

		assert.equal(valueAfter(args, "--model"), "anthropic/claude-opus-4-6:high");
	});
});
