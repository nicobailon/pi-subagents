export function backgroundProcessOptions(platform: NodeJS.Platform = process.platform): {
	detached: boolean;
	windowsHide: true;
} {
	return {
		detached: platform !== "win32",
		windowsHide: true,
	};
}
