import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExternalProcessStatus, HerdrMachineReference } from "../../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../../shared/utils.ts";
import { CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS, type CodeOwnedExternalCliAdapterId } from "./external-cli-contract.ts";
import type { runExternalCli } from "./external-cli-runner.ts";

/**
 * Herdr saved-machine placement for external CLI children.
 *
 * Herdr owns which machines exist and how ssh reaches them (`herdr machine list --json`).
 * pi-subagents owns what runs there: native Pi and the six code-owned external profiles are
 * launched in fresh Herdr-owned visible panes. SSH is bounded transport and never owns the agent.
 * `cwd` means the directory on that machine; the remote `cd` is the directory check.
 */

const MAX_MACHINE_NAME_LENGTH = 128;
const HERDR_MACHINE_LIST_TIMEOUT_MS = 7_500;
const MAX_HERDR_MACHINE_LIST_BYTES = 1024 * 1024;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const SUPPORTED_MACHINE_ADAPTERS = new Set<string>(CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS);
/** The local ssh process gets only what ssh itself needs; remote runs use the machine's own credentials. */
export const HERDR_SSH_ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK"] as const;

type RunExternalCliInput = Parameters<typeof runExternalCli>[0];

interface HerdrMachineCatalogEntry {
	id: string;
	label?: string;
	target: string;
	session?: string;
	enabled: boolean;
}

interface MachineSettingsEntry {
	cwd?: string;
	env?: Record<string, string>;
}

export interface ResolveHerdrMachinePlacementInput {
	/** Profile id or label as typed by the operator. */
	machine: string;
	/** Local directory whose project settings hold `subagents.machines`. */
	cwd: string;
	/** Launch cwd: absolute or `~` paths are remote paths as given; relative paths join the configured machine root. */
	stepCwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Test seam: catalog JSON instead of spawning `herdr machine list --json`. */
	catalogJson?: string;
	/** Test seam: settings entry instead of reading settings files. */
	settings?: MachineSettingsEntry;
	herdrBin?: string;
}

export interface HerdrMachinePlacement {
	machine: HerdrMachineReference;
	/** Opt-in `subagents.machines.<name>.env`, exported in front of the remote command. */
	env?: Record<string, string>;
}

export interface PreparedHerdrMachineExternalCliRun {
	input: RunExternalCliInput;
	decorateProcess(process: ExternalProcessStatus): ExternalProcessStatus;
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function validateMachineName(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error("Herdr machine id or label is required.");
	if (trimmed.length > MAX_MACHINE_NAME_LENGTH) throw new Error(`Herdr machine '${trimmed.slice(0, 24)}…' exceeds ${MAX_MACHINE_NAME_LENGTH} characters.`);
	if (CONTROL_CHARS.test(trimmed)) throw new Error("Herdr machine id or label contains control characters.");
	return trimmed;
}

function validateTarget(value: string, requested: string): string {
	const target = value.trim();
	if (!target || target.startsWith("-") || /[\s\u0000-\u001f\u007f]/u.test(target)) {
		throw new Error(`Herdr machine '${requested}' has an ssh target that cannot be passed safely: ${JSON.stringify(target)}.`);
	}
	return target;
}

function isRemoteAbsolute(value: string): boolean {
	return value.startsWith("/") || value === "~" || value.startsWith("~/");
}

function validateRemoteCwd(value: string, requested: string): string {
	const cwd = value.trim();
	if (!isRemoteAbsolute(cwd)) throw new Error(`Herdr machine '${requested}' cwd must be an absolute POSIX path or start with '~': ${JSON.stringify(cwd)}.`);
	if (CONTROL_CHARS.test(cwd)) throw new Error(`Herdr machine '${requested}' cwd contains control characters.`);
	return cwd.length > 1 ? cwd.replace(/\/+$/u, "") : cwd;
}

function parseMachineCatalog(json: string): HerdrMachineCatalogEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json) as unknown;
	} catch (error) {
		throw new Error(`Failed to parse herdr machine list --json: ${error instanceof Error ? error.message : String(error)}`);
	}
	const entries = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).machines) ? (parsed as Record<string, unknown[]>).machines : undefined);
	if (!entries) throw new Error("herdr machine list --json returned no machine list.");
	return entries.flatMap((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
		const record = entry as Record<string, unknown>;
		if (typeof record.id !== "string" || !record.id.trim() || typeof record.target !== "string") return [];
		return [{
			id: record.id.trim(),
			...(typeof record.label === "string" && record.label.trim() ? { label: record.label.trim() } : {}),
			target: record.target,
			...(typeof record.session === "string" && record.session.trim() ? { session: record.session.trim() } : {}),
			enabled: record.enabled !== false,
		}];
	});
}

