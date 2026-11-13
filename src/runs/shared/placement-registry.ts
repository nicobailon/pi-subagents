import type { PlacementMachineReference, PlacementOpaqueMachineReference } from "../../shared/types.ts";
import type { PlacementMachineAccess, PlacementPaneHost, PlacementSockets } from "./placement-host.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The versioned seam between placement providers and the core: adapters register here, and the
 * core dispatches by `machine.provider` without provider branches of its own. Built-in Herdr and
 * Rex adapters register from `builtin-placement-adapters.ts`; external adapter packages (tmux)
 * register through the same call at extension load.
 *
 * V1 contract: `resolveMachinePlacement` is consulted in registration order until one adapter
 * returns a placement; `openPlacedRun` is looked up by the launch's machine provider and hands
 * back the host pieces (effective machine, pane host, connection, access, runtime dir), while
 * the core assembles the run owner and drives the host-neutral placed-Pi bridge itself, so an
 * adapter only owns panes and machine access.
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

/**
/** A third-party adapter's own machine reference shape, carried opaquely by the core. Defined in `shared/types.ts` and re-exported here as part of the adapter contract. */
export type { PlacementOpaqueMachineReference };


/** The two provider-free questions core asks about a machine: does a placed child on it read and write the parent's disk (`localDisk`), and does it opt in to hosting external-CLI writers (`externalCli`)? Adapters answer through the fields; core never compares providers. */
export function placementEditsLocalDisk(machine: PlacementMachineReference | undefined): boolean {
	return machine?.localDisk === true;
}

/** True when the machine opts in to hosting external-CLI writers (claude/codex adapters) — currently a herdr saved-machine contract. */
export function placementSupportsExternalCli(machine: PlacementMachineReference | undefined): boolean {
	return machine?.externalCli === true;
}

/** A resolved `machine` value with the optional settings env exported in front of the remote command. */
export interface PlacementResolution {
	machine: PlacementMachineReference;
	env?: Record<string, string>;
}

/** What an opened run hands to the core: the concrete machine it connected against plus the host pieces the bridge engine needs. */
export interface PlacementRunContext {
	/** The effective machine reference after adapter-side resolution (remote cwd expansion, recorded session); the core builds the run owner against this one. */
	machine: PlacementMachineReference;
	host: PlacementPaneHost<PlacementSockets>;
	connection: PlacementSockets;
	access: PlacementMachineAccess;
	runtimeDir: string;
	removeRuntime(): void;
}

export interface PlacementAdapterV1 {
	kind: "pi-subagents.placement-adapter";
	version: 1;
	/** Matches the `provider` field of the machine references this adapter places on. */
	provider: string;
	/** Return undefined to decline a machine name and let a later adapter resolve it. */
	resolveMachinePlacement?(request: PlacementResolveRequest): PlacementResolution | undefined;
	/** Open the host pieces for one placed run: connect (creating the adapter's session and window scaffolding as needed), resolve the effective machine, and provision the runtime directory. Fails closed — on any failure the adapter removes its own scaffolding before rethrowing. The core assembles the run owner and drives the bridge engine, so adapters never see launches or sessions. */
	openPlacedRun(machine: PlacementMachineReference, runId: string): Promise<PlacementRunContext>;
	/** Module that exports `registerPlacementAdapters(register)`, so a process that cannot load Pi extensions (the async runner) can load this adapter. Adapters that only ever run inside the Pi host may omit it. */
	moduleUrl?: string;
}

const adapters: PlacementAdapterV1[] = [];
/** Adapters whose `before` target had not registered yet; moved ahead of it when it appears (extension load order is not ours to control). */
const deferredBefore = new Map<string, string>();

