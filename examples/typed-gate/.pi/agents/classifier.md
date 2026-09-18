---
name: classifier
description: Typed classification of the task text (no LLM turn)
runner:
  type: external-cli
  command: classify
  args: [--stdin, --json]
  promptDelivery: stdin
async: true
systemPromptMode: replace
inheritProjectContext: false
inheritGlobalContext: false
inheritSkills: false
---
