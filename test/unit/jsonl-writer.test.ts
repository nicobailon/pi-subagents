import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createJsonlWriter, type DrainableSource, type JsonlWriteStream } from "../../src/shared/jsonl-writer.ts";

class MockSource implements DrainableSource {
	paused = 0;
	resumed = 0;
	pause(): void {
		this.paused++;
	}
	resume(): void {
		this.resumed++;
	}
}

class MockStream implements JsonlWriteStream {
	writes: string[] = [];
	ended = false;
	private drainHandler?: () => void;
	private readonly writeResults: boolean[];
	constructor(writeResults: boolean[] = []) {
		this.writeResults = writeResults;
	}
	write(chunk: string): boolean {
		this.writes.push(chunk);
		if (this.writeResults.length === 0) return true;
		return this.writeResults.shift() ?? true;
	}
	once(event: "drain", listener: () => void): JsonlWriteStream {
		if (event === "drain") this.drainHandler = listener;
		return this;
	}
	end(callback?: () => void): void {
		this.ended = true;
		callback?.();
	}
	emitDrain(): void {
		this.drainHandler?.();
	}
}

describe("createJsonlWriter", () => {
	it("writes lines with trailing newline", () => {
		const source = new MockSource();
		const stream = new MockStream();
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
		});
		writer.writeLine('{"type":"a"}');
		writer.writeLine('{"type":"b"}');
		assert.deepEqual(stream.writes, ['{"type":"a"}\n', '{"type":"b"}\n']);
	});

	it("pauses on backpressure and resumes on drain", () => {
		const source = new MockSource();
		const stream = new MockStream([false, true]);
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
		});
		writer.writeLine('{"type":"a"}');
		assert.equal(source.paused, 1);
		assert.equal(source.resumed, 0);
		stream.emitDrain();
		assert.equal(source.resumed, 1);
		writer.writeLine('{"type":"b"}');
		assert.deepEqual(stream.writes, ['{"type":"a"}\n', '{"type":"b"}\n']);
	});

	it("closes stream once", async () => {
		const source = new MockSource();
		const stream = new MockStream();
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
		});
		await writer.close();
		assert.equal(stream.ended, true);
		await writer.close();
		assert.equal(stream.ended, true);
	});

	it("returns no-op writer when file path is undefined", async () => {
		const source = new MockSource();
		const writer = createJsonlWriter(undefined, source);
		writer.writeLine('{"type":"a"}');
		await writer.close();
		assert.equal(source.paused, 0);
		assert.equal(source.resumed, 0);
	});

	it("stops writing when maxBytes exceeded without pausing source", () => {
		const source = new MockSource();
		const stream = new MockStream();
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
			maxBytes: 30,
		});
		writer.writeLine('{"type":"a"}');
		writer.writeLine('{"type":"b"}');
		writer.writeLine('{"type":"c"}');
		assert.equal(stream.writes.length, 2);
		assert.deepEqual(stream.writes, ['{"type":"a"}\n', '{"type":"b"}\n']);
		assert.equal(source.paused, 0);
	});

	it("creates a private JSONL file", { skip: process.platform === "win32" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jsonl-writer-"));
		try {
			const file = path.join(dir, "child.jsonl");
			const writer = createJsonlWriter(file, new MockSource());
			writer.writeLine('{"type":"private"}');
			await writer.close();
			assert.equal(fs.statSync(file).mode & 0o777, 0o600);
			assert.equal(fs.readFileSync(file, "utf-8"), '{"type":"private"}\n');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not follow a JSONL symlink", { skip: process.platform === "win32" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jsonl-writer-"));
		try {
			const target = path.join(dir, "target.jsonl");
			const link = path.join(dir, "child.jsonl");
			fs.writeFileSync(target, "keep\n");
			fs.symlinkSync(target, link);
			const writer = createJsonlWriter(link, new MockSource());
			writer.writeLine('{"type":"forged"}');
			await writer.close();
			assert.equal(fs.readFileSync(target, "utf-8"), "keep\n");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("allows writes up to exactly maxBytes", () => {
		const source = new MockSource();
		const stream = new MockStream();
		const line = '{"x":"a"}';
		const lineBytes = Buffer.byteLength(`${line}\n`, "utf-8");
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
			maxBytes: lineBytes * 2,
		});
		writer.writeLine(line);
		writer.writeLine(line);
		writer.writeLine(line);
		assert.equal(stream.writes.length, 2);
	});
});
