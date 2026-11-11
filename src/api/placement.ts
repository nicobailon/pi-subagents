import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PLACEMENT_REGISTER_EVENT, type PlacementAdapterV1, type PlacementRegistration, type PlacementRegistrationRequest } from "../runs/shared/placement-registry.ts";

/**
 * Public placement surface for external adapter packages (tmux, zellij, …). An adapter package
 * implements a `PlacementPaneHost` over its terminal multiplexer, drives the host-neutral
 * bridge with a `PlacedRunOwner`, and registers a `PlacementAdapterV1` through
 * `registerPlacementAdapter(pi, adapter)` at extension load. Core stays provider-agnostic:
 * it never branches on a third-party provider, and third-party machine references cross the
 * registry as `PlacementOpaqueMachineReference`.
 */
export {
	PLACEMENT_REGISTER_EVENT,
	registerPlacementEventListener,
	type PlacementAdapterSettings,
	type PlacementAdapterV1,
	type PlacementOpaqueMachineReference,
	type PlacementRegistration,
	type PlacementRegistrationRequest,
	type PlacementResolveRequest,
	type PlacementResolution,
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
	type PlacedRunOwner,
} from "../runs/shared/placed-run-owner.ts";
export {
	BridgeChannel,
	HerdrPiSession,
	serializeHerdrPiLaunch,
	startPlacedPiSession,
	type HerdrRunIdentity,
	type HerdrRunSnapshot,
} from "../runs/shared/herdr-placed-run.ts";
export { remoteShellCommand, sshMachineAccess } from "../runs/shared/herdr-connection.ts";
export { localMachineAccess } from "../runs/shared/local-machine-access.ts";
export { getPiSpawnCommand } from "../runs/shared/pi-spawn.ts";
export type { ChildSession, ChildSessionLaunch } from "../runs/shared/child-session.ts";
export type { PlacementMachineReference } from "../shared/types.ts";

/** Register through the installed owner, even when each extension has its own module root: the request crosses the owner's event bus (PLACEMENT_REGISTER_EVENT) and lands in the runtime's in-process registry. */
export function registerPlacementAdapter(pi: Pick<ExtensionAPI, "events">, adapter: PlacementAdapterV1, options: { before?: string } = {}): PlacementRegistration {
	const request: PlacementRegistrationRequest = { version: 1, adapter, before: options.before };
	pi.events.emit(PLACEMENT_REGISTER_EVENT, request);
	if (!request.result) throw new Error("pi-subagents is not installed, not ready, or does not support placement adapter registration.");
	if (!request.result.ok) throw request.result.error;
	return request.result.registration;
}
