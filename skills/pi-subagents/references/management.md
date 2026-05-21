## Management Mode

The `subagent(...)` tool also supports management actions.

### List available agents and chains

```typescript
subagent({ action: "list" })
```

### Create an agent

```typescript
subagent({
  action: "create",
  config: {
    name: "my-agent",
    package: "code-analysis",
    description: "Project-specific implementation helper",
    systemPrompt: "Your system prompt here.",
    systemPromptMode: "replace",
    model: "openai-codex/gpt-5.4",
    tools: "read,grep,find,ls,bash"
  }
})
```

### Update an agent

```typescript
subagent({
  action: "update",
  agent: "code-analysis.my-agent",
  config: {
    thinking: "high"
  }
})
```

### Delete an agent

```typescript
subagent({ action: "delete", agent: "code-analysis.my-agent" })
```

Use management actions when the system needs to create or edit subagents on
demand without dropping into raw file editing.

Management actions create or update user/project agent files. `config.name` is the local frontmatter name; optional `config.package` registers and looks up the runtime name as `{package}.{name}`. Use the dotted runtime name for `get`, `update`, `delete`, slash commands, and chain steps. For small builtin changes such as a model swap, prefer `subagents.agentOverrides` in settings.

## Creating and Editing Agents by File

A minimal agent file looks like this:

```markdown
---
name: my-agent
package: code-analysis
description: What this agent does
model: openai-codex/gpt-5.4
thinking: high
tools: read, grep, find, ls, bash
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Your system prompt here.
```

That is only a starting point. Omit `package` for the traditional unqualified runtime name. Common optional fields include:
- `defaultProgress`
- `defaultReads`
- `output`
- `fallbackModels`
- `maxSubagentDepth`

For many customizations, builtin overrides in settings are lower-friction than
copying a full builtin file.
