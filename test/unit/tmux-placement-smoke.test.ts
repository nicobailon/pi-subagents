// Real tmux round-trip, gated behind PI_SUBAGENTS_TMUX_SMOKE=1 like the Rex smoke.
// Spawns a real Pi child inside a real (isolated-socket) tmux server through the
// tmux placement adapter, completes the bridge handshake, then closes the pane.
// The child runs this worktree's Pi through a wrapper (like the Rex smoke), so the
// bridge extension version always matches the core under test.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import { createPlacementAwareChildSessionFactory } from "../../src/runs/shared/herdr-placed-run.ts";
import { registerPlacementAdapter } from "../../src/runs/shared/placement-registry.ts";
// The adapter is hosted OUTSIDE this repo (pi-subagents-tmux-placement, a sibling checkout)
// and imports only pi-subagents/placement — the standalone-hosting proof the author asked for.
import { tmuxPlacementAdapter } from "../../../pi-subagents-tmux-placement/src/index.ts";

const smoke = process.env.PI_SUBAGENTS_TMUX_SMOKE === "1";
const worktree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function findPi(): string | undefined { const found = spawnSync("/bin/sh", ["-c", "command -v pi"], { encoding: "utf8" }); return found.status === 0 && found.stdout.trim() ? found.stdout.trim() : undefined; }
const piBin = smoke ? findPi() : undefined;
// The test loader isolates HOME, so the placed child would boot without the operator's models or auth.
// Point the isolated home's .pi at the real one, like the Rex smoke points its server at the real home.
const realHome = os.userInfo().homedir;
const skip = !smoke ? "set PI_SUBAGENTS_TMUX_SMOKE=1" : process.platform === "win32" ? "tmux placement is POSIX-only" : !piBin ? "pi is not on PATH" : false;
const runtime = { runId: "run", agent: "worker", childIndex: 0, fanoutChild: false, depth: 1, maxDepth: 1, inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: false, fast: false, waitTool: { enabled: true } };
const log = (line: string) => process.stdout.write(`[tmux-smoke] ${line}\n`);

