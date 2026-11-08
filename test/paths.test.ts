import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { checkAllowedFolder, PathError, resolveInside } from '../src/safety/paths.js';
import { tempDir } from './helpers/temp.js';

function linkDir(target: string, at: string): boolean {
  try {
    symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

it('resolves paths inside the server folder, new or existing', () => {
  const root = tempDir('paths');
  mkdirSync(join(root, 'world', 'datapacks'), { recursive: true });
  expect(resolveInside(root, 'world/datapacks/pack/pack.mcmeta').endsWith(join('world', 'datapacks', 'pack', 'pack.mcmeta'))).toBe(true);
  expect(resolveInside(root, 'config\\neoforge-server.toml').endsWith(join('config', 'neoforge-server.toml'))).toBe(true);
  expect(resolveInside(root, './server.properties').endsWith('server.properties')).toBe(true);
});

it('refuses absolute paths, drive letters and ".." in any form', () => {
  const root = tempDir('paths');
  for (const p of ['/etc/passwd', 'C:\\Windows\\win.ini', 'c:/x', '\\\\server\\share\\x', '../outside', 'world/../../outside', 'world\\..\\..\\x', '..']) {
    expect(() => resolveInside(root, p), p).toThrow(PathError);
  }
});

it('refuses Windows device names, streams, trailing dots and empty paths', () => {
  const root = tempDir('paths');
  for (const p of ['CON', 'world/nul.txt', 'com1', 'server.properties:secret', 'world/x.', 'world/x ', '', '  ', 'a\0b']) {
    expect(() => resolveInside(root, p), JSON.stringify(p)).toThrow(PathError);
  }
});

it("keeps the tool's own folder hidden, in any letter case", () => {
  const root = tempDir('paths');
  expect(() => resolveInside(root, '.stonecut/server.json', { hidden: ['.stonecut'] })).toThrow(/ is the tool's own folder/);
  expect(() => resolveInside(root, '.STONECUT/x', { hidden: ['.stonecut'] })).toThrow(/ is the tool's own folder/);
  expect(resolveInside(root, 'world/.stonecut', { hidden: ['.stonecut'] })).toContain('world');
});

it('refuses a path that leaves the folder through a symlink or junction', () => {
  const root = tempDir('paths');
  const outside = tempDir('outside');
  writeFileSync(join(outside, 'secret.txt'), 'x');
  if (!linkDir(outside, join(root, 'escape'))) return;
  expect(() => resolveInside(root, 'escape/secret.txt')).toThrow(/through a link/);
  expect(() => resolveInside(root, 'escape/new/file.txt')).toThrow(/through a link/);
});

it('accepts server folders inside an allowed folder and refuses others, including look-alike names', () => {
  const base = tempDir('allowed');
  const allowed = join(base, 'servers');
  mkdirSync(join(allowed, 'one'), { recursive: true });
  mkdirSync(join(base, 'servers2'), { recursive: true });
  expect(checkAllowedFolder([allowed], join(allowed, 'one'))).toContain('one');
  expect(checkAllowedFolder([allowed], join(allowed, 'not-made-yet'))).toContain('not-made-yet');
  expect(() => checkAllowedFolder([allowed], join(base, 'servers2'))).toThrow(/not inside an allowed server folder/);
  expect(() => checkAllowedFolder([allowed], base)).toThrow(PathError);
  expect(() => checkAllowedFolder([allowed], 'relative/folder')).toThrow(/full path/);
  if (linkDir(base, join(allowed, 'sneaky'))) expect(() => checkAllowedFolder([allowed], join(allowed, 'sneaky', 'servers2'))).toThrow(PathError);
});
