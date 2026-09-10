import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExternalProcessStatus, HerdrMachineReference, HerdrRemoteGitStatus } from "../../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../../shared/utils.ts";
import { CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS, type CodeOwnedExternalCliAdapterId } from "./external-cli-contract.ts";
import { type ExternalCliBinaryAvailability, type ExternalCliPreflightResult, type ExternalCliPreflightSpec, resolveExternalCliBinaryAvailability } from "./external-cli-preflight.ts";
import type { ExternalCliParser, ExternalCliParserProgress, runExternalCli } from "./external-cli-runner.ts";

/**
 * Herdr saved-machine placement for external CLI children.
 *
 * Herdr owns which machines exist and how ssh reaches them (`herdr machine list --json`).
 * pi-subagents owns what runs there: the adapter launch is wrapped as a local `ssh -T <target>`
 * child so prompt delivery, stream parsing, stop, and exit proof stay exactly as they are locally.
 * `cwd` means the directory on that machine; the remote `cd` is the directory check.
 */

const MAX_MACHINE_NAME_LENGTH = 128;
const HERDR_MACHINE_LIST_TIMEOUT_MS = 7_500;
const MAX_HERDR_MACHINE_LIST_BYTES = 1024 * 1024;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const SUPPORTED_MACHINE_ADAPTERS = new Set<string>(CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS);
/** The local ssh process gets only what ssh itself needs; remote runs use the machine's own credentials. */
export const HERDR_SSH_ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK"] as const;
/** Non-interactive ssh shells skip rc files, so common install locations are prepended explicitly. */
const REMOTE_PATH_PREFIX = '"$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"';
/** One random token per runner process; every marker line derives from it so rc-file noise cannot forge one. */
const RUN_TOKEN = randomBytes(8).toString("hex");
const READY_MARKER = `__pi_subagents_ready_${RUN_TOKEN}__`;
const FINAL_BEGIN_MARKER = `__pi_subagents_final_begin_${RUN_TOKEN}__`;
const FINAL_END_MARKER = `__pi_subagents_final_end_${RUN_TOKEN}__`;
const GIT_MARKER = `__pi_subagents_git_${RUN_TOKEN}__`;

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

/** Shell expression for a remote path; `~` is expanded through `$HOME` since single quotes suppress tilde expansion. */
function remotePathExpr(cwd: string): string {
	if (cwd === "~") return '"$HOME"';
	if (cwd.startsWith("~/")) return `"$HOME"${shellQuote(cwd.slice(1))}`;
	return shellQuote(cwd);
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
			...(selected.session ? { session: selected.session } : {}),
			cwd: validateRemoteCwd(cwd, requested),
		},
		...(settings?.env ? { env: settings.env } : {}),
	};
}

/** Availability for a placed agent: ssh resolves locally and the machine is saved and enabled. The agent CLI lives on the machine. */
export function resolveHerdrMachineAvailability(machine: string, env: NodeJS.ProcessEnv): ExternalCliBinaryAvailability {
	const ssh = resolveExternalCliBinaryAvailability("ssh", env);
	if (!ssh.available) return ssh;
	try {
		const catalog = readHerdrMachineCatalog(env, env.HERDR_BIN ?? "herdr");
		selectMachine(catalog, validateMachineName(machine));
		return { available: true };
	} catch (error) {
		return { available: false, unavailableReason: (error instanceof Error ? error.message : String(error)).slice(0, 256) };
	}
}

