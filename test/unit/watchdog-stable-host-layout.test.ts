import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("watchdog modules link on the stable host surface without newer pi-ai exports", () => {
	const review = pathToFileURL(path.join(projectRoot, "src", "watchdog", "review.ts")).href;
	const arbiter = pathToFileURL(path.join(projectRoot, "src", "watchdog", "permission-arbiter.ts")).href;
	const loader = pathToFileURL(path.join(projectRoot, "test", "support", "watchdog-stable-host-loader.mjs")).href;
	const script = `
		const review = await import(${JSON.stringify(review)});
		const arbiter = await import(${JSON.stringify(arbiter)});
		if (typeof review.createMainWatchdogReview !== "function") throw new Error("review module did not load");
		if (typeof arbiter.createWatchdogPermissionArbiter !== "function") throw new Error("permission arbiter module did not load");
	`;

	execFileSync(process.execPath, ["--experimental-strip-types", "--loader", loader, "--input-type=module", "--eval", script], {
		cwd: projectRoot,
		stdio: "pipe",
	});
});
