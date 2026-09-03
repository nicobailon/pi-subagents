/**
 * Child session factory for the detached async runner.
 *
 * The runner imports `@earendil-works/pi-coding-agent` like the parent does;
 * the parent aliases that specifier (and the other host peer packages) to the
 * installed pi package through `JITI_ALIAS` when it spawns the runner, see
 * `runner-aliases.ts`. Tests replace the factory with a scripted one by
 * naming a module in the runner config.
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createDefaultChildSessionFactory, type ChildSessionFactory } from "../shared/child-session.ts";

export interface RunnerChildSessionConfig {
	/** Test seam: module whose default export is a `ChildSessionFactory`, or a function returning one. */
	childSessionFactoryModule?: string;
}

function isChildSessionFactory(value: unknown): value is ChildSessionFactory {
	return Boolean(value) && typeof value === "object" && typeof (value as ChildSessionFactory).create === "function" && typeof (value as ChildSessionFactory).dispose === "function";
}

export async function loadRunnerChildSessionFactory(config: RunnerChildSessionConfig): Promise<ChildSessionFactory> {
	if (!config.childSessionFactoryModule) return createDefaultChildSessionFactory();
	const loaded = await import(pathToFileURL(path.resolve(config.childSessionFactoryModule)).href) as { default?: unknown };
	const candidate = typeof loaded.default === "function" ? (loaded.default as () => unknown)() : loaded.default;
	if (!isChildSessionFactory(candidate)) {
		throw new Error(`Child session factory module '${config.childSessionFactoryModule}' must default-export a ChildSessionFactory or a function returning one.`);
	}
	return candidate;
}
