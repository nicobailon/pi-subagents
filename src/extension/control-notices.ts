import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	controlNotificationKey,
	formatControlNoticeMessage,
	isControlEventActionable,
} from "../runs/shared/subagent-control.ts";
import {
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	type AsyncStatus,
	type ControlEvent,
	type SubagentState,
} from "../shared/types.ts";
import { readStatus } from "../shared/utils.ts";
import { resolveChildPresentation, type ChildPresentationDetails } from "./human-messages.ts";

export const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";

export interface SubagentControlMessageDetails extends Partial<ChildPresentationDetails> {
	event: ControlEvent;
	source?: "foreground" | "async";
	asyncDir?: string;
	childIntercomTarget?: string;
	noticeText?: string;
	channels?: string[];
	intercom?: { to?: string; message?: string };
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
	pi: Pick<ExtensionAPI, "events" | "sendMessage">;
	state: SubagentState;
	visibleControlNotices: Set<string>;
	details: SubagentControlMessageDetails;
}): void {
	const childIntercomTarget = controlNoticeTarget(input.details);
	const key = controlNotificationKey(input.details.event, childIntercomTarget);
	if (input.visibleControlNotices.has(key)) return;
	const channels = input.details.channels ?? ["event"];
	const deliverVisible = channels.includes("event");
	const deliverIntercom = channels.includes("intercom")
		&& input.details.event.type !== "active_long_running"
		&& typeof input.details.intercom?.to === "string"
		&& typeof input.details.intercom.message === "string";
	if (!deliverVisible && !deliverIntercom) return;
	input.visibleControlNotices.add(key);
	const noticeText = input.details.noticeText ?? formatControlNoticeMessage(input.details.event, childIntercomTarget);
	if (deliverVisible) {
		const presentation = resolveChildPresentation(
			input.state,
			input.details.event.runId,
			input.details.event.agent,
			input.details.event.index,
		);
		const details = { ...input.details, ...presentation, childIntercomTarget, noticeText };
		input.pi.events.emit(SUBAGENT_CONTROL_EVENT, details);
		input.pi.sendMessage(
			{
				customType: SUBAGENT_CONTROL_MESSAGE_TYPE,
				content: noticeText,
				display: true,
				details,
			},
			{ triggerTurn: input.details.source !== "foreground" },
		);
	}
	if (deliverIntercom) {
		input.pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
			...input.details,
			to: input.details.intercom!.to,
			message: input.details.intercom!.message,
		});
	}
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
		status: step.status,
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
	const child = details.event.index !== undefined ? control.childSnapshots?.get(details.event.index) : undefined;
	return isControlEventActionable(details.event, child ? {
		runId: control.runId,
		state: "running",
		agent: child.agent,
		index: details.event.index,
		status: child.status,
		activityState: child.activityState,
		lastActivityAt: child.lastActivityAt,
		currentTool: child.currentTool,
	} : {
		runId: control.runId,
		state: "running",
		agent: control.currentAgent,
		index: control.currentIndex,
		status: control.currentStatus,
		activityState: control.currentActivityState,
		lastActivityAt: control.lastActivityAt,
		currentTool: control.currentTool,
	});
}

export function handleSubagentControlNotice(input: {
	pi: Pick<ExtensionAPI, "events" | "sendMessage">;
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
