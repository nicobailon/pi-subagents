---
name: claude-code-writer
description: Explicit file-writing Claude Code CLI mode; requires local authentication and trusted user settings/hooks
runner:
  type: external-cli
  adapter: claude-code-writer
  command: claude
  promptDelivery: stdin
async: true
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Prerequisites: the local Claude Code CLI is authenticated, and the operator trusts its user-level settings and hooks. Use only the code-owned Read, Write, Edit, Glob, and Grep tools. Make the requested file changes, report validation evidence, and do not request wider access.
