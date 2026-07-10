import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { tryImport } from "../support/helpers.ts";

interface ClarifyTestModel {
	provider: string;
	id: string;
	fullId: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
}

interface ClarifyTestComponent {
	editingStep: number | null;
	selectedStep: number;
	modelSelectedIndex: number;
	filteredModels: ClarifyTestModel[];
	getEffectiveModel(stepIndex: number): string;
	applyThinkingLevel(level: "high"): void;
	enterModelSelector(): void;
	enterThinkingSelector(): void;
	renderThinkingSelector(): string[];
	handleModelSelectorInput(data: string): void;
	handleInput(data: string): void;
	render(width: number): string[];
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

interface ClarifyTestModule {
	ChainClarifyComponent: new (...args: unknown[]) => ClarifyTestComponent;
}

const clarifyMod = await tryImport<ClarifyTestModule>("./src/runs/foreground/chain-clarify.ts");
const available = !!clarifyMod;
const ChainClarifyComponent = clarifyMod?.ChainClarifyComponent;

describe("chain clarify model display", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("keeps the preferred provider visible after applying thinking to a bare model", () => {
		const component = new ChainClarifyComponent(
			{ requestRender() {} },
			{ fg(_key: string, text: string) { return text; } },
			[{
				name: "worker",
				description: "",
				systemPrompt: "",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				source: "user",
				filePath: "worker.md",
				model: "gpt-5-mini",
			}],
			["Task"],
			"Task",
			undefined,
			[{ output: false, outputMode: "inline", reads: false, progress: false, skills: [], model: "gpt-5-mini" }],
			[
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			"github-copilot",
			[],
			() => {},
			"single",
		);

		assert.equal(component.getEffectiveModel(0), "github-copilot/gpt-5-mini");
		component.editingStep = 0;
		component.applyThinkingLevel("high");
		assert.equal(component.getEffectiveModel(0), "github-copilot/gpt-5-mini:high");
	});

	it("shows only thinking levels supported by the selected model", () => {
		const component = new ChainClarifyComponent(
			{ requestRender() {} },
			{ fg(_key: string, text: string) { return text; } },
			[{
				name: "worker",
				description: "",
				systemPrompt: "",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				source: "user",
				filePath: "worker.md",
				model: "deepseek-v4-pro",
			}],
			["Task"],
			"Task",
			undefined,
			[{ output: false, outputMode: "inline", reads: false, progress: false, skills: [], model: "deepseek-v4-pro" }],
			[{
				provider: "deepseek",
				id: "deepseek-v4-pro",
				fullId: "deepseek/deepseek-v4-pro",
				reasoning: true,
				thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
			}],
			"deepseek",
			[],
			() => {},
			"single",
		);

		component.selectedStep = 0;
		component.enterThinkingSelector();
		const rendered = component.renderThinkingSelector().join("\n");

		assert.match(rendered, /off - No extended thinking/);
		assert.match(rendered, /high - Deep reasoning/);
		assert.match(rendered, /xhigh - Maximum reasoning/);
		assert.doesNotMatch(rendered, /minimal - Brief reasoning/);
		assert.doesNotMatch(rendered, /low - Light reasoning/);
		assert.doesNotMatch(rendered, /medium - Moderate reasoning/);
		assert.doesNotMatch(rendered, /max - Maximum available reasoning/);
	});

	it("renders the max thinking option when the selected model exposes it", () => {
		const component = new ChainClarifyComponent(
			{ requestRender() {} },
			{ fg(_key: string, text: string) { return text; } },
			[{
				name: "worker",
				description: "",
				systemPrompt: "",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				source: "user",
				filePath: "worker.md",
				model: "openai/gpt-5",
			}],
			["Task"],
			"Task",
			undefined,
			[{ output: false, outputMode: "inline", reads: false, progress: false, skills: [], model: "openai/gpt-5" }],
			[{ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5", reasoning: true, thinkingLevelMap: { max: "max" } }],
			"openai",
			[],
			() => {},
			"single",
		);
		component.selectedStep = 0;
		component.enterThinkingSelector();
		const rendered = component.renderThinkingSelector().join("\n");
		assert.match(rendered, /max - Maximum available reasoning/);
	});

	it("drops thinking when switching to a model that does not support it", () => {
		const component = new ChainClarifyComponent(
			{ requestRender() {} },
			{ fg(_key: string, text: string) { return text; } },
			[{
				name: "worker",
				description: "",
				systemPrompt: "",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				source: "user",
				filePath: "worker.md",
				model: "reasoning-model",
			}],
			["Task"],
			"Task",
			undefined,
			[{ output: false, outputMode: "inline", reads: false, progress: false, skills: [], model: "reasoning-model" }],
			[
				{ provider: "test", id: "reasoning-model", fullId: "test/reasoning-model", reasoning: true },
				{ provider: "test", id: "basic-model", fullId: "test/basic-model", reasoning: false },
			],
			"test",
			[],
			() => {},
			"single",
		);

		component.editingStep = 0;
		component.applyThinkingLevel("high");
		component.selectedStep = 0;
		component.enterModelSelector();
		component.modelSelectedIndex = component.filteredModels.findIndex((model) => model.fullId === "test/basic-model");
		component.handleModelSelectorInput("\r");

		assert.equal(component.getEffectiveModel(0), "test/basic-model");
	});

	it("does not expose persistent save shortcuts", () => {
		const component = new ChainClarifyComponent(
			{ requestRender() {} },
			{ fg(_key: string, text: string) { return text; } },
			[{
				name: "worker",
				description: "",
				systemPrompt: "",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				source: "user",
				filePath: "worker.md",
			}],
			["Task"],
			"Task",
			undefined,
			[{ output: false, outputMode: "inline", reads: false, progress: false, skills: [], model: undefined }],
			[],
			undefined,
			[],
			() => {},
			"chain",
		);

		const initial = component.render(84).join("\n");
		assert.doesNotMatch(initial, /\bS\b/);
		assert.doesNotMatch(initial, /\bW\b/);

		component.handleInput("W");
		const afterSaveChainKey = component.render(84).join("\n");
		assert.doesNotMatch(afterSaveChainKey, /Save Chain/);

		component.handleInput("S");
		const afterSaveAgentKey = component.render(84).join("\n");
		assert.doesNotMatch(afterSaveAgentKey, /Saved agent settings/);
	});

	it("wraps wide characters inside the runtime editor width", () => {
		const component = new ChainClarifyComponent(
			{ requestRender() {} },
			{ fg(_key: string, text: string) { return text; } },
			[{
				name: "worker",
				description: "",
				systemPrompt: "",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				source: "user",
				filePath: "worker.md",
			}],
			["界".repeat(60)],
			"Task",
			undefined,
			[{ output: false, outputMode: "inline", reads: false, progress: false, skills: [], model: undefined }],
			[],
			undefined,
			[],
			() => {},
			"single",
		);

		component.handleInput("e");
		const lines = component.render(84).map(stripAnsi);
		assert.ok(lines.some((line) => line.includes("界")), "editor should render the wide-character task");
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 84, `line exceeded component width: ${line}`);
		}
	});

	it("keeps the current model selected and preserves thinking when switching models", () => {
		const component = new ChainClarifyComponent(
			{ requestRender() {} },
			{ fg(_key: string, text: string) { return text; } },
			[{
				name: "worker",
				description: "",
				systemPrompt: "",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				source: "user",
				filePath: "worker.md",
				model: "gpt-5-mini",
			}],
			["Task"],
			"Task",
			undefined,
			[{ output: false, outputMode: "inline", reads: false, progress: false, skills: [], model: "gpt-5-mini" }],
			[
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5", fullId: "github-copilot/gpt-5" },
			],
			"github-copilot",
			[],
			() => {},
			"single",
		);

		component.editingStep = 0;
		component.applyThinkingLevel("high");
		component.selectedStep = 0;
		component.enterModelSelector();

		assert.equal(component.filteredModels[component.modelSelectedIndex]?.fullId, "github-copilot/gpt-5-mini");

		component.modelSelectedIndex = component.filteredModels.findIndex((model) => model.fullId === "github-copilot/gpt-5");
		component.handleModelSelectorInput("\r");

		assert.equal(component.getEffectiveModel(0), "github-copilot/gpt-5:high");
	});

	it("labels every shortcut and keeps the clarify overlay within 84 columns", () => {
		for (const mode of ["single", "parallel", "chain"] as const) {
			const count = mode === "single" ? 1 : mode === "parallel" ? 2 : 4;
			const component = new ChainClarifyComponent(
				{ requestRender() {} },
				{ fg(_key: string, text: string) { return `\u001b[31m${text}\u001b[0m`; } },
				Array.from({ length: count }, (_, index) => ({
					name: `agent-${index + 1}`,
					description: "",
					systemPrompt: "",
					systemPromptMode: "replace",
					inheritProjectContext: false,
					inheritSkills: false,
					source: "user",
					filePath: `agent-${index + 1}.md`,
				})),
				Array.from({ length: count }, (_, index) => index === 0 ? "Task" : "Use {previous}"),
				"Task",
				undefined,
				Array.from({ length: count }, () => ({
					output: false,
					outputMode: "inline",
					reads: false,
					progress: false,
					skills: [],
					model: undefined,
				})),
				[],
				undefined,
				[],
				() => {},
				mode,
			);

			const initialLines = component.render(84).map(stripAnsi);
			const initial = initialLines.join("\n");
			assert.match(initial, /\[e\]Task/);
			assert.match(initial, /\[m\]Model/);
			assert.match(initial, /\[t\]Think/);
			assert.match(initial, /\[s\]Skills/);
			assert.match(initial, /\[b\]Background:OFF/);
			assert.doesNotMatch(initial, /• e m t/);
			assert.match(initial, /\[Enter\] Run • \[Esc\] Cancel/);
			if (mode === "single") {
				assert.match(initial, /\[w\]Output/);
				assert.doesNotMatch(initial, /\[↑↓\] Navigate/);
			} else {
				assert.match(initial, /\[↑↓\] Navigate/);
			}
			if (mode === "chain") {
				assert.match(initial, /\[w\]Output/);
				assert.match(initial, /\[r\]Reads/);
				assert.match(initial, /\[p\]Prog/);
			} else if (mode === "parallel") {
				assert.doesNotMatch(initial, /\[w\]Output|\[r\]Reads|\[p\]Prog/);
			}
			for (const line of initialLines) {
				assert.equal(visibleWidth(line), 84, `${mode} line did not match component width: ${line}`);
			}

			component.handleInput("b");
			assert.match(component.render(84).map(stripAnsi).join("\n"), /\[b\]Background:ON/);
		}
	});
});
