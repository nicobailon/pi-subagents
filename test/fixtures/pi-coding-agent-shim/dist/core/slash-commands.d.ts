import type { SourceInfo } from "./source-info.ts";
export type SlashCommandSource = "extension" | "prompt" | "skill";
export interface SlashCommandInfo {
    name: string;
    description?: string;
    source: SlashCommandSource;
    sourceInfo: SourceInfo;
}
export interface BuiltinSlashCommand {
    name: string;
    description: string;
    argumentHint?: string;
}
export declare const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand>;
//# sourceMappingURL=slash-commands.d.ts.map