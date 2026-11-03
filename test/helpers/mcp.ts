import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../../src/config.js';
import { Context } from '../../src/context.js';
import { updateProperties } from '../../src/mc/properties.js';
import { writeEula, writeMeta } from '../../src/mc/testserver.js';
import { createServer } from '../../src/server.js';
import { tempDir } from './temp.js';

export interface Setup {
  client: Client;
  ctx: Context;
  root: string;
  serverDir: string;
}

/** An MCP client connected in memory, with its own settings file and a server folder that is not running. */
export async function connect(settings: Record<string, unknown> = {}, withServer = true): Promise<Setup> {
  const base = tempDir('mcp');
  const root = join(base, 'servers');
  mkdirSync(root, { recursive: true });
  const file = join(base, 'config.json');
  writeFileSync(file, JSON.stringify({ serverFolders: [root], ...settings }));
  const ctx = new Context(loadConfig({ STONECUT_MAP_CONFIG: file }));
  const serverDir = join(root, 'test');
  if (withServer) {
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, 'server.properties'), updateProperties('', { 'server-ip': '127.0.0.1', 'rcon.port': '1', 'rcon.password': 'p'.repeat(32), 'enable-rcon': 'true' }));
    writeEula(serverDir, false);
    writeMeta(serverDir, {
      minecraft: '1.21.11', loader: 'vanilla', javaPath: 'java', javaMajor: 21, memoryMb: 1024,
      launch: { type: 'jar', jar: 'server.jar' }, rconPort: 1, createdAt: '2026-01-01T00:00:00Z', createdByTool: true,
    });
  }
  const server = createServer(ctx);
  const client = new Client({ name: 'stonecut-test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, ctx, root, serverDir };
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

export function text(result: CallToolResult): string {
  const item = result.content[0];
  return item?.type === 'text' ? item.text : '';
}

/** The error text of a call that should fail, or '' if it did not fail. */
export async function callError(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  try {
    const r = await call(client, name, args);
    return r.isError ? text(r) : '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
