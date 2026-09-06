import assert from "node:assert/strict";
import registerSubagentNotify, { type CompletionNotification } from "../../src/runs/background/notify.ts";

const callbacks = new Map<number, () => void>();
let timerId = 0;
let now = 0;
let failSend = false;
const state = { currentSessionId: "session-a", completionOwnerId: "owner-a" };
const sent: unknown[] = [];
const pi = {
	events: { on: () => () => {} },
	sendMessage(message: unknown, options: unknown) {
		if (failSend) throw new Error("PRIVATE_ERROR_CREDENTIAL");
		sent.push({ message, options });
	},
};
const notifier = registerSubagentNotify(pi as never, state, {
	now: () => now,
	timers: {
		setTimeout(callback) { callbacks.set(++timerId, callback); return timerId; },
		clearTimeout(handle) { callbacks.delete(handle as number); },
	},
});
const result = (id: string, extra: Partial<CompletionNotification> = {}): CompletionNotification => ({
	id, runId: id, sessionId: "session-a", completionOwnerId: "owner-a", success: true,
	summary: "PRIVATE_OUTPUT", task: "PRIVATE_TASK", credential: "PRIVATE_CREDENTIAL",
	sessionFile: "/PRIVATE_SESSION_PATH", ...extra,
});
const flush = () => { for (const callback of [...callbacks.values()]) callback(); };
assert.equal(await notifier.deliver(result("missing", { sessionId: undefined })), false);
assert.equal(await notifier.deliver(result("foreground-other", { source: "foreground", sessionId: "other" })), false);
assert.equal(await notifier.deliver(result("foreign", { completionOwnerId: "other" })), false);
assert.equal(await notifier.deliver(result("relayed", { intercomDelivered: true })), true);
assert.equal(sent.length, 0);
const first = result("first");
const firstDelivery = notifier.deliver(first);
assert.equal(notifier.deliver(first), firstDelivery);
const secondDelivery = notifier.deliver(result("second"));
assert.equal(sent.length, 0);
assert.equal(notifier.hasPendingDelivery(), true);
flush();
assert.equal(await firstDelivery, true);
assert.equal(await secondDelivery, true);
assert.equal(sent.length, 1); // grouped, not dropped
now = 600_000;
assert.equal(await notifier.deliver(first), true); // inclusive TTL boundary
assert.equal(sent.length, 1);
now++;
const expired = notifier.deliver(first);
flush();
assert.equal(await expired, true);
assert.equal(sent.length, 2);
const lostOwnership = notifier.deliver(result("owner-changed"));
state.completionOwnerId = "other";
flush();
assert.equal(await lostOwnership, false);
state.completionOwnerId = "owner-a";
failSend = true;
assert.equal(await notifier.deliver(result("retry", { success: false })), false);
failSend = false;
assert.equal(await notifier.deliver(result("retry", { success: false })), true);
assert.equal(await notifier.deliver(result("foreground", { source: "foreground" })), true);
// Attention still flushes held successes before its own immediate send.
const held = notifier.deliver(result("held"));
assert.equal(await notifier.deliver(result("attention", { success: false })), true);
assert.equal(await held, true);
const abandoned = notifier.deliver(result("abandoned"));
notifier.dispose();
assert.equal(await abandoned, false);
assert.equal(notifier.hasPendingDelivery(), false);
assert.equal(callbacks.size, 0);
assert.equal(await notifier.deliver(result("after-dispose")), false);
// Malformed/large identity cannot create multiline or unbounded trace records.
await notifier.deliver(result("unsafe\n\u001b[31m" + "x".repeat(10_000)));
// Disabled diagnostics must not even read diagnostic identity fields at a guard.
if (!process.env.NODE_DEBUG) {
	const unread = result("unread");
	Object.defineProperty(unread, "runId", { get() { throw new Error("diagnostic metadata read while disabled"); } });
	assert.equal(await notifier.deliver(unread), false);
}
const immediate = registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
assert.equal(await immediate.deliver(result("unbatched", { triggerTurn: false })), true);
immediate.dispose();
console.log(JSON.stringify(sent));
