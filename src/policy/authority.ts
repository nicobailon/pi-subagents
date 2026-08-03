export const AUTHORITY_ACTIONS = [
	"discardWorktree",
	"destructiveCleanup",
	"spawnBudgetGrant",
	"scheduleCreate",
	"stopRun",
	"steerRun",
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
};

export function resolveAuthorityDecision(input: {
	action: AuthorityAction;
	policy?: AuthorityPolicyConfig;
}): AuthorityDecision {
	return input.policy?.[input.action] ?? DEFAULT_AUTHORITY_POLICY[input.action];
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
