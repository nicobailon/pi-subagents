import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";

const OPENCODE_HOST = "opencode.ai";

function matchesOpenCodeHost(baseUrl: string): boolean {
	try {
		return new URL(baseUrl).hostname === OPENCODE_HOST;
	} catch {
		return false;
	}
}

/**
 * OpenCode session-routing headers for internal subagent model calls.
 *
 * Pi's own session path emits these from coding-agent's provider-attribution
 * merge, but subagent-internal calls (watchdog review, permission arbiter,
 * task-mutation arbiter, prompt audit) stream through bare Agents that bypass
 * that path. Without them OpenCode falls back to client-IP affinity and loses
 * prompt-cache routing (see pi issue #4847). Returns undefined for every other
 * provider so non-OpenCode requests stay byte-identical.
 */
export function opencodeSessionHeaders(
	model: Pick<Model<Api>, "provider" | "baseUrl">,
	sessionId: string | undefined,
): ProviderHeaders | undefined {
	if (!sessionId) return undefined;
	if (model.provider !== "opencode" && model.provider !== "opencode-go" && !matchesOpenCodeHost(model.baseUrl)) return undefined;
	return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}
