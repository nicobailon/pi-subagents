# Rollout verification

Date: 2026-09-07
Candidate: `d080871fb7a9fb2b807014064b2f091bf367b11c`
Pi: 0.85.1 under Node 24.16.0

## Structural scout ledger

A fresh CodeGraph build of the rollout checkout indexed 599 files, 27,238 symbols, and 57,713 edges with graph quality 92/100. The catalog registration seam remains in `src/extension/index.ts` and `src/extension/fanout-child.ts`; canonical execution remains behind `src/extension/public-execution.ts`, the foreground/background runners, and the existing RPC transport. This rollout commit adds evidence only and does not move those seams.

## Source interpretation ledger

- The selected desktop settings still pin `npm:pi-subagents@0.65.1`.
- The active configured extension roots were scanned for files containing both `tool_call` handling and `subagent` argument use. No active external permission hook classifies the old flat subagent arguments.
- The installed `pi-subagents` child permission gate classifies tool names, not the parent catalog envelope.
- The excluded `pi-messenger` extension records activity and reserves `edit`/`write` paths; it does not inspect subagent arguments.
- The excluded `cursor-subagents` extension registers a different tool named `subagent`; it is not a policy hook and would conflict if enabled alongside this package.
- The old `pi-interactive-subagents` checkout is not selected by the current Pi settings.
- Updated third-party policy consumers should use `parseSubagentCatalogCall` and `SubagentCatalogCallCandidate` from `pi-subagents/command-catalog`. Legacy hooks that read root-level fields remain a rollout constraint.

## Proof and manual-check ledger

### Evidence archive

- All archived gzip files passed `gzip -t`.
- `SHA256SUMS` verifies every stored artifact.
- Decompressing each result reproduces the original `/tmp` JSON or JSONL hash in `RAW-SHA256SUMS`.
- All six evaluator JSON files parsed as result version 3 and retained every attempt.
- A recursive scan of the evaluator results and provider-smoke events found no nonempty authorization, API-key, access-token, refresh-token, password, secret, or cookie fields and no recognized key, bearer-token, private-key, GitHub-token, or AWS-key formats.

### Branch validation

The rollout checkout passed these local gates after the catalog implementation and evidence archive were present:

- `npm run typecheck`
- 3,047 of 3,061 unit tests, with 14 expected skips and no failures
- 1,003 of 1,009 integration tests, with 6 expected skips and no failures
- Oxfmt on the changed Markdown and JSON files
- `git diff --check`
- `npm pack --dry-run`, which reported package version 0.66.0, 317 entries, and no `test/eval/results` files
- AIslop with zero errors and warnings for the `d080871f...HEAD` change
- slop-scan with 217 findings on both the clean `d080871f` worktree and the rollout checkout, with no added, resolved, worsened, or improved code findings

AIslop skipped its format and lint engines for this documentation-and-artifact change. slop-scan reported no changed code path because it does not scan the added Markdown and gzip artifacts. The explicit Oxfmt, hash, archive, and credential checks cover those files.

### Isolated package installation

The production `pi install` command installed the local checkout into `/tmp/pi-subagents-catalog-rollout-agent`. `pi list` resolved it back to the checkout path.

A production CLI registration probe produced these discriminating results:

1. No extension config: startup succeeded and registered `subagent` and `bg_wait`.
2. A copy of the current live config containing `toolDescriptionMode: "compact"`: startup exited 1 before registration with the intended `RemovedConfigError` message.
3. The same config with only `toolDescriptionMode` deleted: startup succeeded, registered `subagent`, and exposed the catalog schema with one required `action`, 58 action values, and optional `input`.

The before/after configs were normalized and compared to prove that the isolated migration deleted only the removed key.

### Provider acceptance smoke

A fresh, no-session CLI run loaded the installed local package and selected `openai-codex/gpt-5.6-luna:max`. Built-in tools, context files, skills, prompts, themes, and every extension tool except `subagent` were disabled.

The model made exactly one call:

```json
{ "action": "help", "input": { "topic": "overview" } }
```

The call returned the catalog overview without error. The model then returned `CATALOG_SMOKE_OK`. No child, workflow, host, schedule, control, shell, or filesystem effect was attempted or produced. The two provider turns used 2,704 total tokens and reported a combined cost of USD 0.0006128. The complete JSON event stream is preserved as `luna-provider-smoke.jsonl.gz`.

### Live synchronization checks

The first `pi-sync check` found an explicit empty yadm `local.hostname`. The documented host-selection contract requires that override to match the physical short hostname, so local yadm metadata was corrected to `desktop`. This changed no tracked file, selected settings path, or package entry.

The next checks produced:

- `pi-sync check`: 138 profile/configuration tests passed and one failed because the dirty desktop settings no longer include the expected local llama model.
- `pi-resource-check.sh`: no missing required extension or skill and no extension load errors; the command exited 1 for the pre-existing `writing-pr` skill name diagnostic.
- Production CLI probe: passed under Node 24.16.0 with in-memory SQLite and the Recall tool registered.

These are current-host configuration results. They do not replace the isolated candidate registration and provider checks above.

### Live migration status

Live candidate migration has not run. A pre-mutation guard found 24 current-user Pi processes, so the exact config migration refused before changing `/home/will/.pi/agent/extensions/subagent/config.json`.

The yadm checkout also contains unrelated working changes in:

- `.agents/skills/CLASSIFICATIONS.md`
- `.agents/skills/invocation-policy-map.html`
- `.pi/agent/settings.json##hostname.desktop`

The selected settings change is an unrelated default-model preference; the `pi-subagents` package entry remains `npm:pi-subagents@0.65.1`. This evidence pass did not stage, commit, revert, or overwrite any of those files.

Before a live candidate install:

1. Close the other Pi sessions.
2. Back up and delete only `toolDescriptionMode` from `~/.pi/agent/extensions/subagent/config.json`.
3. Keep the shared package pin on 0.65.1 until a portable candidate release exists. Do not commit a machine-local worktree path or a nonexistent 0.66.0 package.
4. After publication, update the tracked desktop settings variant through the locked dotfiles workflow, preserving the unrelated default-model edit.
5. Run `pi-sync check`, `pi-resource-check.sh`, the CLI probe, and a fresh interactive help call on each target host.

## Result

The package-loader, removed-setting migration, current provider, and local policy-consumer checks are ready for review. Live installation and cross-host synchronization remain deliberately blocked; the current package and settings were left in place. Only the empty local yadm hostname metadata was corrected to `desktop`.
