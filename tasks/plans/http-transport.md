# HTTP Transport — Subagent Execution Plan

Spec: `tasks/specs/http-transport.md`

## Key findings from exploration

1. Only 3 functions across the entire codebase call `spawn()`: `execution.ts:runSingleAttempt()` (line 211), `async-execution.ts:spawnRunner()` (line 190), `subagent-runner.ts:runPiStreaming()` (line 229). All use `getPiSpawnCommand()` and JSONL-over-stdout.

2. The extension entry (`src/extension/index.ts`, 573 lines) is the hub — it imports from nearly everything. Rewriting it is the critical path. It registers the `"subagent"` tool via `pi.registerTool(tool)` and delegates execution to `createSubagentExecutor`.

3. `src/runs/foreground/subagent-executor.ts` (2528 lines) is the largest file and most entangled. It handles single/parallel/chain modes, management actions, async dispatch, resume, interrupt, intercom delivery, worktree setup, nested run routing, and fork context. The HTTP version replaces all of this with ~200 lines of HTTP client calls.

4. Files to KEEP untouched: `src/agents/` (all 7 files — agent discovery, config, management, skills), `src/shared/artifacts.ts`, `src/shared/formatters.ts`, `src/shared/settings.ts`. These are transport-agnostic and may be useful later.

5. Files to DELETE: `src/runs/` (19 files), `src/intercom/` (2 files), `src/tui/` (2 files), `src/slash/` (4 files), plus 8 individual files. Total: ~35 files, ~8800 lines.

6. The Pi extension API needs: `pi.registerTool(tool)` with a `ToolDefinition<TParams, TDetails>`. The tool's `execute(id, params, signal, onUpdate, ctx)` is async and returns `AgentToolResult<TDetails>`. The `@earendil-works/pi-tui` `Text` component suffices for basic result rendering.

7. `package.json` declares the extension entry at `pi.extensions: ["./src/extension/index.ts"]`. Pi discovers it via the `pi` field in package.json. The extension is loaded by jiti (TypeScript runtime).

8. The existing `ExtensionConfig` type in `src/shared/types.ts` (loaded from `~/.pi/agent/extensions/subagent/config.json`) is subprocess-specific. HTTP transport uses a new config at `~/.pi/agent/extensions/subagent-http/config.json`.

## Wave 1 — 2 parallel subagents

### W1-A: Create HTTP transport layer
- **Files:** `src/transport/types.ts`, `src/transport/config.ts`, `src/transport/http-client.ts`, `src/transport/job-tracker.ts` (all NEW)
- **Depends on:** none
- **Changes:** Create the 4-file transport layer:
  - `types.ts`: `AgentEndpoint`, `HttpConfig`, `InvokeRequest`, `InvokeResponse`, `StatusResponse`, `ResultResponse`, `RemoteRunState`, `RemoteRun` types
  - `config.ts`: `loadHttpConfig()` reads `~/.pi/agent/extensions/subagent-http/config.json`, `getAgent()`, `listAgents()`
  - `http-client.ts`: `invoke()` POSTs to `/invoke`, `getStatus()` GETs `/status/:runId`, `getResult()` GETs `/result/:runId`. Uses `fetch()` (Node 18+ built-in). Throws on non-OK responses with status code and body.
  - `job-tracker.ts`: `JobTracker` class with `track()`, `get()`, `getAll()`, `getActive()`, `pollAll()`, `stop()`. Background `setInterval` poller checks active runs, marks timeouts, fetches results on completion.

### W1-B: Rewrite extension schemas + config
- **Files:** `src/extension/schemas.ts`, `src/extension/config.ts` (both REWRITE)
- **Depends on:** none
- **Changes:**
  - `schemas.ts`: Replace the 168-line TypeBox schema with a simplified version. Keep: `agent`, `task`, `action` (enum: "list", "status"), `id`, `tasks` (parallel array). Remove: `chain`, `worktree`, `context` (fork), `async`, `clarify`, `share`, `sessionDir`, `agentScope`, `chainDir`, `chainName`, `config` (management CRUD), `control`, `skill`, `output`, `outputMode`, `runId`, `dir`, `index`, `message`, `artifacts`, `includeProgress`, `concurrency`. Add: `context` (optional string for additional context to send).
  - `config.ts`: Replace the 16-line config loader. Instead of loading `ExtensionConfig` from `~/.pi/agent/extensions/subagent/config.json`, import `loadHttpConfig` from `../transport/config.ts` and re-export. Keep the same export name `loadConfig()` but return `HttpConfig`.

## Wave 2 — 1 subagent

