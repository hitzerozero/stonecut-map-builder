import { cpSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { skillPath } from '../src/cli.js';
import { checkJava, checkNode, formatChecks, runDoctor, type Check } from '../src/doctor.js';
import type { JavaInstall } from '../src/mc/java.js';
import { updateProperties } from '../src/mc/properties.js';
import { writeEula, writeMeta } from '../src/mc/testserver.js';
import { ALL_TOOLS } from '../src/server.js';
import { tempDir } from './helpers/temp.js';

interface Options {
  settings?: string;
  node?: string;
  java?: JavaInstall[];
  skill?: 'personal' | 'project' | 'changed' | 'none';
  server?: { eula?: boolean; javaPath?: string; ports: [number, number] };
  start?: () => Promise<number>;
}

const JAVA_21: JavaInstall = { path: join('jdk', 'bin', 'java'), major: 21, version: '21.0.5' };

/** Every file under dir with its size and change time, to show doctor wrote nothing. */
function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).map((d) => {
    const p = join(d.parentPath, d.name);
    const st = statSync(p);
    return `${p} ${st.size} ${st.mtimeMs}`;
  });
}

async function doctor(o: Options = {}): Promise<{ checks: Check[]; base: string; serverDir: string }> {
  const base = tempDir('doctor');
  const home = join(base, 'home');
  const cwd = join(base, 'project');
  const servers = join(base, 'servers');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const file = join(base, 'config.json');
  writeFileSync(file, o.settings ?? JSON.stringify({ serverFolders: [servers] }));
  const skill = o.skill ?? 'personal';
  if (skill !== 'none') {
    const to = join(skill === 'project' ? join(cwd, '.claude') : join(home, '.claude'), 'skills', 'map-builder');
    cpSync(skillPath(), to, { recursive: true });
    if (skill === 'changed') writeFileSync(join(to, 'SKILL.md'), 'an older skill');
  }
  const serverDir = join(servers, 'test');
  if (o.server) {
    mkdirSync(serverDir, { recursive: true });
    const [game, rcon] = o.server.ports;
    writeFileSync(join(serverDir, 'server.properties'), updateProperties('', { 'server-ip': '127.0.0.1', 'server-port': String(game), 'rcon.port': String(rcon), 'rcon.password': 'p'.repeat(32) }));
    writeEula(serverDir, o.server.eula ?? true);
    writeMeta(serverDir, {
      minecraft: '1.21.11', loader: 'vanilla', javaPath: o.server.javaPath ?? process.execPath, javaMajor: 21, memoryMb: 1024,
      launch: { type: 'jar', jar: 'server.jar' }, rconPort: rcon, createdAt: '2026-01-01T00:00:00Z', createdByTool: true,
    });
  }
  const before = snapshot(base);
  const checks = await runDoctor({
    env: { STONECUT_MAP_CONFIG: file },
    home,
    cwd,
    nodeVersion: o.node ?? 'v22.12.0',
    findJava: async () => o.java ?? [JAVA_21],
    startServer: o.start ?? (async () => ALL_TOOLS.length),
  });
  expect(snapshot(base)).toEqual(before);
  return { checks, base, serverDir };
}

const find = (checks: Check[], re: RegExp) => {
  const c = checks.find((x) => re.test(x.label));
  if (!c) throw new Error(`no check matching ${re}`);
  return c;
};

async function freePorts(): Promise<[number, number]> {
  const servers = [createServer(), createServer()];
  const ports = await Promise.all(servers.map((s) => new Promise<number>((r) => s.listen({ host: '127.0.0.1', port: 0 }, () => r((s.address() as { port: number }).port)))));
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return [ports[0]!, ports[1]!];
}

it('passes every check when everything is set up, and writes nothing', async () => {
  const { checks } = await doctor();
  expect(checks.filter((c) => !c.ok)).toEqual([]);
  expect(checks.map((c) => c.label).join('\n')).toMatch(/Node\.js[\s\S]*Settings file[\s\S]*Java found[\s\S]*No test server yet[\s\S]*skill is installed and up to date[\s\S]*starts and lists its 24 tools/);
  expect(formatChecks(checks)).toMatch(/All 6 checks passed\.$/);
});

it('fails an old Node version with where to get a new one', () => {
  expect(checkNode('v18.19.0')).toMatchObject({ ok: false, fix: expect.stringMatching(/nodejs\.org/) });
  expect(checkNode('v20.0.0').ok).toBe(true);
});

