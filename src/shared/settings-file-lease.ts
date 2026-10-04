import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLease } from "./file-lease.ts";

/** Physical file a settings path writes to, following file and directory links (including a dangling file link). */
export function resolveSettingsWriteTarget(filePath: string): string {
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

/** Hold the physical settings file's lease for a whole read-modify-write. */
export function withSettingsFileLease<T>(filePath: string, action: () => T): T {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	return withFileLease(resolveSettingsWriteTarget(filePath), action);
}
