import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLoopback, RCON_HOST } from '../safety/address.js';

// server.properties is a Java properties file. Lines are kept in order so the person's own
// comments and settings survive; only the keys we set are changed.

export type Properties = Map<string, string>;

function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c);
}

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/([:=#!])/g, '\\$1').replace(/^ /, '\\ ');
}

export function parseProperties(text: string): Properties {
  const out: Properties = new Map();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trimStart();
    if (t === '' || t.startsWith('#') || t.startsWith('!')) continue;
    const m = /^((?:\\.|[^=:\s\\])+)\s*[=:\s]\s*(.*)$/.exec(t) ?? /^((?:\\.|[^=:\s\\])+)$/.exec(t);
    if (!m) continue;
    out.set(unescape(m[1]!), unescape(m[2] ?? ''));
  }
  return out;
}

export function updateProperties(text: string, changes: Record<string, string>): string {
  const left = new Map(Object.entries(changes));
  const lines = text.split(/\r?\n/).map((line) => {
    const t = line.trimStart();
    if (t.startsWith('#') || t.startsWith('!')) return line;
    const m = /^((?:\\.|[^=:\s\\])+)/.exec(t);
    if (!m) return line;
    const key = unescape(m[1]!);
    if (!left.has(key)) return line;
    const v = left.get(key)!;
    left.delete(key);
    return `${key}=${escape(v)}`;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of left) lines.push(`${k}=${escape(v)}`);
  return `${lines.join('\n')}\n`;
}

export function propertiesFile(serverDir: string): string {
  return join(serverDir, 'server.properties');
}

export function readProperties(serverDir: string): Properties {
  const f = propertiesFile(serverDir);
  return existsSync(f) ? parseProperties(readFileSync(f, 'utf8')) : new Map();
}

export function newPassword(): string {
  return randomBytes(24).toString('base64url');
}

/** Settings the tool always keeps: local only, RCON on, no query port, no RCON echo to players. */
export function lockedChanges(props: Properties, rconPort: number): Record<string, string> {
  const pw = props.get('rcon.password') ?? '';
  return {
    'server-ip': isLoopback(props.get('server-ip') ?? '') ? props.get('server-ip')! : RCON_HOST,
    'enable-rcon': 'true',
    'rcon.port': String(rconPort),
    'rcon.password': pw.length >= 20 ? pw : newPassword(),
    'enable-query': 'false',
    'broadcast-rcon-to-ops': 'false',
  };
}

/** Rewrites the locked settings if anything changed them. Returns the keys it had to fix. */
export function enforceLocked(serverDir: string, rconPort: number): string[] {
  const f = propertiesFile(serverDir);
  const text = existsSync(f) ? readFileSync(f, 'utf8') : '';
  const props = parseProperties(text);
  const changes = lockedChanges(props, rconPort);
  const fixed = Object.entries(changes).filter(([k, v]) => props.get(k) !== v).map(([k]) => k);
  if (fixed.length) writeFileSync(f, updateProperties(text, changes));
  return fixed;
}

export function redactProperties(text: string): string {
  return text.replace(/^(\s*rcon\.password\s*[=:]).*$/gm, '$1<hidden>');
}
