import { type ImageResizeOptions } from "./image-resize.ts";
export interface ProcessImageOptions {
    /** Whether to resize images to inline provider limits. Default: true */
    autoResizeImages?: boolean;
    /** Optional resize overrides. Uses resizeImage defaults when omitted. */
    resizeOptions?: ImageResizeOptions;
}
export type ProcessImageResult = {
    ok: true;
    data: string;
    mimeType: string;
    hints: string[];
} | {
    ok: false;
    message: string;
};
export declare function processImage(bytes: Uint8Array, mimeType: string, options?: ProcessImageOptions): Promise<ProcessImageResult>;
//# sourceMappingURL=image-process.d.ts.map