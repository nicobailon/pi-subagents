import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Ends a waking notice that reports results. */
export const COMPLETION_ACTION = "Read the saved results above and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";
/** Ends a waking notice that reports a problem or a run state rather than results. */
export const STATUS_ACTION = "Check the run status and details above, then resume the already-authorized parent task or report the problem. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";

// A wake whose run never starts emits no agent_start; past this deadline an idle parent's wake counts as abandoned.
// Pi persists the waking notice only when its run reaches message_end, so a run that never starts loses it;
// notify.ts records undelivered subagent-notify notices at shutdown and replays them at the next start.
const WAKE_PENDING_MS = 10_000;

// Reload replaces extension instances, not Pi's session manager or a wake still starting.
// The key and shape are shared with pi-intercom's idle wake: a wake prompt it sends is in
// preflight until agent_start, and a second extension's wake must not start another run then.
type WakeReservation = { sessionId: string; sentAt?: number };
const reservationsSymbol = Symbol.for("pi.idle-wake.v1");
const wakeGlobal = globalThis as typeof globalThis & { [reservationsSymbol]?: WeakMap<object, WakeReservation> };
const reservations = wakeGlobal[reservationsSymbol] ?? (wakeGlobal[reservationsSymbol] = new WeakMap<object, WakeReservation>());

export interface ParentWake {
	/**
	 * pi.sendMessage that shares the idle-wake reservation. A turn-triggering message to an idle
	 * parent starts the run itself: Pi runs before_agent_start for it and emits its message_start.
	 * Returns true when the message was only appended (held, or another wake is already starting
	 * the run): Pi emits no extension message_start for it.
	 * After userAborted() and until the next run starts, a turn-triggering message is only appended.
	 */
	sendMessage(...args: Parameters<ExtensionAPI["sendMessage"]>): boolean;
	/** True from an idle wake until its run starts or the session shuts down. Past the deadline it holds only while the parent is busy, which may still be the wake's preflight (for example compacting). */
	isPending(): boolean;
	bindSession(ctx: Pick<ExtensionContext, "isIdle" | "sessionManager">): void;
	agentStarted(): void;
	/** The user stopped the parent run: hold wakes until the next run starts. */
	userAborted(): void;
	/** A deliberate resume (manual compaction) drops the hold without touching the shared wake reservation. */
	releaseHold(): void;
	isHeld(): boolean;
	sessionShutdown(reason: string | undefined): void;
}

export function createParentWake(pi: Pick<ExtensionAPI, "sendMessage">, now: () => number = Date.now): ParentWake {
	let ctx!: Pick<ExtensionContext, "isIdle">;
	// Captured at bind: Pi's ctx throws once stale, which it can be by session_shutdown.
	let session: { manager: object; id: string } | undefined;
	let held = false;
	// Look the reservation up on every access: another extension may have created this session's entry.
	const reservation = (): WakeReservation => {
		// Pi can shut an extension down before session_start binds it; an unbound wake reserved nothing.
		if (!session) return { sessionId: "" };
		const current = reservations.get(session.manager);
		if (current?.sessionId === session.id) return current;
		const next = { sessionId: session.id };
		reservations.set(session.manager, next);
		return next;
	};
	const reserved = () => {
		const { sentAt } = reservation();
		return sentAt !== undefined && now() - sentAt < WAKE_PENDING_MS;
	};
	return {
		sendMessage(message, options) {
			if (options?.triggerTurn !== true) {
				pi.sendMessage(message, options);
				return false;
			}
			if (held || (ctx.isIdle() && reserved())) {
				// Appended now, or at the end of a run still finishing; neither emits an extension message_start.
				// A reserved wake's run picks the notice up when it starts.
				pi.sendMessage(message, { triggerTurn: false });
				return true;
			}
			if (ctx.isIdle()) reservation().sentAt = now();
			pi.sendMessage(message, options);
			return false;
		},
		isPending: () => reservation().sentAt !== undefined && (reserved() || !ctx.isIdle()),
		bindSession(context) {
			ctx = context;
			session = { manager: context.sessionManager, id: context.sessionManager.getSessionId() };
			held = false;
		},
		agentStarted() {
			reservation().sentAt = undefined;
			held = false;
		},
		userAborted: () => { held = true; },
		releaseHold: () => { held = false; },
		isHeld: () => held,
		sessionShutdown(reason) {
			if (reason !== "reload") reservation().sentAt = undefined;
		},
	};
}
