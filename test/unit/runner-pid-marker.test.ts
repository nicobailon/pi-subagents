import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SUBAGENT_RUNNER_PID_ENV } from "../../src/runs/shared/child-runtime-config.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("async runner pid marker", () => {
	it("records the runner's own pid when the runner module loads", () => {
		const script = String.raw`
			await import("./src/runs/background/subagent-runner.ts");
			console.log(JSON.stringify({ pid: process.pid, marker: process.env.${SUBAGENT_RUNNER_PID_ENV} }));
		`;
		const output = execFileSync(
			process.execPath,
			["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script],
			{ cwd: projectRoot, env: { ...process.env, [SUBAGENT_RUNNER_PID_ENV]: "1" }, encoding: "utf-8", timeout: 60_000 },
		);
		const result = JSON.parse(output.trim().split("\n").at(-1)!) as { pid: number; marker?: string };

		assert.equal(result.marker, String(result.pid));
	});
});
