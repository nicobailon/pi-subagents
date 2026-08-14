import * as fs from "node:fs";
import * as path from "node:path";

export function writeNodeCommand(directory: string, name: string, source: string): string {
	if (process.platform === "win32") {
		const scriptPath = path.join(directory, `${name}.cjs`);
		const commandPath = path.join(directory, `${name}.cmd`);
		fs.writeFileSync(scriptPath, source, "utf-8");
		fs.writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf-8");
		return commandPath;
	}
	const commandPath = path.join(directory, name);
	fs.writeFileSync(commandPath, `#!/usr/bin/env node\n${source}\n`, { encoding: "utf-8", mode: 0o755 });
	return commandPath;
}
