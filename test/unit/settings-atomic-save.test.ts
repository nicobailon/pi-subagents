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

function physicalPath(file) {
	const absolute = path.resolve(String(file));
	return path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
}
const target = physicalPath(process.env.PI_SETTINGS_ATOMIC_TARGET);
const originalWriteFileSync = fs.writeFileSync;
fs.writeFileSync = function(file, data, ...args) {
	const candidate = physicalPath(file);
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

function physicalPath(file) {
	const absolute = path.resolve(String(file));
	return path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
}
const target = physicalPath(process.env.PI_SETTINGS_ATOMIC_TARGET);
const originalRenameSync = fs.renameSync;
fs.renameSync = function(source, destination, ...args) {
	if (physicalPath(destination) === target) {
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

it("follows a short settings symlink chain with existing and dangling targets", {
	skip: process.platform === "win32" ? "POSIX symlink semantics vary on Windows" : undefined,
}, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-symlink-chain-"));
	tempRoots.push(root);
	const project = createProject(root);
	const settingsPath = path.join(project, ".pi", "settings.json");
	const intermediatePath = path.join(project, ".pi", "settings-link.json");
	const targetPath = path.join(root, "settings-target.json");
	const linkText = path.relative(path.dirname(intermediatePath), targetPath);
	fs.symlinkSync("settings-link.json", settingsPath);
	fs.symlinkSync(linkText, intermediatePath);
	for (const dangling of [false, true]) {
		const previous = dangling ? {} : { topLevelSentinel: "chain-target" };
		if (dangling) fs.unlinkSync(targetPath);
		else fs.writeFileSync(targetPath, `${JSON.stringify(previous, null, 2)}\n`, "utf-8");
		saveBuiltinAgentOverride(project, "reviewer", "project", { disabled: true });
		assert.equal(fs.readlinkSync(settingsPath), "settings-link.json");
		assert.equal(fs.readlinkSync(intermediatePath), linkText);
		assert.equal(fs.readFileSync(targetPath, "utf-8"), `${JSON.stringify({
			...previous,
			subagents: { agentOverrides: { reviewer: { disabled: true } } },
		}, null, 2)}\n`);
	}
});

for (const absolute of [false, true]) {
	for (const dangling of [false, true]) {
		it(`follows directory symlinks before parent traversal (${absolute ? "absolute" : "relative"}, ${dangling ? "dangling" : "existing"})`, {
			skip: process.platform === "win32" ? "POSIX symlink semantics vary on Windows" : undefined,
		}, () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-physical-path-"));
			tempRoots.push(root);
			const project = createProject(root);
			const configDir = path.join(project, ".pi");
			const settingsPath = path.join(configDir, "settings.json");
			const physicalParent = path.join(configDir, "actual");
			const physicalTarget = path.join(physicalParent, "target.json");
			const lexicalDecoy = path.join(configDir, "target.json");
			fs.mkdirSync(path.join(physicalParent, "nested"), { recursive: true });
			fs.symlinkSync(path.join(physicalParent, "nested"), path.join(configDir, "via"), "dir");
			const linkText = `${absolute ? `${configDir}/` : ""}via/../target.json`;
			fs.symlinkSync(linkText, settingsPath);
			const previous = dangling ? {} : { sentinel: "physical" };
			if (!dangling) {
				fs.writeFileSync(physicalTarget, `${JSON.stringify(previous, null, 2)}\n`, "utf-8");
				fs.chmodSync(physicalTarget, 0o640);
			}
			const decoyRaw = `${JSON.stringify({ sentinel: "decoy" }, null, 2)}\n`;
			fs.writeFileSync(lexicalDecoy, decoyRaw, "utf-8");

			saveBuiltinAgentOverride(project, "reviewer", "project", { disabled: true });
			assert.equal(fs.readlinkSync(settingsPath), linkText);
			assert.equal(fs.readFileSync(lexicalDecoy, "utf-8"), decoyRaw);
			assert.equal(fs.readFileSync(physicalTarget, "utf-8"), `${JSON.stringify({
				...previous,
				subagents: { agentOverrides: { reviewer: { disabled: true } } },
			}, null, 2)}\n`);
			if (!dangling) assert.equal(fs.statSync(physicalTarget).mode & 0o7777, 0o640);
		});
	}
}

it("rejects missing settings target parents without creating directories or changing a decoy", {
	skip: process.platform === "win32" ? "POSIX symlink semantics vary on Windows" : undefined,
}, () => {
	for (const linkText of ["missing/target.json", "missing/../target.json"]) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-missing-parent-"));
		tempRoots.push(root);
		const project = createProject(root);
		const configDir = path.join(project, ".pi");
		const settingsPath = path.join(configDir, "settings.json");
		const decoyPath = path.join(configDir, "target.json");
		const decoyRaw = `${JSON.stringify({ sentinel: "decoy" }, null, 2)}\n`;
		fs.writeFileSync(decoyPath, decoyRaw, "utf-8");
		fs.symlinkSync(linkText, settingsPath);
		assert.throws(() => saveBuiltinAgentOverride(project, "reviewer", "project", { disabled: true }), { code: "ENOENT" });
		assert.equal(fs.readlinkSync(settingsPath), linkText);
		assert.equal(fs.existsSync(path.join(configDir, "missing")), false);
		assert.equal(fs.readFileSync(decoyPath, "utf-8"), decoyRaw);
		assert.deepEqual(fs.readdirSync(configDir).sort(), ["settings.json", "target.json"]);
	}
});

