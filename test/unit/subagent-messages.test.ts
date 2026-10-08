import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CustomMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { renderSubagentEntry, renderSubagentMessage } from "../../src/tui/subagent-messages.ts";

// Markdown bodies read Pi's markdown theme, which Pi initializes at startup.
initTheme("dark");

const plainTheme = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
};

const tokenTheme = {
	fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
	bg: (token: string, text: string) => `[${token}]${text.trimEnd()}[/${token}]`,
	bold: (text: string) => `<b>${text}</b>`,
};

type TestTheme = typeof plainTheme;

function renderMessage(customType: string, details: unknown, options: { content?: string; expanded?: boolean; width?: number; theme?: TestTheme } = {}): string[] {
	const message = { customType, content: options.content ?? "", details };
	// SAFETY: the renderer reads only fg, bg, and bold from Pi's theme.
	const component = renderSubagentMessage(message, { expanded: options.expanded ?? false }, (options.theme ?? plainTheme) as never);
	assert.ok(component, `no renderer for ${customType}`);
	return component.render(options.width ?? 100).map((line) => line.trimEnd());
}

function renderEntry(customType: string, data: unknown, options: { expanded?: boolean; width?: number; theme?: TestTheme } = {}): string[] {
	// SAFETY: the renderer reads only fg, bg, and bold from Pi's theme.
	const component = renderSubagentEntry({ customType, data }, { expanded: options.expanded ?? false }, (options.theme ?? plainTheme) as never);
	assert.ok(component, `no renderer for ${customType}`);
	return component.render(options.width ?? 100).map((line) => line.trimEnd());
}

