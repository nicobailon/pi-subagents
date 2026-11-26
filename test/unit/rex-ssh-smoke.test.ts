import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import { remoteShellCommand } from "../../src/runs/shared/herdr-connection.ts";
import { createPlacementAwareChildSessionFactory, HerdrPiSession } from "../../src/runs/shared/herdr-placed-run.ts";
import { REX_BUNDLE_BIN } from "../../src/runs/shared/rex-machine.ts";
import { closeOwnedRexPane, connectRex, REX_SSH_SESSION_LABEL } from "../../src/runs/shared/rex-pane-host.ts";
import type { RexSshMachineReference } from "../../src/shared/types.ts";

// Live check against a real Mac over SSH: PI_SUBAGENTS_REX_SSH_SMOKE=<ssh target> (Rex running there, Pi and this pi-subagents
// version installed there). It opens tabs only in that Mac's `subagents` session and removes the temp directory it makes there.
const target = process.env.PI_SUBAGENTS_REX_SSH_SMOKE;
const log = (line: string) => process.stdout.write(`[rex-ssh-smoke] ${line}\n`);
const ssh = (script: string, args: string[] = []) => spawnSync("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target!, remoteShellCommand(script, args)], { encoding: "utf8", timeout: 30_000 });
const remoteRex = (args: string[]) => ssh(`exec "$HOME/${REX_BUNDLE_BIN}" --autostart=false "$@"`, args);

describe("Rex SSH placement against a real Mac and a real Pi", { skip: !target ? "set PI_SUBAGENTS_REX_SSH_SMOKE=<ssh target>" : process.platform === "win32" ? "Rex placement is POSIX-only" : false }, () => {
	it("opens a background Pi tab in the remote subagents session, completes a prompt round trip, and cleans up only what it owns", { timeout: 240_000 }, async () => {
		const made = ssh(`umask 077; d=$(mktemp -d /tmp/rex-ssh-smoke.XXXXXX) && mkdir -p "$d/.pi/agents" && printf '%s\\n' '---' 'name: rex-smoke' 'description: Rex placement smoke agent' 'tools: read' '---' 'You answer in one short line.' > "$d/.pi/agents/rex-smoke.md" && cd -P "$d" && pwd -P`);
		assert.equal(made.status, 0, made.stderr);
		const project = made.stdout.trim();
		const sessionsBefore = remoteRex(["ls", "--json"]).stdout;
		log(`remote project ${project}; sessions before ${sessionsBefore.replace(/\s+/gu, " ")}`);
		const machine: RexSshMachineReference = { provider: "rex", id: "smokemac", target: target!, cwd: project };
		const model = process.env.PI_SUBAGENTS_REX_SMOKE_MODEL ?? "opencode-go/glm-5.3-flash";
		const launch: ChildSessionLaunch = { cwd: project, machine, remoteResources: { agent: "rex-smoke" }, storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: true, hooks: [], noSkills: true, noContextFiles: true, tools: ["read"], model, runtime: { runId: "rexsshsmoke", agent: "rex-smoke", childIndex: 0, fanoutChild: false, depth: 1, maxDepth: 1, inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: false, fast: false } };
		const factory = createPlacementAwareChildSessionFactory({ create: async () => { throw new Error("the local factory must not run for a Rex SSH machine"); }, dispose: async () => {} });
		try {
			const started = Date.now();
			const child = await factory.create(launch);
			assert.ok(child instanceof HerdrPiSession);
			const identity = child.identity, session = identity.workspaceId;
			log(`bridge ready+configured in ${Date.now() - started}ms: session ${session}, window ${identity.tabId}, block ${identity.paneId}, tools ${JSON.stringify(child.requestedTools)}, model ${child.model}`);
			const listed: { sessions: Array<{ session_id: string; label?: string }> } = JSON.parse(remoteRex(["ls", "--json"]).stdout);
			assert.deepEqual(listed.sessions.filter((entry) => entry.label === REX_SSH_SESSION_LABEL).map((entry) => entry.session_id), [session]);
			const inspected: { active_window_id: string; windows: Array<{ window_id: string; label: string }> } = JSON.parse(remoteRex(["session", "inspect", session, "--json"]).stdout);
			log(`tab label ${inspected.windows.find((window) => window.window_id === identity.tabId)?.label}; active window is another tab: ${inspected.active_window_id !== identity.tabId}`);
			assert.equal(identity.cwd, project);

			const promptStarted = Date.now();
			await child.prompt("Reply with exactly the word rex-ssh-ok and nothing else.");
			const assistant = child.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
			const text = assistant?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
			log(`prompt round trip in ${Date.now() - promptStarted}ms; assistant said ${JSON.stringify(text)} (stop ${assistant?.stopReason})`);
			assert.match(text, /rex-ssh-ok/u);

			const forwardDir = path.dirname((child.bridgeForward as { socketPath: string }).socketPath);
			await child.abort();
			await child.dispose();
			const aborted = remoteRex(["block", "inspect", "-s", session, identity.paneId]), runtime = ssh('test -e "$1"', [identity.runtimeDir]);
			log(`after abort + dispose: block inspect exit ${aborted.status}; remote runtime dir test exit ${runtime.status}; local forward dir exists ${fs.existsSync(forwardDir)}`);
			assert.equal(aborted.status, 3);
			assert.equal(runtime.status, 1);
			assert.equal(fs.existsSync(forwardDir), false);

			// A finished (not aborted) child keeps its tab, like a Herdr pane; only the runtime directory goes.
			const finished = await factory.create({ ...launch, runtime: { ...launch.runtime, runId: "rexsshsmoke2" } });
			assert.ok(finished instanceof HerdrPiSession);
			const kept = finished.identity;
			assert.equal(kept.workspaceId, session);
			await finished.dispose();
			const keptInspect = remoteRex(["block", "inspect", "-s", session, kept.paneId]);
			log(`finished child after dispose: same session ${kept.workspaceId === session}; block inspect exit ${keptInspect.status}; remote runtime dir test exit ${ssh('test -e "$1"', [kept.runtimeDir]).status}`);
			assert.equal(keptInspect.status, 0);
			const connection = await connectRex(machine, { session });
			await closeOwnedRexPane(connection, { workspaceId: session, tabId: kept.tabId, paneId: kept.paneId });
			await connection.close();
			assert.equal(remoteRex(["block", "inspect", "-s", session, kept.paneId]).status, 3);
		} finally {
			await factory.dispose();
			// The remote Pi keeps its session files in its agent dir, under a folder named for the temp project; remove that folder.
			const removed = ssh('d="$HOME/.pi/agent/sessions/$1"; case "$1" in --*-tmp-rex-ssh-smoke.*--) test -d "$d" && rm -rf -- "$d" && echo "$d";; *) exit 64;; esac', [`--${project.slice(1).replaceAll("/", "-")}--`]);
			log(`removed remote Pi session folder: ${removed.stdout.trim() || "none"}`);
			assert.equal(ssh('case "$1" in /tmp/rex-ssh-smoke.*|/private/tmp/rex-ssh-smoke.*) rm -rf -- "$1";; *) exit 64;; esac', [project]).status, 0);
		}
	});
});
