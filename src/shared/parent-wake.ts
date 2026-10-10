import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PARENT_WAKE_TEXT = "Inspect subagent updates above. Answer pending supervisor requests within your authority. For completed work, read saved results and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";
// A handled or failed wake prompt emits no agent_start. Past this deadline an idle parent's
// wake counts as abandoned: its notices are already in the session, only the turn is lost.
const WAKE_PENDING_MS = 10_000;

// Reload replaces extension instances, not Pi's session manager or a wake prompt in preflight.
// The key and shape are shared with pi-intercom's idle wake: Pi marks a run active only after the
// prompt's async preflight, so a second extension's wake sent in that gap throws in agent.prompt().
type WakeReservation = { sessionId: string; sentAt?: number };
const reservationsSymbol = Symbol.for("pi.idle-wake.v1");
const wakeGlobal = globalThis as typeof globalThis & { [reservationsSymbol]?: WeakMap<object, WakeReservation> };
const reservations = wakeGlobal[reservationsSymbol] ?? (wakeGlobal[reservationsSymbol] = new WeakMap<object, WakeReservation>());

export interface ParentWake {
	/**
	 * pi.sendMessage, except that a turn-triggering message to an idle parent is appended and the
	 * turn is started with sendUserMessage. Pi starts a sendMessage-triggered run without
	 * before_agent_start (earendil-works/pi#5581), so that run drops every hook-set prompt section.
	 * Returns true when the message was appended that way: Pi emits no extension message_start for it.
	 */
	sendMessage(...args: Parameters<ExtensionAPI["sendMessage"]>): boolean;
	/** True from an idle wake until its run starts or the session shuts down. Past the deadline it holds only while the parent is busy, which may still be the wake's preflight (for example compacting). */
	isPending(): boolean;
	bindSession(ctx: Pick<ExtensionContext, "isIdle" | "sessionManager">): void;
	agentStarted(): void;
	sessionShutdown(reason: string | undefined): void;
}

export function createParentWake(pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">, now: () => number = Date.now): ParentWake {
	let ctx!: Pick<ExtensionContext, "isIdle">;
	// Captured at bind: Pi's ctx throws once stale, which it can be by session_shutdown.
	let session: { manager: object; id: string } | undefined;
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
			if (!ctx.isIdle()) {
				pi.sendMessage(message, options);
				return false;
			}
			pi.sendMessage(message, { triggerTurn: false });
			if (!reserved()) {
				reservation().sentAt = now();
				// Steer queues the wake if another prompt starts the run first.
				pi.sendUserMessage(PARENT_WAKE_TEXT, { deliverAs: "steer" });
			}
			return true;
		},
		isPending: () => reservation().sentAt !== undefined && (reserved() || !ctx.isIdle()),
		bindSession(context) {
			ctx = context;
			session = { manager: context.sessionManager, id: context.sessionManager.getSessionId() };
		},
		agentStarted() {
			reservation().sentAt = undefined;
		},
		sessionShutdown(reason) {
			if (reason !== "reload") reservation().sentAt = undefined;
		},
	};
}
