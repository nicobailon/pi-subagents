# Project guide

## Commands

- `npm run test:unit` — unit suite.
- `npm run test:integration` — integration suite.
- `npm run test:e2e` — end-to-end suite.
- `npm run test:all` — all suites; run the narrowest relevant command first.

## Navigation

- `src/extension/` registers the Pi extension and tool schemas.
- `src/runs/foreground/` executes foreground child runs; `src/runs/background/` owns detached runs, persisted status, and result delivery.
- `src/shared/` holds cross-run types and formatting helpers.
- `agents/`, `skills/`, and `prompts/` are packaged agent assets; `test/unit/`, `test/integration/`, and `test/e2e/` mirror test scope.

## Change discipline

Keep changes focused. Update the nearest matching tests with behavior changes, preserve public/persisted status compatibility, and run the relevant npm test command before handoff. Do not edit generated `.pi-subagents/` or `.pi/todos/` data.

## Durable agent notes

Start at [`.agents/README.md`](.agents/README.md). It indexes implementation and benchmark notes that are useful across sessions.

The repository is indexed in `codebase-memory-mcp` as `pi-subagents`. Use that index for graph-based architecture, symbol, call-path, and code searches when helpful; refresh it after substantial code changes.
