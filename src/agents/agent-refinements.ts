import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { discoverAgents, formatUnknownAgentError, resolveAgentName, unknownAgentDiagnosticContext, type AgentConfig } from "./agents.ts";
import { getProjectSubagentsDir } from "../shared/artifacts.ts";
import type { Details, JsonSchemaObject, SingleResult, SubagentState } from "../shared/types.ts";

const REFINEMENT_FORMAT_VERSION = 1;
const REFINEMENT_DIR = "refinements";
const CURRENT_FENCE = "pi-subagents-refinement-current";
const SNAPSHOTS_FENCE = "pi-subagents-refinement-snapshots-json";
const MAX_EVIDENCE_ITEMS = 8;
const MAX_AGE_DAYS = 14;
const MAX_ITEM_BYTES = 2_048;
const MAX_PACKET_BYTES = 16_384;
const PROPOSAL_AGENT = "reviewer";

type RefinementAction = "refine" | "refine.show" | "refine.rollback";
type RefinementEvidenceSource = "live-state" | "artifact-metadata" | "artifact-output";

export interface RefinementEvidenceItem {
	id: string;
	source: RefinementEvidenceSource;
	runId?: string;
	agent: string;
	at?: string;
	status?: string;
	model?: string;
	thinking?: string;
	acceptanceStatus?: string;
	reviewFindings?: string[];
	residualRisks?: string[];
	errors?: string[];
	controlSignals?: string[];
	outputTail?: string;
	refs: string[];
}

export interface RefinementProposalEdit {
	title: string;
	guidance: string;
	evidenceIds: string[];
	rationale: string;
}

export interface RefinementProposal {
	summary: string;
	edits: RefinementProposalEdit[];
	rejectedIdeas?: string[];
	residualRisks: string[];
}

interface RefinementMetadata {
	agent: string;
	revision: number;
	updatedAt: string;
	base: {
		source: AgentConfig["source"];
		filePath: string;
		systemPromptSha256: string;
	};
	evidence: {
		maxItems: number;
		maxAgeDays: number;
		itemBytes: number;
		totalBytes: number;
	};
}

interface RefinementSnapshot {
	revision: number;
	at: string;
	action: "refine" | "rollback";
	before: string;
	after: string;
	evidenceIds: string[];
	proposalAgent?: string;
}

interface ParsedRefinementFile {
	metadata: RefinementMetadata;
	current: string;
	snapshots: RefinementSnapshot[];
}

interface ExistingRefinementFile {
	path: string;
	parsed?: ParsedRefinementFile;
}

interface ProposalChildResult {
	isError?: boolean;
	content?: Array<{ type: string; text?: string }>;
	details?: {
		results?: Array<Pick<SingleResult, "structuredOutput" | "finalOutput" | "error">>;
	};
}

export type LaunchRefinementProposalChild = (
	task: string,
	outputSchema: JsonSchemaObject,
	signal: AbortSignal,
) => Promise<ProposalChildResult>;

export interface RefinementActionContext {
	cwd: string;
	state: SubagentState;
	signal: AbortSignal;
	launchProposalChild: LaunchRefinementProposalChild;
}

function result(text: string, isError = false): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [] },
	};
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function textArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(text).filter((entry): entry is string => entry !== null);
}

function isoTime(value: unknown): string | undefined {
	const numberValue = typeof value === "number" && Number.isFinite(value) ? value : undefined;
	if (numberValue !== undefined) return new Date(numberValue).toISOString();
	const stringValue = text(value);
	if (!stringValue) return undefined;
	const parsed = Date.parse(stringValue);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function hashPrompt(systemPrompt: string): string {
	return createHash("sha256").update(systemPrompt).digest("hex");
}

function safeAgentFileName(agentName: string): string {
	const trimmed = agentName.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed) || trimmed.includes("..")) {
		throw new Error(`Agent name '${agentName}' cannot be used as a refinement file name.`);
	}
	return `${trimmed}.md`;
}

