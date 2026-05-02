import * as fs from "node:fs";
import * as path from "node:path";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
	buildBuiltinOverrideConfig,
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
	buildRuntimeName,
	discoverAgentsAll,
	frontmatterNameForConfig,
	removeBuiltinAgentOverride,
	saveBuiltinAgentOverride,
	type AgentConfig,
	type BuiltinAgentOverrideBase,
	type ChainConfig,
} from "../agents/agents.ts";
import { serializeAgent } from "../agents/agent-serializer.ts";
import { TEMPLATE_ITEMS, type AgentTemplate, type TemplateItem } from "../agents/agent-templates.ts";
import { parseChain, serializeChain } from "../agents/chain-serializer.ts";
import { DEFAULT_AGENT_MANAGER_NEW_SHORTCUT, renderList, handleListInput, type ListAgent, type ListShortcuts, type ListState, type ListAction } from "./agent-manager-list.ts";
import { createParallelState, handleParallelInput, renderParallel, formatParallelTitle, type ParallelState, type AgentOption } from "./agent-manager-parallel.ts";
import { renderDetail, handleDetailInput, renderTaskInput, type DetailState, type DetailAction, type LaunchToggleState } from "./agent-manager-detail.ts";
import { renderChainDetail, handleChainDetailInput, type ChainDetailAction, type ChainDetailState } from "./agent-manager-chain-detail.ts";
import { createEditState, handleEditInput, renderEdit, type EditField, type EditScreen, type EditState, type ModelInfo, type SkillInfo } from "./agent-manager-edit.ts";
import { createEditorState, ensureCursorVisible, getCursorDisplayPos, handleEditorInput, renderEditor, wrapText } from "../tui/text-editor.ts";
import type { TextEditorState } from "../tui/text-editor.ts";
import { loadRunsForAgent } from "../runs/shared/run-history.ts";
import { pad, row, renderHeader, renderFooter } from "../tui/render-helpers.ts";
import { isParallelStep, type ChainStep } from "../shared/settings.ts";

export type ManagerResult =
	| { action: "launch"; agent: string; task: string; skipClarify?: boolean; fork?: boolean; background?: boolean }
	| { action: "chain"; agents: string[]; task: string; skipClarify?: boolean; fork?: boolean; background?: boolean }
	| { action: "parallel"; tasks: Array<{ agent: string; task: string }>; skipClarify?: boolean; fork?: boolean; background?: boolean; worktree?: boolean }
	| { action: "launch-chain"; chain: ChainConfig; task: string; skipClarify?: boolean; fork?: boolean; background?: boolean; worktree?: boolean }
	| undefined;

export interface AgentData { builtin: AgentConfig[]; user: AgentConfig[]; project: AgentConfig[]; chains: ChainConfig[]; userDir: string; projectDir: string | null; userSettingsPath: string; projectSettingsPath: string | null; cwd: string; }
type ManagerScreen = "list" | "detail" | "chain-detail" | "edit" | "edit-field" | "edit-prompt" | "task-input" | "confirm-delete" | "name-input" | "chain-edit" | "template-select" | "parallel-builder" | "override-scope";
interface AgentEntry { id: string; kind: "agent"; config: AgentConfig; isNew: boolean; }
interface ChainEntry { id: string; kind: "chain"; config: ChainConfig; }
interface NameInputState { mode: "new-agent" | "clone-agent" | "clone-chain" | "new-chain"; editor: TextEditorState; scope: "user" | "project"; allowProject: boolean; sourceId?: string; template?: AgentTemplate; error?: string; }
interface StatusMessage { text: string; type: "error" | "info"; }
interface OverrideScopeState { selectedScope: "user" | "project"; allowProject: boolean; }
export interface AgentManagerOptions { newShortcut?: string; preferredModelProvider?: string; }

const BUILTIN_OVERRIDE_FIELDS: EditField[] = ["model", "fallbackModels", "thinking", "systemPromptMode", "inheritProjectContext", "inheritSkills", "defaultContext", "disabled", "tools", "skills", "prompt"];

