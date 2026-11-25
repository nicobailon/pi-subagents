import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { createNativeSupervisorChannel } from "../../src/intercom/native-supervisor-channel.ts";
import registerNotify from "../../src/runs/background/notify.ts";

it("bounds reminders for unresolved supervisor decisions", async () => {

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-settle-check-'));
const handlers = new Map(), tools = new Map(), wakes = [], messages = [];
const pi = {
  on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
  getAllTools: () => [...tools.values()],
  registerTool: tool => tools.set(tool.name, tool),
  sendMessage: (...args) => { wakes.push(args); messages.push({ ...args[0], role: "custom" }); },
  appendEntry() {},
};
const state = { supervisorOwnerSessionId: 'owner', foregroundControls: new Map(), asyncJobs: new Map() };
const channel = createNativeSupervisorChannel(pi, state, { getChannelDirs: () => ({ dirs: [dir] }) });
const settle = (overrides = {}) => handlers.get('agent_before_settle')?.({
  outcome: 'completed', entries: [], context: { canContinue: true, pendingMessages: [], contextMessages: messages }, ...overrides,
});
function request(id, overrides = {}) {
  fs.mkdirSync(path.join(dir, 'requests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'requests', `${id}.json`), JSON.stringify({
    type: 'subagent.supervisor.request', id, createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    reason: 'need_decision', message: 'Keep strict latency targets?', expectsReply: true,
    runId: 'child', agent: 'oracle', childIndex: 0, orchestratorSessionId: 'owner', ...overrides,
  }));
  channel.activateTransport();
}
try {
  channel.start();
  assert.equal(settle(), undefined, 'no requests: no continuation');
  assert.equal(handlers.has('agent_before_settle'), false, 'no requests: no settle hook');
  request('first');
  assert.equal(wakes.length, 1, 'normal wake still delivered');
  assert.equal(settle({ outcome: 'aborted' }), undefined, 'never override abort');
  assert.equal(settle({ outcome: 'error' }), undefined, 'never retry provider errors');
  assert.equal(settle({ context: { canContinue: true, pendingMessages: [{}] } }), undefined, 'queued wake gets its turn first');
  // Only silent/hidden output earns a continuation.
  messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "   " }] });
  const reminder = settle();
  assert.equal(reminder.continue, true);
  assert.match(reminder.entries[0].content, /explicitly ask the user/);
  assert.deepEqual(reminder.entries[0].details.requestIds, ['first']);
  assert.doesNotMatch(reminder.entries[0].content, /Keep strict latency targets/);
  const warning = settle();
  assert.equal(warning.continue, undefined, 'warning cannot force another model turn');
  assert.equal(warning.entries[0].details.blocked, true);
  assert.doesNotMatch(warning.entries[0].content, /Keep strict latency targets/);
  assert.equal(handlers.has('agent_before_settle'), false, 'exhausted wake unsubscribes');
  assert.equal(settle(), undefined, 'no infinite reminders or warning spam');
  assert.equal(fs.existsSync(path.join(dir, 'replies', 'first.json')), false, 'guard never approves');
  fs.mkdirSync(path.join(dir, 'replies'), { recursive: true });
  await channel.runParentAction({ action: 'reply', replyTo: 'first', message: 'Preserve strict targets.' });
  assert.equal(settle(), undefined, 'answered request no longer blocks');
  assert.equal(handlers.has('agent_before_settle'), false);

  request('second');
  assert.equal(settle().continue, true, 'new request receives independent budget');
  fs.rmSync(path.join(dir, 'requests', 'second.json'));
  assert.equal(settle(), undefined, 'removed requests no longer block');
  assert.equal(handlers.has('agent_before_settle'), false);
  request('expired', { expiresAt: Date.now() - 1 });
  request('foreign', { orchestratorSessionId: 'other' });
  request('progress', { reason: 'progress_update', expectsReply: false });
  assert.equal(settle(), undefined, 'expired, foreign, progress excluded');
  request('inactive');
  state.asyncJobs.set('child', { status: 'complete' });
  assert.equal(settle(), undefined, 'completed child excluded');
  state.asyncJobs.clear();
  request('pre-draft-cannot-continue');
  const preDraftContext = { context: { canContinue: false, pendingMessages: [], contextMessages: messages } };
  const appendedReminder = settle(preDraftContext);
  assert.equal(appendedReminder.continue, true, 'appended reminder supplies runnable context');
  assert.equal(appendedReminder.entries[0].customType, 'subagent-supervisor-unanswered');
  const blocked = settle(preDraftContext);
  assert.equal(blocked.continue, undefined);
  assert.equal(blocked.entries[0].details.blocked, true, 'exhausted reminder budget flags instead of looping');
  assert.equal(settle(preDraftContext), undefined, 'pre-draft continuation state cannot reset budget');
  request('approval');
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'May I approve this child action?' }] });
  assert.equal(settle(), undefined, 'visible escalation does not retry');
  channel.activateTransport();
  assert.equal(handlers.has('agent_before_settle'), false, 'visible escalation stays acknowledged while request remains pending');
  assert.equal(channel.pending.has('approval'), true);
  request('reply-before-settle');
  await channel.runParentAction({ action: 'reply', replyTo: 'reply-before-settle', message: 'Approved by existing authority.' });
  assert.equal(handlers.has('agent_before_settle'), false, 'reply immediately clears settle subscription');
  channel.dispose();
  assert.equal(settle(), undefined, 'disposed runtime inert');
} finally {
  channel.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
}

});