export function getAgentRefinementPath(cwd: string, agentName: string): string {
	const refinementRoot = path.join(getProjectSubagentsDir(cwd), REFINEMENT_DIR);
	const resolvedRoot = path.resolve(refinementRoot);
	const resolvedPath = path.resolve(refinementRoot, safeAgentFileName(agentName));
	if (resolvedPath !== path.join(resolvedRoot, path.basename(resolvedPath))) {
		throw new Error(`Agent name '${agentName}' cannot be used as a refinement file name.`);
	}
	return resolvedPath;
}

function readExisting(cwd: string, agentName: string): ExistingRefinementFile {
	const filePath = getAgentRefinementPath(cwd, agentName);
	if (!fs.existsSync(filePath)) return { path: filePath };
	return { path: filePath, parsed: parseRefinementFile(fs.readFileSync(filePath, "utf-8"), filePath) };
}

function extractFence(markdown: string, fence: string): string | null {
	const escaped = fence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = markdown.match(new RegExp("\\n```" + escaped + "\\n([\\s\\S]*?)\\n```", "m"));
	return match?.[1] ?? null;
}

export function parseRefinementFile(markdown: string, label = "refinement file"): ParsedRefinementFile {
	const metadataMatch = markdown.match(/^<!-- pi-subagents-refinement:v1\n([\s\S]*?)\n-->\n/);
	if (!metadataMatch?.[1]) throw new Error(`${label} is missing refinement metadata.`);
	const metadataValue = JSON.parse(metadataMatch[1]) as unknown;
	const metadataRecord = record(metadataValue);
	if (!metadataRecord) throw new Error(`${label} metadata must be an object.`);
	const agent = text(metadataRecord.agent);
	const revision = metadataRecord.revision;
	const updatedAt = text(metadataRecord.updatedAt);
	const base = record(metadataRecord.base);
	const evidence = record(metadataRecord.evidence);
	if (!agent || typeof revision !== "number" || !Number.isInteger(revision) || !updatedAt || !base || !evidence) {
		throw new Error(`${label} metadata is invalid.`);
	}
	const source = text(base.source);
	const filePath = text(base.filePath);
	const systemPromptSha256 = text(base.systemPromptSha256);
	if (source !== "builtin" && source !== "package" && source !== "user" && source !== "project") throw new Error(`${label} base source is invalid.`);
	if (!filePath || !systemPromptSha256) throw new Error(`${label} base metadata is invalid.`);
	const current = extractFence(markdown, CURRENT_FENCE);
	if (current === null) throw new Error(`${label} is missing current refinement block.`);
	const snapshotsRaw = extractFence(markdown, SNAPSHOTS_FENCE) ?? "[]";
	const snapshotsValue = JSON.parse(snapshotsRaw) as unknown;
	if (!Array.isArray(snapshotsValue)) throw new Error(`${label} snapshots must be an array.`);
	const snapshots = snapshotsValue.map((entry, index): RefinementSnapshot => {
		const item = record(entry);
		if (!item) throw new Error(`${label} snapshot ${index} must be an object.`);
		const action = text(item.action);
		const before = typeof item.before === "string" ? item.before : null;
		const after = typeof item.after === "string" ? item.after : null;
		const at = text(item.at);
		if (typeof item.revision !== "number" || !Number.isInteger(item.revision) || !at || (action !== "refine" && action !== "rollback") || before === null || after === null) {
			throw new Error(`${label} snapshot ${index} is invalid.`);
		}
		return {
			revision: item.revision,
			at,
			action,
			before,
			after,
			evidenceIds: textArray(item.evidenceIds),
			...(text(item.proposalAgent) ? { proposalAgent: text(item.proposalAgent)! } : {}),
		};
	});
	return {
		metadata: {
			agent,
			revision,
			updatedAt,
			base: { source, filePath, systemPromptSha256 },
			evidence: {
				maxItems: typeof evidence.maxItems === "number" ? evidence.maxItems : MAX_EVIDENCE_ITEMS,
				maxAgeDays: typeof evidence.maxAgeDays === "number" ? evidence.maxAgeDays : MAX_AGE_DAYS,
				itemBytes: typeof evidence.itemBytes === "number" ? evidence.itemBytes : MAX_ITEM_BYTES,
				totalBytes: typeof evidence.totalBytes === "number" ? evidence.totalBytes : MAX_PACKET_BYTES,
			},
		},
		current,
		snapshots,
	};
}

