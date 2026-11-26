import * as fs from "node:fs";
import * as path from "node:path";

function isNodeExecutableName(execPath: string): boolean {
	const basename = path.basename(execPath).toLowerCase();
	return basename === "node" || basename === "node.exe" || basename === "nodejs" || basename === "nodejs.exe";
}

function canUseNodeExecutable(execPath: string): boolean {
	try {
		fs.accessSync(execPath, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function resolveNodeExecutable(execPath = process.execPath): string {
	if (isNodeExecutableName(execPath) && canUseNodeExecutable(execPath)) return execPath;
	return process.platform === "win32" ? "node.exe" : "node";
}

export function resolveLiveNodeExecutable(execPath = process.execPath, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (canUseNodeExecutable(execPath)) return execPath;
	const name = process.platform === "win32" ? "node.exe" : "node";
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (!path.isAbsolute(dir)) continue;
		const candidate = path.join(dir, name);
		if (canUseNodeExecutable(candidate)) return candidate;
	}
	return undefined;
}