for (const absolute of [false, true]) {
	for (const suffix of ["/", "//"]) {
		for (const chained of [false, true]) {
			it(`rejects missing directory settings targets (${absolute ? "absolute" : "relative"}, ${suffix}, ${chained ? "chain" : "direct"})`, {
				skip: process.platform === "win32" ? "POSIX symlink semantics vary on Windows" : undefined,
			}, () => {
				const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-directory-target-"));
				tempRoots.push(root);
				const project = createProject(root);
				const configDir = path.join(project, ".pi");
				const settingsPath = path.join(configDir, "settings.json");
				const missingPath = path.join(configDir, "missing");
				const linkText = `${absolute ? missingPath : "missing"}${suffix}`;
				const finalLink = chained ? path.join(configDir, "settings-link.json") : settingsPath;
				fs.symlinkSync(linkText, finalLink);
				if (chained) fs.symlinkSync("settings-link.json", settingsPath);

				assert.throws(() => saveBuiltinAgentOverride(project, "reviewer", "project", { disabled: true }));
				assert.equal(fs.existsSync(missingPath), false);
				assert.equal(fs.readlinkSync(finalLink), linkText);
				if (chained) assert.equal(fs.readlinkSync(settingsPath), "settings-link.json");
				assert.deepEqual(fs.readdirSync(configDir).sort(), chained ? ["settings-link.json", "settings.json"] : ["settings.json"]);
			});
		}
	}
}

it("rejects cyclic settings symlinks without replacing them", {
	skip: process.platform === "win32" ? "POSIX symlink semantics vary on Windows" : undefined,
}, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-cycle-"));
	tempRoots.push(root);
	const project = createProject(root);
	const settingsPath = path.join(project, ".pi", "settings.json");
	fs.symlinkSync("settings.json", settingsPath);
	assert.throws(() => saveBuiltinAgentOverride(project, "reviewer", "project", { disabled: true }));
	assert.equal(fs.readlinkSync(settingsPath), "settings.json");
	assert.deepEqual(fs.readdirSync(path.dirname(settingsPath)), ["settings.json"]);
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
	const interruptedTemps = fs.readdirSync(path.dirname(settingsPath))
		.filter((entry) => entry.startsWith(".settings.json.") && entry.endsWith(".tmp"));
	assert.equal(interruptedTemps.length, 1, "the child must have exited after writing its temporary file");
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
	assert.deepEqual(
		fs.readdirSync(path.dirname(settingsPath)).filter((entry) => entry.startsWith(".settings.json.") && entry.endsWith(".tmp")),
		[],
	);
});
