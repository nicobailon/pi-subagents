/**
 * Extension runner - executes extensions and manages their lifecycle.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Provider, ProviderHeaders } from "@earendil-works/pi-ai";
import type { KeyId } from "@earendil-works/pi-tui";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { KeybindingsConfig } from "../keybindings.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { SessionManager } from "../session-manager.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, BeforeProviderHeadersEvent, BeforeProviderRequestEvent, ContextEvent, EntryRenderer, Extension, ExtensionActions, ExtensionCommandContext, ExtensionCommandContextActions, ExtensionContext, ExtensionContextActions, ExtensionError, ExtensionEvent, ExtensionFlag, ExtensionMode, ExtensionRuntime, ExtensionShortcut, ExtensionUIContext, InputEvent, InputEventResult, InputSource, LoadExtensionsResult, MessageEndEvent, MessageRenderer, ProjectTrustContext, ProjectTrustEvent, ProjectTrustEventResult, ProviderConfig, RegisteredTool, ReplacedSessionContext, ResolvedCommand, ResourcesDiscoverEvent, SessionBeforeCompactResult, SessionBeforeForkResult, SessionBeforeSwitchResult, SessionBeforeTreeResult, SessionShutdownEvent, ToolCallEvent, ToolCallEventResult, ToolResultEvent, ToolResultEventResult, UserBashEvent, UserBashEventResult } from "./types.ts";
/** Combined result from all before_agent_start handlers */
interface BeforeAgentStartCombinedResult {
    messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
    systemPrompt?: string;
}
/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
type RunnerEmitEvent = Exclude<ExtensionEvent, ToolCallEvent | ProjectTrustEvent | ToolResultEvent | UserBashEvent | ContextEvent | BeforeProviderRequestEvent | BeforeProviderHeadersEvent | BeforeAgentStartEvent | MessageEndEvent | ResourcesDiscoverEvent | InputEvent>;
type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends {
    type: "session_before_switch";
} ? SessionBeforeSwitchResult | undefined : TEvent extends {
    type: "session_before_fork";
} ? SessionBeforeForkResult | undefined : TEvent extends {
    type: "session_before_compact";
} ? SessionBeforeCompactResult | undefined : TEvent extends {
    type: "session_before_tree";
} ? SessionBeforeTreeResult | undefined : undefined;
export type ExtensionErrorListener = (error: ExtensionError) => void;
export type NewSessionHandler = (options?: {
    parentSession?: string;
    setup?: (sessionManager: SessionManager) => Promise<void>;
    withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}) => Promise<{
    cancelled: boolean;
}>;
export type ForkHandler = (entryId: string, options?: {
    position?: "before" | "at";
    withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}) => Promise<{
    cancelled: boolean;
}>;
export type NavigateTreeHandler = (targetId: string, options?: {
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
    label?: string;
}) => Promise<{
    cancelled: boolean;
}>;
export type SwitchSessionHandler = (sessionPath: string, options?: {
    withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}) => Promise<{
    cancelled: boolean;
}>;
export type ReloadHandler = () => Promise<void>;
export type ShutdownHandler = () => void;
/**
 * Helper function to emit session_shutdown event to extensions.
 * Returns true if the event was emitted, false if there were no handlers.
 */
