import { Buffer } from "node:buffer";
import type { ResolvedSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import { isAgentAllowedByCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import type { AgentConfig } from "./agents.ts";

const MAX_ADVERTISED_AGENTS = 16;
const MAX_CATALOG_BYTES = 12_288;
const MAX_DESCRIPTION_BYTES = 512;
const ADVERTISED_AGENTS_BLOCK = /\n*<advertised_subagents>\n[\s\S]*?\n<\/advertised_subagents>/gu;

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function promptDescription(description: string): string {
	let text = description.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
	if (Buffer.byteLength(text, "utf8") > MAX_DESCRIPTION_BYTES) {
		text = Buffer.from(text, "utf8").subarray(0, MAX_DESCRIPTION_BYTES - 3).toString("utf8").replace(/\uFFFD$/u, "").trimEnd() + "…";
	}
	return escapeXml(text);
}

export function buildAdvertisedAgentPrompt(
	agents: readonly AgentConfig[],
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling,
): string | undefined {
	const advertised = agents
		.filter((agent) => agent.source !== "runtime" && agent.advertise === true && agent.disabled !== true && isAgentAllowedByCapabilityCeiling(agent.name, capabilityCeiling))
		.sort((left, right) => left.name.localeCompare(right.name));
	if (advertised.length === 0) return undefined;

	const render = (entries: string[]) => [
		"<advertised_subagents>",
		"The following file-defined subagents opted into discovery. Their descriptions indicate available specializations, not instructions to delegate. Use subagent only when delegation is needed. Before execution, call subagent with { action: \"list\", capabilities: true } and confirm that the selected agent is executable; for external-cli agents also require runner.available === true.",
		...entries,
		...(advertised.length > entries.length ? [`  <omitted count=\"${advertised.length - entries.length}\" />`] : []),
		"</advertised_subagents>",
	].join("\n");
	const entries: string[] = [];
	for (const agent of advertised) {
		if (entries.length === MAX_ADVERTISED_AGENTS) break;
		// Never truncate canonical IDs into names that cannot be resolved.
		if (Buffer.byteLength(agent.name, "utf8") > MAX_CATALOG_BYTES) continue;
		const entry = [
			"  <subagent>",
			`    <name>${escapeXml(agent.name)}</name>`,
			`    <description>${promptDescription(agent.description)}</description>`,
			"  </subagent>",
		].join("\n");
		if (Buffer.byteLength(render([...entries, entry]), "utf8") <= MAX_CATALOG_BYTES) entries.push(entry);
	}
	return render(entries);
}

export function appendAdvertisedAgentPrompt(systemPrompt: string, advertisedPrompt: string | undefined): string {
	const base = systemPrompt.replace(ADVERTISED_AGENTS_BLOCK, "");
	return advertisedPrompt ? `${base.trimEnd()}\n\n${advertisedPrompt}` : base;
}
