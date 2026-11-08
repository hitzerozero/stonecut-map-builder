import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { Config } from '../config.js';
import { checkAllowedFolder } from '../safety/paths.js';
import { downloadFile } from './download.js';
import { findJava, javaInstallHint, pickJava, type JavaInstall } from './java.js';
import { newPassword, updateProperties } from './properties.js';
import { findFreePort, portFree, STATE_DIR, writeEula, writeMeta, type Launch, type ServerMeta } from './testserver.js';
import { EULA_URL, neoforgeSha256, resolveNeoForge, resolveVersion, serverDownload, type Loader } from './versions.js';

// Setup in two steps. plan_setup looks everything up and changes nothing. create_server does the
// plan, and only after the person said yes to it.

export interface SetupInput {
  minecraft: string;
  loader: Loader;
  name: string;
  serverFolder?: string;
  gamePort?: number;
  rconPort?: number;
  memoryMb?: number;
  worldType?: 'flat' | 'normal';
  javaPath?: string;
}

export interface PlannedDownload {
  what: string;
  url: string;
  source: string;
  hash: { algo: 'sha1' | 'sha256'; value: string };
  size?: number;
}

export interface Plan {
  planId: string;
  folder: string;
  minecraft: string;
  loader: Loader;
  loaderVersion?: string;
  loaderIsBeta?: boolean;
  javaNeeded: number;
  java: JavaInstall | null;
  javaFound: JavaInstall[];
  javaMissing?: string[];
  downloads: PlannedDownload[];
  gamePort: number;
  rconPort: number;
  memoryMb: number;
  worldType: 'flat' | 'normal';
  eulaUrl: string;
  ready: boolean;
  expires: number;
}

const PLAN_LIFETIME_MS = 30 * 60_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export class SetupError extends Error {}

/**
 * A Java the agent names must be a program called java (java.exe) given by full path, and not inside
 * a server folder: the file tools can write there, and the tool runs this program.
 */
export function checkJavaPath(config: Config, path: string): void {
  const name = basename(path).toLowerCase();
  if (!isAbsolute(path) || (name !== 'java' && name !== 'java.exe')) throw new SetupError(`java_path must be the full path of a program called java or java.exe, not ${path}`);
  let inServerFolder = true;
  try {
    checkAllowedFolder(config.serverFolders, path);
  } catch {
    inServerFolder = false;
  }
  if (inServerFolder) throw new SetupError(`java_path cannot be inside a server folder: ${path}. Use a Java installed on this computer.`);
}

export async function planSetup(config: Config, input: SetupInput): Promise<Plan> {
  if (!NAME.test(input.name)) throw new SetupError('Server name: 1-40 characters of A-Z a-z 0-9 _ -, starting with a letter or digit');
  const root = input.serverFolder ?? config.serverFolders[0]!;
  checkAllowedFolder(config.serverFolders, root);
  const folder = checkAllowedFolder(config.serverFolders, join(root, input.name));
  if (existsSync(folder) && readdirSync(folder).length > 0) throw new SetupError(`${folder} already exists and is not empty. Pick another name, or use_server to use it.`);
  if (input.javaPath) checkJavaPath(config, input.javaPath);

  const entry = await resolveVersion(input.minecraft);
  const server = await serverDownload(entry);
  const downloads: PlannedDownload[] = [];
  let loaderVersion: string | undefined;
  let loaderIsBeta: boolean | undefined;
  if (input.loader === 'vanilla') {
    downloads.push({ what: `Minecraft ${entry.id} server`, url: server.url, source: 'Mojang (official version manifest)', hash: { algo: 'sha1', value: server.sha1 }, size: server.size });
  } else {
    const build = await resolveNeoForge(entry.id);
    loaderVersion = build.version;
    loaderIsBeta = build.beta;
    downloads.push({ what: `NeoForge ${build.version} installer`, url: build.installerUrl, source: 'NeoForged (maven.neoforged.net)', hash: { algo: 'sha256', value: await neoforgeSha256(build) } });
    downloads.push({ what: `Minecraft ${entry.id} server and NeoForge libraries, fetched and hash-checked by the NeoForge installer`, url: 'https://piston-data.mojang.com and https://maven.neoforged.net', source: 'Mojang and NeoForged', hash: { algo: 'sha1', value: server.sha1 } });
  }

  const extra = [input.javaPath, config.javaPath].filter((p): p is string => !!p);
  const javaFound = await findJava(extra);
  const java = input.javaPath ? javaFound.find((j) => j.path === input.javaPath && j.major >= server.javaMajor) ?? null : pickJava(javaFound, server.javaMajor);

  const gamePort = input.gamePort ?? (await findFreePort(25565));
  const rconPort = input.rconPort ?? (await findFreePort(25575, [gamePort]));
  if (gamePort === rconPort) throw new SetupError('Game port and RCON port must differ');

  return {
    planId: randomUUID(),
    folder,
    minecraft: entry.id,
    loader: input.loader,
    ...(loaderVersion ? { loaderVersion, loaderIsBeta } : {}),
    javaNeeded: server.javaMajor,
    java,
    javaFound,
    ...(java ? {} : { javaMissing: javaInstallHint(server.javaMajor) }),
    downloads,
    gamePort,
    rconPort,
    memoryMb: input.memoryMb ?? (input.loader === 'neoforge' ? 4096 : 2048),
    worldType: input.worldType ?? 'flat',
    eulaUrl: EULA_URL,
    ready: java !== null,
    expires: Date.now() + PLAN_LIFETIME_MS,
  };
}

