import { type Component, Container, type Focusable } from "@earendil-works/pi-tui";
import type { SessionTreeNode } from "../../../core/session-manager.ts";
/** Filter mode for tree display */
export type FilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";
declare class TreeList implements Component {
    private flatNodes;
    private filteredNodes;
    private selectedIndex;
    private currentLeafId;
    private maxVisibleLines;
    private filterMode;
    private searchQuery;
    private toolCallMap;
    private multipleRoots;
    private showLabelTimestamps;
    private activePathIds;
    private visibleParentMap;
    private visibleChildrenMap;
    private lastSelectedId;
    private foldedNodes;
    onSelect?: (entryId: string) => void;
    onCancel?: () => void;
    onCopy?: (text: string | undefined) => void;
    onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;
    constructor(tree: SessionTreeNode[], currentLeafId: string | null, maxVisibleLines: number, initialSelectedId?: string, initialFilterMode?: FilterMode);
    /**
     * Find the index of the nearest visible entry, walking up the parent chain if needed.
     * Returns the index in filteredNodes, or the last index as fallback.
     */
    private findNearestVisibleIndex;
    /** Build the set of entry IDs on the path from root to current leaf */
    private buildActivePath;
    private flattenTree;
    private applyFilter;
    /**
     * Recompute indentation/connectors for the filtered view
     *
     * Filtering can hide intermediate entries; descendants attach to the nearest visible ancestor.
     * Keep indentation semantics aligned with flattenTree() so single-child chains don't drift right.
     */
    private recalculateVisualStructure;
    /** Get searchable text content from a node */
    private getSearchableText;
    invalidate(): void;
    getSearchQuery(): string;
    getSelectedNode(): SessionTreeNode | undefined;
    copySelected(): void;
    updateNodeLabel(entryId: string, label: string | undefined, labelTimestamp?: string): void;
    private getStatusLabels;
    render(width: number): string[];
    private getEntryDisplayText;
    private formatLabelTimestamp;
    private extractContent;
    private extractFullContent;
    private getEntryCopyText;
    private hasTextContent;
    private formatToolCall;
    handleInput(keyData: string): void;
    /**
     * Whether a node can be folded. A node is foldable if it has visible children
     * and is either a root (no visible parent) or a segment start (visible parent
     * has multiple visible children).
     */
    private isFoldable;
    /**
     * Find the index of the next branch segment start in the given direction.
     * A segment start is the first child of a branch point.
     *
     * "up" walks the visible parent chain; "down" walks visible children
     * (always following the first child).
     */
    private findBranchSegmentStart;
}
/**
 * Component that renders a session tree selector for navigation
 */
export declare class TreeSelectorComponent extends Container implements Focusable {
    private treeList;
    private labelInput;
    private labelInputContainer;
    private treeContainer;
    private onLabelChangeCallback?;
    onCopy?: (text: string | undefined) => void;
    private _focused;
    get focused(): boolean;
    set focused(value: boolean);
    constructor(tree: SessionTreeNode[], currentLeafId: string | null, terminalHeight: number, onSelect: (entryId: string) => void, onCancel: () => void, onLabelChange?: (entryId: string, label: string | undefined) => void, initialSelectedId?: string, initialFilterMode?: FilterMode);
    private showLabelInput;
    private hideLabelInput;
    handleInput(keyData: string): void;
    getTreeList(): TreeList;
}
export {};
//# sourceMappingURL=tree-selector.d.ts.map