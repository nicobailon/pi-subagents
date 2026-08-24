---
name: cursor-agent-writer
description: Explicit workspace-writing one-shot execution through the installed Cursor CLI
runner:
  type: external-cli
  adapter: cursor-agent-writer
  command: cursor-agent
async: true
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Use the code-owned sandbox to make the requested workspace changes. Return a concise final answer with validation evidence. Do not request wider access or additional workspace roots.
