import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FocusedChildComponent, type FocusedChildTarget } from "../../src/tui/fleet-child-view.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

interface ChildViewFixture {
	root: string;
	target: FocusedChildTarget;
}

class FakeEditor {
	onEscape?: () => void;
	onSubmit?: (text: string) => void;
	disableSubmit = false;
	setText(): void {}
	handleInput(): void {}
	render(): string[] { return ["editor"]; }
	invalidate(): void {}
}

function fixture(): ChildViewFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-child-view-"));
	const transcript = path.join(root, "transcript.jsonl");
	fs.writeFileSync(transcript, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Child response" }] } })}\n`);
	fs.writeFileSync(path.join(root, "status.json"), JSON.stringify({
		runId: "run-1",
		mode: "single",
		state: "running",
		startedAt: 1,
		steps: [{ agent: "worker", status: "running", childControl: { requestId: "input-1", type: "input", state: "queued", requestedAt: 1, updatedAt: 2, message: "waiting for correlation" } }],
	}));
	return {
		root,
		target: {
			key: "async:run-1:0",
			runId: "run-1",
			asyncDir: root,
			index: 0,
			agent: "worker",
			transcript: { path: transcript, trustedRoots: [root] },
			model: "test/model",
			thinking: "medium",
			modelScopes: [],
			availableModels: [],
		},
	};
}

describe("focused native child view", () => {
	it("submits normal multiline editor text directly and Esc returns to Fleet", async () => {
		const { root, target } = fixture();
		try {
			let submitted: string | undefined;
			let closed = false;
			const editor = new FakeEditor();
			// SAFETY: this test double implements the CustomEditor surface used by FocusedChildComponent.
			const component = new FocusedChildComponent({
				tui: { terminal: { rows: 24 }, requestRender() {} },
				theme: theme as never,
				target,
				actions: {
					async submit(message) { submitted = message; return { requestId: "input-2" }; },
					async setRuntime() { return { requestId: "runtime-1" }; },
				},
				done: () => { closed = true; },
				editor: editor as never,
			});
			editor.onSubmit?.("first line\nsecond line");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(submitted, "first line\nsecond line");
			assert.match(component.render(100).join("\n"), /queued · waiting for correlation/);
			const status = JSON.parse(fs.readFileSync(path.join(root, "status.json"), "utf-8"));
			status.steps[0] = { ...status.steps[0], model: "test/new-model", thinking: "high", childControl: { ...status.steps[0].childControl, requestId: "input-2" } };
			fs.writeFileSync(path.join(root, "status.json"), JSON.stringify(status));
			component.invalidate();
			assert.match(component.render(100).join("\n"), /Model: test\/new-model · Thinking: high/);
			component.handleInput("\u001b");
			assert.equal(closed, true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses Pi model-select and thinking-cycle keybindings for runtime controls", async () => {
		const { root, target } = fixture();
		try {
			target.availableModels = [{ provider: "test", id: "model", fullId: "test/model", reasoning: true }];
			const editor = new FakeEditor();
			const requests: Array<{ model?: string; thinking?: string }> = [];
			const keybindings = {
				matches(data: string, action: string) {
					return (data === "model-select" && action === "app.model.select") || (data === "thinking-cycle" && action === "app.thinking.cycle");
				},
			};
			// SAFETY: these test doubles implement the exact Theme and CustomEditor members consumed by the view.
			const component = new FocusedChildComponent({
				tui: { terminal: { rows: 24 }, requestRender() {} },
				theme: theme as never,
				target,
				actions: {
					async submit() { return { requestId: "input" }; },
					async setRuntime(request) { requests.push(request); return { requestId: "runtime" }; },
				},
				done: () => {},
				editor: editor as never,
				keybindings,
			});
			component.handleInput("model-select");
			component.handleInput("\r");
			await new Promise<void>((resolve) => setImmediate(resolve));
			component.handleInput("thinking-cycle");
			component.handleInput("\r");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(requests[0]?.model, "test/model");
			assert.equal(requests[1]?.model, "test/model");
			assert.ok(requests[1]?.thinking);
			assert.match(component.render(100).join("\n"), /model.*thinking.*Enter submit/);
			component.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps ANSI-styled borders aligned within the terminal height", () => {
		const { root, target } = fixture();
		try {
			const ansiTheme = {
				fg: (_name: string, text: string) => `\u001b[36m${text}\u001b[0m`,
				bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
			};
			const component = new FocusedChildComponent({
				tui: { terminal: { rows: 12 }, requestRender() {} },
				theme: ansiTheme as never,
				target,
				actions: { async submit() { return { requestId: "x" }; }, async setRuntime() { return { requestId: "y" }; } },
				done: () => {},
				editor: new FakeEditor() as never,
			});
			const lines = component.render(60);
			assert.ok(lines.length <= 12);
			assert.ok(lines.every((line) => visibleWidth(line) === 60));
			component.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails transcript display closed when the path is outside trusted roots", () => {
		const { root, target } = fixture();
		try {
			target.transcript.trustedRoots = [path.join(root, "other")];
			const editor = new FakeEditor();
			// SAFETY: these test doubles implement the exact Theme and CustomEditor members consumed by the view.
			const component = new FocusedChildComponent({
				tui: { terminal: { rows: 24 }, requestRender() {} },
				theme: theme as never,
				target,
				actions: { async submit() { return { requestId: "x" }; }, async setRuntime() { return { requestId: "y" }; } },
				done: () => {},
				editor: editor as never,
			});
			assert.match(component.render(100).join("\n"), /outside trusted roots/);
			component.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
