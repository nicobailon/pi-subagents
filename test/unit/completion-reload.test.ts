import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import registerNotify from "../../src/runs/background/notify.ts";

function harness(manager: { getSessionId(): string }, appended = false) {
	let beforeSettle: any;
	const sent: any[] = [];
	const notifier = registerNotify({
		events: { on: () => () => {} },
		on(_name: string, handler: any) { beforeSettle = handler; return () => { beforeSettle = undefined; }; },
		sendMessage(message: any) { sent.push(message); return appended; },
	} as never, { currentSessionId: manager.getSessionId(), completionOwnerId: "owner" }, { batchConfig: { enabled: false } });
	return {
		notifier, sent,
		bind: () => notifier.bindSession(manager),
		deliver: () => notifier.deliver({
			id: randomUUID(), sessionId: manager.getSessionId(), completionOwnerId: "owner",
			success: true, agent: "workflow", summary: "Saved report ready.",
		}),
		settle: (messages: any[]) => beforeSettle?.({
			outcome: "completed", continue: false, entries: [],
			context: { canContinue: true, pendingMessages: [], contextMessages: messages },
		}),
	};
}

for (const appended of [false, true]) {
	for (const reminded of [false, true]) {
		it(`retains completion retry state on reload (appended=${appended}, reminded=${reminded})`, async () => {
			const manager = { getSessionId: () => randomId };
			const randomId = randomUUID();
			const first = harness(manager, appended);
			first.bind();
			assert.equal(await first.deliver(), true);
			const completion = { ...first.sent[0], role: "custom" };
			const messages = [completion, { role: "assistant", content: [{ type: "text", text: "" }] }];
			if (reminded) {
				first.notifier.messageStarted(completion);
				assert.equal(first.settle(messages).continue, true);
			}
			first.notifier.sessionShutdown("reload");
			first.notifier.dispose();
			const replacement = harness(manager, appended);
			try {
				replacement.bind();
				assert.equal(replacement.notifier.hasPendingDelivery(), !appended && !reminded);
				replacement.notifier.messageStarted(completion);
				const result = replacement.settle(messages);
				if (reminded) {
					assert.equal(result.continue, undefined, "reload must not reset exhausted retry budget");
				} else {
					assert.equal(result.continue, true, "retained empty wake gets its continuation");
				}
				const warning = reminded ? result : replacement.settle(messages);
				assert.match(warning.entries[0].content, /^UNHANDLED:/);
				assert.equal(replacement.settle(messages), undefined, "no further retry or warning");
				assert.equal(replacement.sent.length, 0, "reload does not redeliver the completed workflow");
			} finally {
				replacement.notifier.sessionShutdown("quit");
				replacement.notifier.dispose();
			}
		});
	}
}

it("isolates retained acknowledgement state and merges completions accepted before bind", async () => {
	let id = randomUUID();
	const manager = { getSessionId: () => id };
	const first = harness(manager);
	first.bind();
	await first.deliver();
	const original = { ...first.sent[0], role: "custom" };
	first.notifier.sessionShutdown("reload");
	first.notifier.dispose();
	const otherManager = harness({ getSessionId: () => id });
	otherManager.bind();
	assert.equal(otherManager.settle([original]), undefined, "same UUID on another manager cannot inherit state");
	otherManager.notifier.dispose();
	const replacement = harness(manager);
	await replacement.deliver(); // Accepted by the new runtime before session_start binds it.
	const early = { ...replacement.sent[0], role: "custom" };
	replacement.bind();
	assert.equal(replacement.settle([original, early]).continue, true);
	const warning = replacement.settle([original, early]);
	assert.match(warning.entries[0].content, /UNHANDLED:/);
	assert.match(warning.entries[0].content, /completion notices above/);
	assert.doesNotMatch(warning.entries[0].content, /Saved report ready/);
	await replacement.deliver();
	const latest = { ...replacement.sent.at(-1), role: "custom" };
	id = randomUUID();
	replacement.bind();
	assert.equal(replacement.settle([latest]), undefined, "changing UUID on same manager drops old state");
	replacement.notifier.dispose();
});

it("restores pre-upgrade queued wakes without a tracking map", async () => {
	const sessionId = randomUUID();
	const manager = { getSessionId: () => sessionId };
	const content = "Background task completed: **workflow**\n\nRetained legacy result";
	const registry = (globalThis as any)[Symbol.for("pi-subagents.queued-completion-wakes.v2")];
	registry.set(manager, { sessionId, wakes: [content] });
	const replacement = harness(manager);
	try {
		replacement.bind();
		assert.equal(replacement.notifier.hasPendingDelivery(), true);
		const messages = [{ role: "custom", customType: "subagent-notify", content }];
		replacement.notifier.messageStarted(messages[0]);
		assert.equal(replacement.settle(messages).continue, true, "legacy wake receives safeguard");
		assert.equal(await replacement.deliver(), true, "new delivery uses a valid map");
		messages.push({ ...replacement.sent[0], role: "custom" });
		assert.equal(replacement.settle(messages).continue, true);
		assert.match(replacement.settle(messages).entries[0].content, /^UNHANDLED:/);
		assert.equal(replacement.settle(messages), undefined);
	} finally {
		replacement.notifier.sessionShutdown("quit");
		replacement.notifier.dispose();
		registry.delete(manager);
	}
});

it("quit clears retained completion tracking", async () => {
	const manager = { getSessionId: () => "quit-" + id };
	const id = randomUUID();
	const first = harness(manager);
	first.bind();
	await first.deliver();
	const completion = { ...first.sent[0], role: "custom" };
	first.notifier.sessionShutdown("quit");
	first.notifier.dispose();
	const replacement = harness(manager);
	try {
		replacement.bind();
		assert.equal(replacement.settle([completion]), undefined);
	} finally {
		replacement.notifier.dispose();
	}
});
