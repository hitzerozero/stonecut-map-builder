import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, relative, sep } from 'node:path';
import { expect, it } from 'vitest';

// Nothing in the repository may point at a particular computer or person: no absolute home
// paths, no e-mail addresses, and none of the identity of whoever runs the tests (user name, home
// folder, git name and e-mail). Extra words can be checked too, comma separated, in
// HYGIENE_EXTRA_TERMS (kept out of the repository on purpose).

const ROOT = join(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const GENERIC_USERS = new Set(['runner', 'root', 'user', 'admin', 'vagrant', 'ubuntu', 'node', 'docker', 'runneradmin']);

function repoFiles(): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\0').filter(Boolean);
  } catch {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory()) {
          if (!SKIP_DIRS.has(d.name)) walk(join(dir, d.name));
        } else files.push(relative(ROOT, join(dir, d.name)).split(sep).join('/'));
      }
    };
    walk(ROOT);
    return files;
  }
}

function git(key: string): string {
  try {
    return execFileSync('git', ['config', '--get', key], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rules(): { name: string; re: RegExp }[] {
  const r = [
    { name: 'Windows home path', re: /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`<>]+/i },
    { name: 'macOS home path', re: /(?<![\w.])\/Users\/[A-Za-z0-9._-]+/ },
    { name: 'Linux home path', re: /(?<![\w.])\/home\/[A-Za-z0-9._-]+/ },
    { name: 'e-mail address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/ },
  ];
  const identity: string[] = [homedir(), git('user.email'), git('user.name')];
  const name = userInfo().username;
  if (name.length >= 3 && !GENERIC_USERS.has(name.toLowerCase())) identity.push(name);
  for (const t of (process.env.HYGIENE_EXTRA_TERMS ?? '').split(',')) identity.push(t.trim());
  for (const term of identity.filter((t) => t.length >= 3)) r.push({ name: 'local identity or extra term', re: new RegExp(`(?<![A-Za-z0-9])${escape(term)}(?![A-Za-z0-9])`, 'i') });
  return r;
}

it('finds no absolute home paths, e-mail addresses or local identity in any repository file', () => {
  const files = repoFiles();
  expect(files.length).toBeGreaterThan(20);
  const found: string[] = [];
  const checks = rules();
  for (const f of files) {
    const full = join(ROOT, f);
    if (statSync(full).size > 5 * 1024 * 1024) continue;
    const content = readFileSync(full, 'latin1');
    for (const { name, re } of checks) {
      const m = re.exec(content);
      if (m) found.push(`${f}: ${name} (line ${content.slice(0, m.index).split('\n').length})`);
    }
  }
  expect(found).toEqual([]);
});

it('catches each kind of leak it looks for', () => {
  const checks = rules();
  const hit = (s: string) => checks.some(({ re }) => re.test(s));
  // Built at run time so this file does not trip its own scan.
  const users = ['Us', 'ers'].join('');
  expect(hit(['C:', users, 'someone', 'Desktop'].join('\\'))).toBe(true);
  expect(hit(`see /${users}/someone/Library`)).toBe(true);
  expect(hit(`cd /${'ho'}me/someone/x`)).toBe(true);
  expect(hit(`write to ${['a.person', 'example.org'].join('@')}`)).toBe(true);
  expect(hit(`path ${homedir()}`)).toBe(true);
  expect(hit('npm i @modelcontextprotocol/sdk and ~/stonecut-map-builder/servers')).toBe(false);
});
