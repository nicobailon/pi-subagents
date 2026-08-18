# Fix Pi session runtime identity cleanup

## Goal

Allow several independent Pi `AgentSession` instances to load `pi-subagents` in one Node process without one instance running another instance's reload cleanup. Keep cleanup for a real reload of one `AgentSession`.

## Root cause

`registerSubagentExtension()` stores one cleanup callback in `globalThis.__piSubagentRuntimeCleanup`. Every new extension registration runs that callback. The callback belongs to the previously registered instance and sets its `state.currentSessionId` to `null`. A later headless `agent_end` in that first instance calls `drainOutstandingWork()`, which rejects the missing session identity.

The extension also stores event unsubscribers and the visible-control-notice set as process-wide singletons. A second independent instance can therefore unsubscribe the first instance's event handlers or share notice state with it.

## Design

1. Replace the three process-wide singleton values with one registry stored on `globalThis`. The registry uses a `WeakMap` keyed by the `ctx.sessionManager` object received at `session_start`, plus a set of currently active entries for the process-wide shutdown guards.
2. Use the session manager as the runtime key because one Pi `AgentSession` keeps it across extension reloads, while independent `AgentSession` instances have different managers. A new extension API object is not a stable reload key.
3. Build one runtime entry per extension registration. At `session_start`, look up the session-manager key. Clean a prior entry only when it has the same key, then install the new entry. Never clean, unsubscribe, or reuse state from another key.
4. Transfer the prior entry's visible-control-notice set to the replacement entry before cleanup. Do not share that set between different session-manager keys.
5. Use one complete, idempotent cleanup function for both reload replacement and `session_shutdown`. It must dispose every runtime-owned timer, watcher, notifier, watchdog, scheduled-run manager, supervisor channel, wait-subscription manager, fleet view, async-job tracker, event subscription, cleanup timer, slash bridge, and prompt-template bridge.
6. Track the installed entry in the closure. On `session_shutdown`, remove a registry entry only when the key still points to that entry. A stale shutdown may clean its own idempotent resources, but it must not remove or dispose the replacement entry.
7. Guard process-wide shutdown effects. Capture the shutting-down session ID before cleanup. Delete `PI_SUBAGENT_PARENT_SESSION` only when its value still equals that ID. Remove the shutting-down entry from the active-entry set, and clear module-wide slash snapshots only when that set is empty.
8. Keep the hard auto-drain error when `agent_end` has no active session identity. Swallowing or guarding that error would hide a lifecycle defect and could skip real work.
9. Keep current auto-drain, execution, acceptance, mission, and workflow logic unchanged.

The installed Pi 0.81 implementation calls `emitSessionShutdownEvent(oldRunner, reason: "reload")`, invalidates the old runner, builds the new extension runtime, and then emits `session_start(reason: "reload")`. The same `AgentSession` retains its session manager through that sequence. Binding replacement at `session_start` also protects a compatible host that omits the old shutdown event but reuses the same session manager.

## Tests

1. Add a regression test through the public extension registration boundary:
   - Create two independent fake Pi APIs and contexts in one Node process.
   - Give them different session-manager objects, event buses, and lifecycle-handler maps.
   - Start the first session.
   - Register and start the second session.
   - Assert the first runtime still receives an async-complete event after the second registration.
   - Await the first session's headless `agent_end` handler.
   - Prove the handler completes without the missing-session-identity error.
2. Run the new regression test against the old implementation first. Confirm that it fails because the first runtime lost its session identity.
3. Update the reload-cleanup test to model Pi reload:
   - Use two extension API objects and lifecycle-handler maps.
   - Reuse one session-manager object and one underlying event bus.
   - Start the replacement with reason `reload`.
   - Prove old notification timers and event subscriptions are canceled.
   - Prove the new notifier sends exactly one message.
4. Add a shutdown cleanup test that tracks intervals. Prove `session_shutdown` disposes the wait-subscription interval before a different runtime starts.
5. Add stale and independent shutdown checks. Prove an old reload handler and an independent session shutdown cannot remove the live runtime's event subscriptions, session identity, or parent-session environment value.
6. If slash snapshots can be observed through the public renderer without a production test hook, prove one session's shutdown does not clear another active session's snapshot. Otherwise, keep the active-runtime guard covered through the public shutdown behavior and document this small test gap.
7. Do not add a production-only test hook or assert private registry structure.

## Validation

Run these commands from the repository root:

```text
node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs --test test/unit/index-child-registration.test.ts
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
```

Record pass, fail, and skip counts. If an unrelated test fails, reproduce it once and report the exact failure without weakening the test.

## Delivery

1. Commit the approved plan before implementation and record that clean commit as the implementation review base.
2. Use one implementation worker as the only source-code writer.
3. Run one implementation review-panel round after the worker completes. Apply required findings with the same worker, then run focused validation and inspect the final diff.
4. Add one entry under `CHANGELOG.md` → `Unreleased` → `Fixed`.
5. Push `fix/session-runtime-identity` to `ryanbbrown/pi-subagents`.
6. Update `/Users/ryanbrown/code/dotfiles/home/.pi/agent/settings.json` to use the fork at the exact final source commit. Keep this local configuration change out of the upstream pull request.
7. Open a pull request from `ryanbbrown:fix/session-runtime-identity` to `nicobailon:main`. Include the root cause, behavior change, tests, and remaining risk. Do not merge it.

## Residual risk

- `PI_SUBAGENT_PARENT_SESSION` is a process-wide compatibility fallback and cannot represent several active parent sessions at the same instant. Current launch paths pass the owning parent session explicitly. This change prevents one shutdown from deleting another session's value but does not redesign the fallback.
- Pi lifecycle handlers registered with `pi.on()` have no unsubscribe API. The supported reload shape creates a new extension API and runner, so the old runner owns the old handlers. Re-registering twice on the exact same API object remains unsupported.
