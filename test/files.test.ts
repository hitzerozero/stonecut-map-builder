import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseProperties } from '../src/mc/properties.js';
import { call, callError, connect, text } from './helpers/mcp.js';
import { tempDir } from './helpers/temp.js';

it('writes, lists and reads files inside the server folder', async () => {
  const { client, serverDir } = await connect();
  const w = JSON.parse(text(await call(client, 'write_file', { path: 'world/datapacks/demo/pack.mcmeta', content: '{"pack":{}}' })));
  expect(w).toMatchObject({ path: 'world/datapacks/demo/pack.mcmeta', created: true });
  expect(readFileSync(join(serverDir, 'world', 'datapacks', 'demo', 'pack.mcmeta'), 'utf8')).toBe('{"pack":{}}');
  const list = JSON.parse(text(await call(client, 'list_files', { path: '.', depth: 4 })));
  expect(list.entries.map((e: { path: string }) => e.path)).toContain('world/datapacks/demo/pack.mcmeta');
  expect(list.entries.some((e: { path: string }) => e.path.startsWith('.stonecut'))).toBe(false);
  const r = JSON.parse(text(await call(client, 'read_file', { path: 'world/datapacks/demo/pack.mcmeta' })));
  expect(r.content).toBe('{"pack":{}}');
  const b = JSON.parse(text(await call(client, 'read_file', { path: 'world/datapacks/demo/pack.mcmeta', encoding: 'base64' })));
  expect(Buffer.from(b.content, 'base64').toString()).toBe('{"pack":{}}');
});

it('refuses paths outside the server folder, through .. or links', async () => {
  const { client, serverDir } = await connect();
  expect(await callError(client, 'read_file', { path: '../config.json' })).toMatch(/".." is not allowed/);
  expect(await callError(client, 'write_file', { path: '/tmp/x.txt', content: 'x' })).toMatch(/absolute path/);
  expect(await callError(client, 'list_files', { path: '..' })).toMatch(/".." is not allowed/);
  const outside = tempDir('outside');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  try {
    symlinkSync(outside, join(serverDir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    return;
  }
  expect(await callError(client, 'read_file', { path: 'link/secret.txt' })).toMatch(/through a link/);
  expect(await callError(client, 'write_file', { path: 'link/new.txt', content: 'x' })).toMatch(/through a link/);
  expect(existsSync(join(outside, 'new.txt'))).toBe(false);
});

it("protects the tool's state, eula.txt and the world's chunk files", async () => {
  const { client } = await connect();
  expect(await callError(client, 'read_file', { path: '.stonecut/server.json' })).toMatch(/tool's own folder/);
  expect(await callError(client, 'write_file', { path: 'eula.txt', content: 'eula=true', overwrite: true, confirm: true })).toMatch(/accept_eula/);
  expect(await callError(client, 'write_file', { path: 'world/region/r.0.0.mca', content: 'x' })).toMatch(/chunk files/);
  expect(await callError(client, 'write_file', { path: 'world/level.dat', content: 'x' })).toMatch(/part of the world/);
});

it('keeps an existing file unless overwrite is set, and asks for the OK to replace it', async () => {
  const { client } = await connect();
  await call(client, 'write_file', { path: 'config/a.toml', content: 'one' });
  expect(await callError(client, 'write_file', { path: 'config/a.toml', content: 'two' })).toMatch(/overwrite: true/);
  expect(await callError(client, 'write_file', { path: 'config/a.toml', content: 'two', overwrite: true })).toMatch(/Needs the person's OK/);
  const r = await call(client, 'write_file', { path: 'config/a.toml', content: 'two', overwrite: true, confirm: true });
  expect(r.isError).toBeFalsy();
});

it('follows the person\'s settings for file writes, mods and size', async () => {
  const noWrites = await connect({ allowFileWrites: false });
  expect(await callError(noWrites.client, 'write_file', { path: 'a.txt', content: 'x' })).toMatch(/allowFileWrites/);
  const noMods = await connect();
  expect(await callError(noMods.client, 'write_file', { path: 'mods/x.jar', content: 'AA==', encoding: 'base64' })).toMatch(/allowModInstall/);
  expect(await callError(noMods.client, 'write_file', { path: 'mods/readme.txt', content: 'x' })).toMatch(/allowModInstall/);
  const mods = await connect({ allowModInstall: true });
  expect((await call(mods.client, 'write_file', { path: 'mods/x.jar', content: 'AA==', encoding: 'base64' })).isError).toBeFalsy();
  const small = await connect({ maxFileBytes: 10 });
  expect(await callError(small.client, 'write_file', { path: 'big.txt', content: 'x'.repeat(11) })).toMatch(/over the limit of 10/);
});

it('hides the RCON password and keeps RCON local after server.properties is rewritten', async () => {
  const { client, serverDir } = await connect();
  const read = JSON.parse(text(await call(client, 'read_file', { path: 'server.properties' })));
  expect(read.content).toMatch(/rcon\.password=<hidden>/);
  const w = JSON.parse(text(await call(client, 'write_file', { path: 'server.properties', content: 'server-ip=0.0.0.0\nmotd=hi\n', overwrite: true, confirm: true })));
  expect(w.note).toMatch(/server-ip/);
  const props = parseProperties(readFileSync(join(serverDir, 'server.properties'), 'utf8'));
  expect(props.get('server-ip')).toBe('127.0.0.1');
  expect(props.get('enable-rcon')).toBe('true');
  expect(props.get('motd')).toBe('hi');
});

it('lists a folder that does not exist as an error', async () => {
  const { client, serverDir } = await connect();
  mkdirSync(join(serverDir, 'config'), { recursive: true });
  expect(await callError(client, 'list_files', { path: 'nothing-here' })).toMatch(/Nothing at/);
});
