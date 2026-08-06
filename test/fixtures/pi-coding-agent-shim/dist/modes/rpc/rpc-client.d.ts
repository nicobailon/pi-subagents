/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import type { RpcSessionState, RpcSlashCommand } from "./rpc-types.ts";
export interface RpcClientOptions {
    /** Path to the CLI entry point (default: searches for dist/cli.js) */
    cliPath?: string;
    /** Working directory for the agent */
    cwd?: string;
    /** Environment variables */
    env?: Record<string, string>;
    /** Provider to use */
    provider?: string;
    /** Model ID to use */
    model?: string;
    /** Additional CLI arguments */
    args?: string[];
}
export interface ModelInfo {
    provider: string;
    id: string;
    contextWindow: number;
    reasoning: boolean;
}
export type RpcEventListener = (event: AgentSessionEvent) => void;
export declare class RpcClient {
    private process;
    private stopReadingStdout;
    private eventListeners;
    private pendingRequests;
    private requestId;
    private stderr;
    private exitError;
    private options;
    constructor(options?: RpcClientOptions);
    /**
     * Start the RPC agent process.
     */
    start(): Promise<void>;
    /**
     * Stop the RPC agent process.
     */
    stop(): Promise<void>;
    /**
     * Subscribe to agent events.
     */
    onEvent(listener: RpcEventListener): () => void;
    /**
     * Get collected stderr output (useful for debugging).
     */
    getStderr(): string;
    /**
     * Send a prompt to the agent.
     * Returns immediately after sending; use onEvent() to receive streaming events.
     * Use waitForIdle() to wait for completion.
     */
    prompt(message: string, images?: ImageContent[]): Promise<void>;
    /**
     * Queue a steering message to interrupt the agent mid-run.
     */
    steer(message: string, images?: ImageContent[]): Promise<void>;
    /**
     * Queue a follow-up message to be processed after the agent finishes.
     */
    followUp(message: string, images?: ImageContent[]): Promise<void>;
    /**
     * Abort current operation.
     */
    abort(): Promise<void>;
    /**
     * Start a new session, optionally with parent tracking.
     * @param parentSession - Optional parent session path for lineage tracking
     * @returns Object with `cancelled: true` if an extension cancelled the new session
     */
    newSession(parentSession?: string): Promise<{
        cancelled: boolean;
    }>;
    /**
     * Get current session state.
     */
    getState(): Promise<RpcSessionState>;
    /**
     * Set model by provider and ID.
     */
    setModel(provider: string, modelId: string): Promise<{
        provider: string;
        id: string;
    }>;
    /**
     * Cycle to next model.
     */
    cycleModel(): Promise<{
        model: {
            provider: string;
            id: string;
        };
        thinkingLevel: ThinkingLevel;
        isScoped: boolean;
    } | null>;
    /**
     * Get list of available models.
     */
    getAvailableModels(): Promise<ModelInfo[]>;
    /**
     * Set thinking level.
     */
    setThinkingLevel(level: ThinkingLevel): Promise<void>;
    /**
     * Cycle thinking level.
     */
    cycleThinkingLevel(): Promise<{
        level: ThinkingLevel;
    } | null>;
    /**
     * Get list of available thinking levels for the current model.
     */
    getAvailableThinkingLevels(): Promise<ThinkingLevel[]>;
    /**
     * Set steering mode.
     */
    setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void>;
    /**
     * Set follow-up mode.
     */
    setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void>;
    /**
     * Compact session context.
     */
    compact(customInstructions?: string): Promise<CompactionResult>;
    /**
     * Set auto-compaction enabled/disabled.
     */
    setAutoCompaction(enabled: boolean): Promise<void>;
    /**
     * Set auto-retry enabled/disabled.
     */
    setAutoRetry(enabled: boolean): Promise<void>;
    /**
     * Abort in-progress retry.
     */
    abortRetry(): Promise<void>;
    /**
     * Execute a bash command.
     */
    bash(command: string): Promise<BashResult>;
    /**
     * Abort running bash command.
     */
    abortBash(): Promise<void>;
    /**
     * Get session statistics.
     */
    getSessionStats(): Promise<SessionStats>;
    /**
     * Export session to HTML.
     */
    exportHtml(outputPath?: string): Promise<{
        path: string;
    }>;
    /**
     * Switch to a different session file.
     * @returns Object with `cancelled: true` if an extension cancelled the switch
     */
    switchSession(sessionPath: string): Promise<{
        cancelled: boolean;
    }>;
    /**
     * Fork from a specific message.
     * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
     */
    fork(entryId: string): Promise<{
        text: string;
        cancelled: boolean;
    }>;
    /**
     * Clone the current active branch into a new session.
     * @returns Object with `cancelled: true` if an extension cancelled the clone
     */
    clone(): Promise<{
        cancelled: boolean;
    }>;
    /**
     * Get messages available for forking.
     */
    getForkMessages(): Promise<Array<{
        entryId: string;
        text: string;
    }>>;
    /**
     * Get session entries in append order, optionally only those after the `since` entry id.
     */
    getEntries(since?: string): Promise<{
        entries: SessionEntry[];
        leafId: string | null;
    }>;
    /**
     * Get the session entry tree.
     */
    getTree(): Promise<{
        tree: SessionTreeNode[];
        leafId: string | null;
    }>;
    /**
     * Get text of last assistant message.
     */
    getLastAssistantText(): Promise<string | null>;
    /**
     * Set the session display name.
     */
    setSessionName(name: string): Promise<void>;
    /**
     * Get all messages in the session.
     */
    getMessages(): Promise<AgentMessage[]>;
    /**
     * Get available commands (extension commands, prompt templates, skills).
     */
    getCommands(): Promise<RpcSlashCommand[]>;
    /**
     * Wait for agent to become idle (no streaming).
     * Resolves when agent_settled event is received.
     */
    waitForIdle(timeout?: number): Promise<void>;
    /**
     * Collect events until agent becomes idle.
     */
    collectEvents(timeout?: number): Promise<AgentSessionEvent[]>;
    /**
     * Send prompt and wait for completion, returning all events.
     */
    promptAndWait(message: string, images?: ImageContent[], timeout?: number): Promise<AgentSessionEvent[]>;
    private handleLine;
    private createProcessExitError;
    private rejectPendingRequests;
    private send;
    private getData;
}
//# sourceMappingURL=rpc-client.d.ts.map