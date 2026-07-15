import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface MockPiResponse {
	output?: string;
	stderr?: string;
	exitCode?: number;
	delay?: number;
	waitForPath?: string;
	keepAliveAfterFinalMessageMs?: number;
	ignoreSigterm?: boolean;
	jsonl?: unknown[];
	stdoutRaw?: string;
	stdoutBase64Chunks?: string[];
	steps?: Array<{
		delay?: number;
		jsonl?: unknown[];
		stdoutRaw?: string;
		stdoutBase64Chunks?: string[];
		stderr?: string;
	}>;
	echoEnv?: string[];
	matchArgIncludes?: string | string[];
	/** Files the mock child writes to disk before emitting output, standing in for its write-tool side effects. */
	writeFiles?: Array<{ path: string; content: string }>;
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
	const piPackageDir = path.join(rootDir, "pi-package");
	const cliScriptPath = path.join(piPackageDir, "dist", "cli.mjs");
	ensureDir(queueDir);
	ensureDir(binDir);
	ensureDir(path.dirname(cliScriptPath));
	fs.copyFileSync(SCRIPT_PATH, cliScriptPath);
	fs.writeFileSync(
		path.join(piPackageDir, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
		"utf-8",
	);

	const shellScriptPath = path.join(binDir, "pi");
	const cmdScriptPath = path.join(binDir, "pi.cmd");
	writeExecutable(shellScriptPath, `#!/bin/sh\nexec "${process.execPath}" "${cliScriptPath}" "$@"\n`);
	writeExecutable(cmdScriptPath, `@echo off\r\n"${process.execPath}" "${cliScriptPath}" %*\r\n`);

	let installed = false;
	let nextSequence = 0;
	let originalPath: string | undefined;
	let originalPiBinary: string | undefined;
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
			originalPiBinary = process.env.PI_SUBAGENT_PI_BINARY;
			originalQueueEnv = process.env.MOCK_PI_QUEUE_DIR;
			process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
			if (process.platform === "win32") {
				delete process.env.PI_SUBAGENT_PI_BINARY;
				originalArgv1 = process.argv[1];
				process.argv[1] = cliScriptPath;
			} else {
				process.env.PI_SUBAGENT_PI_BINARY = shellScriptPath;
			}
			process.env.MOCK_PI_QUEUE_DIR = queueDir;
		},
		uninstall() {
			if (!installed) return;
			installed = false;
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalPiBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
			else process.env.PI_SUBAGENT_PI_BINARY = originalPiBinary;
			if (process.platform === "win32") {
				if (originalArgv1 === undefined) delete process.argv[1];
				else process.argv[1] = originalArgv1;
			}
			if (originalQueueEnv === undefined) delete process.env.MOCK_PI_QUEUE_DIR;
			else process.env.MOCK_PI_QUEUE_DIR = originalQueueEnv;
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
