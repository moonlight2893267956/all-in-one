import { z } from "zod";
import { getApiKey } from "../config.js";

const TAVILY_API_URL = "https://api.tavily.com/search";

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

interface TavilyResponse {
  answer?: string;
  results?: TavilyResult[];
}

async function callTavilyApi(args: {
  query: string;
  max_results: number;
  search_depth: "basic" | "advanced";
  include_answer: boolean;
  include_raw_content: boolean;
}): Promise<TavilyResponse> {
  const apiKey = getApiKey("TAVILY_API_KEY");

  const response = await fetch(TAVILY_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query: args.query,
      search_depth: args.search_depth,
      max_results: args.max_results,
      include_answer: args.include_answer,
      include_raw_content: args.include_raw_content,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tavily API error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<TavilyResponse>;
}

function formatResults(data: TavilyResponse): string {
  const lines: string[] = [];

  if (data.answer) {
    lines.push(`[Summary] ${data.answer}`);
    lines.push("");
  }

  const results = data.results ?? [];
  lines.push(`Found ${results.length} results:`);
  lines.push("");

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    lines.push(`${i + 1}. ${item.title ?? "No title"}`);
    lines.push(`   URL: ${item.url ?? "No URL"}`);
    if (item.content) {
      lines.push(`   ${item.content.slice(0, 500)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

const InputSchema = z.object({
  query: z.string().describe("The search query string"),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe("Maximum number of search results to return (1-20)"),
  search_depth: z
    .enum(["basic", "advanced"])
    .default("advanced")
    .describe("'basic' is faster, 'advanced' provides more comprehensive results"),
  include_answer: z
    .boolean()
    .default(true)
    .describe("Whether to include an AI-generated answer summary"),
  include_raw_content: z
    .boolean()
    .default(false)
    .describe("Whether to include the raw content of each result page"),
});

export const tavilySearchTool = {
  name: "tavily_search",
  description:
    "Search the web using the Tavily Search API. " +
    "Use this tool to find current information, facts, and data from the internet. " +
    "Supports both basic and advanced search depth, and can include an AI-generated answer summary.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "The search query string" },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        default: 10,
        description: "Maximum number of search results to return (1-20)",
      },
      search_depth: {
        type: "string",
        enum: ["basic", "advanced"],
        default: "advanced",
        description: "'basic' is faster, 'advanced' provides more comprehensive results",
      },
      include_answer: {
        type: "boolean",
        default: true,
        description: "Whether to include an AI-generated answer summary",
      },
      include_raw_content: {
        type: "boolean",
        default: false,
        description: "Whether to include the raw content of each result page",
      },
    },
    required: ["query"],
  },
  handler: async (args: Record<string, unknown>) => {
    const parsed = InputSchema.parse(args);
    const data = await callTavilyApi(parsed);
    return formatResults(data);
  },
};
