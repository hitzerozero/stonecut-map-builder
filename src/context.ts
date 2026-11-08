import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { findJava, pickJava } from './mc/java.js';
import type { Plan } from './mc/setup.js';
import { detectLaunch, metaPath, ServerError, TestServer, writeMeta } from './mc/testserver.js';
import { readProperties } from './mc/properties.js';
import { World } from './ops/world.js';
import { checkAllowedFolder } from './safety/paths.js';

// What the MCP server remembers between calls: the settings, the one active test server, and
// setup plans waiting for the person's yes. Calls that touch the server run one at a time.

export class Context {
  readonly plans = new Map<string, Plan>();
  private active: TestServer | null = null;
  private worldOps: World | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly config: Config) {}

  private get stateFile(): string {
    return join(this.config.stateDir, 'state.json');
  }

  /** Runs fn after every earlier call has finished. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private remembered(): string | null {
    if (!existsSync(this.stateFile)) return null;
    try {
      const s = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { activeServer?: string };
      return s.activeServer ?? null;
    } catch {
      return null;
    }
  }

  /** Servers made by this tool inside the allowed folders. */
  knownServers(): string[] {
    const out: string[] = [];
    for (const root of this.config.serverFolders) {
      if (existsSync(metaPath(root))) out.push(root);
      if (!existsSync(root)) continue;
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (d.isDirectory() && existsSync(metaPath(join(root, d.name)))) out.push(join(root, d.name));
      }
    }
    return out;
  }

  /** The server to use when none is active yet: the remembered one, else the first known one. Only reads. */
  findServer(): TestServer | null {
    const candidates = [this.remembered(), ...this.knownServers()].filter((p): p is string => !!p && existsSync(metaPath(p)));
    for (const dir of candidates) {
      try {
        return TestServer.open(checkAllowedFolder(this.config.serverFolders, dir));
      } catch {
        // no longer allowed or unreadable; try the next one
      }
    }
    return null;
  }

  /** The active server, or null if there is none yet. */
  current(): TestServer | null {
    if (this.active) return this.active;
    const found = this.findServer();
    return found ? this.setActive(found.dir) : null;
  }

  server(): TestServer {
    const s = this.current();
    if (!s) throw new ServerError('There is no test server yet. Ask the person which Minecraft version and modpack they use, then call plan_setup.');
    return s;
  }

  world(): World {
    const s = this.server();
    if (!this.worldOps || this.worldOps.server !== s) this.worldOps = new World(s, this.config);
    return this.worldOps;
  }

  setActive(dir: string): TestServer {
    const checked = checkAllowedFolder(this.config.serverFolders, dir);
    if (this.active && this.active.dir !== checked) this.active.closeConnections();
    this.active = TestServer.open(checked);
    this.worldOps = null;
    mkdirSync(this.config.stateDir, { recursive: true });
    writeFileSync(this.stateFile, `${JSON.stringify({ activeServer: checked }, null, 2)}\n`);
    return this.active;
  }

  /** Makes an existing server folder (inside an allowed folder) the active one, adopting it if this tool did not make it. */
  async adopt(dir: string): Promise<{ server: TestServer; adopted: boolean }> {
    const checked = checkAllowedFolder(this.config.serverFolders, dir);
    if (existsSync(metaPath(checked))) return { server: this.setActive(checked), adopted: false };
    const launch = detectLaunch(checked);
    if (!launch) throw new ServerError(`${checked} has no server.jar and no NeoForge install; it does not look like a Minecraft server folder`);
    const javaFound = await findJava(this.config.javaPath ? [this.config.javaPath] : []);
    const java = pickJava(javaFound, 21) ?? pickJava(javaFound, 17);
    if (!java) throw new ServerError('No Java 17 or newer found. Run plan_setup to see where to get it.');
    const props = readProperties(checked);
    writeMeta(checked, {
      minecraft: 'unknown',
      loader: launch.type === 'jar' ? 'vanilla' : 'neoforge',
      javaPath: java.path,
      javaMajor: java.major,
      memoryMb: 4096,
      launch,
      rconPort: Number(props.get('rcon.port') ?? 25575),
      createdAt: new Date().toISOString(),
      createdByTool: false,
    });
    return { server: this.setActive(checked), adopted: true };
  }
}
