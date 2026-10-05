import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PARENT_WAKE_TEXT = "Subagent updates above.";
// A handled or failed wake prompt emits no agent_start. Past this deadline an idle parent's
// wake counts as abandoned: its notices are already in the session, only the turn is lost.
const WAKE_PENDING_MS = 10_000;

// Reload replaces extension instances, not Pi's session manager or a wake prompt in preflight.
type WakeReservation = { sessionId: string; sentAt?: number };
const reservationsSymbol = Symbol.for("pi-subagents.parent-wake-reservations.v1");
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
	let reservation: WakeReservation = { sessionId: "" };
	const reserved = () => reservation.sentAt !== undefined && now() - reservation.sentAt < WAKE_PENDING_MS;
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
				reservation.sentAt = now();
				// Steer queues the wake if another prompt starts the run first.
				pi.sendUserMessage(PARENT_WAKE_TEXT, { deliverAs: "steer" });
			}
			return true;
		},
		isPending: () => reservation.sentAt !== undefined && (reserved() || !ctx.isIdle()),
		bindSession(context) {
			ctx = context;
			const sessionId = context.sessionManager.getSessionId();
			const retained = reservations.get(context.sessionManager);
			reservation = retained?.sessionId === sessionId ? retained : { sessionId };
			reservations.set(context.sessionManager, reservation);
		},
		agentStarted() {
			reservation.sentAt = undefined;
		},
		sessionShutdown(reason) {
			if (reason !== "reload") reservation.sentAt = undefined;
		},
	};
}
