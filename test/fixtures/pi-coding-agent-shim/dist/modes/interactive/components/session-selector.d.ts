import { type Component, Container, type Focusable } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../../../core/session-manager.ts";
import { type NameFilter, type SortMode } from "./session-selector-search.ts";
/**
 * Custom session list component with multi-line items and search
 */
declare class SessionList implements Component, Focusable {
    getSelectedSessionPath(): string | undefined;
    private allSessions;
    private filteredSessions;
    private selectedIndex;
    private searchInput;
    private showCwd;
    private sortMode;
    private nameFilter;
    private keybindings;
    private showPath;
    private confirmingDeletePath;
    private currentSessionCanonicalPath?;
    onSelect?: (sessionPath: string) => void;
    onCancel?: () => void;
    onExit: () => void;
    onToggleScope?: () => void;
    onToggleSort?: () => void;
    onToggleNameFilter?: () => void;
    onTogglePath?: (showPath: boolean) => void;
    onDeleteConfirmationChange?: (path: string | null) => void;
    onDeleteSession?: (sessionPath: string) => Promise<void>;
    onRenameSession?: (sessionPath: string) => void;
    onError?: (message: string) => void;
    private maxVisible;
    private _focused;
    get focused(): boolean;
    set focused(value: boolean);
    constructor(sessions: SessionInfo[], showCwd: boolean, sortMode: SortMode, nameFilter: NameFilter, keybindings: KeybindingsManager, currentSessionFilePath?: string);
    setSortMode(sortMode: SortMode): void;
    setNameFilter(nameFilter: NameFilter): void;
    setSessions(sessions: SessionInfo[], showCwd: boolean): void;
    private filterSessions;
    private setConfirmingDeletePath;
    private startDeleteConfirmationForSelectedSession;
    private isCurrentSessionPath;
    invalidate(): void;
    render(width: number): string[];
    private buildTreePrefix;
    handleInput(keyData: string): void;
}
type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;
/**
 * Component that renders a session selector
 */
export declare class SessionSelectorComponent extends Container implements Focusable {
    handleInput(data: string): void;
    private canRename;
    private sessionList;
    private header;
    private keybindings;
    private scope;
    private sortMode;
    private nameFilter;
    private currentSessions;
    private allSessions;
    private currentSessionsLoader;
    private allSessionsLoader;
    private requestRender;
    private renameSession?;
    private currentLoading;
    private allLoading;
    private allLoadSeq;
    private mode;
    private renameInput;
    private renameTargetPath;
    private _focused;
    get focused(): boolean;
    set focused(value: boolean);
    private buildBaseLayout;
    constructor(currentSessionsLoader: SessionsLoader, allSessionsLoader: SessionsLoader, onSelect: (sessionPath: string) => void, onCancel: () => void, onExit: () => void, requestRender: () => void, options?: {
        renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
        showRenameHint?: boolean;
        keybindings?: KeybindingsManager;
    }, currentSessionFilePath?: string);
    private loadCurrentSessions;
    private enterRenameMode;
    private exitRenameMode;
    private confirmRename;
    private loadScope;
    private toggleSortMode;
    private toggleNameFilter;
    private refreshSessionsAfterMutation;
    private toggleScope;
    getSessionList(): SessionList;
}
export {};
//# sourceMappingURL=session-selector.d.ts.map