function serializeRefinementFile(parsed: ParsedRefinementFile): string {
	const metadata = JSON.stringify(parsed.metadata, null, 2);
	const snapshots = JSON.stringify(parsed.snapshots, null, 2);
	return [
		`<!-- pi-subagents-refinement:v${REFINEMENT_FORMAT_VERSION}`,
		metadata,
		"-->",
		"",
		`# Current refinement for \`${parsed.metadata.agent}\``,
		"",
		`\`\`\`${CURRENT_FENCE}`,
		parsed.current,
		"```",
		"",
		"# Snapshots",
		"",
		`\`\`\`${SNAPSHOTS_FENCE}`,
		snapshots,
		"```",
		"",
	].join("\n");
}

function writeRefinementFile(filePath: string, parsed: ParsedRefinementFile): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	fs.writeFileSync(tmp, serializeRefinementFile(parsed), "utf-8");
	fs.renameSync(tmp, filePath);
}

function baseMetadata(agent: AgentConfig): RefinementMetadata["base"] {
	return {
		source: agent.source,
		filePath: agent.filePath,
		systemPromptSha256: hashPrompt(agent.systemPrompt),
	};
}

function metadataFor(agent: AgentConfig, revision: number, now: string): RefinementMetadata {
	return {
		agent: agent.name,
		revision,
		updatedAt: now,
		base: baseMetadata(agent),
		evidence: {
			maxItems: MAX_EVIDENCE_ITEMS,
			maxAgeDays: MAX_AGE_DAYS,
			itemBytes: MAX_ITEM_BYTES,
			totalBytes: MAX_PACKET_BYTES,
		},
	};
}

function withinAge(at: string | undefined, now = Date.now()): boolean {
	if (!at) return true;
	const parsed = Date.parse(at);
	return Number.isFinite(parsed) && now - parsed <= MAX_AGE_DAYS * 24 * 60 * 60 * 1_000;
}

function tailBytes(value: string, maxBytes: number): string {
	const buffer = Buffer.from(value, "utf-8");
	if (buffer.byteLength <= maxBytes) return value;
	return buffer.subarray(buffer.byteLength - maxBytes).toString("utf-8");
}

function pushCapped(items: RefinementEvidenceItem[], item: RefinementEvidenceItem): void {
	if (items.length >= MAX_EVIDENCE_ITEMS) return;
	items.push({ ...item, outputTail: item.outputTail ? tailBytes(item.outputTail, MAX_ITEM_BYTES) : undefined });
}

function acceptanceFields(value: unknown): Pick<RefinementEvidenceItem, "acceptanceStatus" | "reviewFindings" | "residualRisks"> {
	const ledger = record(value);
	if (!ledger) return {};
	const childReport = record(ledger.childReport);
	const reviewResult = record(ledger.reviewResult);
	const reviewFindings = [
		...textArray(childReport?.reviewFindings),
		...(Array.isArray(reviewResult?.findings) ? reviewResult.findings.map((finding) => text(record(finding)?.issue)).filter((entry): entry is string => entry !== null) : []),
	];
	const residualRisks = textArray(childReport?.residualRisks);
	return {
		...(text(ledger.status) ? { acceptanceStatus: text(ledger.status)! } : {}),
		...(reviewFindings.length > 0 ? { reviewFindings } : {}),
		...(residualRisks.length > 0 ? { residualRisks } : {}),
	};
}

