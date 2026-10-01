import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { after, it } from "node:test";
import { saveBuiltinAgentOverride } from "../../src/agents/agents.ts";

const repoRoot = process.cwd();
const tempRoots: string[] = [];

type UnixIdentity = { uid: number; gid: number };

after(() => {
	for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function getReadOnlyTestIdentity(): UnixIdentity | undefined {
	if (process.platform === "win32" || typeof process.getuid !== "function" || typeof process.getgid !== "function") return undefined;
	const uid = process.getuid();
	const gid = process.getgid();
	if (uid !== 0) return { uid, gid };
	try {
		const nobody = fs.readFileSync("/etc/passwd", "utf-8").split("\n").find((entry) => /^(?:_)?nobody:/u.test(entry));
		if (!nobody) return undefined;
		const fields = nobody.split(":");
		const nobodyUid = Number(fields[2]);
		const nobodyGid = Number(fields[3]);
		return Number.isInteger(nobodyUid) && Number.isInteger(nobodyGid) ? { uid: nobodyUid, gid: nobodyGid } : undefined;
	} catch {
		return undefined;
	}
}

function createProject(root: string): string {
	const project = path.join(root, "project");
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	return project;
}

function runChild(
	mode: "interrupt-temp-write" | "rename-eio" | "read-only-save",
	project: string,
	settingsPath: string,
	identity?: UnixIdentity,
) {
	const agentsModuleUrl = pathToFileURL(path.join(repoRoot, "src/agents/agents.ts")).href;
	let childSource: string;
	if (mode === "interrupt-temp-write") {
		childSource = `
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const target = path.resolve(process.env.PI_SETTINGS_ATOMIC_TARGET);
const originalWriteFileSync = fs.writeFileSync;
fs.writeFileSync = function(file, data, ...args) {
	const candidate = path.resolve(String(file));
	if (path.dirname(candidate) === path.dirname(target)
		&& path.basename(candidate).startsWith(".settings.json.")
		&& path.basename(candidate).endsWith(".tmp")) {
		const serialized = typeof data === "string" ? data : Buffer.from(data).toString("utf-8");
		originalWriteFileSync.call(fs, file, serialized.slice(0, 12), ...args);
		process.exit(73);
	}
	return originalWriteFileSync.call(fs, file, data, ...args);
};
syncBuiltinESMExports();
const { saveBuiltinAgentOverride } = await import(${JSON.stringify(agentsModuleUrl)});
saveBuiltinAgentOverride(process.env.PI_SETTINGS_ATOMIC_PROJECT, "reviewer", "project", { disabled: true });
process.exit(0);
`;
	} else if (mode === "rename-eio") {
		childSource = `
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const target = path.resolve(process.env.PI_SETTINGS_ATOMIC_TARGET);
const originalRenameSync = fs.renameSync;
fs.renameSync = function(source, destination, ...args) {
	if (path.resolve(String(destination)) === target) {
		const error = new Error("injected settings rename failure");
		Object.assign(error, { code: "EIO" });
		throw error;
	}
	return originalRenameSync.call(fs, source, destination, ...args);
};
syncBuiltinESMExports();
const { saveBuiltinAgentOverride } = await import(${JSON.stringify(agentsModuleUrl)});
try {
	saveBuiltinAgentOverride(process.env.PI_SETTINGS_ATOMIC_PROJECT, "reviewer", "project", { disabled: true });
	process.exit(2);
} catch (error) {
	process.stdout.write(JSON.stringify({ code: error?.code ?? null, message: error instanceof Error ? error.message : String(error) }) + "\\n");
	process.exit(0);
}
`;
	} else {
		childSource = `
const { saveBuiltinAgentOverride } = await import(${JSON.stringify(agentsModuleUrl)});
try {
	saveBuiltinAgentOverride(process.env.PI_SETTINGS_ATOMIC_PROJECT, "reviewer", "project", { disabled: true });
	process.exit(2);
} catch (error) {
	process.stdout.write(JSON.stringify({ code: error?.code ?? null, message: error instanceof Error ? error.message : String(error) }) + "\\n");
	process.exit(0);
}
`;
	}
	return spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", childSource], {
		cwd: repoRoot,
		env: {
			...process.env,
			PI_SETTINGS_ATOMIC_TARGET: settingsPath,
			PI_SETTINGS_ATOMIC_PROJECT: project,
		},
		encoding: "utf-8",
		maxBuffer: 1024 * 1024,
		timeout: 10_000,
		killSignal: "SIGKILL",
		...(identity ? { uid: identity.uid, gid: identity.gid } : {}),
	});
}

it("saves settings with the existing JSON format and unrelated values intact", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-atomic-controls-"));
	tempRoots.push(root);
	const project = createProject(root);
	const settingsPath = path.join(project, ".pi", "settings.json");
	const before = { topLevelSentinel: "keep-me", packages: ["keep-this-package"] };
	const expected = {
		...before,
		subagents: { agentOverrides: { reviewer: { disabled: true } } },
	};
	fs.writeFileSync(settingsPath, `${JSON.stringify(before, null, 2)}\n`, "utf-8");
	const returnedPath = saveBuiltinAgentOverride(project, "reviewer", "project", { disabled: true });
	const healthyRaw = fs.readFileSync(settingsPath, "utf-8");
	assert.equal(returnedPath, settingsPath);
	assert.equal(healthyRaw, `${JSON.stringify(expected, null, 2)}\n`);
	assert.deepEqual(JSON.parse(healthyRaw), expected);
});

