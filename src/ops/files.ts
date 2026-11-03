import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Config } from '../config.js';
import { enforceLocked, redactProperties } from '../mc/properties.js';
import { STATE_DIR, type TestServer } from '../mc/testserver.js';
import { resolveInside, shown } from '../safety/paths.js';

// Files inside the test server's folder only: datapacks, configs, mods. The tool's own state
// folder, the world's chunk files and eula.txt are off limits.

export class FileError extends Error {}

const PROTECTED_NAMES = new Set(['level.dat', 'level.dat_old', 'session.lock', 'eula.txt']);
const PROTECTED_EXT = /\.(mca|mcc)$/i;

function resolve(server: TestServer, rel: string): string {
  return resolveInside(server.dir, rel, { hidden: [STATE_DIR] });
}

export interface Entry {
  path: string;
  type: 'file' | 'folder' | 'link';
  bytes?: number;
}

export function listFiles(server: TestServer, rel: string, depth: number, max = 500): { entries: Entry[]; truncated: boolean } {
  const start = resolve(server, rel || '.');
  if (!existsSync(start)) throw new FileError(`Nothing at ${rel}`);
  const entries: Entry[] = [];
  const walk = (dir: string, level: number) => {
    for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= max) return;
      const full = join(dir, d.name);
      if (dir === server.dir && d.name === STATE_DIR) continue;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) entries.push({ path: shown(server.dir, full), type: 'link' });
      else if (st.isDirectory()) {
        entries.push({ path: `${shown(server.dir, full)}/`, type: 'folder' });
        if (level < depth) walk(full, level + 1);
      } else entries.push({ path: shown(server.dir, full), type: 'file', bytes: st.size });
    }
  };
  if (!statSync(start).isDirectory()) throw new FileError(`${rel} is a file; use read_file`);
  walk(start, 1);
  return { entries, truncated: entries.length >= max };
}

export function readServerFile(server: TestServer, config: Config, rel: string, encoding: 'text' | 'base64'): { path: string; bytes: number; content: string } {
  const p = resolve(server, rel);
  if (!existsSync(p) || !statSync(p).isFile()) throw new FileError(`No file at ${rel}`);
  const size = statSync(p).size;
  if (size > config.maxFileBytes) throw new FileError(`${rel} is ${size} bytes, over the limit of ${config.maxFileBytes} (maxFileBytes in the config)`);
  const buf = readFileSync(p);
  let content = encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8');
  if (encoding === 'text' && basename(p).toLowerCase() === 'server.properties') content = redactProperties(content);
  return { path: shown(server.dir, p), bytes: size, content };
}

export function isModFile(rel: string): boolean {
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  return /\.jar$/i.test(rel) || parts[0]?.toLowerCase() === 'mods';
}

export function writeServerFile(
  server: TestServer,
  config: Config,
  rel: string,
  content: string,
  encoding: 'text' | 'base64',
  overwrite: boolean,
): { path: string; bytes: number; created: boolean; note?: string } {
  if (!config.allowFileWrites) throw new FileError('File writes are turned off (allowFileWrites is false in the config). The person can turn them on.');
  if (isModFile(rel) && !config.allowModInstall) {
    throw new FileError('Adding or changing mods is turned off (allowModInstall is false in the config). Tell the person which mod you want and why; they can turn it on.');
  }
  const p = resolve(server, rel);
  const name = basename(p).toLowerCase();
  if (PROTECTED_NAMES.has(name)) {
    throw new FileError(name === 'eula.txt' ? 'eula.txt can only change through accept_eula, after the person accepts the EULA' : `${name} is part of the world and cannot be written`);
  }
  if (PROTECTED_EXT.test(name)) throw new FileError('World chunk files cannot be written; change blocks with the block tools');
  const data = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
  if (data.length > config.maxFileBytes) throw new FileError(`That is ${data.length} bytes, over the limit of ${config.maxFileBytes} (maxFileBytes in the config)`);
  const existed = existsSync(p);
  if (existed && statSync(p).isDirectory()) throw new FileError(`${rel} is a folder`);
  if (existed && !overwrite) throw new FileError(`${rel} exists. Call again with overwrite: true to replace it.`);
  mkdirSync(dirname(p), { recursive: true });
  // Check again after making folders, in case a link appeared on the way.
  resolve(server, rel);
  writeFileSync(p, data);
  let note: string | undefined;
  if (name === 'server.properties' && dirname(p) === resolve(server, '.')) {
    const fixed = enforceLocked(server.dir, server.meta.rconPort);
    if (fixed.length) note = `Kept these settings as the tool needs them (local only, RCON on): ${fixed.join(', ')}`;
    note = `${note ? `${note}. ` : ''}Restart the server for changes to take effect.`;
  }
  return { path: shown(server.dir, p), bytes: data.length, created: !existed, ...(note ? { note } : {}) };
}
