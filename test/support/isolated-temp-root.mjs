import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

if (!process.env.PI_SUBAGENTS_TEMP_ROOT) {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-root-"));
	process.env.PI_SUBAGENTS_TEMP_ROOT = tempRoot;
	process.on("exit", () => fs.rmSync(tempRoot, { recursive: true, force: true }));
}