it('shows the allowed folders and the main switches, and fails a broken settings file without checking the server', async () => {
  const good = await doctor({ settings: JSON.stringify({ serverFolders: ['~/mc'], allowModInstall: true }) });
  expect(find(good.checks, /Settings file/).label).toMatch(/is valid\. Allowed server folders: .*mc \(not made yet\)\. File writes: yes\. Mods: yes\./);
  const broken = await doctor({ settings: '{"maxFillBlocks": "lots"}' });
  expect(find(broken.checks, /maxFillBlocks/)).toMatchObject({ ok: false, fix: expect.stringMatching(/does not start/) });
  expect(find(broken.checks, /Test server not checked/).ok).toBe(false);
  expect(find(broken.checks, /starts/).ok).toBe(true);
  const notJson = await doctor({ settings: '{ nope' });
  expect(find(notJson.checks, /not valid JSON/).ok).toBe(false);
});

it('says which Minecraft versions the Java found is enough for, and where to get Java when there is none', () => {
  expect(checkJava([{ path: 'a', major: 17, version: '17' }])).toMatchObject({ ok: true, label: expect.stringMatching(/Enough for Minecraft 1\.20\.1 to 1\.20\.4\. Not enough for Minecraft 1\.20\.5 to 1\.21\.11 \(needs Java 21\), 26\.1 and newer \(needs Java 25\)/) });
  expect(checkJava([{ path: 'a', major: 25, version: '25' }]).label).toMatch(/Enough for Minecraft 1\.20\.1 to 1\.20\.4, 1\.20\.5 to 1\.21\.11, 26\.1 and newer\.$/);
  expect(checkJava([])).toMatchObject({ ok: false, fix: expect.stringMatching(/adoptium\.net/) });
  expect(checkJava([{ path: 'a', major: 11, version: '11' }])).toMatchObject({ ok: false, label: expect.stringMatching(/Too old/) });
  expect(checkJava([JAVA_21], 'C:/missing/java.exe')).toMatchObject({ ok: false, label: expect.stringMatching(/javaPath in the settings file/) });
});

it('finds the skill in the personal or the project folder, and flags a copy that differs', async () => {
  expect(find((await doctor({ skill: 'project' })).checks, /skill/).ok).toBe(true);
  const none = find((await doctor({ skill: 'none' })).checks, /skill/);
  expect(none).toMatchObject({ ok: false, label: expect.stringMatching(/not installed/), fix: expect.stringMatching(/Copy the folder .*map-builder/) });
  expect(find((await doctor({ skill: 'changed' })).checks, /skill/)).toMatchObject({ ok: false, label: expect.stringMatching(/differs/) });
});

it('reports the test server: EULA, its Java, and stopped with free ports', async () => {
  const ports = await freePorts();
  const { checks } = await doctor({ server: { ports } });
  expect(find(checks, /EULA accepted/).ok).toBe(true);
  expect(find(checks, /server's Java/).ok).toBe(true);
  expect(find(checks, /stopped/)).toMatchObject({ ok: true, label: expect.stringContaining(`game port ${ports[0]}, RCON port ${ports[1]} are free`) });
  const noEula = await doctor({ server: { ports, eula: false, javaPath: join('gone', 'java') } });
  expect(find(noEula.checks, /EULA is not accepted/)).toMatchObject({ ok: false, fix: expect.stringMatching(/aka\.ms\/MinecraftEULA.*accept_eula/) });
  expect(find(noEula.checks, /server's Java .* is gone/).ok).toBe(false);
});

it('fails when another program holds a port of the stopped server', async () => {
  const ports = await freePorts();
  const busy: Server = createServer();
  await new Promise<void>((r) => busy.listen({ host: '127.0.0.1', port: ports[0] }, () => r()));
  try {
    const { checks } = await doctor({ server: { ports } });
    expect(find(checks, /in use by another program/)).toMatchObject({ ok: false, label: expect.stringContaining(`Game port ${ports[0]}`) });
  } finally {
    await new Promise((r) => busy.close(r));
  }
});

it('fails when the MCP server does not start or lists the wrong tools', async () => {
  const down = await doctor({ start: async () => Promise.reject(new Error('Config file x has a problem')) });
  expect(find(down.checks, /does not start/)).toMatchObject({ ok: false, label: expect.stringMatching(/Config file x has a problem/), fix: expect.stringMatching(/claude mcp add.*VS Code/) });
  expect(find((await doctor({ start: async () => 3 })).checks, /lists 3 tools/).ok).toBe(false);
});
