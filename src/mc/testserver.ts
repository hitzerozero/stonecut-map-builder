import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { RCON_HOST } from '../safety/address.js';
import { resolveInside } from '../safety/paths.js';
import { Rcon } from '../rcon/rcon.js';
import { EULA_URL, type Loader } from './versions.js';
import { enforceLocked, readProperties } from './properties.js';

// One local test server: its folder, how to launch it, and the RCON connections to it.

export const STATE_DIR = '.stonecut';
export const META_FILE = 'server.json';

export type Launch = { type: 'jar'; jar: string } | { type: 'argfile'; libDir: string };

export interface ServerMeta {
  minecraft: string;
  loader: Loader;
  loaderVersion?: string;
  javaPath: string;
  javaMajor: number;
  memoryMb: number;
  launch: Launch;
  rconPort: number;
  createdAt: string;
  createdByTool: boolean;
}

export class ServerError extends Error {}

export function metaPath(dir: string): string {
  return join(dir, STATE_DIR, META_FILE);
}

export function writeMeta(dir: string, meta: ServerMeta): void {
  mkdirSync(join(dir, STATE_DIR), { recursive: true });
  writeFileSync(metaPath(dir), `${JSON.stringify(meta, null, 2)}\n`);
}

export function eulaAccepted(dir: string): boolean {
  const f = join(dir, 'eula.txt');
  return existsSync(f) && /^\s*eula\s*=\s*true\s*$/im.test(readFileSync(f, 'utf8'));
}

export function writeEula(dir: string, accepted: boolean): void {
  writeFileSync(
    join(dir, 'eula.txt'),
    `#By changing the setting below to TRUE you are indicating your agreement to the Minecraft EULA (${EULA_URL}).\n` +
      `#${accepted ? 'Accepted by the person through Stonecut Map Builder' : 'Not accepted yet'} on ${new Date().toISOString()}\n` +
      `eula=${accepted}\n`,
  );
}

/**
 * True when no program on this computer uses the port. Listens on 127.0.0.1 for a moment (never on
 * a network address, so no firewall question comes up) and tries to connect there, which also
 * finds a program that listens on every address.
 */
export function portFree(port: number): Promise<boolean> {
  const canListen = new Promise<boolean>((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen({ host: RCON_HOST, port, exclusive: true }, () => s.close(() => resolve(true)));
  });
  const answers = () =>
    new Promise<boolean>((resolve) => {
      const c = connect({ host: RCON_HOST, port });
      const done = (open: boolean) => {
        c.destroy();
        resolve(open);
      };
      c.setTimeout(500, () => done(false));
      c.once('connect', () => done(true));
      c.once('error', () => done(false));
    });
  return canListen.then(async (free) => free && !(await answers()));
}

