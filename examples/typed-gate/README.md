# Typed gates and typed steps

Two ways to put a small classifier into a workflow without an LLM turn. `classify` is a keyword stand-in so the example runs with no API key; replace its `score` block with a real classifier and keep the stdin/JSON contract.

```
shape 1: typed gate                       shape 2: typed step
-------------------                       -------------------
reviewer ──► reports/review.md            runs.all(classifier × N)
                 |                              |
     gate: ./classify --report ...        stdin: task text
                 |                              |
     stdout JSON ──► result.structuredOutput    stdout JSON ──► result.output
                 |                              |
     script branches on .verdict          script JSON.parse()s and routes
```

Run it from this directory. The agent's `command: classify` is a PATH lookup (a relative path would resolve against the runner process, not the run cwd), so put the directory on PATH before starting Pi:

```bash
export PATH="$PWD:$PATH"
pi
```

```js
subagent({ workflowScriptPath: "workflow.js", agentScope: "both" })
```

The gate command (`./classify --report ...`) is a shell command run in the child's cwd, so it can stay relative.

What to look at afterwards:

- `review.structuredOutput` on the review child: the gate's parsed JSON, schema-validated.
- `acceptance.verifyRuns[0]` on the same child: `status: passed`, `structuredOutput`, and `stdout`.
- The classifier children: `output` is the raw JSON the script printed.

Rules that matter when you swap in a real classifier:

- A typed gate's stdout must be one JSON document under 12,000 characters. Anything else fails the gate, which fails the run; the verdict is never silently dropped.
- Typed gates are not memoized, so a changed report is always re-graded.
- `gate.output: "json"` cannot be combined with `outputSchema`.
- Command-runner agents are async-only and receive only the assembled prompt on stdin, never a forked transcript.
- Keep any credentials in the environment or a file the script reads; never in the agent file or the workflow script (both are persisted with run evidence).
