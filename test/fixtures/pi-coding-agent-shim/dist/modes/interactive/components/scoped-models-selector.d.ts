import type { Model } from "@earendil-works/pi-ai";
import { Container, type Focusable, Input } from "@earendil-works/pi-tui";
export interface ModelsConfig {
    allModels: Model<any>[];
    enabledModelIds: string[] | null;
}
export interface ModelsCallbacks {
    /** Called whenever the enabled model set or order changes (session-only, no persist) */
    onChange: (enabledModelIds: string[] | null) => void | Promise<void>;
    /** Called when user wants to persist current selection to settings */
    onPersist: (enabledModelIds: string[] | null) => void | Promise<void>;
    onCancel: () => void;
}
/**
 * Component for enabling/disabling models for Ctrl+P cycling.
 * Changes are session-only until explicitly persisted with Ctrl+S.
 */
export declare class ScopedModelsSelectorComponent extends Container implements Focusable {
    private modelsById;
    private allIds;
    private enabledIds;
    private filteredItems;
    private selectedIndex;
    private searchInput;
    private _focused;
    get focused(): boolean;
    set focused(value: boolean);
    private listContainer;
    private footerText;
    private callbacks;
    private maxVisible;
    private isDirty;
    constructor(config: ModelsConfig, callbacks: ModelsCallbacks);
    private buildItems;
    private getFooterText;
    private refresh;
    private notifyChange;
    private updateList;
    handleInput(data: string): void;
    getSearchInput(): Input;
}
//# sourceMappingURL=scoped-models-selector.d.ts.map