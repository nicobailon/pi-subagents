import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type { ProjectTrustContext, ReplacedSessionContext, SessionStartEvent } from "./extensions/index.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { SessionManager } from "./session-manager.ts";
/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
    services: AgentSessionServices;
    diagnostics: AgentSessionRuntimeDiagnostic[];
}
/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    sessionStartEvent?: SessionStartEvent;
    projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;
/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export declare class SessionImportFileNotFoundError extends Error {
    readonly filePath: string;
    constructor(filePath: string);
}
/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
export declare class AgentSessionRuntime {
    private rebindSession?;
    private beforeSessionInvalidate?;
    private _session;
    private _services;
    private readonly createRuntime;
    private _diagnostics;
    private _modelFallbackMessage?;
    constructor(_session: AgentSession, _services: AgentSessionServices, createRuntime: CreateAgentSessionRuntimeFactory, _diagnostics?: AgentSessionRuntimeDiagnostic[], _modelFallbackMessage?: string);
    get services(): AgentSessionServices;
    get session(): AgentSession;
    get cwd(): string;
    get diagnostics(): readonly AgentSessionRuntimeDiagnostic[];
    get modelFallbackMessage(): string | undefined;
    setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void;
    /**
     * Set a synchronous callback that runs after `session_shutdown` handlers finish
     * but before the current session is invalidated.
     *
     * This is for host-owned UI teardown that must not yield to the event loop,
     * such as detaching extension-provided TUI components before the old extension
     * context becomes stale.
     */
    setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void;
    private emitBeforeSwitch;
    private emitBeforeFork;
    private teardownCurrent;
    private apply;
    private finishSessionReplacement;
    switchSession(sessionPath: string, options?: {
        cwdOverride?: string;
        withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
        projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
    }): Promise<{
        cancelled: boolean;
    }>;
    newSession(options?: {
        parentSession?: string;
        setup?: (sessionManager: SessionManager) => Promise<void>;
        withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
    }): Promise<{
        cancelled: boolean;
    }>;
    fork(entryId: string, options?: {
        position?: "before" | "at";
        withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
    }): Promise<{
        cancelled: boolean;
        selectedText?: string;
    }>;
    /**
     * Import a session JSONL file and switch runtime state to the imported session.
     *
     * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
     * @throws {SessionImportFileNotFoundError} When the input path does not exist.
     * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
     */
    importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{
        cancelled: boolean;
    }>;
    dispose(): Promise<void>;
}
/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export declare function createAgentSessionRuntime(createRuntime: CreateAgentSessionRuntimeFactory, options: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    sessionStartEvent?: SessionStartEvent;
}): Promise<AgentSessionRuntime>;
export { type AgentSessionRuntimeDiagnostic, type AgentSessionServices, type CreateAgentSessionFromServicesOptions, type CreateAgentSessionServicesOptions, createAgentSessionFromServices, createAgentSessionServices, } from "./agent-session-services.ts";
//# sourceMappingURL=agent-session-runtime.d.ts.map