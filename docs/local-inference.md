# Unbounded local inference

Local model requests can spend several minutes queued, prefilling a large context, or reasoning before returning response headers or the next token. Operators who deliberately allow these waits can enable an owner-level policy in `~/.pi/agent/extensions/subagent/config.json` (or the corresponding `PI_CODING_AGENT_DIR`):

```json
{ "localInference": { "enabled": true } }
```

Merge this into the existing configuration. The default remains disabled.

When enabled, native foreground and detached child sessions have no automatic execution or inference deadline. The policy takes precedence over run `timeoutMs`, `maxRuntimeMs`, agent defaults and inherited execution deadlines. Each child gets a dedicated proxy-aware HTTP dispatcher with header, body and connection clocks disabled. Pi's cancellation signal still reaches the request, including during streaming. The parent process's global dispatcher is unchanged.

This setting is an operator decision, not a model-controlled tool argument. Malformed policy fails explicitly. `subagent({ action: "doctor" })` reports the policy, and child session artifacts record `pi-subagents:local-inference-policy`.

## Scope and tradeoffs

The validated boundary is native OpenAI-compatible requests on npm Pi 0.85.1. The implementation depends on that runtime's per-request `fetch` seam. Other providers, standalone runtimes and external CLI HTTP clients require separate validation; this does not claim to disable their internal timers. Gateways and inference engines retain their own policies.

Manual stop and actual transport or server errors still terminate work. No new retry loop is introduced. A permanently stalled server with a healthy connection requires operator cancellation. Tool-command timeouts, control waits, verification and usage budgets retain their meanings. Model definitions, reasoning levels, context/output capacities and concurrency are untouched.

## Why both execution and transport policy are needed

The native detached runner's proxy dispatcher otherwise inherits Undici's 300,000 ms header/body defaults. A large Pi idle timeout or subagent execution timeout does not override those clocks. In an observed local inference incident, four requests in each failed lane were cancelled after approximately 301–302 seconds, with retry backoffs presenting as a roughly twenty-minute failure. The gateway recorded cancellation while those requests were still queued.

The child transport forwards the outer Pi cancellation signal instead of the provider SDK's separate timeout controller. This avoids substituting a large finite duration for an unlimited wait. An SDK timeout of zero is not assumed to mean unlimited; the custom transport is what removes the request clock.

## Regression checks

```sh
npm ci --ignore-scripts
npm run typecheck
npm run test:local-inference
node tools/check-local-inference.mjs /absolute/path/to/pi-coding-agent --long
```

The last command uses the real Pi CLI, public subagent tool, detached runner, native SDK and a local HTTP fixture. Parallel requests delay headers and streaming body for 310 seconds, while isolated Pi/run settings specify one-millisecond deadlines. Both must complete with exactly one request. It also checks foreground execution, operator stop, HTTP disconnection, observed runner exit and capacity release. Omit `--long` for a quick wiring check; it does not prove the five-minute boundary.

The fixtures use separate settings, placeholder credentials, sessions and runtime storage, and never contact production model servers. The harness watchdog applies only to the test process.
