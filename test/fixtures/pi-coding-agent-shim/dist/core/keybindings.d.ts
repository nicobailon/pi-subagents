import { type Keybinding, type KeybindingsConfig, type KeyId, KeybindingsManager as TuiKeybindingsManager } from "@earendil-works/pi-tui";
export interface AppKeybindings {
    "app.interrupt": true;
    "app.clear": true;
    "app.exit": true;
    "app.suspend": true;
    "app.thinking.cycle": true;
    "app.model.cycleForward": true;
    "app.model.cycleBackward": true;
    "app.model.select": true;
    "app.tools.expand": true;
    "app.thinking.toggle": true;
    "app.session.toggleNamedFilter": true;
    "app.editor.external": true;
    "app.message.copy": true;
    "app.message.followUp": true;
    "app.message.dequeue": true;
    "app.clipboard.pasteImage": true;
    "app.session.new": true;
    "app.session.tree": true;
    "app.session.fork": true;
    "app.session.resume": true;
    "app.tree.foldOrUp": true;
    "app.tree.unfoldOrDown": true;
    "app.tree.editLabel": true;
    "app.tree.toggleLabelTimestamp": true;
    "app.session.togglePath": true;
    "app.session.toggleSort": true;
    "app.session.rename": true;
    "app.session.delete": true;
    "app.session.deleteNoninvasive": true;
    "app.models.save": true;
    "app.models.enableAll": true;
    "app.models.clearAll": true;
    "app.models.toggleProvider": true;
    "app.models.reorderUp": true;
    "app.models.reorderDown": true;
    "app.tree.filter.default": true;
    "app.tree.filter.noTools": true;
    "app.tree.filter.userOnly": true;
    "app.tree.filter.labeledOnly": true;
    "app.tree.filter.all": true;
    "app.tree.filter.cycleForward": true;
    "app.tree.filter.cycleBackward": true;
}
export type AppKeybinding = keyof AppKeybindings;
declare module "@earendil-works/pi-tui" {
    interface Keybindings extends AppKeybindings {
    }
}
export declare const KEYBINDINGS: {
    readonly "tui.editor.cursorUp": {
        readonly defaultKeys: "up";
        readonly description: "Move cursor up";
    };
    readonly "tui.editor.cursorDown": {
        readonly defaultKeys: "down";
        readonly description: "Move cursor down";
    };
    readonly "tui.editor.cursorLeft": {
        readonly defaultKeys: ["left", "ctrl+b"];
        readonly description: "Move cursor left";
    };
    readonly "tui.editor.cursorRight": {
        readonly defaultKeys: ["right", "ctrl+f"];
        readonly description: "Move cursor right";
    };
    readonly "tui.editor.cursorWordLeft": {
        readonly defaultKeys: ["alt+left", "ctrl+left", "alt+b"];
        readonly description: "Move cursor word left";
    };
    readonly "tui.editor.cursorWordRight": {
        readonly defaultKeys: ["alt+right", "ctrl+right", "alt+f"];
        readonly description: "Move cursor word right";
    };
    readonly "tui.editor.cursorLineStart": {
        readonly defaultKeys: ["home", "ctrl+a"];
        readonly description: "Move to line start";
    };
    readonly "tui.editor.cursorLineEnd": {
        readonly defaultKeys: ["end", "ctrl+e"];
        readonly description: "Move to line end";
    };
    readonly "tui.editor.jumpForward": {
        readonly defaultKeys: "ctrl+]";
        readonly description: "Jump forward to character";
    };
    readonly "tui.editor.jumpBackward": {
        readonly defaultKeys: "ctrl+alt+]";
        readonly description: "Jump backward to character";
    };
    readonly "tui.editor.pageUp": {
        readonly defaultKeys: "pageUp";
        readonly description: "Page up";
    };
    readonly "tui.editor.pageDown": {
        readonly defaultKeys: "pageDown";
        readonly description: "Page down";
    };
    readonly "tui.editor.deleteCharBackward": {
        readonly defaultKeys: "backspace";
        readonly description: "Delete character backward";
    };
    readonly "tui.editor.deleteCharForward": {
        readonly defaultKeys: ["delete", "ctrl+d"];
        readonly description: "Delete character forward";
    };
    readonly "tui.editor.deleteWordBackward": {
        readonly defaultKeys: ["ctrl+w", "alt+backspace"];
        readonly description: "Delete word backward";
    };
    readonly "tui.editor.deleteWordForward": {
        readonly defaultKeys: ["alt+d", "alt+delete"];
        readonly description: "Delete word forward";
    };
    readonly "tui.editor.deleteToLineStart": {
        readonly defaultKeys: "ctrl+u";
        readonly description: "Delete to line start";
    };
    readonly "tui.editor.deleteToLineEnd": {
        readonly defaultKeys: "ctrl+k";
        readonly description: "Delete to line end";
    };
    readonly "tui.editor.yank": {
        readonly defaultKeys: "ctrl+y";
        readonly description: "Yank";
    };
    readonly "tui.editor.yankPop": {
        readonly defaultKeys: "alt+y";
        readonly description: "Yank pop";
    };
    readonly "tui.editor.undo": {
        readonly defaultKeys: "ctrl+-";
        readonly description: "Undo";
    };
    readonly "tui.input.newLine": {
        readonly defaultKeys: ["shift+enter", "ctrl+j"];
        readonly description: "Insert newline";
    };
    readonly "tui.input.submit": {
        readonly defaultKeys: "enter";
        readonly description: "Submit input";
    };
    readonly "tui.input.tab": {
        readonly defaultKeys: "tab";
        readonly description: "Tab / autocomplete";
    };
    readonly "tui.input.copy": {
        readonly defaultKeys: "ctrl+c";
        readonly description: "Copy selection";
    };
    readonly "tui.select.up": {
        readonly defaultKeys: "up";
        readonly description: "Move selection up";
    };
    readonly "tui.select.down": {
        readonly defaultKeys: "down";
        readonly description: "Move selection down";
    };
    readonly "tui.select.pageUp": {
        readonly defaultKeys: "pageUp";
        readonly description: "Selection page up";
    };
    readonly "tui.select.pageDown": {
        readonly defaultKeys: "pageDown";
        readonly description: "Selection page down";
    };
    readonly "tui.select.confirm": {
        readonly defaultKeys: "enter";
        readonly description: "Confirm selection";
    };
    readonly "tui.select.cancel": {
        readonly defaultKeys: ["escape", "ctrl+c"];
        readonly description: "Cancel selection";
    };
    readonly "app.interrupt": {
        readonly defaultKeys: "escape";
        readonly description: "Cancel or abort";
    };
    readonly "app.clear": {
        readonly defaultKeys: "ctrl+c";
        readonly description: "Clear editor";
    };
    readonly "app.exit": {
        readonly defaultKeys: "ctrl+d";
        readonly description: "Exit when editor is empty";
    };
    readonly "app.suspend": {
        readonly defaultKeys: "ctrl+z" | never[];
        readonly description: "Suspend to background";
    };
    readonly "app.thinking.cycle": {
        readonly defaultKeys: "shift+tab";
        readonly description: "Cycle thinking level";
    };
    readonly "app.model.cycleForward": {
        readonly defaultKeys: "ctrl+p";
        readonly description: "Cycle to next model";
    };
    readonly "app.model.cycleBackward": {
        readonly defaultKeys: "shift+ctrl+p";
        readonly description: "Cycle to previous model";
    };
    readonly "app.model.select": {
        readonly defaultKeys: "ctrl+l";
        readonly description: "Open model selector";
    };
    readonly "app.tools.expand": {
        readonly defaultKeys: "ctrl+o";
        readonly description: "Toggle tool output";
    };
    readonly "app.thinking.toggle": {
        readonly defaultKeys: "ctrl+t";
        readonly description: "Toggle thinking blocks";
    };
    readonly "app.session.toggleNamedFilter": {
        readonly defaultKeys: "ctrl+n";
        readonly description: "Toggle named session filter";
    };
    readonly "app.editor.external": {
        readonly defaultKeys: "ctrl+g";
        readonly description: "Open external editor";
    };
    readonly "app.message.copy": {
        readonly defaultKeys: "ctrl+x";
        readonly description: "Copy message to clipboard";
    };
    readonly "app.message.followUp": {
        readonly defaultKeys: "alt+enter";
        readonly description: "Queue follow-up message";
    };
    readonly "app.message.dequeue": {
        readonly defaultKeys: "alt+up";
        readonly description: "Restore queued messages";
    };
    readonly "app.clipboard.pasteImage": {
        readonly defaultKeys: "alt+v" | "ctrl+v";
        readonly description: "Paste image from clipboard (text fallback)";
    };
    readonly "app.session.new": {
        readonly defaultKeys: [];
        readonly description: "Start a new session";
    };
    readonly "app.session.tree": {
        readonly defaultKeys: [];
        readonly description: "Open session tree";
    };
    readonly "app.session.fork": {
        readonly defaultKeys: [];
        readonly description: "Fork current session";
    };
    readonly "app.session.resume": {
        readonly defaultKeys: [];
        readonly description: "Resume a session";
    };
    readonly "app.tree.foldOrUp": {
        readonly defaultKeys: ("alt+left" | "ctrl+left")[];
        readonly description: "Fold tree branch or move up";
    };
    readonly "app.tree.unfoldOrDown": {
        readonly defaultKeys: ("alt+right" | "ctrl+right")[];
        readonly description: "Unfold tree branch or move down";
    };
    readonly "app.tree.editLabel": {
        readonly defaultKeys: "shift+l";
        readonly description: "Edit tree label";
    };
    readonly "app.tree.toggleLabelTimestamp": {
        readonly defaultKeys: "shift+t";
        readonly description: "Toggle tree label timestamps";
    };
    readonly "app.session.togglePath": {
        readonly defaultKeys: "ctrl+p";
        readonly description: "Toggle session path display";
    };
    readonly "app.session.toggleSort": {
        readonly defaultKeys: "ctrl+s";
        readonly description: "Toggle session sort mode";
    };
    readonly "app.session.rename": {
        readonly defaultKeys: "ctrl+r";
        readonly description: "Rename session";
    };
    readonly "app.session.delete": {
        readonly defaultKeys: "ctrl+d";
        readonly description: "Delete session";
    };
    readonly "app.session.deleteNoninvasive": {
        readonly defaultKeys: "ctrl+backspace";
        readonly description: "Delete session when query is empty";
    };
    readonly "app.models.save": {
        readonly defaultKeys: "ctrl+s";
        readonly description: "Save model selection";
    };
    readonly "app.models.enableAll": {
        readonly defaultKeys: "ctrl+a";
        readonly description: "Enable all models";
    };
    readonly "app.models.clearAll": {
        readonly defaultKeys: "ctrl+x";
        readonly description: "Clear all models";
    };
    readonly "app.models.toggleProvider": {
        readonly defaultKeys: "ctrl+p";
        readonly description: "Toggle all models for provider";
    };
    readonly "app.models.reorderUp": {
        readonly defaultKeys: "alt+up";
        readonly description: "Move model up in order";
    };
    readonly "app.models.reorderDown": {
        readonly defaultKeys: "alt+down";
        readonly description: "Move model down in order";
    };
    readonly "app.tree.filter.default": {
        readonly defaultKeys: "ctrl+d";
        readonly description: "Tree filter: default view";
    };
    readonly "app.tree.filter.noTools": {
        readonly defaultKeys: "ctrl+t";
        readonly description: "Tree filter: hide tool results";
    };
    readonly "app.tree.filter.userOnly": {
        readonly defaultKeys: "ctrl+u";
        readonly description: "Tree filter: user messages only";
    };
    readonly "app.tree.filter.labeledOnly": {
        readonly defaultKeys: "ctrl+l";
        readonly description: "Tree filter: labeled entries only";
    };
    readonly "app.tree.filter.all": {
        readonly defaultKeys: "ctrl+a";
        readonly description: "Tree filter: show all entries";
    };
    readonly "app.tree.filter.cycleForward": {
        readonly defaultKeys: "ctrl+o";
        readonly description: "Tree filter: cycle forward";
    };
    readonly "app.tree.filter.cycleBackward": {
        readonly defaultKeys: "shift+ctrl+o";
        readonly description: "Tree filter: cycle backward";
    };
};
export declare function migrateKeybindingsConfig(rawConfig: Record<string, unknown>): {
    config: Record<string, unknown>;
    migrated: boolean;
};
export declare class KeybindingsManager extends TuiKeybindingsManager {
    private configPath;
    constructor(userBindings?: KeybindingsConfig, configPath?: string);
    static create(agentDir?: string): KeybindingsManager;
    reload(): void;
    getEffectiveConfig(): KeybindingsConfig;
    private static loadFromFile;
}
export type { Keybinding, KeyId, KeybindingsConfig };
//# sourceMappingURL=keybindings.d.ts.map