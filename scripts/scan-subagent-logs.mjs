#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
const defaultRoot = path.join(os.tmpdir(), `pi-subagents-uid-${uid}`, "async-subagent-runs");
const defaultState = path.join(os.homedir(), ".cache", "pi-subagents-log-scan.json");

const args = process.argv.slice(2);
const opts = {
  root: process.env.PI_SUBAGENTS_ASYNC_DIR || defaultRoot,
  state: process.env.PI_SUBAGENTS_SCAN_STATE || defaultState,
  sinceMs: 24 * 60 * 60 * 1000,
  all: false,
  json: false,
  noState: false,
  includeTests: false,
  includeOutput: false,
  run: undefined,
};

function usage(exitCode = 0) {
  console.log(`Usage: node scripts/scan-subagent-logs.mjs [options]\n\nScan pi-subagents async run logs for new failures, attention events, stale-run repairs, and suspicious output.\n\nOptions:\n  --root <dir>       Async runs dir (default: ${defaultRoot})\n  --run <id|prefix>  Scan only one run id/prefix\n  --since <duration> Only scan runs updated in this window (default: 24h). Examples: 30m, 6h, 2d\n  --all              Report already-seen issues too\n  --no-state         Do not read/write the seen-issues state file\n  --state <file>     Seen-issues state file (default: ${defaultState})\n  --include-tests    Include test/debug runs whose ids start with async- or debug-\n  --include-output   Grep output-*.log for suspicious words (can be noisy for review tasks)\n  --json             Emit JSON\n  -h, --help         Show help\n\nTypical use:\n  npm run logs:scan\n  npm run logs:scan -- --all --since 7d\n  npm run logs:scan -- --run ff3fc44b\n`);
  process.exit(exitCode);
}

function parseDuration(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const n = Number(match[1]);
  const unit = (match[2] || "ms").toLowerCase();
  return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]);
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-h" || arg === "--help") usage(0);
  else if (arg === "--root") opts.root = args[++i];
  else if (arg === "--run") opts.run = args[++i];
  else if (arg === "--since") opts.sinceMs = parseDuration(args[++i]);
  else if (arg === "--all") opts.all = true;
  else if (arg === "--json") opts.json = true;
  else if (arg === "--no-state") opts.noState = true;
  else if (arg === "--include-tests") opts.includeTests = true;
  else if (arg === "--include-output") opts.includeOutput = true;
  else if (arg === "--state") opts.state = args[++i];
  else throw new Error(`Unknown argument: ${arg}`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
}

function readLines(file, maxBytes = 2 * 1024 * 1024) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      let text = buffer.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      return text.split(/\r?\n/).filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  } catch { return []; }
}

function safeStat(file) {
  try { return fs.statSync(file); } catch { return undefined; }
}

