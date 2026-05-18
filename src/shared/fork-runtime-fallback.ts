import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

export type ForkSource = "intercom" | "return_on" | "subagents";
export type ForkHandlerKind = "intercom" | "return-on" | "subagent";
export interface ForkHandlerIdentity { kind: ForkHandlerKind; runId?: string; statusTag: string; sessionName: string }

const SOURCE_STATE_DIR: Record<ForkSource, string> = { intercom: "pi-intercom", return_on: "pi-return-on", subagents: "pi-subagents" };
const SOURCE_ENV: Record<ForkSource, { flag: string; runId: string }> = {
  intercom: { flag: "PI_INTERCOM_FORK_HANDLER", runId: "PI_INTERCOM_FORK_HANDLER_RUN_ID" },
  return_on: { flag: "PI_RETURN_ON_HANDLER", runId: "PI_RETURN_ON_HANDLER_RUN_ID" },
  subagents: { flag: "PI_SUBAGENT_BACKGROUND_HANDLER", runId: "PI_SUBAGENT_BACKGROUND_HANDLER_RUN_ID" },
};

function shortForkRunId(runId: string | undefined): string {
  const cleaned = runId?.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ?? "";
  const withoutPrefix = cleaned.replace(/^(?:icfh|roh|sbf)-?/i, "");
  const parts = withoutPrefix.split("-").filter(Boolean);
  const compact = parts.length >= 2 ? parts.slice(0, 2).join("-") : withoutPrefix;
  return (compact || "handler").slice(0, 24);
}

export function forkHandlerKind(source: ForkSource): ForkHandlerKind {
  if (source === "return_on") return "return-on";
  if (source === "subagents") return "subagent";
  return "intercom";
}

export function buildForkIntercomIdentity(source: ForkSource, runId?: string): ForkHandlerIdentity {
  const kind = forkHandlerKind(source);
  return { kind, ...(runId ? { runId } : {}), statusTag: runId ? `fork-handler:${kind}:${runId}` : `fork-handler:${kind}`, sessionName: `fork-${kind}-${shortForkRunId(runId)}` };
}

export function getForkHandlerIdentity(env: NodeJS.ProcessEnv = process.env): ForkHandlerIdentity | undefined {
  for (const source of ["intercom", "return_on", "subagents"] as const) {
    const keys = SOURCE_ENV[source];
    if (env[keys.flag] !== "1") continue;
    return buildForkIntercomIdentity(source, env[keys.runId]?.trim() || undefined);
  }
  return undefined;
}

export function buildForkHandlerEnv(source: ForkSource, runId: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const keys = SOURCE_ENV[source];
  return { ...extra, [keys.flag]: "1", [keys.runId]: runId };
}

export function getForkStateDir(source: ForkSource, homeDir = os.homedir()): string {
  return path.join(homeDir, ".local", "state", SOURCE_STATE_DIR[source]);
}
export function getForkHandlersDir(source: ForkSource, homeDir = os.homedir()): string {
  return path.join(getForkStateDir(source, homeDir), "handlers");
}
export function getForkHandlersFile(source: ForkSource, homeDir = os.homedir()): string {
  return path.join(getForkStateDir(source, homeDir), "handlers.json");
}
export function buildForkRunPaths(source: ForkSource, id: string, homeDir = os.homedir()) {
  const dir = path.join(getForkHandlersDir(source, homeDir), id);
  return { id, dir, eventPath: path.join(dir, "event.json"), promptPath: path.join(dir, "prompt.md"), stdoutPath: path.join(dir, "stdout.log"), stderrPath: path.join(dir, "stderr.log"), sessionDir: path.join(dir, "sessions") };
}
export function buildPiForkArgs(options: { sessionDir: string; systemPrompt: string; promptPath: string; forkFile?: string }): string[] {
  const args = ["-p", "--session-dir", options.sessionDir, "--append-system-prompt", options.systemPrompt];
  if (options.forkFile) args.push("--fork", options.forkFile);
  args.push(`@${options.promptPath}`);
  return args;
}
export async function readOptionalText(filePath: string): Promise<string> {
  try { return await fsp.readFile(filePath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
export function truncateText(value: string, limitBytes: number): string {
  const buf = Buffer.from(value);
  return buf.length <= limitBytes ? value : `${buf.subarray(0, limitBytes).toString("utf8")}\n[truncated ${buf.length - limitBytes} bytes]`;
}
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, filePath);
}
function closeFdBestEffort(fd: number | undefined): void { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
export async function launchDetachedFork(options: { command: string; args: string[]; cwd: string; stdoutPath: string; stderrPath: string; env?: NodeJS.ProcessEnv; onClose?: (code: number | null, signal: NodeJS.Signals | null) => void }) {
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  try {
    stdoutFd = fs.openSync(options.stdoutPath, "a");
    stderrFd = fs.openSync(options.stderrPath, "a");
    const child = spawn(options.command, options.args, { cwd: options.cwd, detached: true, env: options.env ?? process.env, stdio: ["ignore", stdoutFd, stderrFd] });
    closeFdBestEffort(stdoutFd); closeFdBestEffort(stderrFd); stdoutFd = undefined; stderrFd = undefined;
    child.unref();
    let launchError: unknown;
    const spawned = await new Promise<boolean>((resolve) => {
      const onSpawn = () => { child.off("error", onError); resolve(true); };
      const onError = (error: Error) => { launchError = error; child.off("spawn", onSpawn); resolve(false); };
      child.once("spawn", onSpawn); child.once("error", onError);
    });
    if (!spawned) return { ok: false as const, error: launchError };
    if (options.onClose) child.once("close", options.onClose);
    return { ok: true as const, pid: child.pid };
  } catch (error) {
    closeFdBestEffort(stdoutFd); closeFdBestEffort(stderrFd);
    return { ok: false as const, error };
  }
}
