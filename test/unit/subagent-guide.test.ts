import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readSubagentGuide, SUBAGENT_GUIDE_TOPICS } from "../../src/extension/subagent-guide.ts";
import { SUBAGENT_ACTIONS } from "../../src/shared/types.ts";

const SECTION_LIMIT = 8000;
const SECTIONED_TOPICS = SUBAGENT_GUIDE_TOPICS.filter((topic) => topic !== "overview" && topic !== "council");
const packageRoot = path.resolve(import.meta.dirname, "..", "..");

function sectionAddresses(topic: string): string[] {
	return [...readSubagentGuide(topic).matchAll(new RegExp(`^\\s*(${topic}/\\S+) — `, "gm"))].map((match) => match[1]!);
}

describe("subagent guide", () => {
	it("reads the packaged overview by default", () => {
		const guide = readSubagentGuide();

		assert.match(guide, /# pi-subagents/);
	});

	it("lists valid topics for an unknown topic without changing files", () => {
		const guide = readSubagentGuide("unknown");

		assert.match(guide, /Unknown subagents guide topic 'unknown'/);
		assert.match(guide, /No files were changed\./);
		assert.match(guide, new RegExp(SUBAGENT_GUIDE_TOPICS.join(", ")));
	});

	it("registers the guide action for action recovery", () => {
		assert.ok(SUBAGENT_ACTIONS.includes("guide"));
	});

	it("serves the council protocol and its references without loaded skills", () => {
		const guide = readSubagentGuide("council");

		assert.match(guide, /# Council Mode/);
		assert.match(guide, /skills\/council-mode\/references\/pass-contracts\.md -->/);
		assert.match(guide, /skills\/pi-subagents\/references\/execution-controls\.md -->/);
		assert.match(guide, /Completed external-job runs can use `action: "resume"` for provider follow-up when the registered provider exposes `followUp\(input\)`/);
		assert.doesNotMatch(guide, /External job profiles do not support[^.\n]*steer\/resume/);
	});

	it("documents external CLI runner limits in packaged guide topics", () => {
		assert.match(readSubagentGuide("tool-reference/external-cli-agent-profiles"), /External CLI agent profiles[\s\S]*native Pi child options[\s\S]*model override[\s\S]*native Pi tools/);
		assert.match(readSubagentGuide("agents/advisory-runner-data-boundary"), /External CLI agents use their own runner contract[\s\S]*native Pi child options/);
	});

	it("documents failed-lane recovery boundaries in packaged guide topics", () => {
		const workflows = readSubagentGuide("workflows/failed-lane-recovery-and-execution-mode-boundaries");
		const toolReference = readSubagentGuide("tool-reference/failed-lane-recovery-and-execution-mode-boundaries");
		assert.match(workflows, /subagent workflow[\s\S]*child launch[\s\S]*prompt runtime[\s\S]*extension loading[\s\S]*child tooling setup[\s\S]*lane infrastructure blocker/);
		assert.match(workflows, /exact failure[\s\S]*run\/status[\s\S]*(?:repo|repository)\/cwd\/worktree\/branch\/ref/);
		assert.match(workflows, /clean[\s\S]*partial diff/);
		assert.match(workflows, /same-protocol retry/);
		assert.match(workflows, /asking the owner/);
		assert.match(workflows, /external\/foreground\/CLI fallback requires explicit owner approval/);
		assert.match(workflows, /Pi core[\s\S]*pi -ne[\s\S]*out-of-repo hint[\s\S]*not protocol-approved fallback/);
		assert.match(toolReference, /lane infrastructure blocker[\s\S]*external\/foreground\/CLI fallback requires explicit owner approval[\s\S]*interactive_shell[\s\S]*pi -ne/);
	});

	it("keeps advanced workflow details in the packaged guide", () => {
		assert.match(readSubagentGuide("workflows/parallel-sequential-lanes"), /### Parallel sequential lanes[\s\S]*runs\.lanes/);
		assert.match(readSubagentGuide("workflows/host-command-steps"), /### Host command steps[\s\S]*runs\.host/);
		assert.match(readSubagentGuide("workflows/advanced-rolling-child-runs"), /### Advanced rolling child runs[\s\S]*Promise\.race[\s\S]*Promise\.all/);
	});

	it("returns a bare docs topic as a table of section addresses, not the whole document", () => {
		const toc = readSubagentGuide("tool-reference");

		assert.ok(toc.length <= SECTION_LIMIT, `TOC is ${toc.length} chars`);
		assert.match(toc, /^tool-reference\/acceptance-gates — Acceptance gates$/m);
		assert.match(toc, /^ {2}tool-reference\/typed-gates — Typed gates$/m);
		assert.doesNotMatch(toc, /\| `agent` \| string \|/);
	});

	it("returns one section and stops before its next sibling", () => {
		const leaf = readSubagentGuide("tool-reference/herdr-project-panes");
		const nested = readSubagentGuide("tool-reference/stop");

		assert.match(leaf, /^## Herdr project panes\n/);
		assert.doesNotMatch(leaf, /## Orca progress tabs/);
		assert.match(nested, /^### stop\n/);
		assert.doesNotMatch(nested, /### steer/);
	});

	it("keeps every section of every docs topic within the response limit", () => {
		for (const topic of SECTIONED_TOPICS) {
			const addresses = sectionAddresses(topic);
			assert.ok(addresses.length > 0, `${topic} lists no sections`);
			for (const address of addresses) {
				const text = readSubagentGuide(address);
				assert.doesNotMatch(text, /^Unknown/, address);
				assert.ok(text.length <= SECTION_LIMIT, `${address} is ${text.length} chars`);
			}
		}
	});

	it("lists the topic's sections for an unknown section", () => {
		const guide = readSubagentGuide("workflows/no-such-section");

		assert.match(guide, /Unknown section 'workflows\/no-such-section'/);
		assert.match(guide, /^workflows\/scripted-workflows — Scripted workflows$/m);
	});

	it("reads sections the same way from a CRLF checkout", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guide-crlf-"));
		try {
			fs.mkdirSync(path.join(root, "docs"));
			fs.writeFileSync(path.join(root, "docs", "workflows.md"), "# Workflows\r\n\r\nIntro.\r\n\r\n## First\r\n\r\nOne.\r\n\r\n## Second\r\n\r\nTwo.\r\n");
			assert.equal(readSubagentGuide("workflows/first", root), "## First\n\nOne.");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves every guide pointer in shipped prompts, skills and source", () => {
		const topicNames = SUBAGENT_GUIDE_TOPICS.join("|");
		const pointer = new RegExp(`topic:\\s*\\\\?["']([a-z][a-z0-9/-]*)|guide (?:topics? )?((?:${topicNames})(?:/[a-z0-9-]+)?)\\b`, "g");
		const files = ["src", "skills", "prompts", "agents"].flatMap((dir) => fs.readdirSync(path.join(packageRoot, dir), { recursive: true, encoding: "utf-8" })
			.filter((file) => /\.(ts|md)$/.test(file))
			.map((file) => path.join(packageRoot, dir, file)));
		const pointers = files.flatMap((file) => [...fs.readFileSync(file, "utf-8").matchAll(pointer)].map((match) => ({ file, address: match[1] ?? match[2]! })));

		assert.ok(pointers.some(({ address }) => address.includes("/")), "expected section pointers");
		for (const { file, address } of pointers) {
			assert.doesNotMatch(readSubagentGuide(address), /^Unknown/, `${path.relative(packageRoot, file)} points to ${address}`);
		}
	});
});
