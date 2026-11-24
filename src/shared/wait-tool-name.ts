export const DEFAULT_WAIT_TOOL_NAME = "bg_wait";

let current = DEFAULT_WAIT_TOOL_NAME;

/**
 * The name pi-subagents registers its wait tool under (`config.waitTool.name`). One value per process: the parent
 * sets it from config, a child runtime from its launch config, and an async runner from its runner config, because
 * every runtime in a process descends from the same parent setting.
 */
export function waitToolName(): string {
	return current;
}

export function setWaitToolName(name: string): void {
	current = name;
}

let declared = true;

/**
 * Whether the parent declares its pi-subagents tools: with `toolExposure: "deferred"` it declares none, so parent-facing
 * text points to the completion notice. Set by the parent from config, once per process: async runners keep the
 * default, but in-process foreground children share this value, so in a deferred session their own launch receipts
 * use the deferred wording too.
 */
export function parentToolsDeclared(): boolean {
	return declared;
}

export function setParentToolsDeclared(value: boolean): void {
	declared = value;
}

/** How parent-facing text tells the model to wait for one run. */
export function waitForRunText(id: string): string {
	return declared ? `wait with ${current}({ id: "${id}" })` : "wait for its completion notice, which wakes this session";
}