function controlSignals(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => {
		const item = record(entry);
		if (!item) return null;
		const message = text(item.message);
		const reason = text(item.reason);
		return message ? (reason ? `${reason}: ${message}` : message) : null;
	}).filter((entry): entry is string => entry !== null);
}

function evidencePacket(items: RefinementEvidenceItem[]): RefinementEvidenceItem[] {
	const packet: RefinementEvidenceItem[] = [];
	let bytes = 2;
	for (const item of items) {
		const encoded = Buffer.byteLength(JSON.stringify(item), "utf-8") + 1;
		if (bytes + encoded > MAX_PACKET_BYTES) break;
		packet.push(item);
		bytes += encoded;
	}
	return packet;
}

export function collectBoundedRefinementEvidence(cwd: string, agentName: string, state: SubagentState): RefinementEvidenceItem[] {
	const items: RefinementEvidenceItem[] = [];
	const jobs = [...state.asyncJobs.values()]
		.filter((job) => !job.cwd || path.resolve(job.cwd) === path.resolve(cwd))
		.filter((job) => job.agents?.includes(agentName) || job.steps?.some((step) => step.agent === agentName))
		.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	for (const job of jobs) {
		const at = isoTime(job.updatedAt ?? job.startedAt);
		if (!withinAge(at)) continue;
		const matchingSteps = job.steps?.filter((step) => step.agent === agentName) ?? [];
		if (matchingSteps.length === 0) {
			pushCapped(items, {
				id: `live:${job.asyncId}`,
				source: "live-state",
				runId: job.asyncId,
				agent: agentName,
				...(at ? { at } : {}),
				status: job.status,
				refs: [job.asyncDir],
			});
			continue;
		}
		for (const [index, step] of matchingSteps.entries()) {
			const stepRecord = step as unknown as Record<string, unknown>;
			pushCapped(items, {
				id: `live:${job.asyncId}:${index}`,
				source: "live-state",
				runId: job.asyncId,
				agent: agentName,
				...(at ? { at } : {}),
				status: step.status,
				...(text(stepRecord.model) ? { model: text(stepRecord.model)! } : {}),
				...(text(stepRecord.thinking) ? { thinking: text(stepRecord.thinking)! } : {}),
				...acceptanceFields(stepRecord.acceptance),
				...(text(step.error) ? { errors: [text(step.error)!] } : {}),
				...(text(stepRecord.recentOutput) ? { outputTail: text(stepRecord.recentOutput)! } : {}),
				refs: [job.asyncDir],
			});
		}
	}

	const artifactsDir = path.join(getProjectSubagentsDir(cwd), "artifacts");
	if (fs.existsSync(artifactsDir)) {
		const files = fs.readdirSync(artifactsDir)
			.filter((file) => file.endsWith("_meta.json"))
			.map((file) => path.join(artifactsDir, file))
			.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		for (const file of files) {
			if (items.length >= MAX_EVIDENCE_ITEMS) break;
			let metadata: Record<string, unknown> | null = null;
			try { metadata = record(JSON.parse(fs.readFileSync(file, "utf-8")) as unknown); } catch { metadata = null; }
			if (!metadata || text(metadata.agent) !== agentName) continue;
			const stat = fs.statSync(file);
			const at = isoTime(metadata.timestamp ?? stat.mtimeMs);
			if (!withinAge(at)) continue;
			const outputPath = file.replace(/_meta\.json$/, "_output.md");
			const outputTail = fs.existsSync(outputPath) ? tailBytes(fs.readFileSync(outputPath, "utf-8"), MAX_ITEM_BYTES) : undefined;
			pushCapped(items, {
				id: `artifact:${path.basename(file, "_meta.json")}`,
				source: outputTail ? "artifact-output" : "artifact-metadata",
				...(text(metadata.runId) ? { runId: text(metadata.runId)! } : {}),
				agent: agentName,
				...(at ? { at } : {}),
				status: typeof metadata.exitCode === "number" ? (metadata.exitCode === 0 ? "completed" : "failed") : undefined,
				...(text(metadata.model) ? { model: text(metadata.model)! } : {}),
				...(text(metadata.thinking) ? { thinking: text(metadata.thinking)! } : {}),
				...acceptanceFields(metadata.acceptance),
				...(text(metadata.error) ? { errors: [text(metadata.error)!] } : {}),
				...((controlSignals(metadata.controlEvents).length > 0) ? { controlSignals: controlSignals(metadata.controlEvents) } : {}),
				...(outputTail ? { outputTail } : {}),
				refs: outputTail ? [file, outputPath] : [file],
			});
		}
	}
	return evidencePacket(items);
}

