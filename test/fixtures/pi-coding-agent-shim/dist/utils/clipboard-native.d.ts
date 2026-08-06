export type ClipboardModule = {
    getText: () => Promise<string>;
    setText: (text: string) => Promise<void>;
    hasImage: () => boolean;
    getImageBinary: () => Promise<Array<number>>;
};
type ClipboardRequire = (id: string) => unknown;
export declare function loadClipboardNative(requires?: readonly ClipboardRequire[]): ClipboardModule | null;
declare const clipboard: ClipboardModule | null;
export { clipboard };
//# sourceMappingURL=clipboard-native.d.ts.map