// Starts the built MCP server over stdio, as an agent would, and checks that it answers and lists
// its tools with annotations. Uses a settings file in a new temporary folder. Run after `npm run build`.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'stonecut-smoke-'));
const config = join(dir, 'config.json');
writeFileSync(config, JSON.stringify({ serverFolders: [join(dir, 'servers')] }));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(import.meta.dirname, '..', 'dist', 'index.js')],
  env: { ...process.env, STONECUT_MAP_CONFIG: config },
});
const client = new Client({ name: 'stonecut-smoke', version: '0.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
const missing = tools.filter((t) => typeof t.annotations?.readOnlyHint !== 'boolean' || typeof t.annotations?.destructiveHint !== 'boolean');
const status = await client.callTool({ name: 'status', arguments: {} });
await client.close();
if (tools.length !== 24 || missing.length || status.isError) {
  console.error(`Smoke test failed: ${tools.length} tools, ${missing.length} without annotations, status error: ${!!status.isError}`);
  process.exit(1);
}
console.log(`OK on Node ${process.version}: ${tools.length} tools, status answered.`);