export declare function emitSessionShutdownEvent(extensionRunner: ExtensionRunner, event: SessionShutdownEvent): Promise<boolean>;
export declare function emitProjectTrustEvent(extensionsResult: LoadExtensionsResult, event: ProjectTrustEvent, ctx: ProjectTrustContext): Promise<{
    result?: ProjectTrustEventResult;
    errors: ExtensionError[];
}>;
export declare class ExtensionRunner {
    private extensions;
    private runtime;
    private uiContext;
    private mode;
    private cwd;
    private sessionManager;
    private modelRegistry;
    private errorListeners;
    private getModel;
    private isIdleFn;
    private isProjectTrustedFn;
    private getSignalFn;
    private waitForIdleFn;
    private abortFn;
    private hasPendingMessagesFn;
    private getContextUsageFn;
    private compactFn;
    private getSystemPromptFn;
    private getSystemPromptOptionsFn;
    private newSessionHandler;
    private forkHandler;
    private navigateTreeHandler;
    private switchSessionHandler;
    private reloadHandler;
    private shutdownHandler;
    private shortcutDiagnostics;
    private commandDiagnostics;
    private staleMessage;
    constructor(extensions: Extension[], runtime: ExtensionRuntime, cwd: string, sessionManager: SessionManager, modelRegistry: ModelRegistry);
    bindCore(actions: ExtensionActions, contextActions: ExtensionContextActions, providerActions?: {
        registerProvider?: (name: string, config: ProviderConfig) => void;
        registerNativeProvider?: (provider: Provider) => void;
        unregisterProvider?: (name: string) => void;
    }): void;
    bindCommandContext(actions?: ExtensionCommandContextActions): void;
    setUIContext(uiContext?: ExtensionUIContext, mode?: ExtensionMode): void;
    getUIContext(): ExtensionUIContext;
    hasUI(): boolean;
    getExtensionPaths(): string[];
    /** Get all registered tools from all extensions (first registration per name wins). */
    getAllRegisteredTools(): RegisteredTool[];
    /** Get a tool definition by name. Returns undefined if not found. */
    getToolDefinition(toolName: string): RegisteredTool["definition"] | undefined;
    getFlags(): Map<string, ExtensionFlag>;
    setFlagValue(name: string, value: boolean | string): void;
    getFlagValues(): Map<string, boolean | string>;
    getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut>;
    getShortcutDiagnostics(): ResourceDiagnostic[];
    invalidate(message?: string): void;
    private assertActive;
    onError(listener: ExtensionErrorListener): () => void;
    emitError(error: ExtensionError): void;
    hasHandlers(eventType: string): boolean;
    getMessageRenderer(customType: string): MessageRenderer | undefined;
    getEntryRenderer(customType: string): EntryRenderer | undefined;
    private resolveRegisteredCommands;
    getModelRegistry(): ModelRegistry;
    getRegisteredCommands(): ResolvedCommand[];
    getCommandDiagnostics(): ResourceDiagnostic[];
    getCommand(name: string): ResolvedCommand | undefined;
    /**
     * Request a graceful shutdown. Called by extension tools and event handlers.
     * The actual shutdown behavior is provided by the mode via bindExtensions().
     */
    shutdown(): void;
    getActiveTools(): string[];
    /**
     * Create an ExtensionContext for use in event handlers and tool execution.
     * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
     */
    createContext(): ExtensionContext;
    createCommandContext(): ExtensionCommandContext;
    private isSessionBeforeEvent;
    emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>>;
    emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined>;
    emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined>;
    emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined>;
    emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined>;
    emitContext(messages: AgentMessage[]): Promise<AgentMessage[]>;
    emitBeforeProviderRequest(payload: unknown): Promise<unknown>;
    emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders>;
    emitBeforeAgentStart(prompt: string, images: ImageContent[] | undefined, systemPrompt: string, systemPromptOptions: BuildSystemPromptOptions): Promise<BeforeAgentStartCombinedResult | undefined>;
    emitResourcesDiscover(cwd: string, reason: ResourcesDiscoverEvent["reason"]): Promise<{
        skillPaths: Array<{
            path: string;
            extensionPath: string;
        }>;
        promptPaths: Array<{
            path: string;
            extensionPath: string;
        }>;
        themePaths: Array<{
            path: string;
            extensionPath: string;
        }>;
    }>;
    /** Emit input event. Transforms chain, "handled" short-circuits. */
    emitInput(text: string, images: ImageContent[] | undefined, source: InputSource, streamingBehavior?: "steer" | "followUp"): Promise<InputEventResult>;
}
export {};
//# sourceMappingURL=runner.d.ts.map