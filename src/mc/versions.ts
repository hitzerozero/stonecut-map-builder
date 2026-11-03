import { fetchJson, fetchText } from './download.js';

// Minecraft versions and where the server files come from: Mojang's version manifest for the
// game, maven.neoforged.net for NeoForge.

export const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
export const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged';
export const EULA_URL = 'https://aka.ms/MinecraftEULA';
export const MIN_VERSION = '1.20.1';

export type Loader = 'vanilla' | 'neoforge';

/** Numeric parts of a release id: 1.21.11 -> [1, 21, 11], 26.1 -> [26, 1, 0]. Null for snapshots. */
export function versionParts(id: string): number[] | null {
  if (!/^\d+\.\d+(\.\d+)?$/.test(id)) return null;
  const p = id.split('.').map(Number);
  while (p.length < 3) p.push(0);
  return p;
}

export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a), pb = versionParts(b);
  if (!pa || !pb) throw new Error(`Not a release version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

export function isSupportedVersion(id: string): boolean {
  return versionParts(id) !== null && compareVersions(id, MIN_VERSION) >= 0;
}

export interface ManifestEntry {
  id: string;
  type: string;
  url: string;
  sha1: string;
}

interface Manifest {
  latest: { release: string };
  versions: ManifestEntry[];
}

export async function resolveVersion(requested: string): Promise<ManifestEntry> {
  const m = await fetchJson<Manifest>(MANIFEST_URL);
  const id = requested === 'latest' ? m.latest.release : requested;
  if (!isSupportedVersion(id)) throw new Error(`Minecraft ${id} is not supported. Use a release from ${MIN_VERSION} on (snapshots are not supported).`);
  const entry = m.versions.find((v) => v.id === id);
  if (!entry || entry.type !== 'release') throw new Error(`Mojang has no release called ${id}. Latest release: ${m.latest.release}`);
  return entry;
}

export interface ServerDownload {
  javaMajor: number;
  url: string;
  sha1: string;
  size: number;
}

interface VersionJson {
  javaVersion?: { majorVersion: number };
  downloads?: { server?: { url: string; sha1: string; size: number } };
}

export async function serverDownload(entry: ManifestEntry): Promise<ServerDownload> {
  const v = await fetchJson<VersionJson>(entry.url, entry.sha1);
  const s = v.downloads?.server;
  if (!s) throw new Error(`Mojang publishes no server for ${entry.id}`);
  return { javaMajor: v.javaVersion?.majorVersion ?? 17, url: s.url, sha1: s.sha1, size: s.size };
}

// ---- NeoForge ----

export interface NeoForgeBuild {
  artifact: 'neoforge' | 'forge';
  version: string;
  beta: boolean;
  installerUrl: string;
}

/** NeoForge numbers its builds after the game: 1.21.4 -> 21.4.x, 1.21 -> 21.0.x, 26.1.2 -> 26.1.2.x. 1.20.1 is the older "forge" artifact. */
export function neoforgePrefix(mc: string): { artifact: 'neoforge' | 'forge'; prefix: string } {
  const p = versionParts(mc);
  if (!p) throw new Error(`Not a release version: ${mc}`);
  if (mc === '1.20.1') return { artifact: 'forge', prefix: '1.20.1-' };
  if (p[0] === 1) return { artifact: 'neoforge', prefix: `${p[1]}.${p[2]}.` };
  return { artifact: 'neoforge', prefix: `${p[0]}.${p[1]}.${p[2]}.` };
}

export function pickNeoForge(mc: string, versions: string[]): NeoForgeBuild | null {
  const { artifact, prefix } = neoforgePrefix(mc);
  const usable = versions.filter((v) => v.startsWith(prefix) && !/alpha|\+|snapshot|rc/i.test(v));
  const num = (v: string) => v.slice(prefix.length).split(/[.-]/).filter((x) => /^\d+$/.test(x)).map(Number);
  const cmp = (a: string, b: string) => {
    const na = num(a), nb = num(b);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) - (nb[i] ?? 0);
    return 0;
  };
  const stable = usable.filter((v) => !/beta/i.test(v)).sort(cmp);
  const beta = usable.filter((v) => /beta/i.test(v)).sort(cmp);
  const version = stable[stable.length - 1] ?? beta[beta.length - 1];
  if (!version) return null;
  return {
    artifact,
    version,
    beta: !stable.length,
    installerUrl: `${NEOFORGE_MAVEN}/${artifact}/${version}/${artifact}-${version}-installer.jar`,
  };
}

export async function resolveNeoForge(mc: string): Promise<NeoForgeBuild> {
  const { artifact } = neoforgePrefix(mc);
  const xml = await fetchText(`${NEOFORGE_MAVEN}/${artifact}/maven-metadata.xml`);
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]!);
  const build = pickNeoForge(mc, versions);
  if (!build) throw new Error(`NeoForge has no build for Minecraft ${mc} yet`);
  return build;
}

export async function neoforgeSha256(build: NeoForgeBuild): Promise<string> {
  const text = (await fetchText(`${build.installerUrl}.sha256`)).trim().split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{64}$/i.test(text)) throw new Error('NeoForge did not publish a usable sha256 for this installer');
  return text.toLowerCase();
}
