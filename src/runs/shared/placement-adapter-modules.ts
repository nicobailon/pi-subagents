/**
 * Adapter modules for processes that cannot load Pi extensions.
 *
 * Async runs execute in a detached runner process that imports this package directly, so an adapter registered by a
 * Pi extension in the parent never reaches it. The parent therefore forwards the module URL each adapter declares,
 * and the runner imports those modules and lets them register into its own registry.
 */
import { placementAdapters, registerPlacementAdapter, type PlacementAdapterV1 } from "./placement-registry.ts";

/** Env var the parent sets for an async runner: a JSON array of adapter module URLs. */
export const PLACEMENT_ADAPTER_MODULES_ENV = "PI_SUBAGENTS_PLACEMENT_ADAPTERS";

/** What an adapter module must export for a runner process to load it. */
export interface PlacementAdapterModule {
	registerPlacementAdapters(register: (adapter: PlacementAdapterV1, options?: { before?: string }) => void): void;
}

/** Module URLs of the adapters registered in this process, deduplicated; adapters without a module are skipped. */
export function placementAdapterModuleUrls(adapters: readonly PlacementAdapterV1[] = placementAdapters()): string[] {
	const urls = adapters
		.map((adapter) => adapter.moduleUrl)
		.filter((url): url is string => typeof url === "string" && url.length > 0);
	return [...new Set(urls)];
}

/** Reads the forwarded module URLs; a malformed value loads nothing rather than failing the run. */
export function placementAdapterModuleUrlsFromEnv(value: string | undefined = process.env[PLACEMENT_ADAPTER_MODULES_ENV]): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((url): url is string => typeof url === "string" && url.length > 0) : [];
	} catch {
		return [];
	}
}

/** Imports adapter modules and lets each register into this process's registry. */
export async function loadPlacementAdapterModules(urls: readonly string[] = placementAdapterModuleUrlsFromEnv()): Promise<void> {
	for (const url of urls) {
		const module = await import(url) as Partial<PlacementAdapterModule>;
		if (typeof module.registerPlacementAdapters !== "function") {
			throw new Error(`Placement adapter module '${url}' does not export registerPlacementAdapters(register).`);
		}
		module.registerPlacementAdapters((adapter, options) => registerPlacementAdapter(adapter, options));
	}
}
