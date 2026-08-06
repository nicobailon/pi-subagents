export interface ResourceCollision {
    resourceType: "extension" | "skill" | "prompt" | "theme";
    name: string;
    winnerPath: string;
    loserPath: string;
    winnerSource?: string;
    loserSource?: string;
}
export interface ResourceDiagnostic {
    type: "warning" | "error" | "collision";
    message: string;
    path?: string;
    collision?: ResourceCollision;
}
//# sourceMappingURL=diagnostics.d.ts.map