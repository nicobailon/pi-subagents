import {
	registerPlacementAdapter,
	type PlacementAdapterV1,
	type PlacementRegistration,
} from "../../../src/api/placement.ts";
import { resolveTmuxMachinePlacement, TMUX_PROVIDER } from "./tmux-machine.ts";
import { asTmuxMachine, openTmuxPlacedRun } from "./tmux-pane-host.ts";

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
		openPlacedRun: (machine, runId) => openTmuxPlacedRun(asTmuxMachine(machine), runId),
	};
}


/** Registers the tmux adapter through the installed pi-subagents runtime; tmux machines resolve ahead of the Herdr catalog fallback. */
export function registerTmuxPlacementAdapter(pi: Parameters<typeof registerPlacementAdapter>[0], options: { before?: string } = {}): PlacementRegistration {
	return registerPlacementAdapter(pi, tmuxPlacementAdapter(), { before: "herdr", ...options });
}

export { resolveTmuxMachinePlacement, TMUX_PROVIDER, TMUX_SESSION_LABEL, type TmuxMachineReference } from "./tmux-machine.ts";
export { connectTmux, closeOwnedTmuxPane, openTmuxPlacedRun, tmuxPaneHost, type TmuxConnection, type TmuxPaneCandidate } from "./tmux-pane-host.ts";
