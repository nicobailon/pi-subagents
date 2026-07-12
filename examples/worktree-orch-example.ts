/**
 * worktree-orch-example.ts
 *
 * Przykładowy skrypt orchestratora używający runInWorktree.
 * Wszystkie wywołania runAgent() wewnątrz worktree działają na
 * tym samym izolowanym drzewie roboczym git.
 * Po zakończeniu bloku tworzony jest patch ze zmianami.
 *
 * Użycie:
 *   /pi-orch ./examples/worktree-orch-example.ts
 */

import type { OrchestratorScript } from "../src/orchestrator/orchestrator-context";

const script: OrchestratorScript = {
  flow: async (ctx) => {
    ctx.log("Starting worktree orchestrator example...");

    const result = await ctx.runInWorktree(async (wt) => {
      wt.log(`Working inside worktree: ${wt.worktreePath}`);

      // Krok 1: implementacja
      const step1 = await wt.runAgent({
        agent: "worker",
        task: "Add unit tests for the authentication module. Write tests that cover login, logout, and token refresh.",
      });
      wt.log(`Step 1 (worker) exitCode=${step1.exitCode}`);

      if (step1.exitCode !== 0) {
        throw new Error(`Worker failed: ${step1.error}`);
      }

      // Krok 2: code review wewnątrz worktree
      const step2 = await wt.runAgent({
        agent: "reviewer",
        task: "Review the test changes made by the previous step. Fix any issues you find.",
      });
      wt.log(`Step 2 (reviewer) exitCode=${step2.exitCode}`);

      return {
        message: "Worktree block completed successfully",
        steps: [step1.agent, step2.agent],
      };
    });

    ctx.log(`Patch saved to: ${result.patchPath}`);
    ctx.log(
      `Changes: ${result.filesChanged} files, +${result.insertions} -${result.deletions}`,
    );

    const output = [
      `# Worktree Orchestrator Result\n`,
      `**Status**: ${result.message}\n`,
      `**Steps executed**: ${result.steps.join(" → ")}\n`,
      `## Diff summary\n`,
      `- Files changed: ${result.filesChanged}`,
      `- Insertions: +${result.insertions}`,
      `- Deletions: -${result.deletions}\n`,
      `## Diff stat\n`,
      "```",
      result.diffStat || "(no changes)",
      "```\n",
      `## Full patch\n`,
      `Saved to: \`${result.patchPath}\`\n`,
      `\`\`\`diff`,
      result.patch || "(empty)",
      "```",
    ].join("\n");

    return { output };
  },
};

export default script;
