import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

// Finds Java on this computer. Never installs anything: when Java is missing or too old the
// tool says which version is needed and where the person can get it.

export interface JavaInstall {
  path: string;
  major: number;
  version: string;
}

export const JAVA_SOURCES = [
  { name: 'Eclipse Temurin (Adoptium)', url: 'https://adoptium.net/temurin/releases/' },
  { name: 'Microsoft Build of OpenJDK', url: 'https://learn.microsoft.com/java/openjdk/download' },
];

export function javaInstallHint(major: number, platform = process.platform): string[] {
  const hints = JAVA_SOURCES.map((s) => `${s.name}, Java ${major}: ${s.url}`);
  if (platform === 'win32') hints.push(`Windows terminal: winget install EclipseAdoptium.Temurin.${major}.JRE`);
  else if (platform === 'darwin') hints.push(`macOS with Homebrew: brew install --cask temurin@${major}`);
  else hints.push(`Linux: your package manager, for example sudo apt install openjdk-${major}-jre-headless`);
  return hints;
}

export function parseJavaVersion(output: string): { major: number; version: string } | null {
  const m = /version "([^"]+)"/.exec(output);
  if (!m) return null;
  const v = m[1]!;
  const parts = v.split(/[._+-]/).map((n) => parseInt(n, 10));
  const major = parts[0] === 1 ? parts[1]! : parts[0]!;
  return Number.isFinite(major) ? { major, version: v } : null;
}

function exe(): string {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name));
  } catch {
    return [];
  }
}

/** Places Java is commonly installed, built from environment variables and the home folder only. */
export function candidatePaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const out: string[] = [];
  const bin = (dir: string) => join(dir, 'bin', exe());
  if (env.JAVA_HOME) out.push(bin(env.JAVA_HOME));
  for (const p of (env.PATH ?? env.Path ?? '').split(delimiter)) if (p) out.push(join(p, exe()));
  const vendorRoots: string[] = [];
  if (process.platform === 'win32') {
    for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (!pf) continue;
      for (const v of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru', 'OpenJDK']) vendorRoots.push(join(pf, v));
    }
  } else if (process.platform === 'darwin') {
    for (const root of ['/Library/Java/JavaVirtualMachines', join(home, 'Library', 'Java', 'JavaVirtualMachines')]) {
      for (const d of subdirs(root)) out.push(bin(join(d, 'Contents', 'Home')));
    }
  } else {
    vendorRoots.push('/usr/lib/jvm', '/usr/java', '/opt/java');
  }
  vendorRoots.push(join(home, '.jdks'), join(home, '.sdkman', 'candidates', 'java'));
  for (const root of vendorRoots) for (const d of subdirs(root)) out.push(bin(d));
  return [...new Set(out)];
}

export function probeJava(path: string): Promise<JavaInstall | null> {
  return new Promise((resolve) => {
    execFile(path, ['-version'], { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stderr) return resolve(null);
      const v = parseJavaVersion(`${stderr}\n${stdout}`);
      resolve(v ? { path, ...v } : null);
    });
  });
}

export async function findJava(extra: string[] = [], env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Promise<JavaInstall[]> {
  const paths = [...extra, ...candidatePaths(env, home)].filter((p) => existsSync(p));
  const found = await Promise.all(paths.map(probeJava));
  const seen = new Set<string>();
  return found.filter((j): j is JavaInstall => {
    if (!j || seen.has(j.path.toLowerCase())) return false;
    seen.add(j.path.toLowerCase());
    return true;
  });
}

/** The best Java for a required major version: the exact version if present, otherwise the lowest newer one. */
export function pickJava(found: JavaInstall[], major: number): JavaInstall | null {
  const ok = found.filter((j) => j.major >= major).sort((a, b) => a.major - b.major);
  return ok.find((j) => j.major === major) ?? ok[0] ?? null;
}
