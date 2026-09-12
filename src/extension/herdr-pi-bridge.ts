import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import packageJson from "../../package.json" with { type: "json" };
import { encodeHerdrPiFrame, HERDR_PI_MAX_FRAME_BYTES, HERDR_PI_PROTOCOL, HERDR_PI_RUN_ENV, HERDR_PI_RUNTIME_DIR_ENV, HerdrPiFrameDecoder, validateHerdrPiRunId, type HerdrPiFrame } from "../runs/shared/herdr-pi-protocol.ts";
import { discoverAgents } from "../agents/agents.ts";
import { buildSkillInjection, resolveSkills } from "../agents/skills.ts";
import { buildAgentMemoryInjection } from "../agents/agent-memory.ts";
import { appendAgentRefinementOverlay } from "../agents/agent-refinements.ts";
import { rewriteSubagentPrompt } from "../runs/shared/subagent-prompt-runtime.ts";
import { resolveExistingReadPaths } from "../shared/settings.ts";

interface PendingRequest { operation: "prompt" | "steer" | "follow-up" | "abort" | "supervisor-reply"; text?: string; supervisorId?: string }
interface BridgeContext {
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	getActiveTools?(): string[];
	sessionManager?: { getSessionId?(): string; getSessionFile?(): string | undefined };
	model?: { provider?: string; id?: string };
}

function gitEvidence(cwd: string): Record<string, unknown> | undefined {
	const run = (args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5_000, maxBuffer: 128 * 1024 });
	const inside = run(["rev-parse", "--is-inside-work-tree"]);
	if (inside.status !== 0) return undefined;
	const head = run(["rev-parse", "HEAD"]); const branch = run(["symbolic-ref", "--quiet", "--short", "HEAD"]); const dirty = run(["status", "--porcelain"]);
	return { ...(head.status === 0 ? { head: head.stdout.trim() } : {}), ...(branch.status === 0 ? { branch: branch.stdout.trim() } : {}), dirty: Boolean(dirty.stdout.trim()) };
}

export function resolveRemoteHerdrResources(cwd: string, resources: { agent: string; skills?: string[]; toolCeiling?: string[]; reads?: string[] | false }, remoteDefaultTools: string[] = []): { agent: string; skills: string[]; tools: string[]; systemPrompt: string; inheritProjectContext: boolean; inheritGlobalContext: boolean; inheritSkills: boolean } {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(resources.agent) || resources.skills?.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) || resources.toolCeiling?.some((name) => !/^[A-Za-z0-9_-]{1,64}$/u.test(name)) || (resources.reads !== undefined && resources.reads !== false && (!Array.isArray(resources.reads) || resources.reads.some((name) => typeof name !== "string")))) throw new Error("Remote logical resource names are invalid.");
	const discovered = discoverAgents(cwd, "both").agents.filter((agent) => agent.name === resources.agent || agent.aliases?.includes(resources.agent));
	if (discovered.length !== 1) throw new Error(`Remote agent '${resources.agent}' was not found unambiguously in ${cwd}.`);
	const agent = discovered[0]!; const names = resources.skills ?? agent.skills ?? [];
	const skills = resolveSkills(names, cwd); if (skills.missing.length) throw new Error(`Remote Pi skills not found: ${skills.missing.join(", ")}. Configure them on the saved machine.`);
	const skillPrompt = buildSkillInjection(skills.resolved);
	const reads = resources.reads === undefined ? agent.defaultReads ?? false : resources.reads; const readPaths = Array.isArray(reads) ? resolveExistingReadPaths(reads, cwd) : [];
	const systemPrompt = appendAgentRefinementOverlay(`${agent.systemPrompt}${buildAgentMemoryInjection(agent, cwd)}${skillPrompt ? `\n\n${skillPrompt}` : ""}${readPaths.length ? `\n\n[Read from: ${readPaths.join(", ")}]` : ""}`, { cwd, agentName: agent.name });
	const denied = new Set(agent.excludeTools ?? []); const tools = (agent.tools === undefined ? remoteDefaultTools : agent.tools).filter((tool) => !denied.has(tool) && (!resources.toolCeiling || resources.toolCeiling.includes(tool))); if (agent.tools === undefined && !tools.length) throw new Error(`Remote agent '${agent.name}' resolved no default active tools within the inherited ceiling.`);
	return { agent: agent.name, skills: names, tools, systemPrompt, inheritProjectContext: agent.inheritProjectContext, inheritGlobalContext: agent.inheritGlobalContext, inheritSkills: agent.inheritSkills };
}

