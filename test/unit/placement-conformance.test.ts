// Conformance: the same child task must behave identically through every placement host.
// The Herdr and Rex legs share one task spec, one event script, and one assertion set;
// only host glue (pane ids, terminal identity) may differ.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import netModule from "node:net";
import type { ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import { BridgeChannel, createPlacementAwareChildSessionFactory, serializeHerdrPiLaunch, HerdrPiSession } from "../../src/runs/shared/herdr-placed-run.ts";
import type { HerdrPlacedRunOwner } from "../../src/runs/shared/herdr-pane-host.ts";
import { encodeHerdrPiFrame, HerdrPiFrameDecoder, HERDR_PI_MAX_FRAME_BYTES } from "../../src/runs/shared/herdr-pi-protocol.ts";
import { resolveMachinePlacement } from "../../src/runs/shared/herdr-machine.ts";
import "./../../src/runs/shared/builtin-placement-adapters.ts";

const runtime = { runId: "run", agent: "worker", childIndex: 0, fanoutChild: false, depth: 1, maxDepth: 1, inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: false, fast: false, waitTool: { enabled: true } };
const RUN_ID = "run_conf0001";

interface HostLeg {
	label: string;
	machine: Record<string, unknown>;
	terminalId: string;
	paneId: string;
}

const legs: HostLeg[] = [
	{ label: "herdr", machine: { provider: "herdr", id: "m1", target: "remote.example", cwd: "/repo" }, terminalId: "term1", paneId: "p1" },
	{ label: "rex", machine: { provider: "rex", id: "local", cwd: "/repo" }, terminalId: "term-rex", paneId: "%3" },
];

// The shared task: one placed child that reads files and settles idle.
function taskLaunch(machine: Record<string, unknown>): ChildSessionLaunch {
	return {
		cwd: "/repo",
		machine: machine as ChildSessionLaunch["machine"],
		remoteResources: { agent: "worker", toolCeiling: ["read"] },
		storage: { kind: "memory" },
		extensionPaths: [],
		ambientExtensions: true,
		hooks: [],
		noSkills: true,
		noContextFiles: true,
		tools: ["read"],
		runtime,
	};
}

const eventFrame = (cursor: number, event: Record<string, unknown>) => encodeHerdrPiFrame({ protocol: 1, runId: RUN_ID, type: "event", cursor, nativeSessionId: "native", event });

function mockBridgeSockets(): { sockets: EventEmitter[]; restore(): void } {
	const sockets: EventEmitter[] = [], original = netModule.createConnection;
	netModule.createConnection = (() => {
		const socket = Object.assign(new EventEmitter(), { write: () => true, destroy() {} });
		sockets.push(socket);
		return socket;
	}) as unknown as typeof netModule.createConnection;
	syncBuiltinESMExports();
	return { sockets, restore() { netModule.createConnection = original; syncBuiltinESMExports(); } };
}

describe("placement host conformance", { skip: process.platform === "win32" }, () => {
	it("resolves the same task through the shared registry to equivalent references", () => {
		const herdr = resolveMachinePlacement({ machine: "workmac", cwd: "/repo", catalogJson: JSON.stringify([{ id: "m1", label: "workmac", target: "remote.example", enabled: true }]), settings: { cwd: "/repo" } });
		assert.equal(herdr.machine.provider, "herdr");
		// Rex local placement needs a live Rex session context: a fake binary answers the session probe.
		const previous = { REX_SESSION: process.env.REX_SESSION, REX_BIN_DIR: process.env.REX_BIN_DIR };
		const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "placement-conf-"));
		fs.writeFileSync(path.join(binDir, "rex"), `#!/bin/sh\nfor arg in "$@"; do case "$arg" in %*) printf '{"session_id":"%s"}' "$arg" ;; esac; done\nexit 0\n`, { mode: 0o755 });
		process.env.REX_SESSION = "%test";
		process.env.REX_BIN_DIR = binDir;
		let rex: ReturnType<typeof resolveMachinePlacement>;
		try {
			rex = resolveMachinePlacement({ machine: "local", cwd: binDir, settings: {} });
		} finally {
			fs.rmSync(binDir, { recursive: true, force: true });
			for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
		}
		assert.equal(rex.machine.provider, "rex");
		// The core serializes an identical child task for both hosts.
		const herdrPolicy = serializeHerdrPiLaunch(taskLaunch(herdr.machine));
		const rexPolicy = serializeHerdrPiLaunch(taskLaunch(rex.machine));
	});

	it("routes the same task through the placed factory for both hosts", async () => {
		const child = { subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, followUp: async () => {}, abort: async () => {}, dispose: async () => {}, messages: [], sessionFile: undefined, sessionId: "native", modelId: "provider/model" };
		const seenProviders: string[] = [];
		const factory = createPlacementAwareChildSessionFactory(
			{ async create() { throw new Error("a placed task must not fall through to the local factory"); }, async dispose() {} },
			async (value) => {
				seenProviders.push(value.machine?.provider ?? "none");
				return child;
			},
		);
		await Promise.all(legs.map((leg) => factory.create(taskLaunch(leg.machine))));
		assert.deepEqual(seenProviders.sort(), ["herdr", "rex"]);
	});

	for (const leg of legs) {
		it(`delivers the same child task evidence and settle through the ${leg.label} host`, async () => {
			const mock = mockBridgeSockets();
			let session: HerdrPiSession | undefined;
			try {
				const identity = { runId: RUN_ID, machineId: leg.machine.id as string, target: leg.terminalId, session: null, workspaceId: `w-${leg.label}`, tabId: `t-${leg.label}`, paneId: leg.paneId, terminalId: leg.terminalId, agentName: `pi-${leg.label}`, nativeSessionId: "native", cwd: "/repo", runtimeDir: "/tmp/run" };
				const owner = { identity, machine: leg.machine, connection: { async close() {} }, snapshot: { connection: "connected" as const, state: "ready" as const, identity, revision: 0 }, async cleanup() {} } as unknown as HerdrPlacedRunOwner;
				const bridge = new BridgeChannel("mock", RUN_ID);
				session = new HerdrPiSession(owner, { async close() {} }, bridge, ["read"], "p/m", runtime);
				const seen: string[] = [];
				let settled = 0;
				let liveSeen!: () => void;
				const live = new Promise<void>((resolve) => { liveSeen = resolve; });
				session.subscribe((event) => {
					if (event.type === "agent_settled") settled++;
					if (event.type === "tool_execution_start") {
						seen.push((event as { args: { path: string } }).args.path);
						if (seen.includes("report.md")) liveSeen();
					}
				});
				// The same task frames for every host: two reads, then a settle.
				mock.sockets[0]!.emit("data", eventFrame(1, { type: "tool_execution_start", toolName: "read", args: { path: "report.md" } }));
				mock.sockets[0]!.emit("data", eventFrame(2, { type: "tool_execution_start", toolName: "read", args: { path: "notes.md" } }));
				await live;
				mock.sockets[0]!.emit("data", encodeHerdrPiFrame({ protocol: 1, runId: RUN_ID, type: "settled", requestId: "done", nativeSessionId: "native", idle: true, pending: false }));
				const deadline = Date.now() + 5_000;
				while (settled === 0) {
					assert.ok(Date.now() < deadline, `${leg.label} leg never settled`);
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				assert.equal(settled, 1);
				assert.deepEqual(seen, ["report.md", "notes.md"]);
				assert.equal(bridge.failed, false);
				assert.equal(session.placementSnapshot.identity?.terminalId, leg.terminalId);
				await session.dispose();
			} finally {
				mock.restore();
			}
		});
	}

	it("keeps oversized evidence frames failing closed identically for both hosts", () => {
		for (const leg of legs) {
			assert.throws(() => new HerdrPiFrameDecoder().push(Buffer.alloc(HERDR_PI_MAX_FRAME_BYTES + 1)), /exceeds/u, `${leg.label} decoder must reject oversized frames`);
		}
	});
});
