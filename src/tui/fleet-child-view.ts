import { getMarkdownTheme, keyHint, type CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type SelectListTheme } from "@earendil-works/pi-tui";
import { getSupportedThinkingLevels, THINKING_LEVELS, type ModelInfo, type ThinkingLevel } from "../shared/model-info.ts";
import { parseThinkingLevel } from "../shared/thinking-ceiling.ts";
import { readStatus } from "../shared/utils.ts";
import type { ResolvedModelScope } from "../runs/shared/model-scope.ts";
import type { AsyncChildControlStatus } from "../runs/background/async-status.ts";
import { readFleetTranscript, renderFleetTranscript } from "./fleet-transcript.ts";

const REFRESH_MS = 750;

export interface FocusedChildTranscriptTarget {
	path: string;
	trustedRoots: string[];
	trustedFiles?: string[];
	trustedFileRoot?: string;
}

export interface FocusedChildTarget {
	key: string;
	runId: string;
	asyncDir: string;
	index: number;
	agent: string;
	transcript: FocusedChildTranscriptTarget;
	model?: string;
	thinking?: string;
	modelScopes: ResolvedModelScope[];
	thinkingCeiling?: ThinkingLevel;
	availableModels: ModelInfo[];
}

export interface FocusedChildActions {
	submit(message: string): Promise<{ requestId: string }>;
	setRuntime(request: { model?: string; thinking?: ThinkingLevel }): Promise<{ requestId: string }>;
}

type Theme = ExtensionContext["ui"]["theme"];
type ChildTui = { terminal?: { rows: number }; requestRender(): void };

type Picker = { kind: "model" | "thinking"; list: SelectList };
type PiKeybindings = { matches(data: string, keybinding: string): boolean };

