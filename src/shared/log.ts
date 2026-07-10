import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LOAD_LOG_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "load.log");

function appendLog(prefix: string, message: string): void {
	const line = `${new Date().toISOString()} [${prefix}] ${message}`;
	try {
		fs.mkdirSync(path.dirname(LOAD_LOG_PATH), { recursive: true });
		fs.appendFileSync(LOAD_LOG_PATH, `${line}\n`);
	} catch {
		// Best effort logging.
	}
}

export function traceLoad(message: string): void {
	appendLog("load", message);
}

export function traceRuntime(message: string): void {
	appendLog("runtime", message);
}
