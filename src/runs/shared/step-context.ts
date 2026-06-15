import * as fs from "node:fs";
import * as path from "node:path";

export interface StepContext {
    chain_dir: string;
    step_index: number;
    agent: string;
    output?: string;
    reads: string[];
    inputs: Record<string, StepInputEntry>;
}

export interface StepInputEntry {
    text: string;
    structured?: unknown;
}

export function writeStepContextFile(chainDir: string, context: StepContext): string {
    const filePath = path.join(chainDir, `step-${context.step_index}-context.json`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(context, null, 2));
    return filePath;
}