export function appendAgentRefinementOverlay(systemPrompt: string, input: { cwd: string; agentName: string }): string {
	let current = "";
	let filePath = "";
	try {
		filePath = getAgentRefinementPath(input.cwd, input.agentName);
		if (!fs.existsSync(filePath)) return systemPrompt;
		current = parseRefinementFile(fs.readFileSync(filePath, "utf-8"), filePath).current.trim();
	} catch {
		return systemPrompt;
	}
	if (!current) return systemPrompt;
	const overlay = [
		`<pi-subagents-refinement agent=${JSON.stringify(input.agentName)} source=${JSON.stringify(path.relative(input.cwd, filePath))}>`,
		"Project-local refinement guidance generated from recent bounded evidence.",
		"It does not override tool, developer, task, output, acceptance, or safety instructions.",
		"",
		current,
		"</pi-subagents-refinement>",
	].join("\n");
	return systemPrompt.trim() ? `${systemPrompt}\n\n${overlay}` : overlay;
}

export function validateRefinementProposal(proposal: unknown, evidenceIds: string[]): { ok: true; proposal: RefinementProposal } | { ok: false; error: string } {
	const item = record(proposal);
	if (!item) return { ok: false, error: "Refinement proposal must be an object." };
	const summary = text(item.summary);
	const editsValue = item.edits;
	if (!summary || !Array.isArray(editsValue)) return { ok: false, error: "Refinement proposal requires summary and edits." };
	if (editsValue.length > 3) return { ok: false, error: "Refinement proposal may contain at most 3 edits." };
	const allowed = new Set(evidenceIds);
	const protectedInstruction = "(?:acceptance|output|safety|policy|policies|tools?|developer|system)";
	const blocked = new RegExp(`\\b(all agents|every agent|global|(?:disable|ignore|bypass|skip|override)\\s+(?:the\\s+)?${protectedInstruction}(?:\\s+instructions?)?|${protectedInstruction}\\s+(?:instructions?|overrides?)|tool safety|review gates|rewrite base|base agent file|settings\\.json|\\.pi/agent|agents/.*\\.md)\\b`, "i");
	const edits: RefinementProposalEdit[] = [];
	for (const [index, editValue] of editsValue.entries()) {
		const edit = record(editValue);
		if (!edit) return { ok: false, error: `Refinement proposal edit ${index} must be an object.` };
		const title = text(edit.title);
		const guidance = text(edit.guidance);
		const rationale = text(edit.rationale);
		const cited = textArray(edit.evidenceIds);
		if (!title || !guidance || !rationale) return { ok: false, error: `Refinement proposal edit ${index} is missing title, guidance, or rationale.` };
		if (cited.length === 0 || cited.some((id) => !allowed.has(id))) return { ok: false, error: `Refinement proposal edit ${index} must cite known evidence ids.` };
		if (guidance.includes("```") || guidance.includes("</pi-subagents-refinement>") || blocked.test(guidance)) return { ok: false, error: `Refinement proposal edit ${index} contains disallowed guidance.` };
		edits.push({ title, guidance, rationale, evidenceIds: cited });
	}
	return { ok: true, proposal: { summary, edits, rejectedIdeas: textArray(item.rejectedIdeas), residualRisks: textArray(item.residualRisks) } };
}

