# Phase-timing telemetry

## Status and scope

This note documents telemetry currently present in the working tree. It is **uncommitted and not released**.

`PhaseTiming` is the shared optional timestamp shape:

| Field | Boundary observed locally |
| --- | --- |
| `launchedAt` | foreground attempt or async launch begins |
| `runnerStartedAt` | detached async runner starts |
| `childSpawnedAt` | child Pi process is spawned |
| `firstChildEventAt` | first child event is received |
| `firstAssistantEventAt` | first assistant `message_end` event is received |
| `completedAt` | run/attempt completion is recorded |
| `resultDeliveredAt` | async result watcher emits delivery to the parent |

Displayed intervals are `launch→runner`, `spawn→event`, `event→assistant`, `assistant→done`, and `completion→delivery`. Missing milestones leave the corresponding interval absent. Timestamps are local wall-clock observations, not provider-side timings. For retried foreground work, inspect per-attempt `phaseTiming` rather than cleared aggregate result progress.

## Changed implementation and tests

The current telemetry diff changes:

- `src/shared/types.ts` — shared timing fields on run, progress, status, event, and model-attempt shapes.
- `src/runs/foreground/execution.ts` — foreground attempt milestones and attempt-result propagation.
- `src/runs/background/async-execution.ts` — async launch timestamp propagation.
- `src/runs/background/subagent-runner.ts` — runner, child-spawn, child-event, assistant-event, and completion milestones.
- `src/runs/background/result-watcher.ts` — parent delivery timestamp persistence/emission.
- `src/runs/background/async-status.ts` — persisted-status summaries and phase formatting.
- `test/integration/async-execution.test.ts`, `test/integration/async-status.test.ts`, `test/integration/result-watcher.test.ts`, and `test/integration/single-execution.test.ts` — milestone, formatting, delivery, retry, and pre-spawn timeout coverage.

## Benchmark notes

Method: a tiny synthetic direct child job was run three times with the `terra` medium model, then a fresh async run (`dead042b`) was examined through the persisted phase boundaries. This is observational benchmarking, not a throughput or provider SLA test.

- Direct `terra` medium runs: **4257 ms, 4359 ms, 4226 ms**; arithmetic average **4281 ms**.
- Fresh async run `dead042b`: `launch→runner` **227 ms**; `spawn→event` **1881 ms**; `event→assistant` **3857 ms**; `assistant→done` **1020 ms**; `completion→delivery` **655 ms**; total **7640 ms**.

Interpretation: in this sample, the largest measured interval was from the first child event to the first assistant completion event, rather than detached-run startup or parent delivery. The async total is a decomposition of locally observed boundaries and should not be read as a causal attribution or a comparison with the direct-run average.

## Limitations and next steps

Limitations: the job was tiny and synthetic; parent orchestration is excluded; provider/model and network variance can dominate a single sample; the event boundaries are not token-first-byte or provider-internal timings.

Next steps:

1. Collect repeated runs across models, task sizes, and foreground/async modes; report distributions rather than one average.
2. Correlate timings with retry attempts and status persistence while preserving compatibility for absent fields.
3. Decide whether user-facing status needs clearer labeling for local observation boundaries and missing milestones.
4. Add a controlled benchmark harness only if ongoing performance work justifies its maintenance cost.
