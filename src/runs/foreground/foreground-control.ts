import type { AgentProgress, ForegroundChildControl, ForegroundRunControl } from "../../shared/types.ts";

interface BeginForegroundChildInput {
	index: number;
	agent: string;
	description?: string;
	interrupt: () => boolean;
}

function copyProgress(target: ForegroundChildControl, progress: AgentProgress | undefined): void {
	if (!progress) return;
	target.currentActivityState = progress.activityState;
	target.lastActivityAt = progress.lastActivityAt;
	target.currentTool = progress.currentTool;
	target.currentToolStartedAt = progress.currentToolStartedAt;
	target.currentPath = progress.currentPath;
	target.turnCount = progress.turnCount;
	target.tokens = progress.tokens;
	target.toolCount = progress.toolCount;
}

function syncCurrentChild(control: ForegroundRunControl, child: ForegroundChildControl): void {
	control.currentAgent = child.agent;
	control.currentIndex = child.index;
	control.description = child.description;
	control.currentActivityState = child.currentActivityState;
	control.lastActivityAt = child.lastActivityAt;
	control.currentTool = child.currentTool;
	control.currentToolStartedAt = child.currentToolStartedAt;
	control.currentPath = child.currentPath;
	control.turnCount = child.turnCount;
	control.tokens = child.tokens;
	control.toolCount = child.toolCount;
	control.interrupt = child.interrupt;
	control.updatedAt = child.updatedAt;
}

function clearCurrentChild(control: ForegroundRunControl): void {
	control.currentAgent = undefined;
	control.currentIndex = undefined;
	control.currentActivityState = undefined;
	control.lastActivityAt = undefined;
	control.currentTool = undefined;
	control.currentToolStartedAt = undefined;
	control.currentPath = undefined;
	control.turnCount = undefined;
	control.tokens = undefined;
	control.toolCount = undefined;
	control.interrupt = undefined;
}

export function beginForegroundChild(control: ForegroundRunControl, input: BeginForegroundChildInput): void {
	const now = Date.now();
	const child: ForegroundChildControl = {
		index: input.index,
		agent: input.agent,
		...(input.description ? { description: input.description } : {}),
		startedAt: now,
		updatedAt: now,
	};
	child.interrupt = () => {
		if (!input.interrupt()) return false;
		child.currentActivityState = undefined;
		child.updatedAt = Date.now();
		syncCurrentChild(control, child);
		return true;
	};
	control.activeChildren ??= new Map();
	control.activeChildren.set(input.index, child);
	syncCurrentChild(control, child);
}

export function updateForegroundChild(control: ForegroundRunControl, index: number, progress: AgentProgress | undefined): void {
	const child = control.activeChildren?.get(index);
	if (!child) return;
	copyProgress(child, progress);
	child.updatedAt = Date.now();
	syncCurrentChild(control, child);
}

export function finishForegroundChild(control: ForegroundRunControl, index: number): void {
	control.activeChildren?.delete(index);
	if (control.currentIndex === index) {
		const next = [...(control.activeChildren?.values() ?? [])]
			.sort((left, right) => right.updatedAt - left.updatedAt || left.index - right.index)[0];
		if (next) syncCurrentChild(control, next);
		else clearCurrentChild(control);
	}
	control.updatedAt = Date.now();
}