function truncate(text, max = 600) {
  const s = String(text ?? "").trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function loadSeen() {
  if (opts.noState || opts.all) return new Set();
  const data = readJson(opts.state);
  return new Set(Array.isArray(data?.seen) ? data.seen : []);
}

function saveSeen(seen) {
  if (opts.noState || opts.all) return;
  fs.mkdirSync(path.dirname(opts.state), { recursive: true });
  const recent = [...seen].slice(-5000);
  fs.writeFileSync(opts.state, JSON.stringify({ updatedAt: new Date().toISOString(), seen: recent }, null, 2));
}

function listRuns(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}

function issue(id, runId, severity, title, detail = {}, ts) {
  return { id, runId, severity, title, ts, ...detail };
}

function scanRun(runDir) {
  const runId = path.basename(runDir);
  const statusPath = path.join(runDir, "status.json");
  const eventsPath = path.join(runDir, "events.jsonl");
  const status = readJson(statusPath) || {};
  const stat = safeStat(statusPath) || safeStat(eventsPath) || safeStat(runDir);
  const updatedMs = status.lastUpdate || status.endedAt || status.startedAt || stat?.mtimeMs || 0;
  const findings = [];

  if (status.state === "failed" || status.state === "paused") {
    findings.push(issue(`status:${runId}:${status.state}:${status.lastUpdate || ""}`, runId, status.state === "failed" ? "high" : "medium", `run ${status.state}`, {
      error: truncate(status.error || status.steps?.find?.((s) => s.error)?.error || status.summary || ""),
      statusPath,
    }, updatedMs));
  }

  for (const [index, step] of Object.entries(status.steps || [])) {
    const failedOrPaused = step?.status === "failed" || step?.status === "paused";
    const needsAttention = step?.activityState === "needs_attention" && !["complete", "completed", "failed", "paused"].includes(step?.status);
    if (failedOrPaused || needsAttention) {
      const label = failedOrPaused ? step.status : step.activityState;
      findings.push(issue(`step:${runId}:${index}:${label}:${step.endedAt || step.lastActivityAt || ""}`, runId, step.status === "failed" ? "high" : "medium", `step ${Number(index) + 1} ${label}: ${step.agent || "unknown"}`, {
        agent: step.agent,
        stepIndex: Number(index),
        exitCode: step.exitCode,
        error: truncate(step.error || step.recentOutput?.join?.("\n") || ""),
        sessionFile: step.sessionFile,
      }, step.endedAt || step.lastActivityAt || updatedMs));
    }
  }

  readLines(eventsPath).forEach((line, lineIndex) => {
    let record;
    try { record = JSON.parse(line); } catch {
      findings.push(issue(`event:${runId}:${lineIndex}:malformed`, runId, "medium", "malformed events.jsonl line", { line: truncate(line, 300), eventsPath }, updatedMs));
      return;
    }
    const type = record.type;
    if (type === "subagent.step.failed") {
      findings.push(issue(`event:${runId}:${lineIndex}:${type}`, runId, "high", `step failed event: ${record.agent || "unknown"}`, {
        stepIndex: record.stepIndex,
        exitCode: record.exitCode,
        summary: truncate(record.summary),
        sessionFile: record.sessionFile,
      }, record.ts));
    } else if (type === "subagent.run.repaired_stale") {
      findings.push(issue(`event:${runId}:${lineIndex}:${type}`, runId, "high", "stale run repaired as failed", { message: truncate(record.message), pid: record.pid }, record.ts));
    } else if (type === "subagent.control" && record.event?.type === "needs_attention") {
      findings.push(issue(`event:${runId}:${lineIndex}:needs_attention`, runId, "medium", `needs attention: ${record.event.agent || "unknown"}`, {
        reason: record.event.reason,
        notice: truncate(record.noticeText || record.event.message),
      }, record.ts));
    }
  });

  if (opts.includeOutput) {
    for (const entry of fs.readdirSync(runDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^output-\d+\.log$/.test(entry.name)) continue;
      const file = path.join(runDir, entry.name);
      const text = fs.readFileSync(file, "utf8");
      const matches = text.match(/(^|\n).{0,120}(error|exception|traceback|failed|cannot find module|enoent|eacces).{0,240}/gi) || [];
      if (matches.length) {
        findings.push(issue(`output:${runId}:${entry.name}:${entry.size}:${matches.length}`, runId, "low", `suspicious output in ${entry.name}`, {
          outputFile: file,
          matches: matches.slice(-3).map((m) => truncate(m.replace(/^\n/, ""), 300)),
        }, safeStat(file)?.mtimeMs || updatedMs));
      }
    }
  }

  return { runId, runDir, state: status.state || "unknown", updatedMs, findings };
}

const cutoff = Date.now() - opts.sinceMs;
const seen = loadSeen();
const looksLikeTestRun = (runId) => /^(async-|debug-)/.test(runId);
const runs = listRuns(opts.root)
  .filter((dir) => !opts.run || path.basename(dir).startsWith(opts.run))
  .filter((dir) => opts.includeTests || opts.run || !looksLikeTestRun(path.basename(dir)))
  .map(scanRun)
  .filter((run) => opts.run || run.updatedMs >= cutoff)
  .sort((a, b) => b.updatedMs - a.updatedMs);

const newFindings = [];
for (const run of runs) {
  for (const finding of run.findings) {
    if (opts.all || !seen.has(finding.id)) newFindings.push(finding);
    seen.add(finding.id);
  }
}
saveSeen(seen);

if (opts.json) {
  console.log(JSON.stringify({ root: opts.root, scannedRuns: runs.length, newIssues: newFindings.length, findings: newFindings }, null, 2));
} else {
  console.log(`Scanned ${runs.length} async run(s) in ${opts.root}`);
  console.log(`${opts.all ? "Total" : "New"} issue(s): ${newFindings.length}`);
  for (const finding of newFindings) {
    const when = finding.ts ? new Date(finding.ts).toISOString() : "unknown time";
    console.log(`\n[${finding.severity}] ${finding.runId} · ${when}\n  ${finding.title}`);
    for (const [key, value] of Object.entries(finding)) {
      if (["id", "runId", "severity", "title", "ts"].includes(key) || value === undefined || value === "") continue;
      console.log(`  ${key}: ${Array.isArray(value) ? value.join(" | ") : value}`);
    }
  }
  if (!newFindings.length) console.log("No new issues found. Use --all to reprint previously seen issues.");
}
