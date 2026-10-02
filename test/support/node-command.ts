import * as fs from "node:fs";
import * as path from "node:path";

/** Writes `<name>.cmd` exactly as npm's cmd-shim does for a `#!/usr/bin/env node` bin at `target` (relative, backslashes). */
export function writeNpmNodeShim(directory: string, name: string, target: string): string {
	const commandPath = path.join(directory, `${name}.cmd`);
	fs.writeFileSync(commandPath, [
		"@ECHO off",
		"GOTO start",
		":find_dp0",
		"SET dp0=%~dp0",
		"EXIT /b",
		":start",
		"SETLOCAL",
		"CALL :find_dp0",
		"",
		'IF EXIST "%dp0%\\node.exe" (',
		'  SET "_prog=%dp0%\\node.exe"',
		") ELSE (",
		'  SET "_prog=node"',
		"  SET PATHEXT=%PATHEXT:;.JS;=;%",
		")",
		"",
		`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
		"",
	].join("\r\n"), { encoding: "utf-8", mode: 0o755 });
	return commandPath;
}

export function writeNodeCommand(directory: string, name: string, source: string): string {
	if (process.platform === "win32") {
		fs.writeFileSync(path.join(directory, `${name}.cjs`), source, "utf-8");
		return writeNpmNodeShim(directory, name, `${name}.cjs`);
	}
	const commandPath = path.join(directory, name);
	fs.writeFileSync(commandPath, `#!/usr/bin/env node\n${source}\n`, { encoding: "utf-8", mode: 0o755 });
	return commandPath;
}