function readHerdrMachineCatalog(env: NodeJS.ProcessEnv, herdrBin: string): HerdrMachineCatalogEntry[] {
	const result = spawnSync(herdrBin, ["machine", "list", "--json"], {
		env,
		encoding: "utf-8",
		maxBuffer: MAX_HERDR_MACHINE_LIST_BYTES,
		timeout: HERDR_MACHINE_LIST_TIMEOUT_MS,
		windowsHide: true,
	});
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new Error(`Herdr CLI '${herdrBin}' was not found on PATH. Saved-machine placement needs Herdr installed locally.`);
		throw new Error(`Failed to run herdr machine list --json: ${result.error.message}`);
	}
	if (result.status !== 0) throw new Error(`herdr machine list --json exited with code ${result.status}: ${(result.stderr || result.stdout).trim()}`);
	return parseMachineCatalog(result.stdout);
}

/** Mirrors Herdr's own selector rules: profile id first, then a unique case-sensitive label; disabled fails closed. */
function selectMachine(catalog: HerdrMachineCatalogEntry[], requested: string): HerdrMachineCatalogEntry {
	const byId = catalog.find((entry) => entry.id === requested);
	const matches = byId ? [byId] : catalog.filter((entry) => entry.label === requested);
	if (matches.length > 1) throw new Error(`Machine label '${requested}' is ambiguous; use its profile ID.`);
	const machine = matches[0];
	if (!machine) {
		const saved = catalog.filter((entry) => entry.enabled).map((entry) => entry.label ?? entry.id);
		throw new Error(`Herdr machine '${requested}' was not found. Saved machines: ${saved.length ? saved.join(", ") : "none"}. Add one with herdr machine add <target> --label <name>.`);
	}
	if (!machine.enabled) throw new Error(`Machine '${requested}' is disabled. Run herdr machine enable ${machine.id}.`);
	return machine;
}

