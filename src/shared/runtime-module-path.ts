import * as fs from "node:fs";
import * as path from "node:path";

/** Every extension a sibling runtime module may be published with: compiled `.js` first, source `.ts`. */
export const RUNTIME_MODULE_EXTENSIONS = [".js", ".ts"] as const;

/**
 * Which extension a sibling runtime module has on disk now. An in-place package
 * update can swap the `.ts` source layout for the compiled `.js` layout under a
 * running process, so the running module's own extension is not reliable.
 */
export function resolveRuntimeModuleExtension(dir: string, basename: string): string {
	return RUNTIME_MODULE_EXTENSIONS.find((extension) => fs.existsSync(path.join(dir, `${basename}${extension}`))) ?? ".js";
}

/** Absolute, normalized path to a sibling runtime module that exists on disk. */
export function resolveRuntimeModulePath(dir: string, basename: string): string {
	return path.normalize(path.join(dir, `${basename}${resolveRuntimeModuleExtension(dir, basename)}`));
}
