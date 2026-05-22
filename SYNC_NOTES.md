# StartupBros sync notes

Last updated: 2026-05-22

## Baseline

This local checkout dogfoods `pi-subagents` from `/home/will/SITES/pi-subagents` and tracks upstream `nicobailon/pi-subagents`.

- Upstream remote: `upstream` (`git@github.com:nicobailon/pi-subagents.git`)
- Current upstream baseline: `upstream/main` / tag `v0.25.0` (`86326d7`)
- Primary fork remote: `origin` (`git@github.com:StartupBros/pi-subagents.git`)

Future resyncs should start from upstream, then re-apply only the local deltas below.

## Local deltas to preserve

Keep these changes unless upstream grows equivalent behavior:

1. Child extension sandbox default
   - Config key: `defaultChildExtensions`
   - Omitted / `"inherit"`: child Pi processes load normal extensions
   - `[]` / `"none"`: child Pi processes load only the subagent runtime helper
   - String array: allowlist specific child-safe extensions
   - Local machine config uses `[]` to keep headless child runs from loading every global extension.

2. Local Pi package alignment
   - Keep package imports on the `@earendil-works/*` scope.
   - Keep dogfood dev dependencies aligned with the locally installed Pi version when practical.
   - `doctor_packages` must keep passing for live dogfooding.

## No longer preserved

- `managerCommand` / `/agents` manager renaming was removed from the local delta. Upstream trimmed the old manager overlay, `pi-side-agents` is no longer installed locally, and the active Nico-style commands are `/run`, `/chain`, `/parallel`, `/run-chain`, and `/subagents-doctor` plus the `subagent` tool.

## Verification checklist

Run these after every resync:

```bash
cd /home/will/SITES/pi-subagents
npm run test:all
node --experimental-strip-types --input-type=module -e "import('./src/extension/index.ts').then(() => console.log('extension import ok'))"
```

Then from any Pi session using the local path package:

```bash
python3 - <<'PY'
import json, pathlib
settings = json.loads(pathlib.Path('/home/will/.pi/agent/settings.json').read_text())
config = json.loads(pathlib.Path('/home/will/.pi/agent/extensions/subagent/config.json').read_text())
assert '/home/will/SITES/pi-subagents' in settings.get('packages', [])
assert config.get('defaultChildExtensions') == []
print('local Pi subagents config ok')
PY
```

Also run Pi package health:

```bash
# Via Pi tool/harness: doctor_packages(fix=false)
```

Expected result: package health passes, local Pi uses this checkout, and child subagents respect `defaultChildExtensions: []`.

## Manual smoke tests

Use an interactive Pi session after restarting or `/reload` so the edited package is reloaded:

- `/run scout "summarize this repo briefly"` works.
- `/parallel reviewer "review current diff" -> reviewer "look for test gaps"` works on a small safe diff.
- `subagent({ action: "doctor" })` or `/subagents-doctor` reports a healthy setup.
- A child run with no agent-level `extensions` does not inherit all global extensions when `defaultChildExtensions` is `[]`.
