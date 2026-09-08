#!/usr/bin/env node
/**
 * Paired catalog-evaluation runner (thin entry).
 *
 * Compares a caller-supplied pinned baseline root with the current candidate
 * root using each root's actual published tool description, schema, parser,
 * and production workflow sandbox, driven through fresh in-memory Pi sessions
 * with fake effects only. See test/eval/README.md for full usage.
 *
 * Requires: node --experimental-strip-types (the npm script eval:catalog-models sets it).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { shouldRetryPair } from "./lib/classify-outcome.ts";
import { parseRunnerOptions, suiteFileNames } from "./lib/runner-options.ts";
import {
  attemptLine,
  createResultDocument,
  saveResultDocument,
  sha256File,
  summarizeDocument,
  variantOrderFor,
} from "./lib/runner-report.ts";
import { runSessionAttempt } from "./lib/runner-session.ts";
import { decodeSuiteDocument } from "./lib/decode.ts";
import { createFakeSubagentRuntime } from "./lib/fake-runtime.ts";
import {
  lateMutationProbeCalls,
  policyProbeCalls,
  runPolicyProbeCall,
} from "./lib/policy-probe.ts";
import { loadBaselineVariant, loadCatalogVariant, resolveSdkEntry } from "./lib/variant-modules.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repoRoot, "test", "eval", "fixtures");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const parsedOptions = parseRunnerOptions(process.argv.slice(2), process.env, {
  repoRoot,
  cwd: process.cwd(),
});
if (parsedOptions.error !== null) {
  fail(parsedOptions.error);
}
if (parsedOptions.options === null) {
  process.stdout.write(parsedOptions.usage);
  process.exit(0);
}
const options = parsedOptions.options;

const sdkEntry = resolveSdkEntry(options.piSdk);
if (sdkEntry === "") {
  fail(
    `--pi-sdk '${options.piSdk}' does not resolve to a production Pi SDK entry (expected <package>/dist/index.js). Refusing to substitute a test shim.`,
  );
}
const sdkModule = await import(pathToFileURL(sdkEntry).href);
const requiredSdkExports = [
  "createAgentSession",
  "createAgentSessionServices",
  "DefaultResourceLoader",
  "defineTool",
  "getAgentDir",
  "ModelRuntime",
  "resolveCliModel",
  "SessionManager",
  "SettingsManager",
];
for (const exportName of requiredSdkExports) {
  if (sdkModule[exportName] === undefined) {
    fail(
      `Pi SDK entry '${sdkEntry}' does not export '${exportName}'; it is not a production pi-coding-agent distribution.`,
    );
  }
}

const suites = [];
for (const fileName of suiteFileNames(options.suite)) {
  const file = path.join(fixtureDir, fileName);
  const raw = fs.readFileSync(file, "utf8");
  const decoded = decodeSuiteDocument(JSON.parse(raw));
  if (!decoded.ok) {
    fail(`Suite file '${file}' is invalid: ${decoded.error}`);
  }
  suites.push({
    file,
    sha256: sha256File(file),
    suite: decoded.document.suite,
    sourceReport: decoded.document.sourceReport ?? null,
    discoveryAgents: decoded.document.discovery.agents,
    fixtures: decoded.document.fixtures,
  });
}

const selectedFixtures = [];
for (const suite of suites) {
  for (const fixture of suite.fixtures) {
    if (options.fixtureFilter !== null && !options.fixtureFilter.includes(fixture.id)) {
      continue;
    }
    selectedFixtures.push({
      suite: suite.suite,
      discoveryAgents: fixture.discoveryAgents ?? suite.discoveryAgents,
      fixture,
    });
  }
}
if (selectedFixtures.length === 0) {
  fail("No fixture matched the requested suite/filter.");
}

const candidate = await loadCatalogVariant(options.candidateRoot);
const baseline = await loadBaselineVariant(options.baselineRoot);
let modelRuntime;
if (options.providerExtensions.length === 0) {
  modelRuntime = await sdkModule.ModelRuntime.create({ allowModelNetwork: false });
} else {
  const providerServices = await sdkModule.createAgentSessionServices({
    cwd: repoRoot,
    agentDir: sdkModule.getAgentDir(),
    settingsManager: sdkModule.SettingsManager.inMemory({}),
    modelRuntimeSignal: AbortSignal.timeout(15_000),
    resourceLoaderOptions: {
      additionalExtensionPaths: options.providerExtensions,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  });
  const extensionErrors = providerServices.resourceLoader.getExtensions().errors;
  const serviceErrors = providerServices.diagnostics.filter(
    (diagnostic) => diagnostic.type === "error",
  );
  if (extensionErrors.length > 0 || serviceErrors.length > 0) {
    fail(`Provider extension setup failed: ${JSON.stringify({ extensionErrors, serviceErrors })}`);
  }
  modelRuntime = providerServices.modelRuntime;
}

const EVAL_SYSTEM_PROMPT = [
  "You are evaluating a delegation tool.",
  "Follow the user's request using only the subagent tool.",
  "Do not claim a delegated result until the tool returns it.",
  "Report blockers exactly as the tool reported them.",
  "Be concise.",
].join(" ");

const document = createResultDocument({
  entry: "test/eval/paired-eval.mjs",
  candidateRoot: candidate.root,
  baselineRoot: baseline.root,
  piSdkEntry: sdkEntry,
  providerExtensions: options.providerExtensions.map((extensionPath) => ({
    path: extensionPath,
    sha256: sha256File(extensionPath),
  })),
  models: options.models,
  suite: options.suite,
  repetitions: options.repetitions,
  retryCap: options.retryCap,
  maxTurns: options.maxTurns,
  timeoutMs: options.timeoutMs,
  maxOutputTokens: options.maxOutputTokens,
  suiteSources: suites.map((suite) => ({
    file: suite.file,
    sha256: suite.sha256,
    suite: suite.suite,
    sourceReport: suite.sourceReport,
  })),
  heldOutSourceReport: suites.find((suite) => suite.suite === "held-out")?.sourceReport ?? null,
  systemPrompt: EVAL_SYSTEM_PROMPT,
  scope:
    "Fresh SDK sessions with actual baseline or candidate tool definitions, production parsing and workflow sandbox, and injected fake effects. No real children, shell, host commands, schedules, repository mutation, or publication.",
});

function saveResults() {
  saveResultDocument(document, options.output);
}

async function runPolicyProbes(fixture, variants) {
  const records = [];
  for (const variant of variants) {
    const form = variant.kind === "catalog" ? "catalog" : "flat";
    const probes = [...policyProbeCalls(form), ...lateMutationProbeCalls(form)];
    for (const probe of probes) {
      const runtime = createFakeSubagentRuntime(fixture, [], {
        runWorkflowScript: variant.runWorkflowScript,
        validateWorkflowScript: variant.validateWorkflowScript,
        renderHelp: variant.renderHelp,
      });
      const outcome = await runPolicyProbeCall(
        probe,
        variant.canonicalize,
        fixture,
        async (request) => {
          await runtime.execute(request);
          return { effects: runtime.trace };
        },
        fixture.policy,
      );
      records.push({
        fixtureId: fixture.id,
        variant: variant.kind,
        name: outcome.name,
        blocked: outcome.blocked,
        parseOk: outcome.parseOk,
        parseError: outcome.parseError,
        effectCount: outcome.effectCount,
        reasons: outcome.reasons,
      });
    }
  }
  return records;
}

saveResults();

for (const { fixture } of selectedFixtures) {
  if (fixture.policy === undefined) {
    continue;
  }
  const probes = await runPolicyProbes(fixture, [baseline, candidate]);
  document.policyProbes.push(...probes);
  saveResults();
  for (const probe of probes) {
    const verdict = probe.blocked && probe.effectCount === 0 ? "BLOCKED-NO-EFFECTS" : "LEAKED";
    process.stdout.write(
      `policy-probe ${probe.fixtureId} ${probe.variant} ${probe.name}: ${verdict}\n`,
    );
  }
}

const variantsByKind = { baseline, candidate };

for (const modelSelector of options.models) {
  const resolved = sdkModule.resolveCliModel({ cliModel: modelSelector, modelRuntime });
  if (resolved.error !== undefined || resolved.model === undefined) {
    const message = `Could not resolve model '${modelSelector}': ${resolved.error ?? "unknown error"}`;
    document.status = "failed";
    document.failure = message;
    document.completedAt = new Date().toISOString();
    saveResults();
    fail(message);
  }
  const model = { ...resolved.model, maxTokens: options.maxOutputTokens };
  const thinkingLevel = resolved.thinkingLevel ?? "high";
  const modelLabel = `${model.provider}/${model.id}`;

  for (const { suite, discoveryAgents, fixture } of selectedFixtures) {
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      const pairId = `${modelLabel}/${fixture.id}#${repetition}`;
      const attempts = [];
      for (let attemptIndex = 1; attemptIndex <= options.retryCap + 1; attemptIndex += 1) {
        const variantOrder = variantOrderFor(repetition, attemptIndex);
        for (const variantKind of variantOrder) {
          const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-eval-session-"));
          const attempt = await runSessionAttempt({
            fixture,
            discoveryAgents,
            variant: variantsByKind[variantKind],
            variantOrder,
            model,
            modelLabel,
            thinkingLevel,
            repetition,
            attemptIndex,
            suite,
            piSdk: sdkModule,
            modelRuntime,
            providerExtensionPaths: options.providerExtensions,
            options: {
              maxTurns: options.maxTurns,
              timeoutMs: options.timeoutMs,
              systemPrompt: EVAL_SYSTEM_PROMPT,
              recordMessages: options.recordMessages,
            },
            sessionDir,
          });
          attempts.push(attempt);
          document.pairs.push({ pairId, attempt });
          saveResults();
          process.stdout.write(`${attemptLine(attempt)}\n`);
        }
        const baselineOutcome = attempts
          .filter((attempt) => attempt.variant === "baseline")
          .at(-1)?.outcome;
        const candidateOutcome = attempts
          .filter((attempt) => attempt.variant === "candidate")
          .at(-1)?.outcome;
        const retriesRemaining = options.retryCap + 1 - attemptIndex;
        if (baselineOutcome === undefined || candidateOutcome === undefined) {
          break;
        }
        if (!shouldRetryPair(baselineOutcome, candidateOutcome, retriesRemaining)) {
          break;
        }
        process.stdout.write(
          `${pairId}: infrastructure outcome (${baselineOutcome}/${candidateOutcome}); retrying pair, all attempts preserved.\n`,
        );
      }
    }
  }
}

document.summary = summarizeDocument(document);
document.status = "complete";
document.completedAt = new Date().toISOString();
saveResults();
process.stdout.write(`\nSummary: ${JSON.stringify(document.summary.byVariant)}\n`);
process.stdout.write(
  `Policy probes blocked with zero effects: ${document.summary.policyProbes.blockedWithZeroEffects}/${document.summary.policyProbes.total}\n`,
);
process.stdout.write(`Results: ${options.output}\n`);
