/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { type AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { type LatestPiRelease } from "../../utils/version-check.ts";
export declare function formatResumeCommand(sessionManager: SessionManager): string | undefined;
/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
    /** Providers that were migrated to auth.json (shows warning) */
    migratedProviders?: string[];
    /** Warning message if session model couldn't be restored */
    modelFallbackMessage?: string;
    /** Cwd to trust after reload if it gained a .pi directory during this implicitly trusted session. */
    autoTrustOnReloadCwd?: string;
    /** Initial message to send on startup (can include @file content) */
    initialMessage?: string;
    /** Images to attach to the initial message */
    initialImages?: ImageContent[];
    /** Additional messages to send after the initial message */
    initialMessages?: string[];
    /** Force verbose startup (overrides quietStartup setting) */
    verbose?: boolean;
}
export declare class InteractiveMode {
    private runtimeHost;
    private ui;
    private loadedResourcesContainer;
    private chatContainer;
    private pendingMessagesContainer;
    private statusContainer;
    private defaultEditor;
    private editor;
    private editorComponentFactory;
    private autocompleteProvider;
    private autocompleteProviderWrappers;
    private fdPath;
    private editorContainer;
    private footer;
    private footerDataProvider;
    private keybindings;
    private version;
    private isInitialized;
    private onInputCallback?;
    private pendingUserInputs;
    private activeStatusIndicator;
    private readonly idleStatus;
    private workingMessage;
    private workingVisible;
    private workingIndicatorOptions;
    private readonly defaultWorkingMessage;
    private readonly defaultHiddenThinkingLabel;
    private hiddenThinkingLabel;
    private lastSigintTime;
    private lastEscapeTime;
    private changelogMarkdown;
    private startupNoticesShown;
    private anthropicSubscriptionWarningShown;
    private lastStatusSpacer;
    private lastStatusText;
    private streamingComponent;
    private streamingMessage;
    private pendingTools;
    private toolOutputExpanded;
    private hideThinkingBlock;
    private outputPad;
    private skillCommands;
    private unsubscribe?;
    private signalCleanupHandlers;
    private isBashMode;
    private bashComponent;
    private pendingBashComponents;
    private autoCompactionEscapeHandler?;
    private retryEscapeHandler?;
    private compactionQueuedMessages;
    private shutdownRequested;
    private extensionSelector;
    private extensionInput;
    private extensionEditor;
    private extensionTerminalInputUnsubscribers;
    private extensionWidgetsAbove;
    private extensionWidgetsBelow;
    private widgetContainerAbove;
    private widgetContainerBelow;
    private customFooter;
    private headerContainer;
    private builtInHeader;
    private customHeader;
    private options;
    private autoTrustOnReloadCwd;
    private themeController;
    private get session();
    private get agent();
    private get sessionManager();
    private get settingsManager();
    constructor(runtimeHost: AgentSessionRuntime, options?: InteractiveModeOptions);
    private getAutocompleteSourceTag;
    private prefixAutocompleteDescription;
    private getBuiltInCommandConflictDiagnostics;
    private createBaseAutocompleteProvider;
    private setupAutocompleteProvider;
    private showStartupNoticesIfNeeded;
    init(): Promise<void>;
    /**
     * Update terminal title with session name and cwd.
     */
    private updateTerminalTitle;
    /**
     * Run the interactive mode. This is the main entry point.
     * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
     */
    run(): Promise<void>;
    private checkForPackageUpdates;
    private checkTmuxKeyboardSetup;
    /**
     * Get changelog entries to display on startup.
     * Only shows new entries since last seen version, skips for resumed sessions.
     */
    private getChangelogForDisplay;
    private reportInstallTelemetry;
    private getMarkdownThemeWithSettings;
    private formatDisplayPath;
    private formatExtensionDisplayPath;
    private formatContextPath;
    private getStartupExpansionState;
    /**
     * Get a short path relative to the package root for display.
     */
    private getShortPath;
    private getCompactPathLabel;
    private getCompactPackageSourceLabel;
    private getCompactExtensionLabel;
    private getCompactDisplayPathSegments;
    private getCompactNonPackageExtensionLabel;
    private getCompactExtensionLabels;
    private getDisplaySourceInfo;
    private getScopeGroup;
    private isPackageSource;
    private buildScopeGroups;
    private formatScopeGroups;
    private findSourceInfoForPath;
    private formatPathWithSource;
    private formatDiagnostics;
    private showLoadedResources;
    private bindCurrentSessionExtensions;
    private applyRuntimeSettings;
    private rebindCurrentSession;
    private handleFatalRuntimeError;
    private renderCurrentSessionState;
    /**
     * Get a registered tool definition by name (for custom rendering).
     */
    private getRegisteredToolDefinition;
    /**
     * Set up keyboard shortcuts registered by extensions.
     */
    private setupExtensionShortcuts;
    /**
     * Set extension status text in the footer.
     */
    private setExtensionStatus;
    private showStatusIndicator;
    private clearStatusIndicator;
    private setWorkingVisible;
    private setWorkingIndicator;
    private setHiddenThinkingLabel;
    /**
     * Set an extension widget (string array or custom component).
     */
    private setExtensionWidget;
    private clearExtensionWidgets;
    private resetExtensionUI;
    private static readonly MAX_WIDGET_LINES;
    /**
     * Render all extension widgets to the widget container.
     */
    private renderWidgets;
    private renderWidgetContainer;
    /**
     * Set a custom footer component, or restore the built-in footer.
     */
    private setExtensionFooter;
    /**
     * Set a custom header component, or restore the built-in header.
     */
    private setExtensionHeader;
    private addExtensionTerminalInputListener;
    private clearExtensionTerminalInputListeners;
    /**
     * Create the ExtensionUIContext for extensions.
     */
    private createProjectTrustContext;
    private createExtensionUIContext;
    /**
     * Show a selector for extensions.
     */
    private showExtensionSelector;
    /**
     * Hide the extension selector.
     */
    private hideExtensionSelector;
    private showExtensionConfirm;
    private promptForMissingSessionCwd;
    /**
     * Show a text input for extensions.
     */
    private showExtensionInput;
    /**
     * Hide the extension input.
     */
    private hideExtensionInput;
    /**
     * Show a multi-line editor for extensions (with Ctrl+G support).
     */
    private showExtensionEditor;
    /**
     * Hide the extension editor.
     */
    private hideExtensionEditor;
    /**
     * Set a custom editor component from an extension.
     * Pass undefined to restore the default editor.
     */
    private setCustomEditorComponent;
    /**
     * Show a notification for extensions.
     */
    private showExtensionNotify;
    private showExtensionCustom;
    /**
     * Show an extension error in the UI.
     */
    private showExtensionError;
    private setupKeyHandlers;
    private handleClipboardPaste;
    private setupEditorSubmitHandler;
    private subscribeToAgent;
    private handleEvent;
    /** Extract text content from a user message */
    private getUserMessageText;
    /**
     * Show a status message in the chat.
     *
     * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
     * we update the previous status line instead of appending new ones to avoid log spam.
     */
    private showStatus;
    private addCustomEntryToChat;
    private addMessageToChat;
    private renderSessionItems;
    /**
     * Render session entries to chat. Used for initial load and rebuild after compaction.
     * @param entries Compaction-aware session entries to render
     * @param options.updateFooter Update footer state
     * @param options.populateHistory Add user messages to editor history
     */
    private renderSessionEntries;
    /**
     * Show a transcript notice when a completed assistant message paid for a
     * significant cache miss. Only states observable facts: the miss itself,
     * a model switch, or an idle gap past the cache TTL.
     */
    private maybeShowCacheMissNotice;
    private addCacheMissNotice;
    renderInitialMessages(): void;
    private renderProjectTrustWarningIfNeeded;
    getUserInput(): Promise<string>;
    private rebuildChatFromMessages;
    private handleCtrlC;
    private handleCtrlD;
    /**
     * Gracefully shutdown the agent.
     * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
     * repaint the final frame while the process is exiting.
     */
    private isShuttingDown;
    private shutdown;
    private emergencyTerminalExit;
    /**
     * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
     * mode and hides the cursor; without this handler, an uncaught throw from
     * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
     * tears down the process while leaving the terminal in raw mode with no
     * cursor, requiring `stty sane && reset` to recover.
     *
     * Unlike emergencyTerminalExit, the terminal is still alive here, so we
     * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
     * paste / Kitty / modifyOtherKeys sequences.
     */
    private uncaughtCrash;
    private checkShutdownRequested;
    private registerSignalHandlers;
    private unregisterSignalHandlers;
    private handleCtrlZ;
    private handleFollowUp;
    private handleDequeue;
    private updateEditorBorderColor;
    private cycleThinkingLevel;
    private cycleModel;
    private toggleToolOutputExpansion;
    private setToolsExpanded;
    private toggleThinkingBlockVisibility;
    private openExternalEditor;
    clearEditor(): void;
    showError(errorMessage: string): void;
    showWarning(warningMessage: string): void;
    showNewVersionNotification(release: LatestPiRelease): void;
    showPackageUpdateNotification(packages: string[]): void;
    /**
     * Get all queued messages (read-only).
     * Combines session queue and compaction queue.
     */
    private getAllQueuedMessages;
    /**
     * Clear all queued messages and return their contents.
     * Clears both session queue and compaction queue.
     */
    private clearAllQueues;
    private updatePendingMessagesDisplay;
    private restoreQueuedMessagesToEditor;
    private queueCompactionMessage;
    private isExtensionCommand;
    private flushCompactionQueue;
    /** Move pending bash components from pending area to chat */
    private flushPendingBashComponents;
    /**
     * Shows a selector component in place of the editor.
     * @param create Factory that receives a `done` callback and returns the component and focus target
     */
    private showSelector;
    private showSettingsSelector;
    private handleModelCommand;
    private findExactModelMatch;
    private getModelCandidates;
    private updateAvailableProviderCount;
    private maybeWarnAboutAnthropicSubscriptionAuth;
    private maybeSaveImplicitProjectTrustAfterReload;
    private showTrustSelector;
    private showModelSelector;
    private showModelsSelector;
    private showUserMessageSelector;
    private handleCloneCommand;
    private showTreeSelector;
    private showSessionSelector;
    private handleResumeSession;
    private getLoginProviderOptions;
    private getLogoutProviderOptions;
    private findLoginProviderOptions;
    private handleLoginCommand;
    private startProviderLogin;
    private showLoginAuthTypeSelector;
    private showLoginProviderSelector;
    private showOAuthSelector;
    private completeProviderAuthentication;
    private showAmbientAuthDialog;
    private showApiKeyLoginDialog;
    private showAuthSelect;
    private showAuthPrompt;
    private notifyAuthDialog;
    private loginProvider;
    private showLoginDialog;
    private handleReloadCommand;
    private handleExportCommand;
    private getPathCommandArgument;
    private handleImportCommand;
    private handleShareCommand;
    private handleCopyCommand;
    private handleNameCommand;
    private handleSessionCommand;
    private handleChangelogCommand;
    /**
     * Get capitalized display string for an app keybinding action.
     */
    private getAppKeyDisplay;
    /**
     * Get capitalized display string for an editor keybinding action.
     */
    private getEditorKeyDisplay;
    private handleHotkeysCommand;
    private handleClearCommand;
    private handleDebugCommand;
    private handleArminSaysHi;
    private handleDementedDelves;
    private handleDaxnuts;
    private checkDaxnutsEasterEgg;
    private handleBashCommand;
    private handleCompactCommand;
    stop(): void;
}
//# sourceMappingURL=interactive-mode.d.ts.map