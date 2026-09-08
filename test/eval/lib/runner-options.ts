/**
 * CLI and environment option parsing for the paired evaluation runner.
 *
 * Options are validated eagerly with explicit failure messages so the runner
 * never starts a session with an ambiguous configuration. No default contains
 * a machine-specific path; the baseline root, production Pi SDK entry, and at
 * least one model selector are always caller-supplied.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface RunnerOptions {
  baselineRoot: string;
  candidateRoot: string;
  piSdk: string;
  providerExtensions: string[];
  models: string[];
  suite: SuiteSelection;
  fixtureFilter: string[] | null;
  repetitions: number;
  retryCap: number;
  maxTurns: number;
  timeoutMs: number;
  maxOutputTokens: number;
  recordMessages: boolean;
  output: string;
}

export type SuiteSelection = "development" | "capability" | "held-out" | "all";

export interface OptionsParseResult {
  options: RunnerOptions | null;
  error: string | null;
  usage: string;
}

export const USAGE = `Usage: node --experimental-strip-types test/eval/paired-eval.mjs [options]

Required:
  --baseline-root <path>   Pinned baseline pi-subagents worktree (env CATALOG_EVAL_BASELINE_ROOT)
  --pi-sdk <path>          Production @earendil-works/pi-coding-agent package root or dist file (env CATALOG_EVAL_PI_SDK)
  --model <selector>       Model selector; repeat for multiple models (env CATALOG_EVAL_MODEL, comma-separated)

Optional:
  --candidate-root <path>  Candidate worktree (default: this repository; env CATALOG_EVAL_CANDIDATE_ROOT)
  --provider-extension <file>
                           Explicit model-provider extension; repeat when needed
  --suite <name>           development | capability | held-out | all (default: all)
  --fixtures <ids>         Comma-separated fixture id filter
  --repetitions <n>        Pair repetitions per fixture/model (default: 1)
  --retry-cap <n>          Bounded pair retries on infrastructure outcomes; every attempt is recorded (default: 1)
  --max-turns <n>          Model turns per session (default: 8)
  --timeout-ms <n>         Wall-clock session timeout; a timeout is an infrastructure outcome (default: 180000)
  --max-output-tokens <n>  Per-turn output cap (default: 6000)
  --record-messages        Include full session messages in the output document
  --output <path>          Result JSON path (default: catalog-eval-results.json in the working directory)
  --help                   Show this help
`;

interface RawOptions {
  baselineRoot?: string;
  candidateRoot?: string;
  piSdk?: string;
  providerExtensions: string[];
  models: string[];
  suite: string;
  fixtureFilter: string | null;
  repetitions: number;
  retryCap: number;
  maxTurns: number;
  timeoutMs: number;
  maxOutputTokens: number;
  recordMessages: boolean;
  output: string;
}

export interface RunnerEnvironment {
  readonly [key: string]: string | undefined;
}

function parseNonnegativeInteger(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

/** Parse argv plus environment into validated runner options. */
export function parseRunnerOptions(
  argv: ReadonlyArray<string>,
  env: RunnerEnvironment,
  defaults: { repoRoot: string; cwd: string },
): OptionsParseResult {
  const raw: RawOptions = {
    providerExtensions: [],
    models: [],
    suite: "all",
    fixtureFilter: null,
    repetitions: 1,
    retryCap: 1,
    maxTurns: 8,
    timeoutMs: 180_000,
    maxOutputTokens: 6_000,
    recordMessages: false,
    output: path.join(defaults.cwd, "catalog-eval-results.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string | null => {
      index += 1;
      const value = argv[index];
      return value === undefined ? null : value;
    };
    if (arg === "--help" || arg === "-h") {
      return { options: null, error: null, usage: USAGE };
    }
    if (arg === "--baseline-root") {
      const value = next();
      if (value === null) {
        return optionError(arg);
      }
      raw.baselineRoot = value;
    } else if (arg === "--candidate-root") {
      const value = next();
      if (value === null) {
        return optionError(arg);
      }
      raw.candidateRoot = value;
    } else if (arg === "--pi-sdk" || arg === "--sdk") {
      const value = next();
      if (value === null) {
        return optionError(arg);
      }
      raw.piSdk = value;
    } else if (arg === "--provider-extension") {
      const value = next();
      if (value === null) {
        return optionError(arg);
      }
      raw.providerExtensions.push(value);
    } else if (arg === "--model") {
      const value = next();
      if (value === null) {
        return optionError(arg);
      }
      raw.models.push(value);
    } else if (arg === "--suite") {
      const value = next();
      if (value === null) {
        return optionError(arg);
      }
      raw.suite = value;
    } else if (arg === "--fixtures") {
      const value = next();
      if (value === null) {
        return optionError(arg);
      }
      raw.fixtureFilter = value;
    } else if (arg === "--repetitions") {
      const value = next();
      const parsed = value === null ? null : parseNonnegativeInteger(value);
      if (parsed === null || parsed < 1) {
        return optionError(arg);
      }
      raw.repetitions = parsed;
    } else if (arg === "--retry-cap") {
      const value = next();
      const parsed = value === null ? null : parseNonnegativeInteger(value);
      if (parsed === null) {
        return optionError(arg);
      }
      raw.retryCap = parsed;
    } else if (arg === "--max-turns") {
      const value = next();
      const parsed = value === null ? null : parseNonnegativeInteger(value);
      if (parsed === null || parsed < 1) {
        return optionError(arg);
      }
      raw.maxTurns = parsed;
    } else if (arg === "--timeout-ms") {
      const value = next();
      const parsed = value === null ? null : parseNonnegativeInteger(value);
      if (parsed === null || parsed < 1) {
        return optionError(arg);
      }
      raw.timeoutMs = parsed;
    } else if (arg === "--max-output-tokens") {
      const value = next();
      const parsed = value === null ? null : parseNonnegativeInteger(value);
      if (parsed === null || parsed < 1) {
        return optionError(arg);
      }
      raw.maxOutputTokens = parsed;
    } else if (arg === "--record-messages") {
      raw.recordMessages = true;
    } else if (arg === "--output") {
      const value = next();
      if (value === null) {
        return optionError(arg);
      }
      raw.output = value;
    } else {
      return { options: null, error: `Unknown argument '${arg}'. Use --help.`, usage: USAGE };
    }
  }
  const models =
    raw.models.length > 0
      ? raw.models
      : (env.CATALOG_EVAL_MODEL ?? "")
          .split(",")
          .map((model) => model.trim())
          .filter((model) => model.length > 0);
  const suite = decodeSuiteSelection(raw.suite);
  if (suite === null) {
    return {
      options: null,
      error: `Unknown suite '${raw.suite}'. Use development, capability, held-out, or all.`,
      usage: USAGE,
    };
  }
  const baselineRoot = raw.baselineRoot ?? env.CATALOG_EVAL_BASELINE_ROOT;
  if (baselineRoot === undefined || baselineRoot.trim() === "") {
    return {
      options: null,
      error: `--baseline-root (or CATALOG_EVAL_BASELINE_ROOT) is required.\n${USAGE}`,
      usage: USAGE,
    };
  }
  const piSdk = raw.piSdk ?? env.CATALOG_EVAL_PI_SDK;
  if (piSdk === undefined || piSdk.trim() === "") {
    return {
      options: null,
      error: `--pi-sdk (or CATALOG_EVAL_PI_SDK) is required: point it at the production @earendil-works/pi-coding-agent package root or its dist/index.js.\n${USAGE}`,
      usage: USAGE,
    };
  }
  if (models.length === 0) {
    return {
      options: null,
      error: `At least one --model selector (or CATALOG_EVAL_MODEL) is required.\n${USAGE}`,
      usage: USAGE,
    };
  }
  const fixtureFilter =
    raw.fixtureFilter === null
      ? null
      : raw.fixtureFilter
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
  const options: RunnerOptions = {
    baselineRoot: path.resolve(baselineRoot),
    candidateRoot: path.resolve(
      raw.candidateRoot ?? env.CATALOG_EVAL_CANDIDATE_ROOT ?? defaults.repoRoot,
    ),
    piSdk: path.resolve(piSdk),
    providerExtensions: raw.providerExtensions.map((extensionPath) => path.resolve(extensionPath)),
    models,
    suite,
    fixtureFilter,
    repetitions: raw.repetitions,
    retryCap: raw.retryCap,
    maxTurns: raw.maxTurns,
    timeoutMs: raw.timeoutMs,
    maxOutputTokens: raw.maxOutputTokens,
    recordMessages: raw.recordMessages,
    output: path.resolve(raw.output),
  };
  if (!fs.existsSync(options.candidateRoot)) {
    return {
      options: null,
      error: `Candidate root '${options.candidateRoot}' does not exist.`,
      usage: USAGE,
    };
  }
  for (const extensionPath of options.providerExtensions) {
    if (!fs.existsSync(extensionPath) || !fs.statSync(extensionPath).isFile()) {
      return {
        options: null,
        error: `Provider extension '${extensionPath}' does not exist or is not a file.`,
        usage: USAGE,
      };
    }
  }
  return { options, error: null, usage: USAGE };
}

function decodeSuiteSelection(value: string): SuiteSelection | null {
  if (
    value === "development" ||
    value === "capability" ||
    value === "held-out" ||
    value === "all"
  ) {
    return value;
  }
  return null;
}

function optionError(flag: string): OptionsParseResult {
  return { options: null, error: `Missing or invalid value for ${flag}.`, usage: USAGE };
}

/** Suite file names for a selection; `all` covers every suite. */
export function suiteFileNames(suite: SuiteSelection): string[] {
  if (suite === "all") {
    return ["development-suite.json", "capability-suite.json", "held-out-suite.json"];
  }
  return [`${suite}-suite.json`];
}
