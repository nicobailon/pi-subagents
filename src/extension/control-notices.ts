import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	controlNotificationKey,
	formatControlNoticeMessage,
	isControlEventActionable,
} from "../runs/shared/subagent-control.ts";
import type { AsyncStatus, ControlEvent, SubagentState } from "../shared/types.ts";
import { readStatus } from "../shared/utils.ts";
import { resolveChildPresentation, type ChildPresentationDetails } from "./human-messages.ts";

export const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";

export interface SubagentControlMessageDetails extends Partial<ChildPresentationDetails> {
	event: ControlEvent;
	source?: "foreground" | "async";
	asyncDir?: string;
	childIntercomTarget?: string;
	noticeText?: string;
}

export function controlNoticeTarget(details: SubagentControlMessageDetails): string | undefined {
	return details.childIntercomTarget;
}

export function formatSubagentControlNotice(details: SubagentControlMessageDetails, content?: string): string {
	return details.noticeText ?? content ?? formatControlNoticeMessage(details.event, controlNoticeTarget(details));
}

function noticeTimerKey(details: SubagentControlMessageDetails): string {
	const childIntercomTarget = controlNoticeTarget(details);
	return `${details.event.runId}:${controlNotificationKey(details.event, childIntercomTarget)}`;
}

export function clearPendingForegroundControlNotices(state: SubagentState, runId?: string): void {
	const pending = state.pendingForegroundControlNotices;
	if (!pending) return;
	for (const [key, timer] of pending) {
		if (runId !== undefined && !key.startsWith(`${runId}:`)) continue;
		clearTimeout(timer);
		pending.delete(key);
	}
}

function deliverControlNotice(input: {
	pi: Pick<ExtensionAPI, "sendMessage">;
	state: SubagentState;
	visibleControlNotices: Set<string>;
	details: SubagentControlMessageDetails;
}): void {
	const childIntercomTarget = controlNoticeTarget(input.details);
	const key = controlNotificationKey(input.details.event, childIntercomTarget);
	if (input.visibleControlNotices.has(key)) return;
	input.visibleControlNotices.add(key);
	const noticeText = input.details.noticeText ?? formatControlNoticeMessage(input.details.event, childIntercomTarget);
	const presentation = resolveChildPresentation(
		input.state,
		input.details.event.runId,
		input.details.event.agent,
		input.details.event.index,
	);
	input.pi.sendMessage(
		{
			customType: SUBAGENT_CONTROL_MESSAGE_TYPE,
			content: noticeText,
			display: true,
			details: { ...input.details, ...presentation, childIntercomTarget, noticeText },
		},
		{ triggerTurn: input.details.source !== "foreground" },
	);
}

function asyncStatusSnapshot(status: AsyncStatus, event: ControlEvent) {
	const index = event.index ?? status.currentStep ?? (status.steps?.length === 1 ? 0 : undefined);
	if (index === undefined) return undefined;
	const step = status.steps?.[index];
	if (!step) return undefined;
	return {
		runId: status.runId,
		state: status.state,
		agent: step.agent,
		index,
		activityState: step.activityState,
		lastActivityAt: step.lastActivityAt,
		currentTool: step.currentTool,
	};
}

function isNoticeStillActionable(state: SubagentState, details: SubagentControlMessageDetails): boolean {
	if (details.source === "async") {
		const job = state.asyncJobs.get(details.event.runId);
		if (!job || job.status !== "running") return false;
		let status: AsyncStatus | null;
		try {
			status = readStatus(details.asyncDir ?? job.asyncDir);
		} catch {
			return false;
		}
		return status !== null && isControlEventActionable(details.event, asyncStatusSnapshot(status, details.event));
	}

	const control = state.foregroundControls.get(details.event.runId);
	if (!control) return false;
	return isControlEventActionable(details.event, {
		runId: control.runId,
		state: "running",
		agent: control.currentAgent,
		index: control.currentIndex,
		activityState: control.currentActivityState,
		lastActivityAt: control.lastActivityAt,
		currentTool: control.currentTool,
	});
}

export function handleSubagentControlNotice(input: {
	pi: Pick<ExtensionAPI, "sendMessage">;
	state: SubagentState;
	visibleControlNotices: Set<string>;
	details: SubagentControlMessageDetails;
	foregroundDelayMs?: number;
	asyncDelayMs?: number;
}): void {
	if (!input.details?.event || input.details.event.type === "active_long_running" || input.details.event.reason === "completion_guard") return;

	const pending = input.state.pendingForegroundControlNotices ?? new Map<string, ReturnType<typeof setTimeout>>();
	input.state.pendingForegroundControlNotices = pending;
	const timerKey = noticeTimerKey(input.details);
	const existing = pending.get(timerKey);
	if (existing) clearTimeout(existing);
	const timer = setTimeout(() => {
		pending.delete(timerKey);
		if (!isNoticeStillActionable(input.state, input.details)) return;
		deliverControlNotice(input);
	}, input.details.source === "foreground" ? input.foregroundDelayMs ?? 1000 : input.asyncDelayMs ?? 1000);
	timer.unref?.();
	pending.set(timerKey, timer);
}
