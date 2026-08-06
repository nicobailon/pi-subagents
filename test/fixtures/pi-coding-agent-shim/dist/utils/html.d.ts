export interface DecodedHtmlEntity {
    text: string;
    length: number;
}
export declare function decodeHtmlEntity(entity: string): string | undefined;
export declare function decodeHtmlEntityAt(html: string, index: number): DecodedHtmlEntity | undefined;
//# sourceMappingURL=html.d.ts.map