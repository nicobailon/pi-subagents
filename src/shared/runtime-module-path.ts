import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Which extension a sibling runtime module actually has on disk.
 *
 * pi-subagents ships compiled JavaScript (`.js`) to npm but keeps TypeScript
 * sources (`.ts`) in a source checkout. Deriving a sibling's extension from the
 * running module's own `import.meta.url` assumes the running module and its
 * siblings were published with the same extension and stay that way for the
 * lifetime of the process. When an installed package is replaced in place (for
 * example an npm/Pi update from the `.ts`-source layout to the compiled `.js`
 * layout), a long-running process can end up pointing at a sibling that no
 * longer exists and child sessions then fail to start. Resolve what is actually
 * on disk, at the moment it is needed.
 */
export function resolveRuntimeModuleExtension(dir: string, basename: string): string {
	for (const extension of runtimeModuleExtensions()) {
		if (fs.existsSync(path.join(dir, `${basename}${extension}`))) return extension;
	}
	return ".js";
}

/** Absolute, normalized path to a sibling runtime module that exists on disk. */
export function resolveRuntimeModulePath(dir: string, basename: string): string {
	return path.normalize(path.join(dir, `${basename}${resolveRuntimeModuleExtension(dir, basename)}`));
}

/** Every extension a sibling runtime module may be published with. */
export function runtimeModuleExtensions(): readonly string[] {
	return [".js", ".ts"];
}
