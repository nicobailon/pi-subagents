import * as fs from "node:fs";
import * as path from "node:path";

export interface StepContext {
    chain_dir: string;
    step_index: number;
    agent: string;
    task: string;
    output?: string;
    reads: string[];
    inputs: Record<string, StepInputEntry>;
    run_id: string;
    artifacts_dir: string;
}

export interface StepInputEntry {
    text: string;
    structured?: unknown;
}

export function writeStepContextFile(artifactsDir: string, context: StepContext): string {
    const safeAgent = context.agent.replace(/[^\w.-]/g, "_");
    const fileName = `${context.run_id}_${safeAgent}_${context.step_index}_context.json`;
    const filePath = path.join(artifactsDir, fileName);
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(context, null, 2));
    return filePath;
}
