/**
 * orchestrator-discovery.ts
 *
 * Discovery zapisanych orchestratorów (pliki .orch.json).
 * Wzorzec identyczny z discovery chainów w agents/agents.ts.
 *
 * Ścieżki discovery (priorytet: projekt > user):
 * - .pi/orchestrators/**\/*.orch.json
 * - ~/.pi/agent/orchestrators/**\/*.orch.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

// ── Typy ────────────────────────────────────────────────────────────────

export interface SavedOrchestrator {
	name: string;
	description: string;
	scriptPath: string;
	filePath: string;
	source: "user" | "project";
}

// ── Helpers ─────────────────────────────────────────────────────────────

function getUserAgentDir(): string {
	const codingAgentDir = process.env.PI_CODING_AGENT_DIR;
	if (codingAgentDir) return codingAgentDir;
	return path.join(os.homedir(), ".pi", "agent");
}

function getUserOrchestratorDir(): string {
	return path.join(getUserAgentDir(), "orchestrators");
}

function findNearestProjectRoot(cwd: string): string | null {
	let current = path.resolve(cwd);
	for (let i = 0; i < 20; i++) {
		if (fs.existsSync(path.join(current, ".pi"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return null;
}

function resolveProjectOrchestratorDirs(cwd: string): { readDirs: string[]; preferredDir: string | null } {
	const projectRoot = findNearestProjectRoot(cwd);
	if (!projectRoot) return { readDirs: [], preferredDir: null };

	const preferredDir = path.join(projectRoot, ".pi", "orchestrators");
	return {
		readDirs: fs.existsSync(preferredDir) && fs.statSync(preferredDir).isDirectory() ? [preferredDir] : [],
		preferredDir,
	};
}

function listFilesRecursive(dir: string, filter: (fileName: string) => boolean): string[] {
	const results: string[] = [];
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...listFilesRecursive(fullPath, filter));
			} else if (entry.isFile() && filter(entry.name)) {
				results.push(fullPath);
			}
		}
	} catch {
		// brak katalogu — pomiń
	}
	return results;
}

// ── Discovery ────────────────────────────────────────────────────────────

function loadOrchestratorsFromDir(dir: string, source: "user" | "project"): SavedOrchestrator[] {
	const orchestrators = new Map<string, SavedOrchestrator>();

	for (const filePath of listFilesRecursive(dir, (f) => f.endsWith(".orch.json"))) {
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			const parsed = JSON.parse(content);
			if (!parsed.name || typeof parsed.name !== "string") {
				continue;
			}
			if (!parsed.scriptPath || typeof parsed.scriptPath !== "string") {
				continue;
			}

			const orchestrator: SavedOrchestrator = {
				name: parsed.name,
				description: typeof parsed.description === "string" ? parsed.description : "",
				scriptPath: parsed.scriptPath,
				filePath,
				source,
			};

			orchestrators.set(orchestrator.name, orchestrator);
		} catch {
			continue;
		}
	}

	return Array.from(orchestrators.values());
}

export function discoverSavedOrchestrators(cwd: string): SavedOrchestrator[] {
	const userDir = getUserOrchestratorDir();
	const { readDirs: projectDirs } = resolveProjectOrchestratorDirs(cwd);

	const byName = new Map<string, SavedOrchestrator>();

	// User — niższy priorytet
	for (const orch of loadOrchestratorsFromDir(userDir, "user")) {
		byName.set(orch.name, orch);
	}

	// Project — wyższy priorytet (nadpisuje user)
	for (const dir of projectDirs) {
		for (const orch of loadOrchestratorsFromDir(dir, "project")) {
			byName.set(orch.name, orch);
		}
	}

	return Array.from(byName.values());
}
