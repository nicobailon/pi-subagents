import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	PROJECT_PANES_API_VERSION,
	PROJECT_PANE_TRUST_STATUS,
	createProjectPaneManager,
	openProjectPane,
	getProjectPaneStatus,
	focusProjectPane,
	closeProjectPane,
	projectPaneBindingPath,
	readProjectPaneBinding,
	type ProjectPaneCommandClient,
} from "pi-subagents/project-panes";

describe("public project-panes package export", () => {
	it("exposes the versioned extension-to-extension lifecycle surface", () => {
		assert.equal(PROJECT_PANES_API_VERSION, 1);
		assert.equal(PROJECT_PANE_TRUST_STATUS, "human-verification-required");
		assert.equal(typeof createProjectPaneManager, "function");
		assert.equal(typeof openProjectPane, "function");
		assert.equal(typeof getProjectPaneStatus, "function");
		assert.equal(typeof focusProjectPane, "function");
		assert.equal(typeof closeProjectPane, "function");
		assert.equal(typeof readProjectPaneBinding, "function");
	});

	it("runs the structured lifecycle and verifies pane ownership before idle close", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-public-project-pane-"));
		const previousPiBinary = process.env.PI_SUBAGENT_PI_BINARY;
		process.env.PI_SUBAGENT_PI_BINARY = path.join(root, "pi-bin");
		try {
			const projectRoot = fs.realpathSync(root);
			const calls: string[][] = [];
			let opened = false;
			const client: ProjectPaneCommandClient = {
				run: async <T>(args: string[]) => {
					calls.push(args);
					if (args[0] === "--version") return { ok: true, data: "herdr 0.8.0" as T };
					if (args[0] === "pane" && args[1] === "split") return { ok: true, data: { pane: { pane_id: "w1:p20" } } as T };
					if (args[0] === "pane" && args[1] === "run") { opened = true; return { ok: true, data: {} as T }; }
					if (args[0] === "pane" && args[1] === "get" && opened) return { ok: true, data: { pane: {
						pane_id: "w1:p20", agent: "pi", agent_status: "IDLE", cwd: projectRoot,
						foreground_cwd: projectRoot, focused: false, terminal_title_stripped: "Pi · project",
						tab_id: "tab-20", workspace_id: "workspace-1", state_text: "one active subagent",
					} } as T };
					return { ok: true, data: {} as T };
				},
			};
			const manager = createProjectPaneManager({ client, now: () => new Date("2026-01-01T00:00:00.000Z") });
			const open = await manager.open({ cwd: root, focus: false });
			assert.equal(open.ok, true);
			if (open.ok) {
				assert.equal(open.data.disposition, "opened");
				assert.equal(open.data.projectRoot, projectRoot);
				assert.equal(open.data.trust, "human-verification-required");
			}
			const status = await manager.status({ cwd: root });
			assert.equal(status.ok, true);
			if (status.ok) {
				assert.equal(status.data.state, "open");
				assert.equal(status.data.runtime?.agentStatus, "idle");
				assert.equal(status.data.runtime?.summary, "one active subagent");
				assert.equal(status.data.ownership, "verified");
				assert.equal(status.data.safeToClose, true);
			}
			const focus = await manager.focus({ cwd: root });
			assert.equal(focus.ok, true);
			if (focus.ok) assert.deepEqual(focus.data.focused, { paneId: "w1:p20", tabId: "tab-20", workspaceId: "workspace-1" });
			assert.equal(readProjectPaneBinding(root).data?.lastFocusedAt, "2026-01-01T00:00:00.000Z");
			const close = await manager.close({ cwd: root, requireIdle: true });
			assert.equal(close.ok, true);
			if (close.ok) assert.equal(close.data.disposition, "closed");
			assert.deepEqual(readProjectPaneBinding(root), { ok: true, data: undefined });
			assert.ok(calls.some((args) => args.join(" ") === "tab focus tab-20"));
			assert.ok(calls.some((args) => args.join(" ") === "pane close w1:p20"));
		} finally {
			if (previousPiBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
			else process.env.PI_SUBAGENT_PI_BINARY = previousPiBinary;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("distinguishes a stale binding on the default close path", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-public-project-pane-stale-"));
		try {
			const projectRoot = fs.realpathSync(root);
			fs.mkdirSync(path.dirname(projectPaneBindingPath(projectRoot)), { recursive: true });
			fs.writeFileSync(projectPaneBindingPath(projectRoot), JSON.stringify({
				schemaVersion: 1, kind: "herdr-project-pane", projectRoot, paneId: "w1:p21",
				openedAt: "2026-01-01T00:00:00.000Z", command: "pi",
			}));
			const client: ProjectPaneCommandClient = {
				run: async () => ({ ok: false, error: { code: "NOT_FOUND", message: "gone" } }),
			};
			const result = await createProjectPaneManager({ client }).close({ cwd: root });
			assert.equal(result.ok, true);
			if (result.ok) assert.equal(result.data.disposition, "stale-binding-removed");
			assert.deepEqual(readProjectPaneBinding(root), { ok: true, data: undefined });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns a structured error when an existing binding cannot be read", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-public-project-pane-read-failure-"));
		try {
			const projectRoot = fs.realpathSync(root);
			const bindingPath = projectPaneBindingPath(projectRoot);
			fs.mkdirSync(bindingPath, { recursive: true });
			const binding = readProjectPaneBinding(projectRoot);
			assert.equal(binding.ok, false);
			if (!binding.ok) {
				assert.equal(binding.error.code, "BINDING_READ_FAILED");
				assert.equal(binding.error.bindingPath, bindingPath);
			}
			let clientCalled = false;
			const manager = createProjectPaneManager({ client: { run: async () => { clientCalled = true; return { ok: true, data: {} }; } } });
			const status = await manager.status({ cwd: root });
			assert.equal(status.ok, false);
			if (!status.ok) {
				assert.equal(status.error.code, "BINDING_READ_FAILED");
				assert.equal(status.error.bindingPath, bindingPath);
				assert.match(status.error.message, /Failed to read project pane binding/);
				assert.match(String((status.error.details as { code?: unknown }).code), /EISDIR|EPERM|EACCES/);
			}
			assert.equal(clientCalled, false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns a structured error and closes the pane when binding persistence fails", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-public-project-pane-write-failure-"));
		const previousPiBinary = process.env.PI_SUBAGENT_PI_BINARY;
		process.env.PI_SUBAGENT_PI_BINARY = path.join(root, "pi-bin");
		try {
			fs.mkdirSync(path.join(root, ".pi"));
			fs.writeFileSync(path.join(root, ".pi/subagents"), "directory collision");
			const calls: string[][] = [];
			const client: ProjectPaneCommandClient = {
				run: async <T>(args: string[]) => {
					calls.push(args);
					if (args[0] === "--version") return { ok: true, data: "herdr 0.8.0" as T };
					if (args[1] === "split") return { ok: true, data: { pane: { pane_id: "w1:p24" } } as T };
					return { ok: true, data: {} as T };
				},
			};
			const result = await createProjectPaneManager({ client }).open({ cwd: root, focus: false });
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.error.code, "BINDING_WRITE_FAILED");
				assert.equal(result.error.bindingPath, projectPaneBindingPath(fs.realpathSync(root)));
				assert.match(result.error.message, /newly opened pane 'w1:p24' was closed/);
			}
			assert.ok(calls.some((args) => args.join(" ") === "pane close w1:p24"));
		} finally {
			if (previousPiBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
			else process.env.PI_SUBAGENT_PI_BINARY = previousPiBinary;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns a structured error when binding removal fails after closing the pane", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-public-project-pane-remove-failure-"));
		try {
			const projectRoot = fs.realpathSync(root);
			const bindingPath = projectPaneBindingPath(projectRoot);
			fs.mkdirSync(path.dirname(bindingPath), { recursive: true });
			fs.writeFileSync(bindingPath, JSON.stringify({
				schemaVersion: 1, kind: "herdr-project-pane", projectRoot, paneId: "w1:p25",
				openedAt: "2026-01-01T00:00:00.000Z", command: "pi",
			}));
			const client: ProjectPaneCommandClient = {
				run: async <T>(args: string[]) => {
					if (args.join(" ") === "pane get w1:p25") return { ok: true, data: { pane: {
						pane_id: "w1:p25", agent_status: "idle", cwd: projectRoot,
					} } as T };
					if (args.join(" ") === "pane close w1:p25") {
						fs.rmSync(bindingPath);
						fs.mkdirSync(bindingPath);
					}
					return { ok: true, data: {} as T };
				},
			};
			const result = await createProjectPaneManager({ client }).close({ cwd: root });
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.error.code, "BINDING_REMOVE_FAILED");
				assert.equal(result.error.bindingPath, bindingPath);
			}
			assert.equal(fs.statSync(bindingPath).isDirectory(), true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns a structured error when focus cannot update the binding", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-public-project-pane-focus-write-failure-"));
		try {
			const projectRoot = fs.realpathSync(root);
			const bindingPath = projectPaneBindingPath(projectRoot);
			const paneId = "w1:p26";
			fs.mkdirSync(path.dirname(bindingPath), { recursive: true });
			fs.writeFileSync(bindingPath, JSON.stringify({ schemaVersion: 1, kind: "herdr-project-pane", projectRoot, paneId, openedAt: "2026-01-01T00:00:00.000Z", command: "pi" }));
			const client: ProjectPaneCommandClient = {
				run: async <T>(args: string[]) => {
					if (args.join(" ") === `pane get ${paneId}`) return { ok: true, data: { pane: { pane_id: paneId, agent_status: "idle", cwd: projectRoot, tab_id: "tab-26" } } as T };
					if (args.join(" ") === "tab focus tab-26") {
						fs.rmSync(bindingPath);
						fs.mkdirSync(bindingPath);
						return { ok: true, data: {} as T };
					}
					return { ok: true, data: {} as T };
				},
			};
			const result = await createProjectPaneManager({ client }).focus({ cwd: root });
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.error.code, "BINDING_WRITE_FAILED");
				assert.equal(result.error.bindingPath, bindingPath);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects idle close when Herdr pane ownership no longer matches the project", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-public-project-pane-owner-"));
		const other = fs.mkdtempSync(path.join(os.tmpdir(), "pi-public-project-pane-other-"));
		try {
			const projectRoot = fs.realpathSync(root);
			fs.mkdirSync(path.dirname(projectPaneBindingPath(projectRoot)), { recursive: true });
			fs.writeFileSync(projectPaneBindingPath(projectRoot), JSON.stringify({
				schemaVersion: 1, kind: "herdr-project-pane", projectRoot, paneId: "w1:p22",
				openedAt: "2026-01-01T00:00:00.000Z", command: "pi",
			}));
			let closeCalled = false;
			const client: ProjectPaneCommandClient = {
				run: async <T>(args: string[]) => {
					if (args[0] === "--version") return { ok: true, data: "herdr 0.8.0" as T };
					if (args[1] === "get") return { ok: true, data: { pane: { pane_id: "w1:p22", agent_status: "idle", cwd: other } } as T };
					if (args[1] === "close") closeCalled = true;
					return { ok: true, data: {} as T };
				},
			};
			const manager = createProjectPaneManager({ client });
			const open = await manager.open({ cwd: root });
			assert.equal(open.ok, false);
			if (!open.ok) assert.equal(open.error.code, "PANE_OWNERSHIP_UNVERIFIED");
			const result = await manager.close({ cwd: root, requireIdle: true });
			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.error.code, "PANE_OWNERSHIP_UNVERIFIED");
			assert.equal(closeCalled, false);
			const binding = readProjectPaneBinding(root);
			assert.equal(binding.ok, true);
			if (binding.ok) assert.equal(binding.data?.paneId, "w1:p22");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(other, { recursive: true, force: true });
		}
	});

	it("does not expose or lifecycle-manage malformed public bindings as if they were absent", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-public-project-pane-binding-"));
		try {
			const projectRoot = fs.realpathSync(root);
			fs.mkdirSync(path.dirname(projectPaneBindingPath(projectRoot)), { recursive: true });
			fs.writeFileSync(projectPaneBindingPath(projectRoot), JSON.stringify({
				schemaVersion: 1, kind: "herdr-project-pane", projectRoot, paneId: "w1:p23",
				openedAt: "2026-01-01T00:00:00.000Z", command: "pi", startupMessage: 42,
			}));
			const binding = readProjectPaneBinding(root);
			assert.equal(binding.ok, false);
			if (!binding.ok) assert.equal(binding.error.code, "INVALID_BINDING");
			let clientCalled = false;
			const manager = createProjectPaneManager({ client: { run: async () => { clientCalled = true; return { ok: true, data: {} }; } } });
			const status = await manager.status({ cwd: root });
			assert.equal(status.ok, false);
			if (!status.ok) assert.equal(status.error.code, "INVALID_BINDING");
			const close = await manager.close({ cwd: root });
			assert.equal(close.ok, false);
			if (!close.ok) assert.equal(close.error.code, "INVALID_BINDING");
			assert.equal(clientCalled, false);
			assert.equal(fs.existsSync(projectPaneBindingPath(projectRoot)), true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
