import { Buffer } from "node:buffer";
import type { ResolvedSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import { isAgentAllowedByCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import type { AgentConfig } from "./agents.ts";

const MAX_ADVERTISED_AGENTS = 16;
const MAX_DESCRIPTION_BYTES = 512;
const ADVERTISED_AGENTS_BLOCK = /\n*<advertised_subagents>\n[\s\S]*?\n<\/advertised_subagents>/gu;

function truncateUtf8Head(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const truncated = Buffer.from(value, "utf8").subarray(0, Math.max(0, maxBytes - 3)).toString("utf8").replace(/\uFFFD$/u, "");
	return `${truncated.trimEnd()}…`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function promptDescription(description: string): string {
	return escapeXml(truncateUtf8Head(description.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim(), MAX_DESCRIPTION_BYTES));
}

export function buildAdvertisedAgentPrompt(
	agents: readonly AgentConfig[],
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling,
): string | undefined {
	const advertised = agents
		.filter((agent) => agent.advertise === true && agent.disabled !== true && isAgentAllowedByCapabilityCeiling(agent.name, capabilityCeiling))
		.sort((left, right) => left.name.localeCompare(right.name));
	if (advertised.length === 0) return undefined;

	const visible = advertised.slice(0, MAX_ADVERTISED_AGENTS);
	const entries = visible.map((agent) => [
		"  <subagent>",
		`    <name>${escapeXml(agent.name)}</name>`,
		`    <description>${promptDescription(agent.description)}</description>`,
		"  </subagent>",
	].join("\n"));
	const omitted = advertised.length - visible.length;

	return [
		"<advertised_subagents>",
		"The following configured subagents opted into parent-prompt discovery. Use their descriptions as routing guidance. When a request clearly matches one, delegate to it instead of independently reproducing the same capability. Before execution, call subagent with { action: \"list\", capabilities: true } and confirm that the selected agent is executable.",
		...entries,
		...(omitted > 0 ? [`  <omitted count=\"${omitted}\" />`] : []),
		"</advertised_subagents>",
	].join("\n");
}

export function appendAdvertisedAgentPrompt(systemPrompt: string, advertisedPrompt: string | undefined): string {
	const base = systemPrompt.replace(ADVERTISED_AGENTS_BLOCK, "").trimEnd();
	return advertisedPrompt ? `${base}\n\n${advertisedPrompt}` : base;
}
