// One side of a two-process settings race. "first" pauses inside its save until "second"
// tries to take the settings lease (or the test releases it); "second" retries a lease timeout.
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const [project, target, barriers, role, operation] = process.argv.slice(2);
const wait = (...files) => {
	const deadline = Date.now() + 10_000;
	while (!files.some((file) => fs.existsSync(file))) {
		if (Date.now() > deadline) throw new Error(`Barrier ${files.join(" or ")} expired`);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
	}
};
const writeFileSync = fs.writeFileSync;
const mkdirSync = fs.mkdirSync;
let paused = false;
// Agent overrides save through a temp file beside the target; Profile and Watchdog write the target directly.
const name = path.basename(target);
const isSave = (file) => typeof file === "string" && (path.basename(file) === name || path.basename(file).startsWith(`.${name}.`));
fs.writeFileSync = function (file, ...args) {
	if (role === "first" && !paused && isSave(file)) {
		paused = true;
		process.send({ type: "paused" });
		// The marker is a synchronous file, so release does not depend on IPC delivery.
		wait(path.join(barriers, "release"), path.join(barriers, "second.attempted"));
	}
	return writeFileSync.call(fs, file, ...args);
};
let attempted = false;
fs.mkdirSync = function (dir, ...args) {
	// Compare names: the lease resolves the directory natively, which can differ in form on Windows.
	if (role === "second" && !attempted && path.basename(String(dir)) === `${name}.write-lock`) {
		attempted = true;
		writeFileSync.call(fs, path.join(barriers, "second.attempted"), "");
		process.send({ type: "lock-attempt" });
	}
	return mkdirSync.call(fs, dir, ...args);
};
syncBuiltinESMExports();
const agents = await import("../../src/agents/agents.ts");
const watchdog = await import("../../src/watchdog/settings.ts");
const profiles = await import("../../src/profiles/profiles.ts");
process.send({ type: "ready" });
wait(path.join(barriers, `${role}.start`));
const run = () => {
	if (operation === "save") agents.saveBuiltinAgentOverride(project, role, "project", { disabled: true });
	else if (operation === "watchdog") watchdog.writeUserWatchdogEnabled(true);
	else if (operation === "profile") profiles.applySubagentProfile("race");
	else throw new Error(`Unknown operation ${operation}`);
};
// A slow runner can outlast the 200 ms lease wait; retrying still proves the second save waited.
for (let attempt = 1; ; attempt++) {
	try { run(); break; }
	catch (error) { if (attempt >= 20 || !/Timed out waiting for another process/.test(String(error))) throw error; }
}
process.disconnect();
