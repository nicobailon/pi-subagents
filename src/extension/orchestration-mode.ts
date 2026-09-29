import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../agents/agents.ts";

const ENTRY_TYPE = "pi-subagents-orchestration-mode";

const ORCHESTRATION_TOOLS = [
	"read", "grep", "find", "ls", "watchdog_diff",
	"subagent", "subagent_supervisor", "contact_supervisor", "bg_wait",
	"question", "todo", "todo_read", "todo_write",
	// Read-oriented Notion tools (pi-notion); filtered out when not installed.
	"notion_search", "notion_fetch",
];

const DIRECT_LAUNCH_FIELDS = new Set([
	"agent", "task", "skill", "cwd", "worktree", "baseRef", "context", "async",
	"timeoutMs", "maxRuntimeMs", "checkpointBeforeDeadlineMs", "toolTimeoutMs",
	"toolBudget", "usageBudget", "artifacts", "includeProgress", "chatProgress",
	"control", "outputSchema", "agentScope",
]);

const MANAGEMENT_ACTION_FIELDS: Record<string, ReadonlySet<string>> = {
	list: new Set(["action", "capabilities", "agentScope"]),
	status: new Set(["action", "id", "runId", "dir", "index", "view", "lines"]),
	interrupt: new Set(["action", "id", "runId", "dir", "index"]),
	stop: new Set(["action", "id", "runId", "dir", "index", "childId"]),
	resume: new Set(["action", "id", "runId", "dir", "index", "message", "task", "agentScope"]),
	steer: new Set(["action", "id", "runId", "dir", "index", "message", "task", "mode", "steeringRecovery", "agentScope"]),
	doctor: new Set(["action"]),
	guide: new Set(["action", "topic"]),
};

const ORCHESTRATION_PROMPT = `
<orchestration_mode>
You are operating in explicit Pi orchestration mode. You are the workflow coordinator for this session; there is no separate orchestrator child.

The routing contract in ~/.pi/agent/ROUTING.md is authoritative. Own the user's requested outcome, completion conditions, and sequencing until terminal completion or a genuine human/external blocker. After each result, ask what material evidence is still missing and take the smallest action that can supply it. Do not delegate merely because a semantic role exists, and do not treat a launch or dispatch receipt as completion. Select children by role name only; never choose or override child model/provider IDs.

Use bounded read-only inspection directly when it can cheaply establish current state or close a factual gap. Delegate when fresh context, specialization, parallelism, isolation, data/shell execution, independent challenge, or mutation ownership is materially useful. Do not perform leaf implementation, shell execution, data computation, source mutation, or substitute your own routine review for an independent reviewer when one is required. Generic child roles intentionally receive no default skills: bind only the smallest applicable skill set with the singular child launch parameter \`skill\`. If an explicitly requested skill cannot resolve, treat that as a routing error rather than silently continuing.

The worker remains the sole implementation writer. Consume its concrete changed-file and validation evidence before deciding what comes next. For sequential mutation in the same working state, resume the most recent writer by default; start a fresh writer only when fresh context or isolation is itself useful. Use a fresh reviewer when independent review is requested, required by the task/routing contract, or materially useful to acceptance; do not add review ceremony solely because a mutation occurred. Adjudicate reviewer findings, send accepted concrete defects back to the same worker when practical, and re-establish affected evidence after repair instead of assuming the fix closes the task. If a repair changes a semantic mechanism, contract, evidence generator, validation boundary, or population/coverage assumption, run a fresh targeted review of that changed blast radius unless a deterministic oracle fully proves it; a mechanical rerun alone is insufficient. A supported blocked state is a valid terminal outcome.

Do not bypass semantic roles with external CLI writer agents, acceptance/gate shell commands, raw workflow scripts, or model overrides. Prefer direct role launches and native Pi lifecycle/status operations. Do not invent a second orchestration state machine: repository/result state plus existing child and acceptance evidence are authoritative.
</orchestration_mode>`;

interface PersistedModeState { enabled: boolean; normalTools?: string[] }

interface OrchestrationModeOptions {
	discoverUserAgentNames?: (cwd: string) => string[];
}

