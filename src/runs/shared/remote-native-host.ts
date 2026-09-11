import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import packageJson from "../../../package.json" with { type: "json" };
import { createCapturedChildHooks } from "./child-hooks.ts";
import { createDefaultChildSessionFactory, type ChildSession, type ChildSessionFactory, type ChildSessionLaunch } from "./child-session.ts";
import { NATIVE_REMOTE_RPC_PROTOCOL_VERSION, NativeRemoteJsonlDecoder, encodeNativeRemoteRpcRecord } from "./native-remote-rpc.ts";
import type { ChildRuntimeConfig } from "./child-runtime-config.ts";
import { buildSkillInjection, resolveSkills } from "../../agents/skills.ts";
import { buildEffectiveSystemPrompt } from "./effective-system-prompt.ts";

interface RemoteLaunchRecord {
	type: "launch";
	protocol: number;
	packageVersion: string;
	launch: Omit<ChildSessionLaunch, "hooks" | "onExtensionError" | "processEnv" | "requiredExtensions"> & { runtime: ChildRuntimeConfig; remoteSupervision?: boolean };
}

function send(value: unknown): void {
	process.stdout.write(encodeNativeRemoteRpcRecord(value));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function collectRemoteGitEvidence(cwd: string): Record<string, unknown> {
	const evidence: Record<string, unknown> = {};
	try { evidence.head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim(); } catch (error) { evidence.probeError = errorMessage(error); }
	try { const branch = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim(); if (branch) evidence.branch = branch; } catch { /* detached HEAD is valid */ }
	try { evidence.dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim()); } catch (error) { evidence.probeError ??= errorMessage(error); }
	return evidence;
}

function requireLaunch(value: unknown): RemoteLaunchRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a native launch record.");
	const record = value as Partial<RemoteLaunchRecord>;
	if (record.type !== "launch" || record.protocol !== NATIVE_REMOTE_RPC_PROTOCOL_VERSION || record.packageVersion !== packageJson.version || !record.launch) {
		throw new Error(`Incompatible native launch (local=${String(record.packageVersion)}, remote=${packageJson.version}, protocol=${String(record.protocol)}).`);
	}
	if (record.launch.storage.kind === "file" || record.launch.storage.kind === "dir") throw new Error("Remote native Pi does not accept local session storage paths; use a fresh remote session.");
	if (record.launch.extensionPaths.length > 0) throw new Error("Remote native Pi cannot transfer extension paths. Configure required extensions on the saved machine.");
	return record as RemoteLaunchRecord;
}

export function resolveRemoteNativeSkillLaunch<T extends Pick<ChildSessionLaunch, "cwd" | "skillNames" | "systemPrompt" | "appendSystemPrompt">>(launch: T): T {
	if (!launch.skillNames?.length) return launch;
	const skills = resolveSkills(launch.skillNames, launch.cwd);
	if (skills.missing.length) throw new Error(`Remote native Pi skills not found: ${skills.missing.join(", ")}.`);
	const injection = buildSkillInjection(skills.resolved);
	if (!injection) return launch;
	if (launch.systemPrompt !== undefined) return { ...launch, systemPrompt: `${launch.systemPrompt}\n\n${injection}` };
	return { ...launch, appendSystemPrompt: launch.appendSystemPrompt ? `${launch.appendSystemPrompt}\n\n${injection}` : injection };
}

export function resolveRemoteNativePromptLaunch(launch: ChildSessionLaunch): ChildSessionLaunch {
	const spec = launch.remotePromptSpec;
	if (!spec) return resolveRemoteNativeSkillLaunch(launch);
	const skills = resolveSkills(spec.skillNames ?? [], launch.cwd);
	if (skills.missing.length) throw new Error(`Remote native Pi skills not found: ${skills.missing.join(", ")}.`);
	const systemPrompt = buildEffectiveSystemPrompt({
		agent: {
			name: spec.agentName, description: "Remote native Pi child", source: "runtime", filePath: "<remote-native>", systemPrompt: spec.baseSystemPrompt,
			systemPromptMode: spec.mode, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
			...(spec.memory ? { memory: { scope: spec.memory.scope, path: spec.memory.path }, tools: spec.memory.writable ? undefined : [] } : {}),
		},
		resolvedSkills: skills.resolved,
		cwd: launch.cwd,
	});
	return { ...launch, skillNames: undefined, remotePromptSpec: undefined, systemPrompt: spec.mode === "replace" ? systemPrompt : undefined, appendSystemPrompt: spec.mode === "append" ? systemPrompt : undefined };
}

export async function teardownRemoteNativeChild(child: ChildSession | undefined, factory: Pick<ChildSessionFactory, "dispose">, timeoutMs = 1_000): Promise<void> {
	const bounded = async (operation: Promise<unknown>) => { await Promise.race([operation.catch(() => {}), new Promise<void>((resolve) => { setTimeout(resolve, timeoutMs); })]); };
	if (child) {
		await bounded(child.abort());
		await bounded(child.dispose());
	}
	await bounded(factory.dispose());
}

