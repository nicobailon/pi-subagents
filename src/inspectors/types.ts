import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details } from "../shared/types.ts";

export const INSPECTOR_ACTIONS = ["inspector.open", "inspector.command", "inspector.status", "inspector.close"] as const;
export type InspectorAction = typeof INSPECTOR_ACTIONS[number];

export interface InspectorParams {
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
	focus?: boolean;
}

export interface InspectorTarget {
	runId: string;
	asyncDir: string;
	index?: number;
	status: {
		cwd?: string;
		state: string;
		steps?: unknown[];
	};
}

export interface InspectorContext {
	cwd: string;
	signal?: AbortSignal;
	env: NodeJS.ProcessEnv;
	now?: () => Date;
	target: InspectorTarget;
}

export interface InspectorLaunch {
	executable: string;
	argv: string[];
	displayCommand: string;
	mission?: { id: string; path: string };
	allowSteer: boolean;
	allowStop: boolean;
	sessionRoots: string[];
}

export interface InspectorPlugin {
	readonly name: string;
	available(context: InspectorContext): Promise<boolean> | boolean;
	owns(context: InspectorContext): boolean;
	open(context: InspectorContext, launch: InspectorLaunch, params: InspectorParams): Promise<AgentToolResult<Details>>;
	status?(context: InspectorContext): Promise<AgentToolResult<Details>>;
	close?(context: InspectorContext): Promise<AgentToolResult<Details>>;
}
