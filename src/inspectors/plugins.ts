import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { INSPECTOR_REGISTER_EVENT, type InspectorRegistrationRequest } from "../api/inspectors.ts";
import { createHerdrInspectorPlugin } from "./herdr/plugin.ts";
import { createGhosttyInspectorPlugin } from "./ghostty/plugin.ts";
import type { InspectorPlugin } from "./types.ts";

type InspectorOwner = Pick<ExtensionAPI, "events">;
const registeredPlugins = new WeakMap<InspectorOwner, Map<string, InspectorPlugin>>();

/** Built-ins retain host preference; external providers follow registration order. */
export function getInspectorPlugins(pi: InspectorOwner): readonly InspectorPlugin[] {
	return [createHerdrInspectorPlugin(), createGhosttyInspectorPlugin(), ...(registeredPlugins.get(pi)?.values() ?? [])];
}

/** The owner holds callbacks only for this extension runtime, never in child runtimes. */
export function registerInspectorEventListener(pi: InspectorOwner): () => void {
	const plugins = new Map<string, InspectorPlugin>();
	registeredPlugins.set(pi, plugins);
	const builtinNames = new Set(getInspectorPlugins(pi).map((plugin) => plugin.name));
	/* oxlint-disable anti-slop/no-runtime-typeof -- This listener validates the untyped event-bus boundary, including callable provider methods. */
	const unsubscribe = pi.events.on(INSPECTOR_REGISTER_EVENT, (rawRequest) => {
		if (!rawRequest || typeof rawRequest !== "object" || Array.isArray(rawRequest)) return;
		// SAFETY: The envelope is an object; its version and plugin are validated below before storing callbacks.
		const request = rawRequest as Partial<InspectorRegistrationRequest>;
		if (request.result !== undefined) return;
		try {
			if (request.version !== 1) throw new Error(`Unsupported inspector registration version '${String(request.version)}'.`);
			const plugin = request.plugin;
			if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) throw new Error("Inspector plugin must be an object.");
			const name = plugin.name;
			if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
				throw new Error("Inspector plugin name must contain 1–128 letters, digits, dots, underscores, or hyphens and start with a letter or digit.");
			}
			if (builtinNames.has(name) || plugins.has(name)) throw new Error(`Inspector plugin '${name}' is already registered.`);
			for (const method of ["available", "owns", "open"] as const) {
				if (typeof plugin[method] !== "function") throw new Error(`Inspector plugin '${name}' requires ${method}().`);
			}
			for (const method of ["status", "close"] as const) {
				if (plugin[method] !== undefined && typeof plugin[method] !== "function") throw new Error(`Inspector plugin '${name}' ${method} must be a function when provided.`);
			}
			plugins.set(name, plugin);
			let disposed = false;
			request.result = {
				ok: true,
				registration: {
					dispose() {
						if (disposed) return;
						disposed = true;
						plugins.delete(name);
					},
				},
			};
		} catch (error) {
			request.result = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
		}
	});
	/* oxlint-enable anti-slop/no-runtime-typeof */
	return () => {
		unsubscribe();
		plugins.clear();
		if (registeredPlugins.get(pi) === plugins) registeredPlugins.delete(pi);
	};
}
