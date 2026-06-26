import { z } from "zod";
import { unlink } from "node:fs/promises";
import { runHexo, postsDir, parseFilename } from "./hexo.js";

const FILENAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,78}\.md$/;

const InputSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(120)
    .regex(
      FILENAME_RE,
      "Filename must look like YYYY-MM-DD-slug.md (lowercase, dashes, no path traversal)"
    )
    .describe(
      "Filename to delete (e.g. '2026-06-24-leetcode-partition-labels.md'). " +
        "Must be just the filename, no path. Pattern enforced."
    ),
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "Must be true to actually delete. Destructive operation: " +
        "removes the source file AND regenerates the blog (which can take 10-30s)."
    ),
});

export const hexoDeleteTool = {
  name: "hexo_delete",
  description:
    "Delete a Hexo blog post by filename and regenerate. Refuses unless confirm=true. " +
    "Filename must match YYYY-MM-DD-slug.md (no path traversal).",
  inputSchema: {
    type: "object" as const,
    properties: {
      filename: { type: "string", description: "Filename to delete (no path)" },
      confirm: {
        type: "boolean",
        default: false,
        description: "Set true to confirm deletion",
      },
    },
    required: ["filename"],
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const parsed = InputSchema.parse(args);
    if (!parsed.confirm) {
      throw new Error(
        "Refused: hexo_delete is destructive. Re-call with confirm=true to actually delete " +
          "and regenerate."
      );
    }
    const target = `${postsDir()}/${parsed.filename}`;
    await unlink(target);
    const gen = await runHexo("generate --force", 90_000);
    if (gen.exitCode !== 0) {
      throw new Error(
        `File ${parsed.filename} deleted but hexo generate FAILED (exit ${gen.exitCode}). ` +
          `stderr: ${gen.stderr.slice(0, 800)}`
      );
    }
    const parts = parseFilename(parsed.filename);
    return [
      `Deleted: ${parsed.filename}`,
      `Path: ${target}`,
      `hexo generate: exit=${gen.exitCode}  duration=${gen.durationMs}ms`,
      parts ? `Was: date=${parts.date}, slug=${parts.slug}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  },
};
