import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const configuredTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
const tempRoot = configuredTempRoot
	? path.resolve(configuredTempRoot)
	: fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-test-root-"));
fs.mkdirSync(tempRoot, { recursive: true });
if (process.platform === "darwin") fs.closeSync(fs.openSync(path.join(tempRoot, ".metadata_never_index"), "a"));
process.env.PI_SUBAGENTS_TEMP_ROOT = tempRoot;
process.env.TMPDIR = tempRoot;
process.env.TMP = tempRoot;
process.env.TEMP = tempRoot;

const loaderState = process.env.PI_SUBAGENTS_TEST_LOADER;
const nestedTestProcess = loaderState !== undefined;
const testFileProcess = process.env.NODE_TEST_CONTEXT !== undefined && loaderState !== "test-file";
if (!nestedTestProcess || testFileProcess) process.env.PI_SUBAGENTS_TEST_PARENT_PID = String(process.pid);
const isolatedHome = path.join(tempRoot, "home");
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
if (!nestedTestProcess) delete process.env.PI_CODING_AGENT_DIR;
process.env.PI_SUBAGENTS_TEST_LOADER = testFileProcess ? "test-file" : "loaded";

if (!configuredTempRoot) {
	process.on("exit", () => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
}