function cloneConfig(config: AgentConfig): AgentConfig {
	return {
		...config,
		tools: config.tools ? [...config.tools] : undefined,
		mcpDirectTools: config.mcpDirectTools ? [...config.mcpDirectTools] : undefined,
		skills: config.skills ? [...config.skills] : undefined,
		fallbackModels: config.fallbackModels ? [...config.fallbackModels] : undefined,
		defaultReads: config.defaultReads ? [...config.defaultReads] : undefined,
		extraFields: config.extraFields ? { ...config.extraFields } : undefined,
		override: config.override
			? {
				...config.override,
				base: {
					...config.override.base,
					disabled: config.override.base.disabled,
					defaultContext: config.override.base.defaultContext,
					fallbackModels: config.override.base.fallbackModels ? [...config.override.base.fallbackModels] : undefined,
					skills: config.override.base.skills ? [...config.override.base.skills] : undefined,
					tools: config.override.base.tools ? [...config.override.base.tools] : undefined,
					mcpDirectTools: config.override.base.mcpDirectTools ? [...config.override.base.mcpDirectTools] : undefined,
				},
			}
			: undefined,
	};
}
function cloneChainConfig(config: ChainConfig): ChainConfig {
	const steps = (config.steps as unknown as ChainStep[]).map((step) => {
		if (isParallelStep(step)) {
			return {
				...step,
				parallel: step.parallel.map((task) => ({
					...task,
					reads: Array.isArray(task.reads) ? [...task.reads] : task.reads,
					skill: Array.isArray(task.skill) ? [...task.skill] : task.skill,
				})),
			};
		}
		return {
			...step,
			reads: Array.isArray(step.reads) ? [...step.reads] : step.reads,
			...(Array.isArray((step as typeof step & { skills?: string[] | false }).skills) ? { skills: [...(step as typeof step & { skills: string[] }).skills] } : { skills: (step as typeof step & { skills?: false }).skills }),
			...(Array.isArray(step.skill) ? { skill: [...step.skill] } : { skill: step.skill }),
		};
	});
	return { ...config, steps: steps as unknown as ChainConfig["steps"], extraFields: config.extraFields ? { ...config.extraFields } : undefined };
}
function slugTemplateName(name: string): string { return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function nextSelectableIndex(items: TemplateItem[], current: number, direction: 1 | -1): number { let next = current + direction; while (next >= 0 && next < items.length && items[next]!.type === "separator") next += direction; if (next < 0 || next >= items.length) return current; return next; }
const CHAIN_EDIT_VIEWPORT = 10;

export class AgentManagerComponent implements Component {
	private overlayWidth = 84;
	private screen: ManagerScreen = "list";
	private agents: AgentEntry[] = [];
	private chains: ChainEntry[] = [];
	private listState: ListState = { cursor: 0, scrollOffset: 0, filterQuery: "", selected: [] };
	private detailState: DetailState = { resolved: true, scrollOffset: 0 };
	private chainDetailState: ChainDetailState = { scrollOffset: 0 };
	private editState: EditState | null = null;
	private currentAgentId: string | null = null;
	private currentChainId: string | null = null;
	private confirmDeleteId: string | null = null;
	private nameInputState: NameInputState | null = null;
	private chainEditState: { editor: TextEditorState; error?: string } | null = null;
	private taskEditor: TextEditorState = createEditorState();
	private skipClarify = false;
	private launchFork = false;
	private launchBackground = false;
	private launchWorktree = false;
	private chainAgentIds: string[] = [];
	private chainLaunchId: string | null = null;
	private parallelMode = false;
	private parallelState: ParallelState | null = null;
	private taskBackScreen: ManagerScreen = "list";
	private templateCursor = 0;
	private statusMessage?: StatusMessage;
	private overrideScopeState: OverrideScopeState | null = null;
	private builtinOverrideScope: "user" | "project" | null = null;
	private nextId = 1;
	private tui: TUI;
	private theme: Theme;
	private agentData: AgentData;
	private models: ModelInfo[];
	private skills: SkillInfo[];
	private done: (result: ManagerResult) => void;
	private shortcuts: ListShortcuts;
	private preferredModelProvider: string | undefined;

	constructor(tui: TUI, theme: Theme, agentData: AgentData, models: ModelInfo[], skills: SkillInfo[], done: (result: ManagerResult) => void, options: AgentManagerOptions = {}) {
		this.tui = tui;
		this.theme = theme;
		this.agentData = agentData;
		this.models = models;
		this.skills = skills;
		this.done = done;
		this.shortcuts = { newShortcut: options.newShortcut?.trim() || DEFAULT_AGENT_MANAGER_NEW_SHORTCUT };
		this.preferredModelProvider = options.preferredModelProvider;
		this.loadEntries();
	}

	private loadEntries(): void {
		const overridden = new Set([...this.agentData.user, ...this.agentData.project].map((c) => c.name));
		const agents: AgentEntry[] = []; for (const config of this.agentData.builtin) { if (!overridden.has(config.name)) agents.push({ id: `a${this.nextId++}`, kind: "agent", config: cloneConfig(config), isNew: false }); } for (const config of this.agentData.user) agents.push({ id: `a${this.nextId++}`, kind: "agent", config: cloneConfig(config), isNew: false }); for (const config of this.agentData.project) agents.push({ id: `a${this.nextId++}`, kind: "agent", config: cloneConfig(config), isNew: false }); this.agents = agents;
		const chains: ChainEntry[] = []; for (const config of this.agentData.chains) chains.push({ id: `c${this.nextId++}`, kind: "chain", config: cloneChainConfig(config) }); this.chains = chains;
	}

	private getAgentEntry(id: string | null): AgentEntry | undefined { if (!id) return undefined; return this.agents.find((entry) => entry.id === id); }
	private getChainEntry(id: string | null): ChainEntry | undefined { if (!id) return undefined; return this.chains.find((entry) => entry.id === id); }
	private listAgents(): ListAgent[] { const a = this.agents.map((entry) => ({ id: entry.id, name: entry.config.name, description: entry.config.description, model: entry.config.model, source: entry.config.source, overrideScope: entry.config.override?.scope, disabled: entry.config.disabled, kind: "agent" as const })); const c = this.chains.map((entry) => ({ id: entry.id, name: entry.config.name, description: entry.config.description, source: entry.config.source, kind: "chain" as const, stepCount: entry.config.steps.length })); return [...a, ...c]; }
	private clearStatus(): void { this.statusMessage = undefined; }
	private disabledAgentEntries(ids: string[]): AgentEntry[] { return ids.map((id) => this.getAgentEntry(id)).filter((entry): entry is AgentEntry => Boolean(entry?.config.disabled)); }

	private resolveBuiltinOverrideBase(entry: AgentEntry): BuiltinAgentOverrideBase {
		if (entry.config.override) return entry.config.override.base;
		return {
			model: entry.config.model,
			fallbackModels: entry.config.fallbackModels ? [...entry.config.fallbackModels] : undefined,
			thinking: entry.config.thinking,
			systemPromptMode: entry.config.systemPromptMode,
			inheritProjectContext: entry.config.inheritProjectContext,
			inheritSkills: entry.config.inheritSkills,
			defaultContext: entry.config.defaultContext,
			disabled: entry.config.disabled,
			systemPrompt: entry.config.systemPrompt,
			skills: entry.config.skills ? [...entry.config.skills] : undefined,
			tools: entry.config.tools ? [...entry.config.tools] : undefined,
			mcpDirectTools: entry.config.mcpDirectTools ? [...entry.config.mcpDirectTools] : undefined,
		};
	}

	private refreshAgentData(agentName?: string, chainName?: string): void {
		this.agentData = { ...discoverAgentsAll(this.agentData.cwd), cwd: this.agentData.cwd };
		this.nextId = 1;
		this.loadEntries();
		if (agentName) {
			const entry = this.agents.find((candidate) => candidate.config.name === agentName);
			this.currentAgentId = entry?.id ?? null;
		}
		if (chainName) {
			const entry = this.chains.find((candidate) => candidate.config.name === chainName);
			this.currentChainId = entry?.id ?? null;
		}
	}

	private removeAgentEntry(entry: AgentEntry): void { this.agents = this.agents.filter((e) => e.id !== entry.id); this.listState.selected = this.listState.selected.filter((id) => id !== entry.id); }
	private removeChainEntry(entry: ChainEntry): void { this.chains = this.chains.filter((e) => e.id !== entry.id); }

	private enterDetail(entry: AgentEntry): void { this.currentAgentId = entry.id; this.detailState = { resolved: true, scrollOffset: 0, recentRuns: loadRunsForAgent(entry.config.name).slice(0, 5) }; this.screen = "detail"; }
	private enterChainDetail(entry: ChainEntry): void { this.currentChainId = entry.id; this.chainDetailState = { scrollOffset: 0 }; this.screen = "chain-detail"; }
	private enterEdit(entry: AgentEntry): void { this.currentAgentId = entry.id; this.builtinOverrideScope = null; this.editState = createEditState(entry.config, entry.isNew, this.models, this.skills, { preferredProvider: this.preferredModelProvider }); this.screen = "edit"; }
	private enterBuiltinOverrideScope(entry: AgentEntry): void {
		this.currentAgentId = entry.id;
		this.overrideScopeState = { selectedScope: this.agentData.projectSettingsPath ? "project" : "user", allowProject: Boolean(this.agentData.projectSettingsPath) };
		this.screen = "override-scope";
	}
	private enterBuiltinOverrideEdit(entry: AgentEntry, scope: "user" | "project"): void {
		this.currentAgentId = entry.id;
		this.builtinOverrideScope = scope;
		this.editState = createEditState(entry.config, false, this.models, this.skills, {
			fields: BUILTIN_OVERRIDE_FIELDS,
			title: `Builtin Override: ${entry.config.name} [${scope}]`,
			overrideBase: this.resolveBuiltinOverrideBase(entry),
			preferredProvider: this.preferredModelProvider,
		});
		this.screen = "edit";
	}
	private enterParallelBuilder(ids: string[]): void {
		const names = ids.map((id) => this.getAgentEntry(id)?.config.name).filter((n): n is string => Boolean(n));
		if (names.length === 0) return;
		this.parallelState = createParallelState(names);
		this.screen = "parallel-builder";
	}
	private resetLaunchToggles(): void { this.launchFork = false; this.launchBackground = false; this.launchWorktree = false; }
	private enterParallelTaskInput(): void {
		this.chainAgentIds = [];
		this.chainLaunchId = null;
		this.parallelMode = true;
		this.taskBackScreen = "parallel-builder";
		this.taskEditor = createEditorState();
		this.skipClarify = true;
		this.resetLaunchToggles();
		this.screen = "task-input";
	}
	private enterTaskInput(ids: string[], backScreen: ManagerScreen = "list"): void {
		this.chainAgentIds = ids; this.chainLaunchId = null; this.parallelMode = false; this.taskBackScreen = backScreen; this.taskEditor = createEditorState(); this.skipClarify = true; this.resetLaunchToggles(); this.screen = "task-input";
	}
	private enterSavedChainLaunch(entry: ChainEntry): void { this.chainLaunchId = entry.id; this.chainAgentIds = []; this.parallelMode = false; this.taskBackScreen = "chain-detail"; this.taskEditor = createEditorState(); this.skipClarify = true; this.resetLaunchToggles(); this.screen = "task-input"; }
	private enterTemplateSelect(): void { this.templateCursor = TEMPLATE_ITEMS.findIndex((item) => item.type !== "separator"); if (this.templateCursor < 0) this.templateCursor = 0; this.screen = "template-select"; }

	private enterChainEdit(entry: ChainEntry): void {
		try { const content = fs.readFileSync(entry.config.filePath, "utf-8"); this.currentChainId = entry.id; this.chainEditState = { editor: createEditorState(content) }; this.screen = "chain-edit"; }
		catch (err) { this.statusMessage = { text: err instanceof Error ? err.message : "Failed to load chain file.", type: "error" }; this.screen = "list"; }
	}

	private runtimeNameExistsInScope(kind: "agent" | "chain", scope: "user" | "project", name: string, excludePath?: string): boolean {
		const discovered = discoverAgentsAll(this.agentData.cwd);
		if (kind === "agent") {
			const agents = scope === "user" ? discovered.user : discovered.project;
			return agents.some((agent) => agent.name === name && agent.filePath !== excludePath);
		}
		return discovered.chains.some((chain) => chain.source === scope && chain.name === name && chain.filePath !== excludePath);
	}

	private enterNameInput(mode: NameInputState["mode"], sourceId?: string, template?: AgentTemplate): void {
		const allowProject = Boolean(this.agentData.projectDir); let initial = ""; let scope: "user" | "project" = "user";
		if (mode === "clone-agent" && sourceId) { const entry = this.getAgentEntry(sourceId); if (entry) { initial = `${frontmatterNameForConfig(entry.config)}-copy`; scope = entry.config.source === "project" ? "project" : "user"; } }
		if (mode === "clone-chain" && sourceId) { const entry = this.getChainEntry(sourceId); if (entry) { initial = `${frontmatterNameForConfig(entry.config)}-copy`; scope = entry.config.source === "project" ? "project" : "user"; } }
		if (mode === "new-agent" && template && template.name !== "Blank") initial = slugTemplateName(template.name);
		this.nameInputState = { mode, editor: createEditorState(initial), scope, allowProject, sourceId, template }; this.screen = "name-input";
	}

	private saveEdit(): boolean {
		const edit = this.editState; if (!edit) return false; const entry = this.getAgentEntry(this.currentAgentId); if (!entry) return false;
		if (entry.config.source === "builtin") {
			const scope = entry.config.override?.scope ?? this.builtinOverrideScope;
			if (!scope) { edit.error = "Choose where to store the override first."; return false; }
			try {
				const override = buildBuiltinOverrideConfig(this.resolveBuiltinOverrideBase(entry), edit.draft);
				if (override) {
					saveBuiltinAgentOverride(this.agentData.cwd, entry.config.name, scope, override);
				} else {
					removeBuiltinAgentOverride(this.agentData.cwd, entry.config.name, scope);
				}
				this.refreshAgentData(entry.config.name);
				this.builtinOverrideScope = null;
				this.editState = null;
				const refreshed = this.getAgentEntry(this.currentAgentId);
				if (refreshed) this.enterDetail(refreshed);
				return true;
			} catch (err) {
				edit.error = err instanceof Error ? err.message : "Failed to save builtin override.";
				return false;
			}
		}
		let localName = frontmatterNameForConfig(edit.draft).trim();
		if (!edit.draft.packageName && edit.draft.name !== entry.config.name) localName = edit.draft.name.trim();
		if (!localName || !edit.draft.description) { edit.error = "Name and description are required."; return false; }
		edit.draft.localName = localName;
		edit.draft.name = buildRuntimeName(localName, edit.draft.packageName);
		const draftScope = edit.draft.source === "project" ? "project" : "user";
		if (this.runtimeNameExistsInScope("agent", draftScope, edit.draft.name, entry.config.filePath)) {
			edit.error = `An agent named '${edit.draft.name}' already exists in ${draftScope} scope.`;
			return false;
		}
		let filePath = entry.config.filePath;
		if (entry.isNew) {
			const dir = edit.draft.source === "project" ? this.agentData.projectDir : this.agentData.userDir;
			if (!dir) { edit.error = "Project agents directory not found."; return false; }
			filePath = path.join(dir, `${edit.draft.name}.md`);
			if (fs.existsSync(filePath)) { edit.error = "An agent with that name already exists."; return false; }
			fs.mkdirSync(dir, { recursive: true });
		} else if (edit.draft.name !== entry.config.name) {
			const nextPath = path.join(path.dirname(filePath), `${edit.draft.name}.md`);
			if (nextPath !== filePath && fs.existsSync(nextPath)) {
				edit.error = "An agent with that name already exists.";
				return false;
			}
			if (nextPath !== filePath) {
				fs.renameSync(filePath, nextPath);
				filePath = nextPath;
			}
		}
		try { const toSave: AgentConfig = { ...edit.draft, filePath }; fs.writeFileSync(filePath, serializeAgent(toSave), "utf-8"); entry.config = cloneConfig(toSave); entry.isNew = false; edit.error = undefined; return true; }
		catch (err) { edit.error = err instanceof Error ? err.message : "Failed to save agent."; return false; }
	}

	private removeBuiltinOverride(): boolean {
		const edit = this.editState; if (!edit) return false; const entry = this.getAgentEntry(this.currentAgentId); if (!entry || entry.config.source !== "builtin") return false;
		const scope = entry.config.override?.scope ?? this.builtinOverrideScope;
		if (!scope) { edit.error = "No builtin override to remove."; return false; }
		try {
			removeBuiltinAgentOverride(this.agentData.cwd, entry.config.name, scope);
			this.refreshAgentData(entry.config.name);
			this.builtinOverrideScope = null;
			this.editState = null;
			const refreshed = this.getAgentEntry(this.currentAgentId);
			if (refreshed) this.enterDetail(refreshed);
			return true;
		} catch (err) {
			edit.error = err instanceof Error ? err.message : "Failed to remove builtin override.";
			return false;
		}
	}

	private saveChainEdit(): boolean {
		const state = this.chainEditState; const entry = this.getChainEntry(this.currentChainId); if (!state || !entry) return false;
		try { const parsed = parseChain(state.editor.buffer, entry.config.source, entry.config.filePath); fs.writeFileSync(entry.config.filePath, serializeChain(parsed), "utf-8"); entry.config = parsed; state.error = undefined; return true; }
		catch (err) { state.error = err instanceof Error ? err.message : "Failed to save chain."; return false; }
	}

	private canToggleLaunchWorktree(): boolean {
		if (this.parallelMode && this.parallelState) return true;
		if (!this.chainLaunchId) return false;
		const chainEntry = this.getChainEntry(this.chainLaunchId);
		return chainEntry ? (chainEntry.config.steps as unknown as ChainStep[]).some(isParallelStep) : false;
	}
	private launchFlags(): { fork?: boolean; background?: boolean; worktree?: boolean } {
		return {
			...(this.launchFork ? { fork: true } : {}),
			...(this.launchBackground ? { background: true } : {}),
			...(this.launchWorktree && this.canToggleLaunchWorktree() ? { worktree: true } : {}),
		};
	}
	private launchToggleState(): LaunchToggleState {
		return {
			fork: this.launchFork,
			background: this.launchBackground,
			...(this.canToggleLaunchWorktree() ? { worktree: this.launchWorktree } : {}),
		};
	}

	private handleTemplateSelectInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.screen = "list"; this.tui.requestRender(); return; }
		if (matchesKey(data, "up")) { this.templateCursor = nextSelectableIndex(TEMPLATE_ITEMS, this.templateCursor, -1); this.tui.requestRender(); return; }
		if (matchesKey(data, "down")) { this.templateCursor = nextSelectableIndex(TEMPLATE_ITEMS, this.templateCursor, 1); this.tui.requestRender(); return; }
		if (matchesKey(data, "return")) {
			const item = TEMPLATE_ITEMS[this.templateCursor];
			if (!item || item.type === "separator") return;
			if (item.type === "agent") this.enterNameInput("new-agent", undefined, { name: item.name, config: item.config });
			else if (item.type === "chain") this.enterNameInput("new-chain");
			this.tui.requestRender();
		}
	}

	private handleOverrideScopeInput(data: string): void {
		const state = this.overrideScopeState;
		const entry = this.getAgentEntry(this.currentAgentId);
		if (!state || !entry) {
			this.screen = "detail";
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.overrideScopeState = null;
			this.enterDetail(entry);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "tab") || matchesKey(data, "up") || matchesKey(data, "down")) {
			if (state.allowProject) state.selectedScope = state.selectedScope === "user" ? "project" : "user";
			this.tui.requestRender();
			return;
		}

		if (data === "u") {
			state.selectedScope = "user";
			this.tui.requestRender();
			return;
		}

		if (data === "p" && state.allowProject) {
			state.selectedScope = "project";
			this.tui.requestRender();
			return;
		}

		if (!matchesKey(data, "return")) return;
		this.overrideScopeState = null;
		this.enterBuiltinOverrideEdit(entry, state.selectedScope);
		this.tui.requestRender();
	}

	private handleNameInput(data: string): void {
		const state = this.nameInputState; if (!state) return; state.error = undefined;
		const canToggleScope = state.allowProject;
		if (matchesKey(data, "tab")) { if (canToggleScope) { state.scope = state.scope === "user" ? "project" : "user"; this.tui.requestRender(); } return; }
		const innerW = this.overlayWidth - 2; const boxInnerWidth = Math.max(10, innerW - 4);
		const nextState = handleEditorInput(state.editor, data, boxInnerWidth); if (nextState) { state.editor = nextState; this.tui.requestRender(); return; }
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.nameInputState = null; this.screen = "list"; this.tui.requestRender(); return; }
		if (!matchesKey(data, "return")) return;
		const name = state.editor.buffer.trim(); if (!name) { state.error = "Name is required."; this.tui.requestRender(); return; }

		if (state.mode === "clone-chain" && state.sourceId) {
			const sourceEntry = this.getChainEntry(state.sourceId); if (!sourceEntry) { this.screen = "list"; this.tui.requestRender(); return; }
			const dir = state.scope === "project" ? this.agentData.projectDir : this.agentData.userDir;
			if (!dir) { state.error = "Project agents directory not found."; this.tui.requestRender(); return; }
			const filePath = path.join(dir, `${name}.chain.md`); if (fs.existsSync(filePath) || this.runtimeNameExistsInScope("chain", state.scope, name)) { state.error = "A chain with that name already exists."; this.tui.requestRender(); return; }
			try { const cloned = cloneChainConfig({ ...sourceEntry.config, name, localName: name, packageName: undefined, source: state.scope, filePath }); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(filePath, serializeChain(cloned), "utf-8"); const added: ChainEntry = { id: `c${this.nextId++}`, kind: "chain", config: cloned }; this.chains.push(added); this.nameInputState = null; this.enterChainDetail(added); this.tui.requestRender(); return; }
			catch (err) { state.error = err instanceof Error ? err.message : "Failed to clone chain."; this.tui.requestRender(); return; }
		}
		if (state.mode === "new-chain") {
			const dir = state.scope === "project" ? this.agentData.projectDir : this.agentData.userDir;
			if (!dir) { state.error = "Directory not found."; this.tui.requestRender(); return; }
			const filePath = path.join(dir, `${name}.chain.md`); if (fs.existsSync(filePath) || this.runtimeNameExistsInScope("chain", state.scope, name)) { state.error = "A chain with that name already exists."; this.tui.requestRender(); return; }
			const config: ChainConfig = { name, localName: name, description: "Describe this chain", source: state.scope, filePath, steps: [{ agent: "agent-name", task: "{task}" }] };
			try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(filePath, serializeChain(config), "utf-8"); const entry: ChainEntry = { id: `c${this.nextId++}`, kind: "chain", config }; this.chains.push(entry); this.nameInputState = null; this.enterChainEdit(entry); }
			catch (err) { state.error = err instanceof Error ? err.message : "Failed to create chain."; }
			this.tui.requestRender(); return;
		}

		let baseConfig: AgentConfig;
		if (state.mode === "clone-agent" && state.sourceId) {
			const sourceEntry = this.getAgentEntry(state.sourceId); if (!sourceEntry) { this.screen = "list"; this.tui.requestRender(); return; }
			baseConfig = cloneConfig(sourceEntry.config);
		} else {
			const templateConfig = state.template?.config ?? {};
			baseConfig = {
				name,
				description: "Describe this agent",
				systemPrompt: "",
				systemPromptMode: defaultSystemPromptMode(name),
				inheritProjectContext: defaultInheritProjectContext(name),
				inheritSkills: defaultInheritSkills(),
				source: state.scope,
				filePath: "",
				...templateConfig,
			};
		}
		const dir = state.scope === "project" ? this.agentData.projectDir : this.agentData.userDir;
		if (!dir) { state.error = "Project agents directory not found."; this.tui.requestRender(); return; }
		const filePath = path.join(dir, `${name}.md`); const config: AgentConfig = { ...baseConfig, name, localName: name, packageName: undefined, source: state.scope, filePath };
		const entry: AgentEntry = { id: `a${this.nextId++}`, kind: "agent", config, isNew: true };
		this.agents.push(entry); this.nameInputState = null; this.enterEdit(entry); this.tui.requestRender();
	}

	private renderNameInput(w: number): string[] {
		const state = this.nameInputState; if (!state) return [];
		const lines: string[] = []; const title = state.mode === "new-agent" ? "New Agent" : state.mode === "clone-agent" ? "Clone Agent" : state.mode === "new-chain" ? "New Chain" : "Clone Chain";
		lines.push(renderHeader(` ${title} `, w, this.theme)); lines.push(row("", w, this.theme)); lines.push(row(` ${this.theme.fg("dim", "Name:")}`, w, this.theme));
		const innerW = w - 2; const boxInnerWidth = Math.max(10, innerW - 4); const top = `┌${"─".repeat(boxInnerWidth)}┐`; const bottom = `└${"─".repeat(boxInnerWidth)}┘`;
		lines.push(row(` ${top}`, w, this.theme));
		const editorState = { ...state.editor }; const wrapped = wrapText(editorState.buffer, boxInnerWidth); const cursorPos = getCursorDisplayPos(editorState.cursor, wrapped.starts); editorState.viewportOffset = ensureCursorVisible(cursorPos.line, 1, editorState.viewportOffset); const editorLine = renderEditor(editorState, boxInnerWidth, 1)[0] ?? "";
		lines.push(row(` │${pad(editorLine, boxInnerWidth)}│`, w, this.theme)); lines.push(row(` ${bottom}`, w, this.theme));
		if (state.mode === "new-agent" && state.template) lines.push(row(` ${this.theme.fg("dim", "Template:")} ${state.template.name}`, w, this.theme));
		else if (state.mode === "new-chain") lines.push(row(` ${this.theme.fg("dim", "Creates a .chain.md configuration file")}`, w, this.theme));
		else lines.push(row("", w, this.theme));
		if (state.allowProject) { const scopeLabel = state.scope === "user" ? "[user]" : "[proj]"; lines.push(row(` ${this.theme.fg("dim", "Scope:")} ${scopeLabel}  ${this.theme.fg("dim", "[tab] toggle")}`, w, this.theme)); }
		else lines.push(row("", w, this.theme));
		if (state.error) lines.push(row(` ${this.theme.fg("error", state.error)}`, w, this.theme)); else lines.push(row("", w, this.theme));
		lines.push(renderFooter(" [enter] continue  [esc] cancel ", w, this.theme)); return lines;
	}

	private renderOverrideScope(w: number): string[] {
		const state = this.overrideScopeState;
		const entry = this.getAgentEntry(this.currentAgentId);
		if (!state || !entry) return [];
		const lines: string[] = [];
		lines.push(renderHeader(` Create Override: ${entry.config.name} `, w, this.theme));
		lines.push(row("", w, this.theme));
		lines.push(row(` ${this.theme.fg("dim", "Where should this builtin override live?")}`, w, this.theme));
		lines.push(row("", w, this.theme));
		const userLine = state.selectedScope === "user" ? this.theme.fg("accent", "▸ user") : "  user";
		lines.push(row(` ${userLine}${this.theme.fg("dim", `  ${this.agentData.userSettingsPath}`)}`, w, this.theme));
		if (state.allowProject) {
			const projectPath = this.agentData.projectSettingsPath ?? ".pi/settings.json";
			const projectLine = state.selectedScope === "project" ? this.theme.fg("accent", "▸ project") : "  project";
			lines.push(row(` ${projectLine}${this.theme.fg("dim", `  ${projectPath}`)}`, w, this.theme));
		}
		while (lines.length < 8) lines.push(row("", w, this.theme));
		lines.push(renderFooter(" [enter] continue  [↑↓/tab] choose  [esc] cancel ", w, this.theme));
		return lines;
	}

	private renderTemplateSelect(w: number): string[] {
		const lines: string[] = []; lines.push(renderHeader(" Select Template ", w, this.theme)); lines.push(row("", w, this.theme));
		const innerW = w - 2; const viewport = 12; const start = Math.max(0, Math.min(this.templateCursor - Math.floor(viewport / 2), Math.max(0, TEMPLATE_ITEMS.length - viewport))); const visible = TEMPLATE_ITEMS.slice(start, start + viewport);
		for (let i = 0; i < visible.length; i++) {
			const idx = start + i; const item = visible[i]!;
			if (item.type === "separator") {
				const label = `── ${item.label} `;
				lines.push(row(` ${this.theme.fg("dim", label + "─".repeat(Math.max(0, innerW - 1 - visibleWidth(label))))}`, w, this.theme));
			} else {
				const isCursor = idx === this.templateCursor; const cursor = isCursor ? this.theme.fg("accent", "▸") : " ";
				const name = isCursor ? this.theme.fg("accent", item.name) : item.name; const desc = item.type === "agent" ? (item.config.description ?? "") : item.description;
				lines.push(row(` ${cursor} ${pad(name, 16)} ${this.theme.fg("dim", truncateToWidth(desc, Math.max(0, innerW - 24)))}`, w, this.theme));
			}
		}
		for (let i = visible.length; i < viewport; i++) lines.push(row("", w, this.theme));
		const selected = TEMPLATE_ITEMS[this.templateCursor]; const info = selected ? selected.type === "separator" ? selected.label : selected.name : "";
		lines.push(row(` ${this.theme.fg("dim", info)}`, w, this.theme));
		lines.push(renderFooter(" [enter] select  [esc] cancel  [↑↓] navigate ", w, this.theme)); return lines;
	}

	private renderConfirmDelete(w: number): string[] {
		const agent = this.getAgentEntry(this.confirmDeleteId); const chain = this.getChainEntry(this.confirmDeleteId); const name = agent?.config.name ?? chain?.config.name ?? ""; const filePath = agent?.config.filePath ?? chain?.config.filePath ?? "";
		const lines: string[] = []; lines.push(renderHeader(` Delete "${name}"? `, w, this.theme)); lines.push(row("", w, this.theme)); const label = "File: "; const maxPath = Math.max(0, w - 2 - label.length - 1); const trimmed = truncateToWidth(filePath, maxPath);
		lines.push(row(` ${label}${trimmed}`, w, this.theme)); lines.push(row("", w, this.theme)); lines.push(row(` ${this.theme.fg("warning", "This cannot be undone.")}`, w, this.theme)); lines.push(row("", w, this.theme)); lines.push(renderFooter(" [y] confirm  [n / esc] cancel ", w, this.theme)); return lines;
	}

	private renderChainEdit(w: number): string[] {
		const state = this.chainEditState; const entry = this.getChainEntry(this.currentChainId); if (!state || !entry) return [];
		const lines: string[] = []; lines.push(renderHeader(` Edit Chain: ${entry.config.name} `, w, this.theme)); lines.push(row("", w, this.theme));
		const innerW = w - 2; const boxInnerWidth = Math.max(10, innerW - 4); const top = `┌${"─".repeat(boxInnerWidth)}┐`; const bottom = `└${"─".repeat(boxInnerWidth)}┘`;
		lines.push(row(` ${top}`, w, this.theme));
		const editorState = { ...state.editor }; const wrapped = wrapText(editorState.buffer, boxInnerWidth); const cursorPos = getCursorDisplayPos(editorState.cursor, wrapped.starts); editorState.viewportOffset = ensureCursorVisible(cursorPos.line, CHAIN_EDIT_VIEWPORT, editorState.viewportOffset); const editorLines = renderEditor(editorState, boxInnerWidth, CHAIN_EDIT_VIEWPORT);
		for (const line of editorLines) lines.push(row(` │${pad(line, boxInnerWidth)}│`, w, this.theme));
		lines.push(row(` ${bottom}`, w, this.theme)); if (state.error) lines.push(row(` ${this.theme.fg("error", state.error)}`, w, this.theme)); else lines.push(row("", w, this.theme)); lines.push(renderFooter(" [ctrl+s] save  [esc] back ", w, this.theme)); return lines;
	}

	handleInput(data: string): void {
		if (this.screen === "list" && this.statusMessage) this.clearStatus();
		if (this.screen.startsWith("edit") && this.editState?.error) this.editState.error = undefined;
		switch (this.screen) {
			case "list": { const action = handleListInput(this.listState, this.listAgents(), data, this.shortcuts); if (action) this.handleListAction(action); this.tui.requestRender(); return; }
			case "template-select": this.handleTemplateSelectInput(data); return;
			case "override-scope": this.handleOverrideScopeInput(data); return;
			case "detail": {
				const entry = this.getAgentEntry(this.currentAgentId); if (!entry) { this.screen = "list"; this.tui.requestRender(); return; }
				const action = handleDetailInput(this.detailState, data); if (action) this.handleDetailAction(action, entry); this.tui.requestRender(); return;
			}
			case "chain-detail": {
				const entry = this.getChainEntry(this.currentChainId); if (!entry) { this.screen = "list"; this.tui.requestRender(); return; }
				const action = handleChainDetailInput(this.chainDetailState, data); if (action) this.handleChainDetailAction(action, entry); this.tui.requestRender(); return;
			}
			case "parallel-builder": {
				if (!this.parallelState) { this.screen = "list"; this.tui.requestRender(); return; }
				const agentOptions: AgentOption[] = this.agents.map((e) => ({ name: e.config.name, description: e.config.description, model: e.config.model }));
				const pAction = handleParallelInput(this.parallelState, agentOptions, data, this.overlayWidth);
				if (pAction?.type === "proceed") {
					this.enterParallelTaskInput();
				} else if (pAction?.type === "back") {
					this.parallelState = null;
					this.parallelMode = false;
					this.screen = "list";
				}
				this.tui.requestRender();
				return;
			}
			case "task-input": {
				if (matchesKey(data, "tab")) { this.skipClarify = !this.skipClarify; this.tui.requestRender(); return; }
				if (matchesKey(data, "ctrl+f")) { this.launchFork = !this.launchFork; this.tui.requestRender(); return; }
				if (matchesKey(data, "ctrl+b")) { this.launchBackground = !this.launchBackground; this.tui.requestRender(); return; }
				if (matchesKey(data, "ctrl+w") && this.canToggleLaunchWorktree()) { this.launchWorktree = !this.launchWorktree; this.tui.requestRender(); return; }
				const innerW = this.overlayWidth - 2; const boxInnerWidth = Math.max(10, innerW - 4); const nextState = handleEditorInput(this.taskEditor, data, boxInnerWidth);
				if (nextState) { this.taskEditor = nextState; this.tui.requestRender(); return; }
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.screen = this.taskBackScreen; this.tui.requestRender(); return; }
				if (matchesKey(data, "return")) {
					if (this.chainLaunchId) {
						const chainEntry = this.getChainEntry(this.chainLaunchId); if (!chainEntry) { this.screen = "list"; this.tui.requestRender(); return; }
						this.done({ action: "launch-chain", chain: cloneChainConfig(chainEntry.config), task: this.taskEditor.buffer, skipClarify: this.skipClarify, ...this.launchFlags() }); return;
					} else if (this.parallelMode && this.parallelState) {
						const sharedTask = this.taskEditor.buffer;
						const tasks = this.parallelState.slots.map((slot) => ({ agent: slot.agentName, task: slot.customTask || sharedTask }));
						this.done({ action: "parallel", tasks, skipClarify: this.skipClarify, ...this.launchFlags() }); return;
					}
					if (this.chainAgentIds.length > 1) {
						const agents = this.chainAgentIds
							.map((id) => this.getAgentEntry(id)?.config.name)
							.filter((name): name is string => Boolean(name));
						if (agents.length !== this.chainAgentIds.length) { this.screen = "list"; this.tui.requestRender(); return; }
						this.done({ action: "chain", agents, task: this.taskEditor.buffer, skipClarify: this.skipClarify, ...this.launchFlags() }); return;
					}
					const name = this.getAgentEntry(this.chainAgentIds[0] ?? null)?.config.name;
					if (!name) { this.screen = "list"; this.tui.requestRender(); return; }
					this.done({ action: "launch", agent: name, task: this.taskEditor.buffer, skipClarify: this.skipClarify, ...this.launchFlags() }); return;
				}
				return;
			}
			case "confirm-delete": {
				const agent = this.getAgentEntry(this.confirmDeleteId); const chain = this.getChainEntry(this.confirmDeleteId); if (!agent && !chain) { this.screen = "list"; this.tui.requestRender(); return; }
				if (data === "y" || data === "Y") {
					try { if (agent) { fs.unlinkSync(agent.config.filePath); this.removeAgentEntry(agent); } else if (chain) { fs.unlinkSync(chain.config.filePath); this.removeChainEntry(chain); } this.confirmDeleteId = null; this.screen = "list"; this.tui.requestRender(); return; }
					catch (err) { this.statusMessage = { text: err instanceof Error ? err.message : "Failed to delete item.", type: "error" }; this.confirmDeleteId = null; this.screen = "list"; this.tui.requestRender(); return; }
				}
				if (data === "n" || data === "N" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.confirmDeleteId = null; this.screen = "list"; this.tui.requestRender(); return; }
				return;
			}
			case "name-input": this.handleNameInput(data); return;
			case "chain-edit": {
				if (!this.chainEditState) { this.screen = "chain-detail"; this.tui.requestRender(); return; }
				if (matchesKey(data, "ctrl+s")) { this.saveChainEdit(); this.tui.requestRender(); return; }
				const innerW = this.overlayWidth - 2; const boxInnerWidth = Math.max(10, innerW - 4);
				if (matchesKey(data, "shift+up") || matchesKey(data, "pageup") || matchesKey(data, "shift+down") || matchesKey(data, "pagedown")) {
					const { lines: wrapped, starts } = wrapText(this.chainEditState.editor.buffer, boxInnerWidth); const cursorPos = getCursorDisplayPos(this.chainEditState.editor.cursor, starts);
					const dir = matchesKey(data, "shift+up") || matchesKey(data, "pageup") ? -1 : 1; const targetLine = Math.max(0, Math.min(wrapped.length - 1, cursorPos.line + dir * CHAIN_EDIT_VIEWPORT));
					const targetCol = Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0); this.chainEditState.editor = { ...this.chainEditState.editor, cursor: starts[targetLine] + targetCol }; this.tui.requestRender(); return;
				}
				const nextState = handleEditorInput(this.chainEditState.editor, data, boxInnerWidth, { multiLine: true });
				if (nextState) { this.chainEditState.editor = nextState; this.tui.requestRender(); return; }
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.chainEditState = null; this.screen = "chain-detail"; this.tui.requestRender(); return; }
				return;
			}
			case "edit": case "edit-field": case "edit-prompt": {
				if (!this.editState) { this.screen = "list"; this.tui.requestRender(); return; }
				const result = handleEditInput(this.screen as EditScreen, this.editState, data, this.overlayWidth, this.models, this.skills);
				if (result?.action === "discard") { this.handleEditDiscard(); return; }
				if (result?.action === "delete") { this.removeBuiltinOverride(); this.tui.requestRender(); return; }
				if (result?.action === "save") { const ok = this.saveEdit(); if (ok) { const entry = this.getAgentEntry(this.currentAgentId); if (entry) this.enterDetail(entry); } this.tui.requestRender(); return; }
				if (result?.nextScreen) this.screen = result.nextScreen; this.tui.requestRender(); return;
			}
		}
	}

	private handleEditDiscard(): void {
		const entry = this.getAgentEntry(this.currentAgentId); if (!entry) { this.screen = "list"; this.editState = null; this.builtinOverrideScope = null; this.tui.requestRender(); return; }
		if (entry.isNew) { this.removeAgentEntry(entry); this.editState = null; this.builtinOverrideScope = null; this.screen = "list"; this.tui.requestRender(); return; }
		this.editState = null; this.builtinOverrideScope = null; this.enterDetail(entry); this.tui.requestRender();
	}

	private isBuiltin(id: string): boolean { const a = this.getAgentEntry(id); return a?.config.source === "builtin"; }

	private handleListAction(action: ListAction): void {
		switch (action.type) {
			case "open-detail": { const agent = this.getAgentEntry(action.id); if (agent) { this.enterDetail(agent); return; } const chain = this.getChainEntry(action.id); if (chain) this.enterChainDetail(chain); return; }
			case "clone": if (this.getAgentEntry(action.id)) this.enterNameInput("clone-agent", action.id); else if (this.getChainEntry(action.id)) this.enterNameInput("clone-chain", action.id); return;
			case "new": this.enterTemplateSelect(); return;
			case "delete": { if (this.isBuiltin(action.id)) { this.statusMessage = { text: "Builtin agents cannot be deleted. Clone to user scope to override.", type: "error" }; return; } this.confirmDeleteId = action.id; this.screen = "confirm-delete"; return; }
			case "run-chain": {
				const disabled = this.disabledAgentEntries(action.ids);
				if (disabled.length > 0) {
					this.statusMessage = { text: `Disabled builtin agents cannot run: ${disabled.map((entry) => entry.config.name).join(", ")}. Edit the override to re-enable them.`, type: "error" };
					return;
				}
				this.enterTaskInput(action.ids);
				return;
			}
			case "run-parallel": {
				const disabled = this.disabledAgentEntries(action.ids);
				if (disabled.length > 0) {
					this.statusMessage = { text: `Disabled builtin agents cannot run: ${disabled.map((entry) => entry.config.name).join(", ")}. Edit the override to re-enable them.`, type: "error" };
					return;
				}
				this.enterParallelBuilder(action.ids);
				return;
			}
			case "close": this.done(undefined); return;
		}
	}

	private handleDetailAction(action: DetailAction, entry: AgentEntry): void {
		if (action.type === "back") { this.screen = "list"; return; }
		if (action.type === "edit") {
			if (entry.config.source === "builtin") {
				if (entry.config.override) this.enterBuiltinOverrideEdit(entry, entry.config.override.scope);
				else this.enterBuiltinOverrideScope(entry);
				return;
			}
			this.enterEdit(entry);
			return;
		}
		if (action.type === "launch") {
			if (entry.config.disabled) return;
			this.enterTaskInput([entry.id], "detail");
			return;
		}
	}

	private handleChainDetailAction(action: ChainDetailAction, entry: ChainEntry): void {
		if (action.type === "back") { this.screen = "list"; return; }
		if (action.type === "launch") { this.enterSavedChainLaunch(entry); return; }
		if (action.type === "edit") this.enterChainEdit(entry);
	}

	render(width: number): string[] {
		this.overlayWidth = width; const w = this.overlayWidth;
		switch (this.screen) {
			case "list": return renderList(this.listState, this.listAgents(), w, this.theme, this.statusMessage, this.shortcuts);
			case "template-select": return this.renderTemplateSelect(w);
			case "override-scope": return this.renderOverrideScope(w);
			case "detail": { const entry = this.getAgentEntry(this.currentAgentId); if (!entry) return renderList(this.listState, this.listAgents(), w, this.theme, this.statusMessage, this.shortcuts); return renderDetail(this.detailState, entry.config, this.agentData.cwd, w, this.theme); }
			case "chain-detail": { const entry = this.getChainEntry(this.currentChainId); if (!entry) return renderList(this.listState, this.listAgents(), w, this.theme, this.statusMessage, this.shortcuts); return renderChainDetail(this.chainDetailState, entry.config, w, this.theme); }
			case "edit": case "edit-field": case "edit-prompt": return this.editState ? renderEdit(this.screen as EditScreen, this.editState, w, this.theme) : [];
			case "parallel-builder": {
				if (!this.parallelState) return renderList(this.listState, this.listAgents(), w, this.theme, this.statusMessage, this.shortcuts);
				const agentOptions: AgentOption[] = this.agents.map((e) => ({ name: e.config.name, description: e.config.description, model: e.config.model }));
				return renderParallel(this.parallelState, agentOptions, w, this.theme);
			}
			case "task-input": {
				if (this.chainLaunchId) { const entry = this.getChainEntry(this.chainLaunchId); const title = entry ? `Chain: ${entry.config.name}` : "Chain"; return renderTaskInput(title, this.taskEditor, this.skipClarify, w, this.theme, this.launchToggleState()); }
				if (this.parallelMode && this.parallelState) return renderTaskInput(formatParallelTitle(this.parallelState.slots), this.taskEditor, this.skipClarify, w, this.theme, this.launchToggleState());
				if (this.chainAgentIds.length > 1) {
					const names = this.chainAgentIds
						.map((id) => this.getAgentEntry(id)?.config.name)
						.filter((name): name is string => Boolean(name));
					return renderTaskInput(`Chain: ${names.join(" → ")}`, this.taskEditor, this.skipClarify, w, this.theme, this.launchToggleState());
				}
				const name = this.getAgentEntry(this.chainAgentIds[0] ?? null)?.config.name ?? "Agent";
				return renderTaskInput(`Run: ${name}`, this.taskEditor, this.skipClarify, w, this.theme, this.launchToggleState());
			}
			case "confirm-delete": return this.renderConfirmDelete(w);
			case "name-input": return this.renderNameInput(w);
			case "chain-edit": return this.renderChainEdit(w);
		}
	}

	invalidate(): void {}
	dispose(): void {}
}
