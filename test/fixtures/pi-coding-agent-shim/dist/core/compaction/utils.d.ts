/**
 * Shared utilities for compaction and branch summarization.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message } from "@earendil-works/pi-ai";
export interface FileOperations {
    read: Set<string>;
    written: Set<string>;
    edited: Set<string>;
}
export declare function createFileOps(): FileOperations;
/**
 * Extract file operations from tool calls in an assistant message.
 */
export declare function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void;
/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export declare function computeFileLists(fileOps: FileOperations): {
    readFiles: string[];
    modifiedFiles: string[];
};
/**
 * Format file operations as XML tags for summary.
 */
export declare function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string;
/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
export declare function serializeConversation(messages: Message[]): string;
export declare const SUMMARIZATION_SYSTEM_PROMPT = "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";
//# sourceMappingURL=utils.d.ts.map