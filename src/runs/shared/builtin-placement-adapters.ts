import { createHerdrPiSession, createRexPiSession } from "./herdr-placed-run.ts";
import { resolveHerdrMachinePlacement, remoteMachineCwd, validateRemoteCwd, type ResolveHerdrMachinePlacementInput } from "./herdr-machine.ts";
import { registerPlacementAdapter, type PlacementResolveRequest } from "./placement-registry.ts";
import { REX_LOCAL_MACHINE, resolveRexLocalPlacement } from "./rex-machine.ts";

/**
 * The built-in version-1 placement adapters. Rex registers first so the reserved `local` machine
 * and user-settings Rex SSH hosts resolve before the Herdr catalog fallback, preserving the
 * pre-registry resolution order exactly.
 */


function resolveRexMachinePlacement(request: PlacementResolveRequest) {
	const { machine, settings, stepCwd, cwd, env } = request;
	if (machine === REX_LOCAL_MACHINE) {
		if (settings?.rex) throw new Error("Machine 'local' is reserved for a Rex pane on this machine; give the Rex SSH host in subagents.machines.local.rex another name.");
		return { machine: resolveRexLocalPlacement({ cwd, stepCwd, env }) };
	}
	if (settings?.rex) return { machine: { provider: "rex" as const, id: machine, target: settings.rex.ssh, cwd: validateRemoteCwd(remoteMachineCwd(stepCwd, settings.cwd, machine), machine) } };
	return undefined;
}

registerPlacementAdapter({ kind: "pi-subagents.placement-adapter", version: 1, provider: "rex", createPlacedPiSession: createRexPiSession, resolveMachinePlacement: resolveRexMachinePlacement });

registerPlacementAdapter({
	kind: "pi-subagents.placement-adapter",
	version: 1,
	provider: "herdr",
	createPlacedPiSession: createHerdrPiSession,
	resolveMachinePlacement: (request: PlacementResolveRequest) => resolveHerdrMachinePlacement(request as ResolveHerdrMachinePlacementInput),
});
