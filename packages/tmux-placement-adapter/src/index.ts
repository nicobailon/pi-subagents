import {
	registerPlacementAdapter,
	safeRunId,
	serializeHerdrPiLaunch,
	startPlacedPiSession,
	type ChildSession,
	type ChildSessionLaunch,
	type PlacementOpaqueMachineReference,
	type PlacementAdapterV1,
	type PlacementRegistration,
	type PlacementResolveRequest,
	type PlacementResolution,
} from "../../../src/api/placement.ts";
import { resolveTmuxMachinePlacement, TMUX_PROVIDER, type TmuxMachineReference } from "./tmux-machine.ts";
import { TmuxPlacedRunOwner } from "./tmux-pane-host.ts";

/**
 * The tmux placement adapter: resolves `machine: "tmux"` and `subagents.machines.<id>.tmux.ssh` machines to tmux
 * machine references and places child Pi sessions in tmux windows through the host-neutral bridge engine.
 */
export function tmuxPlacementAdapter(): PlacementAdapterV1 {
	return {
		kind: "pi-subagents.placement-adapter",
		version: 1,
		provider: TMUX_PROVIDER,
		resolveMachinePlacement: resolveTmuxMachinePlacement,
		createPlacedPiSession: createTmuxPiSession,
	};
}

/** Places one child Pi session in a tmux window (local, or over SSH for a settings-named machine). */
export async function createTmuxPiSession(launch: ChildSessionLaunch): Promise<ChildSession> {
	// The machine crossed the registry as an opaque reference; typing only knows the builtin union.
	const machine = launch.machine as PlacementOpaqueMachineReference | undefined;
	if (machine?.provider !== TMUX_PROVIDER) throw new Error(`The tmux adapter only places runs on '${TMUX_PROVIDER}' machines.`);
	const policy = serializeHerdrPiLaunch(launch);
	const runId = safeRunId(launch.runtime.runId);
	return startPlacedPiSession(launch, await TmuxPlacedRunOwner.create(machine as unknown as TmuxMachineReference, runId), policy);
}

/** Registers the tmux adapter through the installed pi-subagents runtime; tmux machines resolve ahead of the Herdr catalog fallback. */
export function registerTmuxPlacementAdapter(pi: Parameters<typeof registerPlacementAdapter>[0], options: { before?: string } = {}): PlacementRegistration {
	return registerPlacementAdapter(pi, tmuxPlacementAdapter(), { before: "herdr", ...options });
}

export { resolveTmuxMachinePlacement, TMUX_PROVIDER, TMUX_SESSION_LABEL, type TmuxMachineReference } from "./tmux-machine.ts";
export { connectTmux, closeOwnedTmuxPane, TmuxPlacedRunOwner, tmuxPaneHost, type TmuxConnection, type TmuxPaneCandidate } from "./tmux-pane-host.ts";
