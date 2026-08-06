/**
 * ANSI escape code to HTML converter.
 *
 * Converts terminal ANSI color/style codes to HTML with inline styles.
 * Supports:
 * - Standard foreground colors (30-37) and bright variants (90-97)
 * - Standard background colors (40-47) and bright variants (100-107)
 * - 256-color palette (38;5;N and 48;5;N)
 * - RGB true color (38;2;R;G;B and 48;2;R;G;B)
 * - Text styles: bold (1), dim (2), italic (3), underline (4)
 * - Reset (0)
 */
/**
 * Convert ANSI-escaped text to HTML with inline styles.
 */
export declare function ansiToHtml(text: string): string;
/**
 * Convert array of ANSI-escaped lines to HTML.
 * Each line is wrapped in a div element.
 */
export declare function ansiLinesToHtml(lines: string[]): string;
//# sourceMappingURL=ansi-to-html.d.ts.map