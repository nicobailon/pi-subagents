import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { TUI } from "/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-tui/dist/index.js";
import type { Terminal } from "/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-tui/dist/terminal.js";
import { theme as testTheme } from "/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { AgentManagerComponent } from "../../agent-manager.ts";
import { discoverAgentsAll } from "../../agents.ts";

const tempDirs: string[] = [];

class TestTerminal implements Terminal {
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	get columns(): number { return 120; }
	get rows(): number { return 40; }
	get kittyProtocolActive(): boolean { return false; }
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("agent manager", () => {
	it("renames the backing file when saving an existing renamed agent", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-manager-rename-"));
		tempDirs.push(root);
		const agentsDir = path.join(root, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		const originalPath = path.join(agentsDir, "alpha.md");
		fs.writeFileSync(originalPath, `---\nname: alpha\ndescription: Alpha\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritSkills: false\n---\n\nHello\n`, "utf-8");

		const component = new AgentManagerComponent(
			new TUI(new TestTerminal()),
			testTheme,
			{ ...discoverAgentsAll(root), cwd: root },
			[],
			[],
			() => {},
		);

		const entry = component["agents"].find((candidate) => candidate.config.name === "alpha");
		assert.ok(entry);
		component["enterEdit"](entry);
		component["editState"].draft.name = "beta";

		assert.equal(component["saveEdit"](), true);
		assert.equal(fs.existsSync(originalPath), false);
		assert.equal(fs.existsSync(path.join(agentsDir, "beta.md")), true);
	});
});
