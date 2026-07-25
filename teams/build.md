---
name: build
description: Implementation writer plus independent review and read-only validation, for post-approval work that benefits from a second and third set of eyes
goal: Deliver the approved change with evidence, one writer only
members:
  - agent: worker
    role: writer
    exclusive: true
  - agent: reviewer
    role: reviewer
    context: fresh
    task: >-
      Read-only review of the writer's change. Do not edit. Report findings with
      evidence, most severe first.
  - agent: scout
    role: validator
    context: fresh
    toolBudget: { soft: 25, hard: 40 }
    task: >-
      Read-only. Confirm the change is actually present and that the stated
      validation commands exist and are wired up. Do not edit.
concurrency: 3
---

The writer owns every edit in this run; reviewer and validator are read-only and
must not modify files. Post findings to the team board rather than duplicating
them in your final summary, and claim a path before editing it.

Escalate product and architecture decisions to the parent with
`contact_supervisor` rather than deciding them on the team's behalf.
