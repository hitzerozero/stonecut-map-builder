import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLoopback, RCON_HOST } from '../safety/address.js';

// server.properties is a Java properties file, read here the way Java reads it (line breaks \n, \r
// or \r\n, lines continued with a backslash, \uXXXX escapes, the last of two equal keys wins), so
// the tool sees the same settings the game will. Lines are kept in order so the person's own
// comments and settings survive; only the keys we set are changed, everywhere they appear.

export type Properties = Map<string, string>;

export class PropertiesError extends Error {}

/** Java's whitespace in properties files: space, tab and form feed. */
const SPACE = new Set([' ', '\t', '\f']);
const ESCAPES: Record<string, string> = { t: '\t', n: '\n', r: '\r', f: '\f' };

function unescape(s: string, line: number): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== '\\' || i + 1 >= s.length) {
      out += c;
      continue;
    }
    const n = s[++i]!;
    if (n === 'u') {
      const hex = s.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new PropertiesError(`server.properties line ${line} has a broken \\u escape, so Minecraft cannot read the file either. Fix that line.`);
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += ESCAPES[n] ?? n;
  }
  return out;
}

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/([:=#!])/g, '\\$1').replace(/^ /, '\\ ');
}

function skipSpace(s: string): string {
  let i = 0;
  while (i < s.length && SPACE.has(s[i]!)) i++;
  return s.slice(i);
}

function continues(s: string): boolean {
  let n = 0;
  while (n < s.length && s[s.length - 1 - n] === '\\') n++;
  return n % 2 === 1;
}

interface Entry {
  key: string;
  value: string;
  /** First and last physical line of the entry (more than one when continued with a backslash). */
  first: number;
  last: number;
}

function entries(lines: string[]): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < lines.length; i++) {
    let part = skipSpace(lines[i]!);
    if (part === '' || part[0] === '#' || part[0] === '!') continue;
    const first = i;
    let text = '';
    while (continues(part) && i + 1 < lines.length) {
      text += part.slice(0, -1);
      part = skipSpace(lines[++i]!);
    }
    text += continues(part) ? part.slice(0, -1) : part;
    // The key ends at the first unescaped =, : or whitespace; after whitespace one = or : may follow.
    let k = 0;
    let valueStart = text.length;
    let hasSep = false;
    let escaped = false;
    for (; k < text.length; k++) {
      const c = text[k]!;
      if (!escaped && (c === '=' || c === ':' || SPACE.has(c))) {
        hasSep = !SPACE.has(c);
        valueStart = k + 1;
        break;
      }
      escaped = c === '\\' ? !escaped : false;
    }
    while (valueStart < text.length) {
      const c = text[valueStart]!;
      if (!SPACE.has(c)) {
        if (hasSep || (c !== '=' && c !== ':')) break;
        hasSep = true;
      }
      valueStart++;
    }
    out.push({ key: unescape(text.slice(0, k), first + 1), value: unescape(text.slice(valueStart), first + 1), first, last: i });
  }
  return out;
}

const physicalLines = (text: string) => text.split(/\r\n|\r|\n/);

export function parseProperties(text: string): Properties {
  const out: Properties = new Map();
  for (const e of entries(physicalLines(text))) out.set(e.key, e.value);
  return out;
}

export function updateProperties(text: string, changes: Record<string, string>): string {
  const lines: (string | null)[] = physicalLines(text);
  const left = new Map(Object.entries(changes));
  for (const e of entries(lines as string[])) {
    if (!Object.hasOwn(changes, e.key)) continue;
    lines[e.first] = `${e.key}=${escape(changes[e.key]!)}`;
    for (let i = e.first + 1; i <= e.last; i++) lines[i] = null;
    left.delete(e.key);
  }
  const kept = lines.filter((l): l is string => l !== null);
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  for (const [k, v] of left) kept.push(`${k}=${escape(v)}`);
  return `${kept.join('\n')}\n`;
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
  const management = props.get('management-server-host');
  return {
    'server-ip': isLoopback(props.get('server-ip') ?? '') ? props.get('server-ip')! : RCON_HOST,
    'enable-rcon': 'true',
    'rcon.port': String(rconPort),
    'rcon.password': pw.length >= 20 ? pw : newPassword(),
    'enable-query': 'false',
    'broadcast-rcon-to-ops': 'false',
    // Minecraft 1.21.9 and newer has a management server, off by default; when it is set up it stays local too.
    ...(management !== undefined && !isLoopback(management) ? { 'management-server-host': RCON_HOST } : {}),
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
  return text.replace(/^(\s*(?:rcon\.password|management-server-secret)\s*[=:]).*$/gm, '$1<hidden>');
}
