export interface ChildToolAccess {
	allowlist?: string[];
	excluded: string[];
	ceiling?: string[];
	denyExtensions?: boolean;
	host: "parent" | "runner";
}

export function missingToolRecovery(agent: string, tools: string[], available: string[], access?: ChildToolAccess): string {
	const lines = ["Child tool availability diagnosis:", `Agent: ${agent}`, `Available tools: ${available.join(", ") || "none"}`];
	if (access?.denyExtensions) lines.push("The inherited capability ceiling denies extensions. An extension-provided tool such as the MCP gateway cannot be enabled by changing profiles; ask the owner to change the policy.");
	for (const name of tools) {
		if (available.includes(name)) {
			lines.push(`${name}: registered in the child. Inspect the tool's actual error; this is not a missing-tool failure.`);
		} else if (access?.ceiling && !access.ceiling.includes(name)) {
			lines.push(`${name}: excluded by the inherited capability ceiling. A different profile cannot widen this ceiling; ask the owner to change the policy.`);
		} else if (access?.excluded.includes(name)) {
			lines.push(`${name}: explicitly excluded by the agent's excludeTools configuration.`);
		} else if (access?.allowlist && !access.allowlist.includes(name)) {
			lines.push(`${name}: absent from the agent's strict tools allowlist. Task instructions do not add tools.`);
		} else {
			lines.push(`${name}: not registered in the child. Check the tool provider and extension loading.`);
		}
	}
	if (tools.includes("mcp") && !available.includes("mcp")) {
		lines.push("The MCP gateway tool is missing; this does not establish a server, network, or authentication failure.");
		if (access?.host === "parent") lines.push("This is a foreground child. Ambient MCP adapters load in background children; select async:true for a fresh launch.");
	}
	lines.push(
		`Inspect the profile with subagent({action:"get",agent:${JSON.stringify(agent)}}) and alternatives with subagent({action:"list",options:{capabilities:true}}).`,
		"If authorized, choose or create a profile with the required tools and loaded providers, then launch a new child with the original task. Do not silently relax the task or substitute parent-fetched evidence for required independent research.",
		"Retrying unchanged or resuming this child retains its tool contract. Stop or finish this blocked child before replacing it. This report grants no additional permissions.",
	);
	return lines.join("\n");
}
