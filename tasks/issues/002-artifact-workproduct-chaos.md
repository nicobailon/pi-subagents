# Issue #002: Artifact organization and workproduct format breakdown

## Observed

From M0.1 test run 4 and artifact service catalog, three distinct problems:

### 1. Everything under `no-run/` — no run correlation

All 12 artifacts from the test have `run_id: null`, landing at paths like:
```
default/default/no-run/researcher/research/01KSSGZXHS...
default/default/no-run/writer/brief/01KSSHCYXQ...
```

When the orchestrator delegates via pi-subagents-http, the server.mjs generates a `traceId` (used as runId internally) but this is never propagated to the artifact extension inside the Pi agent session. The artifact `write_artifact` tool defaults to `run_id: null` → S3 key uses `no-run/`.

Result: impossible to tell which artifacts belong to which orchestrator delegation. Multiple runs pile into the same `no-run/` namespace.

**Root cause:** `correlationId` sent in POST /invoke body is stored in the run record but never injected into the Pi session's environment or context where the artifact extension could read it. The artifact extension looks for `PAPERCLIP_RUN_ID` or similar env var that's set per-request in the Paperclip adapter but absent in the pi-subagents-http flow.

**Fix:** server.mjs should set a `RUN_ID` env var (or pass it into the session context) derived from the correlationId or traceId. The artifact extension uses this to namespace artifacts under `{company}/{project}/{runId}/{agent}/{type}/`.

### 2. Researcher outputs markdown prose, not structured JSONL findings

Expected per M0.1 spec: "Researcher writes structured findings using workproduct/findings system (ADMIRALTY-graded, JSONL-persisted)."

Actual: researcher wrote 6 markdown files (`brief`, `research`, `dataset` types) with prose content. No JSONL findings. No ADMIRALTY grading. No `record_finding` tool calls. The workproduct extension is loaded (it's in the extensions list) but the researcher agent prompt doesn't enforce using it for this task type.

Artifacts created by researcher:
```
brief/faceless-instagram-research-2026-05-29.md          (2.5KB)
brief/faceless-tiktok-channel-research.md                (14KB)
brief/faceless-instagram-research.md                     (5.8KB)
brief/tiktok-research-summary.md                         (8KB)
brief/instagram-research-summary.md                      (5.6KB)
dataset/instagram-faceless-channels.json                  (9.4KB)  ← structured but not findings format
dataset/tiktok-faceless-channels.json                     (12KB)  ← structured but not findings format
dataset/faceless-tiktok-channel-analysis.md               (16KB)  ← markdown, not dataset
research/faceless-instagram-channel-analysis.md           (20KB)
research/faceless-tiktok-account-research.md              (13KB)
```

The `.json` datasets are closest to structured output but use a custom schema, not the workproduct findings format (ULID, ADMIRALTY grade, source references, confidence level).

**Root cause:** The orchestrator prompt says "find 5 accounts" not "use record_finding to produce structured findings for each account." The researcher falls back to its default behavior (write markdown). The workproduct extension is available but not invoked unless the task explicitly asks for structured findings or the agent's system prompt mandates it.

**Fix two-layer:**
1. Orchestrator should include workproduct instructions in delegation task when structured output is needed
2. Agent system prompts should default to structured findings for research tasks (already supposed to be the case per agent config, but not enforced in pi-subagents-http flow since Paperclip behavioral skills aren't loaded)

### 3. Writer creates inconsistent document types

Writer produced artifacts under multiple types without consistency:
```
brief/faceless-social-media-cross-platform-report.md     (18KB)
research/faceless-social-media-analysis-report.md         (25KB)
```

Same writer, same task category, different `artifact_type` values (`brief` vs `research`). The `write_artifact` tool lets the agent choose the type freely. No enforcement of "final deliverable = report type" convention.

Also: researcher used `brief` for summaries and `research` for deep analysis, but also put a markdown file under `dataset` type. The type taxonomy is agent's freestyle choice.

**Root cause:** `artifact_type` in `write_artifact` is a free string field. No schema enforcement, no conventions enforced by the extension. Each agent picks whatever seems right per call.

**Fix:** Either constrain `artifact_type` to an enum in the artifact extension, or establish conventions in agent system prompts and validate post-hoc.

## Impact

- Cannot correlate artifacts to orchestrator runs (blocks debugging, auditing, billing)
- Research output is not machine-consumable (blocks downstream structured pipelines)
- Document type inconsistency makes programmatic artifact retrieval unreliable

## Proposed Fixes (priority order)

### P0: Run ID propagation
Server.mjs passes `correlationId` or `traceId` into the Pi session so artifact extension can use it as `run_id`. Simplest path: set `process.env.RUN_ID = traceId` before creating the session, or pass it as session metadata.

### P1: Structured findings enforcement
When the orchestrator needs structured output, task prompt should include: "Use record_finding for each data point. Include source URLs, confidence level, ADMIRALTY grade." The SKILL.md should document this pattern.

### P2: Artifact type conventions
Document and enforce: `research` for raw findings, `dataset` for structured data, `report` for final deliverables, `brief` for summaries. Either validate in the extension or in the agent system prompt.

## Related

- M0.1 success criteria: "Researcher writes structured findings using workproduct/findings system"
- M0.1 success criteria: "Artifacts stored at standardized paths under /artifacts/{agent}/"
- Issue #001: polling loop (fixed — blocking delegation now works)
