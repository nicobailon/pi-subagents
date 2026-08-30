import { stableJsonDigest } from "./launch-contract.ts";
import type { WorkflowResourceProvenanceV1 } from "./types.ts";

export interface WorkflowChildPermitInput {
	issuerPackage: string;
	workflowRunId: string;
	childKey: string;
	agent: string;
	launchContractDigest: string;
	context: "fresh" | "fork";
}

export interface WorkflowChildPermitLaunch {
	workflowRunId: string;
	childKey: string;
	agent: string;
	launchContractDigest: string;
	context: "fresh" | "fork";
	runner: "pi";
}

export interface WorkflowChildPermitContext {
	permit: WorkflowChildPermit;
	workflowRunId: string;
	childKey: string;
}

export interface WorkflowChildPermit {
	readonly __workflowChildPermit: unique symbol;
}

interface WorkflowChildPermitRecord {
	issuerPackage: string;
	workflowRunId: string;
	childKey: string;
	agent: string;
	expectedProjectionDigest: string;
	state: "available" | "claimed" | "consumed";
}

const records = new WeakMap<object, WorkflowChildPermitRecord>();

function projectionDigest(input: Omit<WorkflowChildPermitLaunch, "workflowRunId">): string {
	return stableJsonDigest({
		version: 1,
		childKey: input.childKey,
		agent: input.agent,
		launchContractDigest: input.launchContractDigest,
		context: input.context,
		runner: input.runner,
	});
}

function required(value: string, label: string): string {
	if (!value.trim() || value !== value.trim()) throw new Error(`${label} must be a non-empty trimmed string.`);
	return value;
}

/** Package-internal first-slice permit. It is opaque, in-memory, and not serializable. */
export function createWorkflowChildPermit(input: WorkflowChildPermitInput): WorkflowChildPermit {
	const permit = Object.freeze(Object.create(null)) as WorkflowChildPermit;
	const record: WorkflowChildPermitRecord = {
		issuerPackage: required(input.issuerPackage, "issuerPackage"),
		workflowRunId: required(input.workflowRunId, "workflowRunId"),
		childKey: required(input.childKey, "childKey"),
		agent: required(input.agent, "agent"),
		expectedProjectionDigest: projectionDigest({
			childKey: input.childKey,
			agent: input.agent,
			launchContractDigest: required(input.launchContractDigest, "launchContractDigest"),
			context: input.context,
			runner: "pi",
		}),
		state: "available",
	};
	records.set(permit as object, record);
	return permit;
}

export function validateWorkflowChildPermitRoot(permit: WorkflowChildPermit, workflowRunId: string): string | undefined {
	const record = records.get(permit as object);
	if (!record) return "Workflow child permit is invalid.";
	if (record.state !== "available") return "Workflow child permit is already consumed.";
	if (record.workflowRunId !== workflowRunId) return "Workflow child permit does not match this workflow root.";
	return undefined;
}

/** Claim the first distinct launch attempt before validating its model-authored shape. */
export function claimWorkflowChildPermit(permit: WorkflowChildPermit, workflowRunId: string, childKey: string): string | undefined {
	const record = records.get(permit as object);
	if (!record) return "Workflow child permit is invalid.";
	if (record.state !== "available") return "Workflow child permit is already consumed.";
	if (record.workflowRunId !== workflowRunId) return "Workflow child permit does not match this workflow root.";
	record.state = record.childKey === childKey ? "claimed" : "consumed";
	if (record.childKey !== childKey) return "Workflow child permit child key mismatch.";
	return undefined;
}

/** Verify and permanently consume the permit before the one native process spawn. */
export function consumeWorkflowChildPermit(permit: WorkflowChildPermit, launch: WorkflowChildPermitLaunch): string | undefined {
	const record = records.get(permit as object);
	if (!record) return "Workflow child permit is invalid.";
	if (record.state === "available") return "Workflow child permit launch was not claimed.";
	if (record.state === "consumed") return "Workflow child permit is already consumed.";
	if (record.workflowRunId !== launch.workflowRunId) return "Workflow child permit does not match this workflow root.";
	record.state = "consumed";
	if (record.childKey !== launch.childKey) return "Workflow child permit child key mismatch.";
	if (record.agent !== launch.agent) return "Workflow child permit agent mismatch.";
	if (launch.runner !== "pi") return "Workflow child permit supports native Pi children only.";
	if (record.expectedProjectionDigest !== projectionDigest(launch)) return "Workflow child permit does not match the final launch projection.";
	return undefined;
}