export async function runRemoteNativeHost(options: { piVersion: string; input?: AsyncIterable<Uint8Array>; factory?: ChildSessionFactory; sendRecord?: (value: unknown) => void; teardownTimeoutMs?: number }): Promise<void> {
	const input = options.input ?? process.stdin;
	const sendRecord = options.sendRecord ?? send;
	const piVersion = options.piVersion;
	if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(piVersion)) throw new Error(`Remote native Pi host received an invalid Pi SDK version '${piVersion}'.`);
	const records = async function* () {
		const decoder = new NativeRemoteJsonlDecoder();
		for await (const chunk of input) for (const value of decoder.push(chunk)) yield value;
		decoder.end();
	};
	const iterator = records()[Symbol.asyncIterator]();
	const first = await iterator.next();
	if (first.done) throw new Error("Input ended before launch.");
	const record = requireLaunch(first.value);
	const supervisorRoot = record.launch.remoteSupervision
		? fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-supervisor-")) : undefined;
	if (supervisorRoot) {
		fs.mkdirSync(path.join(supervisorRoot, "requests"), { recursive: true });
		fs.mkdirSync(path.join(supervisorRoot, "replies"), { recursive: true });
	}
	const runtime: ChildRuntimeConfig = { ...record.launch.runtime, ...(supervisorRoot ? { supervisorChannelDir: supervisorRoot } : {}) };
	const captured = createCapturedChildHooks(runtime, true);
	let observedTools: string[] = [];
	const toolObserver = { name: "pi-subagents-remote-tool-observer", factory: (pi: Parameters<ChildSessionLaunch["hooks"][number]["factory"]>[0]) => {
		pi.on("session_start", () => { observedTools = pi.getAllTools().map((tool) => tool.name); });
	} };
	const factory = options.factory ?? createDefaultChildSessionFactory();
	let child: ChildSession | undefined;
	let requestTimer: NodeJS.Timeout | undefined;
	let disposing = false;
	const seenRequests = new Set<string>();
	try {
		const remoteLaunch = resolveRemoteNativePromptLaunch({ ...record.launch, runtime, hooks: [...captured.hooks, toolObserver] });
		child = await factory.create(remoteLaunch);
		child.subscribe((event) => sendRecord({ type: "event", event }));
		if (supervisorRoot) {
			requestTimer = setInterval(() => {
				for (const name of fs.readdirSync(path.join(supervisorRoot, "requests"))) {
					if (seenRequests.has(name) || !name.endsWith(".json")) continue;
					seenRequests.add(name);
					try { sendRecord({ type: "supervisor-request", name, value: JSON.parse(fs.readFileSync(path.join(supervisorRoot, "requests", name), "utf8")) }); } catch { /* writer may still be replacing */ }
				}
			}, 25);
			requestTimer.unref?.();
		}
		const supervisionReady = Boolean(supervisorRoot && runtime.runId && runtime.agent && runtime.orchestratorSessionId && runtime.childIndex !== undefined);
		const initialGit = collectRemoteGitEvidence(record.launch.cwd);
		sendRecord({ type: "pi-subagents-ready", protocol: NATIVE_REMOTE_RPC_PROTOCOL_VERSION, packageVersion: packageJson.version, piVersion, capabilities: ["settlement", "steer", "follow-up", "abort", ...(supervisionReady ? ["supervision"] : [])], cwd: record.launch.cwd, model: child.modelId, tools: observedTools, initialGit });
		const active = new Set<Promise<void>>();
		const handle = async (command: Record<string, unknown>): Promise<void> => {
			const id = typeof command.id === "string" ? command.id : undefined;
			try {
				let data: unknown;
				if (command.type === "prompt") { await child!.prompt(String(command.message ?? "")); data = { finalGit: collectRemoteGitEvidence(record.launch.cwd), toolDiagnostic: captured.toolDiagnostic(), runtimeAcknowledgedExtensions: captured.runtimeAcknowledgedExtensions() }; }
				else if (command.type === "steer") await child!.steer(String(command.message ?? ""));
				else if (command.type === "follow_up") await child!.followUp(String(command.message ?? ""));
				else if (command.type === "abort") await child!.abort();
				else if (command.type === "dispose") { await child!.abort().catch(() => {}); await child!.dispose(); disposing = true; data = { finalGit: collectRemoteGitEvidence(record.launch.cwd) }; }
				else if (command.type === "supervisor-reply" && supervisorRoot && typeof command.name === "string") fs.writeFileSync(path.join(supervisorRoot, "replies", path.basename(command.name)), JSON.stringify(command.value), { mode: 0o600 });
				else throw new Error(`Unsupported native control '${String(command.type)}'.`);
				sendRecord({ type: "response", id, command: command.type, success: true, ...(data !== undefined ? { data } : {}) });
			} catch (error) { sendRecord({ type: "response", id, command: command.type, success: false, error: errorMessage(error), ...(command.type === "prompt" ? { data: { finalGit: collectRemoteGitEvidence(record.launch.cwd), toolDiagnostic: captured.toolDiagnostic(), runtimeAcknowledgedExtensions: captured.runtimeAcknowledgedExtensions() } } : {}) }); }
		};
		for await (const value of { [Symbol.asyncIterator]: () => iterator }) {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Control record must be an object.");
			const command = value as Record<string, unknown>;
			const pending = handle(command).finally(() => active.delete(pending));
			active.add(pending);
			if (command.type === "dispose") { await pending; break; }
		}
	} finally {
		if (requestTimer) clearInterval(requestTimer);
		await teardownRemoteNativeChild(disposing ? undefined : child, factory, options.teardownTimeoutMs);
		if (supervisorRoot) fs.rmSync(supervisorRoot, { recursive: true, force: true });
	}
}
