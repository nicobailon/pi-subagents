# Paired catalog evaluation

This directory contains a durable, runnable harness that compares a **pinned
baseline root** with the **current candidate root** of pi-subagents using each
root's _actual_ published tool contract: the model-facing description, the
parameter schema, the production parser/normalizer, and the production
`runWorkflowScript` sandbox. Every effect is faked. Nothing here launches real
children, shells, host commands, schedules, or publications, and nothing
mutates either repository.

## What it measures

- **Semantic pass/fail** per scenario, judged by independent predicates over
  the ordered fake-effect trace plus the final answer (never by string match
  against a coached answer).
- **Provider errors** (assistant `stopReason: "error"` or provider-pattern
  prompt failures) and **setup/runner errors** are infrastructure outcomes:
  recorded, excluded from the semantic denominator, and eligible for bounded
  pair retry.
- **Turn-limit** (model-turn cap exhaustion) is a model/efficiency outcome: its
  own bucket, never silently retried, never a semantic failure.
- **Wall-timeout** (session wall-clock abort) is infrastructure: recorded,
  retry-eligible, never a semantic failure.
- **Launch-form-neutral infrastructure failure**: the first launch attempt of
  any form (direct child, `runs.run`, `runs.all`) receives the configured
  failure; any further launch is recorded as a prohibited effect, never a
  fabricated success. Launch form is derived from the workflow sandbox's
  admission flag, so a later `runs.run` never inherits a prior `runs.all`
  batch form.
- Per attempt: outcome plus reason, first-call validity, first-launch validity
  and turn, invalid calls, help/discovery calls, turns, input/output/cache
  tokens, total tokens, elapsed time, effect trace, prohibited effects, final
  answer, assembled system prompt, published tool definition, raw provider
  payloads, and the deterministic variant order used for the pair.

## Suites

- `fixtures/development-suite.json` contains the six frozen development
  scenarios (single read-only child, isolated parallel writers,
  writer/review/fix, infrastructure failure, retained-child resume, and
  named-workflow policy). Do not tune these to make a candidate pass.
- `fixtures/capability-suite.json` contains nine self-authored capability
  scenarios (agent `get`, `models`, `validate`-then-run, `status` recovery,
  `steer`, `stop`, `mission.attach-run`/`mission.show`, `schedule.create`, and
  `workflowScriptPath`). These were originally labeled "held-out"; they are
  regression coverage only and are disjoint from the true held-out set.
- `fixtures/held-out-suite.json` contains the true held-out set. Its six
  scenarios come from the independently authored black-box design: foreground
  structured classifier, conditional structured raw workflow, offline
  nested-async validation, exact child transcript tail, child-scoped stop,
  and raw-workflow host-authority denial. The suite document records the
  report's path and SHA-256
  (`1b3bea7280a0feb1195afb81fa86eb7d9c1a0da6756b3d621a3d24656522bda4`,
  `subagent-artifacts/outputs/483f9d3f-e137-4ca8-afd4-2f78298dd75d/catalog-eval/independent-heldout-design.md`),
  and the runner echoes it into the result document's harness metadata.
  Held-out scenario names and answers must never appear in production
  guidance.

`--suite` selects `development`, `capability`, `held-out`, or `all` (default:
all three).

## Preserved evaluation results

`results/catalog-command-catalog/` contains the compressed raw held-out matrices,
the independent scenario design, exact hashes, token measurements, and rollout
verification for candidate commit `d080871f`. These artifacts preserve all
attempts and infrastructure outcomes. They are review evidence, not golden files
or fixtures; normal tests do not read them.

## Permission evidence and coverage

Three distinct tiers, deliberately not conflated:

1. **Deterministic policy-chain probes** (`lib/policy-probe.ts`, exercised by
   the runner before any model call and by unit tests): each variant's real
   parser, then the fixture policy classifier, then the fake runtime. These
   prove the chain the harness controls. They are **not** the real Pi
   `tool_call` hook path.
2. **Registration-path hook evidence** (`test/unit/index-child-registration.test.ts`,
   plus `test/unit/eval-hook-path.test.ts` reusing the same fake-Pi
   registration pattern): the real registered `tool_call` handler of the
   candidate extension blocks forged permits, caller-supplied provenance, and
   post-allow mutated envelopes before the executor runs. This is the
   registration seam, still not a live `AgentSession`.
3. **AgentSession hook traces during model sessions**: the runner's capture
   extension registers `pi.on("tool_call", ...)` on the live session, so
   `policy-allow` / `policy-deny` trace entries in model-session attempts are
   emitted by the actual session hook.

No authority shim is invented anywhere in the harness.

## Requirements

- Node with `--experimental-strip-types` (the npm script sets it).
- The production `@earendil-works/pi-coding-agent` distribution. The
  repository's own dev dependency is a type shim, so the SDK path is always
  explicit; the harness refuses to run against a shim.
