export type FileWatchPurpose =
	| "result-delivery"
	| "supervisor-channel"
	| "async-job-tracker"
	| "runner-control-inbox"
	| "child-steering-inbox";

export function shouldUseNativeFsWatch(_purpose: FileWatchPurpose, platform: NodeJS.Platform = process.platform): boolean {
	return platform !== "darwin";
}