it("bounds retries for empty completion wakes without widening authority", async () => {

const handlers = new Map(), sent = [], messages = [];
let failSend = false;
let held = false;
const pi = {
  events: { on: () => () => {} },
  on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
  isHeld: () => held,
  sendMessage(message, options) {
    if (failSend) throw Error('send failed');
    sent.push({ message, options });
    messages.push({ ...message, role: 'custom' });
    return true; // Idle path appends notice without message_start.
  },
};
const state = { currentSessionId: 'session', completionOwnerId: 'owner' };
const notifier = registerNotify(pi, state, { batchConfig: { enabled: false } });
const sessionManager = { getSessionId: () => 'session' };
notifier.bindSession(sessionManager);
const settle = (overrides = {}) => handlers.get('agent_before_settle')?.({
  outcome: 'completed', continue: false, entries: [],
  context: { contextMessages: messages, pendingMessages: [], canContinue: true }, ...overrides,
});
const deliver = (overrides = {}) => notifier.deliver({
  id: randomUUID(), sessionId: 'session', completionOwnerId: 'owner', source: 'async',
  agent: 'workflow', mode: 'workflow', success: true, state: 'complete',
  summary: 'Saved results ready.', workflowReceipt: { path: '/tmp/receipt.json' }, ...overrides,
});
const assistant = content => messages.push({ role: 'assistant', content });
try {
  assert.equal(settle(), undefined);
  assert.equal(await deliver(), true);
  assert.equal(sent[0].options.triggerTurn, true);
  assert.match(sent[0].message.content, /resume the already-authorized parent task/);
  assistant([{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '' }]);
  assert.equal(settle({ outcome: 'aborted' }), undefined);
  assert.equal(settle({ outcome: 'error' }), undefined);
  assert.equal(settle({ continue: true }), undefined, 'respect another continuation');
  assert.equal(settle({ context: { contextMessages: messages, pendingMessages: [{}], canContinue: true } }), undefined);
  const retry = settle();
  assert.equal(retry.continue, true);
  assert.match(retry.entries[0].content, /completion notices above/);
  assert.doesNotMatch(retry.entries[0].content, /\/tmp\/receipt.json|Saved results ready/);
  messages.push({ ...retry.entries[0], role: 'custom' });
  assistant([{ type: 'text', text: '   ' }]);
  const warning = settle();
  assert.equal(warning.continue, undefined);
  assert.match(warning.entries[0].content, /^UNHANDLED:/);
  assert.doesNotMatch(warning.entries[0].content, /\/tmp\/receipt.json|Saved results ready/);
  assert.equal(handlers.has('agent_before_settle'), false, 'exhausted completion unsubscribes');
  assert.equal(settle(), undefined, 'one retry, one warning, no loop');
  assert.equal(sent.length, 1, 'guard never reruns or resends workflow');

  await deliver();
  assistant([{ type: 'toolCall', name: 'read', arguments: {} }]);
  assert.equal(settle(), undefined, 'tool action acknowledges response');
  await deliver();
  assistant([{ type: 'text', text: 'Results ready; approval required before deployment.' }]);
  assert.equal(settle(), undefined, 'visible escalation/report acknowledges response');
  await deliver({ scheduleOrigin: { id: 'quiet', quiet: true } });
  assert.equal(sent.at(-1).options.triggerTurn, false);
  assert.equal(settle(), undefined, 'quiet schedule never forces continuation');
  assert.equal(handlers.has('agent_before_settle'), false);
  await deliver({ triggerTurn: false });
  assert.equal(settle(), undefined, 'explicit no-wake respected');
  assert.equal(await deliver({ sessionId: 'foreign' }), false);
  assert.equal(settle(), undefined, 'foreign completion ignored');
  failSend = true;
  assert.equal(await deliver(), false);
  failSend = false;
  assert.equal(settle(), undefined, 'failed delivery cannot create retry');
  assert.equal(handlers.has('agent_before_settle'), false);
  await deliver();
  messages.length = 0;
  assert.equal(settle(), undefined, 'removed context cannot revive stale completion');
  assert.equal(handlers.has('agent_before_settle'), false);
  await deliver();
  const preDraftContext = { context: { contextMessages: messages, pendingMessages: [], canContinue: false } };
  const appendedReminder = settle(preDraftContext);
  assert.equal(appendedReminder.continue, true, 'appended reminder supplies runnable context');
  assert.equal(appendedReminder.entries[0].customType, 'subagent-completion-unanswered');
  messages.push({ ...appendedReminder.entries[0], role: 'custom' });
  const blocked = settle(preDraftContext);
  assert.equal(blocked.continue, undefined);
  assert.match(blocked.entries[0].content, /^UNHANDLED:/);
  assert.equal(settle(preDraftContext), undefined, 'pre-draft continuation state cannot reset budget');
  held = true;
  await deliver();
  assert.match(sent.at(-1).message.content, /The user stopped the parent turn\./);
  assistant([{ type: 'text', text: '' }]);
  assert.equal(settle(), undefined, 'a held notice never revives the stopped task');
  assert.equal(handlers.has('agent_before_settle'), false);
  held = false;
  await deliver();
  notifier.bindSession({ getSessionId: () => 'other' });
  assert.equal(settle(), undefined, 'session switch clears acknowledgement state');
  assert.equal(handlers.has('agent_before_settle'), false);
  notifier.dispose();
  assert.equal(handlers.has('agent_before_settle'), false);

} finally {
  notifier.dispose();
}

});
