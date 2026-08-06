import { Container, type TUI } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../../core/extensions/types.ts";
export interface ToolExecutionOptions {
    showImages?: boolean;
    imageWidthCells?: number;
}
export declare class ToolExecutionComponent extends Container {
    private contentBox;
    private contentText;
    private selfRenderContainer;
    private callRendererComponent?;
    private resultRendererComponent?;
    private rendererState;
    private imageComponents;
    private imageSpacers;
    private toolName;
    private toolCallId;
    private args;
    private expanded;
    private showImages;
    private imageWidthCells;
    private isPartial;
    private toolDefinition?;
    private builtInToolDefinition?;
    private ui;
    private cwd;
    private executionStarted;
    private argsComplete;
    private result?;
    private convertedImages;
    private hideComponent;
    constructor(toolName: string, toolCallId: string, args: any, options: ToolExecutionOptions | undefined, toolDefinition: ToolDefinition<any, any> | undefined, ui: TUI, cwd: string);
    private getCallRenderer;
    private getResultRenderer;
    private hasRendererDefinition;
    private getRenderShell;
    private getRenderContext;
    private createCallFallback;
    private createResultFallback;
    updateArgs(args: any): void;
    markExecutionStarted(): void;
    setArgsComplete(): void;
    updateResult(result: {
        content: Array<{
            type: string;
            text?: string;
            data?: string;
            mimeType?: string;
        }>;
        details?: any;
        isError: boolean;
    }, isPartial?: boolean): void;
    private maybeConvertImagesForKitty;
    setExpanded(expanded: boolean): void;
    setShowImages(show: boolean): void;
    setImageWidthCells(width: number): void;
    invalidate(): void;
    render(width: number): string[];
    private updateDisplay;
    private getTextOutput;
    private formatToolExecution;
}
//# sourceMappingURL=tool-execution.d.ts.map