function fitAnsi(value: string, width: number): string {
	const clipped = truncateToWidth(value, width);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function childRuntimeSnapshot(target: FocusedChildTarget): { control?: AsyncChildControlStatus; model?: string; thinking?: string } {
	const step = readStatus(target.asyncDir)?.steps?.[target.index];
	if (!step) return {};
	// SAFETY: the runner writes this optional projection from validated child-control acknowledgements.
	const control = (step as typeof step & { childControl?: AsyncChildControlStatus }).childControl;
	const snapshot: { control?: AsyncChildControlStatus; model?: string; thinking?: string } = {};
	if (control) snapshot.control = control;
	if (step.model) snapshot.model = step.model;
	if (step.thinking) snapshot.thinking = step.thinking;
	return snapshot;
}

interface FocusedChildComponentOptions {
	tui: ChildTui;
	theme: Theme;
	target: FocusedChildTarget;
	actions: FocusedChildActions;
	done: (result: undefined) => void;
	editor: CustomEditor;
	selectListTheme?: SelectListTheme;
	keybindings?: PiKeybindings;
}

interface FocusedChildRenderState {
	tui: ChildTui;
	theme: Theme;
	target: FocusedChildTarget;
	status?: AsyncChildControlStatus;
	currentModel?: string;
	currentThinking?: string;
	picker?: Picker;
	notice?: { text: string; error?: boolean };
	editor: CustomEditor;
	markdownTheme: ReturnType<typeof getMarkdownTheme>;
}

function renderFocusedChild(width: number, state: FocusedChildRenderState): string[] {
	const innerWidth = Math.max(1, width - 2);
	let stateText = "ready";
	if (state.status) stateText = `${state.status.state} · ${state.status.message}`;
	const model = state.currentModel ?? "default";
	const thinking = state.currentThinking ?? "default";
	const header = [
		state.theme.bold(`${state.target.agent} · ${state.target.runId.slice(0, 8)} · child ${state.target.index}`),
		state.theme.fg("dim", `Model: ${model} · Thinking: ${thinking} · Status: ${stateText}`),
	];
	const transcriptOptions = {
		trustedRoots: state.target.transcript.trustedRoots,
		trustedFiles: state.target.transcript.trustedFiles,
		trustedFileRoot: state.target.transcript.trustedFileRoot,
	};
	const transcript = readFleetTranscript(state.target.transcript.path, transcriptOptions);
	const transcriptLines = transcript.events.length
		? renderFleetTranscript(transcript, innerWidth, state.theme, state.markdownTheme, { expandedTools: true })
		: [state.theme.fg("muted", transcript.warning ?? "Waiting for child transcript…")];
	const rows = state.tui.terminal?.rows ?? 32;
	let editorLines: string[];
	if (state.picker) {
		const title = state.picker.kind === "model" ? "Select model" : "Select thinking level";
		editorLines = [state.theme.fg("accent", title), ...state.picker.list.render(innerWidth)];
	} else {
		editorLines = state.editor.render(innerWidth);
	}
	let noticeLines: string[] = [];
	if (state.notice) {
		const noticeColor = state.notice.error ? "error" : "accent";
		noticeLines = wrapTextWithAnsi(state.theme.fg(noticeColor, state.notice.text), innerWidth);
	}
	const fixed = header.length + editorLines.length + noticeLines.length + 5;
	const bodyHeight = Math.max(3, rows - fixed);
	const body = transcriptLines.slice(-bodyHeight);
	const boxed = (line: string): string => state.theme.fg("border", "│") + fitAnsi(line, innerWidth) + state.theme.fg("border", "│");
	const lines = [
		state.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
		...header.map(boxed),
		state.theme.fg("border", `├${"─".repeat(innerWidth)}┤`),
		...body.map(boxed),
		...noticeLines.map(boxed),
		state.theme.fg("border", `├${"─".repeat(innerWidth)}┤`),
		...editorLines.map(boxed),
		boxed(state.theme.fg("dim", ` Esc Fleet · ${keyHint("app.model.select", "model")} · ${keyHint("app.thinking.cycle", "thinking")} · Enter submit `)),
		state.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`),
	];
	return lines.map((line) => truncateToWidth(line, width));
}

export class FocusedChildComponent implements Component {
	private disposed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private notice: { text: string; error?: boolean } | undefined;
	private picker: Picker | undefined;
	private status: AsyncChildControlStatus | undefined;
	private currentModel: string | undefined;
	private currentThinking: string | undefined;
	private readonly markdownTheme = getMarkdownTheme();
	private readonly tui: ChildTui;
	private readonly theme: Theme;
	private readonly target: FocusedChildTarget;
	private readonly actions: FocusedChildActions;
	private readonly done: (result: undefined) => void;
	private readonly editor: CustomEditor;
	private readonly selectListTheme: SelectListTheme;
	private readonly keybindings: PiKeybindings | undefined;

	constructor(options: FocusedChildComponentOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.target = options.target;
		this.actions = options.actions;
		this.done = options.done;
		this.editor = options.editor;
		this.keybindings = options.keybindings;
		this.selectListTheme = options.selectListTheme ?? {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.bold(text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: (text) => this.theme.fg("warning", text),
		};
		this.editor.onEscape = () => this.close();
		this.editor.onSubmit = (text) => this.submit(text);
		const snapshot = childRuntimeSnapshot(this.target);
		this.status = snapshot.control;
		this.currentModel = snapshot.model ?? this.target.model;
		this.currentThinking = snapshot.thinking ?? this.target.thinking;
		this.scheduleRefresh();
	}

	private scheduleRefresh(): void {
		if (this.disposed || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.disposed) return;
			const snapshot = childRuntimeSnapshot(this.target);
			this.status = snapshot.control;
			this.currentModel = snapshot.model ?? this.currentModel;
			this.currentThinking = snapshot.thinking ?? this.currentThinking;
			this.tui.requestRender();
			this.scheduleRefresh();
		}, REFRESH_MS);
		this.timer.unref?.();
	}

	private close(): void {
		if (this.disposed) return;
		this.dispose();
		this.done(undefined);
	}

	private submit(raw: string): void {
		const message = raw.trim();
		if (!message) return;
		this.editor.disableSubmit = true;
		this.notice = { text: "Submitting direct input…" };
		this.tui.requestRender();
		void this.actions.submit(message).then(({ requestId }) => {
			this.editor.setText("");
			this.notice = { text: `Input queued · ${requestId}` };
		}).catch((error) => {
			this.notice = { text: error instanceof Error ? error.message : String(error), error: true };
		}).finally(() => {
			this.editor.disableSubmit = false;
			if (!this.disposed) this.tui.requestRender();
		});
	}

	private openModelPicker(): void {
		const list = new SelectList(this.target.availableModels.map((model) => ({ value: model.fullId, label: model.fullId })), 10, this.selectListTheme);
		list.onCancel = () => { this.picker = undefined; this.tui.requestRender(); };
		list.onSelect = (item) => this.applyRuntime({ model: item.value });
		this.picker = { kind: "model", list };
		this.tui.requestRender();
	}

	private openThinkingPicker(): void {
		const model = this.target.availableModels.find((candidate) => candidate.fullId === this.currentModel);
		let levels = getSupportedThinkingLevels(model);
		const ceiling = this.target.thinkingCeiling;
		if (ceiling) levels = levels.filter((level) => THINKING_LEVELS.indexOf(level) <= THINKING_LEVELS.indexOf(ceiling));
		const list = new SelectList(levels.map((level) => ({ value: level, label: level })), levels.length, this.selectListTheme);
		list.onCancel = () => { this.picker = undefined; this.tui.requestRender(); };
		list.onSelect = (item) => {
			const request: { model?: string; thinking?: ThinkingLevel } = { thinking: parseThinkingLevel(item.value) };
			if (this.currentModel) request.model = this.currentModel;
			this.applyRuntime(request);
		};
		this.picker = { kind: "thinking", list };
		this.tui.requestRender();
	}

	private applyRuntime(request: { model?: string; thinking?: ThinkingLevel }): void {
		this.picker = undefined;
		this.notice = { text: "Queueing runtime selection…" };
		void this.actions.setRuntime(request).then(({ requestId }) => {
			this.notice = { text: `Runtime request queued · ${requestId}` };
		}).catch((error) => {
			this.notice = { text: error instanceof Error ? error.message : String(error), error: true };
		}).finally(() => {
			if (!this.disposed) this.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.picker) {
				this.picker = undefined;
				this.tui.requestRender();
			} else this.close();
			return;
		}
		if (this.picker) return this.picker.list.handleInput(data);
		if (this.keybindings?.matches(data, "app.model.select") ?? matchesKey(data, "ctrl+l")) return this.openModelPicker();
		if (this.keybindings?.matches(data, "app.thinking.cycle") ?? matchesKey(data, "shift+tab")) return this.openThinkingPicker();
		this.editor.handleInput(data);
	}

	render(width: number): string[] {
		return renderFocusedChild(width, {
			tui: this.tui,
			theme: this.theme,
			target: this.target,
			status: this.status,
			currentModel: this.currentModel,
			currentThinking: this.currentThinking,
			picker: this.picker,
			notice: this.notice,
			editor: this.editor,
			markdownTheme: this.markdownTheme,
		});
	}

	invalidate(): void {
		this.editor.invalidate();
		this.picker?.list.invalidate();
		const snapshot = childRuntimeSnapshot(this.target);
		this.status = snapshot.control;
		this.currentModel = snapshot.model ?? this.currentModel;
		this.currentThinking = snapshot.thinking ?? this.currentThinking;
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}

export async function openFocusedChild(ctx: ExtensionContext, target: FocusedChildTarget, actions: FocusedChildActions): Promise<void> {
	const native = await import("@earendil-works/pi-coding-agent");
	const NativeCustomEditor = native.CustomEditor;
	const nativeSelectListTheme = native.getSelectListTheme;
	if (!NativeCustomEditor || !nativeSelectListTheme) throw new Error("Focused child sessions require Pi's native CustomEditor and select-list theme.");
	await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
		const selectListTheme = nativeSelectListTheme();
		const editor = new NativeCustomEditor(tui, { borderColor: (text) => theme.fg("border", text), selectList: selectListTheme }, keybindings, { paddingX: 0 });
		return new FocusedChildComponent({ tui, theme, target, actions, done, editor, selectListTheme, keybindings: keybindings as PiKeybindings });
	});
}
