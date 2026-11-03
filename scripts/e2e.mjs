// End-to-end run against a real, throwaway vanilla server, through the MCP tools themselves.
// Downloads the Minecraft server from Mojang (hash checked), starts it, builds, reads, exports,
// clears, imports, compares, undoes and stops. Run after `npm run build`.
//
//   node scripts/e2e.mjs [minecraft version] [vanilla|neoforge]
//
// Settings (environment, all optional):
//   E2E_DIR        scratch folder (default: <system temp>/stonecut-map-builder-e2e). Must be new or empty.
//   E2E_GAME_PORT  game port (default 25810), E2E_RCON_PORT (default 25811)
//   E2E_JAVA       java executable to use (default: found automatically)
//
// This script accepts the Minecraft EULA for its own throwaway server, standing in for the person.
// The product never does that by itself: accept_eula needs person_accepted: true.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const version = process.argv[2] ?? '1.21.11';
const loader = process.argv[3] ?? 'vanilla';
const dir = process.env.E2E_DIR ?? join(tmpdir(), 'stonecut-map-builder-e2e');
const gamePort = Number(process.env.E2E_GAME_PORT ?? 25810);
const rconPort = Number(process.env.E2E_RCON_PORT ?? 25811);

if (existsSync(dir) && readdirSync(dir).length) {
  console.error(`${dir} is not empty; give an empty E2E_DIR`);
  process.exit(1);
}
mkdirSync(join(dir, 'servers'), { recursive: true });
const configPath = join(dir, 'config.json');
writeFileSync(configPath, JSON.stringify({ serverFolders: [join(dir, 'servers')], ...(process.env.E2E_JAVA ? { javaPath: process.env.E2E_JAVA } : {}) }, null, 2));
process.env.STONECUT_MAP_CONFIG = configPath;

const { loadConfig } = await import('../dist/config.js');
const { Context } = await import('../dist/context.js');
const { createServer } = await import('../dist/server.js');

const server = createServer(new Context(loadConfig()));
const client = new Client({ name: 'stonecut-e2e', version: '0.0.0' });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

const timings = [];
async function call(name, args = {}, { expectError = false } = {}) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 30 * 60_000 });
  const ms = Date.now() - t;
  const text = r.content?.[0]?.text ?? '';
  timings.push({ step: name, seconds: ms / 1000 });
  if (!!r.isError !== expectError) throw new Error(`${name} ${expectError ? 'should have failed' : 'failed'}: ${text}`);
  console.log(`${name} (${(ms / 1000).toFixed(1)}s)${expectError ? ' refused as expected: ' + text.slice(0, 120) : ''}`);
  return expectError ? text : JSON.parse(text);
}
function check(cond, what) {
  if (!cond) throw new Error(`Check failed: ${what}`);
  console.log(`  ok: ${what}`);
}

const O = [100, -60, 100];
const from = O;
const to = [O[0] + 8, O[1] + 5, O[2] + 8];
const at = (dx, dy, dz) => [O[0] + dx, O[1] + dy, O[2] + dz];
let started = false;

