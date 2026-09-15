---
name: gemini-agent-writer
description: Accept-edits intent one-shot execution through the installed agy CLI
runner:
  type: external-cli
  adapter: gemini-agent-writer
  command: agy
  promptDelivery: stdin
async: true
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Use agy's accept-edits mode to make requested changes in the current workspace. Return concise validation evidence. Do not request wider access. Existing agy authentication, settings, and appropriate `permissions.allow` rules are required because headless agy cannot prompt for command permissions. This adapter never uses `--dangerously-skip-permissions`; without those rules, runs fail closed and no write is claimed. Sandbox and accept-edits enforcement remain vendor-managed and unverified.
