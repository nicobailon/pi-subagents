import type { ExtensionConfig } from "../shared/types.ts";

/**
 * Opt-in feature groups an operator can remove from the parent-facing `subagent` tool.
 * Each group owns parameters and actions that no other feature uses, so hiding them
 * cannot remove a field that enabled behavior still needs. Per-call options disable
 * only the per-call override; configured defaults keep applying.
 */
export const SUBAGENT_FEATURES = {
	"agent-management": {
		actions: ["create", "update", "delete", "eject", "disable", "enable", "reset", "refine", "refine.show", "refine.rollback"],
		params: ["config"],
	},
	watchdog: {
		actions: ["watchdog.status", "watchdog.check", "watchdog.configure", "watchdog.recommend-model"],
		params: ["scope", "target", "thinking"],
	},
	panes: {
		actions: ["inspector.open", "inspector.command", "inspector.status", "inspector.close", "project.open", "project.status", "project.close"],
		params: ["focus"],
	},
	"spawn-budget-grants": { actions: ["grant-spawn-budget"], params: ["additional"] },
	preflight: { actions: [], params: ["preflight"] },
	"lane-metadata": { actions: [], params: ["lane"] },
	gates: { actions: [], params: ["gate"] },
	"usage-budgets": { actions: [], params: ["usageBudget"] },
	"tool-budgets": { actions: [], params: ["toolBudget"] },
	"control-overrides": { actions: [], params: ["control"] },
	"extension-bindings": { actions: [], params: ["extensionBindings"] },
} as const satisfies Record<string, { actions: readonly string[]; params: readonly string[] }>;

export type SubagentFeature = keyof typeof SUBAGENT_FEATURES;

const SCHEDULE_SURFACE = {
	actions: ["schedule.create", "schedule.list", "schedule.show", "schedule.history", "schedule.pause", "schedule.resume", "schedule.run", "schedule.run-due", "schedule.delete"],
	params: ["name", "at", "every", "sessionOnly", "quiet", "on", "timezone", "overlap", "catchUp"],
} as const;

const SCHEDULES_DISABLED_BY = "scheduledRuns.enabled=false";

function isSubagentFeature(value: string): value is SubagentFeature {
	return Object.hasOwn(SUBAGENT_FEATURES, value);
}

export function validateDisabledFeatures(value: unknown): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) throw new Error("config.disabledFeatures must be an array of feature names");
	const seen = new Set<string>();
	for (const entry of value) {
		if (entry === "schedules") throw new Error(`config.disabledFeatures does not accept "schedules"; set config.scheduledRuns.enabled to false instead`);
		if (typeof entry !== "string" || !isSubagentFeature(entry)) {
			throw new Error(`config.disabledFeatures entry ${JSON.stringify(entry)} is not one of: ${Object.keys(SUBAGENT_FEATURES).join(", ")}`);
		}
		if (seen.has(entry)) throw new Error(`config.disabledFeatures lists "${entry}" more than once`);
		seen.add(entry);
	}
}

/** Maps each disabled parameter and action to the setting that disabled it. */
export interface DisabledFeatureSurface {
	params: ReadonlyMap<string, string>;
	actions: ReadonlyMap<string, string>;
}

export function resolveDisabledFeatureSurface(config: Pick<ExtensionConfig, "disabledFeatures" | "scheduledRuns">): DisabledFeatureSurface {
	const params = new Map<string, string>();
	const actions = new Map<string, string>();
	for (const feature of config.disabledFeatures ?? []) {
		const disabledBy = `disabledFeatures "${feature}"`;
		for (const param of SUBAGENT_FEATURES[feature].params) params.set(param, disabledBy);
		for (const action of SUBAGENT_FEATURES[feature].actions) actions.set(action, disabledBy);
	}
	if (config.scheduledRuns?.enabled === false) {
		for (const param of SCHEDULE_SURFACE.params) params.set(param, SCHEDULES_DISABLED_BY);
		for (const action of SCHEDULE_SURFACE.actions) actions.set(action, SCHEDULES_DISABLED_BY);
	}
	return { params, actions };
}

/** Returns why a request uses a disabled feature, or undefined when every requested field is enabled. */
export function disabledFeatureUseError(request: object, surface: DisabledFeatureSurface, label = "subagent"): string | undefined {
	const params = request as Record<string, unknown>;
	const action = typeof params.action === "string" ? params.action.trim() : undefined;
	const disabledAction = action === undefined ? undefined : surface.actions.get(action);
	if (disabledAction) return `${label} action '${action}' is disabled by config ${disabledAction}.`;
	for (const [param, disabledBy] of surface.params) {
		if (params[param] !== undefined) return `${label} option '${param}' is disabled by config ${disabledBy}.`;
	}
	return undefined;
}
