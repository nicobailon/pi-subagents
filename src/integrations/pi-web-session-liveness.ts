import { hasLiveNestedDescendants, projectNestedEvents } from "../runs/shared/nested-events.ts";
import type { NestedRouteInfo, SubagentState } from "../shared/types.ts";

export const PI_WEB_SESSION_LIVENESS_REGISTRY_KEY = "@agegr/pi-web/session-liveness/v1";
const PI_WEB_SESSION_LIVENESS_PROTOCOL_VERSION = 1;

interface PiWebSessionLivenessProvider {
	name: string;
	sessionId: string;
	sessionFile?: string;
	isActive(): boolean;
}

interface PiWebSessionLivenessRegistry {
	version: typeof PI_WEB_SESSION_LIVENESS_PROTOCOL_VERSION;
	register(provider: PiWebSessionLivenessProvider): () => void;
}

type SessionLivenessRegistration = Omit<PiWebSessionLivenessProvider, "name">;

export interface PiWebSessionLivenessHandle {
	/** True only when the compatible host accepted the provider registration. */
	registered: boolean;
	release: () => void;
}

type LiveWorkState = Pick<SubagentState, "asyncJobs" | "foregroundControls" | "retainedForegroundNestedRoutes">;

function resolveRegistry(): PiWebSessionLivenessRegistry | null {
	const value = (globalThis as Record<PropertyKey, unknown>)[Symbol.for(PI_WEB_SESSION_LIVENESS_REGISTRY_KEY)];
	if (!value || typeof value !== "object") return null;
	const registry = value as Partial<PiWebSessionLivenessRegistry>;
	if (registry.version !== PI_WEB_SESSION_LIVENESS_PROTOCOL_VERSION || typeof registry.register !== "function") return null;
	return registry as PiWebSessionLivenessRegistry;
}

export function retainLiveForegroundNestedRoute(state: Pick<SubagentState, "retainedForegroundNestedRoutes">, route: NestedRouteInfo): boolean {
	const nested = projectNestedEvents(route);
	if (!hasLiveNestedDescendants(nested.children)) return false;
	state.retainedForegroundNestedRoutes ??= new Map();
	state.retainedForegroundNestedRoutes.set(route.rootRunId, route);
	return true;
}

export function hasLiveSubagentWork(state: LiveWorkState): boolean {
	for (const job of state.asyncJobs.values()) {
		if (job.status === "queued" || job.status === "running" || hasLiveNestedDescendants(job.nestedChildren)) return true;
	}
	for (const control of state.foregroundControls.values()) {
		if ((control.schedulingOwners ?? 0) > 0
			|| (control.activeChildren?.size ?? 0) > 0
			|| hasLiveNestedDescendants(control.nestedChildren)) return true;
	}
	return (state.retainedForegroundNestedRoutes?.size ?? 0) > 0;
}

export function registerPiWebSessionLiveness(registration: SessionLivenessRegistration): PiWebSessionLivenessHandle {
	const registry = resolveRegistry();
	if (!registry) return { registered: false, release: () => {} };
	try {
		const release = registry.register({
			name: "pi-subagents",
			sessionId: registration.sessionId,
			...(registration.sessionFile ? { sessionFile: registration.sessionFile } : {}),
			isActive: registration.isActive,
		});
		if (typeof release === "function") return { registered: true, release };
		console.error("Failed to register pi-web session liveness: host registry returned no release function.");
	} catch (error) {
		console.error("Failed to register pi-web session liveness:", error);
	}
	return { registered: false, release: () => {} };
}
