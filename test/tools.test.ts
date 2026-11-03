import { expect, it } from 'vitest';
import { call, callError, connect, text } from './helpers/mcp.js';

const TOOLS = [
  'accept_eula', 'backup_world', 'clear_blocks', 'copy_blocks', 'create_server', 'export_schematic', 'fill_blocks', 'import_schematic',
  'list_files', 'place_blocks', 'plan_setup', 'read_blocks', 'read_file', 'restart_server', 'restore_world', 'run_command',
  'server_logs', 'start_server', 'status', 'stop_server', 'undo', 'use_server', 'write_file',
];
const READ_ONLY = ['list_files', 'plan_setup', 'read_blocks', 'read_file', 'server_logs', 'status'];
const DESTRUCTIVE = ['clear_blocks', 'copy_blocks', 'export_schematic', 'fill_blocks', 'import_schematic', 'place_blocks', 'restore_world', 'run_command', 'undo', 'write_file'];
const NOT_IDEMPOTENT = ['backup_world', 'create_server', 'restart_server', 'restore_world', 'run_command', 'undo'];

it('lists exactly the documented tools, with instructions', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
  expect(client.getInstructions()).toMatch(/plan_setup/);
});

it('gives every tool all four annotations, with the right read-only, destructive and idempotent sets', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  for (const t of tools) {
    const a = t.annotations!;
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) expect(typeof a[k], `${t.name}.${k}`).toBe('boolean');
    expect(t.description!.length, t.name).toBeGreaterThan(40);
  }
  const names = (f: (a: NonNullable<(typeof tools)[0]['annotations']>) => boolean | undefined) => tools.filter((t) => f(t.annotations!)).map((t) => t.name).sort();
  expect(names((a) => a.readOnlyHint)).toEqual(READ_ONLY);
  expect(names((a) => a.destructiveHint)).toEqual(DESTRUCTIVE);
  expect(names((a) => !a.idempotentHint)).toEqual(NOT_IDEMPOTENT);
  expect(names((a) => a.openWorldHint)).toEqual(['create_server', 'plan_setup']);
});

it('refuses bad input in the schema, before anything runs', async () => {
  const { client } = await connect();
  expect(await callError(client, 'place_blocks', { blocks: [{ pos: [0, 0, 0], block: 'stone run op me' }] })).toMatch(/Not a block state/);
  expect(await callError(client, 'place_blocks', { blocks: [{ pos: [0.5, 0, 0], block: 'stone' }] })).toMatch(/whole numbers/);
  expect(await callError(client, 'place_blocks', { blocks: [] })).toMatch(/blocks/);
  expect(await callError(client, 'fill_blocks', { fills: [{ from: [0, 0, 0], to: [1, 1, 1], block: 'stone', mode: 'explode' }] })).toMatch(/mode/);
  expect(await callError(client, 'run_command', { command: 'say hi\nop me' })).toMatch(/one line/);
  expect(await callError(client, 'create_server', { plan_id: 'not-a-uuid', person_confirmed: true })).toMatch(/plan_id|uuid/i);
  expect(await callError(client, 'create_server', { plan_id: '6f1c2d4e-1a2b-4c3d-8e9f-001122334455', person_confirmed: false })).toMatch(/person_confirmed|true/);
  expect(await callError(client, 'accept_eula', { person_accepted: false })).toMatch(/person_accepted|true/);
  expect(await callError(client, 'export_schematic', { from: [0, 0, 0], to: [1, 1, 1], file: 'out.nbt' })).toMatch(/\.schem/);
  expect(await callError(client, 'read_blocks', { from: [0, 0, 0], to: [1, 1, 1], dimension: 'mars' })).toMatch(/dimension/);
});

it('asks for the person\'s OK before destructive changes while confirmDestructive is on', async () => {
  const { client } = await connect();
  expect(await callError(client, 'clear_blocks', { from: [0, 0, 0], to: [9, 9, 9] })).toMatch(/Needs the person's OK first: clear 1000 blocks/);
  expect(await callError(client, 'import_schematic', { file: 'a.schem', origin: [0, 0, 0] })).toMatch(/Needs the person's OK/);
  expect(await callError(client, 'restore_world', { name: 'world-1' })).toMatch(/Needs the person's OK/);
  const off = await connect({ confirmDestructive: false });
  expect(await callError(off.client, 'clear_blocks', { from: [0, 0, 0], to: [9, 9, 9] })).not.toMatch(/Needs the person's OK/);
});

it('refuses reads over the read limit and says what the limit is', async () => {
  const { client } = await connect({ maxReadBlocks: 100 });
  expect(await callError(client, 'read_blocks', { from: [0, 0, 0], to: [9, 9, 9] })).toMatch(/at most 100 per call/);
});

it('reports the settings and the server in status, and says what to do without a server', async () => {
  const none = await connect({}, false);
  const s = JSON.parse(text(await call(none.client, 'status')));
  expect(s.server).toBeNull();
  expect(s.next).toMatch(/plan_setup/);
  expect(s.settings.rconAddress).toBe('127.0.0.1');
  expect(await callError(none.client, 'read_file', { path: 'server.properties' })).toMatch(/no test server yet/);
  const withServer = await connect();
  const s2 = JSON.parse(text(await call(withServer.client, 'status')));
  expect(s2.server.folder).toBe(withServer.ctx.server().dir);
  expect(s2.server.running).toBe(false);
  expect(s2.server.eula_accepted).toBe(false);
});

it('will not start a server whose EULA the person has not accepted', async () => {
  const { client } = await connect();
  expect(await callError(client, 'start_server')).toMatch(/EULA is not accepted/);
});

it('refuses use_server outside the allowed folders', async () => {
  const { client } = await connect();
  expect(await callError(client, 'use_server', { folder: process.cwd() })).toMatch(/not inside an allowed server folder/);
});
