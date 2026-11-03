import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { configDir, configFile, DEFAULTS, exampleConfig, loadConfig } from '../src/config.js';
import { tempDir } from './helpers/temp.js';

const HOME = join(tempDir('home'), 'person');

function withFile(content: unknown) {
  const dir = tempDir('config');
  const file = join(dir, 'config.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return loadConfig({ STONECUT_MAP_CONFIG: file }, HOME);
}

it('uses safe defaults from the home folder when there is no settings file', () => {
  const c = loadConfig({ STONECUT_MAP_CONFIG: join(tempDir('none'), 'missing.json') }, HOME);
  expect(c.fileExists).toBe(false);
  expect(c.serverFolders).toEqual([join(HOME, 'stonecut-map-builder', 'servers')]);
  expect(c).toMatchObject({ ...DEFAULTS, rconAddress: '127.0.0.1' });
  expect(c.allowModInstall).toBe(false);
  expect(c.confirmDestructive).toBe(true);
});

it('puts the settings file in the standard place for each system', () => {
  expect(configDir({ APPDATA: 'X:\\Roaming' }, HOME, 'win32')).toBe(join('X:\\Roaming', 'stonecut-map-builder'));
  expect(configDir({}, HOME, 'darwin')).toBe(join(HOME, 'Library', 'Application Support', 'stonecut-map-builder'));
  expect(configDir({ XDG_CONFIG_HOME: '/xdg' }, HOME, 'linux')).toBe(join('/xdg', 'stonecut-map-builder'));
  expect(configDir({}, HOME, 'linux')).toBe(join(HOME, '.config', 'stonecut-map-builder'));
  expect(configFile({ STONECUT_MAP_CONFIG: '~/my.json' }, HOME)).toBe(join(HOME, 'my.json'));
});

it('reads the person\'s settings and expands ~ in folders', () => {
  const c = withFile({ serverFolders: ['~/mc-tests'], maxReadBlocks: 1000, allowFileWrites: false, autoBackup: false });
  expect(c.fileExists).toBe(true);
  expect(c.serverFolders).toEqual([join(HOME, 'mc-tests')]);
  expect(c.maxReadBlocks).toBe(1000);
  expect(c.allowFileWrites).toBe(false);
  expect(c.autoBackup).toBe(false);
});

it('refuses a remote RCON address, unknown keys, relative folders and broken JSON', () => {
  expect(() => withFile({ rconAddress: '0.0.0.0' })).toThrow(/rconAddress can only be 127\.0\.0\.1/);
  expect(() => withFile({ allowEverything: true })).toThrow(/allowEverything/);
  expect(() => withFile({ serverFolders: ['servers'] })).toThrow(/full path/);
  expect(() => withFile({ maxFillBlocks: 0 })).toThrow(/maxFillBlocks/);
  expect(() => withFile('{ nope')).toThrow(/not valid JSON/);
});

it('ships an example that loads to exactly the defaults', () => {
  const c = withFile(exampleConfig());
  expect(c).toMatchObject({ ...DEFAULTS, rconAddress: '127.0.0.1', serverFolders: [join(HOME, 'stonecut-map-builder', 'servers')] });
});

it('has a config.example.json in the repository that matches the defaults exactly', () => {
  const file = join(import.meta.dirname, '..', 'config.example.json');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(exampleConfig());
});
