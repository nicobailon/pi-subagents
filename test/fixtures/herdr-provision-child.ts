import * as fs from "node:fs";
import { provisionHerdrPane } from "../../src/runs/shared/herdr-placed-run.ts";

const [statePath, encodedKey, runId] = process.argv.slice(2);
const key = Buffer.from(encodedKey!, "base64url").toString("utf8");
const client = {
	async call(method: string) {
		const state = JSON.parse(fs.readFileSync(statePath!, "utf8")) as { workspaces: Record<string, unknown>[]; panes: Record<string, unknown>[] };
		if (method === "session.snapshot") return { type: "session_snapshot", snapshot: state };
		if (method === "tab.create") { const paneId = `child-${process.pid}`; state.panes.push({ workspace_id: "w", pane_id: paneId, cwd: "/remote/repo" }); fs.writeFileSync(statePath!, JSON.stringify(state)); return { type: "tab_created", tab: { tab_id: `tab-${process.pid}` }, root_pane: { pane_id: paneId } }; }
		throw new Error(method);
	},
};
try { await provisionHerdrPane(client, "/remote/repo", runId!, "/tmp/runtime", undefined, key); process.stdout.write("allocated\n"); }
catch (error) { process.stderr.write(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