export function formatHerdrMachineRunnerUnsupported(input: {
	machine?: string;
	agentName: string;
	runnerType?: string;
	adapter?: string;
	worktree?: boolean;
}): string | undefined {
	if (input.machine === undefined) return undefined;
	if (input.runnerType !== "external-cli") {
		return `Agent '${input.agentName}' requested machine '${input.machine}', but only external-cli agents can run on a Herdr saved machine. Use claude-code, codex-exec, or cursor-agent profiles, or open a Herdr pane on that machine and run Pi there.`;
	}
	if (input.adapter === undefined || !SUPPORTED_MACHINE_ADAPTERS.has(input.adapter)) {
		return `Agent '${input.agentName}' requested machine '${input.machine}', but generic external-cli commands cannot be remote-wrapped safely. Use claude-code, claude-code-writer, codex-exec, codex-exec-writer, cursor-agent, or cursor-agent-writer.`;
	}
	if (input.worktree === true) return `Agent '${input.agentName}' requested machine '${input.machine}', but managed worktrees are local git operations and cannot be combined with a Herdr saved machine.`;
	if (process.platform === "win32") return "Herdr saved-machine launches wrap the child with OpenSSH ControlMaster and a POSIX shell script, which is not supported from a Windows host yet.";
	return undefined;
}

export function isHerdrMachineWriterAdapter(adapter: string | undefined): boolean {
	return adapter !== undefined && adapter.endsWith("-writer");
}

/** One ControlMaster socket per machine, shared by every run on this host. ControlPersist expires it; nothing closes it. */
function sshControlPath(): string {
	const dir = path.join(getAgentDir(), "ssh-control");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return path.join(dir, "%C");
}

/** Herdr's saved-machine ssh option block (src/remote/attach.rs), plus pi-subagents' own ControlMaster entries. */
function sshArgs(machine: HerdrMachineReference, controlPath: string): string[] {
	return [
		"-T",
		"-o", "BatchMode=yes",
		"-o", "NumberOfPasswordPrompts=0",
		"-o", "StrictHostKeyChecking=yes",
		"-o", "ConnectTimeout=10",
		"-o", "ConnectionAttempts=1",
		"-o", "ServerAliveInterval=15",
		"-o", "ServerAliveCountMax=4",
		"-o", "ControlMaster=auto",
		"-o", "ControlPersist=60",
		"-o", `ControlPath=${controlPath}`,
		machine.target,
	];
}

/**
 * The remote login shell receives one argument, `sh -c '<script>'`, so fish or a noisy rc file cannot change
 * how the script is parsed. The script prints the ready marker only after `cd` succeeded.
 */
function remoteCommand(machine: HerdrMachineReference, env: Record<string, string> | undefined, body: string): string {
	const exports = Object.entries(env ?? {}).map(([key, value]) => `export ${key}=${shellQuote(value)}`);
	const script = [
		`export PATH=${REMOTE_PATH_PREFIX}`,
		...exports,
		`cd ${remotePathExpr(machine.cwd)} || exit 125`,
		`printf '%s\\n' ${shellQuote(READY_MARKER)}`,
		body,
	].join("; ");
	return `sh -c ${shellQuote(script)}`;
}

function adapterIdFromPreflight(spec: ExternalCliPreflightSpec | undefined): string | undefined {
	return spec?.id.split("@")[0];
}

function stripThroughMarker(text: string): string {
	const index = text.indexOf(READY_MARKER);
	return index < 0 ? text : text.slice(index + READY_MARKER.length).trim();
}

function remotePreflight(input: RunExternalCliInput, machine: HerdrMachineReference, env: Record<string, string> | undefined, controlPath: string): ExternalCliPreflightSpec | undefined {
	const spec = input.preflight;
	if (!spec) return undefined;
	const probe = (args: readonly string[]) => [...sshArgs(machine, controlPath), remoteCommand(machine, env, `exec ${shellQuote(input.command)} ${args.map(shellQuote).join(" ")}`)];
	const { probeTimeoutMs: _probeTimeoutMs, ...rest } = spec;
	return {
		...rest,
		id: `${spec.id}@${machine.id}`,
		versionArgs: probe(spec.versionArgs),
		helpArgs: probe(spec.helpArgs),
		...(spec.evidenceArgs ? { evidenceArgs: probe(spec.evidenceArgs) } : {}),
		remote: true,
		validate(result: ExternalCliPreflightResult) {
			if (!result.version.includes(READY_MARKER)) {
				throw new Error(`Remote probe on ${machine.label ?? machine.id} did not reach a POSIX shell in ${machine.cwd}. ${formatHerdrMachineHint(machine, result.version) ?? "External-cli runs support POSIX ssh targets only."}`);
			}
			spec.validate?.({ ...result, version: stripThroughMarker(result.version), help: stripThroughMarker(result.help), ...(result.evidence !== undefined ? { evidence: stripThroughMarker(result.evidence) } : {}) });
		},
	};
}

