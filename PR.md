# fix: layer project agentOverrides on top of user overrides for custom agents

Branch: `fix/custom-agent-override-merge-and-extensions-warning`
Base: `main` @ `a4bd0fc` (0.53.0)

## Why

I hit this while chasing why a set of reviewer subagents kept running on
`gpt-5.5` instead of the model I'd pinned per-agent (`cliproxyapi/claude-opus-4-8`),
and separately kept failing to start at all with a `subagent_wait` tool
conflict. Tracked both down to the same area of `agents.ts`.

## What's actually broken

**1. A project-scope override for a custom agent replaces the user-scope
override for that agent, instead of layering on top of it.**

If an agent gets its model pin from `~/.pi/agent/settings.json` (user scope),
and a project's `.pi/settings.json` adds an override for the *same agent
name* for something unrelated — say, `subagentOnlyExtensions` — the project
override doesn't add to the user override. It replaces it. Every field the
project override didn't mention (model, thinking, fallbackModels) just
disappears. No error, no warning. The agent quietly falls back to
`subagents.defaultModel`, and if that combines with a thinking suffix the
provider doesn't like, you get invalid model ids too.

This is in `applyCustomAgentOverrides`:

```ts
// before
return agents.map((agent) => {
    const projectOverride = projectSettings.overrides[agent.name];
    if (projectOverride && projectSettingsPath) {
        return applyCustomAgentOverride(agent, projectOverride, { scope: "project", path: projectSettingsPath });
    }
    const userOverride = userSettings.overrides[agent.name];
    if (userOverride) {
        return applyCustomAgentOverride(agent, userOverride, { scope: "user", path: userSettingsPath });
    }
    return agent;
});
```

Whichever scope has an entry wins outright, applied to the raw base agent.
The other scope's entry for the same name never gets consulted at all.