export function serverProperties(plan: Pick<Plan, 'gamePort' | 'rconPort' | 'worldType'>): string {
  return updateProperties('#Minecraft server properties, made by Stonecut Map Builder\n', {
    'server-ip': '127.0.0.1',
    'server-port': String(plan.gamePort),
    'enable-rcon': 'true',
    'rcon.port': String(plan.rconPort),
    'rcon.password': newPassword(),
    'broadcast-rcon-to-ops': 'false',
    'enable-query': 'false',
    'online-mode': 'true',
    motd: 'Stonecut test server (this computer only)',
    gamemode: 'creative',
    difficulty: 'peaceful',
    'level-type': plan.worldType === 'flat' ? 'minecraft:flat' : 'minecraft:normal',
    'generate-structures': plan.worldType === 'flat' ? 'false' : 'true',
    'spawn-protection': '0',
    'max-players': '8',
    'enable-command-block': 'true',
    'allow-flight': 'true',
  });
}

function run(java: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(java, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`;
      if (err) reject(new SetupError(`${err.message}\n${out.split(/\r?\n/).slice(-20).join('\n')}`));
      else resolve(out);
    });
  });
}

export interface Created {
  folder: string;
  meta: ServerMeta;
  downloaded: { what: string; bytes: number; hash: string }[];
  seconds: number;
}

export async function createServer(plan: Plan): Promise<Created> {
  const began = Date.now();
  if (Date.now() > plan.expires) throw new SetupError('This plan has expired. Run plan_setup again and show the person the new plan.');
  if (!plan.java) throw new SetupError(`Java ${plan.javaNeeded} or newer is needed and was not found. Show the person: ${plan.javaMissing?.join('; ')}`);
  if (existsSync(plan.folder) && readdirSync(plan.folder).length > 0) throw new SetupError(`${plan.folder} is no longer empty`);
  for (const p of [plan.gamePort, plan.rconPort]) if (!(await portFree(p))) throw new SetupError(`Port ${p} is now in use; run plan_setup again`);

  mkdirSync(join(plan.folder, STATE_DIR, 'downloads'), { recursive: true });
  const downloaded: Created['downloaded'] = [];
  let launch: Launch;
  if (plan.loader === 'vanilla') {
    const d = plan.downloads[0]!;
    const r = await downloadFile(d.url, join(plan.folder, 'server.jar'), { algo: d.hash.algo, hash: d.hash.value, ...(d.size ? { size: d.size } : {}) });
    downloaded.push({ what: d.what, ...r });
    launch = { type: 'jar', jar: 'server.jar' };
  } else {
    const d = plan.downloads[0]!;
    const installer = join(plan.folder, STATE_DIR, 'downloads', 'neoforge-installer.jar');
    const r = await downloadFile(d.url, installer, { algo: d.hash.algo, hash: d.hash.value });
    downloaded.push({ what: d.what, ...r });
    const out = await run(plan.java.path, ['-jar', installer, '--installServer', plan.folder], join(plan.folder, STATE_DIR, 'downloads'), 20 * 60_000);
    writeFileSync(join(plan.folder, STATE_DIR, 'install.log'), out);
    rmSync(installer, { force: true });
    const artifact = plan.minecraft === '1.20.1' ? 'forge' : 'neoforge';
    const libDir = `libraries/net/neoforged/${artifact}/${plan.loaderVersion}`;
    if (!existsSync(join(plan.folder, libDir))) throw new SetupError(`The NeoForge installer finished but ${libDir} is missing. See ${STATE_DIR}/install.log.`);
    launch = { type: 'argfile', libDir };
  }

  writeFileSync(join(plan.folder, 'server.properties'), serverProperties(plan));
  writeEula(plan.folder, false);
  const meta: ServerMeta = {
    minecraft: plan.minecraft,
    loader: plan.loader,
    ...(plan.loaderVersion ? { loaderVersion: plan.loaderVersion } : {}),
    javaPath: plan.java.path,
    javaMajor: plan.java.major,
    memoryMb: plan.memoryMb,
    launch,
    rconPort: plan.rconPort,
    createdAt: new Date().toISOString(),
    createdByTool: true,
  };
  writeMeta(plan.folder, meta);
  return { folder: plan.folder, meta, downloaded, seconds: (Date.now() - began) / 1000 };
}
