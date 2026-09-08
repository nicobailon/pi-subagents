/**
 * Child session factory for the detached async runner.
 *
 * The npm runner imports `@earendil-works/pi-coding-agent` through the parent's
 * host peer aliases (`runner-aliases.ts`/`JITI_ALIAS`). A Pi-binary bootstrap
 * instead supplies its embedded SDK loader through the existing factory option.
 * Keep these ownership paths separate: filesystem peer fixes such as #2037 do
 * not make a binary's embedded SDK importable by a detached Node process, and
 * resolving another installed SDK would split provider/extension identities.
 * Tests may still replace the factory by naming a module in the runner config;
 * the standalone smoke deliberately does NOT use that seam.
 * https://github.com/nicobailon/pi-subagents/pull/2037
 * Regressions: test/smoke/pi085-clean-install.mjs checks real npm host aliases;
 * test/smoke/standalone-matrix.mjs forbids a filesystem SDK and proves the
 * injected namespace creates real sessions. Neither gate substitutes for the other.
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createDefaultChildSessionFactory, type ChildSessionFactory, type DefaultChildSessionFactoryOptions } from "../shared/child-session.ts";

export interface RunnerChildSessionConfig {
	/** Test seam: module whose default export is a `ChildSessionFactory`, or a function returning one. */
	childSessionFactoryModule?: string;
}

function isChildSessionFactory(value: unknown): value is ChildSessionFactory {
	return Boolean(value) && typeof value === "object" && typeof (value as ChildSessionFactory).create === "function" && typeof (value as ChildSessionFactory).dispose === "function";
}

export async function loadRunnerChildSessionFactory(config: RunnerChildSessionConfig, options?: DefaultChildSessionFactoryOptions): Promise<ChildSessionFactory> {
	if (!config.childSessionFactoryModule) return createDefaultChildSessionFactory(options);
	const loaded = await import(pathToFileURL(path.resolve(config.childSessionFactoryModule)).href) as { default?: unknown };
	const candidate = typeof loaded.default === "function" ? (loaded.default as () => unknown)() : loaded.default;
	if (!isChildSessionFactory(candidate)) {
		throw new Error(`Child session factory module '${config.childSessionFactoryModule}' must default-export a ChildSessionFactory or a function returning one.`);
	}
	return candidate;
}
