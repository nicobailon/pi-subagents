import assert from "node:assert/strict";
import fs from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function waitForRelease(signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => { watcher.close(); signal?.removeEventListener("abort", finish); resolve(); };
		const watcher = fs.watch("/stage", (_event, file) => { if (file === "release") finish(); });
		signal?.addEventListener("abort", finish, { once: true });
		if (signal?.aborted || fs.existsSync("/stage/release")) finish();
	});
}

export default function registerSmokeProvider(pi: ExtensionAPI) {
	const mode = process.env.PI_STANDALONE_SMOKE_MODE;
	if (mode === "sdk-init-failure" && fs.existsSync("/stage/parent-initialized")) {
		fs.writeFileSync("/stage/provider-failure.json", JSON.stringify({ pid: process.pid, reason: "fixture provider initialization failure" }));
		throw new Error("fixture provider initialization failure");
	}
	const faux = fauxProvider({ provider: "standalone-smoke", models: [{ id: "local" }], tokensPerSecond: 100000 });
	faux.setResponses([
		async (context, options) => {
			const messages = JSON.stringify(context.messages);
			const revival = mode === "revival" && /REVIVAL_[AB]/.test(messages);
			const failingRevival = mode === "revival" && messages.includes("REVIVAL_FAIL");
			const waiting = !failingRevival && (revival || ["shared-run", "parallel-stop", "targeted-controls", "steer", "interrupt", "stop", "child-stop", "child-timeout", "run-timeout"].includes(mode ?? "")) ? waitForRelease(options?.signal) : undefined;
			fs.appendFileSync("/stage/lifecycle.jsonl", JSON.stringify({ event: "request", case: process.env.PI_STANDALONE_CASE, pid: process.pid, messages: context.messages }) + "\n");
			await waiting;
			if (failingRevival) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture revival failure" });
			if (revival) return fauxAssistantMessage(`standalone child response verified ${messages.includes("REVIVAL_A") ? "REVIVAL_A" : "REVIVAL_B"}`);
			if (mode === "tool-timeout") return fauxAssistantMessage(fauxToolCall("bash", { command: 'printf "%s\\n" "$$" > /stage/tool.pid; exec sleep 60' }), { stopReason: "toolUse" });
			const label = ["FIRST", "LEFT", "RIGHT"].find((name) => JSON.stringify(context.messages).includes(name)) ?? "SINGLE";
			return fauxAssistantMessage(`standalone child response verified ${label}`);
		},
		async (context, options) => {
			const shared = mode === "shared-run" || mode === "parallel-stop";
			const waiting = shared ? waitForRelease(options?.signal) : undefined;
			fs.appendFileSync("/stage/lifecycle.jsonl", JSON.stringify({ event: shared ? "request" : "followup", case: process.env.PI_STANDALONE_CASE, pid: process.pid, messages: context.messages }) + "\n");
			await waiting;
			if (shared) {
				const label = ["LEFT", "RIGHT"].find((name) => JSON.stringify(context.messages).includes(name));
				return fauxAssistantMessage(`standalone child response verified ${label}`);
			}
			return fauxAssistantMessage("standalone child response verified after steering");
		},
	]);
	pi.registerProvider(faux.provider);
	pi.on("session_start", (_event, ctx) => {
		assert.ok(ctx.sessionManager instanceof SessionManager, "extension and real session must share the embedded SDK identity");
		fs.appendFileSync("/stage/lifecycle.jsonl", JSON.stringify({ event: "start", sessionId: ctx.sessionManager.getSessionId(), sdkIdentity: ctx.sessionManager instanceof SessionManager, case: process.env.PI_STANDALONE_CASE, pid: process.pid, executable: process.execPath, tools: pi.getActiveTools(), model: ctx.model?.id, provider: ctx.model?.provider }) + "\n");
	});
	pi.on("session_shutdown", (_event, ctx) => {
		fs.appendFileSync("/stage/lifecycle.jsonl", JSON.stringify({ event: "shutdown", sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), case: process.env.PI_STANDALONE_CASE, pid: process.pid, calls: faux.state.callCount }) + "\n");
	});
}
