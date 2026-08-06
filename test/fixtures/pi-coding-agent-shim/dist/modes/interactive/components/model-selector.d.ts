import { type Model } from "@earendil-works/pi-ai";
import { Container, type Focusable, Input, type TUI } from "@earendil-works/pi-tui";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
interface ScopedModelItem {
    model: Model<any>;
    thinkingLevel?: string;
}
/**
 * Component that renders a model selector with search
 */
export declare class ModelSelectorComponent extends Container implements Focusable {
    private searchInput;
    private _focused;
    get focused(): boolean;
    set focused(value: boolean);
    private listContainer;
    private allModels;
    private scopedModelItems;
    private activeModels;
    private filteredModels;
    private selectedIndex;
    private currentModel?;
    private settingsManager;
    private modelRuntime;
    private onSelectCallback;
    private onCancelCallback;
    private errorMessage?;
    private refreshStatusMessage;
    private refreshStatusSuccess;
    private tui;
    private scopedModels;
    private scope;
    private scopeText?;
    private scopeHintText?;
    private readonly refreshAbortController;
    private refreshTimeout?;
    private closed;
    constructor(tui: TUI, currentModel: Model<any> | undefined, settingsManager: SettingsManager, modelRuntime: ModelRuntime, scopedModels: ReadonlyArray<ScopedModelItem>, onSelect: (model: Model<any>) => void, onCancel: () => void, initialSearchInput?: string);
    private loadModelsFromSnapshot;
    private refreshModels;
    private close;
    private sortModels;
    private getScopeText;
    private getScopeHintText;
    private setScope;
    private filterModels;
    private updateList;
    handleInput(keyData: string): void;
    private handleSelect;
    getSearchInput(): Input;
}
export {};
//# sourceMappingURL=model-selector.d.ts.map