import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Config } from '../config.js';
import { enforceLocked, parseProperties, redactProperties } from '../mc/properties.js';
import { STATE_DIR, type TestServer } from '../mc/testserver.js';
import { resolveInside, shown } from '../safety/paths.js';

// Files inside the test server's folder only: datapacks, configs, mods. The tool's own state
// folder, the world's chunk files and eula.txt are off limits, and code (mods, jars, libraries,
// programs and the files that tell Java how to start) needs allowModInstall. The rules are checked
// on the real path, after links and Windows short names (SERVER~1.PRO) are resolved.

export class FileError extends Error {}

const PROTECTED_NAMES = new Set(['level.dat', 'level.dat_old', 'session.lock', 'eula.txt']);
const PROTECTED_EXT = /\.(mca|mcc)$/i;
/** Code the server runs: mods, and the libraries NeoForge's launch files point at. */
const CODE_FOLDERS = new Set(['mods', 'libraries']);
/** Java argument files: they can make Java load any program. */
const CODE_NAMES = new Set(['user_jvm_args.txt', 'win_args.txt', 'unix_args.txt']);
const CODE_EXT = /\.(jar|dll|so|dylib|jnilib|exe|com|bat|cmd|ps1|sh)$/i;

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
      if (dir === server.dir && d.name.toLowerCase() === STATE_DIR) continue;
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
  // The RCON password stays hidden in every file and either encoding (latin1 keeps the bytes as they are).
  let text = readFileSync(p).toString('latin1');
  const pw = rconPassword(server);
  if (pw) text = text.split(pw).join('<hidden>');
  if (basename(p).toLowerCase() === 'server.properties') text = redactProperties(text);
  const content = Buffer.from(text, 'latin1').toString(encoding === 'base64' ? 'base64' : 'utf8');
  return { path: shown(server.dir, p), bytes: size, content };
}

function rconPassword(server: TestServer): string | null {
  try {
    return server.password();
  } catch {
    return null;
  }
}

/** Mods, jars, libraries, programs and Java argument files. rel is relative to the server folder. */
export function isCodeFile(rel: string): boolean {
  const parts = rel.toLowerCase().split(/[\\/]/).filter(Boolean);
  return CODE_FOLDERS.has(parts[0] ?? '') || CODE_NAMES.has(parts[parts.length - 1] ?? '') || CODE_EXT.test(rel);
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
  const p = resolve(server, rel);
  if (isCodeFile(shown(server.dir, p)) && !config.allowModInstall) {
    throw new FileError(
      'Adding or changing mods and other code (jars, libraries, programs, Java argument files) is turned off (allowModInstall is false in the config). Tell the person which mod you want and why; they can turn it on.',
    );
  }
  const name = basename(p).toLowerCase();
  if (PROTECTED_NAMES.has(name)) {
    throw new FileError(name === 'eula.txt' ? 'eula.txt can only change through accept_eula, after the person accepts the EULA' : `${name} is part of the world and cannot be written`);
  }
  if (PROTECTED_EXT.test(name)) throw new FileError('World chunk files cannot be written; change blocks with the block tools');
  const data = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
  if (data.length > config.maxFileBytes) throw new FileError(`That is ${data.length} bytes, over the limit of ${config.maxFileBytes} (maxFileBytes in the config)`);
  const settings = name === 'server.properties' && dirname(p) === resolve(server, '.');
  // Minecraft could not read a broken file and would fall back to its defaults; refuse it instead.
  if (settings) parseProperties(data.toString('utf8'));
  const existed = existsSync(p);
  if (existed && statSync(p).isDirectory()) throw new FileError(`${rel} is a folder`);
  if (existed && !overwrite) throw new FileError(`${rel} exists. Call again with overwrite: true to replace it.`);
  mkdirSync(dirname(p), { recursive: true });
  // Check again after making folders, in case a link appeared on the way.
  resolve(server, rel);
  writeFileSync(p, data);
  let note: string | undefined;
  if (settings) {
    const fixed = enforceLocked(server.dir, server.meta.rconPort);
    if (fixed.length) note = `Kept these settings as the tool needs them (local only, RCON on): ${fixed.join(', ')}`;
    note = `${note ? `${note}. ` : ''}Restart the server for changes to take effect.`;
  }
  return { path: shown(server.dir, p), bytes: data.length, created: !existed, ...(note ? { note } : {}) };
}
