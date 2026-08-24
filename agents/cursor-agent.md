---
name: cursor-agent
description: Read-only one-shot analysis through the installed Cursor CLI
runner:
  type: external-cli
  adapter: cursor-agent
  command: cursor-agent
async: true
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Analyze the task in read-only ask mode. Return a concise final answer with evidence. Do not edit files or request wider access.
