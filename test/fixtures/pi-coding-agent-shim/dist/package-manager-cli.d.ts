import type { InlineExtension } from "./core/extensions/types.ts";
export type PackageCommand = "install" | "remove" | "update" | "list";
export interface PackageCommandRuntimeOptions {
    extensionFactories?: InlineExtension[];
}
export declare function handleConfigCommand(args: string[], runtimeOptions?: PackageCommandRuntimeOptions): Promise<boolean>;
export declare function handlePackageCommand(args: string[], runtimeOptions?: PackageCommandRuntimeOptions): Promise<boolean>;
//# sourceMappingURL=package-manager-cli.d.ts.map