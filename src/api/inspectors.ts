import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InspectorPlugin } from "../inspectors/types.ts";

export type { InspectorContext, InspectorLaunch, InspectorParams, InspectorPlugin, InspectorTarget } from "../inspectors/types.ts";

export const INSPECTOR_REGISTER_EVENT = "pi-subagents:inspector-register:v1";

export interface InspectorRegistration {
	dispose(): void;
}

export interface InspectorRegistrationRequest {
	version: 1;
	plugin: InspectorPlugin;
	result?:
		| { ok: true; registration: InspectorRegistration }
		| { ok: false; error: Error };
}

/** Register with the installed owner, even when each extension has its own module root. */
export function registerInspector(pi: Pick<ExtensionAPI, "events">, plugin: InspectorPlugin): InspectorRegistration {
	const request: InspectorRegistrationRequest = { version: 1, plugin };
	pi.events.emit(INSPECTOR_REGISTER_EVENT, request);
	if (!request.result) throw new Error("pi-subagents is not installed, not ready, or does not support inspector registration.");
	if (!request.result.ok) throw request.result.error;
	return request.result.registration;
}
