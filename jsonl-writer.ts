import * as fs from "node:fs";

export interface DrainableSource {
	pause(): void;
	resume(): void;
}

export interface JsonlWriteStream {
	write(chunk: string): boolean;
	once(event: "drain", listener: () => void): JsonlWriteStream;
	end(callback?: () => void): void;
}

export interface JsonlWriterDeps {
	createWriteStream?: (filePath: string) => JsonlWriteStream;
}

export interface JsonlWriter {
	writeLine(line: string): void;
	close(): Promise<void>;
}

export function createJsonlWriter(
	filePath: string | undefined,
	source: DrainableSource,
	deps: JsonlWriterDeps = {},
): JsonlWriter {
	if (!filePath) {
		return {
			writeLine() {},
			async close() {},
		};
	}

	const createWriteStream = deps.createWriteStream ?? ((targetPath: string) => fs.createWriteStream(targetPath, { flags: "a" }));
	let stream: JsonlWriteStream | undefined;
	try {
		stream = createWriteStream(filePath);
	} catch {
		return {
			writeLine() {},
			async close() {},
		};
	}

	let backpressured = false;
	let closed = false;

	return {
		writeLine(line: string) {
			if (!stream || closed || !line.trim()) return;
			try {
				const ok = stream.write(`${line}\n`);
				if (!ok && !backpressured) {
					backpressured = true;
					source.pause();
					stream.once("drain", () => {
						backpressured = false;
						if (!closed) source.resume();
					});
				}
			} catch {}
		},
		async close() {
			if (!stream || closed) return;
			closed = true;
			const current = stream;
			stream = undefined;
			await new Promise<void>((resolve) => current.end(() => resolve()));
		},
	};
}
