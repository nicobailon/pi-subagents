import { exec, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Optional global package discovery; a failure never prevents local discovery. */
export async function resolveGlobalNpmRoot(options: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	timeoutMs?: number;
	signal?: AbortSignal;
} = {}): Promise<string | null> {
	const signal = options.signal;
	if (signal?.aborted) return null;
	const env = options.env ?? process.env;
	const offline = env.PI_OFFLINE?.toLowerCase();
	if (offline === "1" || offline === "true" || offline === "yes") return null;

	if ((options.platform ?? process.platform) === "win32" && env.APPDATA) {
		const appDataRoot = path.join(env.APPDATA, "npm", "node_modules");
		try {
			if ((await fs.stat(appDataRoot)).isDirectory()) {
				const root = await fs.realpath(appDataRoot);
				return signal?.aborted ? null : root;
			}
		} catch {
			// Invalid APPDATA roots fall back to npm (including disappearing directories).
		}
	}

	if (signal?.aborted) return null;
	const timeoutMs = options.timeoutMs ?? 5000;
	const output = await new Promise<string | null>((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
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
		const cancel = () => {
			child.kill();
			finish(null);
		};
		// Resolve at the deadline even if inherited pipes hold the callback open.
		timer = setTimeout(cancel, timeoutMs);
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
	});
	if (!output || signal?.aborted) return null;
	try {
		const root = await fs.realpath(output);
		return signal?.aborted ? null : root;
	} catch {
		return null;
	}
}
