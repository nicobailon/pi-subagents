/**
 * Operator force (`subagents.operatorModelOverride`) parsing for agent
 * discovery.
 *
 * Operator force is owned by the USER settings file only: discovery parses
 * it exclusively from the user settings read (`operatorOwned`), so a project
 * settings file can neither supply, shadow, nor disable it. The shape is
 * `{ enabled: boolean, agents: { <agent name>: <policy id> } }`; when
 * enabled, each named native Pi agent is forced onto the virtual model
 * `policy/<policy id>`, winning over the agent definition, `agentOverrides`,
 * and per-call model selection. Forced policy ids must exist in the same
 * user file's `subagents.modelPolicies`; the policy definitions themselves
 * are validated and routed by the host extension that registers `policy/*`
 * virtual models, never resolved against a merged or project map here.
 *
 * A present-but-malformed force authority fails closed: parsing throws with
 * a settings error so launches refuse instead of silently running unforced.
 * When `enabled` is false the `agents` map carries no authority and is not
 * validated.
 */

export interface OperatorForceSettings {
	/** Agent name -> forced policy id (bare id, without the `policy/` prefix). Only present when force is enabled. */
	agents: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses `subagents.operatorModelOverride` from one raw `subagents` settings
 * object. Callers must only pass the operator-owned (user) settings object;
 * project settings are never an input. Returns undefined when force is
 * absent or disabled; throws on malformed authority.
 */
export function parseOperatorForceSettings(
	subagentsObject: Record<string, unknown>,
	filePath: string,
): OperatorForceSettings | undefined {
	const rawForce = subagentsObject.operatorModelOverride;
	if (rawForce === undefined) return undefined;
	if (!isRecord(rawForce)) {
		throw new Error(`Subagent settings in '${filePath}' have invalid 'operatorModelOverride'; expected an object {enabled, agents}. Malformed operator force authority fails closed.`);
	}
	if (typeof rawForce.enabled !== "boolean") {
		throw new Error(`Subagent settings in '${filePath}' have invalid 'operatorModelOverride.enabled'; expected a boolean. Malformed operator force authority fails closed.`);
	}
	if (!rawForce.enabled) return undefined;
	if (!isRecord(rawForce.agents)) {
		throw new Error(`Subagent settings in '${filePath}' have invalid 'operatorModelOverride.agents'; expected an object mapping agent names to policy ids when force is enabled.`);
	}
	const policies = isRecord(subagentsObject.modelPolicies) ? subagentsObject.modelPolicies : undefined;
	const agents: Record<string, string> = {};
	for (const [agentName, rawPolicyId] of Object.entries(rawForce.agents)) {
		if (agentName === "" || typeof rawPolicyId !== "string" || rawPolicyId === "" || /\s/.test(rawPolicyId)) {
			throw new Error(`Subagent settings in '${filePath}' have invalid 'operatorModelOverride.agents["${agentName}"]'; expected a policy id (non-empty string without whitespace).`);
		}
		if (!policies || !Object.hasOwn(policies, rawPolicyId)) {
			throw new Error(`Subagent settings in '${filePath}' force agent '${agentName}' onto policy '${rawPolicyId}', which is not defined in the user settings 'subagents.modelPolicies'; refusing rather than resolving against a merged or project map.`);
		}
		agents[agentName] = rawPolicyId;
	}
	return { agents };
}

/**
 * The forced virtual model (`policy/<id>`) for one discovered agent, or
 * undefined when the agent is not forced. External-CLI/external-job runners
 * and machine-placed agents are never forced: they cannot load the host
 * extension that serves `policy/*` virtual models.
 */
export function operatorForcedModelForAgent(
	force: OperatorForceSettings | undefined,
	agent: { name: string; runner?: { type: string }; machine?: string },
): string | undefined {
	if (!force) return undefined;
	const policyId = force.agents[agent.name];
	if (policyId === undefined) return undefined;
	if (agent.runner !== undefined && agent.runner.type !== "pi") return undefined;
	if (agent.machine !== undefined) return undefined;
	return `policy/${policyId}`;
}
