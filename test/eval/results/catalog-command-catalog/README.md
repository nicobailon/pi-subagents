# Command catalog evaluation evidence

This directory preserves the final paired held-out evaluation used to assess the stateless `subagent` command catalog. The candidate is commit `d080871fb7a9fb2b807014064b2f091bf367b11c`. The compact flat-contract baseline is commit `54df154d1891db6b1a3e755539683335b9f9dbd3`.

The evaluator used the production Pi 0.85.1 SDK, each revision's published description and parameter schema, production parsing, and the production workflow sandbox. All child, workflow, host, schedule, control, and filesystem effects were fake. These files record model behavior and provider serialization, not permission to perform real work.

## Held-out results

| Requested model                 | Pair repetitions | Comparable pairs | Compact baseline | Catalog candidate | Other recorded outcomes                                                                                 |
| ------------------------------- | ---------------: | ---------------: | ---------------: | ----------------: | ------------------------------------------------------------------------------------------------------- |
| `openai-codex/gpt-5.6-luna:max` |               18 |               18 |  12 pass, 6 fail |   15 pass, 3 fail | One catalog wall timeout was preserved and retried.                                                     |
| `kimi-coding/k3-256k:max`       |               18 |               15 |  11 pass, 4 fail |   13 pass, 2 fail | Provider errors, one baseline turn limit, and baseline wall timeouts remain in the raw attempt history. |
| `zai/glm-5.3:max`               |               18 |               17 |  11 pass, 6 fail |   12 pass, 5 fail | One baseline turn limit and one baseline wall timeout remain in the raw attempt history.                |
| `cursor/grok-4.6`               |               18 |               17 |  12 pass, 5 fail |   15 pass, 2 fail | Each variant recorded one turn limit.                                                                   |

A turn limit is a reliability miss. Provider errors, setup errors, and wall-clock timeouts are infrastructure outcomes. The evaluator preserves every attempt and retries only infrastructure outcomes up to the configured cap. The table reports comparable semantic pairs separately so infrastructure does not become a model failure or disappear from the record.

The Luna and Kimi results were the primary model-family evidence. GLM and Grok were supplementary. Kimi was retired from further evaluation because its latency made repeated runs impractical.

## Token measurement

`token-counts.json` measures compact JSON with `tiktoken` 0.12.0 and `o200k_base`:

| Definition            | Published tool | First OpenAI provider tool |
| --------------------- | -------------: | -------------------------: |
| Catalog candidate     |     626 tokens |                 634 tokens |
| Compact flat baseline |   5,533 tokens |               5,541 tokens |

The candidate cut the provider-visible definition by about 89%. This is definition-payload evidence, not an end-to-end cost claim. Session cost also depends on discovery calls, turns, output, cache reads, provider pricing, and failures.

## Files

- `luna-heldout.json.gz`, `kimi-heldout.json.gz`, `glm-heldout.json.gz`, and `grok-heldout.json.gz` contain the unedited evaluator JSON compressed with `gzip -n -9`.
- `luna-provider-smoke.jsonl.gz` contains the effect-free installed-package provider smoke.
- `independent-heldout-design.md` is the independently authored scenario design. Its source hash is recorded in each result and in `SHA256SUMS`.
- `token-counts.json` records the exact published and provider-serialized tool hashes used for token counting.
- `SHA256SUMS` verifies the stored files.
- `RAW-SHA256SUMS` verifies the byte stream produced by decompressing each result.
- `rollout-verification.md` records the local policy-consumer, package-loader, config-migration, and provider-smoke checks.

Absolute paths in result metadata identify the originating machine. They are not required for verification. The fixture hashes, tool-definition hashes, model selectors, Pi SDK entry, provider-extension hashes, limits, attempts, and effect traces are inside each result.

## Verify the archive

From this directory:

```bash
sha256sum --check SHA256SUMS
while read -r expected file; do
  actual=$(gzip -dc "$file" | sha256sum | cut -d' ' -f1)
  test "$actual" = "$expected" || exit 1
  printf '%s: decompressed bytes match\n' "$file"
done < RAW-SHA256SUMS
```

The loop verifies decompressed bytes against their original JSON hashes. It does not rewrite the artifacts.

To inspect a result without creating an uncompressed copy:

```bash
gzip -dc luna-heldout.json.gz | jq '.summary'
```

## Reproduce a matrix

Install dependencies in both revisions, then run the evaluator from the candidate:

```bash
npm run eval:catalog-models -- \
  --baseline-root /path/to/pi-subagents-at-54df154d \
  --candidate-root /path/to/pi-subagents-at-d080871f \
  --pi-sdk /path/to/@earendil-works/pi-coding-agent \
  --model 'openai-codex/gpt-5.6-luna:max' \
  --suite held-out \
  --repetitions 3 \
  --retry-cap 1 \
  --max-turns 8 \
  --timeout-ms 120000 \
  --max-output-tokens 6000 \
  --output /path/to/result.json
```

Provider availability, authentication, and responses can change. A reproduction should preserve every attempt and report infrastructure outcomes instead of forcing the historical pass count.