export async function findFreePort(start: number, avoid: number[] = []): Promise<number> {
  for (let p = start; p < start + 200 && p <= 65535; p++) {
    if (!avoid.includes(p) && (await portFree(p))) return p;
  }
  throw new ServerError(`No free port found from ${start}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tail(file: string, lines: number): string[] {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const len = Math.min(size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const all = buf.toString('utf8').split(/\r?\n/);
    if (all[all.length - 1] === '') all.pop();
    return all.slice(-lines);
  } finally {
    closeSync(fd);
  }
}

export interface ServerStatus {
  running: boolean;
  pid: number | null;
  rcon: boolean;
}

export class TestServer {
  private conns: Rcon[] = [];
  private childExit: number | null = null;

  constructor(readonly dir: string, readonly meta: ServerMeta) {}

  static open(dir: string): TestServer {
    const f = metaPath(dir);
    if (!existsSync(f)) throw new ServerError(`${dir} has no ${STATE_DIR}/${META_FILE}. Use use_server to adopt an existing server folder.`);
    return new TestServer(dir, JSON.parse(readFileSync(f, 'utf8')) as ServerMeta);
  }

  get stateDir(): string {
    return join(this.dir, STATE_DIR);
  }
  get pidFile(): string {
    return join(this.stateDir, 'server.pid');
  }
  get consoleLog(): string {
    return join(this.stateDir, 'console.log');
  }
  get logFile(): string {
    return join(this.dir, 'logs', 'latest.log');
  }

  properties(): Map<string, string> {
    return readProperties(this.dir);
  }
  get gamePort(): number {
    return Number(this.properties().get('server-port') ?? 25565);
  }
  /** The world folder named by level-name. A name that leaves the server folder is refused. */
  get worldDir(): string {
    const name = this.properties().get('level-name') || 'world';
    try {
      return resolveInside(this.dir, name, { hidden: [STATE_DIR] });
    } catch (e) {
      throw new ServerError(`level-name in server.properties must be a folder inside the server folder, not "${name}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private pid(): number | null {
    if (!existsSync(this.pidFile)) return null;
    // Written before the computer last started: that process is gone, and the number may now belong to another program.
    if (statSync(this.pidFile).mtimeMs < Date.now() - uptime() * 1000) return null;
    const pid = Number(readFileSync(this.pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
  }

  async status(): Promise<ServerStatus> {
    const pid = this.pid();
    let rcon = false;
    try {
      const c = await this.connection();
      await c.command('list');
      rcon = true;
    } catch {
      rcon = false;
    }
    return { running: rcon || pid !== null, pid, rcon };
  }

  javaArgs(): string[] {
    const mem = [`-Xmx${this.meta.memoryMb}M`];
    if (this.meta.launch.type === 'jar') return [...mem, '-jar', this.meta.launch.jar, 'nogui'];
    const file = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
    return [...mem, `@${this.meta.launch.libDir}/${file}`, 'nogui'];
  }

  async start(timeoutMs = 300_000): Promise<{ seconds: number; fixed: string[] }> {
    const began = Date.now();
    if ((await this.status()).running) throw new ServerError('The server is already running');
    if (!eulaAccepted(this.dir)) {
      throw new ServerError(`The Minecraft EULA is not accepted for this server. Show the person ${EULA_URL} and ask; if they accept, call accept_eula.`);
    }
    if (!existsSync(this.meta.javaPath)) throw new ServerError(`Java not found at ${this.meta.javaPath}. Run plan_setup to see what is needed.`);
    void this.worldDir; // Minecraft makes the world where level-name says; refused if that leaves the server folder.
    const fixed = enforceLocked(this.dir, this.meta.rconPort);
    for (const [what, port] of [['Game', this.gamePort], ['RCON', this.meta.rconPort]] as const) {
      if (!(await portFree(port))) throw new ServerError(`${what} port ${port} is in use by another program. Pick another port in server.properties.`);
    }
    mkdirSync(this.stateDir, { recursive: true });
    const out = openSync(this.consoleLog, 'w');
    this.childExit = null;
    const child = spawn(this.meta.javaPath, this.javaArgs(), { cwd: this.dir, detached: true, stdio: ['ignore', out, out], windowsHide: true });
    closeSync(out);
    child.on('exit', (code) => (this.childExit = code ?? -1));
    child.unref();
    if (child.pid) writeFileSync(this.pidFile, String(child.pid));
    while (Date.now() - began < timeoutMs) {
      await sleep(1000);
      if (this.childExit !== null) {
        throw new ServerError(`The server stopped while starting (exit ${this.childExit}). Last output:\n${this.logs(30).join('\n')}`);
      }
      try {
        const c = await this.connection();
        await c.command('list');
        return { seconds: (Date.now() - began) / 1000, fixed };
      } catch {
        // not up yet
      }
    }
    throw new ServerError(`The server did not answer on RCON within ${timeoutMs / 1000}s. Check server_logs.`);
  }

  async stop(force = false, timeoutMs = 120_000): Promise<{ seconds: number; forced: boolean }> {
    const began = Date.now();
    const pid = this.pid();
    let asked = false;
    try {
      const c = await this.connection();
      await c.command('stop').catch(() => undefined);
      asked = true;
    } catch {
      asked = false;
    }
    this.closeConnections();
    if (!asked && pid === null) throw new ServerError('The server is not running');
    if (!asked && !force) throw new ServerError(`The server does not answer on RCON (process ${pid}). Call stop_server with force: true to end the process; unsaved changes may be lost.`);
    if (!asked && pid !== null) {
      process.kill(pid);
      await this.waitGone(pid, 30_000);
      return { seconds: (Date.now() - began) / 1000, forced: true };
    }
    if (pid !== null) {
      if (!(await this.waitGone(pid, timeoutMs))) {
        if (!force) throw new ServerError(`The server is still saving after ${timeoutMs / 1000}s. Wait, or call stop_server with force: true.`);
        process.kill(pid);
        await this.waitGone(pid, 30_000);
        return { seconds: (Date.now() - began) / 1000, forced: true };
      }
    } else {
      while (Date.now() - began < timeoutMs && (await this.rconUp())) await sleep(500);
    }
    return { seconds: (Date.now() - began) / 1000, forced: false };
  }

  private async waitGone(pid: number, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!alive(pid) || this.childExit !== null) return true;
      await sleep(250);
    }
    return false;
  }

  private async rconUp(): Promise<boolean> {
    try {
      const c = await Rcon.connect(this.meta.rconPort, this.password(), 2000);
      c.close();
      return true;
    } catch {
      return false;
    }
  }

  password(): string {
    const pw = this.properties().get('rcon.password');
    if (!pw) throw new ServerError('server.properties has no rcon.password; start the server through this tool to set one');
    return pw;
  }

  /** An open RCON connection (the first of the pool). */
  async connection(): Promise<Rcon> {
    return (await this.connections(1))[0]!;
  }

  /** Up to n open RCON connections, made on demand and reused. */
  async connections(n: number): Promise<Rcon[]> {
    this.conns = this.conns.filter((c) => c.isOpen);
    while (this.conns.length < n) this.conns.push(await Rcon.connect(this.meta.rconPort, this.password()));
    return this.conns.slice(0, n);
  }

  closeConnections(): void {
    for (const c of this.conns) c.close();
    this.conns = [];
  }

  /** The last lines of the game log, or of the console output if the game log is missing or older. */
  logs(lines = 100, filter?: string): string[] {
    const useConsole = !existsSync(this.logFile) || (existsSync(this.consoleLog) && statSync(this.consoleLog).mtimeMs > statSync(this.logFile).mtimeMs + 2000 && this.childExit !== null);
    let out = tail(useConsole ? this.consoleLog : this.logFile, filter ? 5000 : lines);
    if (filter) out = out.filter((l) => l.toLowerCase().includes(filter.toLowerCase())).slice(-lines);
    let pw: string | undefined;
    try {
      pw = this.password();
    } catch {
      pw = undefined;
    }
    return pw ? out.map((l) => l.split(pw).join('<hidden>')) : out;
  }
}

/** Finds how to launch a server folder that was not made by this tool. */
export function detectLaunch(dir: string): Launch | null {
  for (const artifact of ['neoforge', 'forge']) {
    const base = join(dir, 'libraries', 'net', 'neoforged', artifact);
    if (!existsSync(base)) continue;
    const versions = readdirSync(base).filter((v) => existsSync(join(base, v, 'win_args.txt')) || existsSync(join(base, v, 'unix_args.txt')));
    if (versions.length) return { type: 'argfile', libDir: `libraries/net/neoforged/${artifact}/${versions.sort().pop()}` };
  }
  if (existsSync(join(dir, 'server.jar'))) return { type: 'jar', jar: 'server.jar' };
  return null;
}