export function workflowChildPermitConsumed(permit: WorkflowChildPermit): boolean {
	const state = records.get(permit as object)?.state;
	return state === "claimed" || state === "consumed";
}

export interface WorkflowResourceHostAuthority {
	keys: readonly string[];
	commands: readonly string[];
}

export interface WorkflowResourceAuthority {
	host?: WorkflowResourceHostAuthority;
}

export interface WorkflowResourcePermitInput {
	resourceName: string;
	resourceVersion: number;
	resourceId: string;
	scriptDigest: string;
	authority: WorkflowResourceAuthority;
}

export interface WorkflowResourcePermit {
	readonly __workflowResourcePermit: unique symbol;
}

interface WorkflowResourcePermitRecord {
	resourceName: string;
	resourceVersion: number;
	resourceId: string;
	scriptDigest: string;
	authority: WorkflowResourceAuthority;
	provenance: WorkflowResourceProvenanceV1;
	state: "available" | "consumed";
}

const resourceRecords = new WeakMap<object, WorkflowResourcePermitRecord>();

function cloneWorkflowResourceAuthority(authority: WorkflowResourceAuthority): WorkflowResourceAuthority {
	if (!authority || typeof authority !== "object" || Array.isArray(authority)) throw new Error("Workflow resource authority must be an object.");
	if (authority.host === undefined) return Object.freeze({});
	if (!authority.host || typeof authority.host !== "object" || Array.isArray(authority.host)) throw new Error("Workflow resource host authority must be an object.");
	const { keys, commands } = authority.host;
	if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string" || !key.trim())) throw new Error("Workflow resource host authority keys must be non-empty strings.");
	if (!Array.isArray(commands) || commands.some((command) => typeof command !== "string" || !command.trim())) throw new Error("Workflow resource host authority commands must be non-empty strings.");
	return Object.freeze({ host: Object.freeze({ keys: Object.freeze([...keys]), commands: Object.freeze([...commands]) }) });
}

/** Package-internal permit for a workflow resource resolved by the extension. */
export function createWorkflowResourcePermit(input: WorkflowResourcePermitInput): WorkflowResourcePermit {
	const resourceName = required(input.resourceName, "resourceName");
	const resourceId = required(input.resourceId, "resourceId");
	const scriptDigest = required(input.scriptDigest, "scriptDigest");
	if (!Number.isInteger(input.resourceVersion) || input.resourceVersion < 1) throw new Error("resourceVersion must be a positive integer.");
	const authority = cloneWorkflowResourceAuthority(input.authority);
	const permit = Object.freeze(Object.create(null)) as WorkflowResourcePermit;
	resourceRecords.set(permit as object, {
		resourceName,
		resourceVersion: input.resourceVersion,
		resourceId,
		scriptDigest,
		authority,
		provenance: Object.freeze({
			kind: "workflow",
			name: resourceName,
			version: input.resourceVersion,
			invocation: "named",
			expansion: "resolved",
			id: resourceId,
		}),
		state: "available",
	});
	return permit;
}

export function consumeWorkflowResourcePermit(permit: WorkflowResourcePermit, script: string): { provenance: WorkflowResourceProvenanceV1; authority: WorkflowResourceAuthority } | string {
	const record = resourceRecords.get(permit as object);
	if (!record) return "Workflow resource permit is invalid.";
	if (record.state !== "available") return "Workflow resource permit is already consumed.";
	if (stableJsonDigest(script) !== record.scriptDigest) return "Workflow resource permit does not match the resolved workflow script.";
	record.state = "consumed";
	return { provenance: record.provenance, authority: record.authority };
}

/** Validate a host call against the authority attached to a consumed resource. */
export function authorizeWorkflowResourceHost(permit: WorkflowResourcePermit, key: string, command: string): string | undefined {
	const record = resourceRecords.get(permit as object);
	if (!record || record.state !== "consumed") return "Workflow resource authority is unavailable.";
	const host = record.authority.host;
	if (!host) return "runs.host is not allowed for this workflow resource.";
	if (!host.keys.includes(key)) return `runs.host('${key}') is not allowed for workflow resource '${record.resourceName}'.`;
	if (!host.commands.includes(command.trim())) return `The command for runs.host('${key}') is not allowed for workflow resource '${record.resourceName}'.`;
	return undefined;
}
