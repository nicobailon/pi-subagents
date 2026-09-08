# Standalone background execution

Native background children work through the SDK supplied by their Pi host. Npm Pi keeps the detached Node runner and host peer aliases. A supported Bun-compiled Pi instead loads `src/runs/background/binary-bootstrap.ts` through Pi's extension loader and supplies its embedded SDK to the existing configured runner.

## Tested boundary

| Host | Verification |
| --- | --- |
| Official `earendil-works/pi` v0.85.1, Linux x64 binary | Complete 18-mode isolated lifecycle matrix |
| Npm Pi 0.85.0 and 0.85.1 | Real SDK/default-factory smoke, real public background launch, and existing Node regressions |

The binary harness currently requires Linux x64, bubblewrap, Node, npm, tar and ordinary system libraries. Keep the official release's adjacent assets with its executable. The smoke copies those assets; a binary missing its theme or other initialization resources is not an equivalent test environment.

Other operating systems, architectures, Deno, Node SEA and other packagers are not covered by this standalone claim. Repository CI pins the official release only. No extra runner setting or separate Pi SDK installation is needed for the binary path.

Each independent detached run retains its own host. Workflow children that were separate runs remain separate. Multiple native sessions **inside one run** share its configured runner and host; there is no cross-run process pool or per-session CLI/stdout protocol.

## Run the complete binary gate

Run these commands from a source checkout. Dependency installation and release download are provisioning steps, separate from sandboxed execution:

```bash
npm ci --ignore-scripts
release_dir="$(mktemp -d)"
url="$(node -p 'require("./test/smoke/standalone-release.json").url')"
sha="$(node -p 'require("./test/smoke/standalone-release.json").archiveSha256')"
curl --fail --location --retry 3 "$url" --output "$release_dir/release.tar.gz"
printf '%s  %s\n' "$sha" "$release_dir/release.tar.gz" | sha256sum --check -
tar -xzf "$release_dir/release.tar.gz" -C "$release_dir"
artifacts="$(mktemp -d)/matrix"
node test/smoke/standalone-matrix.mjs "$release_dir/pi/pi" "$artifacts"
```

Install bubblewrap through your platform's package manager if it is absent. Namespace creation must be permitted; an unavailable sandbox fails the gate rather than skipping tests. The harness reads the system dynamic-loader cache where present, so glibc can locate libraries such as `libgcc_s` when workflow threads exit. It does not mount operator configuration or another Pi SDK.

The matrix checks the pinned binary hash, records execution-input hashes, creates fresh stages for all 18 modes and requires every stage to use the same package SHA256. Each stage has fresh home/config/install caches and isolated network/PID namespaces. A separate bare-runtime import must fail, and no filesystem SDK/shim or populated Bun installation cache may appear. `BUN_BE_BUN=1` is used only for that negative control, never to execute accepted child work.

The modes cover single and mixed workflows; multiple sessions in one run; parallel stop; targeted steer/interrupt; child, tool and run deadlines; missing bootstrap; post-spawn persistence/authorization failure; SDK resource initialization failure; bootstrap input/EOF errors with an authorized positive control; and competing revival with handshake and lease-release checks.

The provider is deterministic, but the public tool, Pi SDK, session factory and configured runner are real. Only targeted filesystem writes are faulted for startup-error cases. An installed observer and a real positive control establish that the task could execute. Test file-state checkpoints do not synthesize completion notifications: those still arrive through the real parent's `sendMessage` boundary.

Inspect:

- `matrix.json`: complete/partial receipt, per-mode exit codes and package identity.
- `inputs.json`: frozen execution inputs. Do not combine passes from different snapshots.
- `<mode>/identity.json`, `parent.log`, `lifecycle.jsonl` and notification evidence.
- `<mode>/tmp/**/status.json` and `process-terminal.json`: logical state versus observed process exit.
- Revival and shared-run witnesses in their mode directories.

A persisted result is not exit proof. The tests separately await the close observation, verify the runner PID no longer exists **before sandbox teardown**, and check SDK shutdown hooks. Failed attempts remain evidence, not passing receipts. The CI job runs this same matrix command and retains selected lifecycle evidence with a 32 MiB compressed limit, separately from the input/receipt files; an overflow fails the job.

For one focused diagnostic, use a fresh directory:

```bash
node test/smoke/standalone-background.mjs "$release_dir/pi/pi" "$(mktemp -d)/revival" revival
```

A focused pass is not the complete gate. Stages are retained for inspection and can occupy several GiB; choose a disk-backed artifact directory rather than a small RAM-backed `/tmp`.

## Npm regression checks

Keep npm SDK installs separate from binary stages:

```bash
npm run typecheck
npm test
npm run test:integration

npm_checks="$(mktemp -d)"
node test/smoke/pi085-clean-install.mjs "$npm_checks/sdk-0.85.0" 0.85.0
node test/smoke/pi085-clean-install.mjs "$npm_checks/sdk-0.85.1" 0.85.1
node test/smoke/npm-background.mjs "$npm_checks/sdk-0.85.0" "$npm_checks/launch-0.85.0"
node test/smoke/npm-background.mjs "$npm_checks/sdk-0.85.1" "$npm_checks/launch-0.85.1"
```

The first pair provisions clean real SDK installs and verifies the default factory and host peer aliases. The second pair reuses those installs, with no network during execution, to verify the real npm CLI → public subagent tool → detached Node runner → SDK session → normal notification and observed exit. It also requires Linux/bubblewrap. The existing Bun workflow parity command remains in `.github/workflows/test.yml`.

## Try the local candidate without replacing an installation

From the candidate checkout with its npm dependencies installed, start a separate official Pi process with an isolated agent directory:

```bash
trial_state="$(mktemp -d)"
PI_CODING_AGENT_DIR="$trial_state" "$release_dir/pi/pi" \
  --no-extensions --no-skills --no-prompt-templates \
  --extension "$PWD/index.ts"
```

Authenticate/configure a provider in that trial session, or explicitly load the provider extension it needs. The isolated directory intentionally does not reuse your normal login/configuration. Ask it to run a read-only agent in the background, then inspect its notification and run evidence. This command loads the checkout only for the new process: it does not install the candidate, alter the existing extension checkout, or switch another running session. Keep that process alive for notifications; shutting down the parent is not a validation of child cleanup.