function readJsonObject(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
	} catch (error) {
		throw new Error(`Failed to read settings file '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
	}
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function machineSettingsFrom(settings: Record<string, unknown>, keys: readonly string[], filePath: string): MachineSettingsEntry | undefined {
	const subagents = settings.subagents;
	if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return undefined;
	const machines = (subagents as Record<string, unknown>).machines;
	if (machines === undefined) return undefined;
	if (!machines || typeof machines !== "object" || Array.isArray(machines)) throw new Error(`Subagent settings in '${filePath}' have invalid 'machines'; expected an object keyed by machine label or id.`);
	const key = keys.find((candidate) => candidate in (machines as Record<string, unknown>));
	if (key === undefined) return undefined;
	const value = (machines as Record<string, unknown>)[key];
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Subagent settings in '${filePath}' have invalid 'machines.${key}'; expected an object with 'cwd' and optional 'env'.`);
	const record = value as Record<string, unknown>;
	const entry: MachineSettingsEntry = {};
	if (record.cwd !== undefined) {
		if (typeof record.cwd !== "string" || !record.cwd.trim()) throw new Error(`Subagent settings in '${filePath}' have invalid 'machines.${key}.cwd'; expected a non-empty string.`);
		entry.cwd = validateRemoteCwd(record.cwd, key);
	}
	if (record.env !== undefined) {
		if (!record.env || typeof record.env !== "object" || Array.isArray(record.env) || Object.entries(record.env).some(([name, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || typeof item !== "string")) {
			throw new Error(`Subagent settings in '${filePath}' have invalid 'machines.${key}.env'; expected an object of string values keyed by variable name.`);
		}
		entry.env = { ...(record.env as Record<string, string>) };
		if (Object.keys(entry.env).length > 0) {
			throw new Error(`Subagent settings in '${filePath}' set 'machines.${key}.env'. Saved-machine runs use the remote Herdr/Pi environment; configure credentials and environment on '${key}' and remove the local env map.`);
		}
	}
	return entry;
}

/** Project settings beat user settings, field by field; the entry may be keyed by label, id, or the typed selector. */
function readMachineSettings(cwd: string, keys: readonly string[]): MachineSettingsEntry | undefined {
	const userPath = path.join(getAgentDir(), "settings.json");
	const projectPath = path.join(getProjectConfigDir(findProjectRootForSettings(cwd)), "settings.json");
	const user = machineSettingsFrom(readJsonObject(userPath), keys, userPath);
	const project = projectPath === userPath ? undefined : machineSettingsFrom(readJsonObject(projectPath), keys, projectPath);
	if (!user && !project) return undefined;
	return { ...user, ...project };
}

function findProjectRootForSettings(cwd: string): string {
	let current = path.resolve(cwd);
	while (true) {
		if (fs.existsSync(path.join(getProjectConfigDir(current), "settings.json"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(cwd);
		current = parent;
	}
}

export function resolveHerdrMachinePlacement(input: ResolveHerdrMachinePlacementInput): HerdrMachinePlacement {
	const requested = validateMachineName(input.machine);
	const catalog = input.catalogJson !== undefined
		? parseMachineCatalog(input.catalogJson)
		: readHerdrMachineCatalog(input.env ?? process.env, input.herdrBin ?? process.env.HERDR_BIN ?? "herdr");
	const selected = selectMachine(catalog, requested);
	const name = selected.label ?? selected.id;
	const keys = [...new Set([requested, ...(selected.label ? [selected.label] : []), selected.id])];
	const settings = input.settings ?? readMachineSettings(input.cwd, keys);
	if (settings?.env && Object.keys(settings.env).length > 0) {
		throw new Error(`Saved-machine environment for '${name}' must be configured remotely. Remove machines.${name}.env and configure the remote Herdr/Pi session instead.`);
	}
	const stepCwd = input.stepCwd?.trim();
	let cwd: string;
	if (stepCwd && isRemoteAbsolute(stepCwd)) cwd = stepCwd;
	else if (settings?.cwd) cwd = stepCwd ? path.posix.join(settings.cwd, stepCwd) : settings.cwd;
	else throw new Error(`No root for ${name} in this repo. Set subagents.machines.${name}.cwd in .pi/settings.json or pass an absolute cwd on that machine.`);
	return {
		machine: {
			provider: "herdr",
			id: selected.id,
			...(selected.label ? { label: selected.label } : {}),
			target: validateTarget(selected.target, requested),
			...(selected.session && selected.session !== "default" ? { session: selected.session } : {}),
			cwd: validateRemoteCwd(cwd, requested),
		},
		...(settings?.env ? { env: settings.env } : {}),
	};
}

export function formatHerdrMachineRunnerUnsupported(input: {
	machine?: string;
	agentName: string;
	runnerType?: string;
	adapter?: string;
	worktree?: boolean;
}): string | undefined {
	if (input.machine === undefined) return undefined;
	if (input.runnerType !== undefined && input.runnerType !== "pi" && input.runnerType !== "external-cli") {
		return `Agent '${input.agentName}' requested machine '${input.machine}', but this runner cannot use pane-native Herdr placement. Use native Pi or a built-in Claude, Codex, or Cursor profile.`;
	}
	if (input.runnerType === "external-cli" && (input.adapter === undefined || !SUPPORTED_MACHINE_ADAPTERS.has(input.adapter))) {
		return `Agent '${input.agentName}' requested machine '${input.machine}', but generic external-cli commands cannot be remote-wrapped safely. Use claude-code, claude-code-writer, codex-exec, codex-exec-writer, cursor-agent, or cursor-agent-writer.`;
	}
	if (input.worktree === true) return `Agent '${input.agentName}' requested machine '${input.machine}', but managed worktrees are local git operations and cannot be combined with a Herdr saved machine.`;
	if (process.platform === "win32") return "Herdr saved-machine pane transport requires hardened OpenSSH StreamLocal forwarding, which is not supported from a Windows host yet.";
	return undefined;
}

/** Legacy local-child SSH wrapping is intentionally unavailable after the pane-native cut-over. */
export function prepareHerdrMachineExternalCliRun(input: RunExternalCliInput, placement: HerdrMachinePlacement | undefined, _options: { localCwd: string }): PreparedHerdrMachineExternalCliRun {
	if (placement) throw new Error("Saved-machine external profiles must run in a Herdr-owned pane.");
	return { input, decorateProcess: (process) => process };
}
const HINTS: ReadonlyArray<readonly [RegExp, (machine: HerdrMachineReference) => string]> = [
	[/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Permission denied \(publickey|Permission denied, please try again|No such identity|Could not resolve hostname|Connection (timed out|refused)/iu,
		(machine) => `ssh could not reach or authenticate with ${machine.target}. Connect once interactively with ssh ${machine.target} to accept the host key or fix the identity; BatchMode never prompts.`],
	[/is not recognized as|CommandNotFoundException|PowerShell|At line:\d+ char:\d+/u,
		(machine) => `Machine '${machine.label ?? machine.id}' is not a POSIX host. External-cli runs support POSIX ssh targets only.`],
	[/\bcd: .*(No such file or directory|not a directory|can't cd)|exit(?:ed with)? code 125\b/iu,
		(machine) => `Nothing at ${machine.cwd} on ${machine.label ?? machine.id}. Clone the repo there first; pi-subagents never clones, pulls, or checks out on a machine.`],
	[/(?:command not found|not found)\s*$|No such file or directory\s*$|exit(?:ed with)? code 127\b/imu,
		(machine) => `The agent CLI was not found on ${machine.label ?? machine.id}. Non-interactive shells skip rc files and the PATH prefix did not find it; set the agent's command to the absolute path on that machine.`],
	[/not logged in|unauthorized|authentication_error|invalid api key|please run .*login|OAuth token/iu,
		(machine) => `Remote runs use the machine's own credentials. Log in to the agent CLI on ${machine.label ?? machine.id} once.`],
];

/** One-line operator hint for a predictable remote failure, matched against error text and the stderr tail. */
export function formatHerdrMachineHint(machine: HerdrMachineReference, text: string): string | undefined {
	for (const [pattern, hint] of HINTS) if (pattern.test(text)) return hint(machine);
	return undefined;
}
