export type FileWatchPurpose =
	| "result-delivery"
	| "supervisor-channel"
	| "async-job-tracker"
	| "retained-nested-route-tracker"
	| "runner-control-inbox"
	| "child-steering-inbox";

export function shouldUseNativeFsWatch(_purpose: FileWatchPurpose, platform: NodeJS.Platform = process.platform): boolean {
	if (_purpose === "retained-nested-route-tracker" && platform === "win32") return false;
	return platform !== "darwin";
}