function visibleLines(lines: string[]): string[] {
	return lines.map((line) => stripAnsi(line).trimEnd()).filter((line) => line.trim().length > 0);
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The collapsed line's label color and its headline before the hint, with theme tokens marked. */
function tokenLine(line: string | undefined): { label: string; headline: string } | undefined {
	const match = /^\[customMessageBg\] <(\w+)><b>\[subagent\]<\/b><\/\1> (.*) <dim>\((?:click|ctrl\+o) to expand\)<\/dim>\[\/customMessageBg\]$/.exec(line ?? "");
	return match ? { label: match[1]!, headline: match[2]! } : undefined;
}

function tonedHeadline(customType: string, details: unknown, content = ""): string | undefined {
	return tokenLine(renderMessage(customType, details, { content, theme: tokenTheme, width: 400 })[1])?.headline;
}

// keyText resolves Pi's expand key through the pi-tui copy that pi-coding-agent loads.
async function bindExpandKey(t: TestContext, keys: string): Promise<void> {
	const agentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	// SAFETY: this path is pi-tui's package entry, resolved from where pi-coding-agent loads it.
	const tui = await import(pathToFileURL(createRequire(agentEntry).resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");
	const previous = tui.getKeybindings();
	tui.setKeybindings(new tui.KeybindingsManager({ ...tui.TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: keys, description: "Toggle tool output" } }));
	t.after(() => tui.setKeybindings(previous));
}

const request = { id: "request-1", requestId: "request-1", runId: "run-1", agent: "worker", childIndex: 0, expectsReply: true };
const reply = { requestId: "request-1", reason: "need_decision", runId: "run-1", agent: "worker", childIndex: 1, childTarget: "child-worker", message: "Approved; continue.", createdAt: 123 };
const watchdogWarning = { severity: "blocker", importance: "high", category: "other", source: "main", agent: "worker", summary: "Edits a migration without a backfill", evidence: "diff touches db/migrations/0042.sql", recommendedAction: "Add a reversible backfill" };

describe("subagent messages in the main chat", () => {
	it("shows a supervisor request as one [subagent] line", () => {
		const headline = (details: unknown) => visibleLines(renderMessage("subagent_supervisor_request", details));
		assert.deepEqual(headline({ ...request, reason: "need_decision" }), [" [subagent] worker needs a decision (click to expand)"]);
		assert.deepEqual(headline({ ...request, reason: "interview_request" }), [" [subagent] worker asks for structured answers (click to expand)"]);
		assert.deepEqual(headline({ ...request, reason: "progress_update" }), [" [subagent] worker sent a progress update (click to expand)"]);
		assert.deepEqual(headline(request), [" [subagent] worker needs a decision (click to expand)"]);
		assert.deepEqual(headline({ ...request, agent: 42 }), [" [subagent] supervisor request (click to expand)"]);
		assert.deepEqual(headline(undefined), [" [subagent] supervisor request (click to expand)"]);
	});

	it("shows attention and steering notices as one [subagent] line with toned status words", () => {
		const rows: Array<[string, unknown, string, string]> = [
			["subagent_control_notice", { event: { type: "needs_attention", agent: "worker", runId: "run-1", message: "stuck", ts: 1 } }, "worker needs attention", "<customMessageText>worker </customMessageText><warning>needs attention</warning>"],
			["subagent_control_notice", { event: { type: "active_long_running", agent: "worker", runId: "run-1", message: "slow", ts: 1 } }, "worker active long running", "<customMessageText>worker active long running</customMessageText>"],
			["subagent_control_notice", {}, "subagent notice", "<customMessageText>subagent notice</customMessageText>"],
			["subagent_steering_notice", { type: "subagent.steering.notice", ts: 1, runId: "run-1", requestId: "steer-1", state: "failed", message: "child exited" }, "steering for run run-1 failed", "<customMessageText>steering for run run-1 </customMessageText><error>failed</error>"],
			["subagent_steering_notice", { type: "subagent.steering.notice", ts: 1, runId: "run-1", requestId: "steer-1", state: "partial", message: "one child missed it" }, "steering for run run-1 partial", "<customMessageText>steering for run run-1 </customMessageText><error>partial</error>"],
			["subagent_steering_notice", { type: "subagent.steering.notice", ts: 1, runId: "run-1", requestId: "steer-1", state: "recovered", message: "delivered on retry" }, "steering for run run-1 recovered", "<customMessageText>steering for run run-1 </customMessageText><warning>recovered</warning>"],
			["subagent_steering_notice", { runId: "run-1", state: "lost" }, "steering notice", "<customMessageText>steering notice</customMessageText>"],
		];
		for (const [customType, details, text, toned] of rows) {
			assert.deepEqual(visibleLines(renderMessage(customType, details)), [` [subagent] ${text} (click to expand)`], customType);
			assert.equal(tonedHeadline(customType, details), toned, customType);
		}
	});

	it("shows completion notices as one [subagent] line, including notices saved without details", () => {
		const rows: Array<[unknown, string, string, string]> = [
			[{ runs: [{ agent: "scout", status: "completed" }] }, "", "scout completed", "<customMessageText>scout </customMessageText><success>completed</success>"],
			[{ runs: [{ agent: "worker", status: "failed" }] }, "", "worker failed", "<customMessageText>worker </customMessageText><error>failed</error>"],
			[{ runs: [{ agent: "scout", status: "completed" }, { agent: "worker", status: "failed" }, { agent: "reviewer", status: "stopped" }] }, "", "3 background runs finished · 1 failed · 1 stopped", "<customMessageText>3 background runs finished · 1 </customMessageText><error>failed</error><customMessageText> · 1 </customMessageText><warning>stopped</warning>"],
			[{ runs: [{ agent: "scout", status: "completed" }, { agent: "worker", status: "completed" }] }, "", "2 background runs completed", "<customMessageText>2 background runs </customMessageText><success>completed</success>"],
			[undefined, "Background task paused: **worker** (Migrate the index)\n\nNeeds a decision.", "worker paused", "<customMessageText>worker </customMessageText><warning>paused</warning>"],
			[undefined, "Detached foreground task completed: **reviewer**\n\nRecovered final review", "reviewer completed", "<customMessageText>reviewer </customMessageText><success>completed</success>"],
			[undefined, "Background tasks completed (2): **scout**, **worker**\n\n1. scout\nDone", "2 background runs finished", "<customMessageText>2 background runs finished</customMessageText>"],
			[undefined, "Something else", "background run finished", "<customMessageText>background run finished</customMessageText>"],
		];
		for (const [details, content, text, toned] of rows) {
			assert.deepEqual(visibleLines(renderMessage("subagent-notify", details, { content })), [` [subagent] ${text} (click to expand)`], text);
			assert.equal(tonedHeadline("subagent-notify", details, content), toned, text);
		}
	});

	it("shows reminders, bg_wait wakes, and workflow notices as one [subagent] line", () => {
		const rows: Array<[string, unknown, string, string, string]> = [
			["subagent-supervisor-unanswered", { requestIds: ["request-1"] }, "", "1 supervisor request unanswered", "<customMessageText>1 supervisor request </customMessageText><warning>unanswered</warning>"],
			["subagent-supervisor-unanswered", { requestIds: ["request-1", "request-2"] }, "", "2 supervisor requests unanswered", "<customMessageText>2 supervisor requests </customMessageText><warning>unanswered</warning>"],
			["subagent-supervisor-unanswered", undefined, "", "supervisor requests unanswered", "<customMessageText>supervisor requests </customMessageText><warning>unanswered</warning>"],
			["subagent-supervisor-blocked", { blocked: true, requestIds: ["request-1"] }, "", "1 supervisor request blocked", "<customMessageText>1 supervisor request </customMessageText><error>blocked</error>"],
			["subagent-completion-unanswered", undefined, "", "completion results unanswered", "<customMessageText>completion results </customMessageText><warning>unanswered</warning>"],
			["subagent-completion-unhandled", undefined, "", "completion results unhandled", "<customMessageText>completion results </customMessageText><error>unhandled</error>"],
			["subagent-wait-subscription", { token: "wait-1", runId: "run-1", outcome: "completed" }, "", "bg_wait: run run-1 completed", "<customMessageText>bg_wait: run run-1 </customMessageText><success>completed</success>"],
			["subagent-wait-subscription", { token: "wait-1", runId: "run-1", outcome: "timed out" }, "", "bg_wait: run run-1 timed out", "<customMessageText>bg_wait: run run-1 </customMessageText><warning>timed out</warning>"],
			["subagent-wait-subscription", { token: "wait-1", runId: "run-1", outcome: "reconciliation failed" }, "", "bg_wait: run run-1 reconciliation failed", "<customMessageText>bg_wait: run run-1 </customMessageText><error>reconciliation failed</error>"],
			["subagent-wait-subscription", { token: "wait-1", runId: "run-1", outcome: "detached" }, "", "bg_wait: run run-1 detached", "<customMessageText>bg_wait: run run-1 detached</customMessageText>"],
			["subagent-wait-subscription", undefined, "", "bg_wait fired", "<customMessageText>bg_wait fired</customMessageText>"],
			["subagent-incremental-child-notify", { childKey: "review", outcome: "failed" }, "", "workflow child review failed", "<customMessageText>workflow child review </customMessageText><error>failed</error>"],
			["subagent-incremental-child-notify", undefined, "Workflow child paused (needs attention): **review**\nWorkflow run: wf-1", "workflow child review paused", "<customMessageText>workflow child review </customMessageText><warning>paused</warning>"],
			["subagent-incremental-child-notify", undefined, "Something else", "workflow child update", "<customMessageText>workflow child update</customMessageText>"],
			["subagent-workflow-result-write-failed", undefined, "", "workflow result save failed", "<customMessageText>workflow result </customMessageText><error>save failed</error>"],
		];
		for (const [customType, details, content, text, toned] of rows) {
			assert.deepEqual(visibleLines(renderMessage(customType, details, { content })), [` [subagent] ${text} (click to expand)`], text);
			assert.equal(tonedHeadline(customType, details, content), toned, text);
		}
	});

	it("shows watchdog warnings and clarifications as one [subagent] line", () => {
		const rows: Array<[string, unknown, string, string, string]> = [
			["subagent_watchdog_warning", watchdogWarning, "<subagent_watchdog>", "watchdog blocker", "<customMessageText>watchdog </customMessageText><error>blocker</error>"],
			["subagent_watchdog_warning", { ...watchdogWarning, severity: "concern" }, "<subagent_watchdog>", "watchdog concern", "<customMessageText>watchdog </customMessageText><warning>concern</warning>"],
			["subagent_watchdog_warning", { severity: "blocker" }, "<subagent_watchdog>", "watchdog warning", "<customMessageText>watchdog warning</customMessageText>"],
			["subagent_watchdog_clarification", undefined, "Which migration is current?", "watchdog needs clarification", "<customMessageText>watchdog </customMessageText><warning>needs clarification</warning>"],
		];
		for (const [customType, details, content, text, toned] of rows) {
			assert.deepEqual(visibleLines(renderMessage(customType, details, { content })), [` [subagent] ${text} (click to expand)`], text);
			assert.equal(tonedHeadline(customType, details, content), toned, text);
		}
		assert.deepEqual(visibleLines(renderEntry("subagent_watchdog_warning", watchdogWarning)), [" [subagent] watchdog blocker (click to expand)"]);
		assert.deepEqual(visibleLines(renderEntry("subagent_watchdog_warning", { summary: "No evidence" })), [" [subagent] watchdog warning (click to expand)"]);
	});

	it("keeps a watchdog warning's lifecycle state on the collapsed line", () => {
		const rows: Array<[unknown, string]> = [
			[{ ...watchdogWarning, state: "displayed" }, "watchdog blocker"],
			[{ ...watchdogWarning, state: "stalemate", stalemateRepeats: 3 }, "watchdog blocker · stalemate"],
			[{ ...watchdogWarning, severity: "concern", stale: true, state: "stale" }, "watchdog concern · stale"],
			[{ ...watchdogWarning, state: "failed", error: "review timed out" }, "watchdog blocker · failed review"],
		];
		for (const [details, text] of rows) {
			assert.deepEqual(visibleLines(renderMessage("subagent_watchdog_warning", details, { content: "<subagent_watchdog>" })), [` [subagent] ${text} (click to expand)`], text);
			assert.deepEqual(visibleLines(renderEntry("subagent_watchdog_warning", details)), [` [subagent] ${text} (click to expand)`], text);
		}
	});

	it("expands watchdog warnings to the readable warning instead of the model's XML", () => {
		const readable = [
			" [subagent] watchdog blocker",
			" Subagent watchdog Blocker: Edits a migration without a backfill",
			" Evidence: diff touches db/migrations/0042.sql",
			" Recommended action: Add a reversible backfill",
			" Importance: High · Category: Other · Source: main · Agent: worker",
		];
		assert.deepEqual(visibleLines(renderMessage("subagent_watchdog_warning", watchdogWarning, { content: "<subagent_watchdog severity=\"blocker\">", expanded: true, width: 200 })), readable);
		assert.deepEqual(visibleLines(renderEntry("subagent_watchdog_warning", watchdogWarning, { expanded: true, width: 200 })), readable);
	});

	it("shows the supervisor reply entry as one [subagent] line", () => {
		assert.deepEqual(visibleLines(renderEntry("subagent_supervisor_reply", reply)), [" [subagent] reply sent to worker (click to expand)"]);
		assert.deepEqual(visibleLines(renderEntry("subagent_supervisor_reply", { ...reply, message: ["bad"] })), [" [subagent] supervisor reply (click to expand)"]);
	});

	it("expands a message to the text the main agent read, as markdown", () => {
		const content = [
			"Subagent needs a supervisor decision.",
			"Run: run-1",
			"Agent: worker",
			"Child index: 0",
			"",
			"Should I drop the old `users.email` index first?",
			"",
			"Reply with: subagent_supervisor({ action: \"reply\", replyTo: \"request-1\", message: \"...\" })",
		].join("\n");
		assert.deepEqual(visibleLines(renderMessage("subagent_supervisor_request", { ...request, reason: "need_decision" }, { content, expanded: true, width: 200 })), [
			" [subagent] worker needs a decision",
			" Subagent needs a supervisor decision.",
			" Run: run-1",
			" Agent: worker",
			" Child index: 0",
			" Should I drop the old users.email index first?",
			" Reply with: subagent_supervisor({ action: \"reply\", replyTo: \"request-1\", message: \"...\" })",
		]);
	});

	it("expands the supervisor reply entry to the reply and the request it answers", () => {
		assert.deepEqual(visibleLines(renderEntry("subagent_supervisor_reply", reply, { expanded: true })), [
			" [subagent] reply sent to worker",
			" Request: request-1",
			" Run: run-1",
			" Child index: 1",
			" Child target: child-worker",
			" Approved; continue.",
		]);
	});

	it("names Pi's expand key in the hint, or a click when no key is bound", async (t) => {
		const collapsed = () => visibleLines(renderMessage("subagent_supervisor_request", { ...request, reason: "need_decision" }));
		assert.deepEqual(collapsed(), [" [subagent] worker needs a decision (click to expand)"]);
		await bindExpandKey(t, "ctrl+o");
		assert.deepEqual(collapsed(), [" [subagent] worker needs a decision (ctrl+o to expand)"]);
	});

	it("colors the [subagent] label by message kind", () => {
		const label = (lines: string[]) => tokenLine(lines[1])?.label;
		const messages: Array<[string, unknown, string, string]> = [
			["subagent_supervisor_request", { ...request, reason: "need_decision" }, "", "customMessageLabel"],
			["subagent-supervisor-unanswered", { requestIds: ["request-1"] }, "", "customMessageLabel"],
			["subagent-supervisor-blocked", { blocked: true, requestIds: ["request-1"] }, "", "customMessageLabel"],
			["subagent-notify", { runs: [{ agent: "scout", status: "completed" }] }, "", "mdLink"],
			["subagent-completion-unanswered", undefined, "", "mdLink"],
			["subagent-completion-unhandled", undefined, "", "mdLink"],
			["subagent-incremental-child-notify", { childKey: "review", outcome: "failed" }, "", "mdLink"],
			["subagent-wait-subscription", { token: "wait-1", runId: "run-1", outcome: "completed" }, "", "mdLink"],
			["subagent-workflow-result-write-failed", undefined, "", "mdLink"],
			["subagent_control_notice", { event: { type: "needs_attention", agent: "worker", runId: "run-1", message: "stuck", ts: 1 } }, "", "customMessageLabel"],
			["subagent_steering_notice", { runId: "run-1", state: "failed" }, "", "customMessageLabel"],
			["subagent_watchdog_warning", watchdogWarning, "<subagent_watchdog>", "toolTitle"],
			["subagent_watchdog_clarification", undefined, "Which migration is current?", "toolTitle"],
		];
		for (const [customType, details, content, color] of messages) {
			assert.equal(label(renderMessage(customType, details, { content, theme: tokenTheme, width: 400 })), color, customType);
		}
		assert.equal(label(renderEntry("subagent_supervisor_reply", reply, { theme: tokenTheme, width: 400 })), "customMessageText");
		assert.equal(label(renderEntry("subagent_watchdog_warning", watchdogWarning, { theme: tokenTheme, width: 400 })), "toolTitle");
	});

	it("keeps the collapsed block to one line at narrow widths", () => {
		const lines = visibleLines(renderMessage("subagent_supervisor_request", { ...request, reason: "interview_request" }, { width: 24 }));
		assert.deepEqual(lines, [" [subagent] worker ask…"]);
		assert.ok(visibleWidth(lines[0]!) <= 24);
	});

	it("draws Pi's custom-message block and tones only the status word", () => {
		const lines = renderMessage("subagent_supervisor_request", { ...request, reason: "need_decision" }, { theme: tokenTheme, width: 300 });
		assert.deepEqual(lines, [
			"[customMessageBg][/customMessageBg]",
			"[customMessageBg] <customMessageLabel><b>[subagent]</b></customMessageLabel> <customMessageText>worker </customMessageText><warning>needs a decision</warning> <dim>(click to expand)</dim>[/customMessageBg]",
			"[customMessageBg][/customMessageBg]",
		]);
		const expanded = renderMessage("subagent_supervisor_request", { ...request, reason: "need_decision" }, { theme: tokenTheme, width: 300, expanded: true, content: "First line\n\n- second line" });
		assert.equal(expanded.length, 7);
		for (const line of expanded) assert.match(line, /^\[customMessageBg\].*\[\/customMessageBg\]$/);
	});

	it("renders escape sequences from message text inert", () => {
		const details = { ...request, agent: "wor\x1b[31mker", reason: "need_decision" };
		const content = "Run \x1b]0;pwned\x07this";
		for (const expanded of [false, true]) {
			const text = renderMessage("subagent_supervisor_request", details, { content, expanded, width: 200 }).join("\n");
			assert.match(text, /wor\[U\+001B\]\[31mker/);
			assert.equal(text.includes("\x1b[31m"), false);
			assert.equal(text.includes("\x1b]0;"), false);
		}
		const expandedText = renderMessage("subagent_supervisor_request", details, { content, expanded: true, width: 200 }).join("\n");
		assert.match(expandedText, /Run \[U\+001B\]\]0;pwned\[U\+0007\]this/);
	});

	it("toggles one block on a click, and Pi's expand key discards earlier clicks", () => {
		const message = { customType: "subagent_supervisor_request", content: "Should I continue?", details: { ...request, reason: "need_decision" } };
		const otherMessage = { ...message };
		const render = (target: typeof message, expandedByPi: boolean) => {
			// SAFETY: the renderer reads only fg, bg, and bold from Pi's theme.
			const component = renderSubagentMessage(target, { expanded: expandedByPi }, plainTheme as never);
			assert.ok(component);
			return component;
		};
		const click = (component: ReturnType<typeof render>, button: "left" | "right" = "left") => {
			const height = component.render(100).length;
			return component.handleMouse?.({ type: "click", button, x: 2, y: 1, screenX: 2, screenY: 1, width: 100, height, shift: false, alt: false, ctrl: false });
		};
		const collapsed = [" [subagent] worker needs a decision (click to expand)"];
		const expanded = [" [subagent] worker needs a decision", " Should I continue?"];

		const block = render(message, false);
		assert.equal(click(block, "right"), undefined);
		assert.deepEqual(visibleLines(block.render(100)), collapsed);
		assert.equal(click(block)?.handled, true);
		assert.deepEqual(visibleLines(block.render(100)), expanded);
		assert.deepEqual(visibleLines(render(message, false).render(100)), expanded);
		assert.deepEqual(visibleLines(render(otherMessage, false).render(100)), collapsed);
		assert.deepEqual(visibleLines(render(message, true).render(100)), expanded);
		assert.deepEqual(visibleLines(render(message, false).render(100)), collapsed);
	});

	it("opens and closes inside Pi's own message component, by Pi's expand toggle or a click", () => {
		const message = { role: "custom" as const, customType: "subagent_supervisor_request", content: "Should I continue?", display: true, details: { ...request, reason: "need_decision" }, timestamp: 1 };
		const host = new CustomMessageComponent(message, renderSubagentMessage);
		const shown = () => visibleLines(host.render(100));
		const collapsed = [" [subagent] worker needs a decision (click to expand)"];
		const expanded = [" [subagent] worker needs a decision", " Should I continue?"];

		assert.deepEqual(shown(), collapsed);
		host.setExpanded(true);
		assert.deepEqual(shown(), expanded);
		host.setExpanded(false);
		assert.deepEqual(shown(), collapsed);
		const height = host.render(100).length;
		assert.equal(host.handleMouse({ type: "click", button: "left", x: 2, y: 2, screenX: 2, screenY: 2, width: 100, height, shift: false, alt: false, ctrl: false })?.handled, true);
		assert.deepEqual(shown(), expanded);
		host.setExpanded(true);
		host.setExpanded(false);
		assert.deepEqual(shown(), collapsed);
	});
});