function sameTools(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function registerOrchestrationMode(pi: ExtensionAPI, options: OrchestrationModeOptions = {}): void {
	let enabled = false;
	let normalTools: string[] | undefined;
	let currentCwd = process.cwd();
	const discoverUserAgentNames = options.discoverUserAgentNames ?? ((cwd: string) => discoverAgents(cwd, "user").agents
		.filter((agent) => agent.source === "user")
		.map((agent) => agent.name));

	const availableToolNames = () => new Set(pi.getAllTools().map((tool) => tool.name));
	const orchestrationTools = () => {
		const available = availableToolNames();
		return ORCHESTRATION_TOOLS.filter((name) => available.has(name));
	};
	const setTools = (tools: string[]) => {
		const current = pi.getActiveTools();
		if (!sameTools(current, tools)) pi.setActiveTools(tools);
	};
	const persist = () => pi.appendEntry<PersistedModeState>(ENTRY_TYPE, { enabled, ...(normalTools ? { normalTools: [...normalTools] } : {}) });
	const latestPersistedState = (ctx: ExtensionContext): PersistedModeState | undefined => {
		const getBranch = (ctx.sessionManager as { getBranch?: () => unknown[] }).getBranch;
		if (typeof getBranch !== "function") return undefined;
		const entries = getBranch.call(ctx.sessionManager);
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			if (!entry.data || typeof entry.data !== "object") return undefined;
			const candidate = entry.data as PersistedModeState;
			return {
				enabled: candidate.enabled === true,
				...(Array.isArray(candidate.normalTools) && candidate.normalTools.every((tool) => typeof tool === "string") ? { normalTools: [...candidate.normalTools] } : {}),
			};
		}
		return undefined;
	};
	const enter = (ctx: ExtensionContext, shouldPersist = true) => {
		if (!enabled) normalTools = [...pi.getActiveTools()];
		enabled = true;
		setTools(orchestrationTools());
		if (shouldPersist) persist();
		ctx.ui.notify("Pi orchestration mode ON", "info");
	};
	const exit = (ctx: ExtensionContext, shouldPersist = true) => {
		if (!enabled) return;
		enabled = false;
		if (normalTools) {
			const available = availableToolNames();
			setTools(normalTools.filter((name) => available.has(name)));
		}
		normalTools = undefined;
		if (shouldPersist) persist();
		ctx.ui.notify("Pi orchestration mode OFF", "info");
	};
	const resync = (ctx: ExtensionContext) => {
		const persisted = latestPersistedState(ctx);
		if (persisted?.enabled) {
			if (!enabled) normalTools = persisted.normalTools ?? [...pi.getActiveTools()];
			enabled = true;
			setTools(orchestrationTools());
			return;
		}
		if (enabled && normalTools) {
			const available = availableToolNames();
			setTools(normalTools.filter((name) => available.has(name)));
		}
		enabled = false;
		normalTools = undefined;
	};

	pi.registerFlag("orchestrate", { description: "Start this Pi session in orchestration mode", type: "boolean" });
	pi.registerCommand("orchestrate", {
		description: "Toggle orchestration mode, or use /orchestrate on|off|status",
		handler: async (args, ctx) => {
			const action = (args ?? "").trim().toLowerCase();
			if (action === "status") { ctx.ui.notify(`Pi orchestration mode is ${enabled ? "ON" : "OFF"}`, "info"); return; }
			if (action === "off") { exit(ctx); return; }
			if (action === "on") { enter(ctx); return; }
			if (action && action !== "toggle") { ctx.ui.notify("Usage: /orchestrate [on|off|status]", "warning"); return; }
			if (enabled) exit(ctx); else enter(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		currentCwd = ctx.cwd;
		resync(ctx);
		if (pi.getFlag("orchestrate") === true && !enabled) enter(ctx);
	});
	pi.on("session_tree", (_event, ctx) => { currentCwd = ctx.cwd; resync(ctx); });

	pi.on("tool_call", (event) => {
		if (!enabled || event.toolName !== "subagent") return;
		const input = (event.input ?? {}) as Record<string, unknown>;
		const action = typeof input.action === "string" ? input.action : undefined;
		if (action) {
			const allowedFields = MANAGEMENT_ACTION_FIELDS[action];
			if (!allowedFields) return { block: true, reason: `Pi orchestration mode permits only read/control subagent actions; management action '${action}' is not allowed.` };
			const unexpected = Object.keys(input).filter((field) => input[field] !== undefined && !allowedFields.has(field));
			if (unexpected.length > 0) return { block: true, reason: `Pi orchestration mode forbids management-action override(s): ${unexpected.join(", ")}.` };
			if (action === "guide" && input.topic === "workflows") input.topic = "orchestration";
			if (action === "resume" || action === "steer" || action === "list") input.agentScope = "user";
			// A missed live steer must not turn into an implicit child revival with a
			// broader execution contract. The coordinator can issue an explicit,
			// parameter-bounded resume instead.
			if (action === "steer") input.steeringRecovery = false;
			return;
		}
		if (typeof input.agent !== "string" || typeof input.task !== "string") {
			return { block: true, reason: "Pi orchestration mode requires direct semantic child launches with both agent and task." };
		}
		const unexpected = Object.keys(input).filter((field) => input[field] !== undefined && !DIRECT_LAUNCH_FIELDS.has(field));
		if (unexpected.length > 0) {
			return { block: true, reason: `Pi orchestration mode permits only direct semantic launch fields; unsupported override(s): ${unexpected.join(", ")}.` };
		}
		let userAgentNames: string[];
		try {
			userAgentNames = discoverUserAgentNames(currentCwd);
		} catch (error) {
			return { block: true, reason: `Pi orchestration mode could not validate the user role catalog: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!userAgentNames.includes(input.agent)) {
			return { block: true, reason: `Pi orchestration mode may launch only user-owned semantic roles; '${input.agent}' is not in the user role catalog.` };
		}
		// Ignore project-local role definitions while orchestrating. The operational
		// role catalog is the user-level catalog configured for this Pi installation.
		input.agentScope = "user";
		// The executor also applies this ceiling to nested/recovery launch paths. It
		// prevents a runtime-registered role from becoming an execution escape after
		// the tool_call hook has validated the direct request.
		input.capabilityCeiling = {
			version: 1,
			allowedAgents: [...userAgentNames].sort(),
			denyExtensions: false,
			sources: ["orchestration-mode:user-role-catalog"],
		};
	});

	pi.on("before_agent_start", (event) => enabled ? { systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATION_PROMPT}` } : undefined);
}