### W2-A: Rewrite extension entry point
- **Files:** `src/extension/index.ts` (REWRITE)
- **Depends on:** W1-A (transport layer), W1-B (schemas + config)
- **Changes:** Replace the 573-line entry with ~250 lines. The new extension:
  1. Imports: `SubagentHttpParams` from `./schemas.ts`, `loadConfig` from `./config.ts`, `invoke`/`getStatus`/`getResult` from `../transport/http-client.ts`, `getAgent`/`listAgents` from `../transport/config.ts`, `JobTracker` from `../transport/job-tracker.ts`, types from `../transport/types.ts`, `randomUUID` from `node:crypto`.
  2. Default export `registerSubagentHttpExtension(pi: ExtensionAPI)`:
     - Loads config via `loadConfig()`
     - Creates `JobTracker` instance
     - Registers tool named `"subagent"` with `SubagentHttpParams` schema
     - Tool description explains SINGLE, PARALLEL, and management modes
     - `execute()` routes by action:
       - `action: "list"` → returns agent names and URLs from config
       - `action: "status"` → looks up run by id, polls status via HTTP, returns state + progress
       - No action + `agent` + `task` → single delegation: `invoke()`, track run, return async started message
       - No action + `tasks` → parallel delegation: `invoke()` for each, track all, return summary
     - `renderCall()`: Shows "subagent <agent>" or "subagent list" etc using `Text` component
     - `renderResult()`: Shows result text using `Text` component
     - `session_shutdown` hook: `tracker.stop()`
  3. Does NOT import: anything from `src/runs/`, `src/intercom/`, `src/tui/`, `src/slash/`, `src/shared/fork-context.ts`, `src/shared/session-identity.ts`, `src/shared/types.ts`

## Wave 3 — 1 subagent

### W3-A: Delete old files + update metadata
- **Files:** Multiple deletions + `package.json` + `README.md`
- **Depends on:** W2-A (extension entry no longer imports old modules)
- **Changes:**
  1. Delete entire directories:
     - `src/runs/` (foreground/, background/, shared/ — 19 files)
     - `src/intercom/` (2 files)
     - `src/tui/` (2 files)
     - `src/slash/` (4 files)
  2. Delete individual files:
     - `src/extension/fanout-child.ts`
     - `src/extension/doctor.ts`
     - `src/extension/control-notices.ts`
     - `src/shared/fork-context.ts`
     - `src/shared/session-identity.ts`
     - `src/shared/session-tokens.ts`
     - `src/shared/post-exit-stdio-guard.ts`
     - `src/shared/jsonl-writer.ts`
     - `src/shared/file-coalescer.ts`
     - `src/shared/atomic-json.ts`
     - `src/shared/model-info.ts`
     - `src/shared/types.ts` (replaced by transport/types.ts)
     - `src/shared/utils.ts` (subprocess-specific)
     - `src/shared/settings.ts` (chain-specific, keep agents/ for future)
  3. Update `package.json`:
     - name: `"pi-subagents-http"`
     - description: updated for HTTP transport
     - Remove `@earendil-works/pi-tui` from dependencies (no TUI)
     - Remove `jiti` from dependencies (no TypeScript runner subprocess)
     - Keep `typebox` (used by schemas)
     - Keep peer dependencies (pi-agent-core, pi-ai, pi-coding-agent)
  4. Rewrite `README.md`: HTTP transport usage, config format, server-side contract

## Verification

After all waves:
```bash
# Extension entry resolves
node -e "import('./src/extension/index.ts')" 2>&1 | head -5

# No imports of deleted modules
grep -r "from.*\.\./runs/" src/extension/ src/transport/ || echo "OK: no runs imports"
grep -r "from.*\.\./intercom/" src/extension/ src/transport/ || echo "OK: no intercom imports"
grep -r "from.*\.\./tui/" src/extension/ src/transport/ || echo "OK: no tui imports"
grep -r "from.*\.\./slash/" src/extension/ src/transport/ || echo "OK: no slash imports"
grep -r "from.*fork-context" src/ || echo "OK: no fork-context imports"
grep -r "from.*session-identity" src/ || echo "OK: no session-identity imports"
grep -r "from.*pi-spawn" src/ || echo "OK: no pi-spawn imports"

# Transport layer exists
ls src/transport/types.ts src/transport/config.ts src/transport/http-client.ts src/transport/job-tracker.ts

# Old directories removed
test ! -d src/runs && echo "OK: runs removed"
test ! -d src/intercom && echo "OK: intercom removed"
test ! -d src/tui && echo "OK: tui removed"
test ! -d src/slash && echo "OK: slash removed"

# Package name updated
grep '"name".*pi-subagents-http' package.json && echo "OK: name updated"
```

## Subagent count: 4 (Wave 1: 2, Wave 2: 1, Wave 3: 1)