it("preserves POSIX settings modes and follows symlink targets", { skip: process.platform === "win32" ? "POSIX mode and symlink semantics vary on Windows" : undefined }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-atomic-posix-"));
	tempRoots.push(root);
	const before = { topLevelSentinel: "keep-me", packages: ["keep-this-package"] };
	const expected = { ...before, subagents: { agentOverrides: { reviewer: { disabled: true } } } };
	const project = createProject(root);
	const settingsPath = path.join(project, ".pi", "settings.json");
	fs.writeFileSync(settingsPath, `${JSON.stringify(before, null, 2)}\n`, "utf-8");
	fs.chmodSync(settingsPath, 0o640);

	const originalUmask = process.umask(0o077);
	try {
		saveBuiltinAgentOverride(project, "reviewer", "project", { disabled: true });
	} finally {
		process.umask(originalUmask);
	}
	assert.equal(fs.readFileSync(settingsPath, "utf-8"), `${JSON.stringify(expected, null, 2)}\n`);
	assert.equal(fs.statSync(settingsPath).mode & 0o7777, 0o640);

	const linkedProject = path.join(root, "linked-project");
	fs.mkdirSync(path.join(linkedProject, ".pi"), { recursive: true });
	const linkedSettingsPath = path.join(linkedProject, ".pi", "settings.json");
	const settingsTarget = path.join(root, "shared-settings.json");
	const symlinkText = path.relative(path.dirname(linkedSettingsPath), settingsTarget);
	fs.writeFileSync(settingsTarget, `${JSON.stringify(before, null, 2)}\n`, "utf-8");
	fs.chmodSync(settingsTarget, 0o604);
	fs.symlinkSync(symlinkText, linkedSettingsPath);

	const symlinkUmask = process.umask(0o077);
	try {
		saveBuiltinAgentOverride(linkedProject, "reviewer", "project", { disabled: true });
	} finally {
		process.umask(symlinkUmask);
	}
	assert.equal(fs.lstatSync(linkedSettingsPath).isSymbolicLink(), true);
	assert.equal(fs.readlinkSync(linkedSettingsPath), symlinkText);
	const linkedRaw = fs.readFileSync(settingsTarget, "utf-8");
	assert.equal(linkedRaw, `${JSON.stringify(expected, null, 2)}\n`);
	assert.deepEqual(JSON.parse(linkedRaw), expected);
	assert.equal(fs.statSync(settingsTarget).mode & 0o7777, 0o604);

	const nestedProject = path.join(root, "nested-project");
	const realConfigDir = path.join(root, "central", "config");
	fs.mkdirSync(realConfigDir, { recursive: true });
	fs.mkdirSync(nestedProject, { recursive: true });
	const nestedProjectConfig = path.join(nestedProject, ".pi");
	fs.symlinkSync(realConfigDir, nestedProjectConfig, "dir");
	const nestedSettingsPath = path.join(nestedProjectConfig, "settings.json");
	const nestedTarget = path.join(root, "central", "settings.json");
	const lexicalDecoy = path.join(nestedProject, "settings.json");
	const nestedPrevious = { topLevelSentinel: "physical-target" };
	const decoyPrevious = { topLevelSentinel: "lexical-decoy" };
	const relativeLinkText = "../settings.json";
	fs.writeFileSync(nestedTarget, `${JSON.stringify(nestedPrevious, null, 2)}\n`, "utf-8");
	fs.writeFileSync(lexicalDecoy, `${JSON.stringify(decoyPrevious, null, 2)}\n`, "utf-8");
	fs.symlinkSync(relativeLinkText, nestedSettingsPath);

	saveBuiltinAgentOverride(nestedProject, "reviewer", "project", { disabled: true });
	assert.equal(fs.readlinkSync(nestedSettingsPath), relativeLinkText);
	assert.equal(fs.readFileSync(nestedTarget, "utf-8"), `${JSON.stringify({
		...nestedPrevious,
		subagents: { agentOverrides: { reviewer: { disabled: true } } },
	}, null, 2)}\n`);
	assert.equal(fs.readFileSync(lexicalDecoy, "utf-8"), `${JSON.stringify(decoyPrevious, null, 2)}\n`);
});

