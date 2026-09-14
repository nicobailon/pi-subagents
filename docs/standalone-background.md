# Standalone background execution

Supported standalone target: **official Pi 0.85.1, Linux x64**. Keep its adjacent release assets with the executable. Other versions, operating systems, architectures and packagers are outside the fully validated support target; limited experimental Windows coverage is described below.

Pi's extension loader supplies its embedded SDK to `binary-bootstrap.ts`, which awaits the existing configured runner before exiting. Startup authorization, revival leases, controls, disposal and process-close observation remain shared with npm. Each independent run has its own host; native sessions inside that run share it. No per-session CLI protocol, runtime download/install, alternate SDK or foreground fallback is introduced. Npm Pi keeps its Node runner, peer aliases and detected npm `PI_PACKAGE_DIR` override (including refusal when no npm root exists).

Implementation and lifecycle fixtures derive from [@xz-dev](https://github.com/xz-dev)'s [PR #2049](https://github.com/nicobailon/pi-subagents/pull/2049), source commit `910807bfefcf9ee41d73fa25ec86dcd75ab8f4b2` (Xiangzhe, `xiangzhedev@gmail.com`). Integration retains the lifecycle contract and reduces commentary rather than removing its evidence gates.

## Experimental Windows host recognition

The resolver recognizes Bun's Windows virtual entrypoint prefixes, `B:/~BUN/` and `B:\~BUN\`, alongside `/$bunfs/`. It launches the real `process.execPath` (or the existing executable override). The `B:` prefix is virtual, not the installation drive; `pi-native.exe` is not a required executable name.

A local Windows x64 smoke passed with **xz-dev/pi `0.85.1-xz.169.1.gb5f4d0ff`, Bun 1.4.2**: a fresh async worker executed a read-only Git command, returned its result, delivered the native completion notification, and exited with code 0 and no remaining runner process. This is not validation of the official Windows distribution or every Bun-compiled Pi host. Windows remains **experimental**: the full standalone lifecycle matrix has not been validated there.

Node-hosted npm Pi keeps its existing runner path and is not affected by this virtual-entrypoint detection defect. Installing only the pi-subagents extension through npm does not change a Bun-compiled Pi host into an npm Pi host.

## Official binary gate

On Linux x64 with Node, npm, tar and bubblewrap installed, provision dependencies and the checksum-pinned release separately from execution:

```bash
npm ci --ignore-scripts
release_dir="$(mktemp -d)"
url="$(node -p 'require("./test/smoke/standalone-release.json").url')"
sha="$(node -p 'require("./test/smoke/standalone-release.json").archiveSha256')"
curl --fail --location --retry 3 "$url" --output "$release_dir/release.tar.gz"
printf '%s  %s\n' "$sha" "$release_dir/release.tar.gz" | sha256sum --check -
tar -xzf "$release_dir/release.tar.gz" -C "$release_dir"
node test/smoke/standalone-matrix.mjs "$release_dir/pi/pi" "$(mktemp -d)/matrix"
```

The `official-standalone` CI job runs this gate. Both archive and executable hashes are pinned. Each of 18 modes gets a fresh stage with no filesystem core SDK/shim, empty installation caches and isolated network/PID namespaces. Bare-Bun SDK import must fail; accepted execution uses Pi's actual loader. Missing sandbox support fails rather than skips. Use disk-backed storage: retained stages can occupy several GiB.

The matrix covers public launch/notification, workflows, same-run concurrent sessions, parallel stop, targeted steer/interrupt, child/tool/run deadlines, missing bootstrap, post-spawn persistence/authorization failures, SDK initialization failure, malformed bootstrap input/EOF with an authorized positive control, and competing revival. The provider is deterministic, but SDK sessions, runner and public extension are real. Only startup-failure writes are faulted.

`matrix.json` records complete/partial results; `inputs.json` freezes source identities and every mode must use the same package hash. Inspect per-mode logs, `identity.json`, lifecycle/notification evidence, `status.json` and `process-terminal.json`. A persisted result is not exit proof: the gate separately awaits observed close, verifies dead PIDs before sandbox teardown and checks session shutdown/lease release. CI retains receipts and at most 32 MiB compressed lifecycle evidence. Contributor-head passes do not establish acceptance for a different integration snapshot.

For a focused diagnostic, use `node test/smoke/standalone-background.mjs "$release_dir/pi/pi" "$(mktemp -d)/check" bootstrap-errors` (or another matrix mode). A focused pass is not the complete gate.

## Npm regressions and local trial

Existing npm clean-install CI covers real SDK 0.85.1. The standalone CI job also checks the public npm launch path without execution-time network:

```bash
npm_checks="$(mktemp -d)"
node test/smoke/clean-install.mjs "$npm_checks/sdk" 0.85.1
node test/smoke/npm-background.mjs "$npm_checks/sdk" "$npm_checks/launch"
```

To try a checkout without replacing your installation, start a separate supported Pi process with an isolated agent directory:

```bash
PI_CODING_AGENT_DIR="$(mktemp -d)" "$release_dir/pi/pi" \
  --no-extensions --no-skills --no-prompt-templates --extension "$PWD/index.ts"
```

This command targets a source checkout. The published npm package uses the compiled `index.js` entry instead.

Configure a provider in that isolated session, ask for a read-only background child and inspect its notification/run artifacts. This loads only the checkout for that process; it does not install the candidate or reuse normal credentials. Keep the parent alive for notifications.
