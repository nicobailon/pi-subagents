export declare function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null>;
/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 */
export declare function convertToPng(base64Data: string, mimeType: string): Promise<{
    data: string;
    mimeType: string;
} | null>;
//# sourceMappingURL=image-convert.d.ts.map