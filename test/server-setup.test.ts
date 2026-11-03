import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { candidatePaths, javaInstallHint, parseJavaVersion, pickJava } from '../src/mc/java.js';
import { enforceLocked, parseProperties, redactProperties, updateProperties } from '../src/mc/properties.js';
import { serverProperties } from '../src/mc/setup.js';
import { compareVersions, isSupportedVersion, neoforgePrefix, pickNeoForge } from '../src/mc/versions.js';
import { tempDir } from './helpers/temp.js';

it('supports Minecraft 1.20.1 and newer releases, including the new year-based numbers', () => {
  for (const v of ['1.20.1', '1.20.6', '1.21', '1.21.11', '26.1', '26.3.1']) expect(isSupportedVersion(v), v).toBe(true);
  for (const v of ['1.20', '1.19.4', '1.8.9', '26.4-snapshot-7', '1.21.5-pre1', 'latest']) expect(isSupportedVersion(v), v).toBe(false);
  expect(compareVersions('1.21.11', '1.21.2')).toBeGreaterThan(0);
  expect(compareVersions('26.1', '1.21.11')).toBeGreaterThan(0);
});

it('maps Minecraft versions to NeoForge builds and prefers stable over beta', () => {
  expect(neoforgePrefix('1.20.1')).toEqual({ artifact: 'forge', prefix: '1.20.1-' });
  expect(neoforgePrefix('1.21')).toEqual({ artifact: 'neoforge', prefix: '21.0.' });
  expect(neoforgePrefix('1.21.11')).toEqual({ artifact: 'neoforge', prefix: '21.11.' });
  expect(neoforgePrefix('26.1.2')).toEqual({ artifact: 'neoforge', prefix: '26.1.2.' });
  const list = ['21.11.9', '21.11.10-beta', '21.11.48', '21.11.100-beta', '21.1.5', '26.1.0.0-alpha.3+snapshot-1', '26.1.0.5-beta'];
  expect(pickNeoForge('1.21.11', list)).toMatchObject({ version: '21.11.48', beta: false });
  expect(pickNeoForge('26.1', list)).toMatchObject({ version: '26.1.0.5-beta', beta: true });
  expect(pickNeoForge('1.21.11', list)!.installerUrl).toBe('https://maven.neoforged.net/releases/net/neoforged/neoforge/21.11.48/neoforge-21.11.48-installer.jar');
  expect(pickNeoForge('1.21.4', list)).toBeNull();
});

it('reads Java versions in old and new formats and picks a suitable one', () => {
  expect(parseJavaVersion('openjdk version "21.0.12" 2026-07-15 LTS')).toEqual({ major: 21, version: '21.0.12' });
  expect(parseJavaVersion('java version "1.8.0_401"')).toEqual({ major: 8, version: '1.8.0_401' });
  expect(parseJavaVersion('nothing here')).toBeNull();
  const found = [
    { path: 'a', major: 17, version: '17' },
    { path: 'b', major: 25, version: '25' },
    { path: 'c', major: 21, version: '21' },
  ];
  expect(pickJava(found, 21)!.path).toBe('c');
  expect(pickJava(found, 22)!.path).toBe('b');
  expect(pickJava(found, 26)).toBeNull();
  expect(javaInstallHint(21).join(' ')).toMatch(/adoptium\.net/);
});

it('looks for Java only in places built from the environment and the home folder', () => {
  const home = tempDir('javahome');
  const paths = candidatePaths({ JAVA_HOME: join(home, 'jdk'), PATH: '' }, home);
  expect(paths[0]).toBe(join(home, 'jdk', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
});

it('keeps the person\'s lines when updating server.properties', () => {
  const text = '#my comment\nmotd=Hello\\: world\nserver-ip=\npvp=false\n';
  const out = updateProperties(text, { 'server-ip': '127.0.0.1', 'rcon.port': '25575' });
  expect(out).toBe('#my comment\nmotd=Hello\\: world\nserver-ip=127.0.0.1\npvp=false\nrcon.port=25575\n');
  expect(parseProperties(out).get('motd')).toBe('Hello: world');
});

it('puts back local-only RCON settings that were changed, and hides the password', () => {
  const dir = tempDir('props');
  writeFileSync(join(dir, 'server.properties'), 'server-ip=0.0.0.0\nenable-rcon=false\nrcon.password=short\nenable-query=true\nmotd=keep me\n');
  const fixed = enforceLocked(dir, 25999);
  expect(fixed.sort()).toEqual(['broadcast-rcon-to-ops', 'enable-query', 'enable-rcon', 'rcon.password', 'rcon.port', 'server-ip']);
  const props = parseProperties(readFileSync(join(dir, 'server.properties'), 'utf8'));
  expect(props.get('server-ip')).toBe('127.0.0.1');
  expect(props.get('rcon.port')).toBe('25999');
  expect(props.get('rcon.password')!.length).toBeGreaterThanOrEqual(20);
  expect(props.get('motd')).toBe('keep me');
  expect(enforceLocked(dir, 25999)).toEqual([]);
  expect(redactProperties('a=1\nrcon.password=abc\n')).toBe('a=1\nrcon.password=<hidden>\n');
});

it('writes new servers listening on 127.0.0.1 only, with RCON on and a random password', () => {
  const a = parseProperties(serverProperties({ gamePort: 25810, rconPort: 25811, worldType: 'flat' }));
  const b = parseProperties(serverProperties({ gamePort: 25810, rconPort: 25811, worldType: 'flat' }));
  expect(a.get('server-ip')).toBe('127.0.0.1');
  expect(a.get('enable-rcon')).toBe('true');
  expect(a.get('enable-query')).toBe('false');
  expect(a.get('online-mode')).toBe('true');
  expect(a.get('level-type')).toBe('minecraft:flat');
  expect(a.get('rcon.password')).not.toBe(b.get('rcon.password'));
});
