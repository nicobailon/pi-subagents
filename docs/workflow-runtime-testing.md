# Native Bun workflow cache regression

Some Windows standalone Pi builds (reproduced with Pi 1.4.0 / embedded Bun 1.3.14)
abort on a **warm** runtime transpiler-cache hit for an anonymous eval worker:
`cannot resolve DirInfo for non-absolute path:`. A cold start can succeed, so a
single successful launch is not sufficient evidence. Clearing the cache only
hides the next warm-cache failure.

The worker source lives in `workflow-script-worker.cjs`, shipped in both source
and built packages. Bun starts that file directly to retain an absolute resolver
base. Node reads and memoizes the same source for its existing eval worker:
changing Node to a file worker would re-resolve inherited `--import` preloads
after cwd changes. The VM, message protocol and workflow execution are unchanged.

## Run the native gate

Prerequisites: dependencies installed, Node with native TypeScript stripping, and
an already installed **Bun-compiled standalone Pi**. No provider credentials or
real child/model call is needed. The probe loads the workflow engine as an
explicit test extension in an isolated offline profile.

PowerShell:

```powershell
$env:PI_SUBAGENTS_WORKFLOW_BUN_SMOKE_BINARY = '<standalone-pi.exe>'
node --experimental-strip-types --test test/integration/workflow-bun-cache.test.ts
```

To test built package assets too:

```powershell
npm run build:pkg
$env:PI_SUBAGENTS_WORKFLOW_BUN_SMOKE_PACKAGE_ROOT = (Resolve-Path ./dist-pkg).Path
node --experimental-strip-types --test test/integration/workflow-bun-cache.test.ts test/integration/workflow-bun-package.test.ts
```

`workflow-bun-package.test.ts` resolves the extension from the package manifest,
loads its bundled production entrypoint, and requires terminal async workflow
success on each cold/warm/repeated-warm process. It does not invoke a model.
For a distribution check, unpack the npm tarball into a different directory
(preferably a path with spaces), provide that package's dependencies, and set
`PI_SUBAGENTS_WORKFLOW_BUN_SMOKE_PACKAGE_ROOT` to the unpacked package. Do not
mistake reusing an existing dependency tree for a clean locked dependency install.

Unset `PI_SUBAGENTS_WORKFLOW_BUN_SMOKE_PACKAGE_ROOT` to return to source testing.
Without `PI_SUBAGENTS_WORKFLOW_BUN_SMOKE_BINARY`, the native cases are explicitly
skipped; that is **not** a native regression pass. A Node-based Pi executable is
rejected, not accepted as Bun coverage.

For each scenario the test creates a private cache, explicitly **enables** it,
and starts separate cold, warm and repeated-warm Pi processes. It requires the
exact workflow output and exit code zero each time. Scenarios cover a constant
return and a mocked child-result round trip. The fixture profiles/caches are
removed after the case and subprocesses have bounded timeouts. No shared cache
or live profile is modified.

Run the regular `scripted-workflow.test.ts` cases as well: they protect Node
preload/cwd handling, VM restrictions, argument isolation, child observation,
abort/timeout behavior, and serialization. The native fixture is runtime plumbing
coverage, not proof of real-model reasoning, authentication, TUI rendering or live
service correctness.
