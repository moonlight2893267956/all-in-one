import { z } from "zod";
import { Buffer } from "node:buffer";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const SILICONFLOW_MODELS = [
  "Kwai-Kolors/Kolors",
  "black-forest-labs/FLUX.1-schnell",
  "black-forest-labs/FLUX.1-dev",
  "stabilityai/stable-diffusion-3-5-large",
] as const;

const DASHSCOPE_IMAGE_MODELS = [
  "qwen-image-2.0-pro",
  "wan2.7-image-pro",
] as const;

const SILICONFLOW_URL = "https://api.siliconflow.cn/v1/images/generations";
const DASHSCOPE_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

interface DashScopeResponse {
  output?: {
    choices?: Array<{
      message?: { content?: Array<{ image?: string }> };
    }>;
  };
  error?: { code?: string; message?: string };
}

interface SiliconFlowResponse {
  images?: Array<{ url?: string }>;
  error?: { message?: string };
}

const DEFAULT_OUTPUT_DIR = "/tmp/mcp-images";

const InputSchema = z.object({
  prompt: z.string().min(1).describe("Text description of the image to generate"),
  provider: z
    .enum(["siliconflow", "dashscope"])
    .optional()
    .describe(
      "Image provider. If omitted, picks whichever API key is configured (siliconflow first)."
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Model name. Defaults to Kwai-Kolors/Kolors (siliconflow) or qwen-image-2.0-pro (dashscope). " +
        "Provider-specific valid models: siliconflow: Kwai-Kolors/Kolors, black-forest-labs/FLUX.1-schnell, " +
        "black-forest-labs/FLUX.1-dev, stabilityai/stable-diffusion-3-5-large; " +
        "dashscope: qwen-image-2.0-pro, wan2.7-image-pro."
    ),
  size: z
    .string()
    .default("1024x1024")
    .describe(
      "Image size. Format depends on provider: siliconflow uses 'WxH' (e.g. 1024x1024, 1280x720); " +
        "dashscope uses 'W*H' (e.g. 1024*1024, 2048*2048). The script will translate if needed."
    ),
  negative_prompt: z
    .string()
    .optional()
    .describe("Negative prompt describing what to avoid"),
  save_to: z
    .string()
    .optional()
    .describe(
      "Absolute path on the server to write the image. If omitted, writes to /tmp/mcp-images/<timestamp>.<ext>."
    ),
  upload_to_cos: z
    .boolean()
    .default(true)
    .describe(
      "If true (default), also upload the generated image to the configured COS bucket and " +
        "return the public URL. Set to false to keep the file only on the server."
    ),
  cos_key: z
    .string()
    .optional()
    .describe(
      "COS object key when upload_to_cos is true. Defaults to mcp-images/<basename>."
    ),
  cos_acl: z
    .enum(["private", "public-read"])
    .default("public-read")
    .describe("ACL applied to the uploaded COS object. public-read lets the URL work directly."),
});

function pickProvider(explicit?: "siliconflow" | "dashscope"): "siliconflow" | "dashscope" {
  if (explicit) return explicit;
  if (process.env.SILICONFLOW_API_KEY) return "siliconflow";
  if (process.env.DASHSCOPE_API_KEY) return "dashscope";
  throw new Error(
    "No image provider API key found. Set SILICONFLOW_API_KEY or DASHSCOPE_API_KEY."
  );
}

async function generateSiliconFlow(
  prompt: string,
  model: string,
  size: string,
  negativePrompt: string | undefined
): Promise<string> {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) throw new Error("SILICONFLOW_API_KEY is not set");

  const params: Record<string, unknown> = {
    model,
    prompt,
    image_size: size.replace("*", "x"),
    num_inference_steps: 20,
    batch_size: 1,
  };
  if (negativePrompt) params.negative_prompt = negativePrompt;

  const resp = await fetch(SILICONFLOW_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  const result = (await resp.json()) as SiliconFlowResponse;
  if (!resp.ok) {
    throw new Error(
      `SiliconFlow error (${resp.status}): ${result.error?.message ?? "unknown"}`
    );
  }
  const url = result.images?.[0]?.url;
  if (!url) {
    throw new Error(
      `No image URL in SiliconFlow response: ${JSON.stringify(result).slice(0, 500)}`
    );
  }
  return url;
}

async function generateDashScope(
  prompt: string,
  model: string,
  size: string,
  negativePrompt: string | undefined
): Promise<string> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY is not set");

  const parameters: Record<string, unknown> = {
    n: 1,
    size,
    prompt_extend: true,
    watermark: false,
  };
  if (negativePrompt) parameters.negative_prompt = negativePrompt;

  const payload = {
    model,
    input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
    parameters,
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
    throw new Error(
      `DashScope error: ${result.error?.message ?? `HTTP ${resp.status}`}`
    );
  }
  const url = result.output?.choices?.[0]?.message?.content?.find(
    (c) => c.image
  )?.image;
  if (!url) {
    throw new Error(
      `No image URL in DashScope response: ${JSON.stringify(result).slice(0, 500)}`
    );
  }
  return url;
}

export const imageGenerateTool = {
  name: "image_generate",
  description:
    "Generate an image from a text prompt using SiliconFlow (Kwai-Kolors, FLUX, SD3.5) or " +
    "DashScope (qwen-image, wan2.7). The image is downloaded to the server filesystem at " +
    "save_to (default /tmp/mcp-images/) and its path is returned. Optionally also uploads to COS " +
    "(upload_to_cos=true) and returns the public/presigned URL.",
  inputSchema: {
    type: "object" as const,
    properties: {
      prompt: { type: "string", description: "Text description of the image to generate" },
      provider: {
        type: "string",
        enum: ["siliconflow", "dashscope"],
        description:
          "Image provider. If omitted, picks whichever API key is configured (siliconflow first).",
      },
      model: {
        type: "string",
        description:
          "Model name. Defaults to Kwai-Kolors/Kolors (siliconflow) or qwen-image-2.0-pro (dashscope).",
      },
      size: {
        type: "string",
        default: "1024x1024",
        description:
          "Image size. Format depends on provider: siliconflow 'WxH', dashscope 'W*H'.",
      },
      negative_prompt: { type: "string", description: "Negative prompt" },
      save_to: {
        type: "string",
        description:
          "Absolute path on the server. Defaults to /tmp/mcp-images/<timestamp>.<ext>.",
      },
      upload_to_cos: {
        type: "boolean",
        default: true,
        description:
          "If true (default), uploads to COS and returns the public URL. Set false to skip.",
      },
      cos_key: {
        type: "string",
        description: "COS object key. Defaults to mcp-images/<basename>.",
      },
      cos_acl: {
        type: "string",
        enum: ["private", "public-read"],
        default: "public-read",
        description: "ACL for the uploaded object. public-read makes the URL directly accessible.",
      },
    },
    required: ["prompt"],
  },
  handler: async (args: Record<string, unknown>) => {
    const parsed = InputSchema.parse(args);
    const provider = pickProvider(parsed.provider);

    let model = parsed.model;
    if (!model) {
      model =
        provider === "siliconflow"
          ? process.env.SILICONFLOW_IMAGE_MODEL ?? "Kwai-Kolors/Kolors"
          : process.env.DASHSCOPE_IMAGE_MODEL ?? "qwen-image-2.0-pro";
    }

    const url =
      provider === "siliconflow"
        ? await generateSiliconFlow(
            parsed.prompt,
            model,
            parsed.size,
            parsed.negative_prompt
          )
        : await generateDashScope(
            parsed.prompt,
            model,
            parsed.size,
            parsed.negative_prompt
          );

    // Download to local filesystem
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to download generated image: ${resp.status}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());

    const fallbackName = parsed.save_to ?? `${DEFAULT_OUTPUT_DIR}/${Date.now()}.png`;
    const ext = guessImageExtension(resp.headers.get("content-type"), fallbackName);
    const saveTo = parsed.save_to ?? `${DEFAULT_OUTPUT_DIR}/${Date.now()}.${ext}`;
    await mkdir(dirname(saveTo), { recursive: true });
    await writeFile(saveTo, buf);

    const lines: string[] = [
      `Provider: ${provider}`,
      `Model: ${model}`,
      `Prompt: ${parsed.prompt.slice(0, 200)}${parsed.prompt.length > 200 ? "..." : ""}`,
      `Size: ${(buf.length / 1024).toFixed(1)} KB`,
      `Saved to: ${saveTo}`,
    ];

    if (parsed.upload_to_cos) {
      const { cosKey, publicUrl, acl } = await uploadToCos(
        buf,
        saveTo,
        parsed.cos_key,
        parsed.cos_acl
      );
      lines.push(`COS key: ${cosKey}`);
      lines.push(`COS ACL: ${acl}`);
      lines.push(`COS URL: ${publicUrl}`);
    } else {
      lines.push(`(upload_to_cos=false; COS upload skipped)`);
    }

    return lines.join("\n");
  },
};

async function uploadToCos(
  buf: Buffer,
  saveTo: string,
  cosKeyOverride: string | undefined,
  acl: "private" | "public-read"
): Promise<{ cosKey: string; publicUrl: string; acl: string }> {
  const { cosUploadBuffer, buildPublicUrl } = await import("./cos-client.js");
  const cosKey =
    cosKeyOverride ?? `mcp-images/${saveTo.split("/").pop() ?? "image.png"}`;
  const r = await cosUploadBuffer(buf, cosKey, undefined, undefined, { acl });
  return { cosKey, publicUrl: buildPublicUrl(cosKey), acl: r.acl };
}

function guessImageExtension(
  contentType: string | null,
  fallbackPath: string
): string {
  if (contentType) {
    if (contentType.includes("jpeg")) return "jpg";
    if (contentType.includes("png")) return "png";
    if (contentType.includes("webp")) return "webp";
    if (contentType.includes("gif")) return "gif";
  }
  const m = fallbackPath.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : "png";
}