function parseRemoteGit(line: string): HerdrRemoteGitStatus | undefined {
	if (!line.startsWith(GIT_MARKER)) return undefined;
	try {
		const parsed = JSON.parse(line.slice(GIT_MARKER.length)) as Record<string, unknown>;
		return {
			...(typeof parsed.head === "string" && parsed.head ? { head: parsed.head } : {}),
			...(typeof parsed.branch === "string" && parsed.branch ? { branch: parsed.branch } : {}),
			...(typeof parsed.dirty === "boolean" ? { dirty: parsed.dirty } : {}),
		};
	} catch {
		return undefined;
	}
}

/** Discards stream lines until the ready marker, lifts the Codex final message out of the stream, and records remote git state. */
function wrapParser(parser: ExternalCliParser | undefined, finalOutputPath: string | undefined): { parser: ExternalCliParser; remoteGit: () => HerdrRemoteGitStatus | undefined } {
	let ready = false;
	let capturingFinal = false;
	let finalOutput = "";
	let remoteGit: HerdrRemoteGitStatus | undefined;
	const parseLine = (value: string): ExternalCliParserProgress | undefined => {
		if (!ready) {
			if (value === READY_MARKER) ready = true;
			return undefined;
		}
		if (value === FINAL_BEGIN_MARKER) {
			capturingFinal = true;
			return undefined;
		}
		if (value === FINAL_END_MARKER) {
			capturingFinal = false;
			// An absent remote artifact stays absent locally so the adapter's own "did not write" failure applies.
			if (finalOutputPath && finalOutput.trim()) {
				fs.mkdirSync(path.dirname(finalOutputPath), { recursive: true });
				fs.writeFileSync(finalOutputPath, finalOutput.replace(/\n$/u, ""));
			}
			return undefined;
		}
		if (capturingFinal) {
			finalOutput += `${value}\n`;
			return undefined;
		}
		const git = parseRemoteGit(value);
		if (git) {
			remoteGit = git;
			return undefined;
		}
		return parser?.parseLine(value);
	};
	const finish = () => {
		if (!ready) throw new Error("Remote command never reached the project directory; see stderr for the ssh or shell error.");
		return parser?.finish();
	};
	return {
		parser: { parseLine, finish, ...(parser?.skipOversizedLine ? { skipOversizedLine: (prefix, byteLength) => ready && !capturingFinal ? parser.skipOversizedLine!(prefix, byteLength) : undefined } : {}) },
		remoteGit: () => remoteGit,
	};
}

/** Quote one adapter argument for the remote shell, substituting local artifact paths with remote shell variables. */
function remoteArg(arg: string, substitutions: ReadonlyArray<readonly [local: string, expr: string]>): string {
	for (const [local, expr] of substitutions) {
		if (arg.includes(local)) return arg.split(local).map(shellQuote).join(expr);
	}
	return shellQuote(arg);
}