export default function registerHerdrPiBridge(pi: ExtensionAPI): void {
	const runId = validateHerdrPiRunId(process.env[HERDR_PI_RUN_ENV]);
	const runDir = process.env[HERDR_PI_RUNTIME_DIR_ENV];
	if (!runDir || !path.isAbsolute(runDir) || fs.lstatSync(runDir).isSymbolicLink()) throw new Error("Herdr bridge runtime directory was not authoritatively provisioned.");
	fs.chmodSync(runDir, 0o700);
	const socketPath = path.join(runDir, "bridge.sock");
	const manifestPath = path.join(runDir, "manifest.json");
	for (const candidate of [socketPath, manifestPath]) {
		try { const stat = fs.lstatSync(candidate); if (stat.isSymbolicLink()) throw new Error(`Refusing symlink at '${candidate}'.`); fs.rmSync(candidate, { force: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	let client: net.Socket | undefined;
	let context: BridgeContext | undefined;
	let nativeSessionId: string | undefined;
	let finalAssistant: AgentMessage | undefined;
	let activeRequestId: string | undefined;
	let resolvedSystemPrompt: string | undefined;
	let resolvedContextPolicy: { agent: string; inheritProjectContext: boolean; inheritGlobalContext: boolean; inheritSkills: boolean } | undefined;
	let configured = false;
	const pending = new Map<string, PendingRequest>();
	const supervisor = new Map<string, { reason: "need_decision" | "interview_request" | "progress_update"; resolve(answer: string): void }>();
	let evidenceCursor = 0; let journalBytes = 0; const journal: HerdrPiFrame[] = [];
	const send = (frame: { type: string; [key: string]: unknown }) => {
		const record = { protocol: HERDR_PI_PROTOCOL, runId, ...frame, cursor: ++evidenceCursor } as HerdrPiFrame; const size = Buffer.byteLength(JSON.stringify(record)); journal.push(record); journalBytes += size; while (journal.length > 512 || journalBytes > 8 * 1024 * 1024) { const removed = journal.shift(); if (removed) journalBytes -= Buffer.byteLength(JSON.stringify(removed)); }
		if (!client || client.destroyed) return;
		client.write(encodeHerdrPiFrame(record));
	};
	const sessionId = (ctx: BridgeContext) => ctx.sessionManager?.getSessionId?.();
	const activeTools = (ctx: BridgeContext) => ctx.getActiveTools?.() ?? [];

	pi.registerTool({
		name: "contact_supervisor",
		label: "Contact supervisor",
		description: "Contact the parent/supervisor session for a blocking decision, structured interview, or progress update.",
		parameters: Type.Object({ reason: Type.Union([Type.Literal("need_decision"), Type.Literal("interview_request"), Type.Literal("progress_update")]), message: Type.Optional(Type.String({ maxLength: 65_536 })), interview: Type.Optional(Type.Unknown()) }, { additionalProperties: false }),
		execute: async (_toolCallId, input: { reason: "need_decision" | "interview_request" | "progress_update"; message?: string; interview?: unknown }) => {
			if (input.reason !== "interview_request" && !input.message?.trim()) throw new Error("message is required for supervisor decisions and progress updates.");
			const id = `sup_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
			send({ type: "supervisor-request", requestId: id, reason: input.reason, message: input.message?.slice(0, 65_536) ?? "", ...(input.interview !== undefined ? { interview: input.interview } : {}), expectsReply: input.reason !== "progress_update", nativeSessionId });
			if (input.reason === "progress_update") { await new Promise<string>((resolve) => supervisor.set(id, { reason: input.reason, resolve })); return { content: [{ type: "text", text: "Supervisor progress update queued." }], details: { delivered: true, requestId: id, reason: input.reason } }; }
			const reason = input.reason as "need_decision" | "interview_request"; const answer = await new Promise<string>((resolve) => supervisor.set(id, { reason, resolve })); const details: Record<string, unknown> = { requestId: id, reason }; if (reason === "interview_request") try { details.structuredReply = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/giu, "")); } catch { details.structuredReplyParseError = "Supervisor interview reply was not valid JSON."; }
			return { content: [{ type: "text", text: `**Reply from supervisor:**\n${answer}` }], details };
		},
	});

	const execute = async (requestId: string, ctx: BridgeContext) => {
		const request = pending.get(requestId);
		if (!request) throw new Error(`Unknown or already consumed bridge request '${requestId}'.`);
		pending.delete(requestId);
		if (sessionId(ctx) !== nativeSessionId) throw new Error("Native Pi session identity changed.");
		send({ type: "accepted", requestId, operation: request.operation, nativeSessionId });
		const api = pi as unknown as { sendUserMessage(text: string, options?: { deliverAs?: "steer" | "followUp" }): void; abort(): void };
		if (request.operation === "prompt") { activeRequestId = requestId; finalAssistant = undefined; api.sendUserMessage(request.text ?? ""); }
		else if (request.operation === "steer") api.sendUserMessage(request.text ?? "", { deliverAs: "steer" });
		else if (request.operation === "follow-up") api.sendUserMessage(request.text ?? "", { deliverAs: "followUp" });
		else if (request.operation === "abort") api.abort();
		else {
			const entry = request.supervisorId ? supervisor.get(request.supervisorId) : undefined;
			if (!entry) throw new Error("Unknown supervisor request.");
			supervisor.delete(request.supervisorId!); entry.resolve(request.text ?? "");
		}
		send({ type: "control-ack", requestId, operation: request.operation, nativeSessionId });
	};
	pi.registerCommand("pi-subagents-bridge", { description: "Internal pane-native request dispatch", handler: (args, ctx) => execute(args.trim(), ctx as unknown as BridgeContext) });

	const on = pi.on as unknown as (name: string, handler: (event: Record<string, unknown>, ctx: BridgeContext) => unknown) => void;
	on("before_agent_start", (event) => resolvedSystemPrompt && resolvedContextPolicy ? { systemPrompt: `${rewriteSubagentPrompt(typeof event.systemPrompt === "string" ? event.systemPrompt : "", { inheritProjectContext: resolvedContextPolicy.inheritProjectContext, inheritGlobalContext: resolvedContextPolicy.inheritGlobalContext, inheritSkills: resolvedContextPolicy.inheritSkills })}\n\n<active_agent name=${JSON.stringify(resolvedContextPolicy.agent)}/>\n\n${resolvedSystemPrompt}` } : undefined);
	on("session_start", (_event, ctx) => {
		context = ctx; nativeSessionId = sessionId(ctx);
		if (!nativeSessionId) throw new Error("Pane-native Pi bridge requires a persisted native session identity.");
		fs.writeFileSync(manifestPath, JSON.stringify({ protocol: HERDR_PI_PROTOCOL, packageVersion: packageJson.version, runId, socketPath, nativeSessionId, pid: process.pid }), { mode: 0o600, flag: "wx" });
		send({ type: "ready", packageVersion: packageJson.version, nativeSessionId, sessionFile: ctx.sessionManager?.getSessionFile?.(), cwd: process.cwd(), tools: activeTools(ctx), model: ctx.model?.provider && ctx.model.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined, configured, activeRequestId, evidenceCursor, evidenceFloor: journal[0]?.cursor ?? evidenceCursor + 1, initialGit: gitEvidence(process.cwd()) });
	});
	on("message_end", (event) => {
		const message = event.message as AgentMessage | undefined;
		if (message?.role === "assistant") finalAssistant = message;
		send({ type: "event", requestId: activeRequestId, event: { ...event, message }, nativeSessionId });
	});
	on("agent_settled", (_event, ctx) => { const requestId = activeRequestId; send({ type: "settled", requestId, nativeSessionId, idle: ctx.isIdle(), pending: ctx.hasPendingMessages(), finalAssistant, finalGit: gitEvidence(process.cwd()) }); if (ctx.isIdle() && !ctx.hasPendingMessages()) activeRequestId = undefined; });
	on("session_shutdown", () => { server.close(); client?.destroy(); try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {} });

	const server = net.createServer((socket) => {
		if (client && !client.destroyed) { socket.destroy(); return; }
		client = socket; const decoder = new HerdrPiFrameDecoder(); let total = 0;
		for (const record of journal) socket.write(encodeHerdrPiFrame(record));
		socket.on("data", (chunk: Buffer) => {
			total += chunk.byteLength; if (total > HERDR_PI_MAX_FRAME_BYTES * 32) { socket.destroy(new Error("Bridge byte budget exceeded.")); return; }
			try {
				for (const frame of decoder.push(chunk)) {
					if (frame.runId !== runId) throw new Error("Bridge run identity mismatch.");
					if (frame.type === "supervisor-delivered" && typeof frame.requestId === "string") { const entry = supervisor.get(frame.requestId); if (!entry || entry.reason !== "progress_update") throw new Error("Unknown supervisor delivery acknowledgement."); supervisor.delete(frame.requestId); entry.resolve("delivered"); continue; }
					if (frame.type === "configure") {
						if (configured || typeof frame.requestId !== "string" || !frame.resources || typeof frame.resources !== "object") throw new Error("Invalid or duplicate bridge configuration.");
						const resources = frame.resources as { agent?: unknown; skills?: unknown; toolCeiling?: unknown; reads?: unknown };
						const invalidSkills = resources.skills !== undefined && (!Array.isArray(resources.skills) || resources.skills.some((name) => typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)));
						const invalidReads = resources.reads !== undefined && resources.reads !== false && (!Array.isArray(resources.reads) || resources.reads.some((name) => typeof name !== "string"));
						if (typeof resources.agent !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(resources.agent) || invalidSkills || invalidReads) throw new Error("Remote logical resource names are invalid.");
						const resolved = resolveRemoteHerdrResources(process.cwd(), { agent: resources.agent, ...(resources.skills ? { skills: resources.skills as string[] } : {}), ...(resources.toolCeiling ? { toolCeiling: resources.toolCeiling as string[] } : {}), ...(resources.reads !== undefined ? { reads: resources.reads as string[] | false } : {}) }, context ? activeTools(context) : []); resolvedSystemPrompt = resolved.systemPrompt; resolvedContextPolicy = resolved;
						(pi as unknown as { setActiveTools?(tools: string[]): void }).setActiveTools?.(resolved.tools); const acknowledged = context ? activeTools(context) : []; if (acknowledged.some((tool) => !resolved.tools.includes(tool)) || resolved.tools.some((tool) => !acknowledged.includes(tool))) throw new Error("Remote Pi did not apply the resolved active-tool set exactly.");
						configured = true; send({ type: "configured", requestId: frame.requestId, nativeSessionId, agent: resolved.agent, skills: resolved.skills, model: context?.model?.provider && context.model.id ? `${context.model.provider}/${context.model.id}` : undefined, tools: acknowledged }); continue;
					}
					if (frame.type !== "prepare" || typeof frame.requestId !== "string" || pending.has(frame.requestId) || !configured) throw new Error("Invalid, duplicate, or unconfigured bridge request.");
					const operation = frame.operation;
					if (!(["prompt", "steer", "follow-up", "abort", "supervisor-reply"] as unknown[]).includes(operation)) throw new Error("Unsupported bridge operation.");
					const text = frame.text; if (text !== undefined && (typeof text !== "string" || Buffer.byteLength(text) > 256 * 1024)) throw new Error("Bridge request text is invalid or too large.");
					pending.set(frame.requestId, { operation: operation as PendingRequest["operation"], ...(text !== undefined ? { text } : {}), ...(typeof frame.supervisorId === "string" ? { supervisorId: frame.supervisorId } : {}) });
					send({ type: "prepared", requestId: frame.requestId, nativeSessionId });
				}
			} catch (error) { socket.destroy(error as Error); }
		});
		socket.on("close", () => { if (client === socket) client = undefined; });
		if (context && nativeSessionId) send({ type: "ready", packageVersion: packageJson.version, nativeSessionId, sessionFile: context.sessionManager?.getSessionFile?.(), cwd: process.cwd(), tools: activeTools(context), model: context.model?.provider && context.model.id ? `${context.model.provider}/${context.model.id}` : undefined, configured, activeRequestId, evidenceCursor, evidenceFloor: journal[0]?.cursor ?? evidenceCursor + 1, initialGit: gitEvidence(process.cwd()) });
	});
	server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); });
}
