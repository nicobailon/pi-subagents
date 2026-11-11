import { remoteMachineCwd, validateRemoteCwd, type PlacementResolveRequest, type PlacementResolution } from "../../../src/api/placement.ts";

/** A tmux placement target: the parent's own tmux server (`machine: "tmux"`) or one reached over SSH from settings (`subagents.machines.<id>.tmux.ssh`). */
export interface TmuxLocalMachineReference { provider: "tmux"; id: "local"; session: string; socket?: string; cwd: string; [key: string]: unknown }
export interface TmuxSshMachineReference { provider: "tmux"; id: string; target: string; session: string; socket?: string; cwd: string; [key: string]: unknown }
export type TmuxMachineReference = TmuxLocalMachineReference | TmuxSshMachineReference;

export const TMUX_PROVIDER = "tmux";

/** The one tmux session pi-subagents places children in, locally and over SSH. */
export const TMUX_SESSION_LABEL = "pi-subagents";

export function isTmuxLocalMachine(machine: TmuxMachineReference): machine is TmuxLocalMachineReference { return machine.id === "local"; }

/** Adapter-side view of one machine settings entry; the core hands entries over opaquely and stays tmux-agnostic. */
export interface TmuxMachineSettings { cwd?: string; env?: Record<string, string>; tmux?: { ssh?: string; socket?: string } }

/** tmux resolver: `machine: "tmux"` places locally, a settings entry with `tmux.ssh` places on that machine over SSH, anything else is declined. */
export function resolveTmuxMachinePlacement(request: PlacementResolveRequest): PlacementResolution | undefined {
	const settings = request.settings as TmuxMachineSettings | undefined;
	const ssh = settings?.tmux?.ssh;
	if (request.machine === TMUX_PROVIDER) {
		if (ssh !== undefined) throw new Error(`Machine '${request.machine}' is reserved for local tmux placement; it must not also carry a tmux.ssh setting.`);
		// target records provenance the placed-run journal shows: the parent's own machine.
		return { machine: { provider: TMUX_PROVIDER, id: "local", target: "local", session: TMUX_SESSION_LABEL, socket: settings?.tmux?.socket, cwd: request.stepCwd ?? request.cwd } };
	}
	if (ssh === undefined) return undefined;
	return { machine: { provider: TMUX_PROVIDER, id: request.machine, target: ssh, session: TMUX_SESSION_LABEL, socket: settings?.tmux?.socket, cwd: validateRemoteCwd(remoteMachineCwd(request.stepCwd, settings?.cwd, request.machine), request.machine) } };
}
