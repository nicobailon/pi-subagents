/**
 * determinator-extension — zero-LLM runtime dla agenta "determinator".
 *
 * Wstrzykiwane automatycznie do każdego child processu (tak jak
 * subagent-prompt-runtime.ts). Aktywuje się tylko gdy
 * PI_SUBAGENT_CHILD_AGENT === "determinator".
 *
 * Przechwytuje input, parsuje task (JSON lub ścieżka), ładuje skrypt .ts
 * przez jiti, wywołuje go z DeterminatorContext, zwraca { action: "handled" }.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti/static";
import type {
  DeterminatorContext,
  DeterminatorScript,
} from "./interface";

// ── env (odczytywane w momencie wywołania, nie importu) ──────────────────

function getRunId(): string {
  return process.env.PI_SUBAGENT_RUN_ID ?? "unknown";
}
function getChildIndex(): number {
  return Number(process.env.PI_SUBAGENT_CHILD_INDEX ?? "0");
}

// ── parsowanie prefixów chainowych ─────────────────────────────────────────

const READ_RE = /^\[Read from:\s*(.+?)\]\s*$/gm;
const WRITE_RE = /^\[Write to:\s*(.+?)\]\s*$/gm;

export interface ParsedTask {
  /** Ścieżka do skryptu .ts */
  scriptPath: string;
  /** Dodatkowe parametry (z JSON-a) */
  params: Record<string, unknown>;
  /** Ścieżki z [Read from: ...] */
  reads: string[];
  /** Ścieżka z [Write to: ...] (pierwsza znaleziona) */
  writeTo: string | null;
  /** Tekst tasku po oczyszczeniu z prefixów */
  body: string;
}

export function parseTaskText(text: string): ParsedTask {
  const reads: string[] = [];
  const writeMatches: string[] = [];

  let cleaned = text;
  cleaned = cleaned.replace(READ_RE, (_match, files: string) => {
    for (const f of files.split(",").map((s: string) => s.trim())) {
      if (f) reads.push(f);
    }
    return "";
  });
  cleaned = cleaned.replace(WRITE_RE, (_match, file: string) => {
    writeMatches.push(file.trim());
    return "";
  });

  const writeTo = writeMatches[0] ?? null;
  const body = cleaned.trim();

  // Próbuj sparsować body jako JSON
  let scriptPath = "";
  let params: Record<string, unknown> = {};

  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.script === "string" && parsed.script.length > 0) {
      scriptPath = parsed.script;
    }
    if (parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)) {
      params = parsed.params as Record<string, unknown>;
    }
  } catch {
    // Fallback: pierwsza niepusta linia to ścieżka
    const lines = body.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---")) {
        scriptPath = trimmed;
        break;
      }
    }
  }

  return { scriptPath, params, reads, writeTo, body };
}

// ── context.json ────────────────────────────────────────────────────────────

export interface StepContext {
  chain_dir: string;
  step_index: number;
  agent: string;
  task: string;
  output?: string;
  reads: string[];
  inputs: Record<string, { text: string; structured?: unknown }>;
  run_id: string;
  artifacts_dir: string;
}

export function findContextFile(chainDir: string, runId?: string): string | null {
  const effectiveRunId = runId ?? getRunId();
  if (!fs.existsSync(chainDir)) return null;
  const entries = fs.readdirSync(chainDir);
  // Szukamy pliku *_context.json pasującego do runId
  for (const entry of entries) {
    if (
      entry.startsWith(effectiveRunId) &&
      entry.endsWith("_context.json")
    ) {
      return path.join(chainDir, entry);
    }
  }
  return null;
}

export function loadContextFile(chainDir: string, runId?: string): StepContext | null {
  const filePath = findContextFile(chainDir, runId);
  if (!filePath) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const ctx = JSON.parse(raw) as StepContext;
    return ctx;
  } catch {
    return null;
  }
}

// ── helpery dla DeterminatorContext ─────────────────────────────────────────

