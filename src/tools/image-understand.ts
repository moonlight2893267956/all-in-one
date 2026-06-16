import { z } from "zod";

const DASHSCOPE_VL_MODELS = [
  "qwen3-vl-flash",
  "qwen-vl-plus",
  "qwen-vl-max",
  "qwen2-vl-72b-instruct",
] as const;
type DashScopeVlModel = (typeof DASHSCOPE_VL_MODELS)[number];

const DASHSCOPE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

interface DashScopeChoice {
  message?: { content?: string };
}
interface DashScopeResponse {
  choices?: DashScopeChoice[];
  error?: { code?: string; message?: string };
}

async function fetchImageAsDataUrl(
  source: { path?: string; url?: string }
): Promise<{ mime: string; data: string; bytes: number }> {
  if (source.path) {
    const fs = await import("node:fs/promises");
    const buf = await fs.readFile(source.path);
    const ext = source.path.toLowerCase().split(".").pop() ?? "png";
    const mime =
      ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "webp"
        ? "image/webp"
        : ext === "gif"
        ? "image/gif"
        : "image/png";
    return {
      mime,
      data: buf.toString("base64"),
      bytes: buf.length,
    };
  }
  if (source.url) {
    const resp = await fetch(source.url);
    if (!resp.ok) {
      throw new Error(`Failed to fetch image from URL: ${resp.status}`);
    }
    const ct = resp.headers.get("content-type") ?? "image/png";
    const mime = ct.split(";")[0].trim();
    const buf = Buffer.from(await resp.arrayBuffer());
    return { mime, data: buf.toString("base64"), bytes: buf.length };
  }
  throw new Error("Either image_path or image_url must be provided");
}

const InputSchema = z
  .object({
    image_path: z
      .string()
      .optional()
      .describe("Local filesystem path to the image. Mutually exclusive with image_url."),
    image_url: z
      .string()
      .url()
      .optional()
      .describe("HTTP(S) URL of the image. Mutually exclusive with image_path."),
    prompt: z
      .string()
      .default("请详细描述这张图片的内容，包括所有文字、界面元素和布局。")
      .describe("Question or instruction about the image"),
    model: z
      .enum(DASHSCOPE_VL_MODELS)
      .default("qwen3-vl-flash")
      .describe(
        "DashScope vision model. qwen3-vl-flash is fast and cheap; qwen-vl-plus / -max are stronger."
      ),
    max_tokens: z
      .number()
      .int()
      .min(64)
      .max(8192)
      .default(2000)
      .describe("Maximum tokens in the response"),
  })
  .refine((v) => Boolean(v.image_path) !== Boolean(v.image_url), {
    message: "Provide exactly one of image_path or image_url",
  });

export const imageUnderstandTool = {
  name: "image_understand",
  description:
    "Analyze an image with a DashScope vision-language model and return a text description. " +
    "Accepts a local file path or an HTTP(S) URL. Use this when the user asks about " +
    "the contents of a screenshot, photo, diagram, or any visual content. " +
    "Note: when running as a remote MCP server, image_path must refer to a path on the server, " +
    "or use image_url with a COS URL / public link.",
  inputSchema: {
    type: "object" as const,
    properties: {
      image_path: {
        type: "string",
        description: "Local filesystem path to the image. Mutually exclusive with image_url.",
      },
      image_url: {
        type: "string",
        format: "uri",
        description: "HTTP(S) URL of the image. Mutually exclusive with image_path.",
      },
      prompt: {
        type: "string",
        default: "请详细描述这张图片的内容，包括所有文字、界面元素和布局。",
        description: "Question or instruction about the image",
      },
      model: {
        type: "string",
        enum: DASHSCOPE_VL_MODELS as unknown as string[],
        default: "qwen3-vl-flash",
        description:
          "DashScope vision model. qwen3-vl-flash is fast and cheap; qwen-vl-plus / -max are stronger.",
      },
      max_tokens: {
        type: "integer",
        minimum: 64,
        maximum: 8192,
        default: 2000,
        description: "Maximum tokens in the response",
      },
    },
    required: [],
  },
  handler: async (args: Record<string, unknown>) => {
    const parsed = InputSchema.parse(args);
    const apiKey = process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_API_KEY;
    if (!apiKey) {
      throw new Error("DASHSCOPE_API_KEY (or QWEN_API_KEY) env var is not set");
    }

    const { mime, data, bytes } = await fetchImageAsDataUrl({
      path: parsed.image_path,
      url: parsed.image_url,
    });

    const payload = {
      model: parsed.model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mime};base64,${data}` },
            },
            { type: "text", text: parsed.prompt },
          ],
        },
      ],
      max_tokens: parsed.max_tokens,
    };

    const resp = await fetch(DASHSCOPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = (await resp.json()) as DashScopeResponse;
    if (!resp.ok || result.error) {
      const msg = result.error?.message ?? `HTTP ${resp.status}`;
      throw new Error(`DashScope error: ${msg}`);
    }
    const text = result.choices?.[0]?.message?.content ?? "";
    if (!text) {
      throw new Error("Empty response from DashScope");
    }

    return [
      `Model: ${parsed.model}`,
      `Image: ${parsed.image_path ?? parsed.image_url} (${(bytes / 1024).toFixed(1)} KB, ${mime})`,
      "",
      text,
    ].join("\n");
  },
};