function proposalSchema(): JsonSchemaObject {
	return {
		type: "object",
		additionalProperties: false,
		required: ["summary", "edits", "residualRisks"],
		properties: {
			summary: { type: "string" },
			edits: {
				type: "array",
				maxItems: 3,
				items: {
					type: "object",
					additionalProperties: false,
					required: ["title", "guidance", "evidenceIds", "rationale"],
					properties: {
						title: { type: "string" },
						guidance: { type: "string" },
						evidenceIds: { type: "array", items: { type: "string" }, minItems: 1 },
						rationale: { type: "string" },
					},
				},
			},
			rejectedIdeas: { type: "array", items: { type: "string" } },
			residualRisks: { type: "array", items: { type: "string" } },
		},
	};
}

function proposalFromChild(child: ProposalChildResult): unknown {
	for (const entry of child.details?.results ?? []) {
		if (entry.structuredOutput !== undefined) return entry.structuredOutput;
	}
	const output = child.details?.results?.map((entry) => entry.finalOutput ?? "").find((entry) => entry.trim().length > 0)
		?? child.content?.map((entry) => entry.text ?? "").find((entry) => entry.trim().length > 0)
		?? "";
	const jsonMatch = output.match(/```(?:json)?\n([\s\S]*?)\n```/) ?? output.match(/({[\s\S]*})/);
	if (!jsonMatch?.[1]) return null;
	try { return JSON.parse(jsonMatch[1]) as unknown; } catch { return null; }
}

function proposalTask(agent: AgentConfig, current: string, evidence: RefinementEvidenceItem[]): string {
	return [
		`You are a fresh read-only proposal child for project-local refinement of one subagent: ${agent.name}.`,
		"Do not read files. Do not use write, edit, or shell tools. Use only the evidence packet below.",
		"Propose at most 2-3 minimal overlay guidance edits.",
		"Each edit must cite one or more evidence ids from the packet.",
		"Do not propose base agent file, settings, global, automatic, tool, safety, output, acceptance, developer, or system instruction changes.",
		"Return only structured output that matches the schema.",
		"",
		"Agent metadata:",
		JSON.stringify({ name: agent.name, source: agent.source, filePath: agent.filePath, basePromptSha256: hashPrompt(agent.systemPrompt) }, null, 2),
		"",
		"Current overlay:",
		current.trim() || "(none)",
		"",
		"Evidence packet:",
		JSON.stringify(evidence, null, 2),
	].join("\n");
}

function guidanceFromProposal(proposal: RefinementProposal): string {
	return proposal.edits.map((edit) => `- ${edit.guidance.trim()}`).join("\n");
}

function resolveOneAgent(cwd: string, agentName: string): { ok: true; agent: AgentConfig } | { ok: false; error: string } {
	const discovered = discoverAgents(cwd, "both");
	const resolved = resolveAgentName(agentName, discovered.agents);
	if (resolved.error) return { ok: false, error: resolved.error };
	if (!resolved.agent) return { ok: false, error: formatUnknownAgentError(agentName, unknownAgentDiagnosticContext(discovered)) };
	return { ok: true, agent: resolved.agent };
}

