import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { DIRS, type Details, type SubagentState } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { updateActiveRunIndex } from "../background/active-run-index.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";

export function dismissRecoveredWorkflow(
	state: SubagentState,
	location: { asyncDir: string | null; resolvedId?: string },
): AgentToolResult<Details> {
	const asyncDir = location.asyncDir;
	const runId = location.resolvedId ?? (asyncDir ? path.basename(asyncDir) : "requested");
	if (!asyncDir) {
		return {
			content: [{ type: "text", text: `Recovered workflow '${runId}' has no disk status to dismiss.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const status = readStatus(asyncDir);
	if (!status || status.mode !== "workflow") {
		return {
			content: [{ type: "text", text: `Run '${runId}' is not a recovered workflow.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (!state.currentSessionId || status.sessionId !== state.currentSessionId) {
		return {
			content: [{ type: "text", text: `Recovered workflow '${runId}' was not found in the active session.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (state.workflowControllers?.has(status.runId) || state.workflowControllers?.has(runId)) {
		return {
			content: [{ type: "text", text: `Workflow '${runId}' still has a live controller and cannot be dismissed.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (status.state !== "running") {
		return {
			content: [{ type: "text", text: `Recovered workflow '${runId}' is ${status.state}, not running.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	let latestStatus = status;
	const resultPath = path.join(DIRS.results, `${status.runId}.json`);
	if (fs.existsSync(resultPath)) {
		const reconciled = reconcileAsyncRun(asyncDir).status;
		if (reconciled && reconciled.state !== "running") {
			return {
				content: [{ type: "text", text: `Recovered workflow '${runId}' is ${reconciled.state}, not running.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		if (reconciled) latestStatus = reconciled;
	}

	const dismissed = { ...latestStatus, displayDismissedAt: Date.now() };
	writeAtomicJson(path.join(asyncDir, "status.json"), dismissed);
	const repaired = reconcileAsyncRun(asyncDir).status;
	if (repaired && repaired.state !== "running") {
		return {
			content: [{ type: "text", text: `Recovered workflow '${runId}' is ${repaired.state}, not running.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	updateActiveRunIndex(asyncDir, "complete");
	state.asyncJobs.delete(status.runId);
	state.asyncJobs.delete(runId);
	state.fleetJobs?.delete(status.runId);
	state.fleetJobs?.delete(runId);
	return {
		content: [{ type: "text", text: `Dismissed recovered workflow ${status.runId} from the display. No running work was terminated.` }],
		details: { mode: "management", results: [] },
	};
}
