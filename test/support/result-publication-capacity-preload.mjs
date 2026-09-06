// Child-runner-only fault injection. Barriers are filesystem events, not elapsed waits.
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const root = process.env.RESULT_PUBLICATION_TEST_ROOT;
if (root) {
	const write = fs.writeFileSync;
	const rename = fs.renameSync;
	let resultAttempts = 0;
	let runningWritten = false;
	let statusDeferred = false;
	let asyncDir;
	let failedRecovery = false;
	const barrier = (name, data) => {
		write(path.join(root, `${name}.tmp`), JSON.stringify(data));
		rename(path.join(root, `${name}.tmp`), path.join(root, name));
	};
	const full = () => Object.assign(new Error("injected result publication capacity failure"), { code: "ENOSPC" });
	fs.writeFileSync = function (file, data, ...args) {
		const target = String(file);
		if (path.basename(target).startsWith(".status.json.") && typeof data === "string") {
			const status = JSON.parse(data);
			asyncDir = path.dirname(target);
			if (runningWritten && resultAttempts === 0) {
				statusDeferred = true;
				throw full();
			}
			if (status.state === "running") runningWritten = true;
		}
		if (target.includes(`${path.sep}result-pending${path.sep}`) && target.endsWith(".tmp")) {
			resultAttempts++;
			if (!fs.existsSync(path.join(root, "release"))) {
				if (resultAttempts >= 2) {
					const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
					barrier("blocked.json", {
						state: status.state, statusDeferred,
						active: fs.existsSync(path.join(path.dirname(asyncDir), ".active-runs", path.basename(asyncDir))),
					});
				}
				throw full();
			}
			if (!failedRecovery && fs.existsSync(path.join(root, "fail-on-recovery"))) {
				failedRecovery = true;
				throw Object.assign(new Error("injected non-capacity publication failure"), { code: "EIO" });
			}
		}
		return write.call(this, file, data, ...args);
	};
	fs.renameSync = function (source, target) {
		const result = rename.call(this, source, target);
		if (path.basename(String(target)) === "steer-inbox-closed.json") {
			// A request queued just before inbox closure is consumed during finalization.
			const dir = path.join(path.dirname(String(target)), "steer-requests");
			fs.mkdirSync(dir, { recursive: true });
			write(path.join(dir, "publication-steer.json"), JSON.stringify({ type: "steer", id: "publication-steer", ts: 1, message: "Late queued request", targetIndex: 0 }));
		}
		if (path.basename(String(target)) === "status.json") {
			const status = JSON.parse(fs.readFileSync(target, "utf8"));
			if (status.state === "complete" || status.state === "failed") barrier("terminal.json", status);
		}
		return result;
	};
	syncBuiltinESMExports();
}
