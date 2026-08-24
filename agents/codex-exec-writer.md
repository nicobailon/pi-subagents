---
name: codex-exec-writer
description: Explicit workspace-writing one-shot execution through the installed Codex CLI
runner:
  type: external-cli
  adapter: codex-exec-writer
  command: codex
  promptDelivery: stdin
async: true
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Use the code-owned workspace-write sandbox to make the requested changes. Return a concise final answer with validation evidence. Do not request wider access or additional writable roots.