export async function handleRefinementAction(action: RefinementAction, params: { agent?: string }, ctx: RefinementActionContext): Promise<AgentToolResult<Details>> {
	const requestedAgent = params.agent?.trim();
	if (!requestedAgent) return result(`${action} requires agent. Use /subagents-refine <agent> or subagent({ action: "${action}", agent: "<agent>" }).`, true);
	let resolved: { ok: true; agent: AgentConfig } | { ok: false; error: string };
	try { resolved = resolveOneAgent(ctx.cwd, requestedAgent); } catch (error) { return result(error instanceof Error ? error.message : String(error), true); }
	if (!resolved.ok) return result(resolved.error, true);
	const agent = resolved.agent;
	let existing: ExistingRefinementFile;
	try { existing = readExisting(ctx.cwd, agent.name); } catch (error) { return result(error instanceof Error ? error.message : String(error), true); }

	if (action === "refine.show") {
		if (!existing.parsed) return result(`No refinement overlay exists for '${agent.name}'.`);
		const currentDigest = hashPrompt(agent.systemPrompt);
		const drift = existing.parsed.metadata.base.systemPromptSha256 === currentDigest ? "no" : "yes";
		const history = existing.parsed.snapshots.slice(-5).map((snapshot) => `- r${snapshot.revision} ${snapshot.action} at ${snapshot.at} (${snapshot.evidenceIds.length} evidence id${snapshot.evidenceIds.length === 1 ? "" : "s"})`).join("\n") || "- none";
		return result([
			`Refinement overlay for '${agent.name}'`,
			`Path: ${existing.path}`,
			`Revision: ${existing.parsed.metadata.revision}`,
			`Updated: ${existing.parsed.metadata.updatedAt}`,
			`Base: ${existing.parsed.metadata.base.source} ${existing.parsed.metadata.base.filePath}`,
			`Base prompt changed since overlay: ${drift}`,
			"",
			"Current guidance:",
			existing.parsed.current.trim() || "(empty)",
			"",
			"Recent history:",
			history,
		].join("\n"));
	}

	if (action === "refine.rollback") {
		if (!existing.parsed) return result(`No refinement overlay exists for '${agent.name}'.`, true);
		const latest = existing.parsed.snapshots.at(-1);
		if (!latest) return result(`No refinement snapshot exists for '${agent.name}'.`, true);
		const now = new Date().toISOString();
		const nextRevision = existing.parsed.metadata.revision + 1;
		const next: ParsedRefinementFile = {
			metadata: metadataFor(agent, nextRevision, now),
			current: latest.before,
			snapshots: [...existing.parsed.snapshots, { revision: nextRevision, at: now, action: "rollback", before: existing.parsed.current, after: latest.before, evidenceIds: latest.evidenceIds }],
		};
		try { writeRefinementFile(existing.path, next); } catch (error) { return result(error instanceof Error ? error.message : String(error), true); }
		return result(`Rolled back refinement overlay for '${agent.name}' to revision ${nextRevision}.\nPath: ${existing.path}`);
	}

	const evidence = collectBoundedRefinementEvidence(ctx.cwd, agent.name, ctx.state);
	if (evidence.length === 0) return result(`No bounded recent evidence was found for '${agent.name}'. No proposal child was launched and no overlay was written.`);
	const current = existing.parsed?.current ?? "";
	const child = await ctx.launchProposalChild(proposalTask(agent, current, evidence), proposalSchema(), ctx.signal);
	if (child.isError) return result(`Refinement proposal child failed. No overlay was written.`, true);
	const validation = validateRefinementProposal(proposalFromChild(child), evidence.map((item) => item.id));
	if (!validation.ok) return result(`${validation.error} No overlay was written.`, true);
	if (validation.proposal.edits.length === 0) return result(`The proposal child returned no edits for '${agent.name}'. No overlay was written.`);
	const now = new Date().toISOString();
	const nextRevision = (existing.parsed?.metadata.revision ?? 0) + 1;
	const after = guidanceFromProposal(validation.proposal);
	const snapshot: RefinementSnapshot = {
		revision: nextRevision,
		at: now,
		action: "refine",
		before: current,
		after,
		evidenceIds: [...new Set(validation.proposal.edits.flatMap((edit) => edit.evidenceIds))],
		proposalAgent: PROPOSAL_AGENT,
	};
	const next: ParsedRefinementFile = {
		metadata: metadataFor(agent, nextRevision, now),
		current: after,
		snapshots: [...(existing.parsed?.snapshots ?? []), snapshot],
	};
	try { writeRefinementFile(existing.path, next); } catch (error) { return result(error instanceof Error ? error.message : String(error), true); }
	return result([
		`Wrote refinement overlay for '${agent.name}' at revision ${nextRevision}.`,
		`Path: ${existing.path}`,
		`Evidence items: ${evidence.length}`,
		`Edits: ${validation.proposal.edits.length}`,
	].join("\n"));
}
