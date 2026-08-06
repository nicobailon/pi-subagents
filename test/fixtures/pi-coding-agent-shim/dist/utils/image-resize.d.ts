import { type ImageResizeOptions, type ResizedImage } from "./image-resize-core.ts";
export type { ImageResizeOptions, ResizedImage } from "./image-resize-core.ts";
/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Runs Photon in a worker thread so WASM decoding, resizing, and encoding do not
 * block the TUI event loop. If the worker cannot be loaded (for example in some
 * Bun compiled executable layouts), fall back to in-process resizing so image
 * reads still work.
 */
export declare function resizeImage(inputBytes: Uint8Array, mimeType: string, options?: ImageResizeOptions): Promise<ResizedImage | null>;
/**
 * Format a dimension note for resized images.
 * This helps the model understand the coordinate mapping.
 */
export declare function formatDimensionNote(result: ResizedImage): string | undefined;
//# sourceMappingURL=image-resize.d.ts.map