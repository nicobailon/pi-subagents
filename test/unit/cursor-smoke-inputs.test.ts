import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { cursorSmokeInputs } from "../support/cursor-smoke-inputs.ts";

function roots(): { root: string; workspace: string; stateRoot: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cursor-smoke-inputs-"));
	const workspace = path.join(root, "workspace");
	const stateRoot = path.join(root, "state");
	fs.mkdirSync(workspace);
	fs.mkdirSync(stateRoot);
	return { root, workspace, stateRoot };
}

function env(workspace: string, stateRoot: string): NodeJS.ProcessEnv {
	return {
		PI_SUBAGENTS_CURSOR_SMOKE_DISPOSABLE: "1",
		PI_SUBAGENTS_CURSOR_SMOKE_WORKSPACE: workspace,
		PI_SUBAGENTS_CURSOR_SMOKE_STATE_ROOT: stateRoot,
	};
}

test("resolves existing disposable Cursor smoke roots", () => {
	const input = roots();
	try {
		const workspace = fs.realpathSync(input.workspace);
		const stateRoot = fs.realpathSync(input.stateRoot);
		assert.deepEqual(cursorSmokeInputs(env(input.workspace, input.stateRoot)), {
			workspace,
			stateRoot,
			canaryPath: path.join(workspace, "pi-subagents-cursor-write-canary.txt"),
			promptDirectory: path.join(stateRoot, "external-0.cursor-prompt"),
		});
	} finally {
		fs.rmSync(input.root, { recursive: true, force: true });
	}
});

test("requires disposable attestation and separate existing roots", () => {
	const input = roots();
	try {
		assert.throws(() => cursorSmokeInputs({ ...env(input.workspace, input.stateRoot), PI_SUBAGENTS_CURSOR_SMOKE_DISPOSABLE: undefined }), /DISPOSABLE=1 is required/);
		assert.throws(() => cursorSmokeInputs(env(input.workspace, path.join(input.workspace, "missing"))), /STATE_ROOT must point to an existing directory/);
		assert.throws(() => cursorSmokeInputs(env(input.workspace, input.workspace)), /must be separate directories/);
	} finally {
		fs.rmSync(input.root, { recursive: true, force: true });
	}
});

test("refuses pre-existing harness-owned Cursor smoke paths", () => {
	const input = roots();
	try {
		const values = env(input.workspace, input.stateRoot);
		fs.writeFileSync(path.join(input.workspace, "pi-subagents-cursor-write-canary.txt"), "existing");
		assert.throws(() => cursorSmokeInputs(values), /canary path must not exist/);
		fs.rmSync(path.join(input.workspace, "pi-subagents-cursor-write-canary.txt"));
		fs.mkdirSync(path.join(input.stateRoot, "external-0.cursor-prompt"));
		assert.throws(() => cursorSmokeInputs(values), /prompt directory must not exist/);
	} finally {
		fs.rmSync(input.root, { recursive: true, force: true });
	}
});
