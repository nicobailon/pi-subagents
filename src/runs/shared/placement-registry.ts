import type { PlacementMachineReference } from "../../shared/types.ts";
import type { ChildSession, ChildSessionLaunch } from "./child-session.ts";

/**
 * The versioned seam between placement providers and the core: adapters register here, and the
 * core dispatches by `machine.provider` without provider branches of its own. Built-in Herdr and
 * Rex adapters register from `builtin-placement-adapters.ts`; external adapter packages (tmux)
 * register through the same call at extension load.
 *
 * V1 contract: `resolveMachinePlacement` is consulted in registration order until one adapter
 * returns a placement; `createPlacedPiSession` is looked up by the launch's machine provider.
 * The placed-Pi bridge (version handshake, identity checks, evidence cursor) stays host-neutral
 * in the core; an adapter only owns panes and machine access.
 */

export interface PlacementAdapterSettings {
	cwd?: string;
	env?: Record<string, string>;
	/** User settings only: run this machine's children in Rex panes reached over SSH at `ssh`. */
	rex?: { ssh: string };
}

export interface PlacementResolveRequest {
	/** Machine id or label as typed by the operator, already validated. */
	machine: string;
	/** Local directory whose project settings hold `subagents.machines`. */
	cwd: string;
	/** Launch cwd: absolute or `~` paths are remote paths as given; relative paths join the configured machine root. */
	stepCwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Test seam: catalog JSON instead of spawning the provider's machine list. */
	catalogJson?: string;
	/** Test seam: settings entry instead of reading settings files. */
	settings?: PlacementAdapterSettings;
	herdrBin?: string;
}

/** A resolved `machine` value with the optional settings env exported in front of the remote command. */
export interface PlacementResolution {
	machine: PlacementMachineReference;
	env?: Record<string, string>;
}

export interface PlacementAdapterV1 {
	kind: "pi-subagents.placement-adapter";
	version: 1;
	/** Matches the `provider` field of the machine references this adapter places on. */
	provider: string;
	/** Return undefined to decline a machine name and let a later adapter resolve it. */
	resolveMachinePlacement?(request: PlacementResolveRequest): PlacementResolution | undefined;
	createPlacedPiSession(launch: ChildSessionLaunch): Promise<ChildSession>;
}

const adapters: PlacementAdapterV1[] = [];

export function registerPlacementAdapter(adapter: PlacementAdapterV1, options: { /** Insert ahead of a registered fallback provider (e.g. "herdr") so third-party adapters get first claim on machine names. */ before?: string } = {}): void {
	if (adapter.kind !== "pi-subagents.placement-adapter") throw new Error(`Placement adapter '${adapter.provider}' must declare kind 'pi-subagents.placement-adapter'.`);
	if (adapter.version !== 1) throw new Error(`Placement adapter '${adapter.provider}' declares unsupported version ${String(adapter.version)}; this core speaks version 1.`);
	if (typeof adapter.provider !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(adapter.provider)) throw new Error(`Placement adapter provider id must match /^[a-z][a-z0-9_-]{0,31}$/: ${JSON.stringify(adapter.provider)}.`);
	if (adapters.some((existing) => existing.provider === adapter.provider)) throw new Error(`A placement adapter for provider '${adapter.provider}' is already registered.`);
	const index = options.before ? adapters.findIndex((existing) => existing.provider === options.before) : -1;
	if (options.before && index === -1) throw new Error(`Cannot register placement adapter '${adapter.provider}' before unknown provider '${options.before}'.`);
	adapters.splice(index === -1 ? adapters.length : index, 0, adapter);
}

export function placementAdapters(): readonly PlacementAdapterV1[] {
	return adapters;
}

export function requirePlacementAdapter(provider: string | undefined): PlacementAdapterV1 {
	const adapter = adapters.find((candidate) => candidate.provider === provider);
	if (adapter) return adapter;
	const registered = adapters.map((candidate) => `'${candidate.provider}'`).join(", ");
	throw new Error(`No placement adapter for machine provider '${provider ?? String(provider)}'. Registered providers: ${registered || "none"}.`);
}
