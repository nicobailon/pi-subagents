---
name: codex-exec
description: Read-only one-shot analysis through the installed Codex CLI
runner:
  type: external-cli
  adapter: codex-exec
  command: codex
  promptDelivery: stdin
async: true
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Analyze the task in read-only mode. Return a concise final answer with evidence. Do not edit files or request wider access.
