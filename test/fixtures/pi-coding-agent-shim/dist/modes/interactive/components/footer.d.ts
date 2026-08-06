import { type Component } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
/**
 * Format token counts for compact footer display.
 */
export declare function formatTokens(count: number): string;
export declare function formatCwdForFooter(cwd: string, home: string | undefined): string;
/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export declare class FooterComponent implements Component {
    private autoCompactEnabled;
    private session;
    private footerData;
    constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider);
    setSession(session: AgentSession): void;
    setAutoCompactEnabled(enabled: boolean): void;
    /**
     * No-op: git branch caching now handled by provider.
     * Kept for compatibility with existing call sites in interactive-mode.
     */
    invalidate(): void;
    /**
     * Clean up resources.
     * Git watcher cleanup now handled by provider.
     */
    dispose(): void;
    render(width: number): string[];
}
//# sourceMappingURL=footer.d.ts.map