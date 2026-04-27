import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface MockPiResponse {
	output?: string;
	stderr?: string;
	exitCode?: number;
	delay?: number;
	keepAliveAfterFinalMessageMs?: number;
	jsonl?: unknown[];
	steps?: Array<{
		delay?: number;
		jsonl?: unknown[];
		stderr?: string;
	}>;
	echoEnv?: string[];
}

export interface MockPi {
	readonly dir: string;
	install(): void;
	uninstall(): void;
	onCall(response: MockPiResponse): void;
	reset(): void;
	callCount(): number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, "mock-pi-script.mjs");
const CALL_PREFIX = "call-";
const DEFAULT_RESPONSE_FILE = "default-response.json";
const QUEUED_PREFIX = "pending-";

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function writeExecutable(filePath: string, content: string): void {
	fs.writeFileSync(filePath, content, "utf-8");
	fs.chmodSync(filePath, 0o755);
}

function listQueueFiles(queueDir: string, prefix: string): string[] {
	try {
		return fs.readdirSync(queueDir)
			.filter((name) => name.startsWith(prefix))
			.sort();
	} catch {
		return [];
	}
}

export function createMockPi(): MockPi {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mock-cli-"));
	const queueDir = path.join(rootDir, "queue");
	const binDir = path.join(rootDir, "bin");
	ensureDir(queueDir);
	ensureDir(binDir);

	const shellScriptPath = path.join(binDir, "pi");
	const cmdScriptPath = path.join(binDir, "pi.cmd");
	writeExecutable(shellScriptPath, `#!/bin/sh\nexec "${process.execPath}" "${SCRIPT_PATH}" "$@"\n`);
	writeExecutable(cmdScriptPath, `@echo off\r\n"${process.execPath}" "${SCRIPT_PATH}" %*\r\n`);

	let installed = false;
	let nextSequence = 0;
	let originalPath: string | undefined;
	let originalArgv1: string | undefined;
	let originalQueueEnv: string | undefined;

	return {
		get dir() {
			return queueDir;
		},
		install() {
			if (installed) return;
			installed = true;
			originalPath = process.env.PATH;
			originalQueueEnv = process.env.MOCK_PI_QUEUE_DIR;
			process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
			process.env.MOCK_PI_QUEUE_DIR = queueDir;
			if (process.platform === "win32") {
				originalArgv1 = process.argv[1];
				process.argv[1] = SCRIPT_PATH;
			}
		},
		uninstall() {
			if (!installed) return;
			installed = false;
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalQueueEnv === undefined) delete process.env.MOCK_PI_QUEUE_DIR;
			else process.env.MOCK_PI_QUEUE_DIR = originalQueueEnv;
			if (process.platform === "win32") {
				if (originalArgv1 === undefined) delete process.argv[1];
				else process.argv[1] = originalArgv1;
			}
			try {
				fs.rmSync(rootDir, { recursive: true, force: true });
			} catch {}
		},
		onCall(response) {
			ensureDir(queueDir);
			nextSequence += 1;
			const fileName = `${QUEUED_PREFIX}${String(nextSequence).padStart(6, "0")}.json`;
			const tempPath = path.join(queueDir, `${fileName}.tmp-${process.pid}-${Date.now()}`);
			const finalPath = path.join(queueDir, fileName);
			fs.writeFileSync(tempPath, JSON.stringify(response), "utf-8");
			fs.renameSync(tempPath, finalPath);
			fs.writeFileSync(path.join(queueDir, DEFAULT_RESPONSE_FILE), JSON.stringify(response), "utf-8");
		},
		reset() {
			nextSequence = 0;
			ensureDir(queueDir);
			for (const entry of fs.readdirSync(queueDir)) {
				try {
					fs.rmSync(path.join(queueDir, entry), { recursive: true, force: true });
				} catch {}
			}
		},
		callCount() {
			return listQueueFiles(queueDir, CALL_PREFIX).length;
		},
	};
}
