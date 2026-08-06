import { Container } from "@earendil-works/pi-tui";
import type { EntryRenderer } from "../../../core/extensions/types.ts";
import type { CustomEntry } from "../../../core/session-manager.ts";
/**
 * Component that renders a custom session entry from extensions.
 * The host owns transcript spacing; renderer output should provide only its content.
 */
export declare class CustomEntryComponent extends Container {
    private entry;
    private renderer;
    private customComponent?;
    private _expanded;
    constructor(entry: CustomEntry<unknown>, renderer: EntryRenderer);
    hasContent(): boolean;
    setExpanded(expanded: boolean): void;
    invalidate(): void;
    private rebuild;
}
//# sourceMappingURL=custom-entry.d.ts.map