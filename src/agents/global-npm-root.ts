import { exec, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Optional global package discovery; a failure never prevents local discovery. */
export async function resolveGlobalNpmRoot(options: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	timeoutMs?: number;
} = {}): Promise<string | null> {
	const env = options.env ?? process.env;
	const offline = env.PI_OFFLINE?.toLowerCase();
	if (offline === "1" || offline === "true" || offline === "yes") return null;

	if ((options.platform ?? process.platform) === "win32" && env.APPDATA) {
		const appDataRoot = path.join(env.APPDATA, "npm", "node_modules");
		try {
			if ((await fs.stat(appDataRoot)).isDirectory()) return await fs.realpath(appDataRoot);
		} catch {
			// Invalid APPDATA roots fall back to npm (including disappearing directories).
		}
	}

	const timeoutMs = options.timeoutMs ?? 5000;
	const output = await new Promise<string | null>((resolve) => {
		let settled = false;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const commandOptions = {
			encoding: "utf8",
			timeout: timeoutMs,
			windowsHide: true,
			env,
			maxBuffer: 64 * 1024,
		} as const;
		// POSIX npm is executable directly: killing a shell would leave npm running.
		// Windows npm.cmd requires a shell, matching the existing command behavior.
		const callback = (error: Error | null, stdout: string) => finish(error ? null : stdout.trim());
		const child = (options.platform ?? process.platform) === "win32"
			? exec("npm root -g", commandOptions, callback)
			: execFile("npm", ["root", "-g"], commandOptions, callback);
		// Resolve at the deadline even if inherited pipes hold the callback open.
		const timer = setTimeout(() => {
			child.kill();
			finish(null);
		}, timeoutMs);
	});
	if (!output) return null;
	try {
		return await fs.realpath(output);
	} catch {
		return null;
	}
}