- Custom model providers require each trusted provider extension to be passed
  explicitly with `--provider-extension`. Ambient extensions remain disabled.
- A pinned baseline worktree at the base commit and the candidate worktree.
  Both need their own `node_modules` installed (the harness never installs
  anything).

## Usage

```bash
npm run eval:catalog-models -- \
  --baseline-root /path/to/pi-subagents-baseline-worktree \
  --pi-sdk /path/to/global/node_modules/@earendil-works/pi-coding-agent \
  --model "openai-codex/gpt-5.6-sol:high" \
  --suite all --repetitions 3 --retry-cap 1 \
  --output /path/to/catalog-eval-results.json
```

For a provider supplied by a Pi extension, name the extension file explicitly:

```bash
npm run eval:catalog-models -- \
  --baseline-root /path/to/pi-subagents-baseline-worktree \
  --pi-sdk /path/to/global/node_modules/@earendil-works/pi-coding-agent \
  --provider-extension /path/to/provider-extension/dist/index.js \
  --model "provider/model" \
  --suite held-out --repetitions 3
```

Provider extension paths and SHA-256 hashes are recorded in the result metadata.
The runner loads only those explicit extensions, emits `session_shutdown` before
session disposal, and still disables ambient extensions and other resources.

Equivalent environment variables: `CATALOG_EVAL_BASELINE_ROOT`,
`CATALOG_EVAL_CANDIDATE_ROOT` (default: this repository), `CATALOG_EVAL_PI_SDK`,
and `CATALOG_EVAL_MODEL` (comma-separated). Run `--help` for every flag.

Key flags:

| Flag                   | Meaning                                                                 | Default         |
| ---------------------- | ----------------------------------------------------------------------- | --------------- |
| `--baseline-root`      | Pinned baseline worktree                                                | required        |
| `--candidate-root`     | Candidate worktree                                                      | this repository |
| `--pi-sdk`             | Production Pi SDK package root or `dist/index.js`                       | required        |
| `--provider-extension` | Trusted model-provider extension file; repeatable                       | none            |
| `--model`              | Model selector; repeatable                                              | required        |
| `--suite`              | `development`, `capability`, `held-out`, or `all`                       | `all`           |
| `--fixtures`           | Comma-separated fixture id filter                                       | all             |
| `--repetitions`        | Pair repetitions per fixture/model                                      | `1`             |
| `--retry-cap`          | Bounded pair retries on infrastructure outcomes (all attempts recorded) | `1`             |
| `--max-turns`          | Model turns per session (turn-limit bucket)                             | `8`             |
| `--timeout-ms`         | Wall-clock session timeout (wall-timeout bucket)                        | `180000`        |
| `--record-messages`    | Include full session messages in the output                             | off             |

The result JSON is written incrementally after every attempt, so interrupted
runs still leave a readable partial document. Pairs are only "comparable" when
both variants produced semantic outcomes; infrastructure and timeout attempts
stay in the document but outside the semantic pass-rate denominator.

## Fairness controls

Both variants of a pair share the model, thinking level, explicit provider
extensions, user prompt, lean neutral system policy, discovery table, fake
runtime responses, turn/output limits, and fresh in-memory message history.
The only intended difference is
the published tool contract (baseline flat schema + long compact description
vs candidate catalog envelope + catalog help) and the corresponding guidance.

**Variant order alternates deterministically**: for repetition `r` and attempt
`a`, the order is baseline-first when `r + a` is odd and candidate-first when
even, and the order used is recorded on every attempt (`variantOrder`). The
chosen comparable attempts stay aligned by attempt index within each variant.

One paired repetition per fixture is a smoke test, not an estimate of
statistical reliability; use `--repetitions 3` or more for comparisons.

## Unit tests

The deterministic pieces (outcome classification including the timeout split,
provider-error exclusion, launch-form-neutral failure and batch-form
isolation, capability and held-out predicates, policy-chain probes,
registration-hook path, boundary decoders) are covered by
`test/unit/eval-*.test.ts` and run with the normal unit test suite. The unit
tests use the candidate's own modules only; they never require the baseline
worktree or the production SDK.

## Limitations

- The paired matrix itself is paid model evaluation and is owned by the
  caller; this harness only runs it.
- Fake in-workflow `status` honestly reports "still running"; polling is never
  rewarded with a fabricated completion.
- `runs.all` collects child failures rather than throwing (production
  semantics); the infrastructure fixture therefore relies on the model
  reporting failed child results.
- The baseline variant uses its compact description
  (`COMPACT_SUBAGENT_TOOL_DESCRIPTION`), matching the pinned comparison setup.
- The harness system prompt is deliberately lean and pair-controlled;
  absolute pass rates are not comparable to earlier coached runs.
