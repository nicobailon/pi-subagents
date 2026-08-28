import { createRequire, syncBuiltinESMExports } from "node:module";

const INSTALL_MARK = Symbol.for("pi-subagents.test.windows-hide-child-processes");
const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");

export function withWindowsHide(args, optionsIndex) {
	const next = [...args];
	const current = next[optionsIndex];
	if (current === undefined || typeof current === "function") {
		next.splice(optionsIndex, 0, { windowsHide: true });
	} else if (current && typeof current === "object" && !Array.isArray(current)) {
		next[optionsIndex] = { ...current, windowsHide: true };
	} else {
		next[optionsIndex] = { windowsHide: true };
	}
	return next;
}

function optionsAfterOptionalArgs(args) {
	return Array.isArray(args[1]) ? 2 : 1;
}

export function installWindowsHiddenChildProcesses(platform = process.platform) {
	if (platform !== "win32" || childProcess[INSTALL_MARK] === true) return false;
	const optionIndexes = {
		spawn: optionsAfterOptionalArgs,
		spawnSync: optionsAfterOptionalArgs,
		execFile: optionsAfterOptionalArgs,
		execFileSync: optionsAfterOptionalArgs,
		fork: optionsAfterOptionalArgs,
		exec: () => 1,
		execSync: () => 1,
	};
	for (const [name, indexFor] of Object.entries(optionIndexes)) {
		const original = childProcess[name];
		childProcess[name] = function (...args) {
			return Reflect.apply(original, this, withWindowsHide(args, indexFor(args)));
		};
	}
	childProcess[INSTALL_MARK] = true;
	syncBuiltinESMExports();
	return true;
}

installWindowsHiddenChildProcesses();
