import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const [project, requestedTarget, barriers, role, operation, scope = "project", readOnlyParent = "false"] = process.argv.slice(2);
const target = path.join(fs.realpathSync.native(path.dirname(requestedTarget)), path.basename(requestedTarget));
const wait = (file) => {
	const deadline = Date.now() + 10_000;
	while (!fs.existsSync(file)) {
		if (Date.now() > deadline) throw new Error("Settings test barrier expired");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
	}
};
const { settingsFileLockPath } = await import("../../src/shared/settings-file.ts");
const lockPath = settingsFileLockPath(target);
const originalWrite = fs.writeFileSync;
const originalMkdir = fs.mkdirSync;
const originalAccess = fs.accessSync;
if (readOnlyParent === "true") fs.accessSync = function (file, accessMode) {
	if (file === path.dirname(target) && accessMode === fs.constants.W_OK) throw Object.assign(new Error("read-only settings directory"), { code: "EACCES" });
	return originalAccess.call(fs, file, accessMode);
};
let paused = false;
let attempted = false;
fs.writeFileSync = function (file, ...args) {
	if (role === "first" && !paused && typeof file === "string"
		&& (file === target || (path.dirname(file) === path.dirname(target) && path.basename(file).startsWith(`.${path.basename(target)}.`)))) {
		paused = true;
		process.send?.({ type: "paused" });
		wait(path.join(barriers, "release"));
	}
	return originalWrite.call(fs, file, ...args);
};
fs.mkdirSync = function (file, ...args) {
	if (role === "second" && !attempted && file === lockPath) {
		attempted = true;
		process.send?.({ type: "lock-attempt" });
	}
	return originalMkdir.call(fs, file, ...args);
};
syncBuiltinESMExports();
const agents = await import("../../src/agents/agents.ts");
const watchdog = await import("../../src/watchdog/settings.ts");
const profiles = await import("../../src/profiles/profiles.ts");
process.send?.({ type: "ready" });
wait(path.join(barriers, `${role}.start`));
switch (operation) {
	case "save": agents.saveBuiltinAgentOverride(project, role, scope, { disabled: true }); break;
	case "merge": agents.mergeBuiltinAgentOverride(project, "reviewer", scope, role === "first" ? { model: "example/model" } : { thinking: "high" }); break;
	case "remove": agents.removeBuiltinAgentOverride(project, "first", scope); break;
	case "remove-field": agents.removeBuiltinAgentOverrideFields(project, "reviewer", scope, ["disabled"]); break;
	case "watchdog": watchdog.writeUserWatchdogEnabled(true); break;
	case "profile": profiles.applySubagentProfile("race"); break;
	default: throw new Error(`Unknown test operation: ${operation}`);
}
process.send?.({ type: "result" });
process.disconnect?.();
