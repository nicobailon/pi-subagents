/**
 * Component for displaying bash command execution with streaming output.
 */
import { Container, type TUI } from "@earendil-works/pi-tui";
import { type TruncationResult } from "../../../core/tools/truncate.ts";
export declare class BashExecutionComponent extends Container {
    private command;
    private outputLines;
    private status;
    private exitCode;
    private loader;
    private truncationResult?;
    private fullOutputPath?;
    private expanded;
    private contentContainer;
    constructor(command: string, ui: TUI, excludeFromContext?: boolean);
    /**
     * Set whether the output is expanded (shows full output) or collapsed (preview only).
     */
    setExpanded(expanded: boolean): void;
    invalidate(): void;
    appendOutput(chunk: string): void;
    setComplete(exitCode: number | undefined, cancelled: boolean, truncationResult?: TruncationResult, fullOutputPath?: string): void;
    private updateDisplay;
    /**
     * Get the raw output for creating BashExecutionMessage.
     */
    getOutput(): string;
    /**
     * Get the command that was executed.
     */
    getCommand(): string;
}
//# sourceMappingURL=bash-execution.d.ts.map