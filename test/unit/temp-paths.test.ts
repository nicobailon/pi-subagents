import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
	ASYNC_DIR,
	CHAIN_RUNS_DIR,
	RESULTS_DIR,
	TEMP_ARTIFACTS_DIR,
	TEMP_ROOT_DIR,
	getAsyncConfigPath,
	resolveTempScopeId,
} from "../../src/shared/types.ts";

describe("resolveTempScopeId", () => {
	it("prefers uid when available", () => {
		const scope = resolveTempScopeId({
			getuid: () => 501,
			env: { USER: "alice" },
			userInfo: () => ({ username: "alice" }),
		});
		assert.equal(scope, "uid-501");
	});

	it("falls back to environment usernames when uid is unavailable", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: { USERNAME: "Alice Example" },
			userInfo: () => ({ username: "ignored" }),
		});
		assert.equal(scope, "user-Alice-Example");
	});

	it("falls back to os.userInfo when environment is missing", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: {},
			userInfo: () => ({ username: "svc_account" }),
		});
		assert.equal(scope, "user-svc_account");
	});

	it("falls back to home path when os.userInfo throws", () => {
		const scope = resolveTempScopeId({
			getuid: undefined,
			env: {},
			userInfo: () => {
				throw new Error("uv_os_get_passwd returned ENOENT");
			},
			homedir: () => "/home/12345/app user",
		});
		assert.equal(scope, "home-home-12345-app-user");
	});
});

describe("shared temp paths", () => {
	it("uses the explicit temp root before shared paths resolve", () => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-temp-override-"));
		const override = path.join(fixture, "async state");
		const isolatedHome = path.join(fixture, "home");
		try {
			const moduleUrl = new URL("../../src/shared/types.ts", import.meta.url).href;
			const script = `import { ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify({ ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR }));`;
			const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
				encoding: "utf-8",
				env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, PI_SUBAGENTS_TEMP_ROOT: override },
			});
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(JSON.parse(result.stdout.trim()), {
				ASYNC_DIR: path.join(override, "async-subagent-runs"),
				RESULTS_DIR: path.join(override, "async-subagent-results"),
				TEMP_ROOT_DIR: override,
			});
		} finally {
			fs.rmSync(fixture, { recursive: true, force: true });
		}
	});

	it("anchors shared temp directories under one scoped root", () => {
		assert.equal(path.dirname(RESULTS_DIR), TEMP_ROOT_DIR);
		assert.equal(path.dirname(ASYNC_DIR), TEMP_ROOT_DIR);
		assert.equal(path.dirname(CHAIN_RUNS_DIR), TEMP_ROOT_DIR);
		assert.equal(path.dirname(TEMP_ARTIFACTS_DIR), TEMP_ROOT_DIR);
		assert.match(path.basename(TEMP_ROOT_DIR), /^pi-subagents-/);
		assert.equal(path.basename(RESULTS_DIR), "async-subagent-results");
		assert.equal(path.basename(ASYNC_DIR), "async-subagent-runs");
		assert.equal(path.basename(CHAIN_RUNS_DIR), "chain-runs");
		assert.equal(path.basename(TEMP_ARTIFACTS_DIR), "artifacts");
	});

	it("writes async config files under the same scoped temp root", () => {
		assert.equal(path.dirname(getAsyncConfigPath("abc123")), TEMP_ROOT_DIR);
		assert.equal(path.basename(getAsyncConfigPath("abc123")), "async-cfg-abc123.json");
	});
});
