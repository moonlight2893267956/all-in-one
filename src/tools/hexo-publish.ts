import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Buffer } from "node:buffer";
import {
  runHexo,
  postsDir,
  buildFrontMatter,
  getServerDate,
  getTodayPrefix,
  slugifyTitle,
  ensureFilename,
  ensureDatePrefix,
  parseFilename,
} from "./hexo.js";

const InputSchema = z.object({
  title: z.string().min(1).max(200).describe("Post title (required)"),
  content: z
    .string()
    .min(1)
    .describe(
      "Markdown body (without front matter). The tool builds and prepends the front matter automatically."
    ),
  tags: z
    .array(z.string().min(1).max(50))
    .default([])
    .describe("Post tags (optional)"),
  categories: z
    .array(z.string().min(1).max(50))
    .default([])
    .describe("Post categories (optional)"),
  slug: z
    .string()
    .optional()
    .describe(
      "URL slug (lowercase, dashes). Defaults to a slugified version of the title. " +
        "Final filename: YYYY-MM-DD-<slug>.md"
    ),
  date: z
    .string()
    .optional()
    .describe(
      "Override the post date (format: 'YYYY-MM-DD HH:mm:ss'). " +
        "Defaults to current server time. The date prefix of the filename always " +
        "matches the date field. Future dates are rejected."
    ),
  overwrite: z
    .boolean()
    .default(false)
    .describe(
      "If a file with the target filename already exists, overwrite it. " +
        "Otherwise the call fails with the existing filename in the error so you can " +
        "explicitly confirm with overwrite=true."
    ),
});

function renderFullPost(args: {
  title: string;
  content: string;
  tags: string[];
  categories: string[];
  date: string;
}): string {
  const fm = buildFrontMatter({
    title: args.title,
    date: args.date,
    tags: args.tags,
    categories: args.categories,
  });
  return `${fm}\n\n${args.content.trim()}\n`;
}

export const hexoPublishTool = {
  name: "hexo_publish",
  description:
    "Publish or update a Hexo blog post. Builds the front matter from the inputs, " +
    "writes the file into <HEXO_SOURCE_DIR>/source/_posts/YYYY-MM-DD-<slug>.md, " +
    "and runs `hexo generate --force` (via _config.server.yml, so output goes to " +
    "the site dir configured there, not the default public/). " +
    "Date defaults to the current server time; the filename date prefix always " +
    "matches the date field. Future dates are rejected. If the target file " +
    "already exists, the call fails unless overwrite=true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "Post title" },
      content: { type: "string", description: "Markdown body (without front matter)" },
      tags: { type: "array", items: { type: "string" }, description: "Tags" },
      categories: { type: "array", items: { type: "string" }, description: "Categories" },
      slug: { type: "string", description: "URL slug (defaults to slugified title)" },
      date: { type: "string", description: "Override date 'YYYY-MM-DD HH:mm:ss'" },
      overwrite: {
        type: "boolean",
        default: false,
        description: "Overwrite existing file at target filename",
      },
    },
    required: ["title", "content"],
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const parsed = InputSchema.parse(args);

    const dateStr = parsed.date ?? getServerDate();
    const datePrefix = dateStr.split(" ")[0] ?? "";
    ensureDatePrefix(datePrefix);

    const todayPrefix = getTodayPrefix();
    if (datePrefix > todayPrefix) {
      throw new Error(
        `Refused: post date ${datePrefix} is in the future (server today is ${todayPrefix}). ` +
          "Fix the date or omit it to use the current time."
      );
    }

    const slug = parsed.slug ? slugifyTitle(parsed.slug) : slugifyTitle(parsed.title);
    const filename = ensureFilename(datePrefix, slug);
    const target = `${postsDir()}/${filename}`;

    const checkResult = await runHexo(
      `list post --path source/_posts/${filename} 2>/dev/null; true`,
      5_000
    );
    const exists = /^\s*\d+\s+post/.test(checkResult.stdout) ||
      checkResult.stdout.includes(filename);
    if (exists && !parsed.overwrite) {
      throw new Error(
        `Refused: ${filename} already exists. Re-call with overwrite=true to replace it.`
      );
    }

    const fullPost = renderFullPost({
      title: parsed.title,
      content: parsed.content,
      tags: parsed.tags,
      categories: parsed.categories,
      date: dateStr,
    });
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(fullPost, "utf8"), { mode: 0o644 });

    const gen = await runHexo("generate --force", 90_000);
    if (gen.exitCode !== 0) {
      throw new Error(
        `File written to ${filename} but hexo generate FAILED (exit ${gen.exitCode}). ` +
          `stderr: ${gen.stderr.slice(0, 800)}\nstdout: ${gen.stdout.slice(0, 800)}`
      );
    }

    const parts = parseFilename(filename);
    return [
      `Published: ${filename}`,
      `Title: ${parsed.title}`,
      `Date: ${dateStr}`,
      `Tags: ${parsed.tags.join(", ") || "(none)"}`,
      `Categories: ${parsed.categories.join(", ") || "(none)"}`,
      `Size: ${Buffer.byteLength(fullPost)} bytes`,
      `Path: ${target}`,
      `hexo generate: exit=${gen.exitCode}  duration=${gen.durationMs}ms`,
      parts ? `URL: https://blog.yunmiao.site/${parts.date.replace(/-/g, "/")}/${parts.slug}/` : "",
    ]
      .filter(Boolean)
      .join("\n");
  },
};
