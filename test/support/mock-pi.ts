/**
 * Scripted child sessions for tests.
 *
 * `install()` replaces the process-wide foreground `ChildSessionFactory` with
 * a scripted one and names the runner-side scripted factory module for
 * background launches. Both replay the responses queued with `onCall()` from
 * one directory, so a test scripts a child the same way whichever launch path
 * it exercises.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setChildSessionFactory, setChildSessionFactoryModule } from "../../src/runs/shared/child-session.ts";
import { createFakeChildSessions, type FakeChildResponse, type FakeChildSessionRecord } from "./fake-child-session.ts";

export type MockPiResponse = FakeChildResponse;

export interface MockPi {
	readonly dir: string;
	/** In-process foreground child sessions created since the last reset, in launch order. */
	readonly sessions: FakeChildSessionRecord[];
	/** Number of times the foreground child session factory was disposed. */
	readonly disposeCalls: number;
	install(): void;
	uninstall(): void;
	onCall(response: MockPiResponse): void;
	reset(): void;
	callCount(): number;
}

const RUNNER_FACTORY_MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), "runner-child-session-factory.ts");
const CALL_PREFIX = "call-";
const DEFAULT_RESPONSE_FILE = "default-response.json";
const QUEUED_PREFIX = "pending-";

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
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
	let queueGeneration = 0;
	let queueDir = path.join(rootDir, `queue-${queueGeneration}`);
	ensureDir(queueDir);

	const fakeSessions = createFakeChildSessions(() => queueDir);
	let installed = false;
	let nextSequence = 0;
	let originalQueueEnv: string | undefined;

	return {
		get dir() {
			return queueDir;
		},
		get sessions() {
			return fakeSessions.sessions;
		},
		get disposeCalls() {
			return fakeSessions.disposeCalls;
		},
		install() {
			if (installed) return;
			installed = true;
			setChildSessionFactory(fakeSessions.factory);
			setChildSessionFactoryModule(RUNNER_FACTORY_MODULE);
			originalQueueEnv = process.env.MOCK_PI_QUEUE_DIR;
			process.env.MOCK_PI_QUEUE_DIR = queueDir;
		},
		uninstall() {
			if (!installed) return;
			installed = false;
			setChildSessionFactory(undefined);
			setChildSessionFactoryModule(undefined);
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
			fakeSessions.reset();
			queueGeneration += 1;
			queueDir = path.join(rootDir, `queue-${queueGeneration}`);
			ensureDir(queueDir);
			if (installed) process.env.MOCK_PI_QUEUE_DIR = queueDir;
		},
		callCount() {
			return listQueueFiles(queueDir, CALL_PREFIX).length;
		},
	};
}
