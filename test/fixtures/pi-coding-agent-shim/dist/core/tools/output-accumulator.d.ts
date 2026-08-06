import { type TruncationResult } from "./truncate.ts";
export interface OutputAccumulatorOptions {
    maxLines?: number;
    maxBytes?: number;
    tempFilePrefix?: string;
}
export interface OutputSnapshot {
    content: string;
    truncation: TruncationResult;
    fullOutputPath?: string;
}
/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export declare class OutputAccumulator {
    private readonly maxLines;
    private readonly maxBytes;
    private readonly maxRollingBytes;
    private readonly tempFilePrefix;
    private readonly decoder;
    private rawChunks;
    private tailText;
    private tailBytes;
    private tailStartsAtLineBoundary;
    private totalRawBytes;
    private totalDecodedBytes;
    private completedLines;
    private totalLines;
    private currentLineBytes;
    private hasOpenLine;
    private finished;
    private tempFilePath;
    private tempFileStream;
    constructor(options?: OutputAccumulatorOptions);
    append(data: Buffer): void;
    finish(): void;
    snapshot(options?: {
        persistIfTruncated?: boolean;
    }): OutputSnapshot;
    closeTempFile(): Promise<void>;
    getLastLineBytes(): number;
    private appendDecodedText;
    private trimTail;
    private getSnapshotText;
    private shouldUseTempFile;
    private ensureTempFile;
}
//# sourceMappingURL=output-accumulator.d.ts.map