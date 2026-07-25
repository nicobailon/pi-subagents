# Proposal: Agent Teams

Status: draft / request for comment
Author: Nick Pagel (Pagel56)
Target: `pi-subagents`

## Summary

Add a first-class **team** primitive: a named, reusable group of agents with a
shared goal, a shared scratch space, and a single fleet identity — so a
multi-agent effort can be launched, observed, steered, and stopped as one unit.

Today the closest thing is a chain with `parallel` groups. Chains are excellent
at *one-pass orchestration* but they are not a team: they are anonymous, they
describe a fixed graph rather than a durable roster, and their members cannot see
or address each other.

## Motivation

Chains already cover most static orchestration well, and this proposal does not
seek to replace them. The gap shows up in three recurring shapes:

1. **Reusable rosters.** A "build team" (implementation writer + reviewer +
   validator) gets re-declared inline in every chain that needs it. There is no
   `team: build` to reference, so the roster is copy-pasted and drifts.
2. **Peer awareness.** Chain steps communicate only by passing `outputs` forward.
   A reviewer cannot ask the writer a question, and two parallel writers cannot
   discover that they are about to collide. `contact_supervisor` routes *up* to
   the parent; there is no sideways channel.
3. **One identity for the whole effort.** `/subagents-fleet` shows a flat list of
   children. When eight children belong to one logical effort, there is no way to
   collapse, address, or stop them as a group — and no shared place for them to
   accumulate findings.

## Non-goals

- Not a replacement for chains. A team is a *roster + shared state*; a chain
  remains the way to express ordering. Teams should be usable **inside** a chain.
- Not autonomous peer delegation. Members still may not spawn arbitrary
  subagents; child-safety depth and spawn budgets continue to apply unchanged.
- Not a consensus or voting mechanism. The parent remains the decision authority.
- Not a new sandbox. `tools` stays a strict allowlist; team membership grants no
  additional tool authority.

## Design

### Team definition

Teams live beside agents, discovered the same way (`~/.pi/agent/teams/*.md`,
package `teams/`, project `.pi/teams/`), with frontmatter:

```yaml
---
name: build
description: Implementation writer plus independent review and validation
goal: Ship the parent-approved plan with evidence, one writer only
members:
  - agent: terra
    role: writer
    exclusive: true          # at most one writer role active at a time
  - agent: reviewer
    role: reviewer
    context: fresh
  - agent: scout
    role: validator
    toolBudget: { soft: 25, hard: 40 }
concurrency: 3
sharedDir: true              # provision a team scratch dir
---

Optional prose appended to every member's runtime instructions: shared
conventions, what "done" means for this team, escalation etiquette.
```

`role` is a label the team contract understands, not a new permission tier.
`exclusive: true` is the one-writer invariant made declarative and machine-checked
rather than restated in prose in every agent file.

### Invocation

```js
subagent({ team: "build", task: "...", async: true })
```

Resolution reuses the existing executor end to end: agent discovery, model
resolution and fallback, spawn-budget preflight, artifacts, and async status all
behave exactly as they do for `tasks`. A team launch is a `parallel` group with a
roster, a shared directory, and a team id attached — not a new runner.

Inside a chain, a step may name a team instead of an agent:

```js
{ chain: [ { team: "build", phase: "Implementation" },
           { agent: "oracle", task: "Adjudicate {outputs.build}" } ] }
```

### Shared state

When `sharedDir: true`, the runner provisions
`<asyncDir>/team-<teamId>/` at mode `0700` and passes it to every member as
`PI_TEAM_DIR`, with `board.md` (append-only findings) and `claims.json`
(path-ownership claims).

Members get one new tool, `team_note`, available only to team members:

| action | effect |
|---|---|
| `post` | append a timestamped, attributed entry to `board.md` |
| `read` | read the board (optionally `since`) |
| `claim` | record intended path ownership in `claims.json`; fails on conflict |

`claim` is the cheap fix for parallel-writer collisions: a writer claims
`src/auth/**` before editing, and a second writer's overlapping claim fails fast
with the owner's identity instead of producing a merge conflict later. It is
advisory bookkeeping, not a filesystem lock, and should be documented as such —
`session-lease.ts` already establishes the precedent for cross-process claims
with provable staleness reclamation, and `claims.json` should reuse that
atomic-write and stale-owner logic rather than inventing its own.

Peer messaging deliberately routes through the board rather than a direct
member-to-member channel. A shared append-only log is inspectable after the fact,
cannot deadlock, and needs no delivery guarantees — whereas direct peer messaging
would require presence, retry, and blocking-read semantics that duplicate the
intercom broker for little gain. `contact_supervisor` remains the only upward
path.

### Fleet integration

`fleet-view.ts` gains one grouping level: members render nested under a team row
showing name, goal, per-role state, aggregate token/cost, and the last three board
entries. Existing keybindings are unchanged; `Enter` on a team row expands it.

`subagent({ action: "status", view: "fleet" })` gains a `teams[]` projection
alongside the current flat list, so the textual fallback and any external
consumer keep working. `stop` accepts a team id and stops every member through
the existing stop control channel, recording one `subagent.team.stopped`
lifecycle event.

## Implementation sketch

Roughly additive; the heavy runtime already exists.

| Area | Work |
|---|---|
| `src/agents/teams.ts` (new) | discovery, frontmatter parse, roster validation |
| `src/extension/schemas.ts` | accept `team` on the tool + chain steps |
| `src/runs/shared/team-board.ts` (new) | `board.md` / `claims.json`, atomic writes |
| `src/runs/shared/parallel-utils.ts` | attach team id + shared dir to the group |
| `src/runs/shared/workflow-graph.ts` | represent a team node in the graph |
| `src/runs/background/fleet-view.ts` | one grouping level |
| `src/runs/background/control-channel.ts` | team-scoped stop/steer fan-out |
| `src/runs/shared/subagent-prompt-runtime.ts` | register `team_note` for members |

New lifecycle events: `subagent.team.started`, `.member.started`,
`.member.completed`, `.stopped`, `.completed` — additive, and unknown event types
are already required to be ignored by consumers.

## Risks and open questions

- **Ceremony creep.** A team is easy to over-apply. The docs should state plainly
  that two agents and a handoff is a chain, not a team; teams earn their keep at
  three or more members with shared state.
- **Board as a prompt-bloat vector.** An unbounded `board.md` re-read by every
  member each turn will dominate context. It needs a hard cap (last N entries or
  a byte budget) with `since`-based incremental reads, mirroring the existing
  4 MiB child-protocol line bound.
- **`exclusive` enforcement point.** Cleanest at preflight (reject a roster with
  two active exclusive writers) rather than at runtime, consistent with how
  static chains already fail before creating run artifacts when declared capacity
  cannot fit.
- **Advisory claims will be misread as locks.** Needs explicit documentation and
  probably a warning when a claim is ignored.
- **Does `role` need to affect acceptance inference?** `acceptanceRole` already
  exists for the read-only/writer distinction. `role` should probably *feed*
  `acceptanceRole` rather than become a second parallel concept.

## Alternatives considered

- **Chain macros / includes.** Solves roster reuse only; no shared state, no
  peer awareness, no team identity in the fleet. Cheaper, and worth doing anyway
  if teams are rejected.
- **Teams as a pure prompt convention.** Zero code, but nothing is enforced —
  no collision detection, no grouped stop, no fleet grouping. This is effectively
  the status quo.
- **Full peer-to-peer messaging via the intercom broker.** More capable and much
  more complex: presence, retry, deadlock avoidance, and a real risk of agents
  talking to each other instead of finishing. The board is the 80% at 20% cost.
