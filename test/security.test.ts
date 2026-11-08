import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { enforceLocked, parseProperties, updateProperties } from '../src/mc/properties.js';
import { checkJavaPath } from '../src/mc/setup.js';
import { portFree, ServerError, TestServer } from '../src/mc/testserver.js';
import { javaNeededFor, pickNeoForge } from '../src/mc/versions.js';
import { nbt, readNbt, unpackNbt, writeNbt } from '../src/nbt/nbt.js';
import { isCodeFile } from '../src/ops/files.js';
import { checkAllowedFolder, PathError, resolveInside } from '../src/safety/paths.js';
import { readSponge } from '../src/schematic/sponge.js';
import { call, callError, connect, text } from './helpers/mcp.js';
import { tempDir } from './helpers/temp.js';

// Attacks found in the review before the public release, one test each.

/** The Windows short (8.3) name of a file or folder, or null where the disk does not make them. */
function shortName(dir: string, name: string): string | null {
  if (process.platform !== 'win32') return null;
  const out = execFileSync('cmd', ['/c', 'dir', '/x', '/a', dir], { encoding: 'utf8' });
  const line = out.split(/\r?\n/).find((l) => l.endsWith(` ${name}`));
  const m = line && /\s([A-Z0-9_~]+(?:\.[A-Z0-9_]{1,3})?)\s+\S+$/.exec(line.trimEnd());
  return m && m[1]!.includes('~') ? m[1]! : null;
}

it('reads server.properties as Java does: last key wins, \\r alone ends a line, continued lines and \\u escapes count', () => {
  expect(parseProperties('server-ip=127.0.0.1\nserver-ip=0.0.0.0\n').get('server-ip')).toBe('0.0.0.0');
  expect(parseProperties('motd=x\rserver-ip=0.0.0.0').get('server-ip')).toBe('0.0.0.0');
  expect(parseProperties('\\u0073erver-ip=0.0.0.0').get('server-ip')).toBe('0.0.0.0');
  expect(parseProperties('motd=a\\\n   server-ip=0.0.0.0').get('motd')).toBe('aserver-ip=0.0.0.0');
  expect(parseProperties('motd=a\\\\\nserver-ip=0.0.0.0').get('server-ip')).toBe('0.0.0.0');
  expect(parseProperties('# comment \\\nserver-ip=0.0.0.0').get('server-ip')).toBe('0.0.0.0');
  expect(parseProperties('server-ip  :  0.0.0.0').get('server-ip')).toBe('0.0.0.0');
  // A byte order mark is part of the first key for Java, so that line does not set server-ip.
  expect(parseProperties('\uFEFFserver-ip=127.0.0.1').has('server-ip')).toBe(false);
  expect(() => parseProperties('motd=\\u00zz')).toThrow(/broken \\u escape/);
});

it('puts back server-ip everywhere it appears, however it is written, so Minecraft never listens on the network', () => {
  for (const attack of [
    'server-ip=127.0.0.1\nserver-ip=0.0.0.0\n',
    'server-ip=127.0.0.1\nmotd=x\rserver-ip=0.0.0.0\n',
    'server-ip=127.0.0.1\n\\u0073erver-ip=0.0.0.0\n',
    '\uFEFFserver-ip=127.0.0.1\n',
    'server-ip=0.0.0.\\\n  0\n',
  ]) {
    const dir = tempDir('props-attack');
    writeFileSync(join(dir, 'server.properties'), attack);
    enforceLocked(dir, 25999);
    const after = parseProperties(readFileSync(join(dir, 'server.properties'), 'utf8'));
    expect(after.get('server-ip'), JSON.stringify(attack)).toBe('127.0.0.1');
    expect(enforceLocked(dir, 25999)).toEqual([]);
  }
  expect(updateProperties('a=1\\\n  2\nb=3\n', { a: 'x' })).toBe('a=x\nb=3\n');
  expect(updateProperties('toString=1\n', { a: 'x' })).toBe('toString=1\na=x\n');
});

it('keeps the 1.21.9 management server on 127.0.0.1 when it is set up', () => {
  const dir = tempDir('props-mgmt');
  writeFileSync(join(dir, 'server.properties'), 'management-server-enabled=true\nmanagement-server-host=0.0.0.0\nmanagement-server-secret=abc\n');
  expect(enforceLocked(dir, 25999)).toContain('management-server-host');
  expect(parseProperties(readFileSync(join(dir, 'server.properties'), 'utf8')).get('management-server-host')).toBe('127.0.0.1');
  const plain = tempDir('props-mgmt');
  writeFileSync(join(plain, 'server.properties'), 'motd=x\n');
  enforceLocked(plain, 25999);
  expect(parseProperties(readFileSync(join(plain, 'server.properties'), 'utf8')).has('management-server-host')).toBe(false);
});

