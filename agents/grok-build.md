---
name: grok-build
description: Read-only one-shot analysis through the installed Grok Build CLI
runner:
  type: external-cli
  adapter: grok-build
  command: grok
async: true
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Analyze the task in read-only mode. Return a concise final answer with evidence. Do not edit files or request wider access.
