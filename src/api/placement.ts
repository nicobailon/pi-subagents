import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PLACEMENT_REGISTER_EVENT, placementEditsLocalDisk, type PlacementAdapterV1, type PlacementRegistration, type PlacementRegistrationRequest } from "../runs/shared/placement-registry.ts";

/**
 * Public placement surface for external adapter packages (tmux, zellij, …). An adapter package
 * implements a `PlacementPaneHost` over its terminal multiplexer, exposes `openPlacedRun` on its
 * `PlacementAdapterV1` to connect and provision a run, and registers through
 * `registerPlacementAdapter(pi, adapter)` at extension load. Core drives the host-neutral bridge
 * engine itself: it stays provider-agnostic, never branches on a third-party provider, and
 * third-party machine references cross the registry as `PlacementOpaqueMachineReference`.
 */
export {
	PLACEMENT_REGISTER_EVENT,
	placementEditsLocalDisk,
	placementSupportsExternalCli,
	registerPlacementEventListener,
	type PlacementAdapterSettings,
	type PlacementAdapterV1,
	type PlacementOpaqueMachineReference,
	type PlacementRegistration,
	type PlacementRegistrationRequest,
	type PlacementResolveRequest,
	type PlacementResolution,
	type PlacementRunContext,
} from "../runs/shared/placement-registry.ts";
export {
	herdrPaneAllocationKey,
	withHerdrPaneAllocationLock,
	type PlacementAgentKind,
	type PlacementBridgeIdentity,
	type PlacementCommandOptions,
	type PlacementCommandResult,
	type PlacementEvidenceProof,
	type PlacementLaunchRequest,
	type PlacementMachineAccess,
	type PlacementOwnedPane,
	type PlacementPaneHost,
	type PlacementPromptOptions,
	type PlacementReconnectCheck,
	type PlacementRunState,
	type PlacementSocketForward,
	type PlacementSockets,
	type PlacementStartOptions,
} from "../runs/shared/placement-host.ts";
export {
	PLACED_MANIFEST_READ_SCRIPT,
	createPlacedRuntimeDir,
	discoverPlacedBridgeManifest,
	removePlacedRuntimeDir,
	type PlacedBridgeManifest,
} from "../runs/shared/placed-run-owner.ts";
export { remoteShellCommand, sshMachineAccess } from "../runs/shared/herdr-connection.ts";
export type { HerdrRunIdentity } from "../runs/shared/herdr-placed-run.ts";
export { localMachineAccess } from "../runs/shared/local-machine-access.ts";
export { getPiSpawnCommand } from "../runs/shared/pi-spawn.ts";
export type { PlacementMachineReference } from "../shared/types.ts";

export { remoteMachineCwd, validateRemoteCwd } from "../runs/shared/herdr-machine.ts";
/** Register through the installed owner, even when each extension has its own module root: the request crosses the owner's event bus (PLACEMENT_REGISTER_EVENT) and lands in the runtime's in-process registry. */
export function registerPlacementAdapter(pi: Pick<ExtensionAPI, "events">, adapter: PlacementAdapterV1, options: { before?: string } = {}): PlacementRegistration {
	const request: PlacementRegistrationRequest = { version: 1, adapter, before: options.before };
	pi.events.emit(PLACEMENT_REGISTER_EVENT, request);
	if (!request.result) throw new Error("pi-subagents is not installed, not ready, or does not support placement adapter registration.");
	if (!request.result.ok) throw request.result.error;
	return request.result.registration;
}
