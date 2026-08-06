export interface SessionCwdIssue {
    sessionFile?: string;
    sessionCwd: string;
    fallbackCwd: string;
}
interface SessionCwdSource {
    getCwd(): string;
    getSessionFile(): string | undefined;
}
export declare function getMissingSessionCwdIssue(sessionManager: SessionCwdSource, fallbackCwd: string): SessionCwdIssue | undefined;
export declare function formatMissingSessionCwdError(issue: SessionCwdIssue): string;
export declare function formatMissingSessionCwdPrompt(issue: SessionCwdIssue): string;
export declare class MissingSessionCwdError extends Error {
    readonly issue: SessionCwdIssue;
    constructor(issue: SessionCwdIssue);
}
export declare function assertSessionCwdExists(sessionManager: SessionCwdSource, fallbackCwd: string): void;
export {};
//# sourceMappingURL=session-cwd.d.ts.map