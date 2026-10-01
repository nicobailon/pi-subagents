import path from "node:path";
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
	"control", "output", "outputMode", "outputSchema", "acceptance",
	"mission", "missionId", "agentScope", "capabilityCeiling",
]);

const MANAGEMENT_ACTION_FIELDS: Record<string, ReadonlySet<string>> = {
	list: new Set(["action", "capabilities", "agentScope"]),
	// Read-only discovery of retained resumable workflow writers. It is not an
	// exhaustive list of direct native children.
	"children.list": new Set(["action"]),
	status: new Set(["action", "id", "runId", "dir", "index", "view", "lines"]),
	interrupt: new Set(["action", "id", "runId", "dir", "index"]),
	stop: new Set(["action", "id", "runId", "dir", "index", "childId"]),
	resume: new Set(["action", "id", "runId", "dir", "index", "message", "task", "agentScope", "capabilityCeiling"]),
	steer: new Set(["action", "id", "runId", "dir", "index", "message", "task", "mode", "steeringRecovery", "agentScope", "capabilityCeiling"]),
	"mission.list": new Set(["action", "missionScope"]),
	"mission.show": new Set(["action", "missionId"]),
	"mission.update": new Set(["action", "missionId", "missionUpdate"]),
	"mission.resolve-decision": new Set(["action", "missionId", "id", "summary"]),
	"mission.close": new Set(["action", "missionId", "missionStatus", "summary"]),
	doctor: new Set(["action"]),
	guide: new Set(["action", "topic"]),
};

const ORCHESTRATION_PROMPT = `
<orchestration_mode>
You are operating in explicit Pi orchestration mode. You are the workflow coordinator for this session; there is no separate orchestrator child.

The routing contract in ~/.pi/agent/ROUTING.md is authoritative. Own the user's requested outcome, completion conditions, and sequencing until terminal completion or a genuine human/external blocker. After each result, ask what material evidence is still missing and take the smallest action that can supply it. Do not delegate merely because a semantic role exists, and do not treat a launch or dispatch receipt as completion. Select children by role name only; never choose or override child model/provider IDs.

For substantial multi-step delegated work, compile the user's prose contract into the existing Pi primitives instead of repeatedly restating it: use the child task for the bounded brief, explicit \`skill\` binding for required domain procedure, non-shell \`acceptance\` criteria/evidence/stop rules for completion, a \`mission\`/\`missionId\` when recovery or cross-run continuity matters, and managed \`output\` when a handoff must survive the child. Reuse the same mission across continuation/review runs. Mission records are evidence and recovery state, not a project manager: do not invent phases, duplicate repository truth, or use receipts as permission to merge/deploy/release.

Use bounded read-only inspection directly when it can cheaply establish current state or close a factual gap. Delegate when fresh context, specialization, parallelism, isolation, data/shell execution, independent challenge, or mutation ownership is materially useful. Do not perform leaf implementation, shell execution, data computation, source mutation, or substitute your own routine review for an independent reviewer when one is required. Generic child roles intentionally receive no default skills: bind only the smallest applicable skill set with the singular child launch parameter \`skill\`. If an explicitly requested skill cannot resolve, treat that as a routing error rather than silently continuing.

The worker remains the sole implementation writer. Consume its concrete changed-file and validation evidence before deciding what comes next. For sequential mutation in the same working state, resume the most recent writer by default; start a fresh writer only when fresh context or isolation is itself useful. Use a fresh reviewer when independent review is requested, required by the task/routing contract, or materially useful to acceptance; do not add review ceremony solely because a mutation occurred. Adjudicate reviewer findings, send accepted concrete defects back to the same worker when practical, and re-establish affected evidence after repair instead of assuming the fix closes the task. If a repair changes a semantic mechanism, contract, evidence generator, validation boundary, or population/coverage assumption, run a fresh targeted review of that changed blast radius unless a deterministic oracle fully proves it; a mechanical rerun alone is insufficient. A supported blocked state is a valid terminal outcome.

Do not bypass semantic roles with external CLI writer agents, acceptance/gate shell commands, raw workflow scripts, or model overrides. Prefer direct role launches and native Pi lifecycle/status/mission operations. Read-only \`children.list\` discovers retained resumable workflow writers; it is not an exhaustive list of direct native children. Do not invent a second orchestration state machine: repository/result state plus existing mission, child, repository, and acceptance evidence are authoritative.
</orchestration_mode>`;

interface PersistedModeState { enabled: boolean; normalTools?: string[] }

interface OrchestrationModeOptions {
	discoverUserAgentNames?: (cwd: string) => string[];
}

export interface OrchestrationPolicyDecision {
	block: true;
	reason: string;
}