export function prepareHerdrMachineExternalCliRun(input: RunExternalCliInput, placement: HerdrMachinePlacement | undefined, options: { localCwd: string }): PreparedHerdrMachineExternalCliRun {
	if (!placement) return { input, decorateProcess: (process) => process };
	const { machine, env } = placement;
	const adapter = adapterIdFromPreflight(input.preflight);
	const codex = adapter === "codex-exec" || adapter === "codex-exec-writer";
	const cursor = adapter === "cursor-agent" || adapter === "cursor-agent-writer";
	const captureFinalOutput = codex && input.finalOutputPath !== undefined;
	const promptFilePath = cursor ? input.promptFilePath : undefined;
	const promptDirectory = promptFilePath ? path.dirname(promptFilePath) : undefined;
	const substitutions: Array<readonly [string, string]> = [];
	if (captureFinalOutput) substitutions.push([input.finalOutputPath!, '"$pi_final"']);
	if (promptFilePath) substitutions.push([promptFilePath, '"$pi_prompt"']);
	let args = [...(input.args ?? [])];
	if (promptDirectory) {
		// The local `--add-dir <prompt dir>` pair names a laptop path; the remote prompt directory is added instead.
		args = args.filter((arg, index, all) => !((arg === "--add-dir" && all[index + 1] === promptDirectory) || (arg === promptDirectory && all[index - 1] === "--add-dir")));
		args.splice(Math.max(args.length - 1, 0), 0, "--add-dir", "$pi_prompt_dir");
	}
	const words = args.map((arg) => arg === "$pi_prompt_dir" ? '"$pi_prompt_dir"' : remoteArg(arg, substitutions));
	const body = [
		...(captureFinalOutput ? ['pi_final=$(mktemp "${TMPDIR:-/tmp}/pi-subagents-final.XXXXXX") || exit 126'] : []),
		...(promptFilePath ? ['pi_prompt_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-subagents-prompt.XXXXXX") || exit 126', 'pi_prompt="$pi_prompt_dir/handoff.txt"', 'cat >"$pi_prompt"'] : []),
		`${shellQuote(input.command)} ${words.join(" ")}`,
		"pi_status=$?",
		...(captureFinalOutput ? [`printf '%s\\n' ${shellQuote(FINAL_BEGIN_MARKER)}`, 'cat "$pi_final"', `printf '\\n%s\\n' ${shellQuote(FINAL_END_MARKER)}`, 'rm -f "$pi_final"'] : []),
		...(promptFilePath ? ['rm -rf "$pi_prompt_dir"'] : []),
		`if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf '%s{"head":"%s","branch":"%s","dirty":%s}\\n' ${shellQuote(GIT_MARKER)} "$(git rev-parse --short HEAD 2>/dev/null)" "$(git symbolic-ref --quiet --short HEAD 2>/dev/null)" "$([ -n "$(git status --porcelain 2>/dev/null)" ] && echo true || echo false)"; fi`,
		"exit $pi_status",
	].join("; ");
	const controlPath = sshControlPath();
	const wrapped = wrapParser(input.parser, captureFinalOutput ? input.finalOutputPath : undefined);
	const decorateProcess = (process: ExternalProcessStatus): ExternalProcessStatus => ({
		...process,
		machine: { ...machine, ...(wrapped.remoteGit() ? { remoteGit: wrapped.remoteGit() } : {}) },
	});
	const onProcess = input.onProcess;
	const preflight = remotePreflight(input, machine, env, controlPath);
	const { promptFilePath: _promptFilePath, temporaryDirectories: _temporaryDirectories, ...rest } = input;
	const prepared: RunExternalCliInput = {
		...rest,
		command: "ssh",
		args: [...sshArgs(machine, controlPath), remoteCommand(machine, env, body)],
		cwd: options.localCwd,
		environment: { allowlist: HERDR_SSH_ENV_ALLOWLIST },
		parser: wrapped.parser,
		...(preflight ? { preflight } : {}),
		...(onProcess ? { onProcess: (process: ExternalProcessStatus) => onProcess(decorateProcess(process)) } : {}),
		// Cursor keeps its prompt-file contract locally; remotely the prompt travels over stdin into a remote mktemp file.
		...(cursor ? {} : input.promptFilePath ? { promptFilePath: input.promptFilePath, temporaryDirectories: input.temporaryDirectories } : {}),
	};
	return { input: prepared, decorateProcess };
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

export function formatHerdrMachineWriterNote(machine: HerdrMachineReference): string {
	return `Changes made by this run live on ${machine.label ?? machine.id} at ${machine.cwd}; the local checkout is unchanged.`;
}
