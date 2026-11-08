import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Keeps every file the tools touch inside one folder. Checks the text of the path first
// (no absolute paths, no "..", no drive letters or Windows device names), then resolves symlinks,
// junctions and Windows short names (PROGRA~1) of everything that already exists and checks again.
// The path it returns is that resolved one, so later checks on names see the real names.

export class PathError extends Error {}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

// Hidden folders ignore letter case on every system: Linux folders can be case-folded too.
function fold(p: string): string {
  return p.toLowerCase();
}

function norm(p: string): string {
  return caseInsensitive ? p.toLowerCase() : p;
}

/** True when child is root itself or inside it. Both must be absolute and resolved. */
export function isInside(root: string, child: string): boolean {
  const rel = relative(norm(root), norm(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function realOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Real path of the deepest part of p that exists, with the missing rest appended. */
function realDeepest(p: string): string {
  let existing = p;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ''));
    existing = parent;
  }
  return rest.length ? join(realOrSelf(existing), ...rest) : realOrSelf(existing);
}

export interface ResolveOptions {
  /** Relative paths (first segment) the tools may not touch, for example the tool's own state folder. */
  hidden?: string[];
}

/**
 * Resolves a path given relative to root. Throws PathError if it is absolute, uses "..",
 * names a Windows device or stream, or ends up outside root after following links. Returns the
 * path with links and short names resolved as far as it exists.
 */
export function resolveInside(root: string, userPath: string, options: ResolveOptions = {}): string {
  if (typeof userPath !== 'string' || userPath.trim() === '') throw new PathError('Path is empty');
  if (userPath.includes('\0')) throw new PathError('Path contains a NUL character');
  const cleaned = userPath.replace(/\\/g, '/');
  if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned) || isAbsolute(userPath)) {
    throw new PathError(`Use a path relative to the server folder, not an absolute path: ${userPath}`);
  }
  const parts = cleaned.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.length === 0) return realDeepest(resolve(root));
  for (const part of parts) {
    if (part === '..') throw new PathError(`".." is not allowed in paths: ${userPath}`);
    if (part.includes(':')) throw new PathError(`":" is not allowed in paths: ${userPath}`);
    if (WINDOWS_DEVICE.test(part)) throw new PathError(`"${part}" is a reserved name on Windows`);
    if (/[. ]$/.test(part)) throw new PathError(`Path parts may not end with a dot or space: ${part}`);
  }
  const hidden = (options.hidden ?? []).map(fold);
  if (hidden.includes(fold(parts[0]!))) throw new PathError(`${parts[0]} is the tool's own folder and cannot be read or changed`);

  const rootReal = realDeepest(resolve(root));
  const target = resolve(rootReal, ...parts);
  if (!isInside(rootReal, target)) throw new PathError(`Path leaves the server folder: ${userPath}`);
  const real = realDeepest(target);
  if (!isInside(rootReal, real)) throw new PathError(`Path leads outside the server folder through a link: ${userPath}`);
  const first = relative(rootReal, real).split(sep)[0] ?? '';
  if (first !== '' && hidden.includes(fold(first))) throw new PathError(`${userPath} leads into the tool's own folder, which cannot be read or changed`);
  return real;
}

/** The path relative to root, with forward slashes, for showing to the agent. */
export function shown(root: string, p: string): string {
  return relative(realDeepest(resolve(root)), p).split(sep).join('/');
}

/**
 * Checks that an absolute folder is one of the allowed folders or inside one, after following
 * links. Returns the resolved folder.
 */
export function checkAllowedFolder(allowed: string[], folder: string): string {
  if (!isAbsolute(folder)) throw new PathError(`Give the server folder as a full path: ${folder}`);
  const real = realDeepest(resolve(folder));
  for (const root of allowed) {
    if (isInside(realDeepest(resolve(root)), real)) return real;
  }
  throw new PathError(
    `${folder} is not inside an allowed server folder. Allowed: ${allowed.join(', ')}. The person can add folders under "serverFolders" in the config file.`,
  );
}
