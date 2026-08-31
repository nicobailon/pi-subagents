# Vision

## What pi-subagents is

pi-subagents lets one Pi session delegate focused work to child agents with supervision, evidence, and control.
It serves a single Pi operator first: one person who wants more leverage from one session without losing control of what runs in their name.
It stays flexible enough for other people and other workflows, but it does not redesign itself around them.
It owns the Pi delegation layer: child launch contracts, workflow orchestration, supervision, observability, and result handoff.

## One parent, many focused children

The parent session stays the orchestrator and the decision maker.
Each child gets a clear task, a bounded contract, and a defined way to hand its result back.
Complex semi-autonomous work, such as repository backlog maintenance or several unrelated tasks running in parallel worktrees, composes from these same parts.
Those workflows are capabilities the system must support well, not the product identity.

## Authority comes from clarity

Authority is moderate, not maximal in either direction.
When user intent and policy are clear, safe routine authority can be inferred without a fresh ask.
A blocked child can ask its supervisor to unblock it before interrupting the user.
User and project instructions can tighten or loosen this authority, and the system respects both directions.

## Evidence closes work

A child saying it is done is not enough.
Completion needs evidence: concrete outputs, changed files where change was expected, validation results, or an explicit blocked state.
When behavior cannot be proven, the system fails closed instead of reporting optimistic success.

## Compose before inventing

Existing primitives come first.
A new mode, runner, or abstraction is justified only when current primitives cannot honestly express the needed behavior.

## Compatibility is explicit

Default to hard cutovers when replacing a tool, option, behavior, or public surface.
Do not keep aliases, migration shims, legacy code paths, or compatibility modes unless the owner asks for them or the release contract requires them.
Compatibility has a cost: extra docs, tests, status text, support paths, and future ambiguity.
When that cost is not deliberately accepted, remove the old path cleanly and make the new contract obvious.

Tests should prove the current contract.
Do not add defensive tests that preserve removed behavior, stale migration paths, or compatibility the project no longer wants.
For removals, update or delete obsolete assertions instead of making production code serve them.

## Scope must earn size

Pull requests should be narrow enough to review with confidence.
A large diff is a warning sign, not proof of rigor.
Size is acceptable only when the issue, design, and owner approval justify it.

Broad changes need approval before they expand across launch paths, public APIs, persistence, or runner lifecycle code.
When a proposal touches those surfaces without that approval, the right response is adversarial review and reduction.
Each PR should prove one clear invariant and stop before it turns into a framework.

## Performance is a product constraint

Delegation must stay fast enough that one parent session can keep several children moving without the operator waiting on the tool.
Status, progress, watchers, TUI refresh, filesystem scans, and orchestration setup are hot paths.
Token cost is part of the same constraint: extra context, extra children, and extra layers have to earn their keep.
A change that makes those paths slower needs proof or explicit owner approval.
Unmeasured risk in a hot path is a reason to refuse the change.

## Background work stays visible

Work that runs out of sight must never disappear.
Status views, FleetView, and run artifacts exist so the operator can always see and inspect running work, and steer or stop it when the runner supports those controls.
They are safety infrastructure for delegation, not the product itself.

## External agents earn trust

Agents that are not Pi children are welcome inside workflows.
Over time this points toward a vendor-neutral adapter layer for external CLIs and other harnesses.
Today, external agents must be honest: they declare their real capabilities, receive a deliberate handoff instead of pretended native context, and fail closed when behavior is not proven.
A passing demo is not a capability contract.

## What this project refuses

It does not become a general project manager or issue tracker.
It does not own CI, merge policy, or release policy; it reports evidence into those systems.
It does not add integrations for niche tools without clear demand.
It does not treat external agents as native Pi children before their capabilities are proven.
It does not run background reviewers on every edit by default; delegation happens because the operator asked for it, directly or through their instructions.
It does not accept a slower status loop, watcher, or common workflow just to make the machinery look richer.

## How to judge a change

A change fits when it gives one operator more leverage with the same or better control, visibility, and evidence.
A change fits when it composes from existing primitives or honestly shows why it cannot.
A change fits when it keeps or improves speed and token cost, or proves why a cost is worth paying.
A change does not fit when it adds hot-path cost without proof, hides running work, accepts confidence in place of evidence, widens authority beyond the operator's instructions, or grows scope toward general project management.
When a proposal is in doubt, ask whether it makes delegation more trustworthy for the person whose name it runs under.
