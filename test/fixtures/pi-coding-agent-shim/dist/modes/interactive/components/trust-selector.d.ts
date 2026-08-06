import { Container } from "@earendil-works/pi-tui";
import { type ProjectTrustOption, type ProjectTrustStoreEntry } from "../../../core/trust-manager.ts";
export type TrustSelection = Pick<ProjectTrustOption, "trusted" | "updates">;
export interface TrustSelectorOptions {
    cwd: string;
    savedDecision: ProjectTrustStoreEntry | null;
    projectTrusted: boolean;
    onSelect: (selection: TrustSelection) => void;
    onCancel: () => void;
}
export declare class TrustSelectorComponent extends Container {
    private selectedIndex;
    private readonly listContainer;
    private readonly trustOptions;
    private readonly savedDecision;
    private readonly onSelectCallback;
    private readonly onCancelCallback;
    constructor(options: TrustSelectorOptions);
    private isSavedOption;
    private updateList;
    handleInput(keyData: string): void;
}
//# sourceMappingURL=trust-selector.d.ts.map