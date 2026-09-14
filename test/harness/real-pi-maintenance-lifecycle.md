# Real Pi maintenance lifecycle probe

This no-framework probe runs the official Pi host lifecycle around one explicit pi-subagents source tree. It asserts that the three extension-owned maintenance timers are absent after factory-only loading, present after startup, replaced by a real `AgentSession.reload()`, and cleared by normal `AgentSessionRuntime.dispose()` shutdown. An empty host control runs first. No prompt or provider request is made.

```sh
PI_CODING_AGENT_TEST_ROOT=/path/to/@earendil-works/pi-coding-agent \
node --experimental-strip-types test/harness/real-pi-maintenance-lifecycle.mjs \
  --source-root /path/to/pi-subagents-source \
  --expected-source-ref <ref-or-snapshot-label> \
  --output-root /outside/source/evidence/run-1
```

Use a fresh process and output directory for every run. `--source-root` may be a symlink; the probe canonicalizes it before loading, hashing, and callsite attribution. For a frozen baseline, export the requested ref into a temporary directory and, if needed, add a read-only `node_modules` symlink to the working tree's already-installed dependencies; do not install into the snapshot. Run this same harness file with that directory as `--source-root`. A baseline contract failure must be the factory-only timer assertion, not a loader error.

`result.json` records Pi/Node/platform identity, source hashes before and after, sanitized offline environment evidence, lifecycle entrypoints and trace, extension errors, phase counts, callsite-attributed timer IDs, delays, types, ref state (`hasRef`), fires, and clears. The process exits nonzero after writing evidence when an assertion fails.

## Limits

- Pinned to official Pi 0.85.1 and the current three known maintenance callsites/delays; it is a P3 lifecycle proof, not a general timer leak detector.
- Timer wrappers preserve Node scheduling, clear, and `unref()` behavior while wrapping callbacks only to observe natural firing. Attribution requires both the source callsite and expected timer type/delay; unrelated Pi timers are excluded.
- `--expected-source-ref` is recorded as supplied. Source identity is independently represented by the extension and complete TypeScript-tree SHA-256 values; exported archives do not contain Git metadata.
- The external caller owns a bounded process deadline and preservation of stdout/stderr and snapshot-integrity evidence.
