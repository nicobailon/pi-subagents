/**
 * Windows PowerShell has no backslash-escape for embedded double quotes: a
 * double-quoted string literal only recognizes `` `" `` or `""` to embed a
 * literal quote, so a naively-quoted JSON array (which is full of `"` and
 * `\` characters) gets truncated or split into multiple argv tokens the
 * moment PowerShell tokenizes the `pane run` command line.
 *
 * Base64 has no quotes, backslashes, or spaces for any shell to mangle, so
 * encoding the `--session-roots` payload sidesteps quoting entirely. It is
 * also plain ASCII, so it never hits shellQuote's Windows quoting branch in
 * a way that could still fail as new characters are added upstream.
 */
export function encodeSessionRoots(roots: readonly string[]): string {
	return Buffer.from(JSON.stringify(roots), "utf-8").toString("base64");
}

function parseStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.some((root) => typeof root !== "string")) return undefined;
	return value;
}

/** Decodes a `--session-roots` argument produced by {@link encodeSessionRoots}. */
export function decodeSessionRoots(raw: string): string[] {
	try {
		const decoded = parseStringArray(JSON.parse(Buffer.from(raw, "base64").toString("utf-8")));
		if (decoded) return decoded;
	} catch {
		// Report one stable validation error below.
	}
	throw new Error("--session-roots must be a base64-encoded JSON array of strings.");
}
