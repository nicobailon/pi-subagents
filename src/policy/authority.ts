export const AUTHORITY_ACTIONS = [
	"discardWorktree",
	"destructiveCleanup",
	"spawnBudgetGrant",
	"scheduleCreate",
	"stopRun",
	"steerRun",
	"inspectorOpen",
	"projectOpen",
] as const;

export type AuthorityAction = typeof AUTHORITY_ACTIONS[number];
export type AuthorityDecision = "auto" | "confirm" | "forbid";
export type AuthorityPolicyConfig = Partial<Record<AuthorityAction, AuthorityDecision>>;

const DEFAULT_AUTHORITY_POLICY: Record<AuthorityAction, AuthorityDecision> = {
	discardWorktree: "confirm",
	destructiveCleanup: "confirm",
	spawnBudgetGrant: "confirm",
	scheduleCreate: "auto",
	stopRun: "auto",
	steerRun: "auto",
	inspectorOpen: "auto",
	projectOpen: "confirm",
};

export function resolveAuthorityDecision(input: {
	action: AuthorityAction;
	policy?: AuthorityPolicyConfig;
}): AuthorityDecision {
	return input.policy?.[input.action] ?? DEFAULT_AUTHORITY_POLICY[input.action];
}

const MANAGEMENT_ACTION_AUTHORITY: Readonly<Record<string, AuthorityAction>> = {
	"worktree.cleanup": "discardWorktree",
	"worktree.discard": "discardWorktree",
	"grant-spawn-budget": "spawnBudgetGrant",
	stop: "stopRun",
	"command.cancel": "stopRun",
	steer: "steerRun",
	"command.yield": "steerRun",
	"schedule.create": "scheduleCreate",
	"inspector.open": "inspectorOpen",
	"project.open": "projectOpen",
};

export function authorityConfirmTitle(action: string, targets?: readonly string[]): string {
	return targets ? `Authorize subagent ${action} of ${targets.join(", ")}?` : `Authorize subagent ${action}?`;
}

/** The authority a `subagent` management action needs and its decision; `worktree.cleanup` needs one only with mode "apply". */
export function managementActionAuthority(action: string, mode: unknown, policy: AuthorityPolicyConfig | undefined): { authority: AuthorityAction; decision: AuthorityDecision } | undefined {
	if (!Object.hasOwn(MANAGEMENT_ACTION_AUTHORITY, action) || (action === "worktree.cleanup" && mode !== "apply")) return undefined;
	const authority = MANAGEMENT_ACTION_AUTHORITY[action]!;
	return { authority, decision: resolveAuthorityDecision({ action: authority, ...(policy ? { policy } : {}) }) };
}

export function validateAuthorityPolicy(value: unknown, label = "config.authorityPolicy"): AuthorityPolicyConfig | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be a JSON object`);
	}
	const policy = value as Record<string, unknown>;
	const allowedActions = new Set<string>(AUTHORITY_ACTIONS);
	for (const [action, decision] of Object.entries(policy)) {
		if (!allowedActions.has(action)) {
			throw new Error(`${label}.${action} is unknown; expected one of ${AUTHORITY_ACTIONS.join(", ")}`);
		}
		if (decision !== "auto" && decision !== "confirm" && decision !== "forbid") {
			throw new Error(`${label}.${action} must be "auto", "confirm", or "forbid"`);
		}
	}
	return policy as AuthorityPolicyConfig;
}
