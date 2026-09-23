import * as fs from "node:fs";
import * as path from "node:path";
import * as piAi from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../shared/utils.ts";
import { PI_CODING_AGENT_PACKAGE, resolveInstalledPiPackageRoot, resolveRunningPiPackageRoot, type PiSpawnDeps } from "../runs/shared/pi-spawn.ts";

interface ActivationDetails {
	enabled?: string[];
	missing?: string[];
	unavailable?: string[];
}

const LOADER_NAME = "subagents_enable";
const SUBAGENT_NAME = "subagent";
const MINIMUM_DYNAMIC_TOOLS_VERSION = [0, 86, 1] as const;
const UNSUPPORTED_HOST_MESSAGE = "Dynamic tool activation requires Pi 0.86.1 or newer";
let warnedUnsupportedHost = false;

/** Returns why dynamic tool activation is unavailable, or undefined when the host supports it. */
export function unsupportedDynamicToolsReason(pi: ExtensionAPI, deps: PiSpawnDeps = {}): string | undefined {
	if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function" || typeof piAi.getCurrentTools !== "function") return UNSUPPORTED_HOST_MESSAGE;
	const probe = probeHostPiVersion(deps);
	if ("reason" in probe) return probe.reason;
	return supportsMinimumVersion(probe.version) ? undefined : `${UNSUPPORTED_HOST_MESSAGE} (detected ${probe.version} in ${probe.root})`;
}

type HostPiProbe = { version: string; root: string } | { reason: string };

/**
 * The host SDK is not a dependency of this package, so a bare module
 * resolution only works where it happens to be installed next to us (a
 * repository checkout with devDependencies). Distributed installs read the
 * version from the Pi that owns the session instead: argv ownership, Pi's
 * package directory, the explicit subagents override, then validated compiled
 * image layouts. A
 * selected root must expose a valid manifest — failures are reported rather
 * than silently falling through to a different Pi installation.
 */
function probeHostPiVersion(deps: PiSpawnDeps): HostPiProbe {
	const runningRoot = resolveRunningPiPackageRoot(deps);
	// Only the running host and an explicit override identify the Pi that owns this
	// session. An SDK reached through our own install tree cannot be proven to be
	// that installation, so it may inform the reason but never the gate: dynamic
	// activation stays off until the host is verified.
	if (runningRoot && "reason" in runningRoot) return runningRoot;
	if (runningRoot) return readHostPiManifest(runningRoot.root, runningRoot.source === "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT", deps.readFileSync, deps.platform);
	const installedRoot = resolveInstalledPiPackageRoot();
	return { reason: installedRoot
		? `Could not verify the running Pi installation; ${installedRoot} is not confirmed to be the host that owns this session`
		: "Could not locate the running Pi installation to verify dynamic tool support" };
}

