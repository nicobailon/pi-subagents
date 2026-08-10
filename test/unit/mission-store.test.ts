import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { handleMissionAction } from "../../src/missions/actions.ts";
import {
	createMission,
	listGlobalMissions,
	listMissions,
	readMission,
	resolveMissionStoreLocation,
	updateMission,
} from "../../src/missions/store.ts";
import { createMissionWorkflowState, MISSION_STATE_MAX_BYTES, missionStatePath } from "../../src/missions/workflow-state.ts";

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-missions-"));
	const projectRoot = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(projectRoot, { recursive: true });
	const location = resolveMissionStoreLocation({ projectRoot, agentDir });
	return { root, projectRoot, agentDir, location };
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(filePath)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${filePath} after ${timeoutMs} ms`);
}

describe("mission store", () => {
	it("creates, reads, updates, lists, and globally indexes project missions", () => {
		const test = fixture();
		try {
			const created = createMission(test.location, {
				title: "Ship durable missions",
				objective: "Make delegated work resumable",
				labels: ["phase-1"],
			});
			const updated = updateMission(test.location, created.id, {
				status: "active",
				summary: "Implementation started",
				addRuns: [
					{ runId: "run-1", mode: "single", status: "running" },
					{ runId: "workflow-1", mode: "workflow", status: "completed" },
				],
				addArtifacts: [{ kind: "status", path: path.join(test.root, "status.json") }],
				addReceipts: [{ kind: "pull_request", status: "ready", title: "PR 733", url: "https://github.com/example/repo/pull/733" }],
				addDecisions: [{ title: "Choose release window", options: ["now", "later"] }],
			});

			assert.equal(readMission(test.location, created.id).status, "needs_decision");
			assert.equal(updated.runs[0]?.runId, "run-1");
			assert.equal(readMission(test.location, created.id).runs[1]?.mode, "workflow");
			assert.equal(updated.decisions[0]?.status, "open");
			assert.equal(updated.receipts[0]?.url, "https://github.com/example/repo/pull/733");
			const receiptUpdated = updateMission(test.location, created.id, {
				addReceipts: [{ kind: "pull_request", status: "succeeded", title: "PR 733", url: "https://github.com/example/repo/pull/733" }],
			});
			assert.equal(receiptUpdated.receipts[0]?.status, "succeeded");
			assert.equal(receiptUpdated.receipts[0]?.createdAt, updated.receipts[0]?.createdAt);
			assert.deepEqual(listMissions(test.location).records.map((record) => record.id), [created.id]);
			const global = listGlobalMissions(test.location.globalIndexDir);
			assert.equal(global.entries[0]?.missionId, created.id);
			assert.equal(global.entries[0]?.stale, false);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("persists workflow child attempts and projects their latest heartbeat", () => {
		const test = fixture();
		try {
			const mission = createMission(test.location, { title: "Dispatch ledger", objective: "Track workflow children", status: "active" });
			updateMission(test.location, mission.id, {
				upsertWorkflowChildren: [{
					workflowRunId: "workflow-1",
					key: "review",
					status: "running",
					agent: "reviewer",
					task: "Review the diff",
					phase: "review",
					sessionPath: "/tmp/review.jsonl",
					heartbeat: { status: "running", phase: "review" },
				}],
			}, new Date("2026-08-11T10:00:00.000Z"));
			const completed = updateMission(test.location, mission.id, {
				upsertWorkflowChildren: [{
					workflowRunId: "workflow-1",
					key: "review",
					status: "completed",
					runId: "child-1",
					completedAt: "2026-08-11T10:05:00.000Z",
					artifactPaths: ["/tmp/review.md"],
					heartbeat: { status: "completed", phase: "review" },
				}],
			}, new Date("2026-08-11T10:05:00.000Z"));

			assert.equal(completed.workflowChildren.length, 1);
			assert.deepEqual(completed.workflowChildren[0], {
				workflowRunId: "workflow-1",
				key: "review",
				status: "completed",
				startedAt: "2026-08-11T10:00:00.000Z",
				updatedAt: "2026-08-11T10:05:00.000Z",
				runId: "child-1",
				agent: "reviewer",
				task: "Review the diff",
				phase: "review",
				completedAt: "2026-08-11T10:05:00.000Z",
				sessionPath: "/tmp/review.jsonl",
				artifactPaths: ["/tmp/review.md"],
				heartbeat: { status: "completed", phase: "review", updatedAt: "2026-08-11T10:05:00.000Z" },
			});
			const shown = handleMissionAction("mission.show", { missionId: mission.id }, { cwd: test.projectRoot, agentDir: test.agentDir });
			assert.match(shown.content[0]?.type === "text" ? shown.content[0].text : "", /review \(child-1\): completed — reviewer \[review\]; updated .*; heartbeat completed\/review at/);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("gates a mission on open decisions and resolves them explicitly", () => {
		const test = fixture();
		try {
			const ctx = { cwd: test.projectRoot, agentDir: test.agentDir };
			const mission = createMission(test.location, { title: "Decision gate", objective: "Wait for owner", status: "active" });
			const pending = handleMissionAction("mission.update", {
				missionId: mission.id,
				missionUpdate: { decisions: [{ title: "Choose release window", options: ["now", "later"], recommendation: "later" }] },
			}, ctx);
			const decisionId = pending.details?.mission?.decisions[0]?.id;
			assert.ok(decisionId);
			assert.equal(pending.details?.mission?.status, "needs_decision");
			assert.match(handleMissionAction("mission.list", {}, ctx).content[0]?.type === "text" ? handleMissionAction("mission.list", {}, ctx).content[0].text : "", /decisions: 1 open, 0 resolved/);

			const refreshed = updateMission(test.location, mission.id, {
				status: "active",
				addRuns: [{ runId: "run-1", mode: "single", status: "running" }],
			});
			assert.equal(refreshed.status, "needs_decision");

			const resolved = handleMissionAction("mission.resolve-decision", { missionId: mission.id, id: decisionId, summary: "Release later" }, ctx);
			assert.equal(resolved.details?.mission?.status, "active");
			assert.equal(resolved.details?.mission?.decisions[0]?.status, "resolved");
			assert.equal(resolved.details?.mission?.decisions[0]?.resolution, "Release later");
			assert.match(resolved.content[0]?.type === "text" ? resolved.content[0].text : "", /resolved — Choose release window; resolution: Release later/);
			assert.throws(() => handleMissionAction("mission.resolve-decision", { missionId: mission.id, id: decisionId, summary: "Again" }, ctx), /already resolved/);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("keeps planned and waiting missions in their lifecycle state while decisions are resolved", () => {
		const test = fixture();
		try {
			for (const status of ["planned", "waiting"] as const) {
				const mission = createMission(test.location, { title: `${status} decision`, objective: "Keep state", status });
				const pending = updateMission(test.location, mission.id, { addDecisions: [{ title: "Choose next step" }] });
				const decisionId = pending.decisions[0]?.id;
				assert.ok(decisionId);
				assert.equal(pending.status, status);

				const resolved = updateMission(test.location, mission.id, { resolveDecision: { id: decisionId, resolution: "Later" } });
				assert.equal(resolved.status, status);
				assert.equal(resolved.decisions[0]?.status, "resolved");
			}
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("persists bounded workflow state and reads its file once per workflow", () => {
		const test = fixture();
		try {
			const mission = createMission(test.location, { title: "Stateful mission", objective: "Keep workflow state" });
			const state = createMissionWorkflowState(test.location, mission.id);
			assert.equal(state.get("missing"), undefined);
			fs.mkdirSync(path.dirname(state.path), { recursive: true });
			fs.writeFileSync(state.path, JSON.stringify({ external: true }), "utf-8");
			assert.equal(state.get("external"), undefined);

			const nextWorkflow = createMissionWorkflowState(test.location, mission.id);
			assert.equal(nextWorkflow.get("external"), true);
			nextWorkflow.set("review.stage", { count: 2 });
			const concurrentWorkflow = createMissionWorkflowState(test.location, mission.id);
			assert.deepEqual(concurrentWorkflow.get("review.stage"), { count: 2 });
			nextWorkflow.set("approved", false);
			concurrentWorkflow.set("reviewer", "ready");
			assert.deepEqual(JSON.parse(fs.readFileSync(missionStatePath(test.location, mission.id), "utf-8")), {
				external: true,
				"review.stage": { count: 2 },
				approved: false,
				reviewer: "ready",
			});
			assert.throws(() => nextWorkflow.set("bad key", true), /state key must be 1-128 characters/);
			assert.throws(() => nextWorkflow.set("too-large", "x".repeat(MISSION_STATE_MAX_BYTES)), /256 KiB limit/);
			assert.equal(nextWorkflow.get("too-large"), undefined);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("serializes workflow state writes behind the state-file lock", async () => {
		const test = fixture();
		try {
			const mission = createMission(test.location, { title: "Locked state", objective: "Serialize state writes" });
			const statePath = missionStatePath(test.location, mission.id);
			fs.mkdirSync(path.dirname(statePath), { recursive: true });
			fs.writeFileSync(statePath, JSON.stringify({ external: true }, null, 2), "utf-8");
			const lockPath = `${statePath}.lock`;
			const readyPath = path.join(test.root, "writer-ready");
			fs.mkdirSync(lockPath);
			const script = `
				import * as fs from "node:fs";
				import { createMissionWorkflowState } from "./src/missions/workflow-state.ts";
				const location = JSON.parse(process.env.MISSION_LOCATION);
				fs.writeFileSync(process.env.READY_FILE, "ready", "utf-8");
				createMissionWorkflowState(location, process.env.MISSION_ID).set("reviewer", "ready");
			`;
			const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
				cwd: process.cwd(),
				env: { ...process.env, MISSION_LOCATION: JSON.stringify(test.location), MISSION_ID: mission.id, READY_FILE: readyPath },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
			await waitForFile(readyPath);
			fs.writeFileSync(statePath, JSON.stringify({ external: true, approved: false }, null, 2), "utf-8");
			fs.rmSync(lockPath, { recursive: true, force: true });
			const exit = await Promise.race([
				new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal }))),
				new Promise<{ code: "timeout"; signal: null }>((resolve) => setTimeout(() => { child.kill(); resolve({ code: "timeout", signal: null }); }, 5_000)),
			]);
			assert.deepEqual(exit, { code: 0, signal: null }, stderr);
			assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf-8")), {
				external: true,
				approved: false,
				reviewer: "ready",
			});
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("recovers abandoned workflow state locks", () => {
		const test = fixture();
		try {
			const mission = createMission(test.location, { title: "Stale lock", objective: "Recover state writes" });
			const state = createMissionWorkflowState(test.location, mission.id);
			const lockPath = `${state.path}.lock`;
			fs.mkdirSync(lockPath, { recursive: true });
			const staleAt = new Date(Date.now() - 120_000);
			fs.utimesSync(lockPath, staleAt, staleAt);

			state.set("reviewer", "ready");

			assert.equal(fs.existsSync(lockPath), false);
			assert.deepEqual(JSON.parse(fs.readFileSync(state.path, "utf-8")), { reviewer: "ready" });
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("recovers abandoned workflow state locks even when the owner pid was reused", () => {
		const test = fixture();
		try {
			const mission = createMission(test.location, { title: "Reused pid", objective: "Recover by lock age" });
			const state = createMissionWorkflowState(test.location, mission.id);
			const lockPath = `${state.path}.lock`;
			fs.mkdirSync(lockPath, { recursive: true });
			fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token: "abandoned", createdAt: Date.now(), processKey: "stale-process" }), "utf-8");

			state.set("reviewer", "ready");

			assert.equal(fs.existsSync(lockPath), false);
			assert.deepEqual(JSON.parse(fs.readFileSync(state.path, "utf-8")), { reviewer: "ready" });
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("serializes competing abandoned-lock recovery", async () => {
		const test = fixture();
		try {
			const mission = createMission(test.location, { title: "Competing stale lock", objective: "Recover once" });
			const statePath = missionStatePath(test.location, mission.id);
			fs.mkdirSync(path.dirname(statePath), { recursive: true });
			fs.writeFileSync(statePath, JSON.stringify({ external: true }, null, 2), "utf-8");
			const lockPath = `${statePath}.lock`;
			fs.mkdirSync(lockPath, { recursive: true });
			const staleAt = new Date(Date.now() - 120_000);
			fs.utimesSync(lockPath, staleAt, staleAt);
			const script = `
				import { createMissionWorkflowState } from "./src/missions/workflow-state.ts";
				const location = JSON.parse(process.env.MISSION_LOCATION);
				createMissionWorkflowState(location, process.env.MISSION_ID).set(process.env.STATE_KEY, process.env.STATE_VALUE);
			`;
			const spawnWriter = (key: string, value: string) => {
				let stderr = "";
				const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
					cwd: process.cwd(),
					env: { ...process.env, MISSION_LOCATION: JSON.stringify(test.location), MISSION_ID: mission.id, STATE_KEY: key, STATE_VALUE: value },
					stdio: ["ignore", "pipe", "pipe"],
				});
				child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
				return new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(() => { child.kill(); reject(new Error(`${key} writer timed out`)); }, 5_000);
					child.on("exit", (code, signal) => {
						clearTimeout(timeout);
						if (code === 0 && signal === null) resolve();
						else reject(new Error(`${key} writer failed with code ${code} signal ${signal}: ${stderr}`));
					});
				});
			};

			await Promise.all([spawnWriter("reviewer", "ready"), spawnWriter("approved", "false")]);

			assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf-8")), {
				external: true,
				reviewer: "ready",
				approved: "false",
			});
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("loads older records that do not have receipts or objective", () => {
		const test = fixture();
		try {
			const created = createMission(test.location, { title: "Older record", objective: "Stay readable" });
			const recordPath = path.join(test.location.missionDir, `${created.id}.json`);
			const raw = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as Record<string, unknown>;
			delete raw.receipts;
			delete raw.objective;
			raw.goal = "Stay readable";
			fs.writeFileSync(recordPath, JSON.stringify(raw), "utf-8");

			const mission = readMission(test.location, created.id);
			assert.equal(mission.objective, "Stay readable");
			assert.equal(mission.goal, undefined);
			assert.deepEqual(mission.receipts, []);
			assert.deepEqual(mission.workflowChildren, []);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("skips corrupt records, removes missing pointers, and preserves parse-error pointers", () => {
		const test = fixture();
		try {
			const missing = createMission(test.location, { title: "Missing record", objective: "Heal its pointer" });
			const corrupt = createMission(test.location, { title: "Corrupt record", objective: "Keep evidence" });
			fs.writeFileSync(path.join(test.location.missionDir, "broken.json"), "{not json", "utf-8");
			assert.equal(listMissions(test.location).warnings.length, 1);

			fs.rmSync(path.join(test.location.missionDir, `${missing.id}.json`));
			fs.writeFileSync(path.join(test.location.missionDir, `${corrupt.id}.json`), "{not json", "utf-8");
			const global = listGlobalMissions(test.location.globalIndexDir);
			assert.equal(global.entries.length, 1);
			assert.equal(global.entries[0]?.missionId, corrupt.id);
			assert.equal(global.entries[0]?.stale, true);
			assert.match(global.warnings.join("\n"), /Removed stale global mission pointer/);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("prunes only the oldest terminal missions at the configured bound", () => {
		const test = fixture();
		const location = { ...test.location, retainTerminal: 1 };
		try {
			const oldest = createMission(location, { title: "Old terminal", objective: "Prune me" }, new Date("2026-01-01T00:00:00Z"));
			const newest = createMission(location, { title: "New terminal", objective: "Keep me" }, new Date("2026-01-02T00:00:00Z"));
			const active = createMission(location, { title: "Active", objective: "Never prune", status: "active" }, new Date("2026-01-03T00:00:00Z"));
			const planned = createMission(location, { title: "Planned", objective: "Never prune", status: "planned" }, new Date("2026-01-04T00:00:00Z"));
			updateMission(location, oldest.id, { status: "completed" }, new Date("2026-01-05T00:00:00Z"));
			updateMission(location, newest.id, { status: "failed" }, new Date("2026-01-06T00:00:00Z"));

			assert.throws(() => readMission(location, oldest.id), /was not found/);
			assert.equal(readMission(location, newest.id).status, "failed");
			assert.equal(readMission(location, active.id).status, "active");
			assert.equal(readMission(location, planned.id).status, "planned");
			assert.equal(listGlobalMissions(location.globalIndexDir).entries.some((entry) => entry.missionId === oldest.id), false);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("shows missions with warnings when linked run status is unreadable", () => {
		const test = fixture();
		try {
			const ctx = { cwd: test.projectRoot, agentDir: test.agentDir, currentSessionId: "session-1" };
			const created = handleMissionAction("mission.create", { mission: { title: "Unreadable status", objective: "Keep mission readable" } }, ctx);
			const missionId = created.details?.missionId;
			assert.ok(missionId);
			const asyncDir = path.join(test.root, "async-run");
			fs.mkdirSync(asyncDir, { recursive: true });
			handleMissionAction("mission.attach-run", { missionId, runId: "run-3", runMode: "single", runStatus: "running", dir: asyncDir }, ctx);
			fs.writeFileSync(path.join(asyncDir, "status.json"), "{not json", "utf-8");

			const shown = handleMissionAction("mission.show", { missionId }, ctx);

			assert.equal(shown.details?.mission?.runs[0]?.status, "running");
			assert.match(shown.content[0]?.type === "text" ? shown.content[0].text : "", /Warning: Failed to read linked run status/);
			assert.equal(shown.details?.missions?.warnings?.length, 1);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});

	it("supports the mission management actions with structured details", () => {
		const test = fixture();
		try {
			const ctx = { cwd: test.projectRoot, agentDir: test.agentDir, currentSessionId: "session-1" };
			const created = handleMissionAction("mission.create", { mission: { title: "Action mission", objective: "Exercise actions" } }, ctx);
			const missionId = created.details?.missionId;
			assert.ok(missionId);
			const asyncDir = path.join(test.root, "async-run");
			fs.mkdirSync(asyncDir, { recursive: true });
			const attached = handleMissionAction("mission.attach-run", { missionId, runId: "run-2", runMode: "parallel", runStatus: "running", dir: asyncDir }, ctx);
			assert.equal(attached.details?.mission?.runs[0]?.runId, "run-2");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "complete" }), "utf-8");
			const shown = handleMissionAction("mission.show", { missionId }, ctx);
			assert.equal(shown.details?.mission?.status, "completed");
			assert.match(shown.content[0]?.type === "text" ? shown.content[0].text : "", new RegExp(`State: .*${missionId}[/\\\\]state\\.json`));
			assert.equal(shown.details?.mission?.runs[0]?.status, "complete");
			const receipt = handleMissionAction("mission.update", {
				missionId,
				missionUpdate: {
					receipts: [{ kind: "ci", status: "succeeded", title: "Unit tests", url: "https://github.com/example/repo/actions/runs/1", description: "All checks passed" }],
				},
			}, ctx);
			assert.equal(receipt.details?.mission?.receipts[0]?.status, "succeeded");
			assert.match(receipt.content[0]?.type === "text" ? receipt.content[0].text : "", /Delivery receipts:\n  ci \(succeeded\): Unit tests/);
			const updatedReceipt = handleMissionAction("mission.update", {
				missionId,
				missionUpdate: { receipts: [{ kind: "ci", status: "ready", title: "Unit tests", url: "https://github.com/example/repo/actions/runs/1" }] },
			}, ctx);
			assert.equal(updatedReceipt.details?.mission?.receipts.length, 1);
			assert.equal(updatedReceipt.details?.mission?.receipts[0]?.status, "ready");
			const closed = handleMissionAction("mission.close", { missionId, missionStatus: "completed", summary: "Done" }, ctx);
			assert.equal(closed.details?.mission?.status, "completed");
			const global = handleMissionAction("mission.list", { missionScope: "global" }, ctx);
			assert.equal(global.details?.missions?.globalEntries?.length, 1);
			assert.throws(() => handleMissionAction("mission.list", { missionScope: "everywhere" as "global" }, ctx), /missionScope/);
			assert.throws(() => handleMissionAction("mission.update", { missionId, missionUpdate: { unsupported: true } as never }, ctx), /unknown/);
			assert.throws(() => handleMissionAction("mission.update", { missionId, missionUpdate: { receipts: [{ kind: "ci", status: "ready", title: "Bad URL", url: "relative" }] } as never }, ctx), /absolute URL/);
		} finally {
			fs.rmSync(test.root, { recursive: true, force: true });
		}
	});
});
