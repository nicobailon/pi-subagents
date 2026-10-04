import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { TEMP_ROOT_DIR } from "./types.ts";
import { createAtomicJsonWriter } from "./atomic-json.ts";
import { withFileWriteLock } from "./file-write-lock.ts";

/** The caller supplies the resolved physical file, so aliases share this lock. */
export function settingsFileLockPath(target: string): string {
	return path.join(TEMP_ROOT_DIR, "settings-locks", `${createHash("sha256").update(target).digest("hex")}.lock`);
}

/** Keep the read, mutation and optional save under one physical-file lock. */
export function updateSettingsFile<T>(filePath: string, action: (settings: Record<string, unknown>, save: () => void) => T, options: { allowInPlace?: boolean } = {}): T {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const target = resolveSettingsWriteTarget(filePath);
	const lockfilePath = settingsFileLockPath(target);
	fs.mkdirSync(path.dirname(lockfilePath), { recursive: true, mode: 0o700 });
	return withFileWriteLock(target, () => {
		const settings = readSettingsFileStrict(target);
		return action(settings, () => writeSettingsFile(target, settings, options.allowInPlace === true));
	}, { lockfilePath });
}

export function readSettingsFileStrict(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read settings file '${filePath}': ${message}`, { cause: error });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse settings file '${filePath}': ${message}`, { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Settings file '${filePath}' must contain a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

function writeSettingsFile(filePath: string, settings: Record<string, unknown>, allowInPlace: boolean): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const targetPath = resolveSettingsWriteTarget(filePath);
	let existingMode: number | undefined;
	try {
		existingMode = fs.statSync(targetPath).mode & 0o7777;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	if (existingMode !== undefined) fs.accessSync(targetPath, fs.constants.W_OK);
	if (allowInPlace && existingMode !== undefined) {
		try { fs.accessSync(path.dirname(targetPath), fs.constants.W_OK); }
		catch (error) {
			if (!["EACCES", "EPERM", "EROFS"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
			// Profile and Watchdog historically wrote existing files in place.
			// Keep that permission layout under the same transaction; other I/O
			// errors never trigger a fallback, and overrides still require atomic saving.
			fs.writeFileSync(targetPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
			return;
		}
	}

	const tempMode = existingMode === undefined ? undefined : existingMode | 0o200;
	// Reuse the atomic temp/rename path while retaining settings' newline and existing mode.
	const writeAtomicSettings = createAtomicJsonWriter({
		mode: tempMode,
		fs: {
			mkdirSync: fs.mkdirSync,
			writeFileSync: (tempPath, data, options) => {
				return fs.writeFileSync(tempPath, `${data}\n`, options);
			},
			renameSync: (sourcePath, destinationPath) => {
				if (existingMode !== undefined) fs.chmodSync(sourcePath, existingMode);
				fs.renameSync(sourcePath, destinationPath);
			},
			rmSync: fs.rmSync,
		},
	});
	writeAtomicSettings(targetPath, settings);
}

function resolveSettingsWriteTarget(filePath: string): string {
	let targetPath = filePath;
	for (;;) {
		try {
			return fs.realpathSync.native(targetPath);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			// A trailing separator requires a directory; it cannot name a new settings file.
			if (targetPath.endsWith("/") || targetPath.endsWith(path.sep)) throw error;
		}

		// A missing target is allowed only when its physical parent already exists.
		const parentPath = fs.realpathSync.native(path.dirname(targetPath));
		const unresolvedPath = path.join(parentPath, path.basename(targetPath));
		let linkText: string;
		try {
			linkText = fs.readlinkSync(unresolvedPath);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			return unresolvedPath;
		}
		// Keep link text intact so the filesystem follows directory links before "..".
		targetPath = path.isAbsolute(linkText) ? linkText : `${parentPath}${path.sep}${linkText}`;
	}
}
