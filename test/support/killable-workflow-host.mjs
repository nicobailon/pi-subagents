// A separate Pi-like owner process for an async workflow, so a test can SIGKILL it mid-run.
// It installs the scripted child sessions itself and shares the test's MOCK_PI_QUEUE_DIR, so its
// foreground children and its background runners replay the queue the test scripts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { setChildSessionFactory, setChildSessionFactoryModule } from "../../src/runs/shared/child-session.ts";
import { createFakeChildSessions } from "./fake-child-session.ts";
import { createEventBus, makeAgent, makeMinimalCtx } from "./helpers.ts";

const [cwd, sessionId, paramsJson, output] = process.argv.slice(2);
if (!process.env.MOCK_PI_QUEUE_DIR) throw new Error("killable-workflow-host needs MOCK_PI_QUEUE_DIR");
setChildSessionFactory(createFakeChildSessions(() => process.env.MOCK_PI_QUEUE_DIR).factory);
setChildSessionFactoryModule(path.join(path.dirname(fileURLToPath(import.meta.url)), "runner-child-session-factory.ts"));

const agents = [makeAgent("echo"), makeAgent("bg", { defaultAsync: true })];
const state = { baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
const executor = createSubagentExecutor({
	pi: { events: createEventBus(), getSessionName: () => undefined, sendMessage: () => {} },
	state,
	config: {},
	asyncByDefault: false,
	tempArtifactsDir: cwd,
	getSubagentSessionRoot: () => path.join(cwd, "sessions"),
	expandTilde: (value) => value,
	discoverAgents: () => ({ agents }),
});
const ctx = makeMinimalCtx(cwd);
ctx.sessionManager.getSessionId = () => sessionId;
// Through the public tool entry, as Pi launches it, so the run saves its launch and can be resumed.
const launched = await executor.executePublic("killable-workflow", JSON.parse(paramsJson), new AbortController().signal, undefined, ctx);
fs.writeFileSync(output, JSON.stringify({ isError: launched.isError === true, text: launched.content[0]?.text, runId: launched.details?.asyncId }));
// Stay alive as the workflow's owner until the test kills this process.
setInterval(() => {}, 60_000);
