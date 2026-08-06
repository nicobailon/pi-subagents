export type ClipboardImage = {
    bytes: Uint8Array;
    mimeType: string;
};
export declare function isWaylandSession(env?: NodeJS.ProcessEnv): boolean;
export declare function extensionForImageMimeType(mimeType: string): string | null;
export declare function readClipboardImage(options?: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null>;
//# sourceMappingURL=clipboard-image.d.ts.map