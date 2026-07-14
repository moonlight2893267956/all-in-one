import { z } from "zod";
import { Buffer } from "node:buffer";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getApiKey } from "../config.js";

const NEWAPI_MODELS = [
  "gpt-image-2",
  "gpt-image-1",
  "dall-e-3",
  "dall-e-2",
] as const;

const DASHSCOPE_IMAGE_MODELS = [
  "qwen-image-2.0-pro",
  "wan2.7-image-pro",
] as const;

const NEWAPI_DEFAULT_BASE_URL = "https://ai.centos.hk/v1";
const DASHSCOPE_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

function newApiUrl(): string {
  const base = (process.env.NEWAPI_BASE_URL ?? NEWAPI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}/images/generations`;
}

interface DashScopeResponse {
  output?: {
    choices?: Array<{
      message?: { content?: Array<{ image?: string }> };
    }>;
  };
  error?: { code?: string; message?: string };
}

interface NewApiImageResponse {
  created?: number;
  data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
  error?: { message?: string; code?: string };
}

const DEFAULT_OUTPUT_DIR = "/tmp/mcp-images";

const InputSchema = z.object({
  prompt: z.string().min(1).describe("Text description of the image to generate"),
  provider: z
    .enum(["newapi", "dashscope"])
    .optional()
    .describe(
      "Image provider. If omitted, uses newapi (gpt-image-2) when NEWAPI_API_KEY is set, " +
        "otherwise falls back to dashscope. Set explicitly to force a provider."
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Model name. Defaults to gpt-image-2 (newapi) or qwen-image-2.0-pro (dashscope). " +
        "Provider-specific valid models: newapi (OpenAI-compatible): gpt-image-2, gpt-image-1, " +
        "dall-e-3, dall-e-2; dashscope: qwen-image-2.0-pro, wan2.7-image-pro."
    ),
  size: z
    .string()
    .default("1024x1024")
    .describe(
      "Image size. Format depends on provider: newapi uses 'WxH' (e.g. 1024x1024, 1536x1024, " +
        "1024x1536); dashscope uses 'W*H' (e.g. 1024*1024, 2048*2048). The script translates if needed."
    ),
  negative_prompt: z
    .string()
    .optional()
    .describe("Negative prompt describing what to avoid (dashscope only; ignored by newapi)"),
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

type Provider = "newapi" | "dashscope";

function pickProvider(explicit?: Provider): Provider {
  if (explicit) return explicit;
  if (getApiKey("NEWAPI_API_KEY", { allowUnset: true })) return "newapi";
  if (getApiKey("DASHSCOPE_API_KEY", { allowUnset: true })) return "dashscope";
  throw new Error(
    "No image provider API key found. Set NEWAPI_API_KEY or DASHSCOPE_API_KEY."
  );
}

async function generateNewApi(
  prompt: string,
  model: string,
  size: string
): Promise<{ url: string; revisedPrompt?: string }> {
  const apiKey = getApiKey("NEWAPI_API_KEY");

  const params: Record<string, unknown> = {
    model,
    prompt,
    n: 1,
    size: size.replace("*", "x"),
    response_format: "url",
  };

  const resp = await fetch(newApiUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  const result = (await resp.json()) as NewApiImageResponse;
  if (!resp.ok || result.error) {
    throw new Error(
      `NewAPI error (${resp.status}): ${result.error?.message ?? "unknown"}`
    );
  }
  const item = result.data?.[0];
  if (!item) {
    throw new Error(
      `No image in NewAPI response: ${JSON.stringify(result).slice(0, 500)}`
    );
  }
  if (item.b64_json && !item.url) {
    throw new Error(
      "NewAPI returned b64_json but this tool expects response_format=url. " +
        "The provider may not support url format for this model."
    );
  }
  if (!item.url) {
    throw new Error(
      `No image URL in NewAPI response: ${JSON.stringify(result).slice(0, 500)}`
    );
  }
  return { url: item.url, revisedPrompt: item.revised_prompt };
}

async function generateDashScope(
  prompt: string,
  model: string,
  size: string,
  negativePrompt: string | undefined
): Promise<string> {
  const apiKey = getApiKey("DASHSCOPE_API_KEY");

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
    "Generate an image from a text prompt. Default provider is newapi (gpt-image-2, " +
    "OpenAI-compatible endpoint, default base https://ai.centos.hk/v1, override with " +
    "NEWAPI_BASE_URL env var); falls back to DashScope (qwen-image, wan2.7) when " +
    "NEWAPI_API_KEY is unset. The image is downloaded " +
    "to the server filesystem at save_to (default /tmp/mcp-images/) and its path is returned. " +
    "Optionally also uploads to COS (upload_to_cos=true) and returns the public/presigned URL.",
  inputSchema: {
    type: "object" as const,
    properties: {
      prompt: { type: "string", description: "Text description of the image to generate" },
      provider: {
        type: "string",
        enum: ["newapi", "dashscope"],
        description:
          "Image provider. If omitted, uses newapi (gpt-image-2) when NEWAPI_API_KEY is set, " +
          "otherwise falls back to dashscope.",
      },
      model: {
        type: "string",
        description:
          "Model name. Defaults to gpt-image-2 (newapi) or qwen-image-2.0-pro (dashscope).",
      },
      size: {
        type: "string",
        default: "1024x1024",
        description:
          "Image size. Format depends on provider: newapi 'WxH' (e.g. 1024x1024, 1536x1024, 1024x1536); dashscope 'W*H'.",
      },
      negative_prompt: {
        type: "string",
        description: "Negative prompt (dashscope only; ignored by newapi).",
      },
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
        provider === "newapi"
          ? process.env.NEWAPI_IMAGE_MODEL ?? "gpt-image-2"
          : process.env.DASHSCOPE_IMAGE_MODEL ?? "qwen-image-2.0-pro";
    }

    let url: string;
    let revisedPrompt: string | undefined;
    if (provider === "newapi") {
      const r = await generateNewApi(parsed.prompt, model, parsed.size);
      url = r.url;
      revisedPrompt = r.revisedPrompt;
    } else {
      url = await generateDashScope(
        parsed.prompt,
        model,
        parsed.size,
        parsed.negative_prompt
      );
    }

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
    if (revisedPrompt) {
      lines.push(`Revised prompt: ${revisedPrompt}`);
    }

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
