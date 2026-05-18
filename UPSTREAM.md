# Upstream fork notes

This fork of [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) carries one patch series, `fanout-children`, that re-enables subagent dispatch for child agents whose own `tools` declaration includes `subagent`. The strict child boundary remains the default for every other child.

## Why the fork exists

pi-subagents 0.24.3 unconditionally:

1. Skips registering the `subagent` tool in any child process (`src/extension/index.ts` early return).
2. Prepends `CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS` to every child's system prompt, including the clause "Do not propose or run subagents."
3. Strips all `subagent` tool-call blocks and tool-result messages from inherited history (`stripParentOnlySubagentMessages`).

Together these three sites make it impossible for any child subagent to run its own fanout, even if the agent definition explicitly declares the `subagent` tool. This blocks the canonical use of agents like `wave-review-orchestrator`, whose entire role is to dispatch persona and toolkit reviewers in parallel.

Upstream maintenance has paused, so the fix lives here instead.

## What the `fanout-children` branch changes

The branch adds a new env var, `PI_SUBAGENT_FANOUT_CHILD`, set by the parent in `buildPiArgs` whenever the child agent's `tools` list includes `subagent`. Three sites consult that env:

| Site | Old behavior | New behavior |
| --- | --- | --- |
| `src/runs/shared/pi-args.ts` | sets `PI_SUBAGENT_CHILD=1` on every child | also sets `PI_SUBAGENT_FANOUT_CHILD=1` when `tools` declares `subagent` |
| `src/extension/index.ts` (early return) | returns for any child | returns only when `PI_SUBAGENT_FANOUT_CHILD` is not set |
| `src/runs/shared/subagent-prompt-runtime.ts` (`rewriteSubagentPrompt`) | always prepends the strict boundary text | injects a softer fanout-aware boundary text for fanout children, strict text otherwise. Also drops any inherited copy of the other boundary so a polluted history does not contradict the child's permission. |
| `src/runs/shared/subagent-prompt-runtime.ts` (`stripParentOnlySubagentMessages`) | strips every inherited `subagent` tool call and tool result | strips them only for non-fanout children. Always strips parent-only custom message types (`subagent-notify`, control notices, slash result) for both. |

The softer fanout boundary text is at `CHILD_FANOUT_BOUNDARY_INSTRUCTIONS` in `subagent-prompt-runtime.ts`. It keeps the load-bearing framing (you are a child, parent owns final orchestration, do not propose dispatching agents you were not granted) and drops only the unconditional "do not propose or run subagents" clause.

The `maxSubagentDepth` cap in `pi-subagents/src/shared/types.ts` is untouched and continues to bound global recursion.

## Test coverage added

Three new test cases in `test/unit/index-child-registration.test.ts` and `test/unit/pi-args.test.ts`, five new cases in `test/unit/subagent-prompt-runtime.test.ts`. All exercise the env-gated behavior so a future upstream sync that diverges from this contract will surface as a test failure.

Full suite: 387 tests, 0 failing on the `fanout-children` branch.

## Resync procedure

When upstream releases a new version:

```sh
cd ~/work/pi-subagents-fork
git fetch upstream
git log v0.24.3..upstream/main --oneline      # see what's new
git checkout fanout-children
git rebase upstream/main                      # bring patches forward
# resolve conflicts (touchpoints are tiny: 4 hunks across 3 files)
git push --force-with-lease origin fanout-children
npm run test:unit                             # verify
```

The three patch hunks are intentionally minimal so conflicts are rare. If the upstream author later accepts a PR that addresses this same constraint, drop the branch and switch the `packages` entry in `~/pi-dotfiles/settings.json` back to `"npm:pi-subagents"`.

## Install path

`~/pi-dotfiles/settings.json` packages entry:

```json
"git+https://github.com/longweekendprojects/pi-subagents.git#fanout-children"
```

Pi resolves this via its `parseGitUrl` branch in the package manager. The install lands under `~/.pi/agent/git/` (or equivalent) and pi loads `src/extension/index.ts` as the registered extension per the package's `pi.extensions` manifest.