it("follows a 40-link settings chain when the host filesystem supports it", {
	skip: process.platform === "win32" ? "POSIX symlink-chain limits vary on Windows" : undefined,
}, (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-symlink-chain-"));
	tempRoots.push(root);
	const project = createProject(root);
	const settingsPath = path.join(project, ".pi", "settings.json");
	const linkPaths = [settingsPath, ...Array.from({ length: 39 }, (_, index) => path.join(project, ".pi", `settings-link-${index}.json`))];
	const targetPath = path.join(root, "settings-target.json");
	const previous = { topLevelSentinel: "chain-target" };
	const previousRaw = `${JSON.stringify(previous, null, 2)}\n`;
	fs.writeFileSync(targetPath, previousRaw, "utf-8");
	for (const [index, linkPath] of linkPaths.entries()) {
		fs.symlinkSync(linkPaths[index + 1] ?? targetPath, linkPath);
	}

	let observedRaw: string;
	try {
		observedRaw = fs.readFileSync(settingsPath, "utf-8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ELOOP") {
			t.skip("host filesystem rejects a 40-link chain");
			return;
		}
		throw error;
	}
	assert.equal(observedRaw, previousRaw);

	saveBuiltinAgentOverride(project, "reviewer", "project", { disabled: true });
	assert.equal(fs.readlinkSync(settingsPath), linkPaths[1]);
	assert.equal(fs.readFileSync(targetPath, "utf-8"), `${JSON.stringify({
		...previous,
		subagents: { agentOverrides: { reviewer: { disabled: true } } },
	}, null, 2)}\n`);
});

it("rejects a read-only settings target for a non-root user even when its parent directory is writable", {
	skip: getReadOnlyTestIdentity() ? undefined : "could not find a POSIX identity for a non-root permission check",
}, (t) => {
	const identity = getReadOnlyTestIdentity();
	assert.ok(identity);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-read-only-"));
	tempRoots.push(root);
	const project = createProject(root);
	const settingsDir = path.join(project, ".pi");
	const settingsPath = path.join(settingsDir, "settings.json");
	const previous = { topLevelSentinel: "read-only", packages: ["keep-this-package"] };
	const previousRaw = `${JSON.stringify(previous, null, 2)}\n`;
	fs.writeFileSync(settingsPath, previousRaw, "utf-8");

	if (process.getuid?.() === 0) {
		try {
			fs.chownSync(root, identity.uid, identity.gid);
			fs.chownSync(project, identity.uid, identity.gid);
			fs.chownSync(settingsDir, identity.uid, identity.gid);
			fs.chownSync(settingsPath, identity.uid, identity.gid);
		} catch (error) {
			t.skip(`could not prepare the non-root fixture: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
	}
	fs.chmodSync(root, 0o755);
	fs.chmodSync(project, 0o755);
	fs.chmodSync(settingsDir, 0o777);
	fs.chmodSync(settingsPath, 0o444);

	const childIdentity = process.getuid?.() === 0 ? identity : undefined;
	const child = runChild("read-only-save", project, settingsPath, childIdentity);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.signal, null);
	assert.equal(JSON.parse(child.stdout).code, "EACCES");
	assert.equal(fs.readFileSync(settingsPath, "utf-8"), previousRaw);
	assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf-8")), previous);
	assert.deepEqual(
		fs.readdirSync(settingsDir).filter((entry) => entry.startsWith(".settings.json.") && entry.endsWith(".tmp")),
		[],
	);
});

it("keeps the previous settings file intact when the real API process exits during its temporary write", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-atomic-interrupt-"));
	tempRoots.push(root);
	const project = createProject(root);
	const settingsPath = path.join(project, ".pi", "settings.json");
	const previous = { topLevelSentinel: "previously-readable", packages: ["keep-this-package"] };
	const previousRaw = `${JSON.stringify(previous, null, 2)}\n`;
	fs.writeFileSync(settingsPath, previousRaw, "utf-8");

	const child = runChild("interrupt-temp-write", project, settingsPath);
	assert.equal(child.status, 73, child.stderr);
	assert.equal(child.signal, null);
	assert.equal(fs.readFileSync(settingsPath, "utf-8"), previousRaw);
	assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf-8")), previous);
	const interruptedTemps = fs.readdirSync(path.dirname(settingsPath))
		.filter((entry) => entry.startsWith(".settings.json.") && entry.endsWith(".tmp"));
	assert.equal(interruptedTemps.length, 1, "the child must have exited after writing its temporary file");
	assert.equal(fs.readFileSync(path.join(path.dirname(settingsPath), interruptedTemps[0]!), "utf-8").length, 12);
});

it("keeps the previous settings file intact and cleans up when replacing it fails with EIO", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-atomic-rename-"));
	tempRoots.push(root);
	const project = createProject(root);
	const settingsPath = path.join(project, ".pi", "settings.json");
	const previous = { topLevelSentinel: "previously-readable", packages: ["keep-this-package"] };
	const previousRaw = `${JSON.stringify(previous, null, 2)}\n`;
	fs.writeFileSync(settingsPath, previousRaw, "utf-8");

	const child = runChild("rename-eio", project, settingsPath);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.signal, null);
	assert.deepEqual(JSON.parse(child.stdout), { code: "EIO", message: "injected settings rename failure" });
	assert.equal(fs.readFileSync(settingsPath, "utf-8"), previousRaw);
	assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf-8")), previous);
	assert.deepEqual(
		fs.readdirSync(path.dirname(settingsPath)).filter((entry) => entry.startsWith(".settings.json.") && entry.endsWith(".tmp")),
		[],
	);
});
