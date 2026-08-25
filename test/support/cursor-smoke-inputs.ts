import * as fs from "node:fs";
import * as path from "node:path";

export interface CursorSmokeInputs {
	workspace: string;
	stateRoot: string;
	canaryPath: string;
	promptDirectory: string;
}

function existingDirectory(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`${name} is required.`);
	try {
		const resolved = fs.realpathSync(path.resolve(value));
		if (!fs.statSync(resolved).isDirectory()) throw new Error(`${name} must point to an existing directory.`);
		return resolved;
	} catch (error) {
		if (error instanceof Error && error.message === `${name} must point to an existing directory.`) throw error;
		throw new Error(`${name} must point to an existing directory.`, { cause: error });
	}
}

function pathWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function cursorSmokeInputs(env: NodeJS.ProcessEnv): CursorSmokeInputs {
	if (env.PI_SUBAGENTS_CURSOR_SMOKE_DISPOSABLE !== "1") {
		throw new Error("PI_SUBAGENTS_CURSOR_SMOKE_DISPOSABLE=1 is required to attest that the operator-managed workspace is disposable.");
	}
	const workspace = existingDirectory(env.PI_SUBAGENTS_CURSOR_SMOKE_WORKSPACE, "PI_SUBAGENTS_CURSOR_SMOKE_WORKSPACE");
	const stateRoot = existingDirectory(env.PI_SUBAGENTS_CURSOR_SMOKE_STATE_ROOT, "PI_SUBAGENTS_CURSOR_SMOKE_STATE_ROOT");
	if (pathWithin(workspace, stateRoot) || pathWithin(stateRoot, workspace)) {
		throw new Error("Cursor smoke workspace and state root must be separate directories so the production --add-dir launch shape is exercised.");
	}
	const canaryPath = path.join(workspace, "pi-subagents-cursor-write-canary.txt");
	const promptDirectory = path.join(stateRoot, "external-0.cursor-prompt");
	if (fs.existsSync(canaryPath)) throw new Error(`Cursor smoke canary path must not exist before launch: ${canaryPath}`);
	if (fs.existsSync(promptDirectory)) throw new Error(`Cursor smoke prompt directory must not exist before launch: ${promptDirectory}`);
	return { workspace, stateRoot, canaryPath, promptDirectory };
}
