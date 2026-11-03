import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Context } from './context.js';
import { GUIDE } from './guide.js';
import { backupTools } from './tools/backup.js';
import { blockTools } from './tools/blocks.js';
import { registerTools, type ToolSpec } from './tools/define.js';
import { fileTools } from './tools/files.js';
import { schematicTools } from './tools/schematic.js';
import { serverTools } from './tools/server.js';
import { setupTools } from './tools/setup.js';
import { SERVER_NAME, VERSION } from './version.js';

export const ALL_TOOLS: ToolSpec[] = [...setupTools, ...serverTools, ...blockTools, ...schematicTools, ...backupTools, ...fileTools];

export function createServer(ctx: Context): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: GUIDE });
  registerTools(server, ctx, ALL_TOOLS);
  return server;
}
