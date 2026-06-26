import { runHexo } from "./hexo.js";

export const hexoRebuildTool = {
  name: "hexo_rebuild",
  description:
    "Full clean rebuild of the Hexo blog: hexo clean + hexo generate --force. " +
    "Use after editing theme/_config/_data files. Skips the regenerate that " +
    "hexo_publish / hexo_delete do automatically — this one wipes the public/ " +
    "output and regenerates from scratch. Can take 30-90 seconds.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
  handler: async (): Promise<string> => {
    const clean = await runHexo("clean", 60_000);
    if (clean.exitCode !== 0) {
      throw new Error(
        `hexo clean FAILED (exit ${clean.exitCode}): ${clean.stderr || clean.stdout}`
      );
    }
    const gen = await runHexo("generate --force", 180_000);
    if (gen.exitCode !== 0) {
      throw new Error(
        `hexo generate FAILED (exit ${gen.exitCode}): ${gen.stderr || gen.stdout}`
      );
    }
    return [
      "hexo clean: OK",
      `hexo generate --force: OK  duration=${gen.durationMs}ms`,
      `Total duration: ${clean.durationMs + gen.durationMs}ms`,
    ].join("\n");
  },
};
