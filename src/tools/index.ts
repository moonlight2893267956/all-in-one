import { tavilySearchTool } from "./tavily-search.js";
import { currentDateTool } from "./current-date.js";
import { imageUnderstandTool } from "./image-understand.js";
import { imageGenerateTool } from "./image-generate.js";
import { cosUploadTool } from "./cos-upload.js";
import { cosDownloadTool } from "./cos-download.js";
import { cosListTool } from "./cos-list.js";
import { cosDeleteTool } from "./cos-delete.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export const tools: ToolDefinition[] = [
  tavilySearchTool,
  currentDateTool,
  imageUnderstandTool,
  imageGenerateTool,
  cosUploadTool,
  cosDownloadTool,
  cosListTool,
  cosDeleteTool,
];
