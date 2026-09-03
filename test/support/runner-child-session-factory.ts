/**
 * Scripted `ChildSessionFactory` for the detached async runner under test.
 *
 * The runner is a separate Node process, so it cannot share the parent's
 * in-memory fake. `createMockPi().install()` names this module in the runner
 * config; the runner imports it and replays the responses queued in the
 * directory `MOCK_PI_QUEUE_DIR` points at.
 */
import { createFakeChildSessions } from "./fake-child-session.ts";

export default function createRunnerChildSessionFactory() {
	return createFakeChildSessions(() => {
		const dir = process.env.MOCK_PI_QUEUE_DIR;
		if (!dir) throw new Error("MOCK_PI_QUEUE_DIR is required for the scripted runner child session factory.");
		return dir;
	}).factory;
}