function readHostPiManifest(
	root: string,
	fromOverride: boolean,
	readFileSync: (filePath: string, encoding: "utf-8") => string = (filePath, encoding) => fs.readFileSync(filePath, encoding),
	platform: NodeJS.Platform = process.platform,
): HostPiProbe {
	const manifestPath = (platform === "win32" ? path.win32 : path.posix).join(root, "package.json");
	let source: string;
	try {
		source = readFileSync(manifestPath, "utf-8");
	} catch (error) {
		return { reason: `Could not read the Pi package manifest at ${manifestPath}: ${errorMessage(error)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		return { reason: `Invalid Pi package manifest at ${manifestPath}: ${errorMessage(error)}` };
	}
	if (!isRecord(parsed) || parsed.name !== PI_CODING_AGENT_PACKAGE) {
		return { reason: `${manifestPath} is not ${PI_CODING_AGENT_PACKAGE}${fromOverride ? ` (${PI_CODING_AGENT_PACKAGE_ROOT_ENV} override)` : ""}` };
	}
	return typeof parsed.version === "string" && parsed.version
		? { version: parsed.version, root }
		: { reason: `The Pi package manifest at ${manifestPath} has no version` };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsMinimumVersion(version: string): boolean {
	const parsed = version.split(".").slice(0, 3).map(Number);
	if (parsed.length !== 3 || parsed.some((part) => !Number.isInteger(part) || part < 0)) return false;
	for (let index = 0; index < 3; index++) {
		const part = parsed[index]!;
		const minimum = MINIMUM_DYNAMIC_TOOLS_VERSION[index]!;
		if (part !== minimum) return part > minimum;
	}
	return true;
}

function hasNativeToolSelection(messages: Parameters<typeof piAi.getCurrentTools>[0]): boolean {
	return messages.some((message) => !!message && typeof message === "object"
		&& (Object.hasOwn(message, "toolsAdded") || Object.hasOwn(message, "toolsRemoved")));
}

function setSelection(pi: ExtensionAPI, includeSubagent: boolean): void {
	const active = pi.getActiveTools();
	const next = includeSubagent ? [...active, SUBAGENT_NAME] : active.filter((name) => name !== SUBAGENT_NAME);
	if (!next.includes(LOADER_NAME)) next.push(LOADER_NAME);
	pi.setActiveTools([...new Set(next)]);
}

function applyRecordedSelection(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const available = pi.getAllTools();
	if (!Array.isArray(available) || !Array.isArray(pi.getActiveTools())) return;
	if (!available.some((tool) => tool.name === LOADER_NAME)) return;
	// SAFETY: The running Pi session manager exposes buildSessionContext, but its read-only extension type omits it.
	const messages = (ctx.sessionManager as typeof ctx.sessionManager & { buildSessionContext(): { messages: Parameters<typeof piAi.getCurrentTools>[0] } }).buildSessionContext().messages;
	if (hasNativeToolSelection(messages)) {
		setSelection(pi, piAi.getCurrentTools(messages).some((tool) => tool.name === SUBAGENT_NAME));
		return;
	}
	setSelection(pi, messages.length > 0 && pi.getActiveTools().includes(SUBAGENT_NAME));
}

export function registerSubagentToolActivation(
	pi: ExtensionAPI,
	options: { advertisedPrompt: () => string | undefined },
): void {
	const unsupportedReason = unsupportedDynamicToolsReason(pi);
	if (unsupportedReason) {
		if (!warnedUnsupportedHost) {
			warnedUnsupportedHost = true;
			console.warn(`[pi-subagents] ${unsupportedReason}; keeping subagent eagerly available.`);
		}
		return;
	}

	const parameters = Type.Object({}, { additionalProperties: false });
	const loader: ToolDefinition<typeof parameters, ActivationDetails> = {
		name: LOADER_NAME,
		label: "Enable Subagents",
		description: "Enable pi-subagents delegation and management tools without launching work. Call when delegation is authorized by the current request or applicable user/project instructions, or when managing existing runs. Direct execution is the default; complexity alone never authorizes delegation. Full tools are available on the next model request.",
		promptSnippet: "pi-subagents is installed. For authorized specialist, independent-review, or parallel work, call subagents_enable, then subagent. Authorization must come from the current request or applicable instructions; complexity alone is not authorization.",
		parameters,
		async execute() {
			if (!pi.getAllTools().some((tool) => tool.name === SUBAGENT_NAME)) return {
				isError: true,
				content: [{ type: "text", text: "Cannot enable unavailable tools: subagent." }],
				details: { unavailable: [SUBAGENT_NAME] },
			};
			try {
				setSelection(pi, true);
			} catch (error) {
				return {
					isError: true,
					content: [{ type: "text", text: `Activation failed: ${error instanceof Error ? error.message : String(error)}` }],
					details: { missing: [SUBAGENT_NAME] },
				};
			}
			if (!pi.getActiveTools().includes(SUBAGENT_NAME)) return {
				isError: true,
				content: [{ type: "text", text: "Activation failed: subagent." }],
				details: { missing: [SUBAGENT_NAME] },
			};
			const advertised = options.advertisedPrompt();
			return {
				content: [{ type: "text", text: `Enabled: subagent. On the next model request, call subagent({action:\"list\",capabilities:true}) for current capabilities.${advertised ? `\n\n${advertised}` : ""}` }],
				details: { enabled: [SUBAGENT_NAME] },
			};
		},
	};
	pi.registerTool(loader);

	pi.on("session_start", (_event, ctx) => applyRecordedSelection(pi, ctx));
	pi.on("session_tree", (_event, ctx) => applyRecordedSelection(pi, ctx));
	pi.on("before_agent_start", (event) => {
		const available = pi.getAllTools();
		if (!Array.isArray(available) || !available.some((tool) => tool.name === LOADER_NAME)) return;
		const selectedTools = event.systemPromptOptions.selectedTools ??= [...pi.getActiveTools()];
		if (!selectedTools.includes(LOADER_NAME)) selectedTools.push(LOADER_NAME);
		if (!pi.getActiveTools().includes(LOADER_NAME)) pi.setActiveTools([...pi.getActiveTools(), LOADER_NAME]);
	});
}
