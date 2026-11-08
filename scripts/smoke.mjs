// Starts the built MCP server over stdio, as an agent would, and checks that it answers and lists
// its tools with annotations, then runs the doctor command (which changes nothing and starts no
// Minecraft server). Uses a settings file in a new temporary folder. Run after `npm run build`.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'stonecut-smoke-'));
const config = join(dir, 'config.json');
writeFileSync(config, JSON.stringify({ serverFolders: [join(dir, 'servers')] }));

const entry = join(import.meta.dirname, '..', 'dist', 'index.js');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...process.env, STONECUT_MAP_CONFIG: config },
});
const client = new Client({ name: 'stonecut-smoke', version: '0.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
const missing = tools.filter((t) => typeof t.annotations?.readOnlyHint !== 'boolean' || typeof t.annotations?.destructiveHint !== 'boolean');
const status = await client.callTool({ name: 'status', arguments: {} });
await client.close();
// doctor fails other checks here (no skill installed, maybe no Java), so only its own start check is looked at.
const doctor = spawnSync(process.execPath, [entry, 'doctor'], { env: { ...process.env, STONECUT_MAP_CONFIG: config }, encoding: 'utf8', timeout: 120_000 });
const doctorOk = /^PASS {2}The MCP server starts and lists its 24 tools$/m.test(doctor.stdout ?? '');
if (tools.length !== 24 || missing.length || status.isError || !doctorOk) {
  console.error(`Smoke test failed: ${tools.length} tools, ${missing.length} without annotations, status error: ${!!status.isError}, doctor: ${doctorOk ? 'ok' : doctor.stdout || doctor.stderr}`);
  process.exit(1);
}
console.log(`OK on Node ${process.version}: ${tools.length} tools, status answered, doctor ran.`);
