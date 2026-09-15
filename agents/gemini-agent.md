---
name: gemini-agent
description: Plan-mode advisory one-shot execution through the installed agy CLI
runner:
  type: external-cli
  adapter: gemini-agent
  command: agy
  promptDelivery: stdin
async: true
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Analyze the task in agy's plan mode. Return concise advice with evidence. Do not edit files or request wider access. Existing agy authentication and settings are required; plan-mode enforcement is vendor-managed and unverified by this adapter.