describe("tmux placement smoke", { skip }, () => {
	it("round-trips a real placed child through the tmux host", { timeout: 180_000 }, async () => {
		// A third-party adapter joins through the registry, exactly like a real package would.
		registerPlacementAdapter(tmuxPlacementAdapter());
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-smoke-"));
		const sock = path.join(root, "tmux.sock");
		const listWindows = () => spawnSync("tmux", ["-S", sock, "list-panes", "-a", "-F", "#{window_name}|#{pane_id}|#{pane_dead}"], { encoding: "utf8" }).stdout ?? "";
		const waitFor = async (condition: () => boolean, message: string, timeoutMs = 10_000) => {
			for (let elapsed = 0; elapsed < timeoutMs; elapsed += 100) {
				if (condition()) return elapsed;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.fail(`${message}; panes=${JSON.stringify(listWindows())}`);
		};
		// Start the private tmux server with the operator's real home, like the Rex smoke starts its
		// private server: the placed child inherits the server env, so it sees the operator's models.
		// The test loader scrubs PATH, so re-add the running node's directory: the pi binary is a
		// "#!/usr/bin/env node" script and the pane inherits the server's PATH.
		const serverEnv = { ...process.env, HOME: realHome, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` };
		const server = spawnSync("tmux", ["-S", sock, "new-session", "-d", "-s", "pi-subagents", "-n", "housekeeping", "-c", realHome], { encoding: "utf8", env: serverEnv });
		assert.equal(server.status, 0, server.stderr);
		// The child needs the agent it is asked to run, in the project it starts in.
		const project = fs.realpathSync(fs.mkdtempSync(path.join(root, "project-")));
		fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(project, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: tmux smoke agent\ntools: read\n---\nYou answer in one short line.\n");
		const machine = { provider: "tmux" as const, id: "local", session: "pi-subagents", socket: sock, cwd: project, localDisk: true };
		const wrapper = path.join(root, "pi"), sessions = path.join(root, "sessions");
		// The pane PATH is the multiplexer client's PATH (tmux hands new panes the creating client's
		// environment), so the wrapper invokes node by absolute path instead of a shebang lookup. The
		// child keeps the pane pty as stdout: pi drops to print mode and exits when stdout is a file.
		// -ne matches the Rex smoke: extensions stay off so the child is isolated. Models must
		// therefore use auth that survives `-n` (env keys, e.g. zhipu) — provider auth registered
		// by ambient extensions (google/openai on some boxes) does NOT resolve without them.
		fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(piBin!)} -ne -e ${JSON.stringify(path.join(worktree, "index.ts"))} --session-dir ${JSON.stringify(sessions)} "$@"\n`, { mode: 0o755 });
		process.env.PI_SUBAGENT_PI_BINARY = wrapper;
		// Any model the operator's Pi is logged in to; override with PI_SUBAGENTS_TMUX_SMOKE_MODEL.
		const model = process.env.PI_SUBAGENTS_TMUX_SMOKE_MODEL ?? "opencode-go/glm-5.3-flash";
		const launch: ChildSessionLaunch = { cwd: project, machine, model, remoteResources: { agent: "worker", toolCeiling: ["read"] }, storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: true, hooks: [], noSkills: true, noContextFiles: true, tools: ["read"], runtime };
		const previousPiBinary = process.env.PI_SUBAGENT_PI_BINARY;
		try {
			const factory = createPlacementAwareChildSessionFactory(
				{ async create() { throw new Error("a placed tmux task must not use the local factory"); }, async dispose() {} },
			);
			// The factory resolves the machine through the registry, opens a real tmux window,
			// spawns a real Pi child (exec'd so the pane pid is the agent), and completes the
			// bridge handshake (ready frame, protocol/version/cwd checks, configure ack).
			const started = Date.now();
			// Pi boot under a loaded desktop session can exceed the manifest discovery window, so one
			// fresh retry (new run id, new window) keeps the smoke deterministic without core changes.
			let session;
			try {
				session = await factory.create(launch);
			} catch (error) {
				if (!/did not start the pi-subagents bridge/u.test(error instanceof Error ? error.message : String(error))) throw error;
				log("bridge manifest window missed; retrying with a fresh run id");
				session = await factory.create(launch);
			}
			assert.ok(session, "the placed child session must exist");
			log(`bridge ready+configured in ${Date.now() - started}ms: pane ${session.identity?.paneId}, native session ${session.identity?.nativeSessionId}`);
			const events: string[] = [];
			session.subscribe((event) => { events.push(event.type); if (event.type !== "message_end") log(`event ${event.type}`); });
			// One real prompt round trip through the pane: the parent sends the bridge command, the
			// child answers in its own session, and the settled event carries the final message.
			const promptStarted = Date.now();
			const promptPromise = session.prompt("Reply with exactly tmux-ok and nothing else.");
			const watchdog = setInterval(() => {
				const paneId = session.identity?.paneId;
				const cap = paneId ? spawnSync("tmux", ["-S", sock, "capture-pane", "-p", "-t", paneId], { encoding: "utf8" }).stdout ?? "" : "(no pane)";
				log(`prompt pending; pane tail: ${cap.split("\n").filter((line) => line.trim()).slice(-4).join(" | ").slice(0, 260)}`);
			}, 30_000);
			try { await promptPromise; } finally { clearInterval(watchdog); }
			assert.ok(events.includes("agent_settled"), `the placed child must settle the prompt; events=${JSON.stringify(events)}`);
			const asParts = (message: unknown): Array<{ type?: string; text?: string }> | string => {
				const content = (message as { content?: unknown }).content;
				if (typeof content === "string") return content;
				return Array.isArray(content) ? content as Array<{ type?: string; text?: string }> : [];
			};
			const asText = (message: unknown) => {
				const parts = asParts(message);
				return typeof parts === "string" ? parts : parts.filter((part) => part.type === "text").map((part) => part.text).join(" ");
			};
			log(`events=${JSON.stringify(events)} messages=${session.messages.length} roundTripMs=${Date.now() - promptStarted}`);
			const assistantText = session.messages.filter((message) => (message as { role?: string }).role === "assistant").map((message) => asText(message)).join(" ");
			assert.match(assistantText, /tmux-ok/u, `assistant reply must confirm the round trip; got ${JSON.stringify(assistantText.slice(0, 200))}`);
			log(`prompt round trip in ${Date.now() - promptStarted}ms; assistant said ${JSON.stringify(assistantText.trim().slice(0, 60))}`);

			// Abort + dispose must close the pane; a finished (not aborted) child keeps its pane, like a
			// Herdr pane and a Rex block, so both lifecycles are proven against the same host.
			await session.abort();
			await session.dispose();
			const gone = await waitFor(() => !listWindows().includes("subagent-"), "the aborted child's tmux window must be closed after dispose");
			log(`aborted child closed after ${gone}ms`);

			// Pi boot under a loaded desktop session can exceed the manifest discovery window, so one
			// fresh retry (new run id, new window) keeps the second child deterministic too.
			const finished = await (async () => {
				try {
					return await factory.create(launch);
				} catch (error) {
					if (!/did not start the pi-subagents bridge/u.test(error instanceof Error ? error.message : String(error))) throw error;
					log("bridge manifest window missed; retrying with a fresh run id");
					return factory.create(launch);
				}
			})();
			const keptPane = finished.identity?.paneId;
			await finished.dispose();
			const stillThere = await waitFor(() => listWindows().includes("subagent-"), "the finished child's tmux window must stay after a plain dispose", 3000);
			assert.match(listWindows(), new RegExp(`${keptPane!.replace("%", "%")}[^\\n]*0`, "u"), "the finished child's pane must stay alive (not dead) after dispose");
			log(`finished child kept its pane ${keptPane} after dispose (${stillThere}ms)`);
		} catch (error) {
			// Surface the pane's last screen before the temp root disappears: the smoke only fails when
			// the placed Pi failed to start or failed the handshake, and the pane shows why.
			const pane = spawnSync("tmux", ["-S", sock, "capture-pane", "-p", "-t", "pi-subagents"], { encoding: "utf8" });
			const screen = (pane.stdout ?? "").split("\n").filter((line) => line.trim()).slice(-8).join("\n").trim() || "(pane already gone)";
			assert.fail(`${error instanceof Error ? error.message : error}\n--- pane screen ---\n${screen}`);
		} finally {
			if (previousPiBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY; else process.env.PI_SUBAGENT_PI_BINARY = previousPiBinary;
			spawnSync("tmux", ["-S", sock, "kill-server"], { stdio: "ignore" });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