it('refuses more Windows device names, and returns the real path', () => {
  const root = tempDir('paths');
  for (const p of ['CONIN$', 'conout$.txt', 'COM¹', 'lpt².log']) expect(() => resolveInside(root, p), p).toThrow(PathError);
  mkdirSync(join(root, 'World'));
  expect(resolveInside(root, './World//x.txt')).toBe(join(resolveInside(root, '.'), 'World', 'x.txt'));
  // A name that only starts with two dots stays inside.
  expect(resolveInside(root, '..notes/a.txt')).toBe(join(resolveInside(root, '.'), '..notes', 'a.txt'));
});

it("does not let a Windows short name reach the tool's own folder or skip the server.properties rules", async () => {
  const { client, serverDir } = await connect({ allowModInstall: true });
  const stateShort = shortName(serverDir, '.stonecut');
  const propsShort = shortName(serverDir, 'server.properties');
  if (!stateShort || !propsShort) return; // only where the disk makes short names (most Windows system drives)
  expect(await callError(client, 'read_file', { path: `${stateShort}/server.json` })).toMatch(/tool's own folder/);
  expect(await callError(client, 'write_file', { path: `${stateShort}/server.json`, content: '{}', overwrite: true, confirm: true })).toMatch(/tool's own folder/);
  expect(await callError(client, 'list_files', { path: stateShort })).toMatch(/tool's own folder/);
  const r = JSON.parse(text(await call(client, 'read_file', { path: propsShort })));
  expect(r.path).toBe('server.properties');
  expect(r.content).not.toContain('p'.repeat(32));
});

it('counts libraries, Java argument files, programs and the mods folder as code that needs allowModInstall', async () => {
  for (const p of ['mods/config.toml', 'MODS/a.txt', 'libraries/net/neoforged/neoforge/21.11.1/win_args.txt', 'user_jvm_args.txt', 'x/unix_args.txt', 'tools/a.dll', 'run.bat', 'run.sh', 'a.EXE', 'plugin.jar']) {
    expect(isCodeFile(p), p).toBe(true);
  }
  for (const p of ['config/neoforge-server.toml', 'world/datapacks/a/pack.mcmeta', 'server.properties', 'schematics/house.schem']) expect(isCodeFile(p), p).toBe(false);
  const { client, serverDir } = await connect();
  for (const path of ['./mods/x.toml', 'libraries/net/neoforged/neoforge/21.11.1/win_args.txt', 'user_jvm_args.txt', 'bin/java.exe']) {
    expect(await callError(client, 'write_file', { path, content: '-XX:OnOutOfMemoryError=calc' }), path).toMatch(/allowModInstall/);
  }
  expect(existsSync(join(serverDir, 'user_jvm_args.txt'))).toBe(false);
});

it('hides the RCON password from read_file in every file and in base64 too', async () => {
  const { client, serverDir } = await connect();
  const pw = 'p'.repeat(32);
  const b64 = JSON.parse(text(await call(client, 'read_file', { path: 'server.properties', encoding: 'base64' })));
  expect(Buffer.from(b64.content, 'base64').toString()).not.toContain(pw);
  expect(Buffer.from(b64.content, 'base64').toString()).toMatch(/rcon\.password=<hidden>/);
  mkdirSync(join(serverDir, 'logs'));
  writeFileSync(join(serverDir, 'logs', 'latest.log'), `[Server] somebody pasted ${pw} here\n`);
  const log = JSON.parse(text(await call(client, 'read_file', { path: 'logs/latest.log' })));
  expect(log.content).toBe('[Server] somebody pasted <hidden> here\n');
});

it('refuses a server.properties that Minecraft could not read', async () => {
  const { client, serverDir } = await connect();
  expect(await callError(client, 'write_file', { path: 'server.properties', content: 'motd=\\uZZZZ\n', overwrite: true, confirm: true })).toMatch(/broken \\u escape/);
  expect(readFileSync(join(serverDir, 'server.properties'), 'utf8')).not.toContain('uZZZZ');
});

it('keeps the world inside the server folder whatever level-name says', () => {
  const base = tempDir('level');
  const dir = join(base, 'server');
  mkdirSync(dir);
  const s = new TestServer(dir, { minecraft: '1.21.11', loader: 'vanilla', javaPath: 'java', javaMajor: 21, memoryMb: 1024, launch: { type: 'jar', jar: 'server.jar' }, rconPort: 25575, createdAt: '', createdByTool: true });
  writeFileSync(join(dir, 'server.properties'), 'level-name=my world\n');
  expect(s.worldDir).toBe(join(resolveInside(dir, '.'), 'my world'));
  // server.properties needs a backslash written twice, so this file says ..\outside.
  for (const bad of ['../outside', '..\\\\outside', '.stonecut', '/etc']) {
    writeFileSync(join(dir, 'server.properties'), `level-name=${bad}\n`);
    expect(() => s.worldDir, bad).toThrow(ServerError);
  }
});

it('treats a pid file from before the computer started as stale, so stop never ends another program', async () => {
  const { ctx } = await connect();
  const s = ctx.server();
  mkdirSync(s.stateDir, { recursive: true });
  writeFileSync(s.pidFile, String(process.pid));
  expect((await s.status()).pid).toBe(process.pid);
  utimesSync(s.pidFile, new Date(2000, 0, 1), new Date(2000, 0, 1));
  expect(await s.status()).toMatchObject({ running: false, pid: null });
});

it('checks ports without listening on a network address, and still sees a port in use', async () => {
  const busy = createServer();
  await new Promise<void>((r) => busy.listen({ host: '127.0.0.1', port: 0 }, () => r()));
  const port = (busy.address() as { port: number }).port;
  expect(await portFree(port)).toBe(false);
  await new Promise<void>((r) => busy.close(() => r()));
  expect(await portFree(port)).toBe(true);
});

it('only runs a Java the agent names if it is called java and is not inside a server folder', () => {
  const base = tempDir('javapath');
  const config = loadConfig({ STONECUT_MAP_CONFIG: join(base, 'none.json') }, base);
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  expect(() => checkJavaPath(config, join(config.serverFolders[0]!, 'test', 'bin', exe))).toThrow(/inside a server folder/);
  expect(() => checkJavaPath(config, join(base, 'tools', 'calc.exe'))).toThrow(/called java/);
  expect(() => checkJavaPath(config, join('bin', exe))).toThrow(/full path/);
  expect(() => checkJavaPath(config, join(base, 'jdk', 'bin', exe))).not.toThrow();
});

it('sees a path inside a server folder that does not exist yet, when the folder is reached through a link', () => {
  const base = tempDir('linked');
  const real = join(base, 'real');
  mkdirSync(real);
  symlinkSync(real, join(base, 'link'), 'junction');
  const config = loadConfig({ STONECUT_MAP_CONFIG: join(base, 'none.json') }, join(base, 'link'));
  const inside = join(realpathSync.native(real), relativeToHome(config.serverFolders[0]!, join(base, 'link')));
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  expect(() => checkJavaPath(config, join(inside, 'test', 'bin', exe))).toThrow(/inside a server folder/);
  expect(checkAllowedFolder(config.serverFolders, join(inside, 'world'))).toBe(join(inside, 'world'));
});

function relativeToHome(folder: string, home: string): string {
  return folder.slice(home.length);
}

it('refuses chunk ranges that are too big before listing them', async () => {
  const { client } = await connect();
  const huge = { from: [-29_000_000, 0, -29_000_000], to: [29_000_000, 0, 29_000_000] };
  expect(await callError(client, 'read_entities', huge)).toMatch(/chunks; the limit is 1024/);
  expect(await callError(client, 'run_command', { command: 'say hi', backup_area: huge })).toMatch(/chunks; the limit is 1024/);
  expect(await callError(client, 'place_blocks', { blocks: [{ pos: [-29_000_000, 0, 0], block: 'stone' }, { pos: [29_000_000, 0, 0], block: 'stone' }] })).toMatch(/chunks; the limit is 1024/);
});

it('stops NBT made of millions of tiny tags and decompression bombs', () => {
  const many = writeNbt('', nbt.compound({ l: nbt.list('compound', Array.from({ length: 1000 }, () => nbt.compound({}))) }));
  expect(() => readNbt(many, 100)).toThrow(/too many tags/);
  expect(readNbt(many).tag.value.size).toBe(1);
  const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024));
  expect(() => unpackNbt(bomb, 1024 * 1024)).toThrow();
  // A root compound holding one list of two million bytes: two megabytes that would become two million objects.
  const count = Buffer.alloc(4);
  count.writeInt32BE(2_000_100);
  const bytes = Buffer.concat([Buffer.from([10, 0, 0, 9, 0, 1, 0x6c, 1]), count, Buffer.alloc(2_000_100), Buffer.from([0])]);
  expect(() => readSponge(gzipSync(bytes), { maxBlocks: 1 })).toThrow(/too many tags/);
});

it('takes only plain version names from the NeoForge list, and knows which Java each release needs', () => {
  expect(pickNeoForge('1.21.11', ['21.11.5', '21.11.6.x/../..', '21.11.7.0?a'])).toMatchObject({ version: '21.11.5' });
  expect([javaNeededFor('1.20.1'), javaNeededFor('1.20.4'), javaNeededFor('1.20.5'), javaNeededFor('1.21.11'), javaNeededFor('26.1'), javaNeededFor('unknown')]).toEqual([17, 17, 21, 21, 25, null]);
});