export function registerPlacementAdapter(adapter: PlacementAdapterV1, options: { /** Insert ahead of a registered fallback provider (e.g. "herdr") so third-party adapters get first claim on machine names. */ before?: string } = {}): void {
	if (adapter.kind !== "pi-subagents.placement-adapter") throw new Error(`Placement adapter '${adapter.provider}' must declare kind 'pi-subagents.placement-adapter'.`);
	if (adapter.version !== 1) throw new Error(`Placement adapter '${adapter.provider}' declares unsupported version ${String(adapter.version)}; this core speaks version 1.`);
	if (typeof adapter.provider !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(adapter.provider)) throw new Error(`Placement adapter provider id must match /^[a-z][a-z0-9_-]{0,31}$/: ${JSON.stringify(adapter.provider)}.`);
	if (adapters.some((existing) => existing.provider === adapter.provider)) throw new Error(`A placement adapter for provider '${adapter.provider}' is already registered.`);
	const index = options.before ? adapters.findIndex((existing) => existing.provider === options.before) : -1;
	if (options.before && index === -1) deferredBefore.set(adapter.provider, options.before);
	adapters.splice(index === -1 ? adapters.length : index, 0, adapter);
	for (const [deferred, target] of deferredBefore) {
		if (target !== adapter.provider) continue;
		const moving = adapters.findIndex((existing) => existing.provider === deferred);
		if (moving === -1) {
			deferredBefore.delete(deferred);
			continue;
		}
		const [item] = adapters.splice(moving, 1);
		if (!item) continue;
		adapters.splice(adapters.findIndex((existing) => existing.provider === adapter.provider), 0, item);
		deferredBefore.delete(deferred);
	}
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

/**
 * External adapter packages register through the installed owner's event bus: every extension
 * has its own module root, so a direct import of this module could register into a foreign
 * registry instance instead of the owner's. The listener mirrors the inspector model
 * (`src/api/inspectors.ts`) and fills the request's `result` slot in place.
 */
export const PLACEMENT_REGISTER_EVENT = "pi-subagents:placement-register:v1";

export interface PlacementRegistration {
	dispose(): void;
}

export interface PlacementRegistrationRequest {
	version: 1;
	adapter: PlacementAdapterV1;
	/** Insert ahead of a registered fallback provider (e.g. "herdr") so third-party adapters get first claim on machine names. */
	before?: string;
	result?: { ok: true; registration: PlacementRegistration } | { ok: false; error: Error };
}

/** Listen on an owner runtime's event bus and apply placement registration requests to this registry. Returns the unsubscribe. */
export function registerPlacementEventListener(pi: Pick<ExtensionAPI, "events">): () => void {
	/* oxlint-disable anti-slop/no-runtime-typeof -- This listener validates the untyped event-bus boundary, including callable adapter methods. */
	const unsubscribe = pi.events.on(PLACEMENT_REGISTER_EVENT, (rawRequest) => {
		if (!rawRequest || typeof rawRequest !== "object" || Array.isArray(rawRequest)) return;
		// SAFETY: The envelope is an object; its version and adapter are validated below before storing callbacks.
		const request = rawRequest as Partial<PlacementRegistrationRequest>;
		if (request.result !== undefined) return;
		try {
			if (request.version !== 1) throw new Error(`Unsupported placement adapter registration version '${String(request.version)}'.`);
			const adapter = request.adapter;
			if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) throw new Error("Placement adapter must be an object.");
			const provider = typeof adapter.provider === "string" ? adapter.provider : String(adapter.provider);
			if (typeof adapter.openPlacedRun !== "function") throw new Error(`Placement adapter '${provider}' requires openPlacedRun().`);
			if (adapter.resolveMachinePlacement !== undefined && typeof adapter.resolveMachinePlacement !== "function") throw new Error(`Placement adapter '${provider}' resolveMachinePlacement must be a function when provided.`);
			registerPlacementAdapter(adapter as PlacementAdapterV1, { before: typeof request.before === "string" ? request.before : undefined });
			let disposed = false;
			request.result = {
				ok: true,
				registration: {
					dispose() {
						if (disposed) return;
						disposed = true;
						const index = adapters.indexOf(adapter as PlacementAdapterV1);
						if (index !== -1 && adapters[index] === adapter) adapters.splice(index, 1);
					},
				},
			};
		} catch (error) {
			request.result = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
		}
	});
	/* oxlint-enable anti-slop/no-runtime-typeof */
	return unsubscribe;
}
