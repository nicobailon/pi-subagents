## Error Handling

**"Unknown agent"**
```typescript
subagent({ action: "list" })
// Check available agents and chains, then confirm scope/precedence.
```

**Setup, discovery, or intercom confusion**
```typescript
subagent({ action: "doctor" })
// Check runtime paths, async support, discovery counts, current session, and intercom bridge state.
```

**"Max subagent depth exceeded"**
```typescript
// Flatten the workflow or raise maxSubagentDepth in config.
```

**"Session manager did not return a session file"**
```typescript
// Persist the current session before using context: "fork".
```

**Intercom "Already waiting for a reply"**
```typescript
// Resolve the current outbound ask before starting another one.
```

**Parallel output-path conflict**
```typescript
// Give each parallel task a distinct output path, or disable output for tasks that do not need it.
```

**Worktree launch fails**
```typescript
// Ensure the git working tree is clean and task cwd overrides match the shared cwd.
```

**Child fails before starting**
```typescript
// Inspect `subagent({ action: "status", id: "..." })`, artifact metadata/output logs, and run doctor. Extension loader errors usually appear in child output logs.
```
