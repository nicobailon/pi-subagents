import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getSystemMessageText, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { createDefaultChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { createStructuredOutputRuntime } from "../../src/runs/shared/structured-output.ts";
import { CHILD_FANOUT_BOUNDARY_INSTRUCTIONS, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS, rewriteSubagentPrompt } from "../../src/runs/shared/subagent-prompt-runtime.ts";

type Flags = { inheritProjectContext: boolean; inheritGlobalContext: boolean; inheritSkills: boolean };
type Fixture = { globalContext?: boolean; repoContext?: boolean; orchestrationSkill?: boolean };
type Run = { flags: Flags; fixture?: Fixture; unsetFlags?: boolean; fanout?: boolean; structured?: boolean; prompts?: string[]; toolTurn?: boolean; hooks?: Array<(pi: ExtensionAPI) => void> };

const count = (text: string, part: string) => text.split(part).length - 1;

describe("child provider system prompt", () => {
	let root: string;
	let agentDir: string;
	let repo: string;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

	before(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-prompt-sections-"));
		agentDir = path.join(root, "agent");
		repo = path.join(root, "repo");
		fs.mkdirSync(repo);
		writeSkill("probe-skill");
		fs.writeFileSync(path.join(repo, "notes.txt"), "notes");
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	});

	function writeSkill(name: string): void {
		fs.mkdirSync(path.join(agentDir, "skills", name), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill.\n---\nBody`);
	}

	function setFixture({ globalContext = true, repoContext = true, orchestrationSkill = false }: Fixture): void {
		const toggle = (file: string, present: boolean, write: () => void) => present ? write() : fs.rmSync(file, { recursive: true, force: true });
		toggle(path.join(agentDir, "AGENTS.md"), globalContext, () => fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "GLOBAL-CONTEXT-MARKER"));
		toggle(path.join(repo, "AGENTS.md"), repoContext, () => fs.writeFileSync(path.join(repo, "AGENTS.md"), "REPO-CONTEXT-MARKER"));
		toggle(path.join(agentDir, "skills", "pi-subagents"), orchestrationSkill, () => writeSkill("pi-subagents"));
	}

	/** Runs a real SDK child, one run per prompt, and returns the system prompt of every provider request. */
	async function providerPrompts(run: Run): Promise<string[]> {
		setFixture(run.fixture ?? {});
		const faux = fauxProvider({ provider: "probe", models: [{ id: "local" }], tokensPerSecond: 100_000 });
		const requests: string[] = [];
		const reply = (message: ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory => (context) => {
			requests.push(context.messages.filter((entry) => entry.role === "system").map((entry) => getSystemMessageText(entry as never)).join("\n\n"));
			return message;
		};
		faux.setResponses((run.prompts ?? ["Task"]).flatMap(() => run.toolTurn
			? [reply(fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }), { stopReason: "toolUse" })), reply(fauxAssistantMessage("done"))]
			: [reply(fauxAssistantMessage("done"))]));
		const { session, config } = buildInProcessChildLaunch({
			host: "parent", cwd: repo, childAgentName: "worker", childIndex: 0, sessionEnabled: false, waitToolEnabled: false,
			model: "probe/local", systemPrompt: "Role instructions.", systemPromptMode: "append", ...run.flags,
			...(run.fanout ? { allowNestedSubagents: true } : {}),
			...(run.structured ? { structuredOutput: createStructuredOutputRuntime({ type: "object" }, repo) } : {}),
		});
		// Unset flags make the prompt runtime leave the prompt alone, so the same launch yields Pi's original render.
		if (run.unsetFlags) Object.assign(config, { inheritProjectContext: undefined, inheritGlobalContext: undefined, inheritSkills: undefined });
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: () => import("@earendil-works/pi-coding-agent") });
		const hooks = [(pi: ExtensionAPI) => pi.registerProvider(faux.provider as never), ...run.hooks ?? []];
		const child = await factory.create({ ...session, hooks: [...session.hooks, ...hooks.map((factory, index) => ({ name: `probe-${index}`, factory }))] });
		try {
			for (const prompt of run.prompts ?? ["Task"]) await child.prompt(prompt);
		} finally {
			await child.dispose();
			await factory.dispose();
		}
		return requests;
	}

	it("sends sections that later extensions add to the provider, after the filtered prompt a bridge captured", async () => {
		const captured: string[] = [];
		const requests = await providerPrompts({
			flags: { inheritProjectContext: true, inheritGlobalContext: false, inheritSkills: true },
			prompts: ["Task", "Next task"],
			toolTurn: true,
			hooks: [
				(pi) => pi.on("before_agent_start", (event) => { captured.push(event.systemPrompt); }),
				(pi) => pi.on("before_agent_start", (event) => { event.systemPromptOptions.sections.probe = "PROBE-SECTION-MARKER"; }),
			],
		});

		assert.equal(requests.length, 4, "a tool-result request and a second prompt each re-send the prompt");
		assert.equal(new Set(requests).size, 1, "the prompt is identical across requests");
		for (const [index, request] of requests.entries()) {
			const capture = captured[index < 2 ? 0 : 1]!;
			assert.match(request, /<probe>\nPROBE-SECTION-MARKER\n<\/probe>/);
			assert.ok(request.startsWith(capture), "the bridge-captured prompt is the head of the provider prompt");
			assert.doesNotMatch(capture, /GLOBAL-CONTEXT-MARKER/);
			assert.doesNotMatch(request, /GLOBAL-CONTEXT-MARKER/);
			assert.match(request, /REPO-CONTEXT-MARKER/);
			assert.ok(request.endsWith(`\n\n${CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS}`));
			assert.equal(count(request, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 1);
		}
	});

	it("appends the boundary once to a prompt another extension returns", async () => {
		const [request] = await providerPrompts({
			flags: { inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: true },
			hooks: [(pi) => pi.on("before_agent_start", () => ({ systemPrompt: "Extension-owned prompt." }))],
		});
		assert.equal(request, `Extension-owned prompt.\n\n${CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS}`);
	});

	const inheritAll = { inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: true };
	const noGlobal = { inheritProjectContext: true, inheritGlobalContext: false, inheritSkills: true };
	for (const [label, run, absent] of [
		["nothing to remove", { flags: inheritAll }, {}],
		["context and skills not loaded", { flags: { inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false } }, {}],
		["global context removed", { flags: noGlobal }, { globalContext: false }],
		["the only context file removed", { flags: noGlobal, fixture: { repoContext: false } }, { globalContext: false }],
		["pi-subagents skill removed next to another skill", { flags: inheritAll, fixture: { orchestrationSkill: true } }, { orchestrationSkill: false }],
		["structured output", { flags: noGlobal, structured: true }, { globalContext: false }],
	] as Array<[string, Run, Fixture]>) {
		it(`sends a child without other extensions Pi's render of the launch without the removed resources, plus the boundary (${label})`, async () => {
			// The launch without the removed resources leaves rewriteSubagentPrompt nothing to strip, so it only appends the boundary.
			const [render] = await providerPrompts({ ...run, fixture: { ...run.fixture, ...absent }, unsetFlags: true });
			const [actual] = await providerPrompts(run);
			assert.equal(actual, rewriteSubagentPrompt(render!, { ...run.flags, structuredOutput: run.structured }));
		});
	}

	it("keeps the fanout child's provider prompt byte-identical", async () => {
		const flags = inheritAll;
		const seen: string[] = [];
		const [rewritten] = await providerPrompts({ flags, fanout: true, hooks: [(pi) => pi.on("before_agent_start", (event) => { seen.push(event.systemPrompt); })] });
		// With everything inherited the filter removes nothing, so the prompt seen mid-chain is Pi's original render.
		assert.equal(rewritten, rewriteSubagentPrompt(seen[0]!, { ...flags, fanoutChild: true }));
		assert.ok(rewritten!.endsWith(`\n\n${CHILD_FANOUT_BOUNDARY_INSTRUCTIONS}`));
	});
});