function makeLogFn(chainDir: string): (message: string) => void {
  const logPath = path.join(chainDir, "determinator-debug.log");
  return (message: string) => {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${message}\n`;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, line, "utf-8");
    } catch {
      // Logging is best-effort.
    }
  };
}

async function makeExecFn(
  _cwd: string,
): Promise<(command: string) => Promise<{ stdout: string; stderr: string }>> {
  // Używamy sync exec, bo jiti nie wspiera top-level await w extension
  return (command: string) => {
    try {
      const stdout = execSync(command, {
        encoding: "utf-8",
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return Promise.resolve({ stdout, stderr: "" });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return Promise.resolve({
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message ?? String(err),
      });
    }
  };
}

async function makeReadFileFn(): Promise<
  (filePath: string) => Promise<string>
> {
  return (filePath: string) => {
    return Promise.resolve(fs.readFileSync(filePath, "utf-8"));
  };
}

async function makeWriteFileFn(): Promise<
  (filePath: string, content: string) => Promise<void>
> {
  return (filePath: string, content: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    return Promise.resolve();
  };
}

// ── główna funkcja ─────────────────────────────────────────────────────────

export default function registerDeterminatorExtension(
  pi: ExtensionAPI,
): void {
  pi.on("input", async (event, _ctx) => {
    const rawText = (event as { text: string }).text ?? "";
    const runId = getRunId();
    const childIndex = getChildIndex();

    // 1. Parsuj task text
    const parsed = parseTaskText(rawText);

    if (!parsed.scriptPath) {
      return {
        action: "handled" as const,
      };
    }

    // 2. Ustal chainDir
    let chainDir = process.cwd();
    if (parsed.writeTo) {
      // Wyciągnij chainDir z [Write to: /chainDir/output.md]
      const dir = path.dirname(parsed.writeTo);
      if (fs.existsSync(dir)) chainDir = dir;
    }

    // 3. Wczytaj context.json (jeśli istnieje)
    const stepCtx = loadContextFile(chainDir, runId);
    const inputs = stepCtx?.reads ?? parsed.reads;
    const output =
      stepCtx?.output ?? parsed.writeTo ?? path.join(chainDir, "determinator-output.md");

    // 4. Określ scriptPath, params i task — chain mode z context.json ma priorytet
    let scriptPath = parsed.scriptPath;
    let taskParams = parsed.params;
    let cleanTask = parsed.body;

    if (stepCtx?.task) {
      try {
        const taskObj = JSON.parse(stepCtx.task);
        if (typeof taskObj.script === "string" && taskObj.script.length > 0) {
          scriptPath = taskObj.script;
        }
        if (taskObj.params && typeof taskObj.params === "object" && !Array.isArray(taskObj.params)) {
          taskParams = taskObj.params as Record<string, unknown>;
        }
        cleanTask = stepCtx.task;
      } catch {
        // chain mode fallback — użyj parsed
      }
    }

    // 5. Rozwiąż ścieżkę skryptu
    const resolvedScriptPath = path.isAbsolute(scriptPath)
      ? scriptPath
      : path.resolve(process.cwd(), scriptPath);

    // 6. Zbuduj DeterminatorContext
    const log = makeLogFn(chainDir);
    const execFn = await makeExecFn(process.cwd());
    const readFile = await makeReadFileFn();
    const writeFile = await makeWriteFileFn();

    const ctx: DeterminatorContext = {
      inputs,
      output,
      cwd: process.cwd(),
      task: cleanTask,
      chainDir,
      params: taskParams,
      runId,
      agentName: process.env.PI_SUBAGENT_CHILD_AGENT ?? "determinator",
      stepIndex: Number.isNaN(childIndex) ? 0 : childIndex,
      log,
      exec: execFn,
      readFile,
      writeFile,
    };

    // 6. Załaduj i uruchom skrypt
    let resultContent: string;
    try {
      log(`Loading script: ${resolvedScriptPath}`);

      const jiti = createJiti(import.meta.url, {
        interopDefault: true,
      });
      const mod = await jiti.import(resolvedScriptPath, { default: true });
      const scriptFn: DeterminatorScript =
        typeof mod === "function" ? mod : (mod as { default: DeterminatorScript }).default;

      if (typeof scriptFn !== "function") {
        throw new Error(
          `Script ${scriptPath} did not export a default function. Got: ${typeof scriptFn}`,
        );
      }

      log("Script loaded, executing...");
      const result = await scriptFn(ctx);

      // 7. Zapisz output
      const outputText =
        result.output || `Determinator completed with exit code ${result.exitCode}`;
      resultContent = outputText;
      await writeFile(ctx.output, outputText);

      if (result.error) {
        await writeFile(
          ctx.output + ".error",
          `Exit code: ${result.exitCode}\nError: ${result.error}\n`,
        );
      }

      log(`Done. exitCode=${result.exitCode}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : "";
      resultContent = `Determinator failed:\n${message}\n\n${stack}`;
      try {
        await writeFile(ctx.output, resultContent);
      } catch {
        // Best effort.
      }
      log(`FAILED: ${message}`);
    }

    // 8. Zwróć output i zablokuj LLM
    return { action: "handled" as const };
  });
}
