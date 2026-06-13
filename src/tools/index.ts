import { tavilySearchTool } from "./tavily-search.js";
import { currentDateTool } from "./current-date.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export const tools: ToolDefinition[] = [tavilySearchTool, currentDateTool];
