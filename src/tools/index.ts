import { tavilySearchTool } from "./tavily-search.js";
import { currentDateTool } from "./current-date.js";
import { imageUnderstandTool } from "./image-understand.js";
import { imageGenerateTool } from "./image-generate.js";
import { cosUploadTool, cosUploadChunkedTool } from "./cos-upload.js";
import { cosDownloadTool } from "./cos-download.js";
import { cosListTool } from "./cos-list.js";
import { cosDeleteTool } from "./cos-delete.js";
import { hexoListTool } from "./hexo-list.js";
import { hexoPublishTool } from "./hexo-publish.js";
import { hexoDeleteTool } from "./hexo-delete.js";
import { hexoRebuildTool } from "./hexo-rebuild.js";

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
  cosUploadChunkedTool,
  cosDownloadTool,
  cosListTool,
  cosDeleteTool,
  hexoListTool,
  hexoPublishTool,
  hexoDeleteTool,
  hexoRebuildTool,
];