try {
  await call('status');
  const plan = await call('plan_setup', { minecraft: version, loader, name: 'e2e', game_port: gamePort, rcon_port: rconPort, world_type: 'flat' });
  check(plan.ready, `plan is ready (Java ${plan.java.needed}: ${plan.java.using})`);
  for (const d of plan.downloads) console.log(`  plan: ${d.what} from ${d.url} (${d.checked_with})`);
  const created = await call('create_server', { plan_id: plan.plan_id, person_confirmed: true });
  for (const d of created.downloaded) console.log(`  downloaded ${d.what}: ${d.bytes} bytes, hash ${d.hash}`);
  await call('start_server', {}, { expectError: true });
  await call('accept_eula', { person_accepted: true });
  const st = await call('start_server');
  started = true;
  console.log(`  started in ${st.seconds}s, join at ${st.join_address}`);

  await call('read_file', { path: '../config.json' }, { expectError: true });
  await call('read_file', { path: '.stonecut/server.json' }, { expectError: true });
  const props = await call('read_file', { path: 'server.properties' });
  check(/rcon\.password=<hidden>/.test(props.content) && /server-ip=127\.0\.0\.1/.test(props.content), 'server.properties: RCON password hidden, server-ip 127.0.0.1');
  await call('clear_blocks', { from, to }, { expectError: true });

  // Build: floor, hollow walls, roof, door, windows, torches, a chest with an item, stairs.
  const fill = await call('fill_blocks', {
    fills: [
      { from: at(0, 0, 0), to: at(8, 0, 8), block: 'minecraft:stone_bricks' },
      { from: at(0, 1, 0), to: at(8, 4, 8), block: 'minecraft:oak_planks', mode: 'hollow' },
      { from: at(0, 5, 0), to: at(8, 5, 8), block: 'minecraft:spruce_slab[type=bottom]' },
      { from: at(0, 1, 0), to: at(8, 4, 8), block: 'minecraft:oak_log[axis=y]', mode: 'outline', replace_only: 'minecraft:oak_planks' },
    ],
  });
  console.log(`  fill: ${fill.commands} commands, ${fill.changed} blocks changed, undo ${fill.undo}`);
  check(fill.errors.length === 0, 'fill ran without errors');
  const place = await call('place_blocks', {
    blocks: [
      { pos: at(4, 1, 0), block: 'minecraft:oak_door[facing=south,half=lower,hinge=left]' },
      { pos: at(4, 2, 0), block: 'minecraft:oak_door[facing=south,half=upper,hinge=left]' },
      { pos: at(2, 2, 0), block: 'minecraft:glass_pane' },
      { pos: at(6, 2, 0), block: 'minecraft:glass_pane' },
      { pos: at(4, 3, 1), block: 'minecraft:wall_torch[facing=south]' },
      { pos: at(1, 1, 7), block: 'minecraft:chest[facing=south]', data: '{Items:[{Slot:0b,id:"minecraft:diamond",count:3}]}' },
      ...[1, 2, 3].map((dx) => ({ pos: at(dx + 4, 1, 7), block: 'minecraft:oak_stairs[facing=north]' })),
    ],
  });
  console.log(`  place: ${place.commands} commands for 9 blocks, undo ${place.undo}`);
  check(place.errors.length === 0, 'place ran without errors');

  const built = await call('read_blocks', { from, to, format: 'list' });
  const blockAt = (r, p) => r.blocks.find((x) => x[0] === p[0] && x[1] === p[1] && x[2] === p[2])?.[3];
  check(blockAt(built, at(0, 0, 0)) === 'minecraft:stone_bricks', 'floor corner is stone_bricks');
  check(blockAt(built, at(0, 2, 0))?.startsWith('minecraft:oak_log'), 'wall edge is an oak log (outline + replace_only)');
  check(blockAt(built, at(4, 1, 0))?.includes('oak_door') && blockAt(built, at(4, 2, 0))?.includes('half=upper'), 'door has both halves');
  check(blockAt(built, at(4, 3, 1))?.startsWith('minecraft:wall_torch'), 'wall torch stayed on the wall');
  check(blockAt(built, at(4, 2, 4)) === undefined, 'inside is air (hollow)');
  check(built.block_entities.some((e) => e.id === 'minecraft:chest'), 'chest is a block entity');
  const layers = await call('read_blocks', { from, to });
  check(layers.layers.length === 6 && Array.isArray(layers.palette), 'layers format has 6 layers and a palette');

  const exp3 = await call('export_schematic', { from, to, file: 'schematics/house.schem' });
  const exp2 = await call('export_schematic', { from, to, file: 'schematics/house-v2.schem', version: 2 });
  console.log(`  export: v3 ${exp3.bytes} bytes, v2 ${exp2.bytes} bytes, ${exp3.nonAir} non-air blocks, ${exp3.blockEntities} block entities`);
  check(exp3.nonAir === built.blocks.length, 'export has every non-air block');
  await call('export_schematic', { from, to, file: 'schematics/house.schem' }, { expectError: true });

  await call('clear_blocks', { from, to, confirm: true });
  const cleared = await call('read_blocks', { from, to, format: 'list' });
  check(cleared.blocks.length === 0, 'area is empty after clear');

  const imp = await call('import_schematic', { file: 'schematics/house.schem', origin: from, confirm: true });
  console.log(`  import: ${imp.commands} commands, ${imp.changed} blocks changed, warnings ${imp.warnings.length}`);
  check(imp.errors.length === 0, 'import ran without errors');
  const back = await call('read_blocks', { from, to, format: 'list' });
  check(JSON.stringify(back.blocks) === JSON.stringify(built.blocks), `imported blocks match the original exactly (${back.blocks.length} blocks)`);
  check(JSON.stringify(back.block_entities) === JSON.stringify(built.block_entities), 'block entities match');
  const chest = await call('run_command', { command: `data get block ${at(1, 1, 7).join(' ')} Items` });
  check(/diamond/.test(chest.reply) && /3/.test(chest.reply), `chest still holds 3 diamonds after round trip (${chest.reply.slice(0, 80)})`);

  await call('clear_blocks', { from, to, confirm: true });
  await call('import_schematic', { file: 'schematics/house-v2.schem', origin: from, confirm: true });
  const back2 = await call('read_blocks', { from, to, format: 'list' });
  check(JSON.stringify(back2.blocks) === JSON.stringify(built.blocks), 'version 2 file imports to the same blocks');

  await call('undo', { confirm: true });
  const undone = await call('read_blocks', { from, to, format: 'list' });
  check(undone.blocks.length === 0, 'undo of the v2 import gives the cleared area back');
  await call('undo', { confirm: true });
  const undone2 = await call('read_blocks', { from, to, format: 'list' });
  check(JSON.stringify(undone2.blocks) === JSON.stringify(built.blocks), 'undo of that clear gives the house back');

  // Worst case for packing: a 16x16x16 checkerboard, so every block is its own command.
  const P = [130, -60, 100];
  const checker = [];
  for (let x = 0; x < 16; x++)
    for (let y = 0; y < 16; y++)
      for (let z = 0; z < 16; z++) checker.push({ pos: [P[0] + x, P[1] + y, P[2] + z], block: (x + y + z) % 2 ? 'minecraft:white_concrete' : 'minecraft:black_concrete' });
  const big = await call('place_blocks', { blocks: checker });
  console.log(`  throughput: ${big.commands} commands in ${big.seconds}s (${Math.round(big.commands / big.seconds)} commands/s, snapshot included)`);
  check(big.errors.length === 0, 'checkerboard placed without errors');
  const bigRead = await call('read_blocks', { from: P, to: [P[0] + 15, P[1] + 15, P[2] + 15], format: 'list' });
  check(bigRead.blocks.length === 4096 && bigRead.blocks.every(([x, y, z, s]) => s === ((x - P[0] + y - P[1] + z - P[2]) % 2 ? 'minecraft:white_concrete' : 'minecraft:black_concrete')), 'all 4096 checkerboard blocks read back correctly');
  await call('undo', { confirm: true });
  check((await call('read_blocks', { from: P, to: [P[0] + 15, P[1] + 15, P[2] + 15], format: 'list' })).blocks.length === 0, 'undo removed the checkerboard');

  const status = await call('status');
  check(status.server.running && status.settings.rconAddress === '127.0.0.1', 'status: running, RCON on 127.0.0.1');
  await call('stop_server');
  started = false;
  const after = await call('status');
  check(!after.server.running, 'server stopped');
} finally {
  if (started) await client.callTool({ name: 'stop_server', arguments: { force: true } }).catch(() => undefined);
  await client.close();
}

const total = timings.reduce((s, t) => s + t.seconds, 0);
console.log('\nTimings (seconds):');
for (const t of timings) console.log(`  ${t.step.padEnd(18)} ${t.seconds.toFixed(2)}`);
console.log(`  ${'total'.padEnd(18)} ${total.toFixed(1)}`);
console.log(`\nScratch folder (delete it when done): ${dir}`);
