import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { AgentManagerComponent } from "../../agent-manager.ts";
import { discoverAgentsAll } from "../../agents.ts";

const tempDirs: string[] = [];

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
			{ requestRender() {} } as { requestRender(): void },
			{
				fg(_color: string, text: string) { return text; },
				bg(_color: string, text: string) { return text; },
			} as { fg(color: string, text: string): string; bg(color: string, text: string): string },
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
