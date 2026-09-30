/**
 * Opt-in feature groups an operator can remove from the parent-facing `subagent` tool.
 * Groups own parameters and actions that enabled features do not need, so hiding them
 * cannot remove a field that enabled behavior still needs. `preflight` is the one shared
 * parameter: it is script-only, so `workflow-scripts` removes it too. Per-call options
 * disable only the per-call override; configured defaults keep applying.
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
	missions: {
		actions: ["mission.create", "mission.list", "mission.show", "mission.update", "mission.resolve-decision", "mission.attach-run", "mission.close"],
		params: ["mission", "missionUpdate", "missionStatus", "missionScope", "missionId", "runMode", "runStatus", "summary"],
	},
	"lane-management": {
		actions: ["lane.status", "lane.recordMerge", "lane.recordSupersession", "worktree.discard", "worktree.cleanup"],
		params: ["handoffPath", "laneId", "merge", "supersession", "repo", "planId"],
	},
	"spawn-budget-grants": { actions: ["grant-spawn-budget"], params: ["additional"] },
	preflight: { actions: [], params: ["preflight"] },
	"lane-metadata": { actions: [], params: ["lane"] },
	gates: { actions: [], params: ["gate"] },
	"usage-budgets": { actions: [], params: ["usageBudget"] },
	"tool-budgets": { actions: [], params: ["toolBudget"] },
	"control-overrides": { actions: [], params: ["control"] },
	"extension-bindings": { actions: [], params: ["extensionBindings"] },
	"external-machines": { actions: [], params: ["machine"] },
	"workflow-scripts": { actions: ["validate"], params: ["workflow", "args", "preflight", "globalConcurrencyLimit", "maxSubagentSpawnsPerRun"] },
} as const satisfies Record<string, { actions: readonly string[]; params: readonly string[] }>;

export type SubagentFeature = keyof typeof SUBAGENT_FEATURES;

/** Schedules are turned off by `scheduledRuns.enabled: false`, not by `disabledFeatures`. */
export type SubagentSurfaceFeature = SubagentFeature | "schedules";

const SCHEDULE_SURFACE = {
	actions: ["schedule.create", "schedule.list", "schedule.show", "schedule.history", "schedule.pause", "schedule.resume", "schedule.run", "schedule.run-due", "schedule.delete"],
	params: ["name", "at", "every", "sessionOnly", "quiet", "on", "timezone", "overlap", "catchUp"],
} as const;

export function validateDisabledFeatures(value: unknown): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) throw new Error("config.disabledFeatures must be an array of feature names");
	const seen = new Set<string>();
	for (const entry of value) {
		if (entry === "schedules") throw new Error(`config.disabledFeatures does not accept "schedules"; set config.scheduledRuns.enabled to false instead`);
		if (typeof entry !== "string" || !Object.hasOwn(SUBAGENT_FEATURES, entry)) {
			throw new Error(`config.disabledFeatures entry ${JSON.stringify(entry)} is not one of: ${Object.keys(SUBAGENT_FEATURES).join(", ")}`);
		}
		if (seen.has(entry)) throw new Error(`config.disabledFeatures lists "${entry}" more than once`);
		seen.add(entry);
	}
}

/** Disabled features, and each disabled parameter and action mapped to the setting that disabled it. */
export interface DisabledFeatureSurface {
	features: ReadonlySet<SubagentSurfaceFeature>;
	params: ReadonlyMap<string, string>;
	actions: ReadonlyMap<string, string>;
}

interface FeatureConfig {
	disabledFeatures?: readonly SubagentFeature[];
	scheduledRuns?: { enabled?: boolean };
}

function featureSurface(feature: SubagentSurfaceFeature): { actions: readonly string[]; params: readonly string[]; disabledBy: string } {
	if (feature === "schedules") return { ...SCHEDULE_SURFACE, disabledBy: "scheduledRuns.enabled=false" };
	return { ...SUBAGENT_FEATURES[feature], disabledBy: `disabledFeatures "${feature}"` };
}

export function resolveDisabledFeatureSurface(config: FeatureConfig): DisabledFeatureSurface {
	const features = new Set<SubagentSurfaceFeature>(config.disabledFeatures);
	if (config.scheduledRuns?.enabled === false) features.add("schedules");
	const params = new Map<string, string>();
	const actions = new Map<string, string>();
	for (const feature of features) {
		const surface = featureSurface(feature);
		// A parameter shared with workflow-scripts is always attributed to workflow-scripts,
		// whatever order the config lists the features in.
		for (const param of surface.params) if (feature === "workflow-scripts" || !params.has(param)) params.set(param, surface.disabledBy);
		for (const action of surface.actions) actions.set(action, surface.disabledBy);
	}
	return { features, params, actions };
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
	// workflowScript is the internal carrier for slash, prompt-workflow, RPC, and scheduled scripts.
	// Callers check the original request, before the package lowers chain/tasks into its own script.
	if (params.workflowScript !== undefined && surface.features.has("workflow-scripts")) {
		return `${label} workflow scripts are disabled by config ${featureSurface("workflow-scripts").disabledBy}.`;
	}
	return undefined;
}

/** Lists what config disabled, for prepending to static reference docs that describe the full tool. */
export function disabledFeatureNotice(surface: DisabledFeatureSurface): string | undefined {
	if (surface.features.size === 0) return undefined;
	const lines = [...surface.features].map((feature) => {
		const { actions, params, disabledBy } = featureSurface(feature);
		const parts = [`options ${params.join(", ")}`, ...(actions.length > 0 ? [`actions ${actions.join(", ")}`] : [])];
		return `- ${disabledBy}: ${parts.join("; ")}`;
	});
	return `Disabled by config in this session. The reference below still lists these, but calls that use them are rejected:\n${lines.join("\n")}`;
}
