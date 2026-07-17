import { spawn } from "node:child_process";
import * as path from "node:path";

export interface EditorSpec {
	command: string;
	args: string[];
}

/** Resolve a blocking graphical editor command. Pi owns the terminal, so terminal editors are unsupported. */
export function resolveEditorCommand(): EditorSpec | undefined {
	const raw = (process.env.VISUAL || process.env.EDITOR || "").trim()
		|| (process.platform === "darwin" ? "open -W -n -a MarkEdit" : "");
	if (!raw) return undefined;

	const parts: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < raw.length; index++) {
		const char = raw[index]!;
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && raw[index + 1] === quote) current += raw[++index]!;
			else current += char;
		} else if (char === "'" || char === '"') {
			quote = char;
		} else if (/\s/.test(char)) {
			if (current) {
				parts.push(current);
				current = "";
			}
		} else if (char === "\\" && raw[index + 1] && /[\s'"\\]/.test(raw[index + 1]!)) {
			current += raw[++index]!;
		} else {
			current += char;
		}
	}
	if (quote) throw new Error("The configured editor command contains an unmatched quote.");
	if (current) parts.push(current);
	if (parts.length === 0) return undefined;
	return { command: parts[0]!, args: parts.slice(1) };
}

export function editorLabel(editor: EditorSpec): string {
	const appIdx = editor.args.indexOf("-a");
	if (editor.command === "open" && appIdx !== -1 && editor.args[appIdx + 1]) return editor.args[appIdx + 1]!;
	return editor.command;
}

function escapeWindowsCommand(value: string): string {
	return value.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1");
}

function escapeWindowsArgument(value: string, doubleEscapeMetaChars: boolean): string {
	let escaped = value
		.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"")
		.replace(/(?=(\\+?)?)\1$/, "$1$1");
	escaped = `"${escaped}"`.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1");
	return doubleEscapeMetaChars
		? escaped.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1")
		: escaped;
}

export function runEditorAndWait(editor: EditorSpec, filePath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const editorArgs = [...editor.args, filePath];
		const child = process.platform === "win32" && !/\.(?:com|exe)$/i.test(editor.command)
			? (() => {
				const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(editor.command);
				const commandLine = [
					escapeWindowsCommand(path.normalize(editor.command)),
					...editorArgs.map((arg) => escapeWindowsArgument(arg, doubleEscape)),
				].join(" ");
				return spawn(process.env.ComSpec || process.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", `"${commandLine}"`], {
					stdio: "ignore",
					windowsVerbatimArguments: true,
				});
			})()
			: spawn(editor.command, editorArgs, { stdio: "ignore" });
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) resolve();
			else if (signal) reject(new Error(`${editor.command} terminated by ${signal}`));
			else reject(new Error(`${editor.command} exited with code ${code ?? "unknown"}`));
		});
	});
}