export interface OrchestrationPolicyResult {
	/** Rejection for the request. Present means the request must not execute. */
	block?: OrchestrationPolicyDecision;
	/** Normalized request. Identical to the input when policy is inactive; otherwise a fresh clone. */
	params: Record<string, unknown>;
}

export interface OrchestrationModeHandle {
	isEnabled(): boolean;
	/**
	 * Return a normalized clone of the request plus an optional block decision.
	 * Never mutates `input`, which may be caller-owned, frozen, or non-extensible.
	 * When orchestration is inactive the input is returned unchanged.
	 */
	applyPolicy(input: Record<string, unknown>): OrchestrationPolicyResult;
}

function sameTools(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function acceptanceUsesRuntimeCommands(value: unknown): boolean {
	return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "verify"));
}

function outputEscapesManagedArtifacts(value: unknown): boolean {
	if (value === undefined || value === false || value === "false") return false;
	if (typeof value !== "string" || !value.trim()) return true;
	if (path.isAbsolute(value)) return true;
	const normalized = path.normalize(value);
	return normalized === ".." || normalized.startsWith(`..${path.sep}`);
}

export function registerOrchestrationMode(pi: ExtensionAPI, options: OrchestrationModeOptions = {}): OrchestrationModeHandle {
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
	const persist = (persistedTools?: string[]) => {
		const tools = persistedTools ?? normalTools;
		pi.appendEntry<PersistedModeState>(ENTRY_TYPE, { enabled, ...(tools ? { normalTools: [...tools] } : {}) });
	};
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
		let restored: string[] | undefined;
		if (normalTools) {
			const available = availableToolNames();
			restored = normalTools.filter((name) => available.has(name));
			setTools(restored);
		}
		normalTools = undefined;
		// Persist the restored pre-orchestration set with the disabled state so a
		// later branch switch back to this point restores the same tool set instead
		// of whatever the previously live branch happened to have.
		if (shouldPersist) persist(restored);
		ctx.ui.notify("Pi orchestration mode OFF", "info");
	};
	const resync = (ctx: ExtensionContext) => {
		const persisted = latestPersistedState(ctx);
		if (persisted?.enabled) {
			const persistedNormalTools = persisted.normalTools ? [...persisted.normalTools] : undefined;
			if (!enabled) {
				normalTools = persistedNormalTools ?? [...pi.getActiveTools()];
			} else if (persistedNormalTools && !sameTools(normalTools ?? [], persistedNormalTools)) {
				// enabled -> enabled branch switch: adopt the target branch's own
				// pre-orchestration tool set instead of carrying the previous branch's.
				normalTools = persistedNormalTools;
			}
			enabled = true;
			setTools(orchestrationTools());
			return;
		}
		if (persisted?.normalTools) {
			// Entered a persisted disabled branch that recorded its own pre-orchestration
			// set: restore that branch's set rather than the previous live branch's.
			const available = availableToolNames();
			setTools(persisted.normalTools.filter((name) => available.has(name)));
		} else if (enabled && normalTools) {
			// Left an orchestration branch with no persisted entry (or an old entry
			// without normalTools): restore the set remembered when orchestration was
			// entered.
			const available = availableToolNames();
			setTools(normalTools.filter((name) => available.has(name)));
		}
		enabled = false;
		normalTools = undefined;
	};

	const userRoleCapabilityCeiling = (): { block: true; reason: string } | Record<string, unknown> => {
		let userAgentNames: string[];
		try {
			userAgentNames = discoverUserAgentNames(currentCwd);
		} catch (error) {
			return { block: true, reason: `Pi orchestration mode could not validate the user role catalog: ${error instanceof Error ? error.message : String(error)}` };
		}
		return {
			version: 1,
			allowedAgents: [...userAgentNames].sort(),
			denyExtensions: false,
			sources: ["orchestration-mode:user-role-catalog"],
		};
	};
	// Governs coordinator-initiated public execution lanes only (model tool calls,
	// slash/prompt-template bridges, RPC). Scheduled automation and structured owned
	// delegation are separate non-coordinator lanes that intentionally bypass this
	// policy; do not wire them through here. Explicit orchestration mode is transient
	// session state and must not govern those lanes.
	//
	// One policy boundary shared by the model tool_call hook and every governed
	// execution path, so no entry point can bypass the user-role/no-workflowScript/
	// no-model-override restrictions. `input` is never mutated: a normalized clone is
	// returned, so frozen or caller-owned request objects are safe. Applying the
	// returned params more than once is safe (idempotent): internal fields it writes
	// are accepted on re-entry and overwritten with the same policy.
	const applyPolicy = (input: Record<string, unknown>): OrchestrationPolicyResult => {
		if (!enabled) return { params: input };
		const normalized = { ...input };
		const action = typeof normalized.action === "string" ? normalized.action : undefined;
		if (action) {
			// Own-key lookup so inherited object keys ("constructor", "toString", ...)
			// are rejected as unknown actions instead of reaching ReadonlySet.has unbound.
			const allowedFields = Object.hasOwn(MANAGEMENT_ACTION_FIELDS, action) ? MANAGEMENT_ACTION_FIELDS[action] : undefined;
			if (!allowedFields) return { block: { block: true, reason: `Pi orchestration mode permits only approved native lifecycle actions; management action '${action}' is not allowed.` }, params: normalized };
			const unexpected = Object.keys(normalized).filter((field) => normalized[field] !== undefined && !allowedFields.has(field));
			if (unexpected.length > 0) return { block: { block: true, reason: `Pi orchestration mode forbids management-action override(s): ${unexpected.join(", ")}.` }, params: normalized };
			if (action === "guide" && normalized.topic === "workflows") normalized.topic = "orchestration";
			if (action === "resume" || action === "steer" || action === "list") normalized.agentScope = "user";
			// A missed live steer must not turn into an implicit child revival with a
			// broader execution contract. The coordinator can issue an explicit,
			// parameter-bounded resume instead.
			if (action === "steer") normalized.steeringRecovery = false;
			// Resume/steer can revive a persisted recovery descriptor that is not in
			// the current discovery scope. Carry the same user-role ceiling the
			// executor already intersects into every revival path so the persisted
			// fallback cannot widen the semantic role catalog.
			if (action === "resume" || action === "steer") {
				const ceiling = userRoleCapabilityCeiling();
				if ("block" in ceiling) return { block: ceiling as OrchestrationPolicyDecision, params: normalized };
				normalized.capabilityCeiling = ceiling;
			}
			return { params: normalized };
		}
		if (typeof normalized.agent !== "string" || typeof normalized.task !== "string") {
			return { block: { block: true, reason: "Pi orchestration mode requires direct semantic child launches with both agent and task." }, params: normalized };
		}
		const unexpected = Object.keys(normalized).filter((field) => normalized[field] !== undefined && !DIRECT_LAUNCH_FIELDS.has(field));
		if (unexpected.length > 0) {
			return { block: { block: true, reason: `Pi orchestration mode permits only direct semantic launch fields; unsupported override(s): ${unexpected.join(", ")}.` }, params: normalized };
		}
		if (acceptanceUsesRuntimeCommands(normalized.acceptance)) {
			return { block: { block: true, reason: "Pi orchestration mode forbids acceptance.verify runtime commands; use child-reported evidence and semantic review instead." }, params: normalized };
		}
		if (outputEscapesManagedArtifacts(normalized.output)) {
			return { block: { block: true, reason: "Pi orchestration mode permits only relative managed output paths; absolute paths, parent traversal, and implicit agent-default outputs are not allowed." }, params: normalized };
		}
		let userAgentNames: string[];
		try {
			userAgentNames = discoverUserAgentNames(currentCwd);
		} catch (error) {
			return { block: { block: true, reason: `Pi orchestration mode could not validate the user role catalog: ${error instanceof Error ? error.message : String(error)}` }, params: normalized };
		}
		if (!userAgentNames.includes(normalized.agent)) {
			return { block: { block: true, reason: `Pi orchestration mode may launch only user-owned semantic roles; '${normalized.agent}' is not in the user role catalog.` }, params: normalized };
		}
		// Ignore project-local role definitions while orchestrating. The operational
		// role catalog is the user-level catalog configured for this Pi installation.
		normalized.agentScope = "user";
		// The executor also applies this ceiling to nested/recovery launch paths. It
		// prevents a runtime-registered role from becoming an execution escape after
		// the tool_call hook has validated the direct request.
		normalized.capabilityCeiling = {
			version: 1,
			allowedAgents: [...userAgentNames].sort(),
			denyExtensions: false,
			sources: ["orchestration-mode:user-role-catalog"],
		};
		return { params: normalized };
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
		const policy = applyPolicy((event.input ?? {}) as Record<string, unknown>);
		if (policy.block) return policy.block;
		// `event.input` is pi-owned and documented mutable; copy the normalized clone
		// onto it so execution sees the policy values. `applyPolicy` never mutates the
		// caller's request object itself. A non-extensible input is left untouched here;
		// executeSubagentReady normalizes its own copy before executing.
		if (event.input && typeof event.input === "object" && Object.isExtensible(event.input)) {
			Object.assign(event.input as Record<string, unknown>, policy.params);
		}
	});

	pi.on("before_agent_start", (event) => enabled ? { systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATION_PROMPT}` } : undefined);

	return { isEnabled: () => enabled, applyPolicy };
}