**Fix:** apply the user override first, then apply the project override on
top of that already-user-overridden agent, both through the same
per-field `applyCustomAgentOverride` helper that already exists (it only
fills fields actually present in the override it's handed, and already
correctly defers to the agent's own frontmatter). Per-field precedence
doesn't change — if both scopes set the same field, project still wins,
since it's applied last. What changes is that a field set at *only one*
scope now survives instead of getting wiped out because the other scope
happened to also touch that agent name.

**2. Fixing #1 exposed a second bug in the same function: `disabled` was
handled differently from every other field, and that difference bites once
you have two overrides running in sequence.**

Every field in `applyCustomAgentOverride` goes through a `fill()` helper
that unconditionally applies the override value. `disabled` didn't — it had
its own inline check:

```ts
// before, only field with this shape
if (override.disabled !== undefined && agent.disabled === undefined) {
    mutable().disabled = override.disabled;
    anyFilled = true;
}
```

On `main` this never mattered, because this function only ever ran once per
agent, against the untouched base agent — and custom agents have no
frontmatter field for `disabled`, so `agent.disabled` going in was always
`undefined`. The guard was there but it never actually gated anything.

Once I made the function run twice (user override, then project override
on top), that changed. If the user override sets `disabled`, then by the
time the project override runs, `agent.disabled` is no longer `undefined` —
so the guard now silently blocks the project override from ever touching
`disabled`. Which breaks the exact rule I'd just built: project is supposed
to win.

Caught this while re-checking my own diff against the test cases rather than
trusting it because it typechecked. Fixed by dropping the guard so it works
like every other field — unconditional, matching how `applyBuiltinOverride`
already handles `disabled` for builtin agents. Added a two-way test (user
disables + project re-enables, and the reverse) and confirmed it actually
fails against the pre-fix code before confirming it passes after.

**3. Separate, smaller issue: `extensions: []` on an agent override reads
like "add nothing," but it actually disables every ambient extension for
that child.**

`disableAmbientExtensions` triggers whenever `extensions` is *defined at
all* — including an empty array. So if you set `extensions: []` on an agent
(which I did, originally to work around the `subagent_wait` conflict
mentioned above), you don't just skip adding extra extensions — you strip
out everything ambient, including whatever provider extension the child
needed to resolve a model id like `cliproxyapi/claude-opus-4-8`. There's no
error pointing back at the override that caused it; the model just silently
fails to resolve downstream.

Added a `warnings: string[]` field to `resolvePiLaunchToolPlan`'s return,
and a `console.warn` when this specific case happens (empty array, not
forced by a capability ceiling). Non-empty extension lists don't trigger it —
only the "defined but empty" case, which is the one nobody means to write.

```
[pi-subagents] extensions: [] override for agent 'scratch-persona' disables ALL
ambient extensions for this child (not just "adds nothing"), including any
model-provider extension needed to resolve a provider-qualified model. List
the extensions this child actually needs instead of an empty array.
```

**Update from review:** the first version of this logged from inside
`resolvePiLaunchToolPlan` directly, which sounded right until someone
pointed out that function runs more than once per launch — once inside
`buildPiArgs` to actually build the child's args, and again separately by
the caller (in `execution.ts` and `subagent-runner.ts`) just to compute
launch metadata like the contract digest, plus a third context where
`preflight.ts` calls it purely to validate config without launching
anything. That meant one real launch logged the warning twice, and a pure
preflight check logged it with nothing actually happening. Moved the
logging out of `resolvePiLaunchToolPlan` (it now only returns `warnings`,
no side effects) and into `buildPiArgs` itself, which is the one place
that's unambiguously about to build args for a real spawn. Added tests that
replicate the actual double-call shape (`buildPiArgs` then a direct
`resolvePiLaunchToolPlan` call on the same input) to make sure it logs
exactly once, not zero or two times.

## What I didn't touch, and why

`applyBuiltinOverrides` has the exact same project-XOR-user pattern that #1
fixes for custom agents. I left it alone. It also handles bulk-disable
(`disableBuiltins`) and global thinking-disable (`disableThinking`) through
the same branches, and layering it correctly means getting the combined-flag
logic right across both scopes for those two settings too. I didn't want to
guess at what the intended interaction there should be — flagging it
separately rather than baking in an assumption.

## Where this sits relative to #218

#218 is what added `applyCustomAgentOverride`/`applyCustomAgentOverrides` in
the first place, and it explicitly frames project-over-user as the intended
precedence rule. This PR doesn't change that — project still wins when both
scopes set the same field. It just fixes the part that was never actually
about precedence: a project override touching *different* fields than the
user override shouldn't erase the user override's fields.

I checked for existing issues covering the `extensions: []` behavior before
writing this up — didn't find one. Closest was #1014, which is a different
scenario (a git worktree auto-discovering a duplicate extension), not an
explicit empty-array override.

## Testing

- `npm run typecheck` — clean.
- `npm run test:unit` — 2320 passed, 0 failed, 3 pre-existing skips (full
  suite, not just the files I touched).
- New tests:
  - `agent-overrides.test.ts`: layering test that reproduces the real
    scenario — user-scope model/thinking/fallbackModels, project-scope
    `subagentOnlyExtensions` on the same agent name — and asserts both sets
    of fields survive.
  - `agent-overrides.test.ts`: two-directional `disabled` conflict test.
    I ran this against the pre-fix code specifically to make sure it fails
    there (it does — the agent silently disappears from `discoverAgents`'s
    output because it stays disabled when it should have been re-enabled)
    before trusting that it passes after the fix.
  - `pi-args.test.ts`: `resolvePiLaunchToolPlan` reports the warning in
    `plan.warnings` but never logs by itself; doesn't report anything when
    `extensions` is omitted or non-empty; `buildPiArgs` logs exactly once on
    `extensions: []` and never logs when extensions are omitted; and a test
    that calls `buildPiArgs` then `resolvePiLaunchToolPlan` again on the
    same input (the real double-call shape from `execution.ts` /
    `subagent-runner.ts`) and checks the log only happened once.
- All pre-existing override-precedence tests pass unmodified, including the
  one that checks project overrides winning over user overrides when both
  set the *same* fields (the merge fix is a no-op there, as it should be).

## Manual check against a real `pi` process

Ran this against an actual `pi` CLI process pointed at this branch's
checkout instead of the installed npm package (not just node's test
runner):

1. Dispatched a real reviewer agent with a user-scope model pin and no
   project override — correct model came back, exit 0, no regression from
   before this branch existed.
2. Dispatched a scratch agent with a project-scope `extensions: []` entry —
   the warning fired on stderr, word for word what's in the code above, and
   exactly once (checked this specifically after fixing the double-log
   issue above, by grepping the actual stdout for how many times the string
   showed up, not just that it showed up).

## Files changed

- `src/agents/agents.ts` — the layering fix, plus the `disabled` fix.
- `src/runs/shared/pi-args.ts` — `warnings` field + the `extensions: []`
  diagnostic, logged once from `buildPiArgs` instead of from inside
  `resolvePiLaunchToolPlan`.
- `test/unit/agent-overrides.test.ts` — regression tests for both fixes.
- `test/unit/pi-args.test.ts` — tests for the warning, plus the once-only
  double-call test.
- `CHANGELOG.md` — Unreleased entry crediting this PR.

## Breaking changes

None that I can see. The only agents affected are ones that had entries in
*both* user and project `agentOverrides` for the same name, with different
fields set (or `disabled` set to different values) at each scope. In every
case, what changes is that a field which used to get silently dropped now
applies — which is what anyone setting that override actually wanted